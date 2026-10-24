import * as grpc from '@grpc/grpc-js';
import { z } from 'zod';
import { utf8ByteLength, utf8Bytes } from './bytes';
import { ToolCatalog, type FinalizeViolation } from './catalog';
import { chunkSizeError, chunkUtf8, normalizeChunkSize, runTool } from './execute';
import { CHANNEL_OPTIONS, loadGrokToolsService } from './proto';
import {
  ComposioGrpcAuditEventSchema,
  ComposioGrpcToolInputSchema,
  type ComposioGrpcAuditEvent,
  type ComposioGrpcSession,
  type ComposioGrpcToolInput,
  ExecuteToolRequestSchema,
  FinalizeRequestSchema,
  GetToolInfoRequestSchema,
  ListToolsRequestSchema,
  isExternalCategory,
} from './schema';
import { executeResponse, toolInfoMessage } from './wire';

const HostSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]+$/)
  .refine(host => !host.includes('://'), 'Host must not include a scheme');

export interface ServeComposioGrpcOptions {
  /** Composio session whose `execute` runs the tool. */
  session: ComposioGrpcSession;
  /** Tools to publish. Pass the result of `composio.tools.get`, or any list with `slug`. */
  tools?: readonly ComposioGrpcToolInput[];
  /** Called on every list, lookup, and execute so the catalog can follow the session. */
  loadTools?: () => Promise<readonly ComposioGrpcToolInput[]>;
  /** Bind host. Defaults to loopback. */
  host?: string;
  /** Bind port. `0` asks the OS for a free port. */
  port?: number;
  /** When set, every RPC must send `authorization: Bearer <token>`. */
  authToken?: string;
  /** Recorded on audit events. This is the Composio user id the session was opened for. */
  userId?: string;
  /** Fired after each execute. Arguments are not included. */
  onAudit?: (event: ComposioGrpcAuditEvent) => void;
}

export interface ComposioGrpcServerHandle {
  readonly address: string;
  readonly port: number;
  stop(): Promise<void>;
}

interface MethodDef {
  originalName?: string;
  responseStream: boolean;
}

type Unary = (
  call: grpc.ServerUnaryCall<unknown, unknown>,
  callback: grpc.sendUnaryData<unknown>
) => void;
type Stream = (call: grpc.ServerWritableStream<unknown, unknown>) => void;

/**
 * Serve Composio tools on `xai.grok.tools.v1.GrokToolsService`.
 * QENEX agents that already speak that proto can list and execute the session.
 */
export async function serveComposioGrpc(
  options: ServeComposioGrpcOptions
): Promise<ComposioGrpcServerHandle> {
  const host = HostSchema.parse(options.host ?? '127.0.0.1');
  const port = z
    .number()
    .int()
    .min(0)
    .max(65535)
    .parse(options.port ?? 0);
  if (!options.tools && !options.loadTools) {
    throw new Error('serveComposioGrpc requires tools or loadTools');
  }

  const catalog = new ToolCatalog();
  const initial = options.tools ? parseTools(options.tools) : [];
  catalog.replace(initial);
  if (options.loadTools && !options.tools) {
    catalog.replace(parseTools(await options.loadTools()));
  }

  const refresh = async () => {
    if (!options.loadTools) return;
    catalog.replace(parseTools(await options.loadTools()));
  };

  const Service = await loadGrokToolsService();
  const server = new grpc.Server(CHANNEL_OPTIONS);
  const handlers = createHandlers({ catalog, refresh, options });
  const impl: Record<string, grpc.UntypedHandleCall> = {};
  for (const [name, method] of Object.entries(Service.service) as Array<[string, MethodDef]>) {
    // proto-loader's service keys are the PascalCase RPC names (`ListTools`).
    // `originalName` is the camelCase client method and is not the implementation key.
    if (method.responseStream) {
      impl[name] = handlers.stream.get(name) ?? unimplementedStream;
    } else {
      impl[name] = handlers.unary.get(name) ?? unimplementedUnary;
    }
  }
  server.addService(Service.service, impl);

  const bound = await new Promise<number>((resolve, reject) => {
    server.bindAsync(
      `${host}:${port}`,
      grpc.ServerCredentials.createInsecure(),
      (error, boundPort) => {
        if (error) reject(error);
        else resolve(boundPort);
      }
    );
  });
  return {
    address: `${host}:${bound}`,
    port: bound,
    stop: () =>
      new Promise(resolve => {
        server.tryShutdown(() => resolve());
      }),
  };
}

