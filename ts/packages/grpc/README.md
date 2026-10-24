# @composio/grpc

`@composio/grpc` exposes a Composio session on the gRPC service QENEX agents already call: `xai.grok.tools.v1.GrokToolsService`.

You run this server next to the agent. The server holds the Composio session and the API key. The agent lists tools, finalizes the set it will call, and executes them. It does not talk to Composio itself.

```ts
import { Composio } from '@composio/core';
import { connectComposioGrpc, serveComposioGrpc } from '@composio/grpc';

const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY! });
const userId = 'agent-user';
const session = await composio.create(userId);
const tools = await composio.tools.get(userId, { toolkits: ['github'] });

const server = await serveComposioGrpc({
  session,
  tools,
  userId,
  port: 50051,
  authToken: process.env.QENEX_GRPC_TOKEN,
});

const agent = await connectComposioGrpc({
  address: server.address,
  authToken: process.env.QENEX_GRPC_TOKEN,
});

const listed = await agent.listTools();
await agent.finalize(listed.tools.map(tool => ({ id: tool.id })));
const user = await agent.execute('GITHUB_GET_USER', { login: 'octocat' });
```

The wire contract is `proto/grok-tools.proto`. A Rust or Python agent uses the same service. Tool ids in `FinalizeToolConfigRequest` are `Composio:<SLUG>`, for example `Composio:GITHUB_GET_USER`. `ExecuteTool.tool_name` accepts that id, the slug, or a `name_override` from finalize.

`ListTools` returns schemas only when `include_schemas` is true. `connectComposioGrpc` sets that flag.

Before finalize, every tool you passed in can run. Finalize locks the server to the ids you send. An id that is not in the catalog leaves the previous lock in place and returns `success: false`.

Pass `authToken` and every call must send `authorization: Bearer <token>`. The server binds to `127.0.0.1` unless you set `host`. Terminate TLS on the proxy in front of it. The socket itself is plaintext.

`onAudit` receives the call id, tool slug, user id, duration, and outcome. It does not receive arguments or results.

Output is clipped at 40KB, matching the proto's default truncation. Set a different cap with `SetTruncationConfig` or the `truncation` field on finalize. A clipped JSON result is wrapped as `{ "truncated": true, "bytes": N, "preview": "..." }` and the execute metadata says `truncated`.

This server does not dial `GrokToolsCallbackService`. A finalize request that sets `client_callback_addr` still succeeds, and `callback_status.connected` is false.
