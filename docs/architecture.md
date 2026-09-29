# Architecture: pi-langfuse

This document describes the internal architecture of the Langfuse extension for Pi.

## Tracing Model

The extension maps Pi's agent lifecycle to a hierarchical Langfuse model. Langfuse v5 and OpenTelemetry provide the transport through a typed local facade. Lifecycle modules do not import vendor observation types.

### Hierarchy

```text
Trace (name: "pi-agent")
└── Span (name: "agent.prompt")
    └── Span (name: "agent.turn")
        ├── Generation (name: "llm-response")
        └── Span (name: "tool:<name>")
```

- **Trace**: Represents one full user interaction. It carries global metadata like `cwd`, `model`, `provider`, `release`, and `environment`.
- **agent.prompt**: A span that wraps the entire multi-turn loop for a single prompt.
- **agent.turn**: A span for each reasoning turn. A single prompt may have many turns if the agent is calling tools.
- **llm-response**: A Langfuse Generation object. It captures a bounded summary of the prompt sent to the LLM, the streaming response (text + thinking), and the final token usage/cost.
- **tool:<name>**: A span representing a tool execution (e.g., `bash`, `read_file`). It captures input arguments and the (truncated) result. When a tool reports nested model work as `usage` on its result, the span carries that usage and the prompt trace aggregates it once per `toolCallId` under its separate indirect usage totals; compaction summaries that report `usage` are aggregated once per compaction entry id. Indirect totals stay separate from the direct usage of `llm-response` generations.

## Data Flow

1.  **Initialization**: On `session_start`, the extension assigns events to a `SessionStateOwner` keyed by the Pi session context and captures the session filename stem for trace correlation.
2.  **Prompt Start**: `before_agent_start` creates the `pi-agent` trace and `agent.prompt` root observation.
3.  **Turn Loop**:
    - `turn_start` opens an `agent.turn` span under the prompt.
    - `message_start` (assistant) opens an `llm-response` generation under the turn.
    - `message_update` appends streaming text and thinking to the generation.
    - `tool_execution_start` or `tool_call` opens one tool span under the active turn.
    - `tool_result` stores provisional result data; `tool_execution_end` supplies authoritative completion data.
    - `message_end` finalizes the generation with usage, cost, and provider metadata.
    - `turn_end` closes the turn span.
4.  **Finalization**: `agent_settled` — Pi's final boundary after automatic retry, overflow compaction, and queued continuations — configuration refresh, session replacement, or `session_shutdown` closes unfinished child observations before the parent and updates trace health and aggregate metrics. `agent_end` only closes one low-level agent run: it records the run outcome (a healthy final run marks an earlier failure as recovered) and keeps the prompt open for continuation events that never re-emit `before_agent_start`. A prompt interrupted before settlement is finalized as abandoned by the interrupting boundary. A run that starts with no prompt at all — Pi defers `sendMessage(..., { triggerTurn: true })` issued during settlement and starts it without `before_agent_start` — gets its own trace with empty prompt input and `promptSource: "unannounced-agent-run"` metadata instead of being dropped.
5.  **Export and flush**: Ended spans use the Langfuse processor's public immediate mode and one OTLP exporter. Prompt completion and shutdown flush in-flight sends; they do not query observation read APIs. Scores use the supported scores endpoint.

## Delivery contract

Delivery means the OTLP endpoint accepted the export, not that each observation is already indexed or durably stored. The extension no longer maintains a second trace store, negotiates observation read APIs, or replays accepted exports. This removes indexing delays from the prompt lifecycle and makes normal tracing independent of server read mode.

`otlp-export.ts` uses the existing OTLP serializer and Node.js fetch, with explicit endpoint and credentials. The SDK's default exporter treats partial rejection as success, so the extension supplies its own exporter through the public interface. No global diagnostic interception or private SDK members are used.

- Transient network errors and HTTP 429/502/503/504 retry with backoff, at most four attempts within a two-second total export deadline. A Retry-After value beyond the remaining deadline ends the attempt with a diagnostic.
- Partial rejection is reported and never retried, as required by OTLP. A zero-rejected warning is not a rejection. Malformed responses cannot establish acceptance.
- Requests are bounded to 3.5 MB. Individually oversized spans are reported rather than poisoning sendable spans. Response reads and diagnostic summaries are bounded; server error bodies are not displayed.
- Immediate mode emits one request per ended span. It avoids the SDK batch queue's silent overflow and ensures flush waits for active sends. This increases request count compared with batching, but does not wait for indexing or another prompt.
- The deadline aborts active HTTP work. Exhausted exports are reported, not retained for a later prompt. There is no durable queue or crash-safe delivery guarantee. A timeout can mean an unconfirmed acceptance, not proven server-side loss.

Telemetry diagnostics go through Pi notifications in interactive/RPC modes and stderr in headless mode. `/langfuse-status` keeps the last historical error; successful exports do not erase that history. Adjacent identical notifications are deduplicated for the active UI, and shutdown detaches its listener.

## State Management

Each session owns its model, provider, prompt, turn, generation, tool, counter, raw-trace, and finalization state. The owner rejects ambiguous events instead of attaching them to an arbitrary session. A process-wide lease set keeps the shared Langfuse runtime alive while another extension runtime still owns a session.

Maps correlate turns by `turnIndex`, generations by their ordered request state inside a turn, and tools by `toolCallId`. Start, update, end, abandon, and cleanup transitions are idempotent. Late events after cleanup do not create new observations.

## Truncation and privacy

Payload policy runs before each Langfuse or raw-trace write. Ambiguous sensitive assignments become a redacted marker instead of retaining potentially secret text. The default `full-debug` policy preserves existing capture behavior. `metadata-only`, `prompts-only`, and `conversations` reduce content capture without changing structural trace identifiers. Fine-grained overrides and payload budgets apply to strings, tool payloads, depth, collections, and total nodes.

Exports force redaction independently of live capture settings. Raw `provider_request` records store bounded summaries by default. Set `rawTraceProviderRequestMode: "full"` or `PI_LANGFUSE_RAW_PROVIDER_REQUEST=full` only for controlled runs that need the redacted contents observed at the provider hook. Later extensions can still replace that payload before transmission.

See [privacy.md](./privacy.md) for the policy matrix and redaction boundary.