function createHandlers(input: {
  catalog: ToolCatalog;
  refresh: () => Promise<void>;
  options: ServeComposioGrpcOptions;
}): { unary: Map<string, Unary>; stream: Map<string, Stream> } {
  const { catalog, options } = input;
  const guard = (metadata: grpc.Metadata): { code: number; message: string } | undefined => {
    if (authorized(metadata, options.authToken)) return undefined;
    return { code: grpc.status.UNAUTHENTICATED, message: 'Bearer token required' };
  };

  const unary = new Map<string, Unary>();
  const stream = new Map<string, Stream>();

  unary.set('ListTools', (call, callback) => {
    const denied = guard(call.metadata);
    if (denied) return callback(denied);
    void (async () => {
      await input.refresh();
      const request = ListToolsRequestSchema.parse(call.request);
      if (!isExternalCategory(request.category)) {
        callback(null, { tools: [], totalCount: 0, enabledCount: 0 });
        return;
      }
      const includeSchemas = request.includeSchemas === true;
      const views = catalog.list(request.includeDisabled === true);
      callback(null, {
        tools: views.map(view => toolInfoMessage(view, includeSchemas)),
        totalCount: views.length,
        enabledCount: views.filter(view => view.enabled).length,
      });
    })().catch(error => callback(internal(error)));
  });

  unary.set('GetToolInfo', (call, callback) => {
    const denied = guard(call.metadata);
    if (denied) return callback(denied);
    void (async () => {
      await input.refresh();
      const request = GetToolInfoRequestSchema.parse(call.request);
      const view = catalog.resolve(request.toolName ?? '');
      if (!view) {
        callback({
          code: grpc.status.NOT_FOUND,
          message: `No Composio tool named "${request.toolName ?? ''}"`,
        });
        return;
      }
      callback(null, toolInfoMessage(view, true));
    })().catch(error => callback(internal(error)));
  });

  unary.set('ExecuteTool', (call, callback) => {
    const denied = guard(call.metadata);
    if (denied) return callback(denied);
    void (async () => {
      await input.refresh();
      const request = ExecuteToolRequestSchema.parse(call.request);
      const abort = listenForCancel(call);
      const body = await runTool({
        catalog,
        session: options.session,
        toolName: request.toolName ?? '',
        inputJson: request.inputJson ?? '',
        callId: request.callId,
        timeoutMs: positive(request.options?.timeoutMs),
        signal: abort.signal,
      });
      audit(options, body);
      if (call.cancelled) return;
      callback(null, executeResponse(body));
    })().catch(error => {
      if (!call.cancelled) callback(internal(error));
    });
  });

  unary.set('FinalizeToolConfigRequest', (call, callback) => {
    const denied = guard(call.metadata);
    if (denied) return callback(denied);
    void (async () => {
      await input.refresh();
      const request = FinalizeRequestSchema.parse(call.request);
      if (request.initialToolStateJson && request.initialToolStateJson.length > 0) {
        try {
          catalog.restoredState = JSON.parse(request.initialToolStateJson) as unknown;
        } catch {
          callback(null, {
            success: false,
            message: 'initial_tool_state_json is not valid JSON',
            tools: [],
          });
          return;
        }
      }
      const { violations } = catalog.finalize(request.tools ?? []);
      if (violations.length > 0) {
        callback(null, { success: false, message: formatViolations(violations), tools: [] });
        return;
      }
      if (request.truncation) {
        catalog.truncation = {
          defaultMaxOutputBytes:
            request.truncation.defaultMaxOutputBytes ?? catalog.truncation.defaultMaxOutputBytes,
          perToolMaxOutputBytes: request.truncation.perToolMaxOutputBytes ?? {},
        };
      }
      catalog.systemRemindersEnabled = request.systemRemindersEnabled === true;
      if (request.behaviorPreset && request.behaviorPreset.length > 0) {
        catalog.behaviorPreset = request.behaviorPreset;
      }
      if (request.sessionId && request.sessionId.length > 0) catalog.sessionId = request.sessionId;
      const callbackAddr = request.clientCallbackAddr ?? '';
      callback(null, {
        success: true,
        message: 'ok',
        tools: catalog.list(false).map(view => toolInfoMessage(view, true)),
        ...(callbackAddr.length > 0
          ? {
              callbackStatus: {
                connected: false,
                activeSurfaces: [],
                message: 'This Composio server does not dial host callbacks',
              },
            }
          : {}),
      });
    })().catch(error => callback(internal(error)));
  });

  unary.set('GetToolState', (call, callback) => {
    const denied = guard(call.metadata);
    if (denied) return callback(denied);
    callback(null, { stateJson: catalog.stateJson() });
  });

  registerAdmin({ unary, guard, catalog });
  registerStream({ stream, guard, catalog, refresh: input.refresh, options });

  return { unary, stream };
}

