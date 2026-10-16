# Generic subagent instrumentation handoff

Date: 2026-10-13

## Goal and authorization

Add generic launch and completion hooks to `~/.pi/agent/extensions/pi-subagents`.
Trusted extensions must be able to pass per-child context and observe completion
without changing global environment variables or adding privileged tool arguments.

The user approved generic hooks, not a Langfuse dependency in `pi-subagents`.
The user currently has other agents changing that repository. Start this task
only after the user releases that checkout for this work. Preserve their changes.
Do not commit, deploy, publish, or write synthetic traces to a persistent project
without separate approval.

This handoff covers the generic launcher interface. The Langfuse consumer belongs
in `pi-langfuse`, not in the launcher. Completing these hooks alone does not
complete trace linkage.

## Read first

1. Read the target repository's current `AGENTS.md`, `GLOSSARY.md`, source, and tests.
2. Inspect `git status` and establish a task-local baseline that includes the
   user's completed changes. Do not reset the checkout to the snapshot below.
3. Read the installed Pi extension documentation and `CHANGELOG.md`. The locked
   SDK and the Pi executable can have different event contracts.
4. Recheck the launch and completion paths below. They are evidence from a
   snapshot, not a substitute for inspecting the current tree.

Snapshot inspected: `pi-subagents` 2.9.2, commit
`f7ee6a4d30540f044a37968c45f74d0a97da1161`; installed Pi 1.2.0.
The `pi-langfuse` baseline was
`945cb84f5b8a105af5154e52b5882b8b89cfea49`, with Pi 0.99.2 locked in its tests.

## Verified constraints

- `src/tools/subagent-call-input.ts` and `src/launch/launch-overrides.ts` strip
  `launchEnv` and `forcedCwd` from model-supplied tool arguments. Keep that boundary.
- `src/launch/prep.ts` already builds trusted per-child environment dictionaries.
  Reuse them rather than inventing another environment transport.
- `src/launch/child-command.ts` and `src/launch/background.ts` use environment
  snapshots. `src/launch/shell-command.ts` uses a private environment capsule for
  interactive launches. Keep context out of shell command strings and logs.
- `src/tools/subagent-batch-launch.ts` already has `launchToolCallId`. The tool-call
  identifier is not a telemetry observation identifier.
- `PI_SUBAGENT_AGENT`, `PI_SUBAGENT_NAME`, and `PI_SUBAGENT_PARENT_SESSION` provide
  some lineage, but no complete telemetry handoff exists in this snapshot.
- Current session files come from `src/session/session-files.ts` and
  `src/launch/runtime-paths.ts`. Do not assume a `subagent-artifacts/` directory.
- Started and completed results contain child/session references, not trace IDs.
  Read `src/runtime/running-registry.ts`, `src/runtime/wait-result.ts`, and
  `src/runtime/result-router.ts` for the actual lifecycle.
- Async launches return before completion. Completion can arrive after the
  parent's prompt ends or another prompt starts.
- Pi's event bus is synchronous. `emit()` does not await promises from listeners.
- Non-UI parents force synchronous execution in the inspected version. A
  headless end-to-end test cannot prove the async path.

## Interface requirements

Use the repository's existing extension conventions. Keep the interface small:
one trusted pre-launch hook and one completion hook. Resolve names and exact
types against the current code, and document the public contract in the target
repository.

### Pre-launch

Emit after privileged tool-input stripping and after stable child/run identity
exists, but before building the final environment snapshot or capsule.

The event must identify the owning parent session, original tool call, child/run,
agent, and launch mode. A trusted extension can contribute a child-specific
environment dictionary. The contribution must not become a new tool argument or
be accepted from the model.

Requirements:

- Allocate independent contribution state for every child, including batch calls.
- Never mutate `process.env`, agent definitions, or another launch's environment.
- Specify merge precedence and invalid-value handling. Do not silently overwrite
  reserved launcher-owned fields.
- A launch with no listener must behave exactly as it does today.
- Specify how listener failures affect launch. Keep failures observable and avoid
  silently binding a child to another parent's context.
