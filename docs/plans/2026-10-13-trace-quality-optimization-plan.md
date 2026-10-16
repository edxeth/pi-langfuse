# pi-langfuse trace-quality optimization plan (2026-10-13)

## Why this plan exists

An X thread (https://x.com/michael_chomsky/status/2109894037176295478) claims
production agent traces, including engineers' Claude Code / Codex sessions,
sell for $40-120 per trace. Replies ask what a "trace" is, whether reasoning
is included, and note that "creating environments from traces is the new
market." Whether or not anyone sells traces, the thread defines the bar for a
high-value trace:

1. Complete: system prompt, every message, every tool call and result,
   reasoning, and the final outcome, with nothing silently dropped or mislabeled.
2. Safe: no secrets, no PII, no identifying paths or usernames, so the data can
   leave the machine.
3. Structured: stable hierarchy, correct input/output on every node, linked
   parent/child (subagent) runs, reproducibility metadata (repo, commit, cwd).
4. Labeled: outcome signals (success, errors, user acceptance) attached as scores.

This plan measures pi-langfuse v2.1.2 against that bar using the live local
Langfuse project (`http://localhost:3100`), raw traces under
`~/.pi/agent/langfuse/raw-traces/`, the source tree, and the Pi session
`2026-10-13T16-30-35-231Z_01a13619-...jsonl` (117 entries, $2.27, 3 prompts).

## Verdict in one paragraph

The hierarchy was sound, but the initial report mixed real defects with missing features and incorrect assumptions. The implementation now separates answer text, visible thinking and tool calls, adds turn inputs, extends redaction, adds opt-in identity protection and explicit feedback, and splits the compatibility suite. Independent review found additional boundary defects that remain under repair. Dataset conversion is not integrated, subagent linkage is deferred, and final quality gates have not passed. This plan does not certify traces as anonymous, complete in every capture mode, or permitted for training or sale.

## Initial evidence summary (reported; corrected by source fact-check)

- The initial report sampled three duplicated records. A later read-only check
  of the referenced raw file found 55 assistant records, 40 with thinking,
  and 36 with equal text and thinking. None had a `toolCalls` field. Source
  confirms a concrete bug:
  when final assistant content has no nonempty text block, the fallback joins
  streaming thinking and text; partial updates also join both streams. The
  existing text extractor itself returns only text blocks. The source does not
  establish that every sampled tool-call response lost its visible answer.
- The initial report described both `agent.turn` fields as null. Source
  fact-check confirms turn input was not populated, but turn output was
  already set from finalized assistant text. A tool-call-only response can
  have no visible answer text; the correction adds the structured response
  projection and newly delivered turn input rather than treating every output
  as absent.
- Trace `metadata.sessionFile` and `metadata.cwd` are absolute
  `/home/<user>/...` paths; `userId` is the OS user name (`$USER`);
  `metadata.repo_identity` is the `<owner>/<repo>` of a private repository;
  `metadata.resourceAttributes["service.name"]` is
  `unknown_service:/home/<user>/.local/share/fnm/node-versions/<version>/installation/bin/node`.
  One 3.3 MB raw trace contains 1001 occurrences of the home directory path.
- The inspected pi-subagents 2.9.2 snapshot had no trusted telemetry handoff.
  It uses generated session files, not the older `subagent-artifacts/` layout.
  Independent child traces therefore lacked parent correlation.
- `~/.pi/agent/langfuse/raw-traces/` holds 314 project directories; 158 match
  `--tmp*`, `e[0-9]*`, `auto`, `down`, `floating`. Names alone do not establish
  test ownership. The initial 11,811-file count is historical, not a current
  inventory. The list-only inventory later found 3,812 JSONL files within the
  158 candidate directories.
- An earlier raw-file inspection reported `estimatedBytes` 14,155 and
  `messagesSummary` 34,242 characters. The estimate counts serialized
  captured contents in bytes; the displayed summary count is characters and
  the separately supplied system instruction is stored outside that metric.
  These values have different scopes and units, so they do not prove the
  summary exceeded the request in bytes. The raw summary still needs a compact
  preview and an explicit serialized-size bound.
- Generation `input` uses the existing general summarizer, not a guaranteed
  lossless provider transcript. The live check showed function-call-output
  placeholders there; full tool content was present in turn input and tool
  spans. Full raw provider capture is a separate option.
- Provider response headers already pass through a finite, lowercase-normalized
  allowlist with primitive values capped at 200 characters. The assigned change
  adds compatibility coverage for mixed-case allowed headers, `set-cookie`,
  and `authorization`; it does not replace or broaden that allowlist.
- Redaction patterns cover: private keys, Bearer, GitHub, HF, Anthropic,
  Langfuse, Stripe, SendGrid, Docker, Slack webhook, OpenAI, AWS access key,
  JWT, URL credentials, data URLs, long base64/hex, email, phone, SSN, Luhn
  credit card, plus key-name assignment scanning for
  secret/password/authorization/cookie/credential/private_key/api_key/access_key/refresh_token/client_secret/webhook_secret
  and `*token` keys. Not covered: Google `AIza`, Slack `xox[abps]-`, GitLab
  `glpat-`, npm `npm_`, Groq `gsk_`, xAI `xai-`, DigitalOcean `dop_v1_`,
  Vercel, Cloudflare, Telegram bot, Discord, Shopify `shpat_`, Twilio, and
  key names ending in `_KEY`/`_PASSPHRASE`/`_PIN` without the listed words
  (`SIGNING_KEY=`, `ENCRYPTION_KEY=`, `MASTER_KEY=`, `LICENSE_KEY=`).
- Structured full provider-request copies currently exclude Responses
  `reasoning.summary`, `reasoning.content`, and `encrypted_content`.
  Incoming Responses summaries may already be normalized as assistant thinking.
  The assigned change allows only `reasoning.summary` under assistant-output
  policy; encrypted/replay payloads and the shared summary-mode marker remain
  excluded.
- Session reader: `ask_user` waited 3 minutes (16:32:33 to 16:35:33). That
  wait lands inside a `tool:ask_user` span and inflates turn/prompt latency
  with no marker that a human was in the loop.
- Scores exist (`tool_call_count`, `turn_count`, `total_tool_errors`,
  `tool_success_rate`, `session_had_errors`, plus per-generation scores in
  `generation-lifecycle.ts`). No task-outcome or user-feedback score exists.

## Work items (ordered by value; each is one worker task)

Tier: full (behavior contract) unless marked light. Verify with
`RUN_LANGFUSE_E2E=0 npm test`, `npx biome check .`, and `npm run typecheck`
if present. Before any live check, pin an isolated config
(see AGENTS.md "Telemetry test isolation"); never write to the persistent
project without approval.

### P0-1 Fix reasoning-as-answer corruption in generation output and raw `assistant_output`

Files: `src/generation-lifecycle.ts`, `src/lifecycle-types.ts`,
`src/telemetry-helpers.ts`, `src/payload-policy.ts`,
`src/generation-lifecycle.test.ts`, `src/payload-policy.test.ts`,
`src/compatibility.test.ts`, and the isolated real-Pi runtime scenario.

Acceptance:
- Generation and turn outputs use `{ text, tool_calls: [{id,name,arguments}], thinking? }`.
  Text comes only from final text blocks or the streaming text fallback.
  Final visible thinking is preferred over streamed thinking. Never persist
  opaque replay signatures.
- Raw `assistant_output` keeps answer-only `text`, optional `thinking`, and
  adds `toolCalls`. `metadata.hasThinking` is boolean; no thinking content is
  stored in generation metadata. Do not assert that text and thinking differ
  by value; independent streams can legitimately be equal.
- Prompt/trace final output remains an answer-only string. Do not mutate Pi's
  messages or outgoing provider payloads. Tool-call arguments follow
  `captureToolInput` independently from text/thinking under
  `captureAssistantOutput`; the raw structural `toolCalls` count must not
  bypass that policy when the key carries an array.
- Cover text-only, mixed text/thinking/tool calls, missing final text with
  streamed text fallback, final thinking without deltas in raw-only mode,
  partial/abandoned output, redaction and policy overrides, and correlated
  tool-call IDs. Use the isolated real-Pi event fixture for integration; the
  HTTP recorder is not a Pi event fixture.

### P0-2 Identity pseudonymization option (paths, username, repo identity, service name)

Files: `src/identity.ts`, `src/identity-salt.ts`, `src/redaction.ts`,
`src/payload-policy.ts`, `src/langfuse-client.ts`, `src/package-version.ts`,
configuration/settings, raw/export boundaries, tests, and privacy documentation.

Acceptance:
- New config `identityMode: "raw" | "pseudonymous"` (env
  `PI_LANGFUSE_IDENTITY=pseudonymous`). Default stays `raw` to preserve the
  persisted format; document the trade-off.
- In `pseudonymous` mode: `userId` becomes a stable salted hash (salt stored
  in `pi-langfuse.json`); `$HOME` prefix in every string field becomes `~`;
  `sessionFile`, `cwd`, `sessionRoot`, `previousSessionFile` are
  home-relative; `repo_identity`/`repo_owner`/`repo_name`/`git_remote_path`
  become hashes unless `identityKeepRepo: true`.
- OTel resource always sets `service.name=pi-langfuse` and
  `service.version=<package.json version>` (both modes). This is the only
  change that is unconditional; it fixes the leaked node binary path.
- Tests: the 1001 `/home/<user>` occurrences in a fixture reduce to zero in
  pseudonymous mode. The identity transformation is a no-op in raw mode;
  the explicitly unconditional resource attributes and other approved schema
  changes are separate contracts.
- Invalid configuration or salt persistence fails closed. Salt creation keeps
  existing keys, uses private permissions and atomic replacement, and shares
  one salt across concurrent first use. A lock's age does not prove that its
  owner is dead; an unresolved lock causes a bounded failure, not takeover.
- Known repository metadata and project tags are hashed unless retained by
  configuration. Relative path names, code, commits and other business content
  can still identify a project. Pseudonymization is not anonymity.

### P0-3 Stop test runs from writing into the real raw-trace and session directories

Files: `test/setup.ts`, `test/pi-runtime/isolated-pi.ts`, affected environment
resets, retained timeout/lifecycle regressions and their owned fixtures.

Acceptance:
- Pin temporary HOME, agent, config, session and raw paths plus synthetic
  loopback credentials before test-module imports. Keep that environment for
  the worker's whole lifetime, including late callbacks after a timeout.
- Own runtime startup before its first await. Keep the lease, environment and
  resources until all tracked session work settles, including prompt preflight
  and a tool that ignores abort. A close timeout bounds the caller's wait; it
  does not release ownership or allow a new case to start.
- Prove the old escape and the repair with an owned fake original home and
  backend canary. A shared-directory census cannot attribute concurrent real
  session writes; the random-marker check is only a tripwire.
- `scripts/inventory-raw-trace-candidates.mjs` lists name-pattern candidates.
  It has no deletion mode. Existing data, including the incident artifact
  below, stays untouched without explicit approval and ownership review.
- Document the invariant in AGENTS.md under "Telemetry test isolation".

### P1-1 Link subagent runs to the parent trace

Deferred by the user because other agents are changing pi-subagents. No
companion-extension files were changed. The approved direction is generic
trusted launch/completion hooks, with all Langfuse-specific behavior kept in
pi-langfuse. See `2026-10-13-subagent-tracing-handoff.md` for the self-contained
handoff and start gate.

The handoff distinguishes the model tool-call ID from the Langfuse observation
ID, preserves physical child-session ownership, and groups telemetry under the
parent session. Async completion needs a separate link observation: an ended
launch span cannot be reopened to add eventual child trace IDs. Do not mutate
global process environment or trust privileged launch fields from tool input.

### P1-2 Populate `agent.turn` span input/output

Files: `src/generation-lifecycle.ts`, `src/turn-lifecycle.ts`,
`src/lifecycle-types.ts`, `src/payload-policy.ts`, and lifecycle/policy tests.

Acceptance: `agent.turn.input` contains only newly delivered non-assistant
messages accumulated for that turn at the provider-request boundary: the
initial user/custom/steering messages and prior tool results. Do not infer the
delta by slicing full context; retries, transforms, and compaction make that
invalid, and current-turn tool results must remain input to the next turn.
Shape system, user, assistant/custom, and tool-result content by role and
capture policy, including overrides. Do not assume every run has a user prompt.
`agent.turn.output` uses the structured assistant output from P0-1. Trace-level
input/output remain prompt and final-answer strings.

### P1-3 Capture Responses reasoning summaries; keep encrypted reasoning excluded

Files: `src/payload-policy.ts`, `src/payload-policy.test.ts`, and
`docs/privacy.md`.

Acceptance: In retained structured full request/replay copies,
`reasoning.summary` follows `captureAssistantOutput`; this does not change
incoming thinking capture or the default summary-mode reasoning marker.
Continue excluding `reasoning.content`, `encrypted_content`, and
`redacted_thinking.data`. Strip Google `thoughtSignature` and its Pi replay
wrappers (`textSignature`, `thinkingSignature`) from telemetry copies even
when redaction is disabled. Never mutate live messages or provider requests.
Document the actual source behavior and the privacy contract.

### P1-4 Extend secret patterns and key-name heuristics

Files: `src/redaction.ts` (`SECRET_PATTERNS`, `SENSITIVE_KEY_PATTERN`,
`SENSITIVE_WORD_TEST`), `src/redaction.test.ts`, `src/export.ts` residual
scanner if it has its own list.

Acceptance: add Google `AIza[0-9A-Za-z_-]{35}`, Slack `xox[abps]-`, GitLab
`glpat-`, npm `npm_`, Groq `gsk_`, xAI `xai-`, DigitalOcean `dop_v1_`,
Shopify `shpat_`, Telegram `\d{8,10}:AA[A-Za-z0-9_-]{33}`, Discord bot token;
treat key names ending in `_key`, `passphrase`, `pin`, `otp`, `signing_key`,
`encryption_key`, `master_key`, `license_key` as sensitive while keeping
`public_key` and token-count keys exempt. Each pattern gets a positive and
a near-miss negative test. Run the existing quadratic-input performance test
to confirm no regression.

### P1-5 Compact `provider_request` summaries without changing generation inputs

Files: `src/telemetry-helpers.ts`, `src/generation-lifecycle.ts`,
`src/raw-trace.ts`, and summary/raw-trace tests.

Acceptance: Summary mode uses a raw-summary-only path. Bound each message head
to 200 characters, keep a bounded message window, and cap the combined
serialized UTF-8 size of the separately stored `systemPrompt` and
`messagesSummary` at 4,096 bytes after redaction and raw-record shaping.
Keep a separate system instruction outside `messagesSummary`; include omitted
counts. `estimatedBytes` continues to measure only original captured provider
contents, not the system instruction or preview. A context fallback has no
wire estimate; empty/tiny input need not be strictly smaller. Prove bounded
size for Unicode and redaction-expanded content, all recognized provider
shapes and context fallback, and a reduction for 55 long messages compared to
that same captured-contents measure. Preserve full-mode capture and the general
generation-input summarizer.

### P2-1 Explicit feedback and observed operational metrics

Files: `src/index.ts` (new `/langfuse-score` command), `src/agent-lifecycle.ts`.

Acceptance: `/langfuse-score <good|bad> [comment]` writes a BOOLEAN
`user_feedback` score (1 or 0) to the invoking session's last finalized trace.
Reject a missing target or changed destination. Report success only after the
endpoint accepts the score. Reject oversized comments, redact accepted text
before whitespace changes or truncation, and preserve identity protection.

Automatic scores use precise names: `last_tool_is_error`,
`edit_write_call_count`, and `ask_user_wait_ms`. The first follows transcript
order, the second counts attempts once per tool-call ID, and the third measures
correlated pi-ask dialog intervals with overlap counted once. Missing or invalid
timestamps stay unknown, not receipt-time estimates. Ambiguous cross-session
ownership suppresses a measured score. These signals do not prove task success,
file changes, human participation, or user acceptance.

### P2-2 Training export format options

Files: `src/export.ts`, `src/export-cli.ts`, `src/export.test.ts`, README
"Export pipeline".

Acceptance: `--format openai-chat | anthropic-messages | sharegpt` writes local
review records to `training-index.<format>.jsonl`. Nothing is uploaded or
trained. Consent defaults to unknown and license to empty, with warnings;
neither is inferred from scanner results. Present malformed declarations and
an explicit denial are errors.

Use one completed generation's observed full context plus its final answer.
Require capture provenance and validate actual content, tool pairing, final
stop reason and unambiguous request association. Reject legacy, clipped,
policy-omitted, unsupported, incomplete-history and server-context-dependent
records rather than inventing missing data. Do not reconstruct Pi session trees
or fetch missing server-side context.

OpenAI and Anthropic forms preserve tool calls/results according to their
documented schemas. ShareGPT is text-only and rejects tool-containing samples;
there is no canonical ShareGPT tool-call schema. Document format omissions.

Force redaction and pseudonymous identity without repository retention for
format exports, including derivative names and references. Require a completed,
successful detection-only external scan for accepted format records. A skipped,
missing, failed or signaled scanner cannot approve them. Preserve the legacy
no-format policy separately. Source files are never rewritten.

### P2-3 Provider response header allowlist regression

Files: `src/compatibility.test.ts` (extend the existing registered-handler case).

The implementation already uses a finite allowlist, normalizes header names to
lowercase, accepts only string/number values, and caps values at 200 characters.
Do not replace it with a wildcard or shrink existing allowed diagnostics.

Acceptance: Add `Set-Cookie` and mixed-case allowed headers to the existing
test while preserving assertions for `content-type`, `x-request-id`, and
`authorization`. Verify `set-cookie` and `authorization` are absent.

### P3-1 Split the compatibility contract suite

Light tier. The current pre-split file had 5,639 lines after the capture changes.
It now has a 426-line driver, ten scenario registration modules and shared
fixtures under `test/pi-runtime/`. Independent validation preserved all 35 full
test names, their order and 305 assertions. Two cases include the three explicit
feedback command/subscription expectations; those are feature changes, not
relocation loss. Real-SDK server-mode tests were already separate.

## Implementation status (2026-10-15)

| Item | Current state |
| :--- | :--- |
| P0-1 | Implemented; offline regressions and earlier live Pi cases passed. |
| P0-2 | Implemented and independently reviewed, including exact-secret/identity ordering. |
| P0-3 | Lifetime and lease repair independently approved after the incident below. |
| P1-1 | Deferred by user; generic-hook handoff written, no linkage implementation. |
| P1-2 | Implemented and reviewed, including the excluded tool-details boundary. |
| P1-3 | Implemented with policy and opaque-signature regressions. |
| P1-4 | Implemented and reviewed. The 2026-10-15 scanner repairs are below. |
| P1-5 | Implemented and reviewed, including the post-shaping size bound. |
| P2-1 | Implemented and reviewed, including staggered cross-session flows. |
| P2-2 | Integrated and reviewed. |
| P2-3 | Existing allowlist retained and regression coverage strengthened. |
| P3-1 | Split independently validated. |

### Secret-scanner repairs (2026-10-15)

The shared assignment scanner (`scanSecretAssignments` in `src/redaction.ts`,
used by telemetry redaction and the export residual scan) had fail-open gaps.
All were fixed test-first and closed by independent review:

- A key that reuses the closing quote of the previous value
  (`"password":"a"token":"b"`) was not scanned.
- Text after any quote was treated as one key candidate and skipped, so
  assignments in prose, after JSON, or inside JSON string values were missed
  (`it's fine password=...`). Failed candidates are now scanned as text.
- A bare word after a sensitive quoted key (`"password": hunter2`) was kept.
- A value that ends in an escaped backslash (`{"password":"a\\","note":"x"}`)
  was mis-delimited.

Known limitations, all fail closed or documented in the source:

- When the quote after an assignment could either close the enclosing string
  or open the value, the text is omitted unless the rest of the stretch is
  only JSON punctuation, numbers and literals. So a string that ends with an
  assignment and is followed by prose on the same stretch
  (`{"msg":"Enter password:"} done`) is omitted, and a value made only of
  such tokens (`", 1234"`) reads as no value.
- An assignment inside a string whose quoted value never closes
  (`{"note":"secret='abc"}`) omits the whole text.
- Export rejects some redacted files whose marker is followed by a quote
  (`'token=[REDACTED:...]'"`), because the residual scan keeps its strict
  marker rule.
- Unchanged gaps: a key directly after a serialized `\n` (`\ntoken: x`), a
  string used both as a value and a key (`"password":"password":"x"`), and
  array or object values of sensitive keys inside free text.

Final-tree verification (2026-10-15): typecheck, Biome and the offline suite
pass (1,240 passed, 1 credentialed E2E skipped). The fresh mutation gate on
the final production code covers 428 functions at full line and branch
coverage and 2,099 mutants: 1,975 killed, 73 timed out, 51 waived with
reviewed arguments, 0 survived (the last survivor was killed by a new test and
confirmed by a fresh gate of `src/agent-lifecycle.ts`).
The package smoke passed after the user approved rebuilding `dist/`, which
the installed Pi loads. The locked test copy of
`@earendil-works/pi-coding-agent` moved from 0.99.2 to 1.3.0, which removed
the `brace-expansion` audit finding; `before_agent_start` handling now checks
for a `prompt` field, so custom-message runs (Pi 1.2.0 and later) and older Pi
both work. A scoped `overrides` entry moves `release-it` to `undici` 6.29.1.
`npm audit --omit=dev` and `audit:production` both report 0. The OTLP exporter now runs at most four exports at once and sends
spans that wait as one coalesced export, so a burst of ended spans no longer
opens one request per span and misses deadlines under host load.

## Execution boundaries

Use one writer per checkout. The original suggested parallel groups were not
disjoint: capture/header work shares `generation-lifecycle.ts`, and several
items share serializers and compatibility tests. Parallel work uses separate
checkouts, explicit baselines and inspected integration diffs.

Review combined changes before quality gates. Keep test destinations isolated,
retain failure evidence, and use bounded runner concurrency on a loaded host
without skipping tests or increasing existing deadlines to hide failures.

## Recorded test-isolation incident

An export scratch test timed out during Pi startup. Its abandoned continuation
ran after the old setup restored the real environment and wrote two synthetic
records into the real raw-trace directory. The file remains untouched:
`~/.pi/agent/langfuse/raw-traces/--unknown--/2026-10-14T08-37-01-845Z_01a1398e-cb10-7351-b063-06da7358e0ee.jsonl`.

The owner stopped runtime verification and reported the incident. Read-only
queries found no matching trace or observations in the configured local project;
the score query timed out, so score ingestion remains unverified. No deletion
is approved. The retained canary tests reproduce the old escape only into owned
fake resources. Independent real-SDK probes confirmed that the repaired lease
holds its environment through pending prompt preflight and abort-ignoring work.

The separate Docker maintenance request is complete: the four dependency
services use 30-second steady-state checks and two-second startup checks. They
were healthy, each produced two exec starts during the measured minute, and the
web health endpoint answered. No other Compose project was changed.

## Remaining uncertainties

- Installed Pi 1.2.0 with `openai-cpa/gpt-6-luna` passed two isolated normal
  runs against a loopback recorder, including hierarchy, exact tool-call IDs,
  final text, turn inputs, usage and package service identity. The provider
  emitted no thinking. Errors, retries, compaction and custom-message runs were
  not covered by those live runs, and they were not final-tree checks.
- The live pseudonymous case removed its configured temporary HOME, not the
  real installation's documentation paths. It does not establish a real-HOME
  live result or Langfuse UI/storage acceptance.
- The companion repository is still user-owned concurrent work. Reinspect its
  current contracts only after the user releases it for the handoff task.
- Pseudonymization, redaction and scanner success do not establish anonymity,
  task success, consent, licensing rights or a market value for the records.
