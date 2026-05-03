# pi-langfuse

Production-grade Langfuse observability for [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent).

![Langfuse Trace Screenshot](./docs/screenshot.jpg)

## Why Langfuse?

Langfuse provides open-source observability for LLM applications. This extension traces Pi sessions locally or against any Langfuse-compatible endpoint so you can understand prompts, turns, tool calls, token usage, and failures.

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

## Quick Start

Run the wizard inside Pi:

```text
/langfuse-init
```

Choose one of:

```text
Local self-hosted
Remote / Langfuse Cloud
```

Local mode creates a private Docker Compose stack. Remote mode writes only connection settings for Langfuse Cloud or an existing Langfuse instance.

## Local Quick Start

This is the recommended private setup. It does **not** require Langfuse Cloud.

### 1. Install the extension

```bash
pi install git:github.com/edxeth/pi-langfuse
```

### 2. Initialize local Langfuse

Inside Pi, run:

```text
/langfuse-init
```

The wizard asks for login details and confirmation before writing files. Defaults are:

```text
URL:      http://localhost:3100/auth/sign-in
Email:    local@example.test
Name:     Local User
Password: local-langfuse
```

Fast path for a local-only setup:

```text
/langfuse-init --yes
# equivalent:
/langfuse-init --yes --local
```

Useful options:

```text
/langfuse-init --yes --no-start
/langfuse-init --dir ~/.pi/agent/langfuse
/langfuse-init --host http://localhost:3100
/langfuse-init --email you@example.test --name "Your Name" --password local-langfuse
```

### 3. What gets created

By default, init writes into the active Pi agent directory:

```text
$PI_CODING_AGENT_DIR/langfuse
```

If `PI_CODING_AGENT_DIR` is unset, standalone Pi falls back to:

```text
~/.pi/agent/langfuse
```

Files created:

```text
docker-compose.yml
.env
pi-langfuse.json
```

Safety rule: `/langfuse-init` refuses to initialize into a non-empty directory. It does not overwrite an existing Langfuse stack.

### 4. Autostart behavior

After init, `pi-langfuse.json` enables tracing and local autostart. From then on:

- `pi` starts tracing on sessionful prompts.
- If local Langfuse is not healthy, the extension runs `docker compose up -d` in the local Langfuse directory.
- If Langfuse is already healthy, it only performs a fast health check.
- Unpersisted/no-session runs are skipped by default.

Disable autostart for one process:

```bash
PI_LANGFUSE_AUTOSTART=0 pi
```

## Langfuse Cloud or Existing Langfuse

Cloud is optional. If you already have a Langfuse Cloud account or another Langfuse instance, choose `Remote / Langfuse Cloud` in the wizard.

Fast path:

```text
/langfuse-init --yes --remote \
  --host https://cloud.langfuse.com \
  --public-key pk-lf-... \
  --secret-key sk-lf-...
```

For a custom self-hosted remote instance, change `--host`:

```text
/langfuse-init --yes --remote \
  --host https://langfuse.example.com \
  --public-key pk-lf-... \
  --secret-key sk-lf-...
```

Remote mode creates only:

```text
$PI_CODING_AGENT_DIR/langfuse/pi-langfuse.json
```

It does not create Docker Compose files and does not enable local Docker autostart.

You can also configure keys manually instead of using `/langfuse-init`.

Configuration precedence:

1. `/extensions:settings` if the optional settings extension is installed
2. `$PI_CODING_AGENT_DIR/langfuse/pi-langfuse.json`
3. `config.json` in this extension
4. `LANGFUSE_*` environment variables

Set:

```text
LANGFUSE_PUBLIC_KEY
LANGFUSE_SECRET_KEY
LANGFUSE_HOST
```

For self-hosted local mode, `LANGFUSE_HOST` is usually:

```text
http://localhost:3100
```

## Configuration

