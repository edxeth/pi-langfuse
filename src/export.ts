import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Config } from "./config.js";
import { shapeExportValue } from "./payload-policy.js";
import {
	type RedactionFinding,
	redactString,
	scanForSecrets,
} from "./redaction.js";

interface ExportArgs {
	outDir?: string;
	sessionsDir?: string;
	rawTraceDir?: string;
	includeSessions: boolean;
	includeRawTraces: boolean;
	trufflehog: boolean;
	requireTrufflehog: boolean;
}

interface ExportFileResult {
	layer: "pi-session" | "raw-trace";
	path: string;
	status: "approved" | "rejected";
	inputBytes: number;
	outputBytes: number;
	preRedactionFindings: RedactionFinding[];
	residualFindings: RedactionFinding[];
}

interface ExportDestinationError {
	code: "destination-not-empty" | "destination-not-a-directory";
	message: string;
}

interface ExportReport {
	createdAt: string;
	outDir: string;
	/**
	 * Export-level approval: "failed" when the export aborted before writing,
	 * "rejected" when any file was rejected or a required scanner was
	 * unavailable or failed (independent of file count), else "approved".
	 */
	status: "approved" | "rejected" | "failed";
	files: ExportFileResult[];
	summary: {
		approved: number;
		rejected: number;
		files: number;
	};
	/** Set when the export aborted before writing anything. */
	error?: ExportDestinationError;
	trufflehog?: {
		enabled: boolean;
		required: boolean;
		available: boolean;
		exitCode?: number | null;
		findings: number;
		warning?: string;
	};
}

export interface ExportProgress {
	phase: "discover" | "copy" | "scan" | "write" | "done";
	current?: number;
	total?: number;
	layer?: ExportFileResult["layer"];
	path?: string;
	message: string;
}

type CommandContext = {
	onProgress?: (progress: ExportProgress) => void;
	ui?: {
		notify?: (message: string, type?: "info" | "warning" | "error") => unknown;
	};
};

// Export derivatives can carry residual secrets (rejected files especially),
// so new export artifacts and directories are owner-only at creation,
// consistent with the raw-trace privacy contract. Modes apply at creation
// only; pre-existing files are never chmod'ed.
const EXPORT_DIR_MODE = 0o700;
const EXPORT_FILE_MODE = 0o600;

/**
 * Refuse destinations the export must not touch: a nonempty directory may
 * hold unrelated user files (reusing a directory must never delete or mix
 * with them), and a non-directory cannot receive the export tree.
 * Returns undefined when the destination is usable.
 */
function checkExportDestination(
	outDir: string,
): ExportDestinationError | undefined {
	const existing = statSync(outDir, { throwIfNoEntry: false });
	if (!existing) return undefined;
	if (!existing.isDirectory()) {
		return {
			code: "destination-not-a-directory",
			message: `export destination exists and is not a directory: ${outDir}`,
		};
	}
	if (readdirSync(outDir).length > 0) {
		return {
			code: "destination-not-empty",
			message: `export destination is not empty: ${outDir}; choose another --out or empty the directory, existing files are never deleted`,
		};
	}
	return undefined;
}

function defaultAgentDir() {
	return (
		process.env.PI_CODING_AGENT_DIR ||
		join(process.env.HOME || "", ".pi", "agent")
	);
}

function timestampSlug(date = new Date()) {
	return date.toISOString().replace(/[:.]/g, "-");
}

