# Privacy and capture

pi-langfuse sanitizes values before Langfuse observations, OTLP exports, raw-trace writes, and operator test traces. Pi's own session files remain unchanged.

## Capture policies

`full-debug` is the compatibility default. It captures the same prompt, provider, assistant, tool, and metadata fields as earlier versions, subject to the configured payload limits and existing redaction.

| Policy | Captured content |
| :--- | :--- |
| `metadata-only` | Structural trace and observation metadata. Content fields are omitted. |
| `prompts-only` | User and system prompts plus metadata. Provider, assistant, and tool content are omitted. |
| `conversations` | Prompt, system, provider input, assistant output, and metadata. Tool input and output are omitted. |
| `full-debug` | Prompt, system, provider input, assistant output, tool input, tool output, and metadata. |

Use `/langfuse-privacy` to inspect the resolved policy or `/langfuse-privacy <policy>` to persist one through the existing settings file.

Fine-grained overrides accept `inherit`, `on`, or `off` for prompt, system prompt, provider input, assistant output, tool input, tool output, and metadata fields.

## Assistant output and reasoning

New `llm-response` and `agent.turn` outputs use a structured object with answer `text`, `tool_calls`, and optional visible `thinking`. Assistant text and thinking follow `captureAssistantOutput`; tool-call arguments follow `captureToolInput` independently. The generation metadata stores only the boolean `hasThinking`, not reasoning text. Prompt-level trace output remains the answer text. Raw `assistant_output` records keep answer-only `text`, optional `thinking`, and `toolCalls` under the same field policies.

Responses `reasoning.summary` content in retained full provider-request copies follows the assistant-output policy. Incoming visible reasoning may also appear as assistant thinking. Responses `reasoning.content` and `encrypted_content`, redacted-thinking payload data, and opaque Google/Pi replay-signature fields are excluded from telemetry copies regardless of policy. The live Pi messages and outgoing provider requests remain unchanged. Summary-mode request previews do not expand reasoning summaries.

## Raw provider-request summaries

Summary mode keeps at most 20 message previews, with a 200-character head per message. The serialized `systemPrompt` and `messagesSummary` fields together stay within 4,096 UTF-8 bytes after redaction and raw-record shaping. The system instruction stays in its own field and is not repeated in `messagesSummary`; omitted messages are counted and marked. This compact summary is diagnostic, not a lossless transcript.

`estimatedBytes` measures only the original recognized provider contents. It excludes separately supplied system instructions and the compact summary itself. Context fallbacks have no wire-size estimate. Empty and tiny inputs are not guaranteed to produce a smaller summary.

## Payload budgets

The extension accepts limits for:

- ordinary string characters;
- tool payload characters;
- nesting depth;
- array items;
- object keys;
- total payload nodes.

Use `unlimited` for an explicit unlimited value. Redaction still runs when a limit is unlimited. Invalid limits use the restrictive resolved fallback rather than disabling shaping.

The policy applies to prompt, system prompt, provider input, assistant output, tool input, tool output, metadata, raw traces, and Langfuse payloads. Structural identifiers and parent fields remain available for trace correlation.

## Redaction

Redaction is enabled by default. The sanitizer covers configured keys, secret-like environment values, configured literal secrets, sensitive object keys, private-key blocks, common bearer and provider tokens, JWTs, `.env` assignments, URL credentials, common PII patterns, data URLs, and large encoded blobs.

PIN and OTP fields use markers such as `[REDACTED:pin]` without fingerprints. Short codes can be recovered from unsalted hashes by enumerating possible values. Redacting existing PIN and OTP markers also removes their fingerprints; other credential fingerprints remain unchanged.

Set `PI_LANGFUSE_REDACTION_SECRETS` for additional literal values. Set `PI_LANGFUSE_UNREDACTED=1` only for local debugging. The opt-out affects live telemetry and raw traces, not exports.

The export pipeline forces redaction and replaces absolute source paths with `[PATH_ROOT]`. It does not modify source session files or old raw traces. Its TruffleHog scan is detection-only (`--no-verification --no-update`), so no candidate credential is ever sent to a vendor.

`--format openai-chat|anthropic-messages|sharegpt` additionally writes local training review records. Their privacy policy is fixed whatever the live settings: redaction on, pseudonymous identity with repository identity hashed, a mandatory completed TruffleHog scan (records are dropped if it is skipped, unavailable, killed, nonzero, or reports findings; `--no-trufflehog` is refused), a salt that must exist before output (an unusable config stops the export), and pseudonymized derivative file names, manifests, and index references. Consent and license are operator declarations, default unknown and empty, never inferred, never verified, and refused if the config holds them with the wrong JSON type; a scanner approval does not establish rights to train on the data. The records are review artifacts, not certified provider-upload-ready datasets, and the export uploads nothing.