| Setting | Env Var | Default | Description |
| :--- | :--- | :--- | :--- |
| **Enabled** | - | `true` | Global toggle for tracing. |
| **Public Key** | `LANGFUSE_PUBLIC_KEY` | - | Langfuse project public key. |
| **Secret Key** | `LANGFUSE_SECRET_KEY` | - | Langfuse project secret key. |
| **Base URL** | `LANGFUSE_HOST` / `LANGFUSE_BASE_URL` | `https://cloud.langfuse.com` | API host. Use `http://localhost:3100` for local. |
| **User ID** | `PI_LANGFUSE_USER_ID` | `$USER` | Associate traces with a specific user. |
| **Environment** | `PI_LANGFUSE_ENV` | - | Tag traces, e.g. `local`, `staging`, `production`. |
| **Release** | `PI_LANGFUSE_RELEASE` | - | Tag traces with a version or release ID. |
| **Local Autostart** | `PI_LANGFUSE_AUTOSTART` | `config dependent` | `0` disables Docker autostart, `1` forces it. |
| **Local Autostart Dir** | `PI_LANGFUSE_AUTOSTART_DIR` | `$PI_CODING_AGENT_DIR/langfuse` | Directory containing `docker-compose.yml`. |
| **Capture Provider Payload** | `PI_LANGFUSE_CAPTURE_PROVIDER_PAYLOAD` | `false` | Optional provider payload capture inside Langfuse metadata. |
| **Secret Redaction** | `PI_LANGFUSE_REDACTION` / `PI_LANGFUSE_UNREDACTED=1` | `true` | Redact known secrets and common token/PII-shaped patterns before Langfuse/raw-trace writes. Settings/config values take precedence over env opt-outs. |
| **Additional Redaction Secrets** | `PI_LANGFUSE_REDACTION_SECRETS` | - | Comma-separated literal secrets to redact in addition to env/config secrets. |
| **Raw Trace Export** | `PI_LANGFUSE_RAW_TRACE` | `false` | Redacted JSONL companion stream for training/distillation data. |
| **Raw Trace Directory** | `PI_LANGFUSE_RAW_TRACE_DIR` | `$PI_CODING_AGENT_DIR/langfuse/raw-traces` or `~/.pi/agent/langfuse/raw-traces` | Root directory for raw trace companion files. |

## Usage

### Initialize Langfuse

```text
/langfuse-init
```

Non-interactive examples:

```text
/langfuse-init --yes --local
/langfuse-init --yes --remote --host https://cloud.langfuse.com --public-key pk-lf-... --secret-key sk-lf-...
```

### Toggle tracing

```text
/langfuse:toggle [on|off]
```

### Create a local redacted export

Use this when you want training/eval material or shareable artifacts. It creates **local-only redacted derivatives** and uploads nothing.

For small exports from inside Pi:

```text
/langfuse:export
```

For large/bulk exports, use the standalone CLI outside Pi. This avoids blocking the Pi TUI while thousands of files are read, redacted, written, and scanned:

```bash
pi-langfuse-export \
  --sessions-dir ~/.pi/agent/sessions \
  --raw-dir ~/.pi/agent/langfuse/raw-traces \
  --out ~/pi-training-export \
  --require-trufflehog
```

Sessions only:

```bash
pi-langfuse-export \
  --sessions-only \
  --sessions-dir ~/.pi/agent/sessions \
  --out ~/pi-redacted-sessions \
  --require-trufflehog
```

Raw traces only:

```bash
pi-langfuse-export \
  --raw-only \
  --raw-dir ~/.pi/agent/langfuse/raw-traces \
  --out ~/pi-redacted-raw-traces \
  --require-trufflehog
```

Useful options for both `/langfuse:export` and `pi-langfuse-export`:

```text
--out /tmp/pi-redacted-export
--sessions-only
--raw-only
--sessions-dir ~/.pi/agent/sessions --raw-dir ~/.pi/agent/langfuse/raw-traces
--no-trufflehog
--require-trufflehog
```

The export writes:

```text
<out>/sessions/             redacted Pi session copies
<out>/raw-traces/           redacted raw trace copies
<out>/manifest.jsonl        one record per exported file
<out>/approved.jsonl        approved file records
<out>/rejected.jsonl        rejected file records
<out>/training-index.jsonl  approved redacted derivatives to train/review from
<out>/report.json           scanner findings and approved/rejected status
<out>/REVIEW.md             human review summary
```

No upload is performed.

#### Bulk export behavior

`/langfuse:export` runs inside Pi's command handler. It is convenient for small exports, but it is synchronous: large exports can make the TUI feel stuck until file copying, redaction, and scanner work finish.

`pi-langfuse-export` runs outside Pi. Use it for all sessions, all raw traces, or any export large enough that you care about terminal responsiveness. It streams progress to stderr (`discover`, per-file `copy`, `scan`, `write`, `done`), prints a final JSON summary to stdout, and writes detailed artifacts to the export directory. `report.json`, `approved.jsonl`, `rejected.jsonl`, and `training-index.jsonl` are the source of truth after completion.

Speed depends on total JSONL size, disk speed, sanitizer workload, and TruffleHog scan time. Small exports usually finish in seconds. Large multi-month session archives can take minutes. If the export matters, prefer:

```bash
pi-langfuse-export --require-trufflehog ...
```

so a missing or failing scanner rejects the export instead of silently approving it.

### Trace Model

```text
Trace (name: "pi-agent")
└── Span (name: "agent.prompt")
    └── Span (name: "agent.turn")
        ├── Generation (name: "llm-response")  <-- Cost/Token tracking
        └── Span (name: "tool:<name>")          <-- Arguments/Results
```

