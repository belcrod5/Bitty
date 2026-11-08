import { recordRunnerConnectionRejected } from "./runner-connection-events.mjs";


function parseRequestUrl(req) {
  try {
    return new URL(String(req?.url || "/"), "http://runner.local");
  } catch {
    return new URL("http://runner.local/");
  }
}

function routeFor(pathname, runnerWsPath) {
  if (pathname === runnerWsPath) return "runner-ws";
  if (pathname === "/stream-tts") return "stream-tts";
  if (pathname === "/stream-stt") return "stream-stt";
  return "unsupported-ws";
}

function rejectUpgrade({ req, socket, appendDebug, route, endpoint, reason, status, tokenDiag }) {
  const remoteAddress = String(req?.socket?.remoteAddress || "unknown");
  void appendDebug("upgrade_rejected", { remoteAddress, endpoint, reason, ...tokenDiag });
  recordRunnerConnectionRejected(req, { route, endpoint, reason });
  if (status) socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
  socket.destroy();
}

export function installRunnerWebSocketUpgradeHandler({
  server,
  authenticate,
  attachSocket,
  runnerWsPath,
  runnerWsServer,
  streamTtsWsServer,
  streamSttWsServer,
  appendDebug,
  logRequests = false,
}) {
  server.on("upgrade", async (req, socket, head) => {
    const reqUrl = parseRequestUrl(req);
    const endpoint = reqUrl.pathname;
    const route = routeFor(endpoint, runnerWsPath);
    const remoteAddress = String(req?.socket?.remoteAddress || "unknown");
    const tokenDiag = {};
    if (logRequests) console.log(`[request] WS ${endpoint} from ${remoteAddress}`);
    if (route === "unsupported-ws") {
      rejectUpgrade({ req, socket, appendDebug, route, endpoint, reason: "path_not_supported", tokenDiag });
      return;
    }
    let context;
    try {
      if (!authenticate) throw new Error("authentication_required");
      context = await authenticate(req);
    } catch {
      rejectUpgrade({ req, socket, appendDebug, route, endpoint, reason: "authentication_required", status: "401 Unauthorized", tokenDiag });
      return;
    }
    if (socket.destroyed) return;
    void appendDebug("upgrade_accepted", { remoteAddress, endpoint, route });
    const wsServer = route === "runner-ws"
      ? runnerWsServer
      : route === "stream-stt"
        ? streamSttWsServer
        : streamTtsWsServer;
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      attachSocket?.(ws, context);
      wsServer.emit("connection", ws, req);
    });
  });
}
