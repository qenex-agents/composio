import { utf8ByteLength } from './bytes';
import type { ComposioGrpcToolView } from './schema';
import type { ExecuteBody } from './execute';

/** Proto-loader response objects. Field names are the camelCase proto names. */
export function toolInfoMessage(
  view: ComposioGrpcToolView,
  includeSchemas: boolean
): Record<string, unknown> {
  return {
    name: view.name,
    displayName: view.displayName,
    description: view.description,
    shortDescription: view.displayName,
    category: 'TOOL_CATEGORY_EXTERNAL',
    inputSchemaJson: includeSchemas ? view.inputSchemaJson : '',
    enabled: view.enabled,
    capabilities: {
      supportsBackground: false,
      supportsStreaming: true,
      hasSideEffects: !view.readOnly,
      supportsCancellation: true,
      supportsTimeout: true,
      isReadOnly: view.readOnly,
      customCapabilities: ['composio', `slug:${view.slug}`],
    },
    version: view.version,
    source: 'TOOL_SOURCE_MCP',
    outputSchemaJson: includeSchemas ? view.outputSchemaJson : '',
    contractVersion: 'current',
    namespace: 'Composio',
    outputFormats: [
      {
        format: 'OUTPUT_FORMAT_DEFAULT',
        description: 'JSON result from the Composio session',
        defaultFields: ['output'],
      },
    ],
  };
}

export function executeResponse(body: ExecuteBody): Record<string, unknown> {
  const metadata = {
    durationMs: body.durationMs,
    estimatedTokens: body.ok ? Math.ceil(utf8ByteLength(body.success.promptText) / 4) : 0,
    truncated: body.ok ? body.success.truncated : false,
    toolVersion: body.version,
    contractVersion: 'current',
  };
  if (body.ok) {
    return {
      callId: body.callId,
      success: {
        outputJson: body.success.outputJson,
        promptText: body.success.promptText,
      },
      metadata,
    };
  }
  return {
    callId: body.callId,
    error: {
      code: body.error.code,
      message: body.error.message,
      detailsJson: body.error.detailsJson ?? '',
      retryable: body.error.retryable,
      suggestion: body.error.suggestion ?? '',
    },
    metadata,
  };
}
