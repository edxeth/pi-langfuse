# Extension settings integration best practices

Version 2.0 requires Node.js 22 or newer. The extension integrates with `@axnic/pi-extension-settings` through its event protocol instead of importing the SDK runtime.

## Why this approach

For this extension, the direct event protocol is the most robust integration strategy:

- it matches how several working extensions in this repository already integrate
- it avoids coupling runtime behavior to SDK packaging details
- it still works with `/extensions:settings`
- it keeps the extension installable on its own

## Recommended pattern

### 1. Register settings via events

Emit `pi-extension-settings:register` with:

- `extension`: a stable extension id
- `nodes`: plain schema-like node objects
- `documentation`: optional markdown shown by the settings UI

Also listen for `pi-extension-settings:ready` and re-register then.

### 2. Keep a stable extension id

Use one stable id, such as:

- `pi-langfuse`

This id is the namespace used in `~/.pi/agent/settings.json` under:

- `extensions:settings.pi-langfuse`

Changing it later will orphan previously saved settings.

### 3. Read values through the event bridge first

Preferred order:

1. ask the dashboard/settings bridge via `extension:settings:get`
2. fall back to reading `~/.pi/agent/settings.json`

This works both with the live settings UI and without it.

### 4. Listen for change events

Handle both:

- `pi-extension-settings:<extension-id>:changed`
- `extension:settings:changed:<extension-id>`

That keeps the extension responsive across the original settings panel and bridge-style integrations.

### 5. Use precedence explicitly

The resolved precedence is:

1. settings panel values
2. `$PI_CODING_AGENT_DIR/langfuse/pi-langfuse.json`
3. `LANGFUSE_*` and `PI_LANGFUSE_*` environment variables
4. built-in defaults

The extension does not load an extension-local `config.json`.

### 6. Be careful with secrets

`pi-extension-settings` stores values in plain text. That means:

- secrets in the panel are convenient
- but environment variables are safer

If you expose secrets anyway, document the trade-off plainly.

## Langfuse-specific recommendations

The settings panel exposes connection fields, trace metadata, capture policies, field overrides, payload budgets, redaction, and raw-trace settings. Empty connection fields display the current fallback value.

On each supported change event the extension recomputes the effective config, finalizes active prompts, flushes pending telemetry, and reconfigures the shared runtime. The runtime remains available to ordinary prompts and shuts down only when no session lease remains.

## What to avoid

Avoid these patterns for this extension:

- runtime imports from a sibling checkout like `../pi-extension-settings/...`
- hard dependency on unpublished local SDK builds
- assuming the settings panel is always installed
- assuming only one settings change event format exists

## Summary

The best practice for this extension is:

- use the event protocol directly
- keep install-time dependencies minimal
- support the settings panel when present
- keep file and environment fallbacks working when it is absent
