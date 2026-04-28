# Contributing to pi-langfuse

Thank you for your interest in improving `pi-langfuse`! This project has recently been modernized to ensure high code quality and reliable tracing.

## Development Setup

1. **Clone and Install**:
   ```bash
   git clone https://github.com/edxeth/pi-langfuse.git
   cd pi-langfuse
   npm install
   ```

2. **Environment**:
   Ensure you have Node.js 18+ installed.

## Toolchain

We use a modern, fast toolchain:

- **TypeScript**: Strict type-checking with ESM/Node16 resolution.
- **[Biome](https://biomejs.dev/)**: Handles linting and formatting in a single tool.
- **[Vitest](https://vitest.dev/)**: Fast, native TypeScript testing framework.
- **[Husky](https://typicode.github.io/husky/) & [lint-staged](https://github.com/lint-staged/lint-staged)**: Automatically runs checks before every commit.

## Common Commands

- `npm run check`: Run Biome to check linting and formatting.
- `npm run format`: Auto-fix formatting issues.
- `npm run typecheck`: Run the TypeScript compiler to check for type errors.
- `npm run test`: Run the test suite once.
- `npm run test:watch`: Run tests in watch mode during development.
- `npm run build`: Compile the project to the `dist/` directory.

## Workflow

1. **Check your changes**: Before committing, run `npm run typecheck` and `npm run test`. Husky will also run these automatically on commit.
2. **Commit Messages**: We follow a concise, technical commit style (e.g., `feat: ...`, `fix: ...`, `chore: ...`).
3. **Releasing**: Releases are managed via `release-it`. Only maintainers should run `npm run release`.

## Tracing Model

If you are modifying the tracing logic, please refer to [docs/architecture.md](./docs/architecture.md) to ensure you maintain the established trace hierarchy (Prompt -> Turn -> Tool/Generation).
