export async function fetchGitBranches({ cwd, runCommandWithCapture, timeoutMs }) {
  const maxOutputBytes = 128 * 1024;
  const result = await runCommandWithCapture("git", [
    "-C",
    cwd,
    "for-each-ref",
    "--format=%(refname)%09%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ], {
    timeoutMs,
    maxOutputBytes,
  });
  if (result.timedOut) {
    throw new Error("git command timed out: git for-each-ref");
  }
  if (result.exitCode !== 0) {
    throw new Error(`git command failed (${result.exitCode}): git for-each-ref ${result.stderr || ""}`.trim());
  }
  if (String(result.stdout || "").length >= maxOutputBytes) {
    throw new Error("git branch list output was truncated");
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

export async function fetchGitBranchStatus({ cwd, runCommandWithCapture, timeoutMs }) {
  const result = await runCommandWithCapture("git", [
    "-C",
    cwd,
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=no",
  ], {
    timeoutMs,
    maxOutputBytes: 8 * 1024,
  });
  if (result.timedOut) {
    throw new Error("git command timed out: git status --porcelain=v2 --branch");
  }
  if (result.exitCode !== 0) {
    throw new Error(`git command failed (${result.exitCode}): git status --porcelain=v2 --branch ${result.stderr || ""}`.trim());
  }

  let branchName = "HEAD";
  let behindCount = 0;
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      branchName = value && value !== "(detached)" ? value : "HEAD";
    } else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/^# branch\.ab \+\d+ -(\d+)$/);
      if (match) behindCount = Number(match[1]);
    }
  }

  return { branchName, behindCount };
}
