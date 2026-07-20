Iteration start: selected the first unfinished item because the plan prioritizes executable compatibility contracts before structural changes. I will treat the existing registered extension test harness and its local fakes as the compatibility boundary; no remote reference repository is needed unless local evidence shows a missing contract.

## Handoff 2026-07-20

Selected item: The current user-facing compatibility contract is captured by executable regression tests before structural changes begin.

Decision rationale and assumptions: This was the first unfinished item in the plan's risk order. The test harness treats `registerExtension` plus registered Pi events and commands as the public boundary. A local fake replaces only the unavailable Langfuse SDK transport; the extension, configuration, settings, raw-trace, export, init, and packaging paths run unchanged. No remote repository or credentials were needed.

Changed files:
- `src/compatibility.test.ts`: added registered-path coverage for trace hierarchy and trace IDs, usage and cost, source precedence, settings refresh events, commands, raw records, redaction, local init, export, mutation sensitivity, and an isolated compiled-entrypoint fixture.
- `.ralph/items.json`: marked this item passing and recorded its regression coverage.
- `.ralph/progress.md`: recorded the iteration assumption and this handoff.

Targeted results:
- Baseline: `npm test -- --run src/index.test.ts src/config.test.ts src/settings.test.ts src/raw-trace.test.ts src/export.test.ts src/local-init.test.ts src/redaction.test.ts src/langfuse-client.test.ts` passed 49 tests in 8 files.
- Final compatibility suite: `npm test -- --run src/compatibility.test.ts` passed 4 tests.
- `npm run typecheck -- --pretty false` passed.
- `npx biome check src/compatibility.test.ts` passed.
- A deliberate trace-ID mutation failed the compatibility suite, and a deliberate file/environment precedence mutation failed the source-precedence case.
- Running the compatibility suite with the ignored worktree `dist/` moved aside passed because the entrypoint test builds and loads an isolated temporary package fixture.

GLM review findings and disposition:
- The clean-checkout `dist/index.js` dependency was supported and fixed by compiling the package into a temporary ESM fixture, linking only local dependencies, and importing that fixture.
- No other material GLM finding remained.

GPT Sol review findings and disposition:
- The clean-checkout compiled-entrypoint finding was supported and fixed with the isolated fixture.
- Missing observation trace-ID assertions were supported and fixed; every captured observation is checked against the trace ID.
- File/environment/default source precedence was supported and fixed with separate registered settings cases. The requested extension `config.json` tier was rejected as inapplicable to this baseline capture: starting `src/config.ts` has no extension-config loader, and adding a new source would change behavior outside this test-only item. This remains a risk for a later compatibility decision.
- No-op settings-change callbacks were supported and fixed by invoking both registered callbacks and awaiting their re-registration output.
- Missing stable raw-record fields were supported and fixed with normalized assertions for session, prompt, provider, tool, assistant, compaction, and shutdown records.

Verification gates:
- `node -e "const major = Number(process.versions.node.split('.')[0]); if (major < 22) { console.error('Node.js 22+ required'); process.exit(1); }"` passed.
- `npx biome check .` passed.
- `npm run typecheck` passed.
- `npm test` passed with 53 tests and 1 credential-gated E2E test skipped.
- `npm run build` passed.
- `npm pack --dry-run` passed and listed `dist/index.js`, declarations, maps, and `package.json` in the package.

Item-specific evidence: The local registered-event integration exercised session start, model selection, prompt, turn, context, provider request, tool, streaming assistant, usage/cost scoring, compaction, finalization, shutdown, raw JSONL flushing, command handlers, redacted export, local Langfuse Server v3 Compose output, and compiled package loading. The external credentialed E2E remained skipped because credentials were unavailable; the real local extension path was covered without paid services. No dependency audit was named by this item.

Remaining risks: The documented extension `config.json` source is not loaded by the starting implementation and needs an explicit decision in a later item. Credentialed external ingestion remains unverified. The ignored `dist/` output remains generated build state and was not staged.

## Handoff 2026-07-20

