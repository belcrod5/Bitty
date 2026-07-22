import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("run-local shell scripts are syntactically valid", () => {
  for (const scriptPath of [
    "private_runner/run-local.sh",
    "private_runner/src/run-local-public-runner.sh",
    "private_runner/src/codex-version-gate.sh",
  ]) {
    const result = spawnSync("bash", ["-n", scriptPath], {
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      `${scriptPath}\nstdout=${result.stdout}\nstderr=${result.stderr}`
    );
  }
});

test("Codex version gate rejects old versions and accepts the minimum", () => {
  const runGate = (version) => spawnSync("bash", ["-c", `
    source private_runner/src/codex-version-gate.sh
    CODEX_ENABLE=1
    codex() { printf '%s\\n' 'codex-cli ${version}'; }
    require_codex_minimum_version
  `], { encoding: "utf8" });

  assert.equal(runGate("0.145.0").status, 0);
  const old = runGate("0.144.9");
  assert.equal(old.status, 1);
  assert.match(old.stderr, /0\.145\.0以上へ更新/);
});

test("Cloudflare tunnel startup and preflight are explicit opt-in", async () => {
  const runLocal = await readFile("private_runner/run-local.sh", "utf8");
  const publicRunner = await readFile("private_runner/src/run-local-public-runner.sh", "utf8");

  assert.match(runLocal, /CLOUDFLARE_TUNNEL_ENABLE="\$\{CLOUDFLARE_TUNNEL_ENABLE:-0\}"/);
  assert.match(runLocal, /--cloudflare-tunnel\)/);
  assert.match(runLocal, /cloudflare_tunnel_arg="--cloudflare-tunnel"/);
  assert.match(runLocal, /start_screen_supervisor "\$RUN_LOCAL_SCREEN_SESSION" "\$SCRIPT_PATH" start "\$\{mode_arg\[@\]\}" \$\{cloudflare_tunnel_arg:\+"\$cloudflare_tunnel_arg"\}/);
  assert.match(runLocal, /start_nohup_supervisor 1 1 0 start "\$\{mode_arg\[@\]\}" \$\{cloudflare_tunnel_arg:\+"\$cloudflare_tunnel_arg"\}/);
  assert.doesNotMatch(runLocal, /cloudflare_tunnel_arg=\(\)/);
  assert.match(runLocal, /if \[ "\$CLOUDFLARE_TUNNEL_ENABLE" = "1" \]; then\s+mkdir -p "\$SCRIPT_DIR\/logs"\s+echo "\[run-local\] starting cloudflared tunnel/s);
  assert.match(publicRunner, /preflight_cloudflare_tunnel\(\) \{\s+if \[ "\$CLOUDFLARE_TUNNEL_ENABLE" != "1" \]; then\s+return 0/s);
});

test("bootstrap uses a standalone clone as its own main repository", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "bitty-standalone-clone-"));
  mkdirSync(join(repoRoot, ".git"));

  try {
    const result = spawnSync(
      "bash",
      ["scripts/worktree/bootstrap-local.sh", "--repo-root", repoRoot, "--env"],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
