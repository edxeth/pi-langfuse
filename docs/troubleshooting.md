# Troubleshooting

## Check the resolved state

Run `/langfuse-status` in Pi. The command reports the effective config sources, host, masked public key, capture policy, active-run state, config path, runtime mode, and the last runtime error. It never prints the secret key.

Run `/langfuse-privacy` to inspect capture policy and payload budgets.

## No traces

Check these conditions in order:

1. Node.js is version 22 or newer.
2. `/langfuse-status` reports `ON` and runtime mode `v5-otel`.
3. The session has a persisted session file unless `skipUnpersistedSessions` is disabled.
4. The configured host is reachable and the public and secret keys belong to the same project.
5. The local health endpoint responds when using Docker Compose.

Use `/langfuse-test` to run an authenticated projects request and send an isolated test trace. The command has a bounded timeout and does not flush or close an active session runtime.

## Local Docker stack

Check the generated stack from its directory:

```bash
docker compose ps
docker compose logs langfuse-web langfuse-worker
curl http://localhost:3100/api/public/health
```

If autostart is disabled, start the stack with `docker compose up -d`. Init refuses directories with existing files, so it will not overwrite a working setup.

## Missing raw traces

Confirm `rawTraceEnabled` or `PI_LANGFUSE_RAW_TRACE=1`, then check `rawTraceDir`. Raw traces require a persisted session path. The extension drains its queued writes during session shutdown.

## Incomplete or abandoned observations

The extension closes unfinished prompt, turn, generation, and tool observations during agent finalization and session shutdown. A stalled exporter cannot block those boundaries indefinitely. Check `/langfuse-status` for the last runtime error, then inspect the raw trace for `session_end`.

## Package verification

From a checkout of the repository, run:

```bash
npm ci
npm run verify:release
```

The command checks production runtime dependencies and installs a temporary package tarball through `dist/index.js`. It does not contact Langfuse Cloud or publish the package.
