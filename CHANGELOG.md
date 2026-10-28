# Changelog

Notes for v2.1.2 and earlier are on the [GitHub releases page](https://github.com/edxeth/pi-langfuse/releases).

## [Unreleased]

### Breaking Changes

- Langfuse `llm-response` generation and `agent.turn` span outputs are now objects of the form `{ text, tool_calls, thinking? }` instead of plain strings, and `text` holds only the answer, without reasoning. Dashboards, evaluators, and scripts that read these outputs as strings must read `text` and handle `tool_calls`, because a tool-only response can have empty `text`. See [Structured assistant output](docs/migration.md#structured-assistant-output).

### Added

- Added the `/langfuse-score <good|bad> [comment]` command. It writes a `user_feedback` score (`good` = 1, `bad` = 0) on the current session's last finalized trace and redacts the comment first. See [/langfuse-score](README.md#langfuse-score).
- Added the prompt scores `last_tool_is_error`, `edit_write_call_count`, and `ask_user_wait_ms`, the time that [pi-ask](https://github.com/FasalZein/pi-ask) dialogs were open. See [Prompt scores](README.md#prompt-scores).

#### Pseudonymous identity mode
Refs: `b8c638b`

Added `identityMode: "pseudonymous"` (environment variable `PI_LANGFUSE_IDENTITY`). It replaces your home directory with `~`, also inside Pi session folder names, and replaces your user ID and repository names with salted pseudonyms in everything the extension sends or writes: Langfuse traces, scores, raw traces, and exports. Set `identityKeepRepo: true` (`PI_LANGFUSE_IDENTITY_KEEP_REPO`) to keep repository names readable. The default `raw` mode changes nothing.

The salt is created once and stored as `identitySalt` in `pi-langfuse.json`. If it cannot be created or read, the extension sends no telemetry and writes no raw traces instead of falling back to real names. Folder names, branch names, code, and prompts still pass through, so the mode reduces direct identifiers but does not anonymize. See [Identity pseudonymization](docs/privacy.md#identity-pseudonymization).

#### Training review records from raw traces
Refs: `b8c638b`

Added `pi-langfuse-export --format openai-chat|anthropic-messages|sharegpt`. Besides the usual artifacts, it writes `training-index.<format>.jsonl` with one record per normally completed assistant generation, taken from raw traces captured with `PI_LANGFUSE_RAW_PROVIDER_REQUEST=full`. Samples that cannot be shown complete and unambiguous are rejected, and `report.json` counts the reasons.

`--license <text>` and `--consent unknown|granted|denied` (config `exportLicense` and `exportConsent`) copy your declarations into every record, and `--consent denied` refuses the export. The option requires a completed TruffleHog scan, refuses `--no-trufflehog`, and always uses redaction and pseudonymous identity. The records are for review and do not grant training rights. See [Training review records](README.md#training-review-records---format).

### Changed

- Changed the export's TruffleHog scan to detection only (`--no-verification --no-update`), so it no longer sends candidate credentials to their vendors to check them.
- Changed the OpenTelemetry resource to report `service.name=pi-langfuse` and the package's `service.version` instead of the SDK default `unknown_service:<node binary path>`, which exposed a local install path.
- Changed raw `provider_request` summaries (the default `summary` mode) to keep at most 20 message previews of 200 characters each, with the system prompt and message summary together within 4,096 bytes.
- Changed raw `assistant_output` records: `text` holds only the answer, and the records add `toolCalls` and, when captured, visible `thinking`.
- Changed PIN and OTP redaction markers to carry no fingerprint (for example `[REDACTED:pin]`), because short codes can be recovered from unsalted hashes.
- Changed `/langfuse-privacy` to also show the identity mode.

### Fixed

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
