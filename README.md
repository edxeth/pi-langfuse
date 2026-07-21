# pi-langfuse

Full-stack Langfuse observability for [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent). The extension records live traces and redacted training exports.

Every prompt, turn, tool call, and streaming response is traced with cost and token metadata. Secrets and PII are redacted at the extension boundary before anything leaves your machine. An optional append-only JSONL companion stream gives you training-ready, audit-safe data without touching Pi's original session files.

## Node.js 22+ release

Version 2.0.0 requires Node.js 22 or newer. The package keeps `dist/index.js` as its Pi extension entrypoint. Existing trace names, raw-trace records, local Server v3 files, credentials, and volumes remain compatible.

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
- **Langfuse v5 and OpenTelemetry**: Uses a typed runtime facade with bounded flush and REST fallback when a completed trace is not visible.
- **Operator Commands**: Inspect status, test connectivity with an isolated trace, and change capture policy without interrupting an active run.

## Quick Start

### Install

```bash
pi install git:github.com/edxeth/pi-langfuse
```

### Local self-hosted (recommended)

```text
/langfuse-init --yes --local
```

This creates a private Docker Compose stack with generated secrets. Defaults:

```text
URL:      http://localhost:3100/auth/sign-in
Email:    local@example.test
Name:     Local User
Password: local-langfuse
```

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
2. `$PI_CODING_AGENT_DIR/langfuse/pi-langfuse.json`
3. `LANGFUSE_*` and `PI_LANGFUSE_*` environment variables
4. Built-in defaults

The extension does not load an extension-local `config.json`. Use `pi-langfuse.json`, the settings panel, or environment variables.

## Configuration

| Setting | Env Var | Default | Description |
| :--- | :--- | :--- | :--- |
| **Enabled** | - | `true` | Global toggle for tracing. |
| **Public Key** | `LANGFUSE_PUBLIC_KEY` | - | Langfuse project public key. |
| **Secret Key** | `LANGFUSE_SECRET_KEY` | - | Langfuse project secret key. |
| **Base URL** | `LANGFUSE_BASE_URL` / `LANGFUSE_HOST` | `https://cloud.langfuse.com` | API host. Use `http://localhost:3100` for local. |
| **User ID** | `PI_LANGFUSE_USER_ID` | `$USER` | Associate traces with a specific user. |
| **Environment** | `PI_LANGFUSE_ENV` | - | Tag traces, e.g. `local`, `staging`, `production`. |
| **Release** | `PI_LANGFUSE_RELEASE` | - | Tag traces with a version or release ID. |
| **Local Autostart** | `PI_LANGFUSE_AUTOSTART` | `config dependent` | `0` disables Docker autostart, `1` forces it. |
| **Local Autostart Dir** | `PI_LANGFUSE_AUTOSTART_DIR` | `$PI_CODING_AGENT_DIR/langfuse` | Directory containing `docker-compose.yml`. |
| **Capture Provider Payload** | `PI_LANGFUSE_CAPTURE_PROVIDER_PAYLOAD` | `false` | Optional provider payload capture inside Langfuse metadata. |
| **Secret Redaction** | `PI_LANGFUSE_REDACTION` / `PI_LANGFUSE_UNREDACTED=1` | `true` | Redact known secrets and common token/PII-shaped patterns before Langfuse/raw-trace writes. Settings/config values take precedence over env opt-outs. |
| **Additional Redaction Secrets** | `PI_LANGFUSE_REDACTION_SECRETS` | - | Comma-separated literal secrets to redact in addition to env/config secrets. |
| **Raw Trace Export** | `PI_LANGFUSE_RAW_TRACE` | `false` | Redacted JSONL companion stream for training/distillation data. |
| **Raw Trace Directory** | `PI_LANGFUSE_RAW_TRACE_DIR` | `$PI_CODING_AGENT_DIR/langfuse/raw-traces` | Root directory for raw trace companion files. |
| **Raw Provider Request Mode** | `PI_LANGFUSE_RAW_PROVIDER_REQUEST` | `summary` | Controls `provider_request` raw records: `summary` stores bounded request shape, `full` stores the exact redacted message array, `off` skips the record. |
| **Capture Policy** | `PI_LANGFUSE_CAPTURE_POLICY` | `full-debug` | Select `metadata-only`, `prompts-only`, `conversations`, or `full-debug`. |
| **Capture Overrides** | `PI_LANGFUSE_CAPTURE_*` | `inherit` | Set field overrides to `on` or `off` for prompt, system prompt, provider input, assistant output, tool input, tool output, or metadata. |
| **Payload Budgets** | `PI_LANGFUSE_PAYLOAD_MAX_*` | `unlimited` | Bound strings, tool strings, depth, array items, object keys, or total nodes. Use `unlimited` for an explicit unlimited value. |

## Commands

