import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import net from "node:net";
import { readBrowserControlNativeKey } from "./browser-control-native-auth.mjs";

// Chrome owns stdin/stdout. stdout contains Native Messaging frames only.
export async function runBrowserControlNativeHost(config) {
  if (process.argv[2] !== config.extensionOrigin || !/^chrome-extension:\/\/[a-p]{32}\/$/.test(config.extensionOrigin)) throw new Error("native_host_origin_invalid");
  const { WebSocket } = createRequire(import.meta.url)("ws");
  let socket, retry, stopped = false, header = Buffer.alloc(4), headerSize = 0, body = null, bodySize = 0;
  const write = (payload) => {
    if (stopped || process.stdout.destroyed) return;
    const data = Buffer.from(JSON.stringify(payload));
    if (data.length > 1024 * 1024) { stop(); return; }
    const prefix = Buffer.alloc(4); prefix.writeUInt32LE(data.length);
    if (!process.stdout.write(Buffer.concat([prefix, data]))) socket?.pause();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true; clearTimeout(retry); body = null; header = null;
    socket?.terminate(); process.stdin.destroy();
  };
  const forward = (data) => {
    const payload = JSON.parse(data.toString("utf8"));
    if (!payload || !["reply", "cdp", "closed"].includes(payload.type)) throw new Error();
    // Native results are never queued across a Runner connection change.
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 3 * 1024 * 1024) throw new Error();
    socket.send(JSON.stringify(payload));
  };
  process.stdin.on("data", (data) => {
    try {
      let offset = 0;
      while (offset < data.length && !stopped) {
        if (!body) {
          const size = Math.min(4 - headerSize, data.length - offset);
          data.copy(header, headerSize, offset, offset + size); headerSize += size; offset += size;
          if (headerSize < 4) continue;
          const length = header.readUInt32LE(); headerSize = 0;
          if (length < 2 || length > 3 * 1024 * 1024) throw new Error();
          body = Buffer.allocUnsafe(length); bodySize = 0;
        }
        const size = Math.min(body.length - bodySize, data.length - offset);
        data.copy(body, bodySize, offset, offset + size); bodySize += size; offset += size;
        if (bodySize === body.length) { const complete = body; body = null; forward(complete); }
      }
    } catch { process.stderr.write("bitty_browser_host_invalid_message\n"); stop(); }
  });
  process.stdin.on("end", stop); process.stdin.on("error", stop); process.stdout.on("error", stop);
  process.stdout.on("drain", () => socket?.resume());
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  async function connect() {
    if (stopped) return;
    try {
      const parent = await fs.lstat(path.dirname(config.socketPath)), socketInfo = await fs.lstat(config.socketPath);
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700
        || !socketInfo.isSocket() || socketInfo.uid !== process.getuid() || (socketInfo.mode & 0o777) !== 0o600) throw new Error();
      const token = await readBrowserControlNativeKey(config.keyPath);
      if (stopped) return;
      socket = new WebSocket("ws://localhost/browser-extension", { createConnection: () => net.createConnection(config.socketPath), followRedirects: false, handshakeTimeout: 5000, maxPayload: 1024 * 1024,
        headers: { authorization: `Bearer ${token}` } });
      socket.on("open", () => socket.send(JSON.stringify({ type: "hello", version: 1 })));
      socket.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw));
          if (["ready", "reset", "discover", "attach", "cdp", "detach"].includes(message?.type)) write(message);
        } catch { stop(); }
      });
      socket.on("error", () => {});
      socket.once("close", () => {
        write({ type: "reset" });
        if (!stopped) retry = setTimeout(connect, 3000);
      });
    } catch {
      if (!stopped) retry = setTimeout(connect, 3000);
    }
  }
  void connect();
  return stop;
}
