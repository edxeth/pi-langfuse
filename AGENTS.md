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
- **Telemetry test isolation**: `test/setup.ts` pins a temporary `HOME`, agent/session directories, config path, raw-trace directory, synthetic credentials, and loopback endpoint for each test file, and keeps them pinned for the worker's whole life. Vitest does not cancel a timed-out test: its continuation keeps running after every hook, so nothing may restore the user's `HOME`, Pi, or Langfuse environment, and a longer timeout is not containment. `test/timeout-containment.test.ts` proves this with child runs against a canary original environment. Tests that clear path overrides must stay beneath that temporary `HOME`. Before standalone or live checks, pin an isolated config and verify the exact destination and synthetic credentials. Only explicit `RUN_LANGFUSE_E2E=1` preserves supplied credentials; its config path stays temporary. Persistent-project writes and deletions need explicit approval. After an accidental write, stop and report without cleanup.
- **Pi event contracts**: The locked Pi in `node_modules` (types and offline runtime) can be older or newer than the Pi that loads this extension; the peer range still allows older Pi. When handling Pi events, check the installed Pi `CHANGELOG.md` for contract changes the locked types miss. Example: since Pi 1.2.0, `before_agent_start` for custom-message runs has no `prompt`. Under `npm`/`npx`, `pi` resolves to the locked `node_modules/.bin/pi`; spawn the installed Pi by absolute path (`command -v pi` from a plain shell) for live checks.
- **Offline Pi tests**: Run `RUN_LANGFUSE_E2E=0 npm test`. The real-SDK fixtures in `test/pi-runtime/isolated-pi.ts` disable resource discovery and check owned discovery bait before prompting; reuse that boundary for new runtime scenarios. A case is owned before its first `await`: teardown (or the `afterEach` in that file) discards a startup that outlives its test, refuses later session calls, and releases the environment only after every tracked session call has settled. SDK `abort()` does not join a prompt held in `before_agent_start` or a tool that ignores abort, and a close timeout fails the caller without releasing the case. The first case in a test file pays the cold Pi SDK import, which can outlast Vitest's default test timeout under the full suite; a file whose tests keep that default starts with `beforeAll(warmRuntimeCase)`.
- **Delivery in tests**: `agent_settled` sends a finished prompt's spans and scores without waiting for them; only `flushClient()`, `shutdownClient()`, and session shutdown wait. After `session.waitForIdle()` or a settle, `await flushClient()` before reading a recorder.
- **Overhead benchmark**: `npm run bench -- --repo <checkout> --scenario streaming|burst|long-session` compares checkouts (for example `main` against a worktree) on per-event CPU, sync file calls, and HTTP volume. Its isolation guards are listed in the header of `scripts/bench-overhead.mjs` and pinned by `test/bench-overhead.test.ts`; it exits 1 if a guard blocked anything. A harness that loads `src/index.ts` outside Vitest gets none of `test/setup.ts`'s isolation: use this script or copy its guards.
- **Reported warnings**: Pi notifications and stderr are not in session JSONL. Every diagnostic is appended to `$PI_CODING_AGENT_DIR/langfuse/diagnostics.jsonl` (see `src/diagnostics-log.ts`); read it first.
- **Install verification**: `npm run git-install:smoke` clones committed HEAD, not worktree edits. Use `npm run package:smoke` to verify the current uncommitted package and its entrypoints.
- **Changelog and releases**: Record user-facing changes under `## [Unreleased]` in `CHANGELOG.md`. No release automation is configured: `npm run release` (release-it) has no config. Use Conventional Commits (`feat:`, `fix:`, `chore:`, etc.).

## Client Lifecycle

- **Client Persistence**: Do NOT shut down the Langfuse client on every prompt.
- **Flushing**: Use `flushClient()` to ensure data is sent before the process exits.
- **Clean Finalization**: Use `finalizePrompt()` to cleanly close any abandoned or open spans (especially during interruptions or config reloads).

## Committed Examples

- **Real identities**: When writing docs, plans, or test fixtures from real traces or sessions, replace home paths, user names, and private repository names with placeholders (`/home/<user>`, `<owner>/<repo>`). `package.json` keeps `docs/plans/` out of the npm package, but a push publishes it on GitHub.
