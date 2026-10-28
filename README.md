# pi-langfuse

Full-stack Langfuse observability for [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent). The extension records live traces and redacted training exports.

Every prompt, turn, tool call, and streaming response is traced with cost and token metadata. Secrets and PII are redacted at the extension boundary before anything leaves your machine. An optional append-only JSONL companion stream gives you training-ready, audit-safe data without touching Pi's original session files.

## Node.js 22+ release

The 2.0 release line requires Node.js 22 or newer. Both registry and Git installs load `src/index.ts` through Pi's TypeScript extension loader. The npm API and export CLI use the compiled `dist` files. Existing trace names, raw-trace records, local Server v3 files, credentials, and volumes remain compatible.

See [Migration to 2.0](./docs/migration.md) before upgrading.

![Traces in Langfuse UI](./docs/screenshot-trace.png)
![Export pipeline output](./docs/screenshot-export.png)

## Features

- **Hierarchical Tracing**: Maps user prompts to per-turn spans and nested tool executions.
- **Streaming Generation**: Captures assistant responses as they stream.
- **LLM Metadata**: Records model, provider, token usage, and cost fields when pricing is configured.
- **Tool Observability**: Captures tool calls, sanitized arguments/results, and duration.
- **Session Correlation**: Groups prompts from the same Pi session into one Langfuse session.
- **Setup Wizard**: `/langfuse-init` configures either local self-hosted Langfuse or a remote/Langfuse Cloud endpoint.
- **Local-First Setup**: Local mode creates a self-hosted localhost Langfuse stack with generated secrets.
- **Autostart**: Once local init is complete, the extension starts Docker Compose on demand when tracing begins.
- **Raw Traces**: Optional redacted JSONL companion stream for training, distillation, and audit workflows.
- **Langfuse v5 and OpenTelemetry**: Uses one OTLP export path with bounded transport retries and flush. Normal tracing never waits for Langfuse's observation index.
- **Operator Commands**: Inspect status, test connectivity with an isolated trace, and change capture policy without interrupting an active run.

## Quick Start

### Install

```bash
pi install git:github.com/edxeth/pi-langfuse
```

Requires Pi 0.87.1 or newer and Node.js 22+. Git installs run from TypeScript sources through Pi's extension loader, so no build step is required. Registry installs ship the compiled `dist/` build and behave identically at runtime. The `pi-langfuse-export` CLI is compiled at publish time; when working from a Git checkout, build it with a development install (`npm install && npm run build`).

### Local self-hosted (recommended)

```text
/langfuse-init --yes --local
```

This creates a private Docker Compose stack with generated secrets. Defaults:

```text
URL:      http://localhost:3100/auth/sign-in
Email:    local@example.test
Name:     Local User
Password: unique per install; generated and shown once by /langfuse-init
```

The generated login password is displayed only in the init output. Store it when you run the command, or pass `--password` yourself.

Files are written to `$PI_CODING_AGENT_DIR/langfuse/`. Init refuses to run in a non-empty directory.

After init, `pi` starts tracing on sessionful prompts. If local Langfuse is not healthy, the extension runs `docker compose up -d` automatically. Unpersisted/no-session runs are skipped by default.

Disable autostart for one process:

```bash
PI_LANGFUSE_AUTOSTART=0 pi
```

### Langfuse Cloud or existing instance

```text
/langfuse-init --yes --remote \
  --host https://cloud.langfuse.com \
  --public-key pk-lf-... \
  --secret-key sk-lf-...
```

Remote mode creates only `$PI_CODING_AGENT_DIR/langfuse/pi-langfuse.json`. No Docker files, no autostart.

You can also configure keys manually via env vars or settings. Configuration precedence:

1. `/extensions:settings` if the optional settings extension is installed
2. `pi-langfuse.json` (default `$PI_CODING_AGENT_DIR/langfuse/pi-langfuse.json`; override the path with `PI_LANGFUSE_CONFIG`)
3. `LANGFUSE_*` and `PI_LANGFUSE_*` environment variables
4. Built-in defaults

The extension does not load an extension-local `config.json`. Use `pi-langfuse.json`, the settings panel, or environment variables.

The extension reads `pi-langfuse.json` and the environment when a session starts and when each prompt starts, not on every event. An edit to the file applies from the next prompt. A change in the settings panel, `/langfuse:toggle`, or `/langfuse-privacy` applies at once.

## Configuration

