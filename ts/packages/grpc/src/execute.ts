import { z } from 'zod';
import { clipUtf8, utf8Bytes } from './bytes';
import {
  ArgumentsSchema,
  type ComposioGrpcExecuteResult,
  type ComposioGrpcSession,
  DEFAULT_STREAM_CHUNK_BYTES,
  MAX_STREAM_CHUNK_BYTES,
} from './schema';
import type { ToolCatalog } from './catalog';

export interface ToolErrorBody {
  code: string;
  message: string;
  detailsJson?: string;
  retryable: boolean;
  suggestion?: string;
}

export interface ExecuteSuccessBody {
  outputJson: string;
  promptText: string;
  truncated: boolean;
}

export type ExecuteBody =
  | {
      ok: true;
      callId: string;
      slug: string;
      success: ExecuteSuccessBody;
      durationMs: number;
      version: string;
    }
  | {
      ok: false;
      callId: string;
      slug: string;
      error: ToolErrorBody;
      durationMs: number;
      version: string;
    };

export async function runTool(input: {
  catalog: ToolCatalog;
  session: ComposioGrpcSession;
  toolName: string;
  inputJson: string;
  callId?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ExecuteBody> {
  const started = Date.now();
  const callId = input.callId && input.callId.length > 0 ? input.callId : crypto.randomUUID();
  const toolName = input.toolName.trim();
  if (toolName.length === 0) {
    return failed(
      callId,
      '',
      started,
      errorBody('ERROR_CODE_INVALID_TOOL_NAME', 'Tool name is empty', false)
    );
  }

  const view = input.catalog.resolve(toolName);
  if (!view) {
    return failed(
      callId,
      toolName,
      started,
      errorBody('ERROR_CODE_TOOL_NOT_FOUND', `No Composio tool named "${toolName}"`, false)
    );
  }
  if (!view.enabled) {
    return failed(
      callId,
      view.slug,
      started,
      errorBody(
        'ERROR_CODE_TOOL_DISABLED',
        `${view.slug} is not enabled. Finalize the tool config with this tool included.`,
        false
      ),
      view.version
    );
  }

  const parsedArgs = parseArguments(input.inputJson);
  if (!parsedArgs.ok) {
    return failed(callId, view.slug, started, parsedArgs.error, view.version);
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  input.signal?.addEventListener('abort', onAbort);
  const timeout = input.timeoutMs
    ? setTimeout(() => controller.abort(), input.timeoutMs)
    : undefined;
  const watched = Boolean(input.timeoutMs || input.signal);

  try {
    const execution = input.session.execute(view.slug, parsedArgs.args, undefined, {
      signal: watched ? controller.signal : undefined,
    });
    execution.catch(() => {
      // The race below can leave this promise running after a timeout.
    });
    const result = watched
      ? await Promise.race([execution, whenAborted(controller.signal)])
      : await execution;
    return fromSessionResult(
      callId,
      view.slug,
      view.version,
      started,
      result,
      input.catalog.maxOutputBytes(view.slug)
    );
  } catch (caught) {
    if (controller.signal.aborted || isAbortError(caught)) {
      const cancelled = input.signal?.aborted === true && !input.timeoutMs;
      return failed(
        callId,
        view.slug,
        started,
        errorBody(
          cancelled ? 'ERROR_CODE_CANCELLED' : 'ERROR_CODE_TIMEOUT',
          cancelled ? 'Tool execution was cancelled' : 'Tool execution timed out',
          !cancelled
        ),
        view.version
      );
    }
    return failed(callId, view.slug, started, thrownToError(caught), view.version);
  } finally {
    if (timeout) clearTimeout(timeout);
    input.signal?.removeEventListener('abort', onAbort);
  }
}

export function chunkUtf8(text: string, size: number): Uint8Array[] {
  const safe = normalizeChunkSize(size);
  const buffer = utf8Bytes(text);
  if (buffer.byteLength === 0) return [];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < buffer.byteLength; offset += safe) {
    chunks.push(buffer.subarray(offset, Math.min(buffer.byteLength, offset + safe)));
  }
  return chunks;
}

export function normalizeChunkSize(size: number | null | undefined): number {
  if (!size || size <= 0) return DEFAULT_STREAM_CHUNK_BYTES;
  return Math.min(size, MAX_STREAM_CHUNK_BYTES);
}

export function chunkSizeError(size: number | null | undefined): string | undefined {
  if (size != null && size > MAX_STREAM_CHUNK_BYTES) {
    return `stream_chunk_size must be <= ${MAX_STREAM_CHUNK_BYTES}`;
  }
  return undefined;
}

function fromSessionResult(
  callId: string,
  slug: string,
  version: string,
  started: number,
  result: ComposioGrpcExecuteResult,
  maxBytes: number
): ExecuteBody {
  if (result.resultType === 'blocked') {
    return failed(
      callId,
      slug,
      started,
      errorBody(
        'ERROR_CODE_PERMISSION_DENIED',
        result.error ?? 'A session hook blocked this call',
        false
      ),
      version
    );
  }
  if (result.resultType === 'failed') {
    return failed(
      callId,
      slug,
      started,
      errorBody('ERROR_CODE_EXECUTION_FAILED', result.error ?? 'Tool execution failed', false, {
        logId: result.logId,
      }),
      version
    );
  }
  const raw = JSON.stringify(result.data);
  const clipped = clipUtf8(raw, maxBytes);
  const outputJson = clipped.truncated
    ? JSON.stringify({ truncated: true, bytes: utf8Bytes(raw).byteLength, preview: clipped.text })
    : raw;
  return {
    ok: true,
    callId,
    slug,
    version,
    durationMs: Date.now() - started,
    success: {
      outputJson,
      promptText: clipped.text,
      truncated: clipped.truncated,
    },
  };
}

function parseArguments(
  inputJson: string
): { ok: true; args: Record<string, unknown> } | { ok: false; error: ToolErrorBody } {
  if (inputJson.trim().length === 0) return { ok: true, args: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    return {
      ok: false,
      error: errorBody('ERROR_CODE_INVALID_INPUT', 'input_json is not valid JSON', false),
    };
  }
  const record = ArgumentsSchema.safeParse(parsed);
  if (!record.success) {
    return {
      ok: false,
      error: errorBody('ERROR_CODE_INVALID_INPUT', 'input_json must be a JSON object', false),
    };
  }
  return { ok: true, args: record.data };
}

const ThrownDetailsSchema = z.object({
  inputRequests: z.unknown().optional(),
  requestState: z.unknown().optional(),
});

function thrownToError(caught: unknown): ToolErrorBody {
  if (!(caught instanceof Error)) {
    return errorBody('ERROR_CODE_EXECUTION_FAILED', 'Tool execution failed', false);
  }
  if (caught.name === 'ComposioToolInputRequiredError') {
    const details = ThrownDetailsSchema.safeParse(caught);
    return errorBody(
      'ERROR_CODE_MISSING_REQUIRED_FIELD',
      caught.message,
      false,
      details.success ? details.data : undefined,
      'Collect the requested input and execute the tool again.'
    );
  }
  if (/rate limit|too many requests|429/i.test(caught.message)) {
    return errorBody('ERROR_CODE_RATE_LIMITED', caught.message, true);
  }
  if (/permission|unauthorized|forbidden/i.test(caught.message)) {
    return errorBody('ERROR_CODE_PERMISSION_DENIED', caught.message, false);
  }
  return errorBody('ERROR_CODE_EXECUTION_FAILED', caught.message, false);
}

function errorBody(
  code: string,
  message: string,
  retryable: boolean,
  details?: unknown,
  suggestion?: string
): ToolErrorBody {
  return {
    code,
    message,
    retryable,
    ...(details !== undefined ? { detailsJson: JSON.stringify(details) } : {}),
    ...(suggestion ? { suggestion } : {}),
  };
}

function failed(
  callId: string,
  slug: string,
  started: number,
  error: ToolErrorBody,
  version = ''
): ExecuteBody {
  return { ok: false, callId, slug, error, durationMs: Date.now() - started, version };
}

function isAbortError(caught: unknown): boolean {
  return caught instanceof Error && caught.name === 'AbortError';
}

function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    signal.addEventListener(
      'abort',
      () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      { once: true }
    );
  });
}