Selected item: The package has an explicit Node.js 22+ major-release toolchain contract with a reproducible npm lockfile and non-destructive CI checks.

Starting Git HEAD: `38f44d57b170f85af237b477e6ddc0bd8860d51c`.

Decision rationale and assumptions: The plan prioritizes host and toolchain preconditions before runtime refactors, so this was the first unfinished item. The package remains at version `1.3.3` until the later release item. Existing commands, configuration behavior, Node16 module resolution, strict ESM imports, and the `dist/index.js` entrypoint remain unchanged. The compiler target and library moved to ES2023 because Node.js 22 is the supported runtime. CI follows the current `main` branch. No remote repository or credentials were needed.

Changed files:
- `.github/workflows/ci.yml`: targets `main`, uses Node.js 22, runs `npm ci`, non-mutating `npx biome check .`, typecheck, tests, build, and package dry-run.
- `package.json`: declares Node.js `>=22` and `@types/node` `^22.0.0`.
- `tsconfig.base.json`: changes the target and library from ES2022 to ES2023 while preserving Node16 module resolution and declarations.
- `package-lock.json`: adds an npm lockfile v3 generated from an empty package-only checkout.
- `.ralph/items.json`: marks this item passing and records the verification evidence.
- `.ralph/progress.md`: records this handoff.

Targeted results:
- `npm test -- --run src/compatibility.test.ts` passed 4 tests before review and passed 4 tests after the lockfile repair.
- `npm run typecheck` passed before and after the lockfile repair.
- `npx biome check package.json tsconfig.base.json .github/workflows/ci.yml` passed.
- The Node.js runtime contract passed on local Node.js `v26.0.0`.
- A temporary checkout installed from the replacement lockfile with `npm ci --no-audit --no-fund`; the compatibility suite and typecheck passed there. The archive fixture caused Husky to print `.git can't be found`, but the install exited successfully.

GLM review findings and disposition: GLM reported no material findings. It verified the Node.js metadata, ES2023 compiler settings, CI gates, lockfile consistency, clean install, and compiled entrypoint. It classified the three integrity-free nested `@earendil-works` peer entries as standard behavior from the published package's `hasShrinkwrap` metadata.

GPT Sol review findings and disposition: GPT Sol reported a supported lockfile finding because the initial lockfile omitted `resolved` and `integrity` for 348 registry entries. I regenerated the lockfile from an empty package-only checkout. The replacement pins `resolved` and `integrity` for the concrete registry entries affected by the finding. Clean npm generation retains three nested `@earendil-works` peer entries without direct integrity fields, each under the published peer package's shrinkwrap metadata and with a resolved tarball. The requirement that those nested entries also carry direct integrity fields was rejected as inapplicable after clean-generation evidence. No other GPT Sol finding remained.

Verification gates:
- `node -e "const major = Number(process.versions.node.split('.')[0]); if (major < 22) { console.error('Node.js 22+ required'); process.exit(1); }"` passed.
- `npx biome check .` passed with no fixes applied.
- `npm run typecheck` passed.
- `npm test` passed with 53 tests and 1 credential-gated E2E test skipped.
- `npm run build` passed.
- `npm pack --dry-run` passed and listed `dist/index.js`, declarations, maps, and `package.json` in the 42-file package.

Item-specific evidence: The replacement lockfile has 547 package entries and `npm ci` completed in a clean checkout. The registered compatibility path, configuration, raw traces, export, local setup, redaction, and compiled entrypoint tests passed without runtime changes. No dependency audit was required by this item. The external credentialed E2E remains skipped because credentials are unavailable.

Remaining risks: The exact Node.js 22 patch used by CI was not available locally; local verification used Node.js 26 and the lower-bound gate passed. The lockfile resolves the Pi peer package to a release requiring Node.js `>=22.19.0`; CI's `node-version: 22` uses the current Node 22 patch. Session isolation, lifecycle ownership, privacy policy, telemetry transport, fallback ingestion, and release documentation remain for later items.

## Handoff 2026-07-20

Selected item: Runtime state is isolated by Pi session so overlapping asynchronous sessions cannot contaminate each other.

