import { recordRunnerConnectionRejected } from "./runner-connection-events.mjs";

function parseRequestUrl(req) {
  try {
    return new URL(String(req?.url || "/"), "http://runner.local");
  } catch {
    return new URL("http://runner.local/");
  }
}

function bearerToken(req) {
  const [kind, token] = String(req?.headers?.authorization || "").split(" ");
  return kind === "Bearer" && token ? token : "";
}

function routeFor(pathname, runnerWsPath) {
  if (pathname === runnerWsPath) return "runner-ws";
  if (pathname === "/codex-ws") return "codex-ws-proxy";
  if (pathname === "/stream-tts") return "stream-tts";
  return "unsupported-ws";
}

function rejectUpgrade({ req, socket, appendDebug, route, endpoint, reason, status }) {
  const remoteAddress = String(req?.socket?.remoteAddress || "unknown");
  void appendDebug("upgrade_rejected", { remoteAddress, endpoint, reason });
  recordRunnerConnectionRejected(req, { route, endpoint, reason });
  if (status) socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
  socket.destroy();
}

export function installRunnerWebSocketUpgradeHandler({
  server,
  runnerToken,
  runnerWsPath,
  runnerWsServer,
  streamTtsWsServer,
  codexProxyWsServer,
  appendDebug,
  logRequests = false,
}) {
  server.on("upgrade", (req, socket, head) => {
    const reqUrl = parseRequestUrl(req);
    const endpoint = reqUrl.pathname;
    const route = routeFor(endpoint, runnerWsPath);
    const remoteAddress = String(req?.socket?.remoteAddress || "unknown");
    const authToken = bearerToken(req);
    const queryToken = String(reqUrl.searchParams.get("token") || "").trim();
    const providedToken = authToken;

    if (logRequests) console.log(`[request] WS ${endpoint} from ${remoteAddress}`);
    void appendDebug("upgrade_request", {
      remoteAddress,
      endpoint,
      host: String(req?.headers?.host || ""),
      hasAuthHeaderToken: !!authToken,
      hasQueryToken: !!queryToken,
      tokenSource: authToken ? "authorization" : (queryToken ? "query_rejected" : "none"),
      tokenLength: providedToken.length,
    });

    if (route === "unsupported-ws") {
      rejectUpgrade({ req, socket, appendDebug, route, endpoint, reason: "path_not_supported" });
      return;
    }
    if (!runnerToken) {
      rejectUpgrade({
        req,
        socket,
        appendDebug,
        route,
        endpoint,
        reason: "runner_token_missing",
        status: "500 Internal Server Error",
      });
      return;
    }
    if (!providedToken || providedToken !== runnerToken) {
      rejectUpgrade({
        req,
        socket,
        appendDebug,
        route,
        endpoint,
        reason: providedToken ? "token_mismatch" : "token_missing",
        status: "401 Unauthorized",
      });
      return;
    }

    void appendDebug("upgrade_accepted", { remoteAddress, endpoint, route });
    const wsServer = route === "runner-ws"
      ? runnerWsServer
      : (route === "codex-ws-proxy" ? codexProxyWsServer : streamTtsWsServer);
    wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit("connection", ws, req));
  });
}
