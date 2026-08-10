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

test("restart-keep-token prefers the local token, falls back to main, and preserves arguments", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "bitty-restart-keep-token-"));
  const mainRoot = join(repoRoot, "main");
  const worktreeRoot = join(repoRoot, "worktree");
  const runnerDir = join(worktreeRoot, "private_runner");
  const localTokenPath = join(runnerDir, "custom/token");
  const mainCustomTokenPath = join(mainRoot, "private_runner/custom/token");
  const mainDefaultTokenPath = join(mainRoot, "private_runner/logs/runner-token");
  const captureDir = join(repoRoot, "capture");
  mkdirSync(join(mainRoot, "private_runner/custom"), { recursive: true });
  mkdirSync(join(mainRoot, "private_runner/logs"), { recursive: true });
  mkdirSync(join(runnerDir, "custom"), { recursive: true });
  mkdirSync(captureDir);
  copyFileSync("private_runner/restart-keep-token.sh", join(runnerDir, "restart-keep-token.sh"));
  writeFileSync(
    join(worktreeRoot, ".env"),
    `RESTART_KEEP_TOKEN_ROOT_ONLY=must-not-leak\nBITTY_MAIN_REPO_ROOT=${mainRoot}\n`
  );
  writeFileSync(join(runnerDir, ".env"), "RUNNER_TOKEN_FILE=private_runner/custom/token\n");
  writeFileSync(localTokenPath, "local-runner-token\n");
  writeFileSync(mainCustomTokenPath, "main-custom-token\n");
  writeFileSync(mainDefaultTokenPath, "main-default-token\n");
  writeFileSync(
    join(runnerDir, "run-local.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s' "$RUN_LOCAL_RUNNER_TOKEN" >"$CAPTURE_DIR/token"
printf '%s\n' "$@" >"$CAPTURE_DIR/arguments"
printf '%s' "\${RUNNER_TOKEN_FILE-}" >"$CAPTURE_DIR/token-file"
printf '%s' "\${RESTART_KEEP_TOKEN_ROOT_ONLY-unset}" >"$CAPTURE_DIR/root-only"
`
  );
  chmodSync(join(runnerDir, "run-local.sh"), 0o755);

  const env = { ...process.env, CAPTURE_DIR: captureDir };
  delete env.RESTART_KEEP_TOKEN_ROOT_ONLY;
  delete env.RUNNER_TOKEN_FILE;
  const run = () =>
    spawnSync("bash", [join(runnerDir, "restart-keep-token.sh"), "--mode", "runner-only"], {
      encoding: "utf8",
      env,
    });

  try {
    const local = run();
    assert.equal(local.status, 0, `stdout=${local.stdout}\nstderr=${local.stderr}`);
    assert.equal(readFileSync(join(captureDir, "token"), "utf8"), "local-runner-token");
    assert.equal(
      readFileSync(join(captureDir, "token-file"), "utf8"),
      "private_runner/custom/token"
    );

    rmSync(localTokenPath);
    rmSync(join(runnerDir, ".env"));
    const fallback = run();
    assert.equal(fallback.status, 0, `stdout=${fallback.stdout}\nstderr=${fallback.stderr}`);
    assert.equal(readFileSync(join(captureDir, "token"), "utf8"), "main-default-token");
    assert.equal(
      readFileSync(join(captureDir, "arguments"), "utf8"),
      "restart\n--mode\nrunner-only\n"
    );
    assert.equal(readFileSync(join(captureDir, "token-file"), "utf8"), "");
    assert.equal(readFileSync(join(captureDir, "root-only"), "utf8"), "unset");

    rmSync(join(worktreeRoot, ".env"));
    env.BITTY_MAIN_REPO_ROOT = mainRoot;
    const exportedFallback = run();
    assert.equal(
      exportedFallback.status,
      0,
      `stdout=${exportedFallback.stdout}\nstderr=${exportedFallback.stderr}`
    );
    assert.equal(readFileSync(join(captureDir, "token"), "utf8"), "main-default-token");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("restart-keep-token fails without a non-empty readable token before calling run-local", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "bitty-restart-keep-token-invalid-"));
  const mainRoot = join(repoRoot, "main");
  const worktreeRoot = join(repoRoot, "worktree");
  const runnerDir = join(worktreeRoot, "private_runner");
  const tokenPath = join(runnerDir, "logs/runner-token");
  const mainTokenPath = join(mainRoot, "private_runner/logs/runner-token");
  const calledPath = join(repoRoot, "run-local-called");
  mkdirSync(join(mainRoot, "private_runner/logs"), { recursive: true });
  mkdirSync(join(runnerDir, "logs"), { recursive: true });
  copyFileSync("private_runner/restart-keep-token.sh", join(runnerDir, "restart-keep-token.sh"));
  writeFileSync(join(worktreeRoot, ".env"), `BITTY_MAIN_REPO_ROOT=${mainRoot}\n`);
  writeFileSync(
    join(runnerDir, "run-local.sh"),
    `#!/usr/bin/env bash
touch "$RUN_LOCAL_CALLED_PATH"
`
  );
  chmodSync(join(runnerDir, "run-local.sh"), 0o755);

  const run = (tokenFile) => {
    const env = {
      ...process.env,
      RUN_LOCAL_CALLED_PATH: calledPath,
    };
    delete env.RUNNER_TOKEN_FILE;
    delete env.RESTART_KEEP_TOKEN_MISSING_ROOT;
    if (tokenFile) env.RUNNER_TOKEN_FILE = tokenFile;
    return spawnSync("bash", [join(runnerDir, "restart-keep-token.sh")], {
      encoding: "utf8",
      env,
    });
  };

  try {
    const missing = run();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /runner token file is not readable/);

    writeFileSync(mainTokenPath, "\n");
    const empty = run();
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /runner token file is empty/);

    rmSync(mainTokenPath);
    writeFileSync(tokenPath, "local-token\n");
    chmodSync(tokenPath, 0o000);
    const unreadable = run();
    assert.equal(unreadable.status, 1);
    assert.match(unreadable.stderr, /runner token file is not readable/);

    chmodSync(tokenPath, 0o600);
    rmSync(tokenPath);
    writeFileSync(mainTokenPath, "main-token\n");
    const absolute = run(join(worktreeRoot, "absolute-token"));
    assert.equal(absolute.status, 1);
    assert.match(absolute.stderr, /absolute-token/);

    writeFileSync(
      join(worktreeRoot, ".env"),
      "BITTY_MAIN_REPO_ROOT=$RESTART_KEEP_TOKEN_MISSING_ROOT\n"
    );
    const invalidEnv = run();
    assert.equal(invalidEnv.status, 1);
    assert.match(invalidEnv.stderr, /failed to load .*\.env/);

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
  const fakeBin = join(repoRoot, "bin");
  mkdirSync(join(repoRoot, ".git"));
  mkdirSync(join(repoRoot, "private_runner"));
  mkdirSync(fakeBin);
  writeFileSync(join(repoRoot, "private_runner/package.json"), "{}\n");
  writeFileSync(join(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(fakeBin, "npm"), 0o755);

  try {
    const result = spawnSync(
      "bash",
      [
        "scripts/worktree/bootstrap-local.sh",
        "--repo-root",
        repoRoot,
        "--env",
        "--private-runner",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      }
    );
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("bootstrap copies a missing runner token from main without overwriting a local token", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "bitty-bootstrap-runner-token-"));
  const mainRoot = join(repoRoot, "main");
  const worktreeRoot = join(repoRoot, "worktree");
  const fakeBin = join(repoRoot, "bin");
  const relativeTokenPath = "private_runner/custom/runner-token";
  const mainTokenPath = join(mainRoot, relativeTokenPath);
  const worktreeTokenPath = join(worktreeRoot, relativeTokenPath);
  mkdirSync(join(mainRoot, "private_runner/custom"), { recursive: true });
  mkdirSync(join(worktreeRoot, "private_runner"), { recursive: true });
  mkdirSync(fakeBin);
  writeFileSync(join(mainRoot, "private_runner/.env"), `RUNNER_TOKEN_FILE=${relativeTokenPath}\n`);
  writeFileSync(mainTokenPath, "main-runner-token\n", { mode: 0o600 });
  writeFileSync(join(worktreeRoot, "private_runner/package.json"), "{}\n");
  writeFileSync(join(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(fakeBin, "npm"), 0o755);

  const run = () => spawnSync(
    "bash",
    [
      "scripts/worktree/bootstrap-local.sh",
      "--repo-root",
      worktreeRoot,
      "--env",
      "--private-runner",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        BITTY_MAIN_REPO_ROOT: mainRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    }
  );

  try {
    const copied = run();
    assert.equal(copied.status, 0, `stdout=${copied.stdout}\nstderr=${copied.stderr}`);
    assert.match(copied.stdout, /copied private_runner\/custom\/runner-token/);
    assert.equal(readFileSync(worktreeTokenPath, "utf8"), "main-runner-token\n");

    writeFileSync(worktreeTokenPath, "local-runner-token\n");
    const preserved = run();
    assert.equal(preserved.status, 0, `stdout=${preserved.stdout}\nstderr=${preserved.stderr}`);
    assert.equal(readFileSync(worktreeTokenPath, "utf8"), "local-runner-token\n");

    writeFileSync(worktreeTokenPath, "");
    const replacedEmpty = run();
    assert.equal(
      replacedEmpty.status,
      0,
      `stdout=${replacedEmpty.stdout}\nstderr=${replacedEmpty.stderr}`
    );
    assert.equal(readFileSync(worktreeTokenPath, "utf8"), "main-runner-token\n");

    rmSync(worktreeTokenPath);
    rmSync(mainTokenPath);
    const missingSource = run();
    assert.equal(
      missingSource.status,
      0,
      `stdout=${missingSource.stdout}\nstderr=${missingSource.stderr}`
    );
    assert.match(missingSource.stderr, /reusable runner token not found/);
    assert.throws(() => readFileSync(worktreeTokenPath), { code: "ENOENT" });

    writeFileSync(mainTokenPath, "");
    writeFileSync(worktreeTokenPath, "");
    const emptySource = run();
    assert.equal(emptySource.status, 0, `stdout=${emptySource.stdout}\nstderr=${emptySource.stderr}`);
    assert.equal(readFileSync(worktreeTokenPath, "utf8"), "");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("bootstrap refuses a runner token path that escapes the repository", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "bitty-bootstrap-runner-token-boundary-"));
  const mainRoot = join(repoRoot, "main/repo");
  const worktreeRoot = join(repoRoot, "worktrees/repo");
  const fakeBin = join(repoRoot, "bin");
  const escapedSource = join(repoRoot, "main/escaped-token");
  const escapedTarget = join(repoRoot, "worktrees/escaped-token");
  mkdirSync(join(mainRoot, "private_runner"), { recursive: true });
  mkdirSync(join(worktreeRoot, "private_runner"), { recursive: true });
  mkdirSync(fakeBin);
  writeFileSync(join(mainRoot, "private_runner/.env"), "RUNNER_TOKEN_FILE=../escaped-token\n");
  writeFileSync(escapedSource, "must-not-copy\n");
  writeFileSync(join(worktreeRoot, "private_runner/package.json"), "{}\n");
  writeFileSync(join(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(fakeBin, "npm"), 0o755);

  try {
    const result = spawnSync(
      "bash",
      [
        "scripts/worktree/bootstrap-local.sh",
        "--repo-root",
        worktreeRoot,
        "--env",
        "--private-runner",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BITTY_MAIN_REPO_ROOT: mainRoot,
          PATH: `${fakeBin}:${process.env.PATH}`,
        },
      }
    );
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /refusing runner token path outside repository/);
    assert.throws(() => readFileSync(escapedTarget), { code: "ENOENT" });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