### Raw Traces

Langfuse is great for browsing runs, costs, tools, and failures. It is not meant to be the primary training archive: UI fields can be truncated, and traces may be optimized for observability.

For fine-tuning, distillation, or audit workflows, enable raw traces. Secret redaction still runs before each raw-trace append by default:

```json
{
  "rawTraceEnabled": true,
  "rawTraceDir": "$PI_CODING_AGENT_DIR/langfuse/raw-traces"
}
```

Raw traces are append-only JSONL companion files. They mirror Pi's native session layout, but live under `raw-traces`:

```text
Pi session:
  <agent-dir>/sessions/--project--/<session>.jsonl

Raw trace:
  <agent-dir>/langfuse/raw-traces/--project--/<session>.jsonl
```

If a nonstandard session path has no project directory to mirror, the raw trace is kept under the reserved fallback namespace instead of the raw-traces root:

```text
<agent-dir>/langfuse/raw-traces/--unknown--/<session>.jsonl
```

Each file contains records such as:

- `session_start`
- `agent_prompt_start`
- `provider_request`
- `tool_call`
- `tool_result_first_seen`
- `tool_execution_end`
- `assistant_output`
- `session_compact`

The important raw-trace record is `tool_result_first_seen`: it records a bounded, redacted summary of tool output as soon as this extension sees it, before later extensions can compress or rewrite it. Live raw traces are intentionally bounded to keep Pi responsive; use Pi's canonical sessions plus `/langfuse:export` for training/share derivatives. Raw traces can continue writing even if Langfuse tracing is disabled or the Langfuse server is unavailable.

#### Session lifecycle

| Action | Raw trace behavior |
| :--- | :--- |
| Normal session | Writes one companion JSONL file with the same project directory and filename. |
| `/move-session` with `pi-move-session` | Moves the raw trace companion when one exists; works normally when it does not. |
| Display rename | No change; the session filename does not change. |
| Fork or clone | Starts a new raw trace file for future events; parent evidence stays with the parent session. |
| Delete Pi session | Raw trace remains by default as training/audit evidence. |
| Manual filesystem move/rename | Move the matching raw trace file yourself if you want paths to stay mirrored. |

For a deep dive into the tracing model and data flow, see [docs/architecture.md](./docs/architecture.md).

## Privacy Notes

Local init is designed for private localhost use:

- Langfuse web/API binds to `127.0.0.1:3100`.
- Postgres, Redis, ClickHouse, and MinIO bind to localhost-only ports.
- Langfuse telemetry is disabled in the generated `.env` and Compose file.
- Langfuse Cloud is not used unless you explicitly configure a cloud host/key pair.

This does not change where your LLM provider sends prompts. If you use OpenAI, Anthropic, Google, or another remote model provider, Pi still sends prompts to that provider.

### Redaction model

Secret redaction is enabled by default. The rule is simple: **sanitize before data crosses a `pi-langfuse` write boundary**.

| Layer | Who owns it? | Redacted by `pi-langfuse`? | When? |
| :--- | :--- | :--- | :--- |
| Pi session JSONL | Pi core | No | Pi writes the canonical session directly. |
| `pi-langfuse` raw traces | `pi-langfuse` | Yes | Before each raw trace JSONL append. |
| Langfuse traces | `pi-langfuse` | Yes | Before each Langfuse SDK trace/span/generation/score call. |

In other words:

```text
Pi runtime event
  ├─ Pi session JSONL: Pi-owned, unchanged
  ├─ raw trace JSONL: sanitize -> write
  └─ Langfuse trace: sanitize -> send
```

The sanitizer redacts configured Langfuse secret keys, secret-like environment values, extra comma-separated literals from `PI_LANGFUSE_REDACTION_SECRETS`, sensitive object fields, private-key blocks, bearer tokens, GitHub tokens, `hf_` tokens, OpenAI/Anthropic/Langfuse secret keys, AWS access keys, JWTs, `.env`-style secret assignments, URLs with embedded credentials, common PII-shaped text (email, phone, SSN, credit-card-like numbers), data URLs, and large base64/hex blobs.

Every sanitized raw trace record includes:

```json
{ "redaction": { "applied": true } }
```

Disable redaction only for explicit local debugging:

```bash
PI_LANGFUSE_UNREDACTED=1 pi
# or
PI_LANGFUSE_REDACTION=0 pi
```

Even redacted raw traces can contain private business/user data that is not token-shaped. Treat `raw-traces/` as private data.

### What happens to old data?

Redaction is forward-going. It does not rewrite old data.