- Keep contributed values out of display text, public launch summaries, and shell
  arguments. Existing private environment transport owns their lifetime.
- Do not attempt asynchronous setup through a synchronous event listener.
  Subscribers must prepare context at an earlier awaited lifecycle boundary, or
  the launcher must expose an explicitly awaited interface instead.

Do not add Langfuse imports, `PI_LANGFUSE_*` constants, trace-ID types, vendor
configuration parsing, or telemetry-specific tests to `pi-subagents`.

### Completion

Emit a completion event for the original launch, not for the currently active
parent prompt. Retain the original parent/tool/run association until delivery.

Expose the actual child session reference when one exists, terminal status, and
the original correlation fields. Specify whether events can repeat and how a
subscriber identifies duplicates. Deliver before deleting resources a subscriber
needs to inspect, or provide a documented durable alternative.

Cover successful completion, cancellation, failed launch, partial batch launch,
and a child that produces no persisted session. Do not invent a session reference
or require child telemetry to be enabled.

Resume support needs explicit inspection: the snapshot's
`src/tools/resume-tool.ts` discards the resume call's tool-call ID. If this work
does not cover resume, document that limit and leave resume behavior unchanged.

## Later pi-langfuse integration

The consumer must map the generic interface to its own tracing model:

- One trace per prompt, including each child prompt. Do not reuse the parent trace
  as the child's trace or collapse all child prompts into one trace.
- Pass the parent trace ID, actual Langfuse tool observation ID, separate model
  tool-call ID, and exact parent telemetry session ID. Preserve physical child
  session ownership while grouping its telemetry with the parent session.
- Resolve parent context by original owning session and tool call. Never use the
  latest active prompt as a fallback.
- Inherit the parent's identity policy without placing credentials in tool
  arguments, display metadata, or shell command text.
- Keep the handoff optional. Missing or disabled tracing must not prevent child
  execution or create fabricated linkage.
- Record actual child trace IDs through a documented consumer-owned channel.
  Raw trace files alone are insufficient because raw capture can be disabled.
  Preassigned IDs are planned IDs, not proof that a trace was emitted.
- Keep Langfuse-specific child-record parsing in `pi-langfuse`. Any new persisted
  child-session entry or sidecar format needs an explicit contract and tests.

An ended launch span cannot be updated by the current Langfuse adapter. Preserve
its launch/tool duration. Emit a separate completion/link observation for actual
child trace IDs, associated with the original parent trace and launch observation.
Do not reopen the launch span or hold it open for the whole async child run.

This produces cross-trace correlation and shared session grouping. It does not
turn independent traces into a native nested observation tree in the Langfuse UI.

## Acceptance and verification

Use the target repository's existing offline runtime fixtures and test commands.
All spawned children need isolated configuration, sessions, raw output, provider
resources, and telemetry destinations. Use synthetic credentials and loopback
recorders. Do not load the user's global resources for a regression test.

The generic hook tests must prove:

1. With no subscriber, launch arguments, environment behavior, and results retain
   their current meaning.
2. A model cannot inject privileged environment overrides through tool input.
3. Two concurrent parents and a batch of children receive only their own context.
   Reverse their completion order to expose accidental global state.
4. Both background environment snapshots and interactive capsules carry generic
   synthetic extension values without exposing them in display or shell strings.
5. Completion retains the original association after the parent settles or starts
   a replacement prompt. Repeated events do not create duplicate effects.
6. Failed launches, cancellation, partial batches, missing sessions, nested
   launches, and each supported resume mode have defined behavior.
7. The async-capable launch boundary has a real behavior test, separate from a
   headless child-spawn test.

Later integration tests must inspect actual recorder output for parent/child IDs,
session grouping, privacy inheritance, multiple child prompts, and absence of
cross-parent linkage. A successful process exit is not proof of trace linkage.

Finish with the diff, exact verification commands and results, the final public
hook contract, and any remaining integration blockers. Arrange independent
correctness review before reporting the interface ready for the consumer.
