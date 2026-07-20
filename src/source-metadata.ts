import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";

export type SourceMetadata = Record<string, string>;

const OVERRIDE_KEYS = new Set([
	"repo_identity",
	"repo_owner",
	"repo_name",
	"service_name",
	"project_slug",
	"environment",
	"observability_owner",
]);

function nonGitMetadata(): SourceMetadata {
	return {
		source_type: "non-git",
		metadata_source: "non-git",
	};
}

function runGit(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 2_000,
	}).trim();
}

function optionalGit(cwd: string, args: string[]) {
	try {
		return runGit(cwd, args);
	} catch {
		return undefined;
	}
}

function firstLine(value: string) {
	return (
		value
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? ""
	);
}

function hasControlCharacters(value: string) {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code < 32 || code === 127) return true;
	}
	return false;
}

function sanitizeRemotePath(value: string) {
	const path = value.replace(/^\/+/, "").replace(/\.git$/i, "");
	if (!path || path.includes("\\")) return undefined;
	const parts = path.split("/");
	if (
		parts.some(
			(part) =>
				!part || part === "." || part === ".." || hasControlCharacters(part),
		)
	)
		return undefined;
	return path;
}

export function sanitizeGitRemote(
	remoteUrl: string,
): Partial<Pick<SourceMetadata, "git_remote_host" | "git_remote_path">> {
	const raw = firstLine(remoteUrl);
	if (!raw) return {};

	try {
		const parsed = new URL(raw);
		if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) {
			return {};
		}
		const path = sanitizeRemotePath(parsed.pathname);
		return parsed.hostname && path
			? { git_remote_host: parsed.hostname, git_remote_path: path }
			: {};
	} catch {
		// Continue with scp-like SSH syntax, for example git@github.com:owner/repo.git.
	}

	const scpLike = raw.match(/^(?:[^@\s/:]+@)?([^:\s]+):(.+)$/);
	if (!scpLike) return {};
	const host = scpLike[1]?.toLowerCase();
	const path = scpLike[2] ? sanitizeRemotePath(scpLike[2]) : undefined;
	return host && path ? { git_remote_host: host, git_remote_path: path } : {};
}

function deriveIdentity(remotePath: string | undefined) {
	if (!remotePath) return {};
	const parts = remotePath.split("/").filter(Boolean);
	if (parts.length < 2) return {};
	const repoName = parts.at(-1);
	const owner = parts.at(-2);
	if (!repoName || !owner || repoName.includes("/")) return {};
	return {
		repo_identity: `${owner}/${repoName}`,
		repo_owner: owner,
		repo_name: repoName,
	};
}

function findRepoMetadataFile(cwd: string, gitRoot: string) {
	let current = resolve(cwd);
	const root = resolve(gitRoot);
	while (true) {
		const candidate = join(current, ".pi-langfuse.metadata.json");
		if (existsSync(candidate)) return candidate;
		if (current === root) return undefined;
		const parent = dirname(current);
		if (parent === current || !parent.startsWith(`${root}/`)) return undefined;
		current = parent;
	}
}

function safeOverrideValue(key: string, value: unknown) {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (
		!trimmed ||
		trimmed.length > 200 ||
		hasControlCharacters(trimmed) ||
		posix.isAbsolute(trimmed) ||
		win32.isAbsolute(trimmed) ||
		trimmed.startsWith("~") ||
		trimmed.includes("://")
	)
		return undefined;
	if (["repo_owner", "repo_name"].includes(key) && /[\\/]/.test(trimmed)) {
		return undefined;
	}
	if (key === "repo_identity" && !/^[^/\\\s]+\/[^/\\\s]+$/.test(trimmed)) {
		return undefined;
	}
	return trimmed;
}

function readWhitelistedOverrides(
	cwd: string,
	gitRoot: string,
): SourceMetadata {
	const path = findRepoMetadataFile(cwd, gitRoot);
	if (!path) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
			string,
			unknown
		>;
		const output: SourceMetadata = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (!OVERRIDE_KEYS.has(key)) continue;
			const safeValue = safeOverrideValue(key, value);
			if (safeValue) output[key] = safeValue;
		}
		return output;
	} catch {
		return {};
	}
}

export function collectSourceMetadata(cwd: string): SourceMetadata {
	try {
		if (runGit(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
			return nonGitMetadata();
		}

		const gitRoot = runGit(cwd, ["rev-parse", "--show-toplevel"]);
		const commit = optionalGit(cwd, ["rev-parse", "HEAD"]);
		const branch = optionalGit(cwd, ["branch", "--show-current"]);
		const remote = optionalGit(cwd, ["config", "--get", "remote.origin.url"]);
		const remoteMetadata = sanitizeGitRemote(remote || "");
		const overrides = readWhitelistedOverrides(cwd, gitRoot);
		const derivedIdentity = deriveIdentity(remoteMetadata.git_remote_path);

		const metadata: SourceMetadata = {
			source_type: "git-repo",
			repo_root_name: basename(gitRoot),
			metadata_source:
				Object.keys(overrides).length > 0 ? "repo-file" : "git-detection",
		};
		if (branch) metadata.git_branch = branch;
		if (commit && /^[0-9a-f]{40}$/i.test(commit)) {
			metadata.git_commit = commit.toLowerCase();
		}
		Object.assign(metadata, remoteMetadata, derivedIdentity, overrides);

		if (metadata.repo_name?.includes("/")) delete metadata.repo_name;
		if (!metadata.repo_identity && metadata.repo_owner && metadata.repo_name) {
			metadata.repo_identity = `${metadata.repo_owner}/${metadata.repo_name}`;
		}
		return metadata;
	} catch {
		return nonGitMetadata();
	}
}