function parseArgs(args: string | string[], config: Config): ExportArgs {
	// Array arguments (CLI argv) are already tokenized; re-splitting them would
	// destroy boundaries for paths containing spaces.
	const clean = Array.isArray(args)
		? args
		: (args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((token) =>
				token.replace(/^['"]|['"]$/g, ""),
			);
	const parsed: ExportArgs = {
		includeSessions: true,
		includeRawTraces: true,
		trufflehog: true,
		requireTrufflehog: false,
	};

	for (let index = 0; index < clean.length; index += 1) {
		const token = clean[index];
		const next = clean[index + 1];
		if (token === "--out" && next) {
			parsed.outDir = next;
			index += 1;
		} else if (token === "--sessions-dir" && next) {
			parsed.sessionsDir = next;
			index += 1;
		} else if ((token === "--raw-dir" || token === "--raw-trace-dir") && next) {
			parsed.rawTraceDir = next;
			index += 1;
		} else if (token === "--sessions-only") {
			parsed.includeSessions = true;
			parsed.includeRawTraces = false;
		} else if (token === "--raw-only") {
			parsed.includeSessions = false;
			parsed.includeRawTraces = true;
		} else if (token === "--trufflehog") {
			parsed.trufflehog = true;
		} else if (token === "--no-trufflehog") {
			parsed.trufflehog = false;
		} else if (token === "--require-trufflehog") {
			parsed.trufflehog = true;
			parsed.requireTrufflehog = true;
		}
	}

	parsed.outDir ??= join(
		defaultAgentDir(),
		"langfuse",
		"exports",
		timestampSlug(),
	);
	parsed.sessionsDir ??= join(defaultAgentDir(), "sessions");
	parsed.rawTraceDir ??= config.rawTraceDir;
	return parsed;
}

function listJsonlFiles(root: string) {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl"))
				files.push(path);
		}
	};
	walk(root);
	return files.sort();
}

function sanitizeJsonl(config: Config, content: string) {
	const lines = content.split(/\r?\n/);
	const sanitizedLines = lines.map((line) => {
		if (!line.trim()) return line;
		try {
			const parsed = JSON.parse(line) as unknown;
			return JSON.stringify(shapeExportValue(config, parsed));
		} catch {
			return redactString(config, line);
		}
	});
	return sanitizedLines.join("\n");
}

function stripAbsolutePathPrefix(content: string, prefixes: string[]): string {
	if (!prefixes.length) return content;
	let output = content;
	for (const prefix of prefixes) {
		if (!prefix) continue;
		const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		output = output.replace(new RegExp(escaped, "g"), "[PATH_ROOT]");
	}
	return output;
}

function copyRedactedFile(
	config: Config,
	layer: ExportFileResult["layer"],
	sourceRoot: string,
	source: string,
	outRoot: string,
	pathPrefixes: string[] = [],
): ExportFileResult {
	const content = readFileSync(source, "utf-8");
	const sanitized = stripAbsolutePathPrefix(
		sanitizeJsonl(config, content),
		pathPrefixes,
	);
	const preRedactionFindings = scanForSecrets(config, content);
	const residualFindings = scanForSecrets(config, sanitized);
	const relativePath =
		relative(sourceRoot, source) ||
		source.split(/[\\/]/).pop() ||
		"session.jsonl";
	const outputPath = join(
		layer === "pi-session" ? "sessions" : "raw-traces",
		relativePath,
	);
	const output = join(outRoot, outputPath);
	mkdirSync(dirname(output), { recursive: true, mode: EXPORT_DIR_MODE });
	writeFileSync(output, sanitized, {
		encoding: "utf-8",
		mode: EXPORT_FILE_MODE,
	});

	return {
		layer,
		path: outputPath,
		status: residualFindings.length === 0 ? "approved" : "rejected",
		inputBytes: statSync(source).size,
		outputBytes: Buffer.byteLength(sanitized),
		preRedactionFindings,
		residualFindings,
	};
}

type TrufflehogReport = NonNullable<ExportReport["trufflehog"]>;

function runTrufflehog(
	outDir: string,
	required: boolean,
	onProgress?: (progress: ExportProgress) => void,
): TrufflehogReport {
	onProgress?.({ phase: "scan", message: "checking trufflehog availability" });
	const trufflehogBin = process.env.TRUFFLEHOG_BIN || "trufflehog";
	const version = spawnSync(trufflehogBin, ["--version"], {
		encoding: "utf-8",
	});
	if (version.error || version.status !== 0) {
		return {
			enabled: true,
			required,
			available: false,
			findings: 0,
			warning: required
				? "trufflehog is required but was not available on PATH"
				: "trufflehog was not available on PATH; export used built-in residual scan only",
		};
	}

	onProgress?.({ phase: "scan", message: "running trufflehog scan" });
	const result = spawnSync(trufflehogBin, ["filesystem", "--json", outDir], {
		env: process.env,
		encoding: "utf-8",
		maxBuffer: 20 * 1024 * 1024,
	});
	if (result.error) {
		return {
			enabled: true,
			required,
			available: true,
			exitCode: null,
			findings: 0,
			warning: `trufflehog scan failed: ${result.error.message}`,
		};
	}
	const output = `${result.stdout || ""}\n${result.stderr || ""}`;
	const findings = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => {
			if (!line.startsWith("{")) return false;
			try {
				const parsed = JSON.parse(line) as Record<string, unknown>;
				return (
					!parsed.level &&
					("DetectorName" in parsed ||
						"SourceMetadata" in parsed ||
						"Raw" in parsed ||
						"Redacted" in parsed)
				);
			} catch {
				return false;
			}
		}).length;
	return {
		enabled: true,
		required,
		available: true,
		exitCode: result.status,
		findings,
		warning:
			result.status && result.status !== 0
				? `trufflehog scan exited with status ${result.status}`
				: undefined,
	};
}

