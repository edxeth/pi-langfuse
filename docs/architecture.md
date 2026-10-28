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
- **agent.turn**: A span for each reasoning turn. A single prompt may have many turns if the agent is calling tools. Its input is the newly delivered incoming messages attached at that turn's provider-request boundary, shaped by message role and capture policy.
- **llm-response**: A Langfuse Generation object. It captures a bounded summary of the prompt sent to the LLM, a structured assistant output (`text`, `tool_calls`, optional visible `thinking`), and the final token usage/cost. Text/thinking and tool arguments use their separate capture-policy fields.
- **tool:<name>**: A span representing a tool execution (e.g., `bash`, `read_file`). It captures input arguments and the (truncated) result. When a tool reports nested model work as `usage` on its result, the span carries that usage and the prompt trace aggregates it once per `toolCallId` under its separate indirect usage totals; compaction summaries that report `usage` are aggregated once per compaction entry id. Indirect totals stay separate from the direct usage of `llm-response` generations.

## Data Flow

1.  **Initialization**: On `session_start`, the extension assigns events to a `SessionStateOwner` keyed by the Pi session context and captures the session filename stem for trace correlation.
2.  **Prompt Start**: `before_agent_start` creates the `pi-agent` trace and `agent.prompt` root observation.
3.  **Turn Loop**:
    - `turn_start` opens an `agent.turn` span under the prompt.
    - `message_start` (assistant) opens an `llm-response` generation under the turn.
    - `message_update` updates a structured partial output with separate answer text, tool calls, and visible thinking.
    - `tool_execution_start` or `tool_call` opens one tool span under the active turn.
    - `tool_result` stores provisional result data; `tool_execution_end` supplies authoritative completion data.
    - `message_end` finalizes the generation with usage, cost, and provider metadata.
    - `turn_end` closes the turn span with the same structured assistant output and the role-shaped input captured at the request boundary.
4.  **Finalization**: `agent_settled` — Pi's final boundary after automatic retry, overflow compaction, and queued continuations — configuration refresh, session replacement, or `session_shutdown` closes unfinished child observations before the parent and updates trace health and aggregate metrics. `agent_end` only closes one low-level agent run: it records the run outcome (a healthy final run marks an earlier failure as recovered) and keeps the prompt open for continuation events that never re-emit `before_agent_start`. A prompt interrupted before settlement is finalized as abandoned by the interrupting boundary. A run that starts with no prompt at all — Pi defers `sendMessage(..., { triggerTurn: true })` issued during settlement and starts it without `before_agent_start` — gets its own trace with empty prompt input and `promptSource: "unannounced-agent-run"` metadata instead of being dropped.
5.  **Export and flush**: Ended spans use the Langfuse processor's public immediate mode and one OTLP exporter, which batches them (see "Delivery contract"). Prompt completion sends what is queued without waiting for it; shutdown and configuration refresh flush running and queued sends. Nothing queries observation read APIs. Scores use the supported scores endpoint.

## Delivery contract

Delivery means the OTLP endpoint accepted the export, not that each observation is already indexed or durably stored. The extension no longer maintains a second trace store, negotiates observation read APIs, or replays accepted exports. This removes indexing delays from the prompt lifecycle and makes normal tracing independent of server read mode.

`otlp-export.ts` uses the existing OTLP serializer and Node.js fetch, with explicit endpoint and credentials. The SDK's default exporter treats partial rejection as success, so the extension supplies its own exporter through the public interface. No global diagnostic interception or private SDK members are used.

