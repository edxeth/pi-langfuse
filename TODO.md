# TODO: Improve `pi-langfuse`

Goal: make `pi-langfuse` a first-class, Langfuse-native observability extension for Pi. `pi-otel-telemetry/index.ts` is only a reference for lifecycle coverage and hierarchy patterns — this plan focuses on improving this package itself.

## Objectives

- Preserve the extension's Langfuse-native design
- Improve trace completeness and hierarchy
- Capture more of Pi's lifecycle and tool activity
- Align with current Langfuse SDK and tracing best practices
- Keep configuration and UX simple for Pi users

---

## Phase 0 — Baseline and design constraints

- [x] Document the current event model used by the extension
- [x] Define the target trace model for Pi + Langfuse
- [x] Decide which fields belong in:
  - trace attributes
  - observation metadata
  - usage / cost details
  - tags
- [x] Define a truncation/redaction policy for prompt, tool args, and tool output

### Current implemented model

- One Langfuse **trace per Pi prompt** grouped by `sessionId`
- One `agent.prompt` span under the trace
- One `agent.turn` span per turn under `agent.prompt`
- One `tool:<name>` span per tool execution under the current turn
- One `llm-response` generation per assistant turn under the current turn

---

## Phase 1 — Fix correctness issues

- [x] Fix incorrect `totalTools` reporting
- [x] Stop shutting down the Langfuse client on every `agent_end`
- [x] Ensure abandoned/open spans are ended on shutdown or error paths
- [x] Ensure session-scoped state is reset correctly on reload/fork/resume

---

## Phase 2 — Improve lifecycle coverage

### Add missing Pi events

- [x] Add `agent_start`
- [x] Add `turn_start`
- [x] Add `tool_execution_start`
- [x] Add `tool_execution_update`
- [x] Add `tool_execution_end`
- [x] Implement `message_start`
- [x] Implement `message_update`
- [x] Implement `message_end`
- [x] Add `session_compact` as a trace event / annotation
- [x] Implement `before_provider_request` for request-size/timing metadata

### Event usage policy

- [x] Use `tool_execution_*` for lifecycle timing and progress
- [x] Keep `tool_call` only if needed for pre-execution argument capture/blocking awareness
- [x] Keep `tool_result` only if needed for final normalized content capture
- [x] Use `turn_start`/`turn_end` to model LLM turns explicitly
- [x] Use `message_start`/`update`/`end` to model assistant generations explicitly

---

## Phase 3 — Introduce a better Langfuse hierarchy

### Target hierarchy

- [ ] Session-level root context for the Pi session (grouping via `sessionId` implemented)
- [x] Per-user-prompt observation/span
- [x] Per-turn child observation/span
- [x] Per-tool child span under the turn
- [x] Per-LLM-generation observation under the turn

---

## Phase 4 — Improve Langfuse semantics

### Trace/session/user propagation

- [x] Add `sessionId` consistently and early
- [x] Add `userId` support
- [x] Add trace/session tags
- [x] Add release/environment support following Langfuse guidance

### Metadata quality

- [x] Audit metadata values for SDK compatibility
- [x] Normalize metadata into safe, bounded, meaningful keys
- [x] Avoid stuffing large blobs into metadata
- [x] Move metrics-like values into usage/cost/details where appropriate

---

## Phase 5 — Improve LLM generation capture

- [x] Model each assistant turn as a Langfuse generation when usage/model data exists
- [x] Capture model and provider consistently
- [x] Capture prompt input more precisely
  - **Full messages via `context` event**: `llm-response` generation input now receives the complete
    chat messages array (system prompt, conversation history, tool calls/results, user prompt)
    instead of just the raw user text. Langfuse renders this natively in the UI as a proper
    chat conversation view.
- [x] Capture output more precisely
- [x] Improve usage details (input, output, total, cache read, cache write)
- [x] Improve cost capture (ingest provider cost when present)
- [x] Implement streaming assistant generation updates via `message_update`

---

## Phase 6 — Improve tool observability