Starting Git HEAD: `52e30b8897fc91d960e5c20611f8be13d4007007`.

Decision rationale and assumptions: The plan places session ownership immediately after the Node.js and lockfile contract. The implementation uses a `SessionStateOwner` keyed by the persisted session-file path. Unpersisted sessions use the session-manager identity or session ID as the ownership key. Telemetry keeps the existing filename-stem session ID, so the internal Pi session ID does not change trace or raw-record correlation. Direct handler calls without a context resolve only when one local session exists; ambiguous calls do nothing instead of guessing. A process-wide session lease set protects the shared Langfuse client when separate extension runtimes overlap.

Changed files:
- `src/session-state.ts`: added the explicit per-session state owner, compatibility session-ID derivation, and process-wide session leases.
- `src/index.ts`: moved session, model, provider, prompt, counter, observation, raw-trace, finalization, and shutdown state behind the owner; passed Pi context through every lifecycle handler; added post-await ownership checks before vendor observations; kept the shared client alive until the last session lease ends.
- `src/compatibility.test.ts`: added registered-handler coverage for overlapping sessions, realistic Pi session IDs, independent extension runtimes, shared-client lifetime, per-session hierarchy and counters, raw-trace paths, final output, and late-event cleanup.
- `src/index.test.ts`: closes session state in the existing direct-handler tests.
- `.ralph/items.json`: marked only this item passing and recorded its regression coverage.
- `.ralph/progress.md`: recorded this handoff.

Targeted results:
- `npm test -- --run src/compatibility.test.ts src/index.test.ts` passed 15 tests in 2 files.
- `npm run typecheck -- --pretty false` passed.
- `npx biome check src/index.ts src/session-state.ts src/compatibility.test.ts src/index.test.ts` passed.
- `git diff --check HEAD` passed.

GLM review findings and disposition: GLM supported the session-ID compatibility finding and the missing production `getSessionId()` test path. The code now derives the emitted ID from the filename stem, and the overlap test uses filenames whose stems differ from `getSessionId()` values. No other material GLM finding remained.

GPT Sol review findings and disposition: GPT Sol supported the process-global client-lifetime finding. The code now uses process-wide session leases, removes factory-start client shutdown, and shuts down the client only after the last lease. The independent-runtime regression covers one runtime shutting down while another continues. GPT Sol supported the session-ID finding; the filename-stem fix and realistic test cover it. GPT Sol supported stale observation creation after asynchronous client work; ownership checks now run after local autostart and client awaits before trace, span, and generation creation, with a replacement-prompt regression. The report's model/provider reset watch-out was not material for this item because Pi emits model selection again and `before_agent_start` falls back to the context model; no change was needed.

Verification gates:
- `node -e "const major = Number(process.versions.node.split('.')[0]); if (major < 22) { console.error('Node.js 22+ required'); process.exit(1); }"` passed.
- `npx biome check .` passed with no fixes applied.
- `npm run typecheck` passed.
- `npm test` passed with 56 tests and 1 credential-gated E2E test skipped.
- `npm run build` passed.
- `npm pack --dry-run` passed and listed `dist/index.js`, declarations, maps, `dist/session-state.js`, and `package.json`.

Item-specific evidence: The registered extension harness interleaved prompt, turn, context, provider, generation, tool, model-select, compaction, agent-end, and shutdown events for two sessions. It asserted trace IDs, parent observation IDs, model/provider metadata, usage counters, tool errors, compact counts, final output, raw JSONL session paths, and cleanup after shutdown. A second regression registered two extension instances and confirmed that one shutdown did not close the shared client needed by the other. The package dry-run included the compiled session-state module and retained the `dist/index.js` entrypoint. No dependency audit was required by this item. The credentialed external E2E remained skipped because credentials were unavailable; local registered-handler coverage exercised the real extension path without paid services.

