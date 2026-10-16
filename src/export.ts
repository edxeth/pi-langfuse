import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { type Config, getConfigFilePath } from "./config.js";
import {
	IDENTITY_SALT_PATTERN,
	type IdentityTransform,
	identityTransformFor,
} from "./identity.js";
import { describeError, loadOrCreateIdentitySalt } from "./identity-salt.js";
import { shapeExportValue } from "./payload-policy.js";
import {
	type RedactionFinding,
	redactString,
	scanForSecrets,
} from "./redaction.js";
import {
	convertRawTrace,
	EXPORT_CONSENTS,
	type ExportConsent,
	TRAINING_FORMATS,
	TRAINING_REVIEW_NOTICE,
	type TrainingFormat,
} from "./training-export.js";

interface ExportArgs {
	outDir?: string;
	sessionsDir?: string;
	rawTraceDir?: string;
	includeSessions: boolean;
	includeRawTraces: boolean;
	trufflehog: boolean;
	requireTrufflehog: boolean;
	format?: string;
	license?: string;
	consent?: string;
	/** A malformed option; reported before anything is written. */
	error?: ExportDestinationError;
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
	code:
		| "destination-not-empty"
		| "destination-not-a-directory"
		| "identity-unavailable"
		| "invalid-export-option"
		| "consent-denied"
		| "derivative-name-collision";
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
	/** Present only when a `--format` training review export was requested. */
	training?: TrainingReport;
}

