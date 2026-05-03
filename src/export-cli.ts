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
  --help                   Show this help

Examples:
  pi-langfuse-export --sessions-only --sessions-dir ~/.pi/agent/sessions --out ~/pi-redacted-sessions --require-trufflehog
  pi-langfuse-export --sessions-dir ~/.pi/agent/sessions --raw-dir ~/.pi/agent/langfuse/raw-traces --out ~/pi-training-export --require-trufflehog
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

const report = exportRedactedData(resolveConfig({}), args.join(" "), {
	onProgress: (progress) => {
		process.stderr.write(`${progressLine(progress)}\n`);
	},
});
const status = report.summary.rejected === 0 ? "approved" : "rejected";
console.log(
	JSON.stringify(
		{
			status,
			outDir: report.outDir,
			summary: report.summary,
			trufflehog: report.trufflehog,
		},
		null,
		2,
	),
);

if (report.summary.rejected > 0) process.exitCode = 2;
