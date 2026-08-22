import net from "node:net";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";

// shim(claude-permission-prompt-mcp.mjs)↔bridge間の1行の上限。bridge側の用途は
// title要約のみなので、shimが2KBへ切り詰めた入力より十分大きく確保しつつ、無告知の
// 巨大送信は拒否する(§4.3)。
const MAX_LINE_BYTES = 256 * 1024;

async function ensureSocketDirectory(directory) {
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  // 既存ディレクトリを再利用する場合は「ディレクトリであること」「自分の所有であること」
  // を確認してから権限を是正する。他ユーザーが用意した罠ディレクトリへ書き込まない。
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid()) {
    throw new Error("permission bridge socket directory is unsafe");
  }
  await fs.chmod(directory, 0o700);
}

// token比較はtimingSafeEqualで行うが、脅威モデル上はディレクトリの0700+所有者検証が
// 主防御(§4.3)。長さが異なる場合はtimingSafeEqualが例外を投げるため先に弾く。
function tokensMatch(received, expected) {
  const a = Buffer.from(String(received ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// run毎に生成するpermission bridge。Claude CLIの子processであるMCP shimが
// Unix socket経由で承認要求を送ってくる窓口。仕様は設計書§4.3を参照。
export async function createClaudePermissionBridge({
  socketDirectory = path.join(os.tmpdir(), "bitty-claude-perm"),
  onRequest,
} = {}) {
  if (typeof onRequest !== "function") throw new TypeError("onRequest is required");
  await ensureSocketDirectory(socketDirectory);
  const token = randomBytes(32).toString("hex");
  // macOSのsun_path 104byte制限を考慮し、ソケット名は短いランダムhexにする。
  const socketPath = path.join(socketDirectory, `${randomBytes(8).toString("hex")}.sock`);

  // onRequest呼び出し中(=まだ回答を書いていない)接続。close()時に全てdenyへ倒す。
  const pendingConnections = new Set();

  function writeDecision(socket, decision, message) {
    if (socket.destroyed) return;
    try {
      socket.end(`${JSON.stringify({ decision, ...(message ? { message } : {}) })}\n`);
    } catch {}
  }

  // shimはrequest送信直後にwritable側をend()する(一発リクエストの一形態)。
  // allowHalfOpen:falseだと、そのFIN受信でNodeがこちら側の書き込みも自動終了して
  // しまい、onRequestの解決を待って書くはずの応答が書けなくなる。承認待ちが長い
  // (無期限)ケースで特に破綻するため、明示的にhalf-openを許可する。
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        handled = true;
        writeDecision(socket, "deny", "request too large");
        return;
      }
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      handled = true;
      const line = buffer.slice(0, newlineIndex);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        writeDecision(socket, "deny", "invalid request");
        return;
      }
      if (!tokensMatch(message?.token, token)) {
        writeDecision(socket, "deny", "unauthorized");
        return;
      }
      pendingConnections.add(socket);
      Promise.resolve()
        .then(() => onRequest({
          toolName: String(message?.toolName || ""),
          input: message?.input,
          toolUseId: String(message?.toolUseId || ""),
        }))
        .then((result) => {
          if (!pendingConnections.delete(socket)) return; // close()が先に応答済み
          writeDecision(socket, result?.decision === "allow" ? "allow" : "deny", result?.message);
        })
        .catch(() => {
          if (!pendingConnections.delete(socket)) return;
          writeDecision(socket, "deny", "internal error");
        });
    });
    socket.on("error", () => { pendingConnections.delete(socket); });
  });
  // listen前後のacceptエラーでprocessを落とさない(以後は個々のsocket上でhandledする)。
  server.on("error", () => {});

  await new Promise((resolve, reject) => {
    const onListenError = (error) => reject(error);
    server.once("error", onListenError);
    server.listen(socketPath, () => {
      server.removeListener("error", onListenError);
      resolve();
    });
  });

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    for (const socket of pendingConnections) writeDecision(socket, "deny", "bridge closed");
    pendingConnections.clear();
    // 既存接続の完全なclose(EOF往復)を待たない: shim側が読み切らなくてもrunnerの
    // 終了処理をハングさせない。socket unlinkは既存fdの動作へ影響しない。
    server.close();
    await fs.unlink(socketPath).catch(() => {});
  }

  return { socketPath, token, close };
}