- [x] Capture tool start/end timestamps and duration
- [x] Record tool error status explicitly
- [x] Capture tool args with per-tool summarization/redaction rules
- [x] Capture tool output with per-tool summarization/truncation rules
- [x] Capture partial progress from `tool_execution_update`
- [x] Preserve structured result details when useful
- [ ] Handle non-text tool outputs safely (images, binary/file references)

---

## Phase 7 — Error, cancellation, and shutdown behavior

- [x] Record failed tool executions with explicit status and error metadata
- [x] Record incomplete prompt runs when the session stops mid-agent
- [x] Handle cancellation/interruption via `agent_end` and `finalizePrompt` cleanup
- [x] Flush on `session_shutdown`
- [x] Ensure config reload performs safe client replacement without losing queued data

---

## Phase 8 — SDK modernization

- [x] Upgrade `langfuse` dependency to `^3.38.20`
- [x] Review current Langfuse JS/TS migration guidance
- [x] Adopt newer patterns (release, environment, manual attribute propagation)
- [x] Re-check metadata requirements after upgrade
- [x] Validate no deprecated APIs remain in use

---

## Phase 9 — Configuration and settings improvements

- [x] Keep current settings integration working
- [x] Add optional settings for observability behavior
  - trace input/output limits
  - tool arg/output truncation limits
  - enable/disable tool progress capture
  - enable/disable message streaming capture
  - optional user ID override
  - optional default tags
  - release name
  - environment name
- [x] Add validation and better diagnostics for invalid config

---

## Phase 10 — Testing and verification

- [ ] Manual test: single prompt, no tools
- [ ] Manual test: prompt with multiple tools
- [ ] Manual test: parallel tools
- [ ] Manual test: tool error
- [ ] Manual test: interrupted/cancelled run
- [ ] Manual test: session reload
- [ ] Manual test: session fork/resume
- [ ] Manual test: config change while running
- [ ] Manual test: large tool output truncation
- [ ] Verify hierarchy in Langfuse UI
- [ ] Verify sessions view groups traces correctly
- [ ] Verify user/tag filtering works
- [ ] Verify token/cost charts look correct

---

## Proposed implementation order

### Milestone 1 — Stabilize current extension
- [x] Fix counters and state bugs
- [x] Keep client alive until `session_shutdown`
- [x] Add safe flush/shutdown handling

### Milestone 2 — Add richer lifecycle coverage
- [x] Add `turn_start`
- [x] Add `tool_execution_start/update/end`
- [x] Add duration/error/progress capture
- [x] Implement `message_start/update/end` for streaming

### Milestone 3 — Reshape hierarchy
- [x] Introduce explicit prompt/turn/tool/generation hierarchy
- [x] Add session/user/tags propagation

### Milestone 4 — Modernize Langfuse usage
- [x] Upgrade SDK
- [x] Adopt newer attribute propagation patterns
- [x] Normalize metadata/usage/cost modeling
- [x] Add release/environment support

### Milestone 5 — Polish
- [x] README updates
- [x] config/settings additions
- [ ] optional tests/examples

---

## Current status summary

Implemented in this session:

- refactored `index.ts` to use `message_start`, `message_update`, and `message_end` for more accurate assistant generation tracing.
- added streaming text and thinking capture with optional real-time Langfuse updates.
- implemented `before_provider_request` to capture LLM request metadata (payload size, model) in turn spans.
- added `release` and `environment` support to settings, config, and Langfuse traces.
- updated `finalizePrompt` to cleanly close open generations on abandonment.
- modernized `LangfuseClient` interface and related types to support new fields.
- **added full prompt capture**: hooked into the `context` event to capture the complete chat messages array (system prompt, conversation history, tool calls, user prompts) and use it as the generation `input`, so Langfuse UI displays the full LLM prompt in its native chat messages view instead of just the user's text.

Highest-priority remaining work:

1. ~~verify `systemPrompt` visibility in Langfuse UI~~ → **now visible** via full messages in generation input.
2. verify `before_provider_request` captures payload size correctly in the UI.
3. handle non-text tool outputs (images, etc.) if possible.
4. add manual tests or verification scripts to confirm Langfuse UI behavior across scenarios.
