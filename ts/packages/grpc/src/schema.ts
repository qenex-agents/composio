import { z } from 'zod';

/** Fully-qualified tool id QENEX agents send in `FinalizeToolConfigRequest`. */
export const COMPOSIO_TOOL_NAMESPACE = 'Composio';

const JsonObjectSchema = z.record(z.string(), z.unknown());

export const ComposioGrpcToolInputSchema = z.object({
  slug: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  inputParameters: JsonObjectSchema.optional(),
  outputParameters: JsonObjectSchema.optional(),
  version: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type ComposioGrpcToolInput = z.infer<typeof ComposioGrpcToolInputSchema>;

export const ComposioGrpcExecuteResultSchema = z.object({
  data: JsonObjectSchema,
  error: z.string().nullable(),
  logId: z.string(),
  resultType: z.enum(['completed', 'failed', 'blocked']),
});
export type ComposioGrpcExecuteResult = z.infer<typeof ComposioGrpcExecuteResultSchema>;

/**
 * The slice of a Composio session this server calls.
 * `session.execute()` from `@composio/core` already has this shape.
 */
export interface ComposioGrpcSession {
  execute(
    toolSlug: string,
    arguments_?: Record<string, unknown>,
    options?: { account?: string },
    requestOptions?: { signal?: AbortSignal }
  ): Promise<ComposioGrpcExecuteResult>;
}

export const ComposioGrpcAuditEventSchema = z.object({
  callId: z.string(),
  toolName: z.string(),
  userId: z.string().optional(),
  durationMs: z.number(),
  outcome: z.enum(['completed', 'failed', 'blocked', 'rejected']),
});
export type ComposioGrpcAuditEvent = z.infer<typeof ComposioGrpcAuditEventSchema>;

export interface ComposioGrpcToolView {
  readonly slug: string;
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly inputSchemaJson: string;
  readonly outputSchemaJson: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly readOnly: boolean;
}

const LongSchema = z.union([z.number(), z.string(), z.bigint()]).transform((value, ctx) => {
  const parsed = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    ctx.addIssue({ code: 'custom', message: 'Expected a non-negative number' });
    return z.NEVER;
  }
  return parsed;
});

const ExternalCategorySchema = z.union([
  z.undefined(),
  z.literal(0),
  z.literal(5),
  z.literal('TOOL_CATEGORY_UNSPECIFIED'),
  z.literal('TOOL_CATEGORY_EXTERNAL'),
  z.literal(''),
]);

export const ListToolsRequestSchema = z.object({
  category: z.unknown().optional(),
  includeDisabled: z.boolean().optional(),
  includeSchemas: z.boolean().optional(),
});

export const GetToolInfoRequestSchema = z.object({
  toolName: z.string().optional(),
});

export const ExecuteToolRequestSchema = z.object({
  toolName: z.string().nullish(),
  inputJson: z.string().nullish(),
  callId: z.string().nullish(),
  options: z
    .object({
      timeoutMs: LongSchema.nullish(),
      streamChunkSize: LongSchema.nullish(),
    })
    .nullish(),
});

const ToolConfigEntrySchema = z.object({
  id: z.string().optional(),
  paramsJson: z.string().optional(),
  nameOverride: z.string().optional(),
  descriptionOverride: z.string().optional(),
  paramsNameOverrides: z.record(z.string(), z.string()).optional(),
});

export const FinalizeRequestSchema = z.object({
  tools: z.array(ToolConfigEntrySchema).optional(),
  truncation: z
    .object({
      defaultMaxOutputBytes: LongSchema.optional(),
      perToolMaxOutputBytes: z.record(z.string(), LongSchema).optional(),
    })
    .optional(),
  systemRemindersEnabled: z.boolean().optional(),
  initialToolStateJson: z.string().optional(),
  behaviorPreset: z.string().optional(),
  clientCallbackAddr: z.string().optional(),
  sessionId: z.string().optional(),
});

export const ArgumentsSchema = z.record(z.string(), z.unknown());

export const DEFAULT_MAX_OUTPUT_BYTES = 40 * 1024;
export const DEFAULT_STREAM_CHUNK_BYTES = 1024 * 1024;
export const MAX_STREAM_CHUNK_BYTES = 4 * 1024 * 1024;

export function composioToolId(slug: string): string {
  return `${COMPOSIO_TOOL_NAMESPACE}:${slug}`;
}

export function canonicalSlug(
  toolName: string,
  known: ReadonlyMap<string, string>
): string | undefined {
  const trimmed = toolName.trim();
  if (trimmed.length === 0) return undefined;
  const direct = known.get(trimmed) ?? known.get(trimmed.toUpperCase());
  if (direct) return direct;
  const colon = trimmed.indexOf(':');
  if (colon === -1) return undefined;
  const rest = trimmed.slice(colon + 1);
  return known.get(rest) ?? known.get(rest.toUpperCase());
}

export function isExternalCategory(category: unknown): boolean {
  return ExternalCategorySchema.safeParse(category).success;
}

export function readOnlyFromTags(tags: readonly string[] | undefined): boolean {
  return (tags ?? []).some(
    tag => tag.toLowerCase() === 'readonly' || tag.toLowerCase() === 'read-only'
  );
}
