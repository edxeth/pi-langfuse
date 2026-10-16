# Migration to 2.0

Version 2.x requires Node.js 22 or newer. Starting with version 2.1, Pi 0.87.1 or newer is required, and Pi loads `src/index.ts` for Git and registry installations. The npm API and export CLI still use the compiled `dist` files.

## Install and verify

Use the committed npm lockfile for local and CI installs:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm run verify:release
```

`verify:release` audits the bundled runtime dependency tree with `--omit=dev --omit=peer` and installs the generated tarball into a temporary Pi-compatible fixture without peer auto-installation. The Langfuse OpenTelemetry runtime peers are direct dependencies and remain in the audit. The Pi host peer is not bundled and remains the host project's audit responsibility. The command does not publish, tag, or create a release.

## Configuration

The supported resolution order is:

1. `/extensions:settings` values from the settings bridge
2. `$PI_CODING_AGENT_DIR/langfuse/pi-langfuse.json`
3. `LANGFUSE_*` and `PI_LANGFUSE_*` environment variables
4. Built-in defaults

The extension does not load an extension-local `config.json`. Move values from that file into `pi-langfuse.json`, the settings panel, or environment variables.

Existing setting names and command names remain available. Version 2.0 adds capture policies, payload budgets, `/langfuse-status`, `/langfuse-test`, and `/langfuse-privacy`.

## Runtime and trace data

The runtime now uses Langfuse v5 and OpenTelemetry behind the local facade. Trace names and parent relationships remain unchanged:

```text
pi-agent
└── agent.prompt
    └── agent.turn
        ├── llm-response
        └── tool:<name>
```

Existing raw-trace JSONL files and export inputs remain readable. New payload policies apply to new Langfuse and raw-trace writes. Export redaction remains enabled independently of live capture settings.

### Structured assistant output

New `llm-response` generation and `agent.turn` span outputs are objects of the form `{ text, tool_calls, thinking? }`, rather than plain strings. `text` contains answer text only. Tool-call arguments use the independent tool-input capture policy. Visible thinking is optional and policy-controlled; generation metadata uses `hasThinking` instead of a `thinking` content field. Prompt-level trace output remains a plain answer string.

Raw `assistant_output` JSONL records keep answer-only `text` and add `toolCalls`; they may also include visible `thinking`. Existing raw records remain readable, but consumers that assume new Langfuse generation or turn outputs are strings must read the object's `text` field and handle `tool_calls`. A tool-only response may have empty `text` with non-empty `tool_calls`.

## Local self-hosting

Existing generated Langfuse Server v3 Compose files, credentials, and volumes remain in place. Do not run init in a directory that contains user files. Version 2.0 does not recreate databases or migrate volumes.

See [self-hosting](./self-hosting.md) for local and remote setup details.

## Node.js upgrade

Upgrade the runtime before starting Pi with version 2.0. No Pi session-file migration is required. Keep the existing `$PI_CODING_AGENT_DIR` directory and verify one local prompt before enabling a remote endpoint.