| Existing layer | What happens after installing this version? | What should you assume? |
| :--- | :--- | :--- |
| Old Pi session JSONL | Nothing changes. | Contaminated local originals. |
| Old raw traces | Nothing changes. | Contaminated local originals. |
| Old Langfuse traces | Nothing changes. | Already durable, indexed, exportable, and possibly backed up. |

Safe handling:

- **Pi sessions:** keep originals private. For sharing, create redacted derivative copies with `/langfuse:export` or another local batch review/redaction pipeline.
- **Old raw traces:** reprocess into a separate redacted directory before sharing, then archive or delete originals according to your retention policy.
- **Old Langfuse traces:** if secrets may have been sent, delete affected traces/projects and rotate credentials. Post-hoc cleanup is mitigation, not a guarantee.

### Local export safety gate

Live redaction protects new `pi-langfuse` telemetry. `/langfuse:export` is the separate safety gate for old files and training/share material.

| Step | What it does |
| :--- | :--- |
| Copy | Reads Pi session JSONL and/or raw trace JSONL. Originals are not modified. |
| Redact | Writes sanitized derivative files to the export directory. |
| Scan | Runs deterministic residual-secret checks on the sanitized output. |
| Gate | Marks each file `approved` only when no residual findings remain. |
| External scan | TruffleHog runs on the export directory by default when available. Findings reject the export. Use `--no-trufflehog` only for explicit local bypass, or `--require-trufflehog` to reject if it is unavailable. |
| Review | Writes `report.json`, `manifest.jsonl`, and `REVIEW.md` for local human review. |

This is deliberately local-only. It has no dataset upload path.

### Live redaction vs export redaction

| Mode | Main job | Redaction timing | Boundary |
| :--- | :--- | :--- | :--- |
| Live tracing | Observability while Pi runs | Before writing raw traces or sending Langfuse payloads | Langfuse/raw-trace write boundary |
| Local export | Training/share preparation | On demand, while creating redacted derivative copies | Local export approval boundary |

Live tracing protects new telemetry. Local export protects old files and training/share material. Originals stay unchanged; only derivative copies are reviewed and approved.

### Training, distillation, and fine-tuning

Do not train directly from raw originals. Train from **redacted derivative exports**.

| Source | Use for training? | Best role |
| :--- | :--- | :--- |
| Pi session JSONL | Yes, after redaction/review | Canonical chat and tool transcript. |
| `pi-langfuse` raw traces | Yes, after redaction/review | Runtime evidence, provider requests, tool results, eval mining. |
| Langfuse traces | Maybe | Filtering, scoring, indexing, cost/failure analysis; not the primary corpus. |

Recommended flow:

```text
Pi sessions + raw traces
  -> /langfuse:export
  -> redacted derivatives
  -> scan/review/filter
  -> normalize into training examples
  -> train/fine-tune/distill
```

Raw originals stay local. Only approved redacted derivatives should leave your trust boundary.

### Hard boundaries

Some safety problems cannot be solved honestly by an extension without crossing ownership or destructive boundaries:

| Problem | Current handling | Why |
| :--- | :--- | :--- |
| Canonical Pi session rewrite before persistence | Not done. Use `/langfuse:export` for redacted derivatives. | Pi core owns canonical session persistence. Rewriting it here would require a Pi pre-persist hook or core change. |
| Old traces already stored in Langfuse | Not deleted automatically. | Deleting remote observability data is destructive and requires explicit operator intent, credentials, and retention decisions. |
| Images/binary/media payloads | Redacted or summarized when seen as telemetry fields/strings. | The extension does not OCR or forensically inspect arbitrary binary files. |
| Unknown future secret formats | Covered by configured literals, broad patterns, and export scanner. | No regex/scanner can guarantee detection of every future/private token format. Add literals via `PI_LANGFUSE_REDACTION_SECRETS`. |
| Broad business-sensitive content | Partially covered by PII-shaped patterns. | Semantic confidentiality needs human review before sharing/training. |

## Troubleshooting

- **No traces?** Check `http://localhost:3100/api/public/health`, API keys, and Pi console warnings.
- **Docker did not start?** Run `docker compose up -d` inside the local Langfuse directory.
- **Wrong login?** Check the generated `.env` for `LANGFUSE_INIT_USER_EMAIL` and `LANGFUSE_INIT_USER_PASSWORD`.
- **Incomplete traces?** Ensure your Pi version supports `message_*`, tool, and session lifecycle events.
- **Cost is zero?** Token usage can be captured even when model pricing is not configured.
- **Large payloads in Langfuse UI?** Adjust the max-char limits in config/settings.
- **No raw trace file?** Check `rawTraceEnabled`, `rawTraceDir`, and that the run uses a persisted Pi session rather than `--no-session`.

## License

MIT