Six slash commands drive setup, runtime control, diagnostics, and exports. Run them inside the Pi TUI.

| Command | Description |
| :--- | :--- |
| `/langfuse-init` | Initialize local self-hosted or remote Langfuse. |
| `/langfuse:toggle` | Enable or disable tracing. |
| `/langfuse-status` | Print safe configuration and runtime status. |
| `/langfuse-test` | Check connectivity and send an isolated test trace. |
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
| `--host <url>` | Langfuse API host. Defaults to `http://localhost:3100` (local) or `https://cloud.langfuse.com` (remote). |
| `--email`, `--name`, `--password` | Local Langfuse login. |
| `--public-key`, `--secret-key` | Remote project keys. Also read from `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`. |
| `--yes`, `-y` | Skip interactive prompts. |
| `--no-start` | Write files without running Docker Compose. |

Local mode writes `docker-compose.yml`, `.env`, and `pi-langfuse.json`. Remote mode writes only `pi-langfuse.json`. Init refuses a non-empty directory.

### /langfuse:toggle

```text
/langfuse:toggle [on|off]
```

With no argument, flips the current tracing state. `on` forces tracing on, `off` forces it off. The change persists to settings, refreshes the active config, updates the status line, and notifies with the resolved host or `disabled`.

### /langfuse-status

```text
/langfuse-status
```

Prints safe runtime and config status: the ON/OFF label, resolved config source (`settings panel`, `pi-langfuse.json`, `environment`, or `defaults`), host, masked public key, capture policy, active-run state, config path, runtime mode (`disabled`, `v5-otel`, or `unconfigured`), and the last runtime error. The public key is masked; the secret key is never printed.

### /langfuse-test

```text
/langfuse-test
```

Requires configured keys. The command makes an authenticated request to `<host>/api/public/projects` and then sends an isolated test trace under a bounded timeout. It reports pass or fail without flushing or closing an active session runtime. Errors are redacted before they reach the notification.

### /langfuse-privacy

```text
/langfuse-privacy [policy]
```

With no argument or `show`, prints the capture policy, per-field capture overrides, and payload budgets. With one of `metadata-only`, `prompts-only`, `conversations`, or `full-debug`, it persists the policy to settings and refreshes the active config. Any other input prints usage.

### /langfuse:export

```text
/langfuse:export [--out <dir>] [--sessions-dir <dir>] [--raw-dir <dir>]
                 [--sessions-only] [--raw-only] [--no-trufflehog] [--require-trufflehog]
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

## Raw traces

Langfuse is optimized for observability, not training archives. UI fields can be truncated and traces may be restructured. Raw traces are the append-only JSONL companion for fine-tuning, distillation, and audit.

Enable in config:

```json
{
  "rawTraceEnabled": true,
  "rawTraceDir": "$PI_CODING_AGENT_DIR/langfuse/raw-traces",
  "rawTraceProviderRequestMode": "summary"
}
```

Raw traces mirror Pi's session layout under `raw-traces/`:

```text
Pi session:   <agent-dir>/sessions/--project--/<session>.jsonl
Raw trace:    <agent-dir>/langfuse/raw-traces/--project--/<session>.jsonl
Fallback:     <agent-dir>/langfuse/raw-traces/--unknown--/<session>.jsonl
```

Record types: `session_start`, `agent_prompt_start`, `provider_request`, `tool_call`, `tool_result_first_seen`, `tool_execution_end`, `assistant_output`, `session_compact`, `session_end`.

The key record is `tool_result_first_seen`: it captures a redacted summary of tool output before later extensions can compress or rewrite it. Configured capture policies and payload budgets shape new records. Raw traces continue writing even if Langfuse tracing is disabled or the server is unavailable. Raw trace writes are queued from event handlers and drained synchronously on session shutdown so no data is lost on clean exit. Very large records still require redaction, JSON serialization, and disk I/O, so use full provider-request capture only for controlled debug or data-capture runs.

`provider_request` records store bounded summaries by default: model, message count, estimated bytes, and redacted message summaries. Set `rawTraceProviderRequestMode` or `PI_LANGFUSE_RAW_PROVIDER_REQUEST=full` to capture the exact full redacted message array sent to the LLM. Set it to `off` to skip `provider_request` records entirely. `PI_LANGFUSE_RAW_PROVIDER_REQUEST` is a per-process override, so `PI_LANGFUSE_RAW_PROVIDER_REQUEST=full pi` can run one controlled exact-capture session without permanently changing the config file. `session_end` marks a clean session shutdown.

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
```

### Export invariants

- Redaction is always on. `PI_LANGFUSE_UNREDACTED` and `redactionEnabled` only affect live telemetry, not exports.
- Absolute source paths are replaced with `[PATH_ROOT]`.
- Original files are never modified (read-only copy).

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