function registerAdmin(input: {
  unary: Map<string, Unary>;
  guard: (metadata: grpc.Metadata) => { code: number; message: string } | undefined;
  catalog: ToolCatalog;
}): void {
  const { unary, guard, catalog } = input;
  unary.set('GetSystemReminders', (call, callback) => {
    const denied = guard(call.metadata);
    if (denied) return callback(denied);
    callback(null, { enabled: catalog.systemRemindersEnabled });
  });

  unary.set('SetSystemReminders', (call, callback) => {
    const denied = guard(call.metadata);
    if (denied) return callback(denied);
    const request = z.object({ enabled: z.boolean().optional() }).parse(call.request);
    catalog.systemRemindersEnabled = request.enabled === true;
    callback(null, { success: true, message: 'ok', enabled: catalog.systemRemindersEnabled });
  });

  unary.set('GetTruncationConfig', (call, callback) => {
    const denied = guard(call.metadata);
    if (denied) return callback(denied);
    callback(null, {
      config: {
        defaultMaxOutputBytes: catalog.truncation.defaultMaxOutputBytes,
        perToolMaxOutputBytes: catalog.truncation.perToolMaxOutputBytes,
      },
    });
  });

  unary.set('GetAgentInfo', (call, callback) => {
    const denied = guard(call.metadata);
    if (denied) return callback(denied);
    callback(null, {
      name: 'composio',
      description: 'Composio tools for this QENEX agent session',
      tools: catalog.list(false).map(view => view.name),
    });
  });

  unary.set('GetSystemPrompt', (call, callback) => {
    const denied = guard(call.metadata);
    if (denied) return callback(denied);
    callback(null, { systemPrompt: '', promptMode: 'full' });
  });

  unary.set('GetCompletionState', (call, callback) => {
    const denied = guard(call.metadata);
    if (denied) return callback(denied);
    callback(null, { hasRequirement: false, requiredTool: '', completed: false });
  });

  unary.set('ResetCompletionState', (call, callback) => {
    const denied = guard(call.metadata);
    if (denied) return callback(denied);
    callback(null, {});
  });

  unary.set('FinalizeAgent', (call, callback) => {
    const denied = guard(call.metadata);
    if (denied) return callback(denied);
    callback(null, { success: true, systemPrompt: '' });
  });

  const retired = 'Configure tools with FinalizeToolConfigRequest';
  unary.set('SetTruncationConfig', (call, callback) => {
    const denied = guard(call.metadata);
    if (denied) return callback(denied);
    const request = z
      .object({
        config: z
          .object({
            defaultMaxOutputBytes: z.number().optional(),
            perToolMaxOutputBytes: z.record(z.string(), z.number()).optional(),
          })
          .optional(),
      })
      .parse(call.request);
    if (request.config?.defaultMaxOutputBytes && request.config.defaultMaxOutputBytes > 0) {
      catalog.truncation.defaultMaxOutputBytes = request.config.defaultMaxOutputBytes;
    }
    if (request.config?.perToolMaxOutputBytes) {
      catalog.truncation.perToolMaxOutputBytes = request.config.perToolMaxOutputBytes;
    }
    callback(null, {});
  });

  for (const rpc of [
    'EnableTool',
    'DisableTool',
    'SetToolOptions',
    'ResetToolOptions',
    'SetToolOverride',
    'ClearToolOverride',
  ]) {
    unary.set(rpc, (call, callback) => {
      const denied = guard(call.metadata);
      if (denied) return callback(denied);
      callback(null, { success: false, message: retired, effectiveOptionsJson: '{}' });
    });
  }
  unary.set('GetToolOptions', (call, callback) => {
    const denied = guard(call.metadata);
    if (denied) return callback(denied);
    callback(null, {
      toolName: '',
      effectiveOptionsJson: '{}',
      defaultOptionsJson: '{}',
      configuredOptionsJson: '{}',
    });
  });
}

