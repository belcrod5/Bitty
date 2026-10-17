// Run the real voice service in a disposable, worktree-local Git root. Review Markdown by eye.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexAppServerClient } from "../src/codex-app-server-client.mjs";
import { createVoiceContextService } from "../src/voice-context-service.mjs";

const base = fileURLToPath(new URL("../../tmp/", import.meta.url));
const scenario = process.argv[2] || "code";
if (!["code", "mail", "legacy", "managed", "native", "progress", "overview", "repair", "repair-progress", "repair-progress-alt"].includes(scenario) || process.argv.length > 3) {
  throw new Error("Usage: node voice-task-checklist-product-probe.mjs [code|mail|legacy|managed|native|progress|overview|repair|repair-progress|repair-progress-alt]");
}
const run = path.join(base, `voice-checklist-product-${randomUUID()}`);
const rootDir = path.join(run, "voice_context", "v1");
const codexHome = path.join(run, "codex-home");
const scratch = path.join(run, "scratch");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Turn timed out")), ms);
  })]); }
  finally { clearTimeout(timer); }
}
await fs.mkdir(run, { recursive: true, mode: 0o700 });
await fs.mkdir(codexHome, { mode: 0o700 });
await fs.mkdir(scratch, { mode: 0o700 });
await fs.writeFile(path.join(codexHome, "config.toml"),
  '[mcp_servers.probe]\ncommand = "/bin/false"\n', { mode: 0o600 });
execFileSync("git", ["init", "--quiet", "--template=", run]);
const auth = path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), "auth.json");
await fs.symlink(auth, path.join(codexHome, "auth.json"));
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const child = spawn("codex", ["app-server", "--listen", `ws://127.0.0.1:${port}`,
  "-c", "features.apps=false", "-c", "features.plugins=false", "-c", "web_search=disabled",
  "-c", "apps._default.enabled=false", "-c", "agents.enabled=false"], {
  cwd: run, env: { PATH: process.env.PATH, HOME: process.env.HOME,
    CODEX_HOME: codexHome, TMPDIR: scratch }, stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-1000); });