- Transient network errors and HTTP 429/502/503/504 retry with backoff (250 ms, doubling, at most 2 s) until the ten-second total export deadline, so a server that is unavailable for a few seconds, for example while its database restarts, loses nothing. A Retry-After value or backoff beyond the remaining deadline ends the export with a diagnostic. Every wait lasts at least 250 ms, even when Retry-After advises none.
- Partial rejection is reported and never retried, as required by OTLP. A zero-rejected warning is not a rejection. Malformed responses cannot establish acceptance.
- Requests are bounded to 3.5 MB. Individually oversized spans are reported rather than poisoning sendable spans. Response reads and diagnostic summaries are bounded; server error bodies are not displayed.
- Immediate mode calls the exporter once per ended span. It avoids the SDK batch queue's silent overflow and ensures flush waits for active sends. The exporter batches: an ended span waits up to two seconds for others, and the end of a turn (`agent.turn`) or prompt (`agent.prompt`), 256 waiting spans, a flush, or shutdown sends everything that waits at once. Spans that end while a flush or shutdown runs skip the wait as well; batching resumes when it ends. On the self-hosted v3 server every request that carries a trace stores one more file that each later merge of that trace rereads, so batching cuts server work far more than the request count suggests. The exporter runs at most four exports at once; spans that arrive while all four are busy leave together when a slot frees. Every waiting caller receives that export's result, and a failure is reported once per export. The ten-second deadline starts when an export starts, not while it waits. This does not wait for indexing or another prompt.
- Flush first sends every waiting span, then awaits the owned `LangfuseSpanProcessor` directly; spans the processor hands over meanwhile leave at once. It does not race another timer or call the provider's generic, non-cancelling force-flush watchdog. Shutdown and reconfiguration finalize open roots, await the same completion path, then dispose the SDK resources. Slow responses can hold these operations open until the request accepts or cancels; fast responses add no fixed wait.
- Prompt completion (`agent_settled`) does not wait for delivery. Pi counts the session as busy until settlement handlers return, so waiting there delayed every prompt end by the slowest request. The ended prompt root sends its batch at once, and session shutdown awaits all sends before the process exits.
- Scores share the export budget: a ten-second deadline with an abort signal active through response-body consumption, and the same retries of network errors and HTTP 429/502/503/504. Each score carries an id that stays the same across retries, so a retry after a response that was lost updates the same score instead of adding one. The SDK's header-only timer cannot be disabled through public options and gets the time left. There is no separate score-flush or client-shutdown stopwatch.
- Token usage and cost travel on each `llm-response` generation (`usageDetails`, `costDetails`), where Langfuse aggregates them. They are not repeated as scores.
- Automatic media uploads are disabled explicitly, including when `LANGFUSE_MEDIA_UPLOAD_ENABLED` is set. Langfuse SDK 5.11.1's media PUT has no cancellation control. Media content is subject to existing capture, redaction, and payload limits, but is not uploaded as a separate attachment. With no async masks or async resource attributes configured, all processor I/O belongs to the bounded OTLP exporter.
- The deadline aborts active HTTP work. Exhausted exports are reported, not retained for a later prompt. There is no durable queue or crash-safe delivery guarantee. A timeout can mean an unconfirmed acceptance, not proven server-side loss.

Telemetry diagnostics go through Pi notifications in interactive/RPC modes and stderr in headless mode. `/langfuse-status` keeps the last historical error; successful exports do not erase that history. Adjacent identical notifications are deduplicated for the active UI, and shutdown detaches its listener.

## State Management

Each session owns its model, provider, prompt, turn, generation, tool, counter, raw-trace, and finalization state. The owner rejects ambiguous events instead of attaching them to an arbitrary session. A process-wide lease set keeps the shared Langfuse runtime alive while another extension runtime still owns a session.

Maps correlate turns by `turnIndex`, generations by their ordered request state inside a turn, and tools by `toolCallId`. Start, update, end, abandon, and cleanup transitions are idempotent. Late events after cleanup do not create new observations.

## Truncation and privacy

Payload policy runs before each Langfuse or raw-trace write. Ambiguous sensitive assignments become a redacted marker instead of retaining potentially secret text. The default `full-debug` policy preserves existing capture behavior. `metadata-only`, `prompts-only`, and `conversations` reduce content capture without changing structural trace identifiers. Fine-grained overrides and payload budgets apply to strings, tool payloads, depth, collections, and total nodes.

Shaped `provider_request` and `assistant_output` raw records also carry `captureProvenance`: per content field, whether the emitted value equals the same shaping run with every capture field forced on and all payload limits lifted. The check reuses the shaping code and the resolved limits, so it cannot drift from what shaping actually does. `provider_request` records also carry `serverSideContext` (field names such as `previous_response_id` or `conversation`, never ids) when the observed payload referenced provider-held context, so training export can reject samples whose captured input is not the full context. Training export (`--format`, `training-export.ts`) converts only records whose required fields are `verified`, whose history items report no incomplete status, and which carry no such reference, and keeps them only after a completed external scan.

Exports force redaction independently of live capture settings. Raw `provider_request` records store bounded summaries by default. Set `rawTraceProviderRequestMode: "full"` or `PI_LANGFUSE_RAW_PROVIDER_REQUEST=full` only for controlled runs that need the redacted contents observed at the provider hook. Later extensions can still replace that payload before transmission.

Identity pseudonymization (`identityMode: "pseudonymous"`) runs in the same shared sanitizer, so Langfuse bodies, scores, raw traces, and exports share one policy that does not depend on the redaction toggle. Release, environment, and resource values stamped by the span processor outside body shaping are transformed where the runtime is created, and the runtime always names the OpenTelemetry service `pi-langfuse` with this package's version. An invalid identity configuration or an unavailable salt marks the resolved config unusable: `canTrace`, raw-trace writes, and exports refuse to run, and the sanitizer itself throws rather than emit raw identity.

See [privacy.md](./privacy.md) for the policy matrix, redaction boundary, and identity scope.