function registerStream(input: {
  stream: Map<string, Stream>;
  guard: (metadata: grpc.Metadata) => { code: number; message: string } | undefined;
  catalog: ToolCatalog;
  refresh: () => Promise<void>;
  options: ServeComposioGrpcOptions;
}): void {
  const { stream, guard, catalog, options } = input;
  stream.set('ExecuteToolStream', call => {
    const denied = guard(call.metadata);
    if (denied) {
      call.emit('error', denied);
      return;
    }
    void (async () => {
      await input.refresh();
      const request = ExecuteToolRequestSchema.parse(call.request);
      const sizeError = chunkSizeError(request.options?.streamChunkSize);
      if (sizeError) {
        call.emit('error', { code: grpc.status.INVALID_ARGUMENT, message: sizeError });
        return;
      }
      const abort = listenForCancel(call);
      const body = await runTool({
        catalog,
        session: options.session,
        toolName: request.toolName ?? '',
        inputJson: request.inputJson ?? '',
        callId: request.callId,
        timeoutMs: positive(request.options?.timeoutMs),
        signal: abort.signal,
      });
      audit(options, body);
      if (call.cancelled) return;
      const size = normalizeChunkSize(request.options?.streamChunkSize);
      if (!body.ok) {
        call.write({
          callId: body.callId,
          finalResult: {
            metadata: {
              durationMs: body.durationMs,
              estimatedTokens: 0,
              truncated: false,
              toolVersion: body.version,
              contractVersion: 'current',
            },
            error: {
              code: body.error.code,
              message: body.error.message,
              detailsJson: body.error.detailsJson ?? '',
              retryable: body.error.retryable,
              suggestion: body.error.suggestion ?? '',
            },
            promptTextSize: 0,
            outputJsonSize: 0,
          },
        });
        call.end();
        return;
      }
      writeChunks(call, body.callId, 'STREAM_DATA_KIND_PROMPT_TEXT', body.success.promptText, size);
      writeChunks(call, body.callId, 'STREAM_DATA_KIND_OUTPUT_JSON', body.success.outputJson, size);
      call.write({
        callId: body.callId,
        finalResult: {
          metadata: {
            durationMs: body.durationMs,
            estimatedTokens: Math.ceil(utf8ByteLength(body.success.promptText) / 4),
            truncated: body.success.truncated,
            toolVersion: body.version,
            contractVersion: 'current',
          },
          promptTextSize: utf8ByteLength(body.success.promptText),
          outputJsonSize: utf8ByteLength(body.success.outputJson),
        },
      });
      call.end();
    })().catch(error => {
      call.emit('error', internal(error));
    });
  });
}

function writeChunks(
  call: grpc.ServerWritableStream<unknown, unknown>,
  callId: string,
  kind: string,
  text: string,
  size: number
): void {
  let offset = 0;
  for (const chunk of chunkUtf8(text, size)) {
    call.write({
      callId,
      data: { kind, data: chunk, offset },
    });
    offset += chunk.length;
  }
}

function listenForCancel(call: {
  on: (event: string, listener: () => void) => void;
}): AbortController {
  const abort = new AbortController();
  call.on('cancelled', () => abort.abort());
  return abort;
}

function audit(options: ServeComposioGrpcOptions, body: Awaited<ReturnType<typeof runTool>>): void {
  if (!options.onAudit) return;
  const outcome = body.ok ? 'completed' : outcomeFromCode(body.error.code);
  const event = ComposioGrpcAuditEventSchema.parse({
    callId: body.callId,
    toolName: body.slug,
    ...(options.userId ? { userId: options.userId } : {}),
    durationMs: body.durationMs,
    outcome,
  });
  try {
    options.onAudit(event);
  } catch {
    // Audit is observational. A throwing listener must not fail the RPC.
  }
}

function outcomeFromCode(code: string): ComposioGrpcAuditEvent['outcome'] {
  if (code === 'ERROR_CODE_PERMISSION_DENIED') return 'blocked';
  if (
    code === 'ERROR_CODE_TOOL_NOT_FOUND' ||
    code === 'ERROR_CODE_TOOL_DISABLED' ||
    code === 'ERROR_CODE_INVALID_INPUT' ||
    code === 'ERROR_CODE_INVALID_TOOL_NAME'
  ) {
    return 'rejected';
  }
  return 'failed';
}

function authorized(metadata: grpc.Metadata, expected: string | undefined): boolean {
  if (!expected) return true;
  const header = metadata.get('authorization').find(value => typeof value === 'string');
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = utf8Bytes(header.slice('Bearer '.length));
  const required = utf8Bytes(expected);
  if (presented.byteLength !== required.byteLength || presented.byteLength === 0) return false;
  let difference = 0;
  for (let index = 0; index < presented.byteLength; index += 1) {
    difference |= presented[index]! ^ required[index]!;
  }
  return difference === 0;
}

function parseTools(tools: readonly ComposioGrpcToolInput[]): ComposioGrpcToolInput[] {
  return tools.map(tool => ComposioGrpcToolInputSchema.parse(tool));
}

function formatViolations(violations: readonly FinalizeViolation[]): string {
  return violations.map(violation => `${violation.toolId}: ${violation.message}`).join('; ');
}

function positive(value: number | null | undefined): number | undefined {
  if (value == null || value <= 0) return undefined;
  return value;
}

function internal(error: unknown): { code: number; message: string } {
  const message = error instanceof Error ? error.message : 'Internal error';
  return { code: grpc.status.INTERNAL, message };
}

function unimplementedUnary(
  _call: grpc.ServerUnaryCall<unknown, unknown>,
  callback: grpc.sendUnaryData<unknown>
): void {
  callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented' });
}

function unimplementedStream(call: grpc.ServerWritableStream<unknown, unknown>): void {
  call.emit('error', { code: grpc.status.UNIMPLEMENTED, message: 'Not implemented' });
}
