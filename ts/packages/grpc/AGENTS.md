# AGENTS.md

gRPC adapter that serves a Composio session as `xai.grok.tools.v1.GrokToolsService`.

## Skill Routing

Use `typescript-sdk` for the server and client behavior. Use `typescript-testing` for Vitest and typecheck. Do not edit `proto/grok-tools.proto` to add fields. That file is the QENEX agent wire contract.

## Commands

From the repository root:

```bash
pnpm --filter @composio/grpc test
pnpm --filter @composio/grpc typecheck
pnpm --filter @composio/grpc build
```

## Rules

- Keep tool arguments and results out of audit events.
- Parse gRPC requests with zod. The proto-loader object is untrusted input.
- Bind to loopback unless the caller sets `host`.
