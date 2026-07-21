# Self-hosting Langfuse

pi-langfuse supports a local Langfuse Server v3 stack managed by Docker Compose. Node.js 22 or newer is required for the extension.

## Local setup

Run this command inside Pi:

```text
/langfuse-init --yes --local
```

The command creates `$PI_CODING_AGENT_DIR/langfuse/` with:

- `docker-compose.yml` for Langfuse web, worker, Postgres, ClickHouse, Redis, and MinIO;
- `.env` with generated database, storage, and Langfuse initialization secrets;
- `pi-langfuse.json` with the generated project keys and local host.

The generated services bind their published ports to localhost. The generated `.env` file uses mode `0600`. Treat `pi-langfuse.json` as a secret-bearing configuration file as well.

Init refuses a non-empty directory and does not overwrite existing files.

Use `--no-start` to create files without running Docker Compose:

```text
/langfuse-init --yes --local --no-start
```

Start the stack later from the generated directory:

```bash
docker compose up -d
```

## Autostart

Local init enables autostart in `pi-langfuse.json`. When a session starts, the extension checks the configured health endpoint and runs `docker compose up -d` if the stack is unavailable.

Disable autostart for one process:

```bash
PI_LANGFUSE_AUTOSTART=0 pi
```

Set `PI_LANGFUSE_AUTOSTART=1` to force autostart when the configuration does not enable it. The health request uses the configured timeout. Docker Compose starts in detached mode; inspect `docker compose ps` or logs to confirm service readiness.

## Remote instances

Use remote mode when Langfuse already runs elsewhere:

```text
/langfuse-init --yes --remote \
  --host https://cloud.langfuse.com \
  --public-key pk-lf-... \
  --secret-key sk-lf-...
```

Remote mode writes only `pi-langfuse.json`. It does not create Compose files or start Docker.

## Existing installations

Version 2.0 keeps the generated Server v3 image names, configuration fields, credentials, and volume names. It does not recreate or migrate the database. Keep the existing directory and volumes, upgrade Node.js, install the new package, and check the local health endpoint before starting a traced prompt.
