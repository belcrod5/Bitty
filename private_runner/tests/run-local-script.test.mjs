import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("run-local shell scripts are syntactically valid", () => {
  for (const scriptPath of [
    "private_runner/run-local.sh",
    "private_runner/restart-keep-token.sh",
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

test("restart-keep-token passes the configured token and arguments to run-local", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "bitty-restart-keep-token-"));
  const runnerDir = join(repoRoot, "private_runner");
  const captureDir = join(repoRoot, "capture");
  mkdirSync(join(runnerDir, "custom"), { recursive: true });
  mkdirSync(captureDir);
  copyFileSync("private_runner/restart-keep-token.sh", join(runnerDir, "restart-keep-token.sh"));
  writeFileSync(join(runnerDir, ".env"), "RUNNER_TOKEN_FILE=private_runner/custom/token\n");
  writeFileSync(join(runnerDir, "custom/token"), "same-runner-token\n");
  writeFileSync(
    join(runnerDir, "run-local.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s' "$RUN_LOCAL_RUNNER_TOKEN" >"$CAPTURE_DIR/token"
printf '%s\n' "$@" >"$CAPTURE_DIR/arguments"
`
  );
  chmodSync(join(runnerDir, "run-local.sh"), 0o755);

  try {
    const result = spawnSync(
      "bash",
      [join(runnerDir, "restart-keep-token.sh"), "--mode", "runner-only"],
      {
        encoding: "utf8",
        env: { ...process.env, CAPTURE_DIR: captureDir },
      }
    );
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.equal(readFileSync(join(captureDir, "token"), "utf8"), "same-runner-token");
    assert.equal(
      readFileSync(join(captureDir, "arguments"), "utf8"),
      "restart\n--mode\nrunner-only\n"
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("restart-keep-token fails without a non-empty readable token before calling run-local", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "bitty-restart-keep-token-invalid-"));
  const runnerDir = join(repoRoot, "private_runner");
  const tokenPath = join(runnerDir, "logs/runner-token");
  const calledPath = join(repoRoot, "run-local-called");
  mkdirSync(join(runnerDir, "logs"), { recursive: true });
  copyFileSync("private_runner/restart-keep-token.sh", join(runnerDir, "restart-keep-token.sh"));
  writeFileSync(
    join(runnerDir, "run-local.sh"),
    `#!/usr/bin/env bash
touch "$RUN_LOCAL_CALLED_PATH"
`
  );
  chmodSync(join(runnerDir, "run-local.sh"), 0o755);

  const run = () =>
    spawnSync("bash", [join(runnerDir, "restart-keep-token.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_TOKEN_FILE: tokenPath,
        RUN_LOCAL_CALLED_PATH: calledPath,
      },
    });

  try {
    const missing = run();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /runner token file is not readable/);

    writeFileSync(tokenPath, "\n");
    const empty = run();
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /runner token file is empty/);

    chmodSync(tokenPath, 0o000);
    const unreadable = run();
    assert.equal(unreadable.status, 1);
    assert.match(unreadable.stderr, /runner token file is not readable/);

    assert.throws(() => readFileSync(calledPath), { code: "ENOENT" });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
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
