import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectComposioGrpc, serveComposioGrpc, type ComposioGrpcSession } from '../src/index';
import type { ComposioGrpcServerHandle } from '../src/server';

const github = {
  slug: 'GITHUB_GET_USER',
  name: 'Get user',
  description: 'Look up a GitHub user',
  inputParameters: {
    type: 'object',
    properties: { login: { type: 'string' } },
    required: ['login'],
  },
  outputParameters: { type: 'object', properties: { login: { type: 'string' } } },
  version: '20260101_00',
  tags: ['readOnly'],
};

const send = {
  slug: 'GMAIL_SEND_EMAIL',
  name: 'Send email',
  description: 'Send an email',
  inputParameters: { type: 'object', properties: { to: { type: 'string' } } },
  tags: ['write'],
};

function session(): ComposioGrpcSession & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async execute(slug, args, _options, request) {
      calls.push(slug);
      if (request?.signal?.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      if (slug === 'SLOW_TOOL') {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          request?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }
      if (slug === 'GITHUB_GET_USER') {
        return {
          data: { login: String(args?.login ?? '') },
          error: null,
          logId: 'log_ok',
          resultType: 'completed',
        };
      }
      if (slug === 'BLOCKED_TOOL') {
        return { data: {}, error: 'blocked by hook', logId: 'log_blocked', resultType: 'blocked' };
      }
      if (slug === 'NEEDS_INPUT') {
        const error = new Error('Need approval');
        error.name = 'ComposioToolInputRequiredError';
        throw error;
      }
      return { data: {}, error: 'vendor failed', logId: 'log_fail', resultType: 'failed' };
    },
  };
}