const evidence = [];
const createClient = () => {
  const preflightTurns = new Set();
  const client = createCodexAppServerClient({ upstreamUrl: `ws://127.0.0.1:${port}`,
    turnCompletionTimeoutMs: 120000 });
  const originalRequest = client.request.bind(client);
  client.request = async (method, params, timeout) => {
    if (["thread/start", "thread/resume"].includes(method) && params?.approvalPolicy === "on-request") {
      evidence.push({ method, hasChecklistInstruction: params.developerInstructions?.includes("task-checklists/main.md"),
        hasNewParentReadInstruction: params.developerInstructions?.includes("新しい親セッションでは"),
        sandbox: params.sandbox, agentsEnabled: params.config?.agents?.enabled,
        dynamicToolCount: params.dynamicTools?.length || 0 });
    }
    if (method === "thread/start" && params?.developerInstructions?.startsWith("Summarize the entire supplied task checklist")) {
      evidence.push({ method: "overviewThread", model: params.model, ephemeral: params.ephemeral,
        sandbox: params.sandbox });
    }
    if (method === "turn/start" && params?.input?.[0]?.text?.startsWith("# 架空作業の原本")) {
      evidence.push({ method: "overviewTurn", model: params.model, effort: params.effort,
        sandboxPolicy: params.sandboxPolicy });
    }
    const result = await originalRequest(method, params, timeout);
    if (method === "config/read") evidence.push({ method, mcpNames: Object.keys(result.config?.mcp_servers || {}) });
    if (["thread/start", "thread/resume"].includes(method) && params?.approvalPolicy === "on-request") {
      evidence.push({ method: "threadReady", threadId: result.thread?.id });
      if (method === "thread/resume" && !params.dynamicTools?.length) {
        const status = await originalRequest("mcpServerStatus/list", { threadId: result.thread.id, cursor: null }, 30000);
        evidence.push({ method: "normalMcpStatus", servers: status.data?.map(({ name, runtimeStatus }) =>
          ({ name, runtimeStatus })) });
      }
    }
    if (method === "mcpServerStatus/list") {
      evidence.push({ method, servers: result.data?.map(({ name, runtimeStatus, tools }) => ({
        name, runtimeStatus, tools: Object.keys(tools || {}),
      })) });
    }
    if (method === "turn/start" && params?.sandboxPolicy?.type === "readOnly") {
      preflightTurns.add(result.turn?.id);
      evidence.push({ method: "preflightTurn", turnId: result.turn?.id,
        sandboxPolicy: params.sandboxPolicy });
    }
    return result;
  };
  const originalListener = client.addNotificationListener.bind(client);
  client.addNotificationListener = (callback) => originalListener((method, params) => {
    if (preflightTurns.has(params?.turnId) && method.startsWith("item/")
      && ["item/started", "item/completed", "item/failed"].includes(method)) {
      evidence.push({ method: "preflightItem", event: method, type: params.item?.type,
        id: params.item?.id, command: params.item?.command,
        exitCode: params.item?.exitCode, status: params.item?.status });
    }
    if (method === "item/completed" && params?.item?.type === "agentMessage"
      && preflightTurns.has(params.turnId)) {
      evidence.push({ method: "preflightMessage", text: String(params.item.text || "").slice(0, 500) });
    }
    if (["item/started", "item/completed", "item/failed"].includes(method)
      && ["fileChange", "commandExecution"].includes(params?.item?.type)) {
      evidence.push({ method, type: params.item.type, id: params.item.id,
        command: params.item.command, exitCode: params.item.exitCode,
        ...(params.item.type === "commandExecution" && params.item.command === "/bin/zsh -lc 'cat task-checklists/main.md'"
          && method === "item/completed" ? { readOutput: params.item.aggregatedOutput } : {}),
        changes: params.item.changes?.map(({ path: file, kind }) => ({ path: file, kind: kind?.type })) });
    }
    if (["item/started", "item/completed", "item/failed"].includes(method)
      && ["collabAgentToolCall", "subAgentActivity"].includes(params?.item?.type)) {
      evidence.push({ method, type: params.item.type, kind: params.item.kind, status: params.item.status,
        receiverThreadIds: params.item.receiverThreadIds, agentThreadId: params.item.agentThreadId });
    }
    callback(method, params);
  });
  const originalRequestHandler = client.addServerRequestHandler.bind(client);
  client.addServerRequestHandler = (callback) => originalRequestHandler(async (request) => {
    const result = await callback(request);
    if (request.method === "item/tool/call") evidence.push({ method: request.method,
      namespace: request.params?.namespace, tool: request.params?.tool,
      callId: request.params?.callId, success: result?.success,
      ...(request.params?.namespace === "task_checklist" && request.params?.tool === "write_task_checklist"
        ? { authoredMarkdown: request.params?.arguments?.markdown } : {}),
      content: result?.contentItems?.map((item) => item.text?.slice(0, 100)) });
    if (request.method?.endsWith("/requestApproval")) evidence.push({ method: request.method,
      itemId: request.params?.itemId, decision: result?.decision });
    return result;
  });
  return client;
};
let service;
const managedSessions = scenario === "managed" ? {
  refresh: async () => ({ records: [] }), contextOf: () => "",
  handleTool: async (request) => {
    evidence.push({ method: "managedToolHandled", namespace: request.params?.namespace,
      tool: request.params?.tool });
    return { success: true, contentItems: [{ type: "inputText", text: "No delegated sessions" }] };
  },
} : undefined;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`App Server exited: ${stderr}`);
    const ready = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (ready) break;
    if (attempt === 99) throw new Error(`App Server did not listen: ${stderr}`);
    await pause(100);
  }
  const onChecklistChanged = () => evidence.push({ method: "checklistChanged" });
  service = createVoiceContextService({ rootDir, createClient, managedSessions, onChecklistChanged,
    ...(scenario === "legacy" ? {} : { taskChecklistPath: "task-checklists/main.md" }) });
  let conversation = await service.open();
  await service.configure("gpt-6.1-sol", "low");
  const workspace = await service.getWorkspaceDirectory();
  const checklist = path.join(workspace, "task-checklists", "main.md");
  let repairOriginal = "";
  async function turn(label, text) {
    const operationId = randomUUID();
    let finish;
    const terminal = new Promise((resolve) => { finish = resolve; });
    const request = { operationId, payload: { backendId: "codex",
      logicalConversationId: conversation.logicalConversationId, clientOperationId: operationId,
      input: { blocks: [{ type: "text", text }] } } };
    const start = await service.start(request, finish, async () => "decline");
    if (start.status === "confirmation_required") throw new Error("Unexpected reset confirmation");
    const result = await within(terminal, 120000);
    const markdown = await fs.readFile(checklist, "utf8").catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    const row = { scenario, label, status: result.status, code: result.code,
      response: result.text, ...(repairOriginal ? { original: repairOriginal } : {}),
      markdown, events: evidence.splice(0) };
    await fs.appendFile(path.join(run, "evidence.jsonl"), `${JSON.stringify(row)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(row));
    if (result.status !== "completed") throw new Error(`${label} failed: ${result.code}`);
  }
  if (scenario === "overview") {
    const original = "# 架空作業の原本\n- P-21の調査は完了と確認済み\n- P-22の結果確認を進行中\n- P-23は次に着手予定\n";
    await fs.writeFile(checklist, original, { mode: 0o600 });
    service = createVoiceContextService({ rootDir, createClient, onChecklistChanged,
      taskChecklistPath: "task-checklists/main.md" });
    await service.open();
    let history;
    for (let attempt = 0; attempt < 120; attempt++) {
      history = await service.history();
      if (history.taskChecklistOverview?.status === "present") break;
      await pause(1000);
    }
    if (history?.taskChecklistOverview?.status !== "present") throw new Error("Overview did not appear");
    if (await fs.readFile(checklist, "utf8") !== original) throw new Error("Overview changed the original");
    const row = { scenario, original, overview: history.taskChecklistOverview.markdown, events: evidence.splice(0) };
    await fs.appendFile(path.join(run, "evidence.jsonl"), `${JSON.stringify(row)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(row));
  } else if (["repair", "repair-progress", "repair-progress-alt"].includes(scenario)) {
    repairOriginal = (scenario === "repair-progress-alt" ? [
      "# 架空の移設目標: 権限を確認してから資料を共有する",
      "- Q-01の診断ログL09は存在するが、内容はまだ読んでいない",
      "- Q-02の権限付与は申請したが、承認結果が不明",
      "- Q-03のバックアップC7は復元試験完了と確認済み",
      "- Q-04は3端末中2端末で表示確認済み、残り1端末は未確認",
      "- Q-05の通知文案には個人名があり、削除待ち",
      "- Q-06のA案は期限が短いが監査記録が不足",
      "- Q-07のB案には監査記録があるが、採否は未決",
      "- Q-08の結果不明の送信操作は再実行しない",
      "- Q-09の次の一手は既存の承認記録を読む",
      "- Q-10の公開は最終承認まで停止",
      "- Q-11のファイルXのチェックサムab12は記録済み、検証は未実施",
      "- Q-12の作業者への連絡は下書きのみで、まだ送信していない",
    ] : [
      "# 架空の公開作業の目標: 未確認の結果を再実行せず調べ、安全に公開する",
      "- P-01の入力検証はレビュー記録R-11で完了確認済み",
      "- P-02の権限境界は設計案Aを検討中で、最終判断はまだ",
      "- P-03の削除操作は実行した可能性があるが、結果を取得できていない",
      "- P-04の差分確認はmainとfeatureの比較で完了確認済み",
      "- P-05の履歴移行は利用者の許可待ちで着手しない",
      "- P-06の通知仕様はiOSとmacOSの両方を確認する予定",
      "- P-07の失敗記録には時刻09:14とコードE7が残っている",
      "- P-08の再実行はP-03の結果が判明するまで保留",
      "- P-09のUI文言は原本と概要の区別を説明する必要がある",
      "- P-10のアクセシビリティはチェック状態の読み上げを検証中",
      "- P-11のバックアップB-42は存在を確認済み、復元試験は未実施",
      "- P-12の古い設定値は安全に読めるが、保存互換性は未確認",
      "- P-13のログには個人情報を追加しない方針を確認済み",
      "- P-14の外部API契約は変更しない予定で、関係者確認が必要",
      "- P-15のテストT-8は実行済みだが終了コードの記録が欠けている",
      "- P-16のテストT-9は失敗を確認し、原因を調査中",
      "- P-17の競合対策は二重書込の再現手順を残している",
      "- P-18のキャッシュは原本hashと一致するときだけ表示する",
      "- P-19の不一致キャッシュは廃棄せず表示から除外する予定",
      "- P-20の作業領域はgit管理下で、共有ログには触れない",
      "- P-21の公開日は未定で、利用者の承認前に配布しない",
      "- P-22の監査証跡は書込イベントとディスク内容を照合中",
      "- P-23の次の一手はP-03の既存記録を読んで結果を確定する",
      "- P-24のその後の一手はP-16の失敗原因を調査する",
    ]).join("\n") + "\n";
    await fs.writeFile(checklist, repairOriginal, { mode: 0o600 });
    await turn("repair_legacy", scenario === "repair-progress-alt"
      ? "架空の進捗です。Q-09の既存承認記録を読み、Q-02の権限付与申請はまだ承認されていないと判明しました。この結果をTo Do原本へ反映してください。他の項目の事実と順序を保ち、資料共有や送信は実行しないでください。"
      : scenario === "repair-progress"
      ? "架空の進捗です。P-03の削除操作は既存監査記録から未実行と確認できました。この結果をTo Do原本へ反映してください。ほかの項目は今の事実と順序を保ち、作業は実行せず、次の一手を短く答えてください。"
      : "架空作業を続けます。原本にある安全な次の一手を短く答えてください。");
  } else if (scenario === "progress") {
    await turn("progress_started", "架空のP-21調査を進めています。まだ結果は未確認です。メインのTo Do原本に未完了として記録してください。ここで他の操作は不要です。");
    await turn("progress_confirmed", "架空のP-21調査結果を確認し、完了が確定しました。To Do原本を今すぐ完了へ更新してください。ここで他の操作は不要です。");
  } else if (scenario === "managed") {
    await turn("managed_status", "架空の作業を開始します。まず voice_subagent.status ツールを呼び、委任セッションがないか確認してください。その結果と次の一手を task-checklists/main.md に記録してください。");
  } else if (scenario === "native") {
    await turn("native_delegate", "架空の設計作業です。Codex のネイティブサブエージェントを実際に1人起動し、『A案は速いが複雑、B案は少し遅いが単純』を比較して、どちらが保守しやすいか一言だけ検討させてください。外部アクセスやコマンドは不要です。その結果と次の一手を task-checklists/main.md に記録してください。");
    await turn("native_delegate_confirmed", "はい、ネイティブサブエージェントを1人起動して比較させ、結果を task-checklists/main.md に記録してください。これは実行への明示的な許可です。外部アクセスやコマンドは不要です。");
  } else if (scenario === "legacy") {
    await turn("old_parent", "架空作業。A-01は完了済み、A-02は結果不明です。次はA-02の結果確認です。短く返答して。");
    service = createVoiceContextService({ rootDir, createClient, onChecklistChanged,
      taskChecklistPath: "task-checklists/main.md" });
    await service.open();
    await turn("legacy_resume", "架空作業の安全な次の一手を教えて。");
  } else {
  await turn("create", scenario === "code"
    ? "架空コード作業。P-17の入力検証漏れは修正済み。T-01のテスト実行は終わったが、保存された結果は未確認。テストを再実行せず、次は結果を読む。進行中の作業を記録して。"
    : "架空メール整理。M-01からM-06は確認済みで、許可済みのニュースレター整理も成功済み。M-07はユーザー判断待ちなので整理しない。M-08を次に確認する。確定済み、保留、次の一手を記録して。");
  conversation = await service.clearMessages();
  service = createVoiceContextService({ rootDir, createClient, onChecklistChanged,
    taskChecklistPath: "task-checklists/main.md" });
  const reopened = await service.open();
  if (reopened.logicalConversationId !== conversation.logicalConversationId) {
    throw new Error("Service recreation changed the conversation");
  }
  await turn("first_new_parent", scenario === "code"
    ? "先ほどの架空コード作業の安全な次の一手を教えて。"
    : "先ほどの架空メール整理の安全な次の一手を教えて。");
  await turn("uncertain_update", scenario === "code"
    ? "架空の通知: T-01結果の確認を試みたが、結果を取得できず実行済みか不明。再実行せず保留を記録して。"
    : "架空の通知: M-08の模擬確認を試みたが、結果を取得できず実行済みか不明。再実行せず保留を記録して。");
  conversation = await service.clearMessages();
  await turn("second_new_parent", scenario === "code"
    ? "架空コード作業を続けて。結果不明の操作を扱う安全な次の一手は？"
    : "架空メール整理を続けて。結果不明の操作を扱う安全な次の一手は？");
  }
  console.log(JSON.stringify({ workspace, checklist, evidence: path.join(run, "evidence.jsonl") }));
} finally {
  child.kill();
  if (child.exitCode === null) await Promise.race([new Promise((resolve) => child.once("exit", resolve)), pause(2000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
