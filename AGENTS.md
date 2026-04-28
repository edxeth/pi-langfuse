# Agent Context for pi-langfuse

This document provides essential context for AI agents working on this project.

## Architectural Principles

- **TypeScript ESM**: This is a strict ESM project. 
  - **Crucial**: All internal imports MUST use the `.js` extension (e.g., `import { x } from "./config.js"`), even though the files are `.ts`.
- **Node16 Resolution**: We follow `Node16` module resolution to ensure compatibility with the Pi agent's loader.
- **Src Structure**: All source code is in `src/`. Tests are colocated in `src/*.test.ts`, except for E2E tests which reside in `test/`.

## Tracing Model (Langfuse Native)

When modifying tracing logic, you MUST maintain the following hierarchy:
- **Trace**: One per Pi prompt.
- **Span (agent.prompt)**: The root observation for the prompt.
- **Span (agent.turn)**: One per LLM turn.
- **Generation (llm-response)**: Nested under the turn, captures usage/cost.
- **Span (tool:<name>)**: Nested under the turn or prompt, captures tool execution.

## Toolchain

- **Linting/Formatting**: We use **Biome**. Run `npm run check` or `npm run format`.
- **Testing**: We use **Vitest**. Run `npm test`.
- **E2E Integration**: Requires `RUN_LANGFUSE_E2E=1` and valid `LANGFUSE_*` credentials.
- **Releases**: Managed via `release-it`. Always use Conventional Commits (`feat:`, `fix:`, `chore:`, etc.) to ensure the automated changelog works correctly.

## Client Lifecycle

- **Client Persistence**: Do NOT shut down the Langfuse client on every prompt.
- **Flushing**: Use `flushClient()` to ensure data is sent before the process exits.
- **Clean Finalization**: Use `finalizePrompt()` to cleanly close any abandoned or open spans (especially during interruptions or config reloads).
