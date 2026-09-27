// Git exports repository-local variables to commit hooks. Tests create their
// own repositories, so inheriting those variables redirects fixture commands
// into the developer's worktree instead of the fixture directory.
for (const key of Object.keys(process.env)) {
	if (key.startsWith("GIT_")) delete process.env[key];
}