describe('Composio gRPC server', () => {
  let server: ComposioGrpcServerHandle;
  const backend = session();

  beforeAll(async () => {
    server = await serveComposioGrpc({
      session: backend,
      tools: [
        github,
        send,
        { slug: 'SLOW_TOOL', description: 'hangs' },
        { slug: 'BLOCKED_TOOL' },
        { slug: 'NEEDS_INPUT' },
      ],
      port: 0,
      authToken: 'test-token',
      userId: 'agent-user',
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  it('rejects a missing bearer token', async () => {
    const client = await connectComposioGrpc({ address: server.address });
    await expect(client.listTools()).rejects.toMatchObject({ code: 16 });
    client.close();
  });

  it('lists Composio tools with schemas and executes one', async () => {
    const client = await connectComposioGrpc({ address: server.address, authToken: 'test-token' });
    const listed = await client.listTools();
    const found = listed.tools.find(tool => tool.slug === 'GITHUB_GET_USER');
    expect(found).toMatchObject({
      id: 'Composio:GITHUB_GET_USER',
      name: 'GITHUB_GET_USER',
      description: 'Look up a GitHub user',
      enabled: true,
      version: '20260101_00',
      inputSchema: github.inputParameters,
    });
    expect(listed.enabledCount).toBe(listed.tools.length);

    const result = await client.execute('GITHUB_GET_USER', { login: 'octocat' });
    expect(result).toMatchObject({
      ok: true,
      data: { login: 'octocat' },
      truncated: false,
    });
    client.close();
  });

  it('maps failed, blocked, and input-required executions', async () => {
    const client = await connectComposioGrpc({ address: server.address, authToken: 'test-token' });
    const failed = await client.execute('GMAIL_SEND_EMAIL', { to: 'a@b.c' });
    expect(failed).toMatchObject({
      ok: false,
      code: 'ERROR_CODE_EXECUTION_FAILED',
      message: 'vendor failed',
    });

    const blocked = await client.execute('BLOCKED_TOOL', {});
    expect(blocked).toMatchObject({
      ok: false,
      code: 'ERROR_CODE_PERMISSION_DENIED',
      message: 'blocked by hook',
    });

    const needsInput = await client.execute('NEEDS_INPUT', {});
    expect(needsInput).toMatchObject({
      ok: false,
      code: 'ERROR_CODE_MISSING_REQUIRED_FIELD',
      message: 'Need approval',
    });
    client.close();
  });

  it('rejects unknown tools and invalid input without calling the session', async () => {
    const client = await connectComposioGrpc({ address: server.address, authToken: 'test-token' });
    const before = backend.calls.length;
    const missing = await client.execute('NO_SUCH_TOOL', {});
    expect(missing).toMatchObject({ ok: false, code: 'ERROR_CODE_TOOL_NOT_FOUND' });
    const invalid = await client.execute('GITHUB_GET_USER', {});
    // A JSON object is valid even when the schema requires login. The session sees it.
    expect(invalid.ok).toBe(true);
    expect(backend.calls.length).toBe(before + 1);

    const raw = await connectRaw(server.address);
    const badJson = await raw.execute({ toolName: 'GITHUB_GET_USER', inputJson: '[' });
    expect(badJson.error).toMatchObject({ code: 'ERROR_CODE_INVALID_INPUT' });
    raw.close();
    client.close();
  });

  it('locks the tool set on finalize and accepts the fully qualified id', async () => {
    const local = await serveComposioGrpc({
      session: backend,
      tools: [github, send],
      port: 0,
      authToken: 'test-token',
    });
    const client = await connectComposioGrpc({ address: local.address, authToken: 'test-token' });
    const rejected = await client.finalize([{ id: 'Composio:NOT_A_TOOL' }]);
    expect(rejected.success).toBe(false);
    expect(rejected.message).toContain('NOT_A_TOOL');

    const stillWorks = await client.execute('GMAIL_SEND_EMAIL', {});
    expect(stillWorks).toMatchObject({ ok: false, code: 'ERROR_CODE_EXECUTION_FAILED' });

    const locked = await client.finalize([
      {
        id: 'Composio:GITHUB_GET_USER',
        nameOverride: 'lookup_user',
        descriptionOverride: 'Lookup only',
      },
    ]);
    expect(locked.success).toBe(true);
    expect(locked.tools.map(tool => tool.slug)).toEqual(['GITHUB_GET_USER']);
    expect(locked.tools[0]).toMatchObject({ name: 'lookup_user', description: 'Lookup only' });

    const hidden = await client.execute('GMAIL_SEND_EMAIL', {});
    expect(hidden).toMatchObject({ ok: false, code: 'ERROR_CODE_TOOL_DISABLED' });

    const renamed = await client.execute('lookup_user', { login: 'qenex' });
    expect(renamed).toMatchObject({ ok: true, data: { login: 'qenex' } });
    client.close();
    await local.stop();
  });

  it('times out a tool that ignores neither the abort signal nor the deadline', async () => {
    const client = await connectComposioGrpc({ address: server.address, authToken: 'test-token' });
    const result = await client.execute('SLOW_TOOL', {}, { timeoutMs: 30 });
    expect(result).toMatchObject({ ok: false, code: 'ERROR_CODE_TIMEOUT', retryable: true });
    client.close();
  });

  it('omits schemas when include_schemas is false and filters other categories', async () => {
    const raw = await connectRaw(server.address);
    const bare = await raw.list({ includeSchemas: false, category: 'TOOL_CATEGORY_EXTERNAL' });
    expect(bare.tools[0].inputSchemaJson).toBe('');
    const files = await raw.list({ includeSchemas: true, category: 'TOOL_CATEGORY_FILE' });
    expect(files.tools).toEqual([]);
    raw.close();
  });

  it('streams the prompt and JSON, then a final metadata chunk', async () => {
    const raw = await connectRaw(server.address);
    const chunks = await raw.stream({
      toolName: 'GITHUB_GET_USER',
      inputJson: '{"login":"stream"}',
      options: { streamChunkSize: 8 },
    });
    const text = chunks
      .filter(chunk => chunk.data?.kind === 'STREAM_DATA_KIND_PROMPT_TEXT')
      .map(chunk => Buffer.from(chunk.data?.data ?? []).toString('utf8'))
      .join('');
    const json = chunks
      .filter(chunk => chunk.data?.kind === 'STREAM_DATA_KIND_OUTPUT_JSON')
      .map(chunk => Buffer.from(chunk.data?.data ?? []).toString('utf8'))
      .join('');
    expect(JSON.parse(json)).toEqual({ login: 'stream' });
    expect(text).toContain('stream');
    expect(chunks.at(-1)?.finalResult?.outputJsonSize).toBe(Buffer.byteLength(json));
    raw.close();
  });

  it('records an audit event without the tool arguments', async () => {
    const audits: Array<Record<string, unknown>> = [];
    const local = await serveComposioGrpc({
      session: backend,
      tools: [github],
      port: 0,
      userId: 'agent-user',
      onAudit: event => {
        audits.push(event);
      },
    });
    const client = await connectComposioGrpc({ address: local.address });
    await client.execute('GITHUB_GET_USER', { login: 'secret-login' });
    expect(audits).toEqual([
      expect.objectContaining({
        toolName: 'GITHUB_GET_USER',
        userId: 'agent-user',
        outcome: 'completed',
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain('secret-login');
    client.close();
    await local.stop();
  });
});

async function connectRaw(address: string) {
  const grpc = await import('@grpc/grpc-js');
  const { loadGrokToolsService } = await import('../src/proto');
  const Service = await loadGrokToolsService();
  const client = new Service(address, grpc.credentials.createInsecure());
  const metadata = new grpc.Metadata();
  metadata.set('authorization', 'Bearer test-token');

  const unary = (method: string, request: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const fn = (
        client as unknown as Record<
          string,
          (
            req: unknown,
            md: unknown,
            cb: (err: Error | null, res: Record<string, unknown>) => void
          ) => void
        >
      )[method];
      if (!fn) {
        reject(new Error(`missing ${method}`));
        return;
      }
      fn.call(client, request, metadata, (error, response) => {
        if (error) reject(error);
        else resolve(response);
      });
    });

  return {
    close: () => client.close(),
    execute: async (request: unknown) => {
      const response = await unary('executeTool', request);
      const error = response.error as { code?: string; message?: string } | undefined;
      return { error };
    },
    list: async (request: unknown) => {
      const response = await unary('listTools', request);
      return {
        tools: (response.tools as Array<{ inputSchemaJson?: string }> | undefined) ?? [],
      };
    },
    stream: (request: unknown) =>
      new Promise<
        Array<{
          data?: { kind?: string; data?: Uint8Array };
          finalResult?: { outputJsonSize?: number };
        }>
      >((resolve, reject) => {
        const fn = (
          client as unknown as Record<string, (req: unknown, md: unknown) => { on: Function }>
        )['executeToolStream'];
        if (!fn) {
          reject(new Error('missing executeToolStream'));
          return;
        }
        const call = fn.call(client, request, metadata);
        const chunks: Array<{
          data?: { kind?: string; data?: Uint8Array };
          finalResult?: { outputJsonSize?: number };
        }> = [];
        call.on(
          'data',
          (chunk: {
            data?: { kind?: string; data?: Uint8Array };
            finalResult?: { outputJsonSize?: number };
          }) => chunks.push(chunk)
        );
        call.on('end', () => resolve(chunks));
        call.on('error', (error: Error) => reject(error));
      }),
  };
}
