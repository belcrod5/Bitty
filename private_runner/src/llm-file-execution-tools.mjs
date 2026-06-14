import path from "node:path";
import { promises as fs } from "node:fs";

export function createLlmFileExecutionTools(deps) {
  const {
    buildCommandExecutionEnv,
    buildCommandPreview,
    clamp,
    isPathInsideRoot,
    isProbablyBinary,
    makeToolError,
    maxEditFileBytes,
    pathExists,
    resolvePathWithinToolRoot,
    resolveSandboxedRunApprovalPolicy,
    runCommandWithCapture,
    runTestsDefaultTimeoutMs,
    runTestsMaxTimeoutMs,
    sandboxedRunAllowedCommands,
    sandboxedRunDefaultTimeoutMs,
    sandboxedRunDenyCommands,
    sandboxedRunMaxArgLength,
    sandboxedRunMaxArgs,
    sandboxedRunMaxOutputBytes,
    sandboxedRunMaxTimeoutMs,
    splitCommandLine,
    toUnixPath,
  } = deps;

  async function runWriteFileTool(args, ctx) {
    const mode = String(args.mode || "overwrite").trim().toLowerCase();
    if (mode !== "overwrite" && mode !== "append" && mode !== "create") {
      throw new Error("mode must be overwrite | append | create");
    }
    const content = String(args.content ?? "");
    const resolved = await resolvePathWithinToolRoot(ctx.rootReal, args.path, {
      allowMissing: true,
      ensureParentDir: true,
    });

    if (resolved.exists) {
      const existingStat = await fs.stat(resolved.realPath);
      if (!existingStat.isFile()) {
        throw new Error("path is not a file");
      }
      if (mode === "create") {
        throw new Error("target already exists");
      }
    }

    if (mode === "append") {
      await fs.appendFile(resolved.absPath, content, "utf8");
    } else if (mode === "create") {
      await fs.writeFile(resolved.absPath, content, { encoding: "utf8", flag: "wx" });
    } else {
      await fs.writeFile(resolved.absPath, content, { encoding: "utf8", flag: "w" });
    }

    const finalReal = await fs.realpath(resolved.absPath);
    if (!isPathInsideRoot(ctx.rootReal, finalReal)) {
      throw new Error("write target escaped root directory");
    }
    const stat = await fs.stat(finalReal);
    return {
      path: toUnixPath(path.relative(ctx.rootReal, finalReal)) || ".",
      mode,
      bytesWritten: Buffer.byteLength(content, "utf8"),
      totalBytes: stat.size,
    };
  }

  function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let count = 0;
    let startAt = 0;
    while (true) {
      const idx = haystack.indexOf(needle, startAt);
      if (idx < 0) return count;
      count += 1;
      startAt = idx + needle.length;
    }
  }

  async function runEditFileTool(args, ctx) {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    if (edits.length === 0) {
      throw new Error("edits must have at least one item");
    }
    const resolved = await resolvePathWithinToolRoot(ctx.rootReal, args.path);
    const stat = await fs.stat(resolved.realPath);
    if (!stat.isFile()) {
      throw new Error("path is not a file");
    }
    if (stat.size > maxEditFileBytes) {
      throw new Error(`file is too large for edit_file (${stat.size} bytes)`);
    }
    const raw = await fs.readFile(resolved.realPath);
    if (isProbablyBinary(raw)) {
      throw new Error("edit_file supports text files only");
    }
    let text = raw.toString("utf8");
    let replacements = 0;
    for (const edit of edits) {
      const oldText = String(edit?.oldText ?? "");
      const newText = String(edit?.newText ?? "");
      const replaceAll = Boolean(edit?.replaceAll);
      if (!oldText) {
        throw new Error("oldText must not be empty");
      }
      if (replaceAll) {
        const count = countOccurrences(text, oldText);
        if (count === 0) {
          throw new Error("oldText not found");
        }
        text = text.split(oldText).join(newText);
        replacements += count;
        continue;
      }
      const index = text.indexOf(oldText);
      if (index < 0) {
        throw new Error("oldText not found");
      }
      text = `${text.slice(0, index)}${newText}${text.slice(index + oldText.length)}`;
      replacements += 1;
    }
    await fs.writeFile(resolved.realPath, text, "utf8");
    return {
      path: resolved.relativePath,
      replacements,
      totalBytes: Buffer.byteLength(text, "utf8"),
    };
  }

  async function runMediaTool(args) {
    const actionRaw = String(args?.action || "").trim().toLowerCase();
    const action = actionRaw === "stop" || actionRaw === "next" || actionRaw === "prev"
      ? actionRaw
      : "";
    if (!action) {
      throw makeToolError("invalid_action", "action must be one of stop | next | prev", {
        action: actionRaw,
      });
    }
    const defaultTarget = action === "stop" ? "all" : "youtube";
    const targetRaw = String(args?.target || defaultTarget).trim().toLowerCase();
    const target = targetRaw === "all" || targetRaw === "youtube" || targetRaw === "tts"
      ? targetRaw
      : "";
    if (!target) {
      throw makeToolError("invalid_target", "target must be one of all | youtube | tts", {
        target: targetRaw,
      });
    }
    if ((action === "next" || action === "prev") && target === "tts") {
      throw makeToolError("invalid_target", "target=tts is not supported for next | prev", {
        action,
        target,
      });
    }
    const reason = String(args?.reason || "").trim();
    return {
      action,
      target,
      reason: reason || undefined,
    };
  }

  function normalizeSandboxedArgs(rawArgs) {
    if (rawArgs === undefined || rawArgs === null) return [];
    if (!Array.isArray(rawArgs)) {
      throw makeToolError("invalid_arguments", "args must be an array of strings");
    }
    const args = rawArgs.map((item) => String(item ?? ""));
    if (args.length > sandboxedRunMaxArgs) {
      throw makeToolError("too_many_args", `too many args (max ${sandboxedRunMaxArgs})`, {
        max: sandboxedRunMaxArgs,
        count: args.length,
      });
    }
    for (const arg of args) {
      if (arg.includes("\u0000")) {
        throw makeToolError("invalid_arguments", "args must not include NUL");
      }
      if (arg.length > sandboxedRunMaxArgLength) {
        throw makeToolError(
          "arg_too_long",
          `arg is too long (max ${sandboxedRunMaxArgLength} chars)`,
          { max: sandboxedRunMaxArgLength }
        );
      }
    }
    return args;
  }

  async function runCommandSandboxedTool(args, ctx, opts = {}) {
    const commandInput = String(args?.command || "").trim();
    if (!commandInput) {
      throw makeToolError("invalid_arguments", "command is required");
    }
    if (/[/\\]/.test(commandInput)) {
      return {
        ok: false,
        code: "command_not_allowed",
        message: "command must not include path separators",
        command: commandInput,
        changedFiles: [],
      };
    }
    const command = commandInput.toLowerCase();
    if (sandboxedRunDenyCommands.has(command)) {
      return {
        ok: false,
        code: "command_denied",
        message: `command is denied: ${commandInput}`,
        command: command,
      };
    }
    if (!sandboxedRunAllowedCommands.has(command)) {
      return {
        ok: false,
        code: "command_not_allowed",
        message: `command is not in allowlist: ${commandInput}`,
        command: command,
      };
    }
    const commandArgs = normalizeSandboxedArgs(args?.args);
    const timeoutInput = args?.timeoutMs === undefined || args?.timeoutMs === null
      ? sandboxedRunDefaultTimeoutMs
      : Number(args.timeoutMs);
    if (!Number.isFinite(timeoutInput) || timeoutInput <= 0) {
      throw makeToolError("invalid_timeout", "timeoutMs must be a positive number");
    }
    const timeoutMs = clamp(Math.floor(timeoutInput), 1000, sandboxedRunMaxTimeoutMs);
    const policyDecision = await resolveSandboxedRunApprovalPolicy(command, commandArgs);
    const requiresApproval = policyDecision.approval !== "none";
    const requestApproval = typeof ctx.requestToolApproval === "function"
      ? ctx.requestToolApproval
      : null;
    if (requiresApproval && !requestApproval) {
      throw new Error("run_command_sandboxed requires interactive approval over /stream-tts");
    }
    if (requiresApproval) {
      const approval = await requestApproval({
        callId: String(opts.callId || ""),
        toolName: "run_command_sandboxed",
        command,
        args: commandArgs,
        reason: "コマンド実行のため",
        cwd: String(args?.cwd || "."),
        timeoutMs,
        approvalKey: policyDecision.key,
        approvalMode: policyDecision.approval,
        sessionId: String(ctx?.sessionId || ""),
        message: `「${buildCommandPreview(command, commandArgs)}」を実行しようとしています。\n許可しますか？`,
      });
      if (!approval?.approved) {
        const note = String(approval?.note || "").trim();
        throw makeToolError(
          "permission_denied",
          note ? `run_command_sandboxed denied by user: ${note}` : "run_command_sandboxed denied by user"
        );
      }
    }
    const cwdResolved = await resolvePathWithinToolRoot(ctx.rootReal, args?.cwd, { defaultPath: "." });
    const cwdStat = await fs.stat(cwdResolved.realPath);
    if (!cwdStat.isDirectory()) {
      throw makeToolError("not_a_directory", "cwd is not a directory", { cwd: cwdResolved.relativePath });
    }
    const result = await runCommandWithCapture(command, commandArgs, {
      cwd: cwdResolved.realPath,
      timeoutMs,
      maxOutputBytes: sandboxedRunMaxOutputBytes,
      env: buildCommandExecutionEnv({
        llmSessionId: String(ctx?.sessionId || ""),
      }),
    });
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      command,
      args: commandArgs,
      approval: requiresApproval ? "approved" : "skipped_by_policy",
      approvalKey: policyDecision.key,
      cwd: cwdResolved.relativePath,
      timeoutMs,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      code: result.timedOut ? "timed_out" : (result.exitCode === 0 ? "ok" : "command_failed"),
      message: result.timedOut
        ? `command timed out after ${timeoutMs}ms`
        : (result.exitCode === 0 ? "ok" : `command exited with code ${result.exitCode}`),
    };
  }

  async function detectDefaultTestCommand(rootReal) {
    const custom = String(process.env.RUN_TESTS_DEFAULT_COMMAND || "").trim();
    if (custom) {
      const parts = splitCommandLine(custom);
      if (parts.length > 0) {
        return { command: parts[0], args: parts.slice(1), source: "env" };
      }
    }
    if (await pathExists(path.join(rootReal, "package.json"))) {
      return { command: "npm", args: ["test", "--silent"], source: "package.json" };
    }
    if (await pathExists(path.join(rootReal, "pytest.ini")) || await pathExists(path.join(rootReal, "pyproject.toml"))) {
      return { command: "pytest", args: ["-q"], source: "pytest" };
    }
    if (await pathExists(path.join(rootReal, "go.mod"))) {
      return { command: "go", args: ["test", "./..."], source: "go.mod" };
    }
    if (await pathExists(path.join(rootReal, "Cargo.toml"))) {
      return { command: "cargo", args: ["test", "--quiet"], source: "Cargo.toml" };
    }
    return null;
  }

  async function runTestsTool(args, ctx) {
    const target = String(args?.target || "").trim();
    let command = "";
    let commandArgs = [];
    let selectedBy = "";
    if (target) {
      const parts = splitCommandLine(target);
      if (parts.length === 0) {
        throw makeToolError("invalid_target", "target must not be empty");
      }
      command = String(parts[0] || "").trim();
      commandArgs = parts.slice(1);
      selectedBy = "target";
    } else {
      const detected = await detectDefaultTestCommand(ctx.rootReal);
      if (!detected) {
        return {
          ok: false,
          code: "no_test_command",
          message: "no default test command found; provide target",
          command: "",
          args: [],
          cwd: ".",
          exitCode: 127,
          stdout: "",
          stderr: "",
        };
      }
      command = detected.command;
      commandArgs = detected.args;
      selectedBy = detected.source;
    }

    if (!command || /[/\\]/.test(command)) {
      throw makeToolError("invalid_target", "target command must not include path separators");
    }
    const commandLower = command.toLowerCase();
    if (!sandboxedRunAllowedCommands.has(commandLower) || sandboxedRunDenyCommands.has(commandLower)) {
      return {
        ok: false,
        code: "command_not_allowed",
        message: `test command is not allowed: ${command}`,
        command: commandLower,
        args: commandArgs,
        cwd: ".",
        exitCode: 127,
        stdout: "",
        stderr: "",
      };
    }
    const normalizedArgs = normalizeSandboxedArgs(commandArgs);
    const timeoutMs = clamp(runTestsDefaultTimeoutMs, 1000, runTestsMaxTimeoutMs);
    const result = await runCommandWithCapture(commandLower, normalizedArgs, {
      cwd: ctx.rootReal,
      timeoutMs,
      maxOutputBytes: Math.max(sandboxedRunMaxOutputBytes, 256 * 1024),
    });
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      command: commandLower,
      args: normalizedArgs,
      cwd: ".",
      selectedBy,
      timeoutMs,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.timedOut ? "timed_out" : (result.exitCode === 0 ? "ok" : "tests_failed"),
      message: result.timedOut
        ? `tests timed out after ${timeoutMs}ms`
        : (result.exitCode === 0 ? "ok" : `tests exited with code ${result.exitCode}`),
    };
  }

  function extractChangedFilesFromDiffText(diffText) {
    const out = [];
    const seen = new Set();
    const lines = String(diffText || "").split(/\r?\n/);
    for (const line of lines) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (!match) continue;
      const filePath = String(match[2] || match[1] || "").trim();
      if (!filePath) continue;
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      out.push(filePath);
    }
    return out;
  }

  async function runGitDiffTool(args, ctx) {
    const staged = Boolean(args?.staged);
    const diffArgs = ["-C", ctx.rootReal, "diff", "--no-color", "--minimal"];
    if (staged) diffArgs.push("--staged");
    let relativeTargetPath = ".";
    if (args?.path !== undefined && args?.path !== null && String(args.path).trim() !== "") {
      const resolved = await resolvePathWithinToolRoot(ctx.rootReal, args.path, {
        defaultPath: ".",
        allowMissing: true,
      });
      relativeTargetPath = resolved.relativePath;
    }
    diffArgs.push("--", relativeTargetPath);
    const result = await runCommandWithCapture("git", diffArgs, {
      timeoutMs: Math.max(30000, sandboxedRunDefaultTimeoutMs),
      maxOutputBytes: Math.max(sandboxedRunMaxOutputBytes, 512 * 1024),
    });
    const diffText = result.stdout || "";
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      staged,
      path: relativeTargetPath,
      command: "git",
      args: diffArgs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      diffText,
      changedFiles: extractChangedFilesFromDiffText(diffText),
      stderr: result.stderr,
      code: result.timedOut ? "timed_out" : (result.exitCode === 0 ? "ok" : "git_diff_failed"),
      message: result.timedOut
        ? "git diff timed out"
        : (result.exitCode === 0 ? "ok" : "git diff failed"),
    };
  }

  return {
    runCommandSandboxedTool,
    runEditFileTool,
    runGitDiffTool,
    runMediaTool,
    runTestsTool,
    runWriteFileTool,
  };
}
