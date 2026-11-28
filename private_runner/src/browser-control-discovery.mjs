import { promises as fs } from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";

const fail = (code = "chrome_discovery_unavailable") => Object.assign(new Error(code), { code });

// DevToolsActivePort also works with user-enabled Chrome, whose /json endpoints return 404.
export async function readBrowserControlEndpoint(userDataDir) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) throw fail();
  let file;
  try { file = await fs.open(path.join(userDataDir, "DevToolsActivePort"), "r"); } catch { throw fail("chrome_debugging_not_enabled"); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > 4096) throw fail("chrome_debugging_endpoint_invalid");
    const buffer = Buffer.alloc(4097), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const [port, endpoint, ...rest] = buffer.toString("utf8", 0, bytesRead).trimEnd().split("\n");
    if (bytesRead > 4096 || rest.length || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535
      || !/^\/devtools\/browser\/[A-Za-z0-9_-]{1,200}$/.test(endpoint)) throw fail("chrome_debugging_endpoint_invalid");
    return `ws://127.0.0.1:${port}${endpoint}`;
  } finally { await file.close(); }
}

// One explicit discovery before a panel exists. Never titles, full URLs, DOM, values or images.
export async function discoverBrowserControlTargets(cdpUrl, origin, { connectTimeoutMs = 60_000, timeoutMs = 5000 } = {}) {
  const endpoint = new URL(cdpUrl), expected = new URL(origin);
  if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !/^\/devtools\/browser\/[A-Za-z0-9_-]{1,200}$/.test(endpoint.pathname)
    || !["https:", "http:"].includes(expected.protocol) || expected.origin !== origin) throw fail();
  const socket = new WebSocket(endpoint, { followRedirects: false, maxPayload: 1024 * 1024 });
  try {
    return await new Promise((resolve, reject) => {
      let timer = setTimeout(() => reject(fail("chrome_permission_timeout")), connectTimeoutMs);
      const finish = (error, value) => { clearTimeout(timer); error ? reject(fail()) : resolve(value); };
      socket.on("error", () => finish(true)); socket.on("close", () => finish(true));
      socket.once("open", () => {
        clearTimeout(timer); timer = setTimeout(() => finish(true), timeoutMs);
        socket.send(JSON.stringify({ id: 1, method: "Target.getTargets", params: { filter: [{ type: "page" }, { exclude: true }] } }));
      });
      socket.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw));
          if (message.id !== 1) return;
          if (message.error || message.sessionId || !Array.isArray(message.result?.targetInfos) || message.result.targetInfos.length > 1000) return finish(true);
          const targets = message.result.targetInfos.filter((info) => {
            if (info.type !== "page" || typeof info.targetId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(info.targetId)) return false;
            try { return new URL(info.url).origin === origin; } catch { return false; }
          }).map(({ targetId }) => ({ targetId, origin }));
          if (targets.length > 100) return finish(true);
          finish(false, { targets });
        } catch { finish(true); }
      });
    });
  } finally { socket.terminate(); }
}
