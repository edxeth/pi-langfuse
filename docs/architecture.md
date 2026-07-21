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
- **tool:<name>**: A span representing a tool execution (e.g., `bash`, `read_file`). It captures input arguments and the (truncated) result.

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
4.  **Finalization**: `agent_end`, configuration refresh, session replacement, or `session_shutdown` closes unfinished child observations before the parent and updates trace health and aggregate metrics.
5.  **Flush and fallback**: A bounded OTel flush runs at prompt completion. If a completed trace is not visible, the facade sends one redacted REST batch attempt and retires the snapshot.

## State Management

Each session owns its model, provider, prompt, turn, generation, tool, counter, raw-trace, and finalization state. The owner rejects ambiguous events instead of attaching them to an arbitrary session. A process-wide lease set keeps the shared Langfuse runtime alive while another extension runtime still owns a session.

Maps correlate turns by `turnIndex`, generations by their ordered request state inside a turn, and tools by `toolCallId`. Start, update, end, abandon, and cleanup transitions are idempotent. Late events after cleanup do not create new observations.

## Truncation and privacy

Payload policy runs before each Langfuse or raw-trace write. The default `full-debug` policy preserves existing capture behavior. `metadata-only`, `prompts-only`, and `conversations` reduce content capture without changing structural trace identifiers. Fine-grained overrides and payload budgets apply to strings, tool payloads, depth, collections, and total nodes.

Exports force redaction independently of live capture settings. Raw `provider_request` records store bounded summaries by default. Set `rawTraceProviderRequestMode: "full"` or `PI_LANGFUSE_RAW_PROVIDER_REQUEST=full` only for controlled runs that need the exact redacted provider message array.

See [privacy.md](./privacy.md) for the policy matrix and redaction boundary.
