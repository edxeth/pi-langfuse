import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectSourceMetadata, sanitizeGitRemote } from "./source-metadata.js";

const roots: string[] = [];

function git(cwd: string, args: string[]) {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function createRepository() {
	const root = mkdtempSync(join(tmpdir(), "pi-langfuse-source-metadata-"));
	roots.push(root);
	const repo = join(root, "repo");
	mkdirSync(repo);
	git(repo, ["init"]);
	git(repo, ["config", "user.email", "test@example.com"]);
	git(repo, ["config", "user.name", "Test User"]);
	writeFileSync(join(repo, "README.md"), "test\n");
	git(repo, ["add", "README.md"]);
	git(repo, ["commit", "-m", "init"]);
	return { root, repo };
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("source metadata", () => {
	it("sanitizes credentialed remotes and ignores unsafe override keys", () => {
		const { repo } = createRepository();
		git(repo, [
			"remote",
			"add",
			"origin",
			"https://token:secret@github.com/zyahav/Google-Calendar.git",
		]);
		writeFileSync(
			join(repo, ".pi-langfuse.metadata.json"),
			JSON.stringify({
				repo_identity: "zyahav/Google-Calendar",
				repo_owner: "zyahav",
				repo_name: "Google-Calendar",
				service_name: "calendar-supervisor",
				raw_path: "/Users/private/project",
				token: "secret-token",
				unknown_key: "must-not-pass",
				git_remote_path: "evil/override",
			}),
		);

		const metadata = collectSourceMetadata(repo);
		expect(metadata).toMatchObject({
			source_type: "git-repo",
			repo_root_name: "repo",
			repo_identity: "zyahav/Google-Calendar",
			repo_owner: "zyahav",
			repo_name: "Google-Calendar",
			service_name: "calendar-supervisor",
			git_remote_host: "github.com",
			git_remote_path: "zyahav/Google-Calendar",
			metadata_source: "repo-file",
		});
		expect(metadata).not.toHaveProperty("raw_path");
		expect(metadata).not.toHaveProperty("token");
		expect(metadata).not.toHaveProperty("unknown_key");
		expect(JSON.stringify(metadata)).not.toContain("secret");
		expect(JSON.stringify(metadata)).not.toContain(repo);
	});

	it("keeps repository identity safe for local remotes and missing remote metadata", () => {
		const { repo } = createRepository();
		const localRemote = join(repo, "../private-source.git");
		git(repo, ["remote", "add", "origin", `file://${localRemote}`]);
		const metadata = collectSourceMetadata(repo);

		expect(metadata.source_type).toBe("git-repo");
		expect(metadata.git_commit).toMatch(/^[0-9a-f]{40}$/);
		expect(metadata).not.toHaveProperty("git_remote_path");
		expect(JSON.stringify(metadata)).not.toContain("private-source");
		expect(JSON.stringify(metadata)).not.toContain(repo);
	});

	it("returns only non-git markers outside usable repositories", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-langfuse-non-git-"));
		roots.push(root);
		writeFileSync(
			join(root, ".pi-langfuse.metadata.json"),
			JSON.stringify({ repo_identity: "must-not-pass", token: "secret-token" }),
		);

		expect(collectSourceMetadata(root)).toEqual({
			source_type: "non-git",
			metadata_source: "non-git",
		});
	});

	it("rejects cross-platform absolute paths in metadata overrides", () => {
		const { repo } = createRepository();
		writeFileSync(
			join(repo, ".pi-langfuse.metadata.json"),
			JSON.stringify({
				service_name: "\\\\server\\share\\private-project",
				project_slug: "\\\\?\\C:\\private-project",
				environment: "\\\\.\\PIPE\\private-secret",
			}),
		);

		const metadata = collectSourceMetadata(repo);
		expect(metadata).not.toHaveProperty("service_name");
		expect(metadata).not.toHaveProperty("project_slug");
		expect(metadata).not.toHaveProperty("environment");
		expect(JSON.stringify(metadata)).not.toContain("private-project");
		expect(JSON.stringify(metadata)).not.toContain("private-secret");
	});

	it("normalizes supported remote forms without retaining credentials", () => {
		for (const remote of [
			"https://token:secret@github.com/zyahav/Google-Calendar.git",
			"git@github.com:zyahav/Google-Calendar.git",
			"https://github.com/zyahav/Google-Calendar.git",
		]) {
			const sanitized = sanitizeGitRemote(remote);
			expect(sanitized).toEqual({
				git_remote_host: "github.com",
				git_remote_path: "zyahav/Google-Calendar",
			});
			expect(JSON.stringify(sanitized)).not.toMatch(
				/token|secret|git@|https:\/\//,
			);
		}
	});
});