| Setting | Env Var | Default | Description |
| :--- | :--- | :--- | :--- |
| **Config File** | `PI_LANGFUSE_CONFIG` | `$PI_CODING_AGENT_DIR/langfuse/pi-langfuse.json` | Path of the `pi-langfuse.json` file the extension loads. |
| **Enabled** | - | `true` | Global toggle for tracing. |
| **Public Key** | `LANGFUSE_PUBLIC_KEY` | - | Langfuse project public key. |
| **Secret Key** | `LANGFUSE_SECRET_KEY` | - | Langfuse project secret key. |
| **Base URL** | `LANGFUSE_BASE_URL` / `LANGFUSE_HOST` | `https://cloud.langfuse.com` | API host. Use `http://127.0.0.1:3100` for the local stack: it listens on IPv4 only, and `localhost` often resolves to IPv6 first, which adds about 250 ms to every new connection. |
| **User ID** | `PI_LANGFUSE_USER_ID` | `$USER` | Associate traces with a specific user. |
| **Environment** | `PI_LANGFUSE_ENV` | - | Tag traces, e.g. `local`, `staging`, `production`. |
| **Release** | `PI_LANGFUSE_RELEASE` | - | Tag traces with a version or release ID. |
| **Local Autostart** | `PI_LANGFUSE_AUTOSTART` | `config dependent` | `0` disables Docker autostart, `1` forces it. |
| **Local Autostart Dir** | `PI_LANGFUSE_AUTOSTART_DIR` | `$PI_CODING_AGENT_DIR/langfuse` | Directory containing `docker-compose.yml`. |
| **Local Autostart Health Timeout** | `PI_LANGFUSE_AUTOSTART_TIMEOUT_MS` | `2000` | Config key `localAutostartTimeoutMs` (50 to 5000). How long the health check waits before autostart treats the stack as down. |
| **Capture Provider Payload** | `PI_LANGFUSE_CAPTURE_PROVIDER_PAYLOAD` | `false` | Optional provider payload capture inside Langfuse metadata. |
| **Secret Redaction** | `PI_LANGFUSE_REDACTION` / `PI_LANGFUSE_UNREDACTED=1` | `true` | Redact known secrets and common token/PII-shaped patterns before Langfuse/raw-trace writes. Settings/config values take precedence over env opt-outs. |
| **Additional Redaction Secrets** | `PI_LANGFUSE_REDACTION_SECRETS` | - | Comma-separated literal secrets to redact in addition to env/config secrets. |
| **Identity Mode** | `PI_LANGFUSE_IDENTITY` | `raw` | `raw` keeps usernames, home paths, and repository names as captured. `pseudonymous` hashes the user ID and repository identity with a private salt and rewrites the home directory to `~`. This is pseudonymization, not anonymization. See [Identity pseudonymization](#identity-pseudonymization). |
| **Keep Repository Identity** | `PI_LANGFUSE_IDENTITY_KEEP_REPO` | `false` | Config key `identityKeepRepo`. Only `true` keeps repository owner, name, remote path, root name, and project tags readable in `pseudonymous` mode. |
| **Raw Trace Export** | `PI_LANGFUSE_RAW_TRACE` | `false` | Redacted JSONL companion stream for training/distillation data. |
| **Raw Trace Directory** | `PI_LANGFUSE_RAW_TRACE_DIR` | `$PI_CODING_AGENT_DIR/langfuse/raw-traces` | Root directory for raw trace companion files. |
| **Raw Provider Request Mode** | `PI_LANGFUSE_RAW_PROVIDER_REQUEST` | `summary` | Controls `provider_request` raw records: `summary` stores bounded request shape, `full` stores the exact redacted request contents (required for `--format` training records), `off` skips the record. |
| **Capture Policy** | `PI_LANGFUSE_CAPTURE_POLICY` | `full-debug` | Select `metadata-only`, `prompts-only`, `conversations`, or `full-debug`. |
| **Capture Overrides** | `PI_LANGFUSE_CAPTURE_*` | `inherit` | Set field overrides to `on` or `off` for prompt, system prompt, provider input, assistant output, tool input, tool output, or metadata. |
| **Payload Budgets** | `PI_LANGFUSE_PAYLOAD_MAX_*` | `unlimited` | Bound strings, tool strings, depth, array items, object keys, or total nodes. Use `unlimited` for an explicit unlimited value. |

## Commands

Seven slash commands drive setup, runtime control, diagnostics, feedback, and exports. Run them inside the Pi TUI.

| Command | Description |
| :--- | :--- |
| `/langfuse-init` | Initialize local self-hosted or remote Langfuse. |
| `/langfuse:toggle` | Enable or disable tracing. |
| `/langfuse-status` | Print safe configuration and runtime status. |
| `/langfuse-test` | Check connectivity and send an isolated test trace. |
| `/langfuse-score` | Rate this session's last finalized trace as good or bad. |
| `/langfuse-privacy` | Show or persist the capture policy. |
| `/langfuse:export` | Create a local redacted export of sessions and raw traces. |

### /langfuse-init

Configures Langfuse for Pi without overwriting existing files. Local mode creates a self-hosted Docker Compose stack with generated secrets. Remote mode points Pi at Langfuse Cloud or an existing instance.

```text
/langfuse-init --yes --local
/langfuse-init --yes --local --no-start
/langfuse-init --yes --remote \
  --host https://cloud.langfuse.com \
  --public-key pk-lf-... \
  --secret-key sk-lf-...
/langfuse-init --dir ~/.pi/agent/langfuse
```

Flags:

| Flag | Effect |
| :--- | :--- |
| `--mode local\|remote` | Setup type. `--local`, `--remote`, and `--cloud` select the same modes. |
| `--dir <path>` | Target directory. Default `$PI_CODING_AGENT_DIR/langfuse`. |
| `--host <url>` | Langfuse API host. Local mode requires an `http://` URL on `localhost` or `127.0.0.1` (IPv4 loopback; `[::1]` is refused because the stack publishes `127.0.0.1` only); the published web port comes from the URL (default `3100`). Remote mode accepts any Langfuse URL. |
| `--email`, `--name`, `--password` | Local Langfuse login. A unique password is generated when `--password` is omitted. |
| `--public-key`, `--secret-key` | Remote project keys. Also read from `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`. |
| `--yes`, `-y` | Skip interactive prompts. |
| `--no-start` | Write files without running Docker Compose. |

Local mode writes `docker-compose.yml`, `.env`, and `pi-langfuse.json`. Remote mode writes only `pi-langfuse.json`. Init refuses a non-empty directory.

With `--dir <path>`, files land outside the default search path. Set `PI_LANGFUSE_CONFIG=<path>/pi-langfuse.json` before starting `pi` so the extension discovers the configuration; local mode also pins `localAutostartDir` in the generated file.

### /langfuse:toggle

```text
/langfuse:toggle [on|off]
```

With no argument, flips the current tracing state. `on` forces tracing on, `off` forces it off. The change persists to settings, refreshes the active config, updates the status line, and notifies with the resolved host or `disabled`.

### /langfuse-status

```text
/langfuse-status
```

Prints safe runtime and config status: the ON/OFF label, resolved config source (`settings panel`, `pi-langfuse.json`, `environment`, or `defaults`), host, masked public key, capture policy, active-run state, config path, runtime mode (`disabled`, `v5-otel`, or `unconfigured`), the last runtime error, and the path of the diagnostics log. The public key is masked; the secret key is never printed.

Every diagnostic the extension raises is appended, sanitized, to `$PI_CODING_AGENT_DIR/langfuse/diagnostics.jsonl` (owner-only, capped at 1 MB with one previous file kept as `diagnostics.jsonl.1`). Pi shows each distinct cause at most once every 15 minutes; repeats only reach the log.

### /langfuse-test

```text
/langfuse-test
```

Requires configured keys. The command makes an authenticated request to `<host>/api/public/projects` and then sends an isolated test trace under a bounded timeout. It reports pass or fail without flushing or closing an active session runtime. Errors are redacted before they reach the notification.

### /langfuse-score

```text
/langfuse-score <good|bad> [comment]
```

Writes a `user_feedback` BOOLEAN score (`good` = 1, `bad` = 0) on the last trace this session finalized. Any other first word prints usage and writes nothing.

- **Target.** Only the invoking session's last finalized trace qualifies. A prompt that is still running is never scored; while one runs, the command targets the previous finalized trace. The command rejects the request when the session has not finalized a trace.
- **Destination.** The trace keeps the Langfuse host and public key it was created for. After a configuration change that points elsewhere, the command rejects the request instead of writing to another project. It accepts the request again once the original destination is configured.
- **Comment.** The comment is optional. A comment over 4000 characters is rejected with its length (never echoed) and nothing is saved. Otherwise the original text is redacted first (always, whatever the redaction setting, with the full configuration), then flattened to one line and cut to 500 characters. Redacting first keeps secrets that contain whitespace or span lines matchable, and a cut never leaves a secret fragment.
- **Delivery.** Success means the scores endpoint accepted the score. A rejected or failed delivery shows an error notification and a runtime diagnostic; the command never reports enqueueing as success. Repeating the command adds another score.

### /langfuse-privacy

```text
/langfuse-privacy [policy]
```

With no argument or `show`, prints the capture policy, the identity mode, per-field capture overrides, and payload budgets. With one of `metadata-only`, `prompts-only`, `conversations`, or `full-debug`, it persists the policy to settings and refreshes the active config. Any other input prints usage.

### /langfuse:export

```text
/langfuse:export [--out <dir>] [--sessions-dir <dir>] [--raw-dir <dir>]
                 [--sessions-only] [--raw-only] [--no-trufflehog] [--require-trufflehog]
                 [--format openai-chat|anthropic-messages|sharegpt]
                 [--license <text>] [--consent unknown|granted|denied]
```

Creates a local redacted copy of Pi sessions and raw traces. The command blocks the TUI during processing. Redaction is always on for exports, and original files are never modified. For the full pipeline, output files, and the recommended standalone CLI for bulk runs, see [Export pipeline](#export-pipeline).

## Data flow

Every Pi event fans out to three destinations. Redaction happens at the `pi-langfuse` boundary -- Pi's own session file is never modified.

```text
                              YOU TYPE A PROMPT
                               pi "..."
                                      |
                   +------------------+------------------+
                   |                                     |
                   v                                     v
    +---------------------------+         +---------------------------+
    |   Pi session JSONL        |         |   pi-langfuse extension    |
    |   (Pi core writes this)   |         |                           |
    |                           |         |   sanitize() runs BEFORE  |
    |   Unredacted originals.  |         |   every write boundary    |
    |   pi-langfuse never       |         |                           |
    |   touches these.          |         |   Redacts: secrets, keys, |
    |                           |         |   tokens, PII, credentials|
    |   ~/.pi/agent/            |         |   blobs, assignments.     |
    |     sessions/             |         |                           |
    +---------------------------+         +------+------------+-------+
                                                 |            |
                                     +-----------+            +----------+
                                     v                                   v
                      +-------------------------+           +------------------+
                      |   Raw trace JSONL       |           |   Langfuse       |
                      |   (if enabled)          |           |   server         |
                      |                         |           |                  |
                      |   Append-only companion |           |   Local:         |
                      |   Redacted on write.   |           |   localhost:3100 |
                      |                         |           |   Cloud:         |
                      |   langfuse/raw-traces/  |           |   cloud.langfuse |
                      +-------------------------+           |                  |
                                                          |   Redacted on   |
                                                          |   send.         |
                                                          +------------------+
```

```text
Layer                    Redacted?   By whom?            When?
-----------------------  ----------  -----------------  ---------------
Pi session JSONL         NO          Pi core             On write
                         (originals) (untouchable)

Raw trace JSONL          YES         pi-langfuse         Before append
                         (companion) (sanitize->write)

Langfuse traces          YES         pi-langfuse         Before SDK send
                         (server)    (sanitize->send)

Export derivatives       YES         export pipeline     On copy
                         (output/)   (always-on)
```

### Trace hierarchy

```text
Trace (name: "pi-agent")
└── Span (name: "agent.prompt")
    └── Span (name: "agent.turn")
        ├── Generation (name: "llm-response")  <-- Cost/Token tracking
        └── Span (name: "tool:<name>")          <-- Arguments/Results
```

### Prompt scores

Each prompt finalizes its scores once, when Pi reports the run settled (`agent_settled`), including runs that no `before_agent_start` announced. Scores describe observed events. They are not task success, proof that files changed, human participation, or user acceptance. Use `/langfuse-score` for an explicit judgment.

| Score | Type | Meaning |
| :--- | :--- | :--- |
| `tool_call_count`, `turn_count`, `total_tool_errors`, `tool_success_rate`, `session_had_errors` | numeric / boolean | Existing operational health signals. A run that Pi reports as aborted, or that ended on a failed assistant message, counts as incomplete. A failure that a later run of the same prompt recovered from does not. |
| `last_tool_is_error` | boolean | `isError` of the last tool result in the prompt, in Pi's finalized transcript order (the last turn that returned tool results), not the order in which parallel tools finished. Omitted when the prompt has no tool result. |
| `edit_write_call_count` | numeric | Distinct `edit` and `write` tool calls attempted, counted once per tool call id. Failed and blocked attempts count; the count does not show that any file changed. |
| `ask_user_wait_ms` | numeric | Time that [pi-ask](https://github.com/FasalZein/pi-ask) dialogs were open, as the union of the intervals between each flow's `pi-ask:started` and `pi-ask:completed` events (overlapping flows count once). Omitted unless every observed flow was measured. |

`ask_user_wait_ms` reads the pi-ask lifecycle events and keeps only flow id, tool call id, source, timestamps, and the cancellation flag and reason, never questions or answers. Setup and the rest of the `ask_user` tool span are not part of it, and a cancelled dialog still counts as open time. A dialog that a bridge answered through `pi-ask:submit` is still a dialog flow, so the value is not proof that a person was present. Total prompt latency (`durationMs`) is unchanged.

Flows are matched to a prompt by tool call id. A flow without one (such as `/answer`) belongs to no prompt. When the same tool call id is active in more than one session, the flow is attributed to none of them. The prompt metadata `askUserWait` (also `askUserWaitStatus` and `askUserWaitMs` on the trace) reports the outcome, and the `tool:<name>` span metadata `askUserWait` lists the flows of that tool:

- Absent: no pi-ask flow was observed. This is missing instrumentation, not a measured zero.
- `measured`: every flow has a start and an end; `waitMs` can be 0.
- `incomplete`: a flow lacks its start or end event, has no valid timestamp for one of them (absent or non-finite; receipt time is never substituted), or ends before it starts. No score is written.
- `ambiguous`: an event matched several sessions. No score is written.

Native Pi `ui_prompt_start` and `ui_prompt_end` events are not used: they carry no tool call id, and using both sources would double-count.

## Raw traces

Langfuse is optimized for observability, not training archives. UI fields can be truncated and traces may be restructured. Raw traces are the append-only JSONL companion for fine-tuning, distillation, and audit.

Enable in config:

```json
{
  "rawTraceEnabled": true,
  "rawTraceProviderRequestMode": "summary"
}
```

Omit `rawTraceDir` to use the default `<agent-dir>/langfuse/raw-traces`, where `<agent-dir>` is the Pi agent directory (`$PI_CODING_AGENT_DIR`). Configuration values are not variable-expanded: a literal `$PI_CODING_AGENT_DIR` inside the JSON would create a directory with that literal name under the current project. To override the directory, set `PI_LANGFUSE_RAW_TRACE_DIR` or write a real absolute path.

Raw traces mirror Pi's session layout under `raw-traces/`:

```text
Pi session:   <agent-dir>/sessions/--project--/<session>.jsonl
Raw trace:    <agent-dir>/langfuse/raw-traces/--project--/<session>.jsonl
Fallback:     <agent-dir>/langfuse/raw-traces/--unknown--/<session>.jsonl
```

Record types: `session_start`, `agent_prompt_start`, `provider_request`, `tool_call`, `tool_result_first_seen`, `tool_execution_end`, `assistant_output`, `session_compact`, `session_end`.

The key record is `tool_result_first_seen`: it captures a redacted summary of tool output before later extensions can compress or rewrite it. Configured capture policies and payload budgets shape new records. Raw traces continue writing even if Langfuse tracing is disabled or the server is unavailable. Raw trace writes are queued from event handlers and drained synchronously on session shutdown so no data is lost on clean exit. Very large records still require redaction, JSON serialization, and disk I/O, so use full provider-request capture only for controlled debug or data-capture runs.

`provider_request` records store bounded summaries by default: model, request source, item count, estimated bytes, and redacted message summaries. Recognized request shapes include Chat Completions `messages`, Responses `input` (with a top-level `instructions` string recorded as the system prompt field), Google `contents` (with `config.systemInstruction` recorded as the system prompt field), and pi-protocol `context.messages`. Set `rawTraceProviderRequestMode` or `PI_LANGFUSE_RAW_PROVIDER_REQUEST=full` to capture the exact full redacted request contents sent to the LLM. Set it to `off` to skip `provider_request` records entirely. `PI_LANGFUSE_RAW_PROVIDER_REQUEST` is a per-process override, so `PI_LANGFUSE_RAW_PROVIDER_REQUEST=full pi` can run one controlled exact-capture session without permanently changing the config file. `session_end` marks a clean session shutdown.

#### Session lifecycle

| Action | Raw trace behavior |
| :--- | :--- |
| Normal session | Writes one companion JSONL file with the same project directory and filename. |
| Display rename | No change; the session filename does not change. |
| Fork or clone | Starts a new raw trace file; parent evidence stays with the parent session. |
| Delete Pi session | Raw trace remains as training/audit evidence. |
| Manual filesystem move | Move the matching raw trace file yourself to keep paths mirrored. |

For a deep dive, see [docs/architecture.md](./docs/architecture.md).

## Export pipeline

Use `/langfuse:export` inside Pi for small exports, or the standalone `pi-langfuse-export` CLI for bulk exports. Originals are never modified.

```text
+-----------+    +-----------+    +------------+    +----------+
| DISCOVER  |--->|  COPY &   |--->|    SCAN    |--->|   GATE   |
|           |    |  REDACT   |    |            |    |          |
| Walk      |    |           |    | Built-in   |    | approved |
| sessions/ |    | JSON      |    | residual   |    | if 0     |
| raw-      |    | parse     |    | checks +   |    | findings |
| traces/   |    | per line  |    | TruffleHog |    |          |
+-----------+    +-----------+    +------------+    +-----+----+
                                                          |
                                                          v
+--------------------------------------------------------------+
|  ~/export/                                                    |
|                                                               |
|  sessions/           redacted Pi session copies              |
|  raw-traces/         redacted raw trace copies               |
|  manifest.jsonl      one record per exported file             |
|  approved.jsonl      approved file records                    |
|  rejected.jsonl      rejected file records                    |
|  training-index.jsonl approved redacted derivatives           |
|  report.json         scanner findings + approved/rejected     |
|  REVIEW.md           human review summary                     |
|                                                               |
|  Nothing uploaded. Nothing sent. Purely local.                |
+--------------------------------------------------------------+
```

### Inside Pi

```text
/langfuse:export
```

Synchronous -- convenient for small exports, but blocks the TUI during processing.

### Standalone CLI (recommended for bulk)

```bash
pi-langfuse-export \
  --sessions-dir ~/.pi/agent/sessions \
  --raw-dir ~/.pi/agent/langfuse/raw-traces \
  --out ~/export \
  --require-trufflehog
```

Streams progress to stderr, prints JSON summary to stdout. Speed depends on JSONL size, disk, and TruffleHog scan time. Large archives can take minutes.

Flags:

```text
--sessions-only           export sessions only
--raw-only                export raw traces only
--require-trufflehog      reject export if TruffleHog is unavailable
--no-trufflehog           skip external scan (local debug only)
--format <name>           also write training-index.<name>.jsonl review records
                          (requires the TruffleHog scan; refuses --no-trufflehog)
--license <text>          operator-declared license for review records
--consent <value>         operator-declared consent: unknown (default), granted, denied
```

### Export invariants

- Redaction is always on. `PI_LANGFUSE_UNREDACTED` and `redactionEnabled` only affect live telemetry, not exports.
- Absolute source paths are replaced with `[PATH_ROOT]`.
- Original files are never modified (read-only copy).
- TruffleHog runs detection-only (`--no-verification --no-update`): no candidate credential is sent to a vendor to check whether it is valid.

### Training review records (`--format`)

`--format openai-chat`, `anthropic-messages`, or `sharegpt` additionally writes `training-index.<format>.jsonl` next to the usual artifacts. These are **local review records, not certified provider-upload-ready datasets**. Nothing is uploaded, and no per-record permission system exists.

One record is one normally completed assistant generation: the full provider context observed in a raw `provider_request`, with the answer of the `assistant_output` that followed it appended. Tool calls and results earlier in that context stay in it. Records come only from raw traces that passed the built-in scan, and the generated records are scanned again. `--format` makes the external scan mandatory, as if `--require-trufflehog` were given: records are kept only if TruffleHog was available, exited with status 0 (a signal-killed or otherwise incomplete run counts as failure even with empty output), and reported no findings. Otherwise the export is `rejected` and the review file is empty. `--format` with `--no-trufflehog` is refused before anything is written. A passing scan is not permission to train. `--format` also cannot be combined with `--sessions-only`: Pi session files are not converted.

A value-taking option (`--out`, `--sessions-dir`, `--raw-dir`, `--format`, `--license`, `--consent`) followed directly by another recognized option is refused as missing its value and never swallows that option, so `--license --consent denied` cannot hide a denial. An explicit empty argument (`--license ""`) is a valid empty license.

A sample is accepted only if all of these hold, otherwise it is rejected with a reason code and counted in `report.json`, `REVIEW.md`, and the CLI output (`training.rejectionReasons`):

- The answer ended with `stopReason: "stop"`, has text, and has no tool calls. `aborted`, `error`, `length`, and tool-call endings are rejected, as are history turns that ended that way.
- The request is a `full` capture of a supported shape: Pi-native `context.messages`, Responses `input` (items or a string, plus top-level `instructions`), or Chat Completions / Anthropic `messages`. Google `contents`, images and other non-text blocks, custom tool calls, unknown roles, and mid-conversation system messages are rejected. The default `summary` mode, legacy records, and raw records without capture provenance cannot be converted.
- Capture was complete. Each `provider_request` and `assistant_output` raw record carries `captureProvenance`, measured where the record is shaped: a content field is listed under `verified` only if its emitted value equals the same field shaped with every capture field forced on and every payload limit lifted. Fields that the capture policy or a payload budget cut appear under `degraded` as `policy-omitted` or `budget-truncated`, and records with any such required field are rejected. Redaction, identity normalization, and the always-removed opaque reasoning payloads are not counted as degradation.
- No history item states an incomplete status. Responses messages, function calls, function outputs, and reasoning items may carry `status`; any explicit value other than `completed` (`in_progress`, `incomplete`, or anything else) rejects the sample. An absent or null status is accepted because the input schema allows it.
- The request is self-contained. If the provider payload referenced stored context (`previous_response_id` or `conversation`), the raw record carries `serverSideContext` (the field names only, never the ids) and the sample is rejected (`request-server-side-context`): the captured items are not the context the model saw. Nothing is looked up or reconstructed. The marker is written by the provider hook from the payload it observes, before any later adapter reduces a continuation request; it makes no claim about what a given adapter sends afterwards. Records written before this marker existed cannot show it.
- Tool calls and results pair exactly: unique non-empty ids, every call answered once by a matching result before the next turn, no orphan or duplicate results, parseable object arguments.
- The pairing of request and answer is unambiguous. Within one prompt (raw `agent_prompt_start` records split prompts, and `turnIndex` restarts for each), a request pairs only with the next request-or-answer record when it answers the same turn. A turn index that occurs on more than one request or answer in a prompt, such as a provider retry, rejects all records involved (`ambiguous-turn`) instead of guessing the order.

Format notes:

| Format | Shape | Not carried |
| --- | --- | --- |
| `openai-chat` | `{messages}`; assistant `tool_calls[].function.arguments` is a JSON string; tool messages use `tool_call_id` | tool definitions, reasoning, the tool error flag (listed in `omitted` when present) |
| `anthropic-messages` | `{system, messages}`; `tool_use.input` is an object; `tool_result` blocks sit in the user message right after their `tool_use`, `is_error` is kept | tool definitions, reasoning |
| `sharegpt` | `{system?, conversations}` with `human`/`gpt` turns only; the system prompt is a top-level `system` string, a private convention because ShareGPT has no system role or tool schema | everything with tool calls or results is rejected, never flattened to prose |

Tool arguments are normalized through JSON parse and stringify, so whitespace can differ from the source. Multiple text blocks join with a newline. Reasoning text and encrypted or signed reasoning state are never copied into answer text; each record lists what was left out in `omitted`.

Privacy for `--format` is fixed regardless of live capture settings: redaction on, identity pseudonymous with repository identity hashed. The identity salt must exist before anything is written, and it is created in the `PI_LANGFUSE_CONFIG` file if missing; an unreadable, malformed, or unwritable config stops the export. Derivative file and directory names, manifests, and index references are pseudonymized too (the encoded home directory becomes `~`); source files are never renamed. Pseudonymous is not anonymous: code, commits, relative paths, and business content can still identify people or repositories.

`--license <text>` / `exportLicense` (default empty) and `--consent unknown|granted|denied` / `exportConsent` (default `unknown`) are operator declarations that are copied into every record. They are never inferred from a scan, a license, or an approval, and nothing verifies them. A missing license or unknown consent produces a warning. `denied` refuses the export. Environment variables `PI_LANGFUSE_EXPORT_LICENSE` and `PI_LANGFUSE_EXPORT_CONSENT` set the same values. The config file value outranks the environment. A config declaration of the wrong JSON type (an array, object, number, boolean, or `null`) is never coerced: a `--format` export refuses with `invalid-export-option` naming the key, unless a flag replaces that declaration. Defaults (empty license, `unknown` consent) apply only to missing or blank values. Live telemetry and exports without `--format` ignore these keys.

Both are review records only. Neither the declarations nor a clean scan grant training rights.

## Privacy

### Local setup

- Langfuse web/API binds to `127.0.0.1:3100`. Postgres, Redis, ClickHouse, and MinIO bind to localhost-only ports.
- Langfuse telemetry is disabled in the generated `.env` and Compose file.
- Cloud is not used unless you explicitly configure a cloud host/key pair.

This does not change where your LLM provider sends prompts.

### Redaction

Redaction is enabled by default. Every raw trace record includes `{ "redaction": { "applied": true } }`. Disable only for local debugging:

```bash
PI_LANGFUSE_UNREDACTED=1 pi
```

The sanitizer covers: configured secret keys, secret-like env values, `PI_LANGFUSE_REDACTION_SECRETS` literals, sensitive object fields, private-key blocks, bearer tokens, GitHub/HuggingFace/OpenAI/Anthropic/AWS/Stripe/SendGrid/Docker/Slack tokens, JWTs, `.env`-style assignments, URL-embedded credentials, email/phone/SSN/credit-card PII, data URLs, and large base64/hex blobs.

Even redacted traces can contain private business data that is not token-shaped. Treat raw traces as private.

### Identity pseudonymization

`identityMode` (`settings` > `pi-langfuse.json` > `PI_LANGFUSE_IDENTITY`) selects `raw` (default, unchanged output) or `pseudonymous`. In `pseudonymous` mode the shared output sanitizer, which feeds Langfuse spans, scores, raw traces, and exports, does the following:

- Hashes `userId` and the `repo_identity`, `repo_owner`, `repo_name`, `git_remote_path`, and `repo_root_name` metadata (including `.pi-langfuse.metadata.json` overrides) and `project:` tags with a salted HMAC, unless `identityKeepRepo` is `true`.
- Rewrites your home directory prefix to `~` in every emitted string at directory boundaries, including nested text, errors, serialized fragments, and the encoded home name inside Pi session folder names (`--home-user-project--` becomes `--~-project--`).
- Never changes the file paths the extension reads internally.

The salt is a random 256-bit value stored as `identitySalt` in the file at `PI_LANGFUSE_CONFIG` (default `<agent-dir>/langfuse/pi-langfuse.json`). It is created once, only when `pseudonymous` mode first needs it, with owner-only permissions, an atomic rename, and a lock for concurrent first use. Existing keys are kept. `raw` mode never creates or rewrites the file. A malformed or non-object config file, an invalid `identitySalt`, or a salt that cannot be written is never overwritten or regenerated: telemetry, raw traces, and exports stay off until you fix it (`/langfuse-privacy` shows the reason). A config file that exists but cannot be read leaves the identity mode unknown, so it also stops telemetry unless the settings panel sets the mode. Keep the salt private: sharing it lets others test guesses against the hashes. Deleting it changes every pseudonym. Salt creation takes a `<config path>.lock` file; a process that finds it waits five seconds and then fails closed. pi-langfuse never removes that lock automatically, so after a killed Pi process, verify that nothing is running and delete the lock yourself. `/langfuse-init` does not merge with an existing `pi-langfuse.json` (including a salt-only one), so initialize the stack before you enable pseudonymous capture.

Identity protection does not depend on the secret redaction setting. The OpenTelemetry resource always reports `service.name=pi-langfuse` and `service.version` from this package, in both modes, so the Node binary path no longer leaks.

This is pseudonymization, not anonymization. Directory and file names below your home directory, branch names, commit hashes, prompts, code, tool output, and other content can still identify you or a repository. Raw trace files on disk keep their local names, and artifact names are masked only for `--format` exports. See [docs/privacy.md](./docs/privacy.md) for the full scope.

### Old data

Redaction is forward-going. It does not rewrite old data.

| Existing data | After installing | Assume |
| :--- | :--- | :--- |
| Old Pi sessions | Unchanged | Contaminated originals. Use `/langfuse:export` for redacted copies. |
| Old raw traces | Unchanged | Reprocess before sharing, then archive or delete originals. |
| Old Langfuse traces | Unchanged | If secrets were sent, delete affected traces and rotate credentials. |

### Training workflow

Do not train from raw originals. Train from redacted derivative exports.

```text
Pi sessions + raw traces
  -> /langfuse:export
  -> redacted derivatives
  -> scan/review/filter
  -> normalize into training examples
  -> train/fine-tune/distill
```

### Known limitations

- **Canonical session rewrite**: Not done. Pi core owns session persistence. Use export for redacted copies.
- **Binary/media payloads**: Redacted as strings when seen in telemetry. No OCR or forensic inspection.
- **Unknown secret formats**: Covered by configured literals, broad patterns, and export scanner. No scanner catches everything -- add literals via `PI_LANGFUSE_REDACTION_SECRETS`.
- **Semantic confidentiality**: PII patterns catch tokens and identifiers. Business-sensitive content needs human review before sharing.

## Troubleshooting

- **No traces?** Check `http://localhost:3100/api/public/health`, API keys, and Pi console warnings.
- **Docker did not start?** Run `docker compose up -d` inside the local Langfuse directory.
- **Wrong login?** Check the generated `.env` for `LANGFUSE_INIT_USER_EMAIL` and `LANGFUSE_INIT_USER_PASSWORD`.
- **Incomplete traces?** Ensure your Pi version supports `message_*`, tool, and session lifecycle events.
- **Cost is zero?** Token usage can be captured even when model pricing is not configured.
- **Large payloads in Langfuse UI?** Select a smaller capture policy or set the payload budgets in config/settings.
- **No raw trace file?** Check `rawTraceEnabled`, `rawTraceDir`, and that the run uses a persisted session rather than `--no-session`.
- **Need a safe diagnostic?** Run `/langfuse-status` and `/langfuse-test` before changing the active runtime.

For detailed setup, privacy, troubleshooting, and migration guidance, see [docs/](./docs/).

## Acknowledgments

Heavily refactored fork of [hdkiller/pi-langfuse](https://github.com/hdkiller/pi-langfuse).

## License

MIT
