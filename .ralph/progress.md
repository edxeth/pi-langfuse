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
