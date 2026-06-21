export async function fetchGitBranches({ cwd, runCommandWithCapture, timeoutMs }) {
  const result = await runCommandWithCapture("git", [
    "-C",
    cwd,
    "for-each-ref",
    "--format=%(refname)%09%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ], {
    timeoutMs,
    maxOutputBytes: 128 * 1024,
  });
  if (result.timedOut) {
    throw new Error("git command timed out: git for-each-ref");
  }
  if (result.exitCode !== 0) {
    throw new Error(`git command failed (${result.exitCode}): git for-each-ref ${result.stderr || ""}`.trim());
  }

  const seen = new Set();
  const branches = [];
  for (const rawLine of String(result.stdout || "").split(/\r?\n/)) {
    const [fullRefRaw, nameRaw] = rawLine.split("\t");
    const fullRef = String(fullRefRaw || "").trim();
    const name = String(nameRaw || fullRefRaw || "").trim();
    const kind = fullRef.startsWith("refs/remotes/") ? "remote" : "local";
    const key = `${kind}:${name}`;
    if (!name || seen.has(key) || (kind === "remote" && /\/HEAD$/.test(fullRef))) continue;
    seen.add(key);
    branches.push({ name, kind });
  }
  branches.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "local" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return branches;
}
