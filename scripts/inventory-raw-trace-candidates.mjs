import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const fixtureNames = new Set(["auto", "down", "floating"]);
const usage =
	"Usage: node scripts/inventory-raw-trace-candidates.mjs <raw-trace-directory>\nLists name-pattern candidates only. It never deletes files.";

function isCandidate(name) {
	return (
		name.startsWith("--tmp") || /^e[0-9]/.test(name) || fixtureNames.has(name)
	);
}

function countJsonlFiles(directory) {
	let count = 0;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			count += countJsonlFiles(join(directory, entry.name));
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			count += 1;
		}
	}
	return count;
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
	console.log(usage);
} else if (args.length !== 1 || args[0] === "" || args[0].startsWith("--")) {
	console.error(usage);
	process.exitCode = 1;
} else {
	const rawTraceDir = resolve(args[0]);
	const candidates = readdirSync(rawTraceDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && isCandidate(entry.name))
		.map((entry) => entry.name)
		.sort()
		.map((directory) => ({
			directory,
			jsonlFiles: countJsonlFiles(join(rawTraceDir, directory)),
		}));
	console.log(
		JSON.stringify(
			{
				rawTraceDir,
				candidateDirectories: candidates.length,
				jsonlFiles: candidates.reduce(
					(sum, entry) => sum + entry.jsonlFiles,
					0,
				),
				candidates,
				warning:
					"Names do not prove test ownership. Review candidates before any separately approved cleanup. Symlink entries are skipped; concurrent writes can change this inventory. No files were changed.",
			},
			null,
			2,
		),
	);
}
