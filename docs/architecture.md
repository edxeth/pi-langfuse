# Architecture: pi-langfuse

This document describes the internal architecture of the Langfuse extension for Pi.

## Tracing Model

The extension maps Pi's agentic lifecycle to a hierarchical Langfuse model. This allows you to drill down from a high-level user prompt into specific LLM turns and tool executions.

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
- **llm-response**: A Langfuse Generation object. It captures the exact prompt sent to the LLM, the streaming response (text + thinking), and the final token usage/cost.
- **tool:<name>**: A span representing a tool execution (e.g., `bash`, `read_file`). It captures input arguments and the (truncated) result.

## Data Flow

1.  **Initialization**: On `session_start`, we capture the `sessionId` from the Pi session file.
2.  **Prompt Start**: `before_agent_start` creates the root Langfuse trace.
3.  **Turn Loop**:
    - `turn_start` opens an `agent.turn` span.
    - `message_start` (assistant) opens an `llm-response` generation.
    - `message_update` appends streaming text/thinking to the generation.
    - `tool_execution_start` opens a tool span nested under the turn.
    - `message_end` finalizes the generation with usage data.
    - `turn_end` closes the turn span.
4.  **Finalization**: `agent_end` or `finalizePrompt` closes any abandoned spans and updates the trace with aggregate metrics (total tokens, total tool calls).

## State Management

The extension uses an in-memory `promptState` to track active observations. Because Pi can execute tools in parallel or have complex turn logic, we use `Map` structures to correlate events via `turnIndex` or `toolCallId`.

## Truncation & Privacy

To avoid sending massive payloads to Langfuse:
- User prompts and assistant responses are truncated based on `trace-input-max-chars`.
- Tool arguments and results are truncated based on `tool-args-max-chars` and `tool-output-max-chars`.
- Sensitive environment variables are **not** captured by default.