## Identity pseudonymization

`identityMode` accepts `raw` (default) or `pseudonymous`. Resolution order is the settings panel, then `pi-langfuse.json`, then `PI_LANGFUSE_IDENTITY`. `identityKeepRepo` (settings `identity-keep-repo`, env `PI_LANGFUSE_IDENTITY_KEEP_REPO`) is `false` unless explicitly `true`. Raw mode keeps the persisted format and every payload as before.

In `pseudonymous` mode, the shared sanitizer behind Langfuse observations, scores, OTLP exports, raw traces, and `/langfuse:export` applies these rules to every emitted string and object key:

| Data | Result |
| :--- | :--- |
| `userId` | Stable salted pseudonym such as `pseudonym-user-<24 hex>` |
| Home directory prefix | `~`, only at directory boundaries (`/home/dev` does not change `/home/developer`) |
| Encoded home in Pi session folder names | `--home-dev-project--` becomes `--~-project--` in `sessionFile`, `sessionRoot`, `previousSessionFile`, and any other text |
| `repo_identity`, `repo_owner`, `repo_name`, `git_remote_path`, `repo_root_name` | Salted pseudonyms, including `.pi-langfuse.metadata.json` overrides, unless `identityKeepRepo` is `true` |
| `project:<name>` tags | `project:` plus a salted pseudonym, unless `identityKeepRepo` is `true` |
| The salt itself | Always replaced by `[REDACTED:identity-salt]`, by key and by literal, even when secret redaction is off |
| Release, environment, and OpenTelemetry resource values stamped outside body shaping | Home-normalized |

An already pseudonymized value is never hashed again, so repeated shaping is stable. The same salt gives the same pseudonyms across sessions; a different salt gives different ones. Internal file lookups keep using the real paths. Identity protection runs even when secret redaction is disabled.

### Salt

The salt is 32 random bytes (64 hex characters) stored as `identitySalt` in the file named by `PI_LANGFUSE_CONFIG`. It is created only when `pseudonymous` mode needs it and never in `raw` mode. Creation preserves existing keys, writes an owner-only temporary file, renames it atomically, and takes a lock so concurrent first runs share one salt. The extension never overwrites a malformed or non-object config file and never regenerates an existing invalid salt. If the file or path cannot be read or written, telemetry, raw traces, and exports stay off and `/langfuse-privacy` explains the problem. An invalid mode or `identityKeepRepo` value is handled the same way and never falls back to raw. A config file that exists but is unreadable also stops telemetry unless the settings panel sets the mode. A configuration reload that fails stops new telemetry; prompts already open keep the data they captured under the earlier policy.

There are no salt rotation or storage options. Deleting the key creates a new salt, which changes every pseudonym. Treat the salt as private: anyone with it can test guesses such as a known username against the hashes.

Salt creation uses a lock file named `<config path>.lock`. A process that finds it waits up to five seconds, then fails closed with the lock path. The extension never removes or takes over an existing lock, because a lock's age does not show that its owner has stopped. If a Pi process was killed while creating the salt, the lock can remain. Confirm that no Pi or pi-langfuse process is running, then delete that file yourself.

`/langfuse-init` does not merge with an existing `pi-langfuse.json`, including one that holds only the salt, and refuses to overwrite it. Run `/langfuse-init` to create the stack before you enable pseudonymous capture. If you enabled it first, add the generated connection settings to the existing file by hand.

### Scope and limits

Pseudonymization reduces direct identifiers. It is not anonymization and does not make a trace safe to publish:

- Paths below the home directory keep their directory and file names, so a project folder name in `cwd` or `sessionFile` remains visible.
- Branch names, commit hashes, remote hosts, code, prompts, tool output, and commit messages can identify a person or repository.
- Another user's home directory, other absolute paths, and the plain username outside the home path are not rewritten.
- Raw trace files keep their local file and directory names on disk, which can contain the encoded username. Export artifacts are renamed (home directory to `~`) only for `--format` exports; a plain export keeps source-relative names.
- Traces already sent or written before you enable the mode are not changed.

### OpenTelemetry resource

In both identity modes the resource carries `service.name=pi-langfuse` and `service.version` from this package's `package.json`. This replaces the SDK default `unknown_service:<node binary path>`, which exposed a local install path.

## Data handling

Redaction does not remove ordinary business content. Treat raw traces and Langfuse data as private. Review redacted derivatives before sharing or using them for training.