interface TrainingReport {
	format: TrainingFormat;
	/** Review records written beside the derivatives. */
	output: string;
	consent: ExportConsent;
	license: string;
	notice: string;
	/** Samples considered in approved raw derivatives: accepted + rejected. */
	candidates: number;
	accepted: number;
	rejected: number;
	/** Rejected sample counts by stable reason code. */
	rejectionReasons: Record<string, number>;
	warnings: string[];
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

function invalidOption(message: string): ExportDestinationError {
	return {
		code: "invalid-export-option",
		message: `export refused: ${message}`,
	};
}

/** Options that take the next argument as their value. */
type ValueKey =
	| "outDir"
	| "sessionsDir"
	| "rawTraceDir"
	| "format"
	| "license"
	| "consent";
const VALUE_OPTIONS: ReadonlyMap<string, ValueKey> = new Map([
	["--out", "outDir"],
	["--sessions-dir", "sessionsDir"],
	["--raw-dir", "rawTraceDir"],
	["--raw-trace-dir", "rawTraceDir"],
	["--format", "format"],
	["--license", "license"],
	["--consent", "consent"],
]);
const DIRECTORY_OPTIONS: ReadonlySet<string> = new Set([
	"outDir",
	"sessionsDir",
	"rawTraceDir",
]);
/** Options without a value, and the settings they select. */
const FLAG_OPTIONS: ReadonlyMap<string, Partial<ExportArgs>> = new Map([
	["--sessions-only", { includeSessions: true, includeRawTraces: false }],
	["--raw-only", { includeSessions: false, includeRawTraces: true }],
	["--trufflehog", { trufflehog: true }],
	["--no-trufflehog", { trufflehog: false }],
	["--require-trufflehog", { trufflehog: true, requireTrufflehog: true }],
]);
const RECOGNIZED_OPTIONS: ReadonlySet<string> = new Set([
	...VALUE_OPTIONS.keys(),
	...FLAG_OPTIONS.keys(),
]);

/** Parsed options after defaults: every directory is known. */
interface ParsedExportArgs extends ExportArgs {
	outDir: string;
	sessionsDir: string;
	rawTraceDir: string;
}

function splitArguments(args: string | string[]): string[] {
	// Array arguments (CLI argv) are already tokenized; re-splitting them would
	// destroy boundaries for paths containing spaces.
	if (Array.isArray(args)) return [...args];
	return (args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((token) =>
		token.replace(/^['"]|['"]$/g, ""),
	);
}

/** The first malformed option is the one reported. */
function recordFirstError(
	parsed: ExportArgs,
	error: ExportDestinationError | undefined,
) {
	if (!parsed.error) parsed.error = error;
}

/** Take the value that follows a value option from the remaining arguments. */
function applyValueOption(
	parsed: ExportArgs,
	option: string,
	key: ValueKey,
	rest: string[],
) {
	const value = rest[0];
	// A value that is itself a recognized option means the value was
	// omitted. It is never consumed: `--license --consent denied` must
	// not swallow the denial. An explicit empty string is a value.
	if (value === undefined || RECOGNIZED_OPTIONS.has(value)) {
		recordFirstError(parsed, invalidOption(`${option} requires a value`));
		return;
	}
	rest.shift();
	// An empty directory argument keeps meaning "not given", as before.
	if (value !== "" || !DIRECTORY_OPTIONS.has(key)) parsed[key] = value;
}

function formatError(format: string | undefined) {
	if (format === undefined) return undefined;
	if ((TRAINING_FORMATS as readonly string[]).includes(format))
		return undefined;
	return invalidOption(
		`--format must be one of ${TRAINING_FORMATS.join(", ")}`,
	);
}

/** Directory arguments are never stored empty, so `||` only fills absent ones. */
function withDefaultDirectories(
	parsed: ExportArgs,
	config: Config,
): ParsedExportArgs {
	return {
		...parsed,
		outDir:
			parsed.outDir ||
			join(defaultAgentDir(), "langfuse", "exports", timestampSlug()),
		sessionsDir: parsed.sessionsDir || join(defaultAgentDir(), "sessions"),
		rawTraceDir: parsed.rawTraceDir || config.rawTraceDir,
	};
}

function parseArgs(args: string | string[], config: Config): ParsedExportArgs {
	const rest = splitArguments(args);
	const parsed: ExportArgs = {
		includeSessions: true,
		includeRawTraces: true,
		trufflehog: true,
		requireTrufflehog: false,
	};
	for (let token = rest.shift(); token !== undefined; token = rest.shift()) {
		const valueKey = VALUE_OPTIONS.get(token);
		if (valueKey) applyValueOption(parsed, token, valueKey, rest);
		else Object.assign(parsed, FLAG_OPTIONS.get(token));
	}
	recordFirstError(parsed, formatError(parsed.format));
	return withDefaultDirectories(parsed, config);
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
	let output = content;
	// An empty prefix would match between every character.
	for (const prefix of prefixes.filter(Boolean)) {
		const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		output = output.replace(new RegExp(escaped, "g"), "[PATH_ROOT]");
	}
	return output;
}

/**
 * Derivative path of a source file. A pseudonymous export also normalizes the
 * path: Pi names session folders after the working directory, so the encoded
 * home directory (the user name) would otherwise survive in artifact names.
 * Source files are never renamed.
 */
function derivativePath(
	layer: ExportFileResult["layer"],
	sourceRoot: string,
	source: string,
	identity: IdentityTransform | undefined,
) {
	const relativePath = relative(sourceRoot, source);
	return join(
		layer === "pi-session" ? "sessions" : "raw-traces",
		identity ? identity.string(relativePath) : relativePath,
	);
}

function copyRedactedFile(
	config: Config,
	layer: ExportFileResult["layer"],
	source: string,
	outputPath: string,
	outRoot: string,
	pathPrefixes: string[] = [],
): { result: ExportFileResult; sanitized: string } {
	const content = readFileSync(source, "utf-8");
	const sanitized = stripAbsolutePathPrefix(
		sanitizeJsonl(config, content),
		pathPrefixes,
	);
	const preRedactionFindings = scanForSecrets(config, content);
	const residualFindings = scanForSecrets(config, sanitized);
	const output = join(outRoot, outputPath);
	mkdirSync(dirname(output), { recursive: true, mode: EXPORT_DIR_MODE });
	writeFileSync(output, sanitized, {
		encoding: "utf-8",
		mode: EXPORT_FILE_MODE,
	});

	return {
		result: {
			layer,
			path: outputPath,
			status: residualFindings.length === 0 ? "approved" : "rejected",
			inputBytes: statSync(source).size,
			outputBytes: Buffer.byteLength(sanitized),
			preRedactionFindings,
			residualFindings,
		},
		sanitized,
	};
}

type TrufflehogReport = NonNullable<ExportReport["trufflehog"]>;

/** Fields whose presence marks a TruffleHog JSON line as a detector finding. */
const TRUFFLEHOG_FINDING_KEYS = [
	"DetectorName",
	"SourceMetadata",
	"Raw",
	"Redacted",
];

/** A finding is a JSON object line without a log `level` that has a detector field. */
function isTrufflehogFinding(line: string) {
	if (!line.startsWith("{")) return false;
	try {
		const parsed = JSON.parse(line) as Record<string, unknown>;
		return (
			!parsed.level && TRUFFLEHOG_FINDING_KEYS.some((key) => key in parsed)
		);
	} catch {
		return false;
	}
}

/** Count finding lines across both output streams of a finished scan. */
function countTrufflehogFindings(result: SpawnSyncReturns<string>) {
	const output = `${result.stdout || ""}\n${result.stderr || ""}`;
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(isTrufflehogFinding).length;
}

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
	// Detection only: --no-verification stops TruffleHog from sending any
	// candidate credential to its vendor's API, and --no-update stops its
	// release check. Both flags exist in TruffleHog v3 (verified on 3.99.2).
	const result = spawnSync(
		trufflehogBin,
		["filesystem", "--json", "--no-verification", "--no-update", outDir],
		{
			env: process.env,
			encoding: "utf-8",
			maxBuffer: 20 * 1024 * 1024,
		},
	);
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
	return {
		enabled: true,
		required,
		available: true,
		exitCode: result.status,
		findings: countTrufflehogFindings(result),
		// A scan only counts as complete when it exited with status 0. A null
		// status means the process was killed by a signal before finishing, which
		// leaves the output unscanned even though nothing was printed.
		warning:
			result.status === 0
				? undefined
				: result.status === null
					? `trufflehog scan did not complete (signal ${result.signal})`
					: `trufflehog scan exited with status ${result.status}`,
	};
}

/** True only for a scan that ran detection-only to a clean, finding-free end. */
function scanSucceeded(report: TrufflehogReport) {
	return (
		report.enabled &&
		report.available &&
		report.exitCode === 0 &&
		report.findings === 0 &&
		!report.warning
	);
}

/** Longest operator-declared license text a review record carries. */
const MAX_LICENSE_CHARS = 200;

interface TrainingSetup {
	format: TrainingFormat;
	consent: ExportConsent;
	license: string;
	exportConfig: Config;
	warnings: string[];
}

/** Either the checked value or the refusal that stops the export. */
type Checked<T> = { value: T } | { error: ExportDestinationError };

/** What a `--format` export needs before anything is written. */
interface ExportPlan {
	error?: ExportDestinationError;
	training?: TrainingSetup;
}

/** A malformed config declaration is an error unless a flag replaces it. */
function declarationError(config: Config, options: ExportArgs) {
	const message =
		(options.consent === undefined ? config.exportConsentError : undefined) ??
		(options.license === undefined ? config.exportLicenseError : undefined);
	return message ? invalidOption(message) : undefined;
}

function checkTrainingRequest(config: Config, options: ExportArgs) {
	if (!options.includeRawTraces) {
		return invalidOption(
			"--format builds samples from raw traces only and cannot be combined with --sessions-only",
		);
	}
	// Review records are only kept after the external detection-only scan
	// finished cleanly, so skipping it contradicts the request.
	if (!options.trufflehog) {
		return invalidOption(
			"--format requires the external TruffleHog scan and cannot be combined with --no-trufflehog",
		);
	}
	return declarationError(config, options);
}

function declaredConsent(config: Config, options: ExportArgs): string {
	return options.consent ?? config.exportConsent ?? "unknown";
}

function resolveConsent(
	config: Config,
	options: ExportArgs,
): Checked<ExportConsent> {
	const consent = declaredConsent(config, options);
	if (!(EXPORT_CONSENTS as readonly string[]).includes(consent)) {
		return {
			error: invalidOption(
				`export consent must be one of ${EXPORT_CONSENTS.join(", ")}`,
			),
		};
	}
	if (consent === "denied") {
		return {
			error: {
				code: "consent-denied",
				message:
					"export refused: training consent is declared denied; no review records were written",
			},
		};
	}
	return { value: consent as ExportConsent };
}

function resolveLicense(config: Config, options: ExportArgs): Checked<string> {
	const license = (options.license ?? config.exportLicense ?? "").trim();
	if (
		license.length > MAX_LICENSE_CHARS ||
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is rejected
		/[\u0000-\u001f\u007f]/.test(license)
	) {
		return {
			error: invalidOption(
				`export license must be one line of at most ${MAX_LICENSE_CHARS} characters`,
			),
		};
	}
	return { value: license };
}

/** The configured pseudonymous salt, else the persisted one; never absent. */
function resolveSalt(config: Config): Checked<string> {
	const configured =
		config.identityMode === "pseudonymous" ? config.identitySalt : "";
	if (configured && IDENTITY_SALT_PATTERN.test(configured)) {
		return { value: configured };
	}
	try {
		return { value: loadOrCreateIdentitySalt(getConfigFilePath()) };
	} catch (error) {
		return {
			error: {
				code: "identity-unavailable",
				message: `export refused: pseudonymous identity needs a salt but none is available (${describeError(error)})`,
			},
		};
	}
}

function trainingWarnings(license: string, consent: ExportConsent) {
	const warnings = [
		"Pseudonymous is not anonymous: code, commits, relative paths, and business content can still identify people or repositories.",
	];
	if (!license) {
		warnings.push(
			"No export license is declared (--license or exportLicense); records carry an empty license.",
		);
	}
	if (consent === "unknown") {
		warnings.push(
			"Training consent is undeclared (--consent or exportConsent); records carry consent=unknown.",
		);
	}
	return warnings;
}

function trainingExportConfig(config: Config, salt: string): Config {
	return {
		...config,
		redactionEnabled: true,
		identityMode: "pseudonymous",
		identityKeepRepo: false,
		identitySalt: salt,
		identityHome: config.identityHome ?? homedir(),
	};
}

/**
 * Validate the operator declarations and force the privacy policy for a
 * `--format` export: always pseudonymous identity with repository identity
 * hashed, whatever the live capture settings say. The salt must exist before
 * any output is written; its absence is an error, never a raw fallback.
 */
function prepareTraining(
	config: Config,
	options: ExportArgs,
	format: TrainingFormat,
): ExportPlan {
	const requestError = checkTrainingRequest(config, options);
	if (requestError) return { error: requestError };
	const consent = resolveConsent(config, options);
	if ("error" in consent) return consent;
	const license = resolveLicense(config, options);
	if ("error" in license) return license;
	const salt = resolveSalt(config);
	if ("error" in salt) return salt;
	const exportConfig = trainingExportConfig(config, salt.value);
	return {
		training: {
			format,
			consent: consent.value,
			// Operator text gets the same redaction and identity policy as content.
			license: redactString(exportConfig, license.value),
			warnings: trainingWarnings(license.value, consent.value),
			exportConfig,
		},
	};
}

function notify(
	ctx: CommandContext | undefined,
	message: string,
	level: "info" | "warning" | "error",
) {
	ctx?.ui?.notify?.(message, level);
}

function failedReport(
	outDir: string,
	error: ExportDestinationError,
	ctx?: CommandContext,
): ExportReport {
	notify(ctx, error.message, "error");
	return {
		createdAt: new Date().toISOString(),
		outDir,
		status: "failed",
		files: [],
		summary: { approved: 0, rejected: 0, files: 0 },
		error,
	};
}

/** The first reason the export must not start, else the training setup. */
function planExport(
	config: Config,
	options: ParsedExportArgs,
	outDir: string,
): ExportPlan {
	const destinationError = destinationProblem(config, options, outDir);
	if (destinationError) return { error: destinationError };
	if (!options.format) return {};
	return prepareTraining(config, options, options.format as TrainingFormat);
}

function destinationProblem(
	config: Config,
	options: ParsedExportArgs,
	outDir: string,
): ExportDestinationError | undefined {
	if (options.error) return options.error;
	// An unusable identity policy must not fall back to unprotected output.
	if (config.identityError) {
		return {
			code: "identity-unavailable",
			message: `export refused: identity configuration is unusable (${config.identityError})`,
		};
	}
	return checkExportDestination(outDir);
}

interface ExportInput {
	layer: ExportFileResult["layer"];
	root: string;
	file: string;
	outputPath: string;
}

function layerInputs(
	layer: ExportFileResult["layer"],
	enabled: boolean,
	dir: string,
) {
	if (!enabled) return [];
	const root = resolve(dir);
	return listJsonlFiles(root).map((file) => ({ layer, root, file }));
}

function exportInputs(
	options: ParsedExportArgs,
	identity: IdentityTransform | undefined,
): ExportInput[] {
	return [
		...layerInputs("pi-session", options.includeSessions, options.sessionsDir),
		...layerInputs("raw-trace", options.includeRawTraces, options.rawTraceDir),
	].map((input) => ({
		...input,
		outputPath: derivativePath(input.layer, input.root, input.file, identity),
	}));
}

/**
 * Source roots whose absolute paths are scrubbed from derivative content.
 * The last entry is empty when no session root applies.
 */
function sourcePathPrefixes(options: ParsedExportArgs) {
	const sessionsRoot = resolve(options.sessionsDir);
	return Array.from(
		new Set([
			...(options.includeSessions ? [sessionsRoot] : []),
			...(options.includeRawTraces ? [resolve(options.rawTraceDir)] : []),
			options.includeSessions
				? sessionsRoot.replace(/[\\/]sessions[\\/]?$/, "")
				: "",
		]),
	);
}

interface CopiedFiles {
	files: ExportFileResult[];
	rawDerivatives: Array<{ file: ExportFileResult; sanitized: string }>;
}

function copyInputs(
	config: Config,
	inputs: ExportInput[],
	outDir: string,
	pathPrefixes: string[],
	onProgress: CommandContext["onProgress"],
): CopiedFiles {
	const copied: CopiedFiles = { files: [], rawDerivatives: [] };
	inputs.forEach((input, index) => {
		onProgress?.({
			phase: "copy",
			current: index + 1,
			total: inputs.length,
			layer: input.layer,
			path: relative(input.root, input.file),
			message: `redacting ${index + 1}/${inputs.length}`,
		});
		const { result, sanitized } = copyRedactedFile(
			config,
			input.layer,
			input.file,
			input.outputPath,
			outDir,
			pathPrefixes,
		);
		copied.files.push(result);
		if (input.layer === "raw-trace") {
			copied.rawDerivatives.push({ file: result, sanitized });
		}
	});
	return copied;
}

interface TrainingRun {
	setup: TrainingSetup;
	/** Review-record file name inside the export directory. */
	file: string;
	samples: Array<{ file: ExportFileResult; line: string }>;
	/** Rejected sample counts by stable reason code. */
	rejections: Map<string, number>;
}

function countRejections(run: TrainingRun, reason: string, count = 1) {
	run.rejections.set(reason, (run.rejections.get(reason) ?? 0) + count);
}

/** A converted example is kept only if the generated line itself scans clean. */
function keepCleanExample(
	run: TrainingRun,
	config: Config,
	file: ExportFileResult,
	example: unknown,
) {
	const line = JSON.stringify(example);
	if (scanForSecrets(config, line).length > 0) {
		countRejections(run, "residual-secret");
	} else {
		run.samples.push({ file, line });
	}
}

/**
 * Samples come from the sanitized derivatives that passed the built-in
 * scan, and are scanned again as generated: conversion adds strings
 * (serialized tool arguments, the declarations) the copy never saw.
 */
function convertTrainingSamples(
	setup: TrainingSetup,
	config: Config,
	rawDerivatives: CopiedFiles["rawDerivatives"],
	outDir: string,
): TrainingRun {
	const run: TrainingRun = {
		setup,
		file: `training-index.${setup.format}.jsonl`,
		samples: [],
		rejections: new Map(),
	};
	const declaration = { consent: setup.consent, license: setup.license };
	for (const { file, sanitized } of rawDerivatives) {
		if (file.status !== "approved") continue;
		const conversion = convertRawTrace(sanitized, {
			format: setup.format,
			source: file.path,
			declaration,
		});
		for (const rejection of conversion.rejections) {
			countRejections(run, rejection.reason);
		}
		for (const example of conversion.examples) {
			keepCleanExample(run, config, file, example);
		}
	}
	writeTrainingFile(outDir, run.file, run.samples);
	return run;
}

function skippedTrufflehog(): TrufflehogReport {
	return {
		enabled: false,
		required: false,
		available: false,
		findings: 0,
		warning: "trufflehog scan skipped by --no-trufflehog",
	};
}

/** A scan that found something, did not finish, or was required but is missing. */
function scanRejectsFiles(scan: TrufflehogReport) {
	return (
		(scan.available && (scan.findings > 0 || !!scan.warning)) ||
		(!scan.available && scan.required)
	);
}

function scanExport(
	options: ParsedExportArgs,
	training: boolean,
	outDir: string,
	files: ExportFileResult[],
	onProgress: CommandContext["onProgress"],
): TrufflehogReport {
	if (!options.trufflehog) return skippedTrufflehog();
	const scan = runTrufflehog(
		outDir,
		// Review records make the scan mandatory: an unavailable scanner is
		// then a required-scan failure, not an optional warning.
		options.requireTrufflehog || training,
		onProgress,
	);
	if (scanRejectsFiles(scan)) {
		for (const file of files) file.status = "rejected";
	}
	return scan;
}

/**
 * Records survive only a clean, completed, detection-only scan. A failed
 * scan also rejects every derivative, but the samples are judged on the
 * scan result itself so no other file status can keep them.
 */
function finishTraining(
	run: TrainingRun,
	scan: TrufflehogReport,
	outDir: string,
	ctx: CommandContext | undefined,
): TrainingReport {
	const scanned = scanSucceeded(scan);
	if (!scanned && run.samples.length > 0) {
		countRejections(run, "scanner-rejected", run.samples.length);
		run.samples = [];
		writeTrainingFile(outDir, run.file, run.samples);
	}
	const warnings = [...run.setup.warnings];
	if (!scanned) {
		warnings.push(
			"The external TruffleHog scan did not complete cleanly; no review records were kept.",
		);
	}
	const rejected = [...run.rejections.values()].reduce(
		(total, count) => total + count,
		0,
	);
	for (const warning of warnings) notify(ctx, warning, "warning");
	return {
		format: run.setup.format,
		output: run.file,
		consent: run.setup.consent,
		license: run.setup.license,
		notice: TRAINING_REVIEW_NOTICE,
		candidates: run.samples.length + rejected,
		accepted: run.samples.length,
		rejected,
		rejectionReasons: Object.fromEntries(
			[...run.rejections].sort(([left], [right]) => left.localeCompare(right)),
		),
		warnings,
	};
}

/**
 * Export-level status. A required scanner that is unavailable or failed
 * rejects the whole export, independent of how many input files were
 * scanned (including zero).
 */
function exportStatus(
	files: ExportFileResult[],
	scan: TrufflehogReport,
): ExportReport["status"] {
	const scannerRequiredFailure =
		scan.required && (!scan.available || scan.findings > 0 || !!scan.warning);
	const anyRejected = files.some((file) => file.status === "rejected");
	return anyRejected || scannerRequiredFailure ? "rejected" : "approved";
}

function assembleReport(
	outDir: string,
	files: ExportFileResult[],
	scan: TrufflehogReport,
	training: TrainingReport | undefined,
): ExportReport {
	const approved = files.filter((file) => file.status === "approved").length;
	return {
		createdAt: new Date().toISOString(),
		outDir,
		status: exportStatus(files, scan),
		files,
		summary: {
			approved,
			rejected: files.length - approved,
			files: files.length,
		},
		trufflehog: scan,
		...(training ? { training } : {}),
	};
}

function jsonlOf(rows: unknown[]) {
	return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function writeExportFile(outDir: string, name: string, content: string) {
	writeFileSync(join(outDir, name), content, { mode: EXPORT_FILE_MODE });
}

function trufflehogLine(scan: TrufflehogReport) {
	const state = scan.enabled
		? scan.available
			? "ran"
			: "unavailable"
		: "skipped";
	return `${state}, required=${scan.required}, findings=${scan.findings}`;
}

function reviewMarkdown(report: ExportReport, scan: TrufflehogReport) {
	return `# pi-langfuse redacted export\n\nStatus: ${report.status}\n\n- Files: ${report.summary.files}\n- Approved: ${report.summary.approved}\n- Rejected: ${report.summary.rejected}\n- TruffleHog: ${trufflehogLine(scan)}\n- Training index: training-index.jsonl\n\nThis export is local-only. Review approved files before using them for training or sharing.\n${report.training ? reviewTrainingSection(report.training) : ""}`;
}

function writeReviewFiles(
	outDir: string,
	report: ExportReport,
	scan: TrufflehogReport,
) {
	const { files } = report;
	const byStatus = (status: ExportFileResult["status"]) =>
		files.filter((file) => file.status === status);
	// The written report ships inside the shareable bundle, so it keeps the
	// destination scrubbed ("." = this directory); callers and CLI output get
	// the real destination from the returned report.
	writeExportFile(
		outDir,
		"report.json",
		`${JSON.stringify({ ...report, outDir: "." }, null, 2)}\n`,
	);
	writeExportFile(outDir, "manifest.jsonl", jsonlOf(files));
	writeExportFile(outDir, "approved.jsonl", jsonlOf(byStatus("approved")));
	writeExportFile(outDir, "rejected.jsonl", jsonlOf(byStatus("rejected")));
	writeExportFile(
		outDir,
		"training-index.jsonl",
		jsonlOf(
			byStatus("approved").map((file) => ({
				layer: file.layer,
				path: file.path,
				format: "redacted-jsonl-derivative",
			})),
		),
	);
	writeExportFile(outDir, "REVIEW.md", reviewMarkdown(report, scan));
}

function hasDerivativeCollision(inputs: ExportInput[]) {
	return new Set(inputs.map((input) => input.outputPath)).size < inputs.length;
}

/**
 * Convert review records, scan the finished export, and judge the records on
 * that scan. The order is fixed: the scan must see the conversion's output.
 */
function scanAndFinishTraining(
	training: TrainingSetup | undefined,
	exportConfig: Config,
	options: ParsedExportArgs,
	outDir: string,
	copied: CopiedFiles,
	ctx: CommandContext | undefined,
) {
	const run =
		training &&
		convertTrainingSamples(
			training,
			exportConfig,
			copied.rawDerivatives,
			outDir,
		);
	const scan = scanExport(
		options,
		!!training,
		outDir,
		copied.files,
		ctx?.onProgress,
	);
	return {
		scan,
		trainingReport: run && finishTraining(run, scan, outDir, ctx),
	};
}

/** Everything after the export was accepted: copy, convert, scan, report. */
function performExport(
	config: Config,
	training: TrainingSetup | undefined,
	options: ParsedExportArgs,
	outDir: string,
	ctx: CommandContext | undefined,
): ExportReport {
	// Export always redacts regardless of live telemetry settings.
	// PI_LANGFUSE_UNREDACTED disables redaction for live traces only.
	const exportConfig = training?.exportConfig ?? {
		...config,
		redactionEnabled: true,
	};
	const onProgress = ctx?.onProgress;
	onProgress?.({ phase: "discover", message: "discovering JSONL files" });
	const identity = training ? identityTransformFor(exportConfig) : undefined;
	const inputs = exportInputs(options, identity);
	// Name normalization can map two sources to one derivative; refuse before
	// anything is written rather than letting one overwrite the other.
	if (hasDerivativeCollision(inputs)) {
		return failedReport(
			outDir,
			{
				code: "derivative-name-collision",
				message:
					"export refused: two source files map to the same pseudonymized derivative name",
			},
			ctx,
		);
	}
	mkdirSync(outDir, { recursive: true, mode: EXPORT_DIR_MODE });
	const copied = copyInputs(
		exportConfig,
		inputs,
		outDir,
		sourcePathPrefixes(options),
		onProgress,
	);
	const { files } = copied;
	const { scan, trainingReport } = scanAndFinishTraining(
		training,
		exportConfig,
		options,
		outDir,
		copied,
		ctx,
	);
	const report = assembleReport(outDir, files, scan, trainingReport);
	onProgress?.({ phase: "write", message: "writing export reports" });
	writeReviewFiles(outDir, report, scan);
	notify(
		ctx,
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

export function exportRedactedData(
	config: Config,
	args: string | string[] = "",
	ctx?: CommandContext,
): ExportReport {
	const options = parseArgs(args, config);
	const outDir = resolve(options.outDir);
	const plan = planExport(config, options, outDir);
	if (plan.error) return failedReport(outDir, plan.error, ctx);
	return performExport(config, plan.training, options, outDir, ctx);
}

/** Overwrites only this export's own review-record file, never user files. */
function writeTrainingFile(
	outDir: string,
	name: string,
	samples: Array<{ line: string }>,
) {
	writeFileSync(
		join(outDir, name),
		samples.map((sample) => `${sample.line}\n`).join(""),
		{ mode: EXPORT_FILE_MODE },
	);
}

function reviewTrainingSection(training: TrainingReport) {
	const reasons = Object.entries(training.rejectionReasons)
		.map(([reason, count]) => `  - ${reason}: ${count}`)
		.join("\n");
	return `\n## Training review records (${training.format})\n\n${training.notice}\n\n- File: ${training.output}\n- Consent declaration: ${training.consent}\n- License declaration: ${training.license || "(none)"}\n- Samples: ${training.accepted} accepted, ${training.rejected} rejected\n${reasons ? `- Rejection reasons:\n${reasons}\n` : ""}${training.warnings.map((warning) => `- Warning: ${warning}`).join("\n")}\n`;
}
