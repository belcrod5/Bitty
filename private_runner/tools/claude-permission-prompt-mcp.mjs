#!/usr/bin/env node
// Claude CLIが`--permission-prompt-tool`で子processとしてspawnする最小のMCPサーバー。
// stdin/stdoutでnewline区切りJSON-RPC 2.0を話し、承認要求をBITTY_PERMISSION_SOCKET
// (Unix socket)経由でrunner側のpermission bridgeへ転送する。依存パッケージなし
// (node標準libのみ)。仕様は設計書§4.4を参照。
import net from "node:net";
import readline from "node:readline";

const SOCKET_PATH = String(process.env.BITTY_PERMISSION_SOCKET || "");
const TOKEN = String(process.env.BITTY_PERMISSION_TOKEN || "");
const FALLBACK_PROTOCOL_VERSION = "2024-11-05";
// bridge側の用途はtitleの300字要約のみ。大きなWrite等が256KBの行上限で無告知denyされる
// 事態を避け、内容の越境も最小化するため、socketへ送るinputは2KBへ切り詰める。
const INPUT_TRUNCATE_BYTES = 2048;

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function truncatedInput(rawInput) {
  let serialized;
  try {
    serialized = JSON.stringify(rawInput ?? {});
  } catch {
    serialized = String(rawInput ?? "");
  }
  if (Buffer.byteLength(serialized, "utf8") <= INPUT_TRUNCATE_BYTES) return rawInput ?? {};
  return { _truncated: true, preview: serialized.slice(0, INPUT_TRUNCATE_BYTES) };
}

// socket接続失敗・応答不正・切断は全てdeny(fail closed)。shim自身はタイムアウトを
// 持たない(承認待ちは無期限。打ち切りはrunner側のturn管理が担う)。
function requestApproval(toolName, input, toolUseId) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (decision, message) => {
      if (settled) return;
      settled = true;
      resolve({ decision, message });
    };
    if (!SOCKET_PATH) {
      finish("deny", "permission bridge is not configured");
      return;
    }
    let buffer = "";
    const socket = net.createConnection(SOCKET_PATH);
    socket.on("connect", () => {
      socket.end(`${JSON.stringify({ token: TOKEN, toolName, input: truncatedInput(input), toolUseId })}\n`);
    });
    socket.on("data", (chunk) => { buffer += chunk.toString("utf8"); });
    socket.on("error", () => finish("deny", "permission bridge connection failed"));
    socket.on("close", () => {
      const line = buffer.split("\n")[0] || "";
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        finish("deny", "permission bridge response was invalid");
        return;
      }
      finish(parsed?.decision === "allow" ? "allow" : "deny", parsed?.message);
    });
  });
}

async function handleRequest(message) {
  const id = message?.id;
  const method = String(message?.method || "");
  const params = message?.params || {};
  if (method === "initialize") {
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || FALLBACK_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "bitty-permission-prompt", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return; // 応答なし
  if (method === "tools/list") {
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [{
          name: "approval_prompt",
          description: "Ask the user to approve or deny a pending tool call",
          inputSchema: { type: "object", additionalProperties: true },
        }],
      },
    });
    return;
  }
  if (method === "tools/call") {
    const args = params?.arguments || {};
    const { decision, message: denyMessage } = await requestApproval(
      String(args.tool_name || ""),
      args.input,
      String(args.tool_use_id || ""),
    );
    // allow時のupdatedInputは切り詰め前の完全なinput(手元にあるargs.input)を使う。
    // socketへ送った切り詰め版はbridge側の要約用途にのみ使われる。
    const text = decision === "allow"
      ? JSON.stringify({ behavior: "allow", updatedInput: args.input ?? {} })
      : JSON.stringify({ behavior: "deny", message: denyMessage || "Denied by user" });
    writeMessage({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    return;
  }
  // 未知method(CLIのping等)。idがあれば空resultで応答し、CLI側を落とさない。
  if (id !== undefined) writeMessage({ jsonrpc: "2.0", id, result: {} });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  // tools/callは応答待ちで読み取りループを塞がない。各callを並行処理する
  // (subagentの並列承認がshim側で直列化しないため)。
  void handleRequest(message).catch(() => {});
});
// stdinのclose/endでprocessをexitする(CLI死亡時の残骸防止)。
rl.on("close", () => process.exit(0));