export function exportRedactedData(
	config: Config,
	args: string | string[] = "",
	ctx?: CommandContext,
): ExportReport {
	// Export always redacts regardless of live telemetry settings.
	// PI_LANGFUSE_UNREDACTED disables redaction for live traces only.
	const exportConfig: Config = { ...config, redactionEnabled: true };
	const options = parseArgs(args, exportConfig);
	const outDir = resolve(options.outDir || "");
	const onProgress = ctx?.onProgress;
	const destinationError = checkExportDestination(outDir);
	if (destinationError) {
		ctx?.ui?.notify?.(destinationError.message, "error");
		return {
			createdAt: new Date().toISOString(),
			outDir,
			status: "failed",
			files: [],
			summary: { approved: 0, rejected: 0, files: 0 },
			error: destinationError,
		};
	}
	mkdirSync(outDir, { recursive: true, mode: EXPORT_DIR_MODE });
	onProgress?.({ phase: "discover", message: "discovering JSONL files" });

	const sessionInputs = options.includeSessions
		? listJsonlFiles(resolve(options.sessionsDir || "")).map((file) => ({
				layer: "pi-session" as const,
				root: resolve(options.sessionsDir || ""),
				file,
			}))
		: [];
	const rawInputs = options.includeRawTraces
		? listJsonlFiles(resolve(options.rawTraceDir || "")).map((file) => ({
				layer: "raw-trace" as const,
				root: resolve(options.rawTraceDir || ""),
				file,
			}))
		: [];
	const inputs = [...sessionInputs, ...rawInputs];
	const pathPrefixes = Array.from(
		new Set(
			[
				...(options.includeSessions
					? [resolve(options.sessionsDir || "")]
					: []),
				...(options.includeRawTraces
					? [resolve(options.rawTraceDir || "")]
					: []),
				options.includeSessions
					? resolve(options.sessionsDir || "").replace(
							/[\\/]sessions[\\/]?$/,
							"",
						)
					: "",
			].filter(Boolean),
		),
	);
	const files: ExportFileResult[] = [];
	inputs.forEach((input, index) => {
		onProgress?.({
			phase: "copy",
			current: index + 1,
			total: inputs.length,
			layer: input.layer,
			path: relative(input.root, input.file),
			message: `redacting ${index + 1}/${inputs.length}`,
		});
		files.push(
			copyRedactedFile(
				exportConfig,
				input.layer,
				input.root,
				input.file,
				outDir,
				pathPrefixes,
			),
		);
	});

	let trufflehog: ExportReport["trufflehog"] | undefined;
	if (options.trufflehog) {
		const trufflehogResult = runTrufflehog(
			outDir,
			options.requireTrufflehog,
			onProgress,
		);
		trufflehog = trufflehogResult;
		if (
			(trufflehogResult.available &&
				(trufflehogResult.findings > 0 || !!trufflehogResult.warning)) ||
			(!trufflehogResult.available && trufflehogResult.required)
		) {
			for (const file of files) file.status = "rejected";
		}
	} else {
		trufflehog = {
			enabled: false,
			required: false,
			available: false,
			findings: 0,
			warning: "trufflehog scan skipped by --no-trufflehog",
		};
	}

	const approvedCount = files.filter(
		(file) => file.status === "approved",
	).length;
	const rejectedCount = files.filter(
		(file) => file.status === "rejected",
	).length;
	// A required scanner that is unavailable or failed rejects the whole
	// export, independent of how many input files were scanned (including zero).
	const scannerRequiredFailure =
		!!trufflehog &&
		trufflehog.required &&
		(!trufflehog.available || trufflehog.findings > 0 || !!trufflehog.warning);
	const exportStatus: ExportReport["status"] =
		rejectedCount > 0 || scannerRequiredFailure ? "rejected" : "approved";

	const report: ExportReport = {
		createdAt: new Date().toISOString(),
		outDir,
		status: exportStatus,
		files,
		summary: {
			approved: approvedCount,
			rejected: rejectedCount,
			files: files.length,
		},
		trufflehog,
	};

	onProgress?.({ phase: "write", message: "writing export reports" });
	// The written report ships inside the shareable bundle, so it keeps the
	// destination scrubbed ("." = this directory); callers and CLI output get
	// the real destination from the returned report.
	writeFileSync(
		join(outDir, "report.json"),
		`${JSON.stringify({ ...report, outDir: "." }, null, 2)}\n`,
		{ mode: EXPORT_FILE_MODE },
	);
	writeFileSync(
		join(outDir, "manifest.jsonl"),
		`${files.map((file) => JSON.stringify(file)).join("\n")}\n`,
		{ mode: EXPORT_FILE_MODE },
	);
	writeFileSync(
		join(outDir, "approved.jsonl"),
		`${files
			.filter((file) => file.status === "approved")
			.map((file) => JSON.stringify(file))
			.join("\n")}\n`,
		{ mode: EXPORT_FILE_MODE },
	);
	writeFileSync(
		join(outDir, "rejected.jsonl"),
		`${files
			.filter((file) => file.status === "rejected")
			.map((file) => JSON.stringify(file))
			.join("\n")}\n`,
		{ mode: EXPORT_FILE_MODE },
	);
	writeFileSync(
		join(outDir, "training-index.jsonl"),
		`${files
			.filter((file) => file.status === "approved")
			.map((file) =>
				JSON.stringify({
					layer: file.layer,
					path: file.path,
					format: "redacted-jsonl-derivative",
				}),
			)
			.join("\n")}\n`,
		{ mode: EXPORT_FILE_MODE },
	);
	writeFileSync(
		join(outDir, "REVIEW.md"),
		`# pi-langfuse redacted export\n\nStatus: ${exportStatus}\n\n- Files: ${report.summary.files}\n- Approved: ${report.summary.approved}\n- Rejected: ${report.summary.rejected}\n- TruffleHog: ${trufflehog ? `${trufflehog.enabled ? (trufflehog.available ? "ran" : "unavailable") : "skipped"}, required=${trufflehog.required}, findings=${trufflehog.findings}` : "not requested"}\n- Training index: training-index.jsonl\n\nThis export is local-only. Review approved files before using them for training or sharing.\n`,
		{ mode: EXPORT_FILE_MODE },
	);

	ctx?.ui?.notify?.(
		`Langfuse export wrote ${files.length} file(s) to ${outDir}; ${report.summary.rejected} rejected`,
		report.summary.rejected > 0 ? "warning" : "info",
	);
	onProgress?.({
		phase: "done",
		current: files.length,
		total: files.length,
		message: `done: ${report.summary.approved} approved, ${report.summary.rejected} rejected`,
	});
	return report;
}
