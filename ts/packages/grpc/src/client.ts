import * as grpc from '@grpc/grpc-js';
import { z } from 'zod';
import { CHANNEL_OPTIONS, loadGrokToolsService, type GrpcServiceCtor } from './proto';
import { ArgumentsSchema, composioToolId } from './schema';

const ToolInfoSchema = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  inputSchemaJson: z.string().optional(),
  outputSchemaJson: z.string().optional(),
  enabled: z.boolean().optional(),
  version: z.string().optional(),
  namespace: z.string().optional(),
  capabilities: z
    .object({
      customCapabilities: z.array(z.string()).optional(),
    })
    .optional(),
});

const ExecuteResponseSchema = z.object({
  callId: z.string().optional(),
  success: z
    .object({
      outputJson: z.string().optional(),
      promptText: z.string().optional(),
    })
    .optional(),
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
      detailsJson: z.string().optional(),
      retryable: z.boolean().optional(),
      suggestion: z.string().optional(),
    })
    .optional(),
  metadata: z
    .object({
      durationMs: z.number().optional(),
      truncated: z.boolean().optional(),
      toolVersion: z.string().optional(),
    })
    .optional(),
});

export interface ComposioGrpcToolDescription {
  slug: string;
  id: string;
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  enabled: boolean;
  version: string;
}

export type ComposioGrpcCallResult =
  | {
      ok: true;
      callId: string;
      data: Record<string, unknown>;
      promptText: string;
      truncated: boolean;
      durationMs: number;
    }
  | {
      ok: false;
      callId: string;
      code: string;
      message: string;
      retryable: boolean;
      suggestion?: string;
      details?: unknown;
    };

export interface ComposioGrpcClient {
  listTools(options?: { includeSchemas?: boolean; includeDisabled?: boolean }): Promise<{
    tools: ComposioGrpcToolDescription[];
    totalCount: number;
    enabledCount: number;
  }>;
  getTool(name: string): Promise<ComposioGrpcToolDescription>;
  execute(
    name: string,
    input?: Record<string, unknown>,
    options?: { timeoutMs?: number; callId?: string }
  ): Promise<ComposioGrpcCallResult>;
  finalize(
    tools: readonly { id: string; nameOverride?: string; descriptionOverride?: string }[]
  ): Promise<{
    success: boolean;
    message: string;
    tools: ComposioGrpcToolDescription[];
  }>;
  close(): void;
}

export async function connectComposioGrpc(options: {
  address: string;
  authToken?: string;
}): Promise<ComposioGrpcClient> {
  const Service = await loadGrokToolsService();
  const client = new Service(options.address, grpc.credentials.createInsecure(), CHANNEL_OPTIONS);
  const metadata = new grpc.Metadata();
  if (options.authToken) metadata.set('authorization', `Bearer ${options.authToken}`);
  return new Client(client, metadata);
}

class Client implements ComposioGrpcClient {
  constructor(
    private readonly client: InstanceType<GrpcServiceCtor>,
    private readonly metadata: grpc.Metadata
  ) {}

  async listTools(options?: { includeSchemas?: boolean; includeDisabled?: boolean }) {
    const response = await this.unary('listTools', {
      includeSchemas: options?.includeSchemas ?? true,
      includeDisabled: options?.includeDisabled ?? false,
      category: 'TOOL_CATEGORY_EXTERNAL',
    });
    const parsed = z
      .object({
        tools: z.array(ToolInfoSchema).optional(),
        totalCount: z.number().optional(),
        enabledCount: z.number().optional(),
      })
      .parse(response);
    const tools = (parsed.tools ?? []).map(describeTool);
    return {
      tools,
      totalCount: parsed.totalCount ?? tools.length,
      enabledCount: parsed.enabledCount ?? tools.filter(tool => tool.enabled).length,
    };
  }

  async getTool(name: string): Promise<ComposioGrpcToolDescription> {
    const response = await this.unary('getToolInfo', { toolName: name });
    return describeTool(ToolInfoSchema.parse(response));
  }

  async execute(
    name: string,
    input: Record<string, unknown> = {},
    options?: { timeoutMs?: number; callId?: string }
  ) {
    const response = ExecuteResponseSchema.parse(
      await this.unary('executeTool', {
        toolName: name,
        inputJson: JSON.stringify(input),
        callId: options?.callId ?? '',
        options: { timeoutMs: options?.timeoutMs ?? 0 },
      })
    );
    return toCallResult(response);
  }

  async finalize(
    tools: readonly { id: string; nameOverride?: string; descriptionOverride?: string }[]
  ) {
    const response = z
      .object({
        success: z.boolean(),
        message: z.string().optional(),
        tools: z.array(ToolInfoSchema).optional(),
      })
      .parse(
        await this.unary('finalizeToolConfigRequest', {
          tools: tools.map(tool => ({
            id: tool.id,
            nameOverride: tool.nameOverride ?? '',
            descriptionOverride: tool.descriptionOverride ?? '',
          })),
        })
      );
    return {
      success: response.success,
      message: response.message ?? '',
      tools: (response.tools ?? []).map(describeTool),
    };
  }

  close(): void {
    this.client.close();
  }

  private unary(method: string, request: unknown): Promise<unknown> {
    const fn = (this.client as unknown as Record<string, unknown>)[method];
    if (typeof fn !== 'function') {
      throw new Error(`GrokToolsService.${method} is not on the loaded client`);
    }
    return new Promise((resolve, reject) => {
      fn.call(
        this.client,
        request,
        this.metadata,
        (error: grpc.ServiceError | null, response: unknown) => {
          if (error) reject(error);
          else resolve(response);
        }
      );
    });
  }
}

function describeTool(info: z.infer<typeof ToolInfoSchema>): ComposioGrpcToolDescription {
  const tagged = info.capabilities?.customCapabilities?.find(capability =>
    capability.startsWith('slug:')
  );
  const slug = tagged ? tagged.slice('slug:'.length) : info.name;
  return {
    slug,
    id: composioToolId(slug),
    name: info.name,
    description: info.description ?? '',
    inputSchema: parseSchema(info.inputSchemaJson),
    outputSchema: parseSchema(info.outputSchemaJson),
    enabled: info.enabled ?? false,
    version: info.version ?? '',
  };
}

function parseSchema(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function toCallResult(response: z.infer<typeof ExecuteResponseSchema>): ComposioGrpcCallResult {
  const callId = response.callId ?? '';
  if (response.error && response.error.message) {
    let details: unknown;
    if (response.error.detailsJson) {
      try {
        details = JSON.parse(response.error.detailsJson) as unknown;
      } catch {
        details = response.error.detailsJson;
      }
    }
    return {
      ok: false,
      callId,
      code: response.error.code ?? 'ERROR_CODE_UNSPECIFIED',
      message: response.error.message,
      retryable: response.error.retryable ?? false,
      ...(response.error.suggestion ? { suggestion: response.error.suggestion } : {}),
      ...(details !== undefined ? { details } : {}),
    };
  }
  const outputJson = response.success?.outputJson ?? '{}';
  let data: Record<string, unknown> = {};
  try {
    const parsed = ArgumentsSchema.safeParse(JSON.parse(outputJson));
    if (parsed.success) data = parsed.data;
  } catch {
    data = {};
  }
  return {
    ok: true,
    callId,
    data,
    promptText: response.success?.promptText ?? '',
    truncated: response.metadata?.truncated ?? false,
    durationMs: response.metadata?.durationMs ?? 0,
  };
}
