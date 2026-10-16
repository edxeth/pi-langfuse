#!/usr/bin/env node
import { resolveConfig } from "./config.js";
import { type ExportProgress, exportRedactedData } from "./export.js";

function printHelp() {
	console.log(`pi-langfuse-export

Create local redacted derivatives of Pi session JSONL and/or pi-langfuse raw traces.
This command runs outside the Pi TUI, so it is the recommended path for large/bulk exports.

Usage:
  pi-langfuse-export [options]

Options:
  --out <dir>              Export directory. Default: $PI_CODING_AGENT_DIR/langfuse/exports/<timestamp>
  --sessions-dir <dir>     Pi sessions directory. Default: $PI_CODING_AGENT_DIR/sessions
  --raw-dir <dir>          Raw traces directory. Default: configured rawTraceDir
  --sessions-only          Export only Pi session JSONL derivatives
  --raw-only               Export only raw trace JSONL derivatives
  --no-trufflehog          Skip TruffleHog scan explicitly
  --require-trufflehog     Reject export if TruffleHog is unavailable or fails
  --format <name>          Also write training-index.<name>.jsonl local review records from
                           raw traces: openai-chat, anthropic-messages, or sharegpt.
                           Forces pseudonymous identity (repository identity hashed) and requires a
                           completed TruffleHog scan; cannot be combined with --no-trufflehog.
                           These are review records only, not permission to train.
  --license <text>         Operator-declared license recorded in review records (default: empty)
  --consent <value>        Operator-declared training consent: unknown (default), granted, denied.
                           denied refuses the export. Neither declaration is verified.
  --help                   Show this help

Examples:
  pi-langfuse-export --sessions-only --sessions-dir ~/.pi/agent/sessions --out ~/pi-redacted-sessions --require-trufflehog
  pi-langfuse-export --sessions-dir ~/.pi/agent/sessions --raw-dir ~/.pi/agent/langfuse/raw-traces --out ~/pi-training-export --require-trufflehog
  pi-langfuse-export --raw-only --format openai-chat --license "internal-use-only" --consent granted --out ~/pi-review-export --require-trufflehog
`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	printHelp();
	process.exit(0);
}

function progressLine(progress: ExportProgress) {
	const count =
		progress.current !== undefined && progress.total !== undefined
			? ` ${progress.current}/${progress.total}`
			: "";
	const layer = progress.layer ? ` ${progress.layer}` : "";
	const path = progress.path ? ` ${progress.path}` : "";
	return `[${new Date().toISOString()}] ${progress.phase}${count}${layer}${path} - ${progress.message}`;
}

// Pass argv through as an array: joining would re-tokenize paths that
// contain spaces and split them into separate arguments.
const report = exportRedactedData(resolveConfig({}), args, {
	onProgress: (progress) => {
		process.stderr.write(`${progressLine(progress)}\n`);
	},
});
if (report.error) {
	process.stderr.write(`Export failed: ${report.error.message}\n`);
}
for (const warning of report.training?.warnings ?? []) {
	process.stderr.write(`Warning: ${warning}\n`);
}
const status = report.error ? "failed" : report.status;
console.log(
	JSON.stringify(
		{
			status,
			outDir: report.outDir,
			summary: report.summary,
			trufflehog: report.trufflehog,
			training: report.training,
			error: report.error,
		},
		null,
		2,
	),
);

if (report.error || report.status === "rejected") process.exitCode = 2;
