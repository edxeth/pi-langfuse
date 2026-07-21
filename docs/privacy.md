# Privacy and capture

pi-langfuse sanitizes values before Langfuse observations, REST fallback batches, raw-trace writes, and operator test traces. Pi's own session files remain unchanged.

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

Set `PI_LANGFUSE_REDACTION_SECRETS` for additional literal values. Set `PI_LANGFUSE_UNREDACTED=1` only for local debugging. The opt-out affects live telemetry and raw traces, not exports.

The export pipeline forces redaction and replaces absolute source paths with `[PATH_ROOT]`. It does not modify source session files or old raw traces.

## Data handling

Redaction does not remove ordinary business content. Treat raw traces and Langfuse data as private. Review redacted derivatives before sharing or using them for training.
