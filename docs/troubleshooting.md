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

## Export accepted but not visible yet

Langfuse may index accepted exports asynchronously. Normal tracing does not query observation APIs or warn about indexing delay. Check the Langfuse UI when inspecting completeness; a successful export response is not a completeness or durability guarantee.

Export errors appear through Pi's notification UI rather than writing over the editor. Headless runs write diagnostics to stderr, leaving stdout unchanged. `/langfuse-status` shows the last historical error, not an active retry queue. Transient export errors retry within the current bounded send; they do not require another user message. Partial rejection and exhausted attempts are reported without keeping a recovery copy for later prompts.

## Export deadline warnings

An OTLP deadline warning means the endpoint did not confirm acceptance within the ten-second total budget, including retries and response reads. It does not prove that the server lost the span. The extension aborts the request and does not retain a replay copy.

Older versions used the two-second shutdown-step budget for HTTP exports as well. A successful response taking slightly over two seconds could therefore trigger both an export warning and an OTel flush warning. Export now owns a ten-second request deadline. Flush and shutdown await actual completion or cancellation instead of racing a second lifecycle timer.

If warnings continue, check endpoint latency, server load, and connectivity. A successful health request confirms reachability but does not measure OTLP ingestion latency. The session JSONL and raw trace do not contain these UI warnings or HTTP timing details, so retain the warning and its time when investigating server logs.

## Media attachments

The extension disables automatic SDK uploads of embedded image/audio data. The installed SDK cannot cancel those uploads, which could leave shutdown waiting indefinitely. Normal text, tool, usage, and trace hierarchy capture remains available. Media values follow the existing capture, redaction, and payload limits, without separate media attachments. Setting `LANGFUSE_MEDIA_UPLOAD_ENABLED` does not override this safety boundary.

## Package verification

From a checkout of the repository, run:

```bash
npm ci
npm run verify:release
```

The command checks production runtime dependencies and installs a temporary package tarball through `dist/index.js`. It does not contact Langfuse Cloud or publish the package.
