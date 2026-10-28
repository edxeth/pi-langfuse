# Changelog

Notes for v2.1.2 and earlier are on the [GitHub releases page](https://github.com/edxeth/pi-langfuse/releases).

## [Unreleased]

## [3.0.0] - 2026-10-28

### New Features

- **Pseudonymous identity mode**: Send traces without your home directory, user ID, or repository names in readable form. See [Identity pseudonymization](docs/privacy.md#identity-pseudonymization).
- **Training review records**: Turn raw traces into OpenAI Chat, Anthropic Messages, or ShareGPT records for review, with a required secret scan. See [Training review records](README.md#training-review-records---format).
- **Feedback scores**: Rate the last trace as good or bad from Pi with `/langfuse-score`. See [/langfuse-score](README.md#langfuse-score).

### Breaking Changes

- Removed the per-response `input_tokens`, `output_tokens`, and `total_cost` scores. Token usage and cost stay on each `llm-response` generation (`usageDetails`, `costDetails`), where Langfuse's usage and cost views read them. Each copy cost one HTTP request and one stored server object; together they were 87% of all score traffic. Dashboards and queries that read these score names must read the generation's usage and cost instead. A total cost of exactly zero was kept as a score; an all-zero cost is not recorded on the generation.
- Langfuse `llm-response` generation and `agent.turn` span outputs are now objects of the form `{ text, tool_calls, thinking? }` instead of plain strings, and `text` holds only the answer, without reasoning. Dashboards, evaluators, and scripts that read these outputs as strings must read `text` and handle `tool_calls`, because a tool-only response can have empty `text`. See [Structured assistant output](docs/migration.md#structured-assistant-output).

### Added

- Added the `/langfuse-score <good|bad> [comment]` command. It writes a `user_feedback` score (`good` = 1, `bad` = 0) on the current session's last finalized trace and redacts the comment first. See [/langfuse-score](README.md#langfuse-score).
- Added the prompt scores `last_tool_is_error`, `edit_write_call_count`, and `ask_user_wait_ms`, the time that [pi-ask](https://github.com/FasalZein/pi-ask) dialogs were open. See [Prompt scores](README.md#prompt-scores).
- Added the `captureProvenance` field to raw `provider_request` and `assistant_output` records. For each content field it states whether capture policy or payload limits changed the value. Raw `provider_request` records also add `serverSideContext`, the names of fields such as `previous_response_id` that refer to context held by the provider. See [Truncation and privacy](docs/architecture.md#truncation-and-privacy).

#### Pseudonymous identity mode
Refs: `b8c638b`

Added `identityMode: "pseudonymous"` (environment variable `PI_LANGFUSE_IDENTITY`). It replaces your home directory with `~`, also inside Pi session folder names, and replaces your user ID and repository names with salted pseudonyms in everything the extension sends or writes: Langfuse traces, scores, raw traces, and exports. Set `identityKeepRepo: true` (`PI_LANGFUSE_IDENTITY_KEEP_REPO`) to keep repository names readable. The default `raw` mode changes nothing.

The salt is created once and stored as `identitySalt` in `pi-langfuse.json`. If it cannot be created or read, the extension sends no telemetry and writes no raw traces instead of falling back to real names. Folder names, branch names, code, and prompts still pass through, so the mode reduces direct identifiers but does not anonymize. See [Identity pseudonymization](docs/privacy.md#identity-pseudonymization).

#### Training review records from raw traces
Refs: `b8c638b`

Added `pi-langfuse-export --format openai-chat|anthropic-messages|sharegpt`. Besides the usual artifacts, it writes `training-index.<format>.jsonl` with one record per normally completed assistant generation, taken from raw traces captured with `PI_LANGFUSE_RAW_PROVIDER_REQUEST=full`. Samples that cannot be shown complete and unambiguous are rejected, and `report.json` counts the reasons.

`--license <text>` and `--consent unknown|granted|denied` (config `exportLicense` and `exportConsent`) copy your declarations into every record, and `--consent denied` refuses the export. The option requires a completed TruffleHog scan, refuses `--no-trufflehog`, and always uses redaction and pseudonymous identity. The records are for review and do not grant training rights. See [Training review records](README.md#training-review-records---format).

### Changed

- Changed span export to batches. An ended span waits up to two seconds for others; the end of a turn or prompt, a flush, and shutdown send at once. On the self-hosted v3 server every request that carries a trace stores one more file that each later merge of that trace rereads, so fewer requests cut server load sharply (about 65% fewer requests per trace in local data).
- Changed prompt completion (`agent_settled`) to stop waiting for delivery. Pi stays busy until settlement handlers return, so a slow Langfuse delayed every prompt end. Session shutdown still waits for every send.
- Changed transient export failures (network errors, HTTP 429/502/503/504) to retry until the ten-second deadline instead of stopping after four attempts, so a server that restarts its database loses nothing. Attempts are at least 250 ms apart, even when a `Retry-After` header asks for no wait. Scores now use the same deadline and retries instead of one two-second attempt, and each score keeps one id across retries, so a retry cannot add a second score.
- Changed tool progress handling. `tool_execution_update` no longer summarizes, redacts, and applies each partial result to the span, which never reached Langfuse because a span is exported once, at its end. The latest progress output is recorded only when a tool ends without a final result, marked `metadata.partial`. Completed tool spans no longer keep a stale `metadata.partial = true`.
- Changed configuration reads: `pi-langfuse.json` and the environment are read when a session or prompt starts, not on every event. A file edit applies from the next prompt.
- Changed diagnostics. Pi shows each distinct cause at most once every 15 minutes, and every occurrence is appended to `$PI_CODING_AGENT_DIR/langfuse/diagnostics.jsonl` (owner-only, capped at 1 MB). `/langfuse-status` shows the log path.
- Changed `/langfuse-init` to write `http://127.0.0.1:3100` as the local host. The stack listens on IPv4 only, and `localhost` often resolves to IPv6 first, which adds about 250 ms to every new connection.
- Changed git source metadata collection to two parallel, non-blocking git calls instead of five synchronous ones at every prompt start.
- Reduced the extension's CPU use: environment-secret collection no longer reruns its key analysis for every redacted string, and a record is shaped with one secret collection. With the configuration, tool-progress, and git changes above, extension CPU in a synthetic streaming benchmark (`npm run bench`: 10 turns, 20,000 text deltas, 30 tool calls; median of three runs) dropped from about 6.1 s to 1.3 s, and `message_update` from about 0.07 ms to 0.008 ms per event.
- Changed the export's TruffleHog scan to detection only (`--no-verification --no-update`), so it no longer sends candidate credentials to their vendors to check them.
- Changed the OpenTelemetry resource to report `service.name=pi-langfuse` and the package's `service.version` instead of the SDK default `unknown_service:<node binary path>`, which exposed a local install path.
- Changed raw `provider_request` summaries (the default `summary` mode) to keep at most 20 message previews of 200 characters each, with the system prompt and message summary together within 4,096 bytes.
- Changed raw `assistant_output` records: `text` holds only the answer, and the records add `toolCalls` and, when captured, visible `thinking`.
- Changed PIN and OTP redaction markers to carry no fingerprint (for example `[REDACTED:pin]`), because short codes can be recovered from unsalted hashes.
- Changed `/langfuse-privacy` to also show the identity mode.
- Changed full provider-request copies in telemetry to keep OpenAI Responses `reasoning.summary` text under the assistant-output capture policy. Before, reasoning summaries were always left out. Reasoning `content`, `encrypted_content`, and other opaque reasoning data are still always left out, and the requests sent to providers do not change.

### Fixed

- Fixed local autostart recreating running Langfuse containers. The health check gave up after 200 ms, which a healthy stack misses where `localhost` resolves to IPv6 first, so the first prompt of every Pi process ran `docker compose up -d` with that process's environment. A project environment that sets variables such as `POSTGRES_USER` changed the stack's configuration, and Compose recreated Postgres, which interrupted ingestion for every session. Autostart now checks in the background with a 2,000 ms deadline (`localAutostartTimeoutMs`, environment variable `PI_LANGFUSE_AUTOSTART_TIMEOUT_MS`), runs `docker compose up -d --no-recreate`, and passes only the variables the Docker client needs.
- Fixed `agent.turn` spans recording no input. Each turn now records the messages newly delivered at its provider request, shaped by the capture policy.

#### Runs started by extension messages are traced on Pi 1.2 and later
Refs: `b663a8b`, `b8c638b`

Fixed runs that extensions start with `pi.sendMessage(..., { triggerTurn: true })` on Pi 1.2.0 and later. These runs got no trace, and the extension logged "Failed to create trace".

They are now traced as runs without a user prompt, so the custom message is not recorded as trace input. Pi versions from 0.87.1 still work.

#### Bursts of ended spans no longer drop spans
Refs: `b8c638b`

Fixed spans being dropped when many ended at once. Each ended span opened its own export request, so bursts missed their export deadlines under load.

At most four exports now run at once, and spans that arrive while they run are sent together in one export. Flushing and shutdown also wait for those spans.

#### Redaction catches more secret assignments
Refs: `b8c638b`

Fixed secrets that redaction missed: assignments written in prose, after JSON, or inside JSON strings, bare-word values after sensitive quoted keys, and values that end in escaped backslashes. The same scanner serves live redaction and the export's secret scan.

Where a quote could either end a string or start a value, the whole text is now omitted instead of guessed. The known limits are listed in the [trace-quality plan](docs/plans/2026-10-13-trace-quality-optimization-plan.md).
