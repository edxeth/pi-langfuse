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

- **Linting/Formatting**: We use **Biome**. `npm run check` and `npm run format` write changes; use `npx biome check .` for non-writing verification.
- **Testing**: We use **Vitest**. Run `npm test`.
- **E2E Integration**: Requires `RUN_LANGFUSE_E2E=1` and valid `LANGFUSE_*` credentials. Pushes to `main` trigger CI with E2E enabled; when GitHub Langfuse secrets are configured, obtain approval for synthetic trace writes to that project before pushing.
- **Telemetry test isolation**: `resolveConfig({})` can load the user's persistent project. Before any runtime creation, pin an isolated config and verify the exact destination and synthetic credentials. Persistent-project writes and deletions each need explicit approval; after an accidental write, stop and report rather than automatically deleting it.
- **Offline Pi tests**: Run `RUN_LANGFUSE_E2E=0 npm test`. The real-SDK fixtures in `test/pi-runtime/isolated-pi.ts` disable resource discovery and check owned discovery bait before prompting; reuse that boundary for new runtime scenarios.
- **Releases**: Managed via `release-it`. Always use Conventional Commits (`feat:`, `fix:`, `chore:`, etc.) to ensure the automated changelog works correctly.

## Client Lifecycle

- **Client Persistence**: Do NOT shut down the Langfuse client on every prompt.
- **Flushing**: Use `flushClient()` to ensure data is sent before the process exits.
- **Clean Finalization**: Use `finalizePrompt()` to cleanly close any abandoned or open spans (especially during interruptions or config reloads).