Remaining risks: Duplicate and out-of-order lifecycle idempotency, modular handler extraction, the Langfuse v5 and OpenTelemetry facade, privacy budgets, fallback ingestion, additive telemetry, operator commands, and release documentation remain for later items. Client replacement across independently configured runtimes still belongs to the later runtime integration work. Credentialed external ingestion remains unverified.

## Handoff 2026-07-20

Selected item: Agent and turn lifecycle behavior is moved behind explicit handler boundaries without changing emitted trace behavior.

Starting Git HEAD: `542d33aa08cea7308f2f50da157236f34b4a0053`.

Decision rationale and assumptions: The plan prioritizes lifecycle seams after the Node.js toolchain and session ownership contracts. I moved prompt start, prompt finalization, agent start/end, and turn start/end into lifecycle-owned modules. The entrypoint still registers commands and events, creates session state, and supplies explicit dependencies. Shared formatting, raw-trace, tag, usage, and state types moved into internal modules because both the remaining event handlers and the new lifecycle handlers use them. Handler registration order remains unchanged. No remote reference or credentials were needed.

Changed files:
- `src/index.ts`: wires lifecycle handlers and retains command, settings, session, tool, context, generation, and provider registration.
- `src/agent-lifecycle.ts`: owns prompt creation, prompt finalization, agent start, and agent end behavior.
- `src/turn-lifecycle.ts`: owns turn start and turn end behavior.
- `src/telemetry-helpers.ts`: owns shared telemetry shaping, raw-trace, tag, and usage helpers.
- `src/lifecycle-types.ts`: owns shared prompt, turn, tool, and usage types.
- `.ralph/items.json`: marked the selected item passing and recorded its evidence.
- `.ralph/progress.md`: recorded this handoff.

Targeted results:
- `npm run typecheck` passed after implementation and after the review fix.
- `npm test -- --run src/compatibility.test.ts src/index.test.ts` passed 15 tests in 2 files after the review fix.
- `npx biome check src/index.ts src/agent-lifecycle.ts src/turn-lifecycle.ts src/telemetry-helpers.ts src/lifecycle-types.ts` passed with no fixes applied after the review fix.
- `git diff --check HEAD` passed.

GLM review findings and disposition: GLM reported one supported P1 finding. Biome import organization failed in `src/index.ts`, `src/agent-lifecycle.ts`, `src/turn-lifecycle.ts`, and `src/telemetry-helpers.ts`. I applied Biome's safe organize-imports fix to the five selected source files. The targeted check and the full Biome gate passed afterward. GLM reported no other material finding.

GPT Sol review findings and disposition: GPT Sol reported the same supported P1 import-organization finding and no lifecycle, concurrency, compatibility, redaction, packaging, or test gap. I applied the same safe fix and reran the targeted and full checks. No other material finding remained.

Verification gates:
- `node -e "const major = Number(process.versions.node.split('.')[0]); if (major < 22) { console.error('Node.js 22+ required'); process.exit(1); }"` passed.
- `npx biome check .` passed with no fixes applied.
- `npm run typecheck` passed.
- `npm test` passed with 56 tests and 1 credential-gated E2E test skipped.
- `npm run build` passed.
- `npm pack --dry-run` passed. The package listed `dist/index.js`, the lifecycle modules, declarations, maps, and `package.json` across 62 files.

Item-specific evidence: The existing registered extension compatibility harness exercised the public event path through prompt start, agent start, turn start/end, generation, tools, agent end, compaction, shutdown, settings refresh, raw traces, redaction, and compiled entrypoint loading. It asserted the existing `pi-agent`, `agent.prompt`, `agent.turn`, `llm-response`, and `tool:<name>` hierarchy, parent IDs, tags, trace I/O, usage and cost fields, compact metadata, raw records, and cleanup. No dependency audit was required by this item. The credentialed external E2E remained skipped because credentials were unavailable; local registered-handler coverage did not require them.

Remaining risks: Generation and tool handler extraction, duplicate and out-of-order lifecycle idempotency, Langfuse v5 and OpenTelemetry transport, privacy budgets, fallback ingestion, additive telemetry, operator commands, and release documentation remain for later items. Credentialed external ingestion remains unverified.
