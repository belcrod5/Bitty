import {
  checkReadyzHttp,
  createWebSocketWithOptionalAuth,
  deriveReadyzUrlFromWsUrl,
  normalizeCodexWsInputs,
} from "./helpers";
import {
  NEAR_UNLIMITED_TIMEOUT_MS,
  type CodexAppServerProbeResult,
  type CodexWebSocketHandshakeProbeResult,
} from "./types";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import { runCodexRpcSession } from "./rpcSession";

function shouldRunReadyzPreflight(wsUrl: string): boolean {
  try {
    const parsed = new URL(wsUrl);
    const pathname = String(parsed.pathname || "").trim();
    return !pathname || pathname === "/";
  } catch {
    return false;
  }
}

export async function probeCodexAppServerConnection(options: {
  wsUrl: string;
  wsToken?: string;
  timeoutMs?: number;
  runnerWebSocketManager?: RunnerWebSocketManager;
}): Promise<CodexAppServerProbeResult> {
  const normalized = normalizeCodexWsInputs(options.wsUrl, options.wsToken);
  const wsUrl = normalized.wsUrl;
  const wsToken = normalized.wsToken;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(3000, Math.floor(Number(options.timeoutMs)))
    : NEAR_UNLIMITED_TIMEOUT_MS;
  if (!wsUrl) throw new Error("Codex WebSocket URL is empty");
  const readyzUrl = deriveReadyzUrlFromWsUrl(wsUrl);
  if (readyzUrl && shouldRunReadyzPreflight(wsUrl)) {
    await checkReadyzHttp(readyzUrl, timeoutMs);
  }

  return await runCodexRpcSession<CodexAppServerProbeResult>({
    wsUrl,
    wsToken,
    timeoutMs,
    clientName: "expo-ios-client-probe",
    clientTitle: "Expo iOS Client Probe",
    experimentalApi: false,
    runnerWebSocketManager: options.runnerWebSocketManager,
    run: async (_rpc, initialized = {}) => {
      return {
        userAgent: String(initialized?.userAgent || ""),
        codexHome: String(initialized?.codexHome || ""),
        platformOs: String(initialized?.platformOs || ""),
      };
    },
  });
}

export async function probeCodexWebSocketHandshakeOnly(options: {
  wsUrl: string;
  wsToken?: string;
  timeoutMs?: number;
}): Promise<CodexWebSocketHandshakeProbeResult> {
  const normalized = normalizeCodexWsInputs(options.wsUrl, options.wsToken);
  const wsUrl = normalized.wsUrl;
  const wsToken = normalized.wsToken;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(3000, Math.floor(Number(options.timeoutMs)))
    : NEAR_UNLIMITED_TIMEOUT_MS;
  if (!wsUrl) throw new Error("Codex WebSocket URL is empty");

  const ws = createWebSocketWithOptionalAuth(wsUrl, wsToken);
  const wsLabel = wsToken ? `${wsUrl} (token)` : `${wsUrl} (no-token)`;

  return await new Promise<CodexWebSocketHandshakeProbeResult>((resolve, reject) => {
    let opened = false;
    let finalized = false;
    const timeoutHandle = setTimeout(() => {
      if (finalized) return;
      finalized = true;
      try {
        ws.close();
      } catch {}
      reject(new Error(`Codex WS handshake timeout (${timeoutMs}ms) url=${wsLabel} readyState=${ws.readyState}`));
    }, timeoutMs);

    function finishWithError(message: string) {
      if (finalized) return;
      finalized = true;
      clearTimeout(timeoutHandle);
      reject(new Error(message));
    }

    ws.onopen = () => {
      if (finalized) return;
      opened = true;
      finalized = true;
      clearTimeout(timeoutHandle);
      const readyStateAtOpen = ws.readyState;
      try {
        ws.close();
      } catch {}
      resolve({
        opened: true,
        readyStateAtOpen,
      });
    };

    ws.onerror = (event: any) => {
      const detail = String(event?.message || event?.type || "unknown");
      finishWithError(`Codex WS handshake error: ${detail} url=${wsLabel} readyState=${ws.readyState}`);
    };

    ws.onclose = (event: any) => {
      if (finalized) return;
      const code = Number(event?.code);
      const reason = String(event?.reason || "").trim();
      const wasClean = Boolean(event?.wasClean);
      const codeText = Number.isFinite(code) ? String(code) : "unknown";
      const phase = opened ? "after-open" : "before-open";
      finishWithError(
        `Codex WS handshake closed(${phase}): code=${codeText} reason=${reason || "-"} clean=${wasClean} url=${wsLabel} readyState=${ws.readyState}`
      );
    };
  });
}
