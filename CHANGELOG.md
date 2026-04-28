# Changelog

All notable changes to this project will be documented in this file.

## [0.2.2](https://github.com/hdkiller/pi-langfuse/compare/v0.2.1...v0.2.2) (2026-04-26)

### 🧹 Miscellaneous Chores
* release v0.2.2

## [0.2.1](https://github.com/hdkiller/pi-langfuse/compare/v0.2.0...v0.2.1) (2026-04-26)

### 📝 Documentation
* clarify optional status of settings extension and update package metadata

### 🧹 Miscellaneous Chores
* release v0.2.1
* bypass release-it github plugin bug by using gh CLI directly

## 0.2.0 (2026-04-26)

### 🚀 Features
* add configurable observability settings ([ac9059f](https://github.com/hdkiller/pi-langfuse/commit/ac9059f43f1b76f51d510490e5cce50e660c7e4d))
* support enabled in config.json ([c0a79b1](https://github.com/hdkiller/pi-langfuse/commit/c0a79b180013b0654bf942723e63050cc660d82d))
* surface live Langfuse config and add toggle command ([283c3ca](https://github.com/hdkiller/pi-langfuse/commit/283c3ca7fdd1cc4b5322fe061be04dae669e948c))

### 🐛 Bug Fixes
* avoid invalid sessionId on scores ([5fe3e6c](https://github.com/hdkiller/pi-langfuse/commit/5fe3e6cff4eaf7fc721f6a0fb92c37ca2344ccf7))
* update internal imports to .js for Node16 ESM compatibility ([418b949](https://github.com/hdkiller/pi-langfuse/commit/418b9494bd2b9fb11ace9e91d2358211835153d4))

### ♻️ Code Refactoring
* improve type safety and refine E2E test gating

### 🧹 Miscellaneous Chores
* release v0.2.0
* restructure project to src/ and test/ directories
* setup husky and lint-staged for pre-commit validation

## 0.1.0 (2026-04-26)

### 🚀 Features
* **Modernization**: Established strict TypeScript/ESM architecture.
* **Tooling**: Integrated Biome (linting/formatting), Vitest (testing), and Husky.
* **CI/CD**: Setup GitHub Actions with E2E integration tests.
* **Observability**: Major improvements to trace hierarchy and assistant-turn generations.
