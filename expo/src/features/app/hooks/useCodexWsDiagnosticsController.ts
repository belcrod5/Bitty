import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { Alert, Platform } from "react-native";
import {
  probeCodexAppServerConnection,
  probeCodexWebSocketHandshakeOnly,
  runCodexAppServerTurn,
} from "../../codex/codexAppServerClient";
import type { ApprovalAction, ApprovalRequest } from "../../codex/approvalFlow";
import type { AppScreen, AutoClientLogEntry } from "../types/appTypes";
import {
  deriveRunnerBaseUrlFromCodexWsUrl,
  diagErrorMessage,
  fetchHttpWithTimeout,
  postJsonWithTimeout,
  toCodexHttpEndpoint,
} from "../utils/codexDiagnostics";
import type { CodexApprovalPolicy, ReasoningEffort } from "../utils/settingsParsers";

type UploadCodexWsPreflightLogOptions = {
  phase: string;
  targetWsUrl: string;
  targetWsToken: string;
  extra?: Record<string, unknown>;
};

type UseCodexWsDiagnosticsControllerOptions = {
  defaultCodexWsUrl: string;
  nearUnlimitedTimeoutMs: number;
  executionEnvironment: string;
  isExpoGo: boolean;
  codexWsUrl: string;
  codexWsToken: string;
  runnerToken: string;
  activeScreen: AppScreen;
  autoRecordingState: string;
  autoLastEvent: string;
  ttsLoading: boolean;
  modelRef: string;
  reasoningEffort: ReasoningEffort;
  codexApprovalPolicy: CodexApprovalPolicy;
  codexWsProbeLoading: boolean;
  codexWsDiagLoading: boolean;
  runner8788SuiteLoading: boolean;
  codexWsE2eLoading: boolean;
  codexWsHandshakeProbeLoading: boolean;
  autoClientSessionIdRef: MutableRefObject<string>;
  autoRecordingEnabledRef: MutableRefObject<boolean>;
  ttsPlayingRef: MutableRefObject<boolean>;
  replyLoadingRef: MutableRefObject<boolean>;
  codexHandshakeProbeSocketRef: MutableRefObject<WebSocket | null>;
  baseUrl: () => string;
  normalizedLlmDirectoryForRequest: () => string;
  handleApprovalRequest: (request: ApprovalRequest) => Promise<ApprovalAction> | ApprovalAction;
  setError: Dispatch<SetStateAction<string>>;
  setReplyDebug: Dispatch<SetStateAction<string>>;
  setCodexWsProbeLoading: Dispatch<SetStateAction<boolean>>;
  setCodexWsDiagLoading: Dispatch<SetStateAction<boolean>>;
  setCodexWsDiagStatus: Dispatch<SetStateAction<string>>;
  setRunner8788SuiteLoading: Dispatch<SetStateAction<boolean>>;
  setRunner8788SuiteStatus: Dispatch<SetStateAction<string>>;
  setCodexWsE2eLoading: Dispatch<SetStateAction<boolean>>;
  setCodexWsE2eStatus: Dispatch<SetStateAction<string>>;
  setCodexWsHandshakeProbeLoading: Dispatch<SetStateAction<boolean>>;
  setCodexWsHandshakeProbeStatus: Dispatch<SetStateAction<string>>;
};

export function useCodexWsDiagnosticsController({
  defaultCodexWsUrl,
  nearUnlimitedTimeoutMs,
  executionEnvironment,
  isExpoGo,
  codexWsUrl,
  codexWsToken,
  runnerToken,
  activeScreen,
  autoRecordingState,
  autoLastEvent,
  ttsLoading,
  modelRef,
  reasoningEffort,
  codexApprovalPolicy,
  codexWsProbeLoading,
  codexWsDiagLoading,
  runner8788SuiteLoading,
  codexWsE2eLoading,
  codexWsHandshakeProbeLoading,
  autoClientSessionIdRef,
  autoRecordingEnabledRef,
  ttsPlayingRef,
  replyLoadingRef,
  codexHandshakeProbeSocketRef,
  baseUrl,
  normalizedLlmDirectoryForRequest,
  handleApprovalRequest,
  setError,
  setReplyDebug,
  setCodexWsProbeLoading,
  setCodexWsDiagLoading,
  setCodexWsDiagStatus,
  setRunner8788SuiteLoading,
  setRunner8788SuiteStatus,
  setCodexWsE2eLoading,
  setCodexWsE2eStatus,
  setCodexWsHandshakeProbeLoading,
  setCodexWsHandshakeProbeStatus,
}: UseCodexWsDiagnosticsControllerOptions) {
  function buildDiagEvent(
    sessionId: string,
    seq: number,
    event: string,
    payload: Record<string, unknown>
  ): AutoClientLogEntry {
    return {
      sessionId,
      seq,
      at: new Date().toISOString(),
      event,
      payload,
      screen: activeScreen,
      autoEnabled: autoRecordingEnabledRef.current,
      autoState: autoRecordingState,
      autoEvent: autoLastEvent,
      ttsPlaying: ttsPlayingRef.current,
      ttsLoading,
      replyLoading: replyLoadingRef.current,
    };
  }

  async function testHardcodedCodexWsConnection() {
    if (codexWsProbeLoading) return;
    const targetWsUrl = codexWsUrl.trim() || defaultCodexWsUrl;
    const targetWsToken = codexWsToken.trim();
    setCodexWsProbeLoading(true);
    setError("");
    setReplyDebug(
      `codex_probe:start url=${targetWsUrl} token=${targetWsToken ? "yes" : "no"} env=${executionEnvironment} expoGo=${isExpoGo}`
    );
    try {
      const result = await probeCodexAppServerConnection({
        wsUrl: targetWsUrl,
        wsToken: targetWsToken,
        timeoutMs: nearUnlimitedTimeoutMs,
      });
      setReplyDebug(
        `codex_probe:ok url=${targetWsUrl} os=${result.platformOs || "-"} env=${executionEnvironment} expoGo=${isExpoGo}`
      );
      Alert.alert(
        "Codex WS Probe OK",
        `url=${targetWsUrl}\nos=${result.platformOs || "-"}\nexecutionEnvironment=${executionEnvironment}\nexpoGo=${isExpoGo}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setReplyDebug(`codex_probe:error ${message}`);
      setError(message);
      const expoGoNote = isExpoGo
        ? "\n\nExpo Go では ios.infoPlist が反映されません。development build / run:ios で再検証してください。"
        : "";
      Alert.alert("Codex WS Probe Error", `${message}${expoGoNote}`);
    } finally {
      setCodexWsProbeLoading(false);
    }
  }

  async function uploadCodexWsPreflightLog(options: UploadCodexWsPreflightLogOptions) {
    const runnerBase = baseUrl();
    const runnerAuth = runnerToken.trim();
    const fallbackRunnerBase = deriveRunnerBaseUrlFromCodexWsUrl(options.targetWsUrl);
    const uploadCandidates = Array.from(new Set(
      [runnerBase, fallbackRunnerBase]
        .map((raw) => String(raw || "").trim().replace(/\/$/, ""))
        .filter(Boolean)
    ));
    if (!runnerAuth || uploadCandidates.length <= 0) {
      return "skipped:no_runner_auth_or_base";
    }
    const sessionId = `${autoClientSessionIdRef.current}:codex-preflight:${Date.now()}`;
    const event = buildDiagEvent(sessionId, 1, "codex_ws_preflight", {
      phase: options.phase,
      wsUrl: options.targetWsUrl,
      tokenEnabled: !!options.targetWsToken,
      executionEnvironment,
      expoGo: isExpoGo,
      activeScreen,
      ...((options.extra && typeof options.extra === "object") ? options.extra : {}),
    });

    let lastError = "";
    for (const candidate of uploadCandidates) {
      try {
        const { response, data } = await postJsonWithTimeout(
          `${candidate}/client-logs`,
          {
            source: "codex_ws_preflight",
            sessionId,
            device: `${Platform.OS}:${String(Platform.Version)}`,
            events: [event],
          },
          {
            "content-type": "application/json",
            authorization: `Bearer ${runnerAuth}`,
          },
          nearUnlimitedTimeoutMs
        );
        if (!response.ok) {
          throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
        }
        return `uploaded:1@${candidate}`;
      } catch (error) {
        lastError = diagErrorMessage(error);
      }
    }
    return `upload_error:${lastError || "unknown_error"}`;
  }

  async function runCodexWsDiagnosticsAndUpload() {
    if (codexWsDiagLoading) return;
    const targetWsUrl = codexWsUrl.trim() || defaultCodexWsUrl;
    const targetWsToken = codexWsToken.trim();
    const runnerBase = baseUrl();
    const runnerAuth = runnerToken.trim();
    const diagSessionId = `${autoClientSessionIdRef.current}:codex-ws:${Date.now()}`;
    const startedAt = Date.now();
    let seq = 0;
    const diagEvents: AutoClientLogEntry[] = [];

    function pushDiag(event: string, payload: Record<string, unknown>) {
      seq += 1;
      diagEvents.push(buildDiagEvent(diagSessionId, seq, event, payload));
    }

    async function runStep(step: string, action: () => Promise<Record<string, unknown>>) {
      const stepStart = Date.now();
      try {
        const payload = await action();
        pushDiag("codex_ws_diag_step_ok", {
          step,
          elapsedMs: Math.max(0, Date.now() - stepStart),
          ...payload,
        });
        return { step, ok: true, detail: payload };
      } catch (error) {
        const message = diagErrorMessage(error);
        pushDiag("codex_ws_diag_step_error", {
          step,
          elapsedMs: Math.max(0, Date.now() - stepStart),
          message,
        });
        return { step, ok: false, detail: { message } };
      }
    }

    setCodexWsDiagLoading(true);
    setCodexWsDiagStatus("running");
    setError("");
    setReplyDebug((prev) => (
      prev
        ? `${prev} | codex_diag:start url=${targetWsUrl} token=${targetWsToken ? "yes" : "no"}`
        : `codex_diag:start url=${targetWsUrl} token=${targetWsToken ? "yes" : "no"}`
    ));

    pushDiag("codex_ws_diag_start", {
      wsUrl: targetWsUrl,
      tokenEnabled: !!targetWsToken,
      runnerBaseUrl: runnerBase,
      runnerAuthEnabled: !!runnerAuth,
      executionEnvironment,
      expoGo: isExpoGo,
    });

    try {
      const readyzUrl = toCodexHttpEndpoint(targetWsUrl, "readyz");
      const healthzUrl = toCodexHttpEndpoint(targetWsUrl, "healthz");
      let wsPathname = "";
      let wsPort = "";
      try {
        const parsed = new URL(targetWsUrl);
        wsPathname = String(parsed.pathname || "").trim();
        wsPort = String(parsed.port || "").trim();
      } catch {}

      const shouldRunCodexHttpChecks =
        (!wsPathname || wsPathname === "/" || wsPathname === "") &&
        (!wsPort || wsPort === "4500");
      const steps: Array<Promise<{ step: string; ok: boolean; detail: Record<string, unknown> }>> = [];

      if (shouldRunCodexHttpChecks) {
        steps.push(runStep("http_readyz", async () => {
          if (!readyzUrl) throw new Error("readyz endpoint could not be derived from ws url");
          const res = await fetchHttpWithTimeout(readyzUrl, nearUnlimitedTimeoutMs);
          if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
          }
          return {
            endpoint: readyzUrl,
            status: res.status,
            body: res.body || "",
          };
        }));

        steps.push(runStep("http_healthz", async () => {
          if (!healthzUrl) throw new Error("healthz endpoint could not be derived from ws url");
          const res = await fetchHttpWithTimeout(healthzUrl, nearUnlimitedTimeoutMs);
          if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
          }
          return {
            endpoint: healthzUrl,
            status: res.status,
            body: res.body || "",
          };
        }));
      } else {
        pushDiag("codex_ws_diag_step_skipped", {
          step: "http_readyz",
          reason: "non_codex_direct_ws_url",
          wsPathname,
          wsPort,
        });
        pushDiag("codex_ws_diag_step_skipped", {
          step: "http_healthz",
          reason: "non_codex_direct_ws_url",
          wsPathname,
          wsPort,
        });
      }

      steps.push(runStep("ws_handshake_no_token", async () => {
        const result = await probeCodexWebSocketHandshakeOnly({
          wsUrl: targetWsUrl,
          wsToken: "",
          timeoutMs: nearUnlimitedTimeoutMs,
        });
        return {
          readyStateAtOpen: result.readyStateAtOpen,
        };
      }));

      steps.push(runStep("rpc_probe_no_token", async () => {
        const result = await probeCodexAppServerConnection({
          wsUrl: targetWsUrl,
          wsToken: "",
          timeoutMs: nearUnlimitedTimeoutMs,
        });
        return {
          platformOs: result.platformOs || "",
          codexHome: result.codexHome || "",
        };
      }));

      if (targetWsToken) {
        steps.push(runStep("ws_handshake_with_token", async () => {
          const result = await probeCodexWebSocketHandshakeOnly({
            wsUrl: targetWsUrl,
            wsToken: targetWsToken,
            timeoutMs: nearUnlimitedTimeoutMs,
          });
          return {
            readyStateAtOpen: result.readyStateAtOpen,
          };
        }));

        steps.push(runStep("rpc_probe_with_token", async () => {
          const result = await probeCodexAppServerConnection({
            wsUrl: targetWsUrl,
            wsToken: targetWsToken,
            timeoutMs: nearUnlimitedTimeoutMs,
          });
          return {
            platformOs: result.platformOs || "",
            codexHome: result.codexHome || "",
          };
        }));
      }

      const results = await Promise.all(steps);
      const okCount = results.filter((item) => item.ok).length;
      const ngCount = results.length - okCount;

      pushDiag("codex_ws_diag_summary", {
        total: results.length,
        okCount,
        ngCount,
        elapsedMs: Math.max(0, Date.now() - startedAt),
      });

      const summary = `codex_diag:done total=${results.length} ok=${okCount} ng=${ngCount}`;
      setReplyDebug((prev) => (prev ? `${prev} | ${summary}` : summary));

      let uploadStatus = "upload_skipped";
      if (runnerBase && runnerAuth) {
        const fallbackRunnerBase = deriveRunnerBaseUrlFromCodexWsUrl(targetWsUrl);
        const uploadCandidates = Array.from(new Set(
          [runnerBase, fallbackRunnerBase]
            .map((raw) => String(raw || "").trim().replace(/\/$/, ""))
            .filter(Boolean)
        ));
        let uploadSucceeded = false;
        let lastUploadError = "";
        for (const candidate of uploadCandidates) {
          try {
            pushDiag("codex_ws_diag_upload_try", { endpoint: `${candidate}/client-logs` });
            const { response, data } = await postJsonWithTimeout(
              `${candidate}/client-logs`,
              {
                source: "codex_ws_diag",
                sessionId: diagSessionId,
                device: `${Platform.OS}:${String(Platform.Version)}`,
                events: diagEvents,
              },
              {
                "content-type": "application/json",
                authorization: `Bearer ${runnerAuth}`,
              },
              nearUnlimitedTimeoutMs
            );
            if (!response.ok) {
              throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
            }
            uploadStatus = `uploaded:${Number(data?.accepted || diagEvents.length)}@${candidate}`;
            setCodexWsDiagStatus(uploadStatus);
            Alert.alert(
              "Codex WS Multi-Diag OK",
              `${summary}\nlogs=${uploadStatus}\nsession=${diagSessionId}`
            );
            uploadSucceeded = true;
            break;
          } catch (error) {
            lastUploadError = diagErrorMessage(error);
            pushDiag("codex_ws_diag_upload_try_error", {
              endpoint: `${candidate}/client-logs`,
              message: lastUploadError,
            });
          }
        }
        if (uploadSucceeded) {
          return;
        }
        uploadStatus = `upload_error:${lastUploadError || "unknown_error"}`;
        pushDiag("codex_ws_diag_upload_error", {
          message: lastUploadError || "unknown_error",
          runnerBase,
          fallbackRunnerBase,
        });
      }

      setCodexWsDiagStatus(uploadStatus);
      Alert.alert(
        "Codex WS Multi-Diag Result",
        `${summary}\nlogs=${uploadStatus}\nsession=${diagSessionId}`
      );
    } catch (error) {
      const message = diagErrorMessage(error);
      pushDiag("codex_ws_diag_fatal", { message });
      setCodexWsDiagStatus(`fatal:${message}`);
      setError(message);
      Alert.alert("Codex WS Multi-Diag Error", message);
    } finally {
      setCodexWsDiagLoading(false);
    }
  }

  function toWsProxyUrlFromHttpBase(httpBase: string, token: string, path = "/codex-ws") {
    const base = String(httpBase || "").trim();
    if (!base) return "";
    try {
      const parsed = new URL(base);
      const wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
      const normalizedPath = String(path || "").trim().startsWith("/")
        ? String(path || "").trim()
        : `/${String(path || "").trim() || "codex-ws"}`;
      const wsUrl = new URL(`${wsProtocol}//${parsed.host}${normalizedPath}`);
      if (token) {
        wsUrl.searchParams.set("token", token);
      }
      return wsUrl.toString();
    } catch {
      return "";
    }
  }

  async function probeRunnerWsControlPing(wsUrl: string, timeoutMs: number) {
    const timeout = Number.isFinite(Number(timeoutMs))
      ? Math.max(3000, Math.floor(Number(timeoutMs)))
      : nearUnlimitedTimeoutMs;
    const ws = new WebSocket(wsUrl);
    const requestId = `diag-${Date.now()}`;
    return await new Promise<string>((resolve, reject) => {
      let finalized = false;
      const timeoutHandle = setTimeout(() => {
        if (finalized) return;
        finalized = true;
        try {
          ws.close();
        } catch {}
        reject(new Error(`runner-ws control ping timeout (${timeout}ms)`));
      }, timeout);

      function finishOk(detail: string) {
        if (finalized) return;
        finalized = true;
        clearTimeout(timeoutHandle);
        try {
          ws.close();
        } catch {}
        resolve(detail);
      }

      function finishError(message: string) {
        if (finalized) return;
        finalized = true;
        clearTimeout(timeoutHandle);
        try {
          ws.close();
        } catch {}
        reject(new Error(message));
      }

      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({
            channel: "control",
            op: "ping",
            requestId,
          }));
        } catch (error) {
          finishError(`runner-ws control ping send failed: ${diagErrorMessage(error)}`);
        }
      };

      ws.onmessage = (event) => {
        const rawData = typeof event.data === "string" ? event.data : String(event.data || "");
        let message: Record<string, unknown>;
        try {
          const parsed = JSON.parse(rawData);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
          message = parsed as Record<string, unknown>;
        } catch {
          return;
        }
        if (message.channel === "control" && message.op === "pong") {
          finishOk(`pong requestId=${String(message.requestId || "-")}`);
          return;
        }
        if (message.channel === "control" && message.op === "error") {
          const payload = message.payload && typeof message.payload === "object"
            ? message.payload as Record<string, unknown>
            : {};
          finishError(String(payload.message || payload.error || "runner-ws control error"));
        }
      };

      ws.onerror = (event: any) => {
        finishError(`runner-ws control ping error: ${String(event?.message || event?.type || "unknown")}`);
      };

      ws.onclose = (event: any) => {
        if (finalized) return;
        const code = Number(event?.code);
        const reason = String(event?.reason || "").trim();
        finishError(
          `runner-ws control ping closed: code=${Number.isFinite(code) ? code : "unknown"} reason=${reason || "-"}`
        );
      };
    });
  }

  async function runRunner8788ReachabilitySuite() {
    if (runner8788SuiteLoading) return;
    const targetWsUrl = codexWsUrl.trim() || defaultCodexWsUrl;
    const targetWsToken = codexWsToken.trim();
    const runnerBase = baseUrl();
    const runnerAuth = runnerToken.trim();
    const fallbackRunnerBase = deriveRunnerBaseUrlFromCodexWsUrl(targetWsUrl);
    const candidates = Array.from(new Set(
      [runnerBase, fallbackRunnerBase]
        .map((raw) => String(raw || "").trim().replace(/\/$/, ""))
        .filter(Boolean)
    ));
    if (candidates.length <= 0) {
      Alert.alert("Aux Server Reachability Error", "Runner URL が空です。");
      return;
    }

    setRunner8788SuiteLoading(true);
    setRunner8788SuiteStatus("running");
    setError("");
    const startedAt = Date.now();
    let total = 0;
    let ok = 0;
    const lines: string[] = [];

    async function runStep(label: string, action: () => Promise<string>) {
      total += 1;
      try {
        const detail = await action();
        ok += 1;
        lines.push(`ok ${label}${detail ? ` ${detail}` : ""}`);
      } catch (error) {
        lines.push(`ng ${label} ${diagErrorMessage(error)}`);
      }
    }

    try {
      for (const candidate of candidates) {
        lines.push(`base ${candidate}`);

        await runStep(`${candidate} GET /health`, async () => {
          const res = await fetchHttpWithTimeout(`${candidate}/health`, nearUnlimitedTimeoutMs);
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          return `status=${res.status}`;
        });

        if (!runnerAuth) {
          lines.push("skip POST /client-logs (runner token empty)");
        } else {
          await runStep(`${candidate} POST /client-logs`, async () => {
            const sessionId = `${autoClientSessionIdRef.current}:runner-8788:${Date.now()}`;
            const { response, data } = await postJsonWithTimeout(
              `${candidate}/client-logs`,
              {
                source: "runner_8788_suite",
                sessionId,
                device: `${Platform.OS}:${String(Platform.Version)}`,
                events: [
                  buildDiagEvent(sessionId, 1, "runner_8788_suite_probe", {
                    candidate,
                    targetWsUrl,
                    executionEnvironment,
                    expoGo: isExpoGo,
                  }),
                ],
              },
              {
                "content-type": "application/json",
                authorization: `Bearer ${runnerAuth}`,
              },
              nearUnlimitedTimeoutMs
            );
            if (!response.ok) {
              throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
            }
            return `accepted=${Number(data?.accepted || 0)}`;
          });

          await runStep(`${candidate} GET /codex-ws-debug`, async () => {
            const res = await fetchHttpWithTimeout(
              `${candidate}/codex-ws-debug?token=${encodeURIComponent(runnerAuth)}&limit=3`,
              nearUnlimitedTimeoutMs
            );
            if (!res.ok) {
              throw new Error(`HTTP ${res.status}`);
            }
            return `status=${res.status}`;
          });
        }

        const wsProxyUrl = toWsProxyUrlFromHttpBase(candidate, runnerAuth);
        if (!wsProxyUrl) {
          lines.push(`skip WS /codex-ws (${candidate})`);
        } else {
          await runStep(`${candidate} WS /codex-ws`, async () => {
            const result = await probeCodexWebSocketHandshakeOnly({
              wsUrl: wsProxyUrl,
              wsToken: "",
              timeoutMs: nearUnlimitedTimeoutMs,
            });
            return `readyState=${result.readyStateAtOpen}`;
          });
        }

        const runnerWsUrl = toWsProxyUrlFromHttpBase(candidate, runnerAuth, "/runner-ws");
        if (!runnerWsUrl) {
          lines.push(`skip WS /runner-ws (${candidate})`);
        } else {
          await runStep(`${candidate} WS /runner-ws`, async () => {
            const result = await probeCodexWebSocketHandshakeOnly({
              wsUrl: runnerWsUrl,
              wsToken: "",
              timeoutMs: nearUnlimitedTimeoutMs,
            });
            return `readyState=${result.readyStateAtOpen}`;
          });

          await runStep(`${candidate} WS /runner-ws control ping`, async () => {
            return await probeRunnerWsControlPing(runnerWsUrl, nearUnlimitedTimeoutMs);
          });
        }
      }

      await runStep("configured WS URL handshake", async () => {
        const result = await probeCodexWebSocketHandshakeOnly({
          wsUrl: targetWsUrl,
          wsToken: targetWsToken,
          timeoutMs: nearUnlimitedTimeoutMs,
        });
        return `readyState=${result.readyStateAtOpen}`;
      });

      const elapsedMs = Math.max(0, Date.now() - startedAt);
      const summary = `runner8788_suite done ok=${ok}/${total} elapsed=${elapsedMs}ms`;
      setRunner8788SuiteStatus(summary);
      setReplyDebug((prev) => (prev ? `${prev} | ${summary}` : summary));
      Alert.alert(
        "Aux Server Reachability Result",
        `${summary}\n${lines.join("\n").slice(0, 2800)}`
      );
    } catch (error) {
      const message = diagErrorMessage(error);
      setRunner8788SuiteStatus(`fatal:${message}`);
      setError(message);
      Alert.alert("Aux Server Reachability Error", message);
    } finally {
      setRunner8788SuiteLoading(false);
    }
  }

  async function runCodexWsE2eTurnAndUpload() {
    if (codexWsE2eLoading) return;
    const targetWsUrl = codexWsUrl.trim() || defaultCodexWsUrl;
    const targetWsToken = codexWsToken.trim();
    const runnerBase = baseUrl();
    const runnerAuth = runnerToken.trim();
    const e2eSessionId = `${autoClientSessionIdRef.current}:codex-e2e:${Date.now()}`;
    const startedAt = Date.now();
    let seq = 0;
    const e2eEvents: AutoClientLogEntry[] = [];

    function pushE2e(event: string, payload: Record<string, unknown>) {
      seq += 1;
      e2eEvents.push(buildDiagEvent(e2eSessionId, seq, event, payload));
    }

    setCodexWsE2eLoading(true);
    setCodexWsE2eStatus("running");
    setError("");
    setReplyDebug((prev) => (
      prev
        ? `${prev} | codex_e2e:start url=${targetWsUrl} token=${targetWsToken ? "yes" : "no"}`
        : `codex_e2e:start url=${targetWsUrl} token=${targetWsToken ? "yes" : "no"}`
    ));

    pushE2e("codex_ws_e2e_start", {
      wsUrl: targetWsUrl,
      tokenEnabled: !!targetWsToken,
      runnerBaseUrl: runnerBase,
      runnerAuthEnabled: !!runnerAuth,
      executionEnvironment,
      expoGo: isExpoGo,
      cwd: normalizedLlmDirectoryForRequest() || "",
    });

    try {
      const result = await runCodexAppServerTurn({
        wsUrl: targetWsUrl,
        wsToken: targetWsToken,
        inputText: "e2e ping",
        cwd: normalizedLlmDirectoryForRequest() || undefined,
        serviceName: "expo-ios-client-e2e",
        model: modelRef || undefined,
        effort: modelRef ? reasoningEffort : undefined,
        approvalPolicy: codexApprovalPolicy,
        onApprovalRequest: handleApprovalRequest,
        timeoutMs: nearUnlimitedTimeoutMs,
        onLog: (entry) => {
          pushE2e("codex_ws_e2e_ws_log", {
            stage: entry.stage,
            method: entry.method || "",
            id: Number.isFinite(Number(entry.id)) ? Number(entry.id) : null,
            readyState: Number.isFinite(Number(entry.readyState)) ? Number(entry.readyState) : null,
            message: String(entry.message || ""),
          });
        },
        onEvent: (method) => {
          if (!method) return;
          if (
            method === "turn/completed" ||
            method === "item/completed" ||
            method === "item/agentMessage/delta" ||
            method === "item/commandExecution/requestApproval" ||
            method === "item/fileChange/requestApproval"
          ) {
            pushE2e("codex_ws_e2e_ws_event", { method });
          }
        },
      });

      const reply = String(result.reply || "").trim();
      const summary = `codex_e2e:ok thread=${result.threadId || "-"} turn=${result.turnId || "-"} replyChars=${reply.length}`;
      pushE2e("codex_ws_e2e_ok", {
        threadId: result.threadId || "",
        turnId: result.turnId || "",
        replyChars: reply.length,
        replyPreview: reply.slice(0, 120),
        elapsedMs: Math.max(0, Date.now() - startedAt),
      });
      setReplyDebug((prev) => (prev ? `${prev} | ${summary}` : summary));

      let uploadStatus = "upload_skipped";
      if (runnerBase && runnerAuth) {
        const fallbackRunnerBase = deriveRunnerBaseUrlFromCodexWsUrl(targetWsUrl);
        const uploadCandidates = Array.from(new Set(
          [runnerBase, fallbackRunnerBase]
            .map((raw) => String(raw || "").trim().replace(/\/$/, ""))
            .filter(Boolean)
        ));
        let uploaded = false;
        let lastError = "";
        const uploadBatchSize = 100;
        for (const candidate of uploadCandidates) {
          try {
            pushE2e("codex_ws_e2e_upload_try", {
              endpoint: `${candidate}/client-logs`,
              events: e2eEvents.length,
              batchSize: uploadBatchSize,
            });
            let acceptedTotal = 0;
            for (let from = 0; from < e2eEvents.length; from += uploadBatchSize) {
              const batch = e2eEvents.slice(from, from + uploadBatchSize);
              const { response, data } = await postJsonWithTimeout(
                `${candidate}/client-logs`,
                {
                  source: "codex_ws_e2e",
                  sessionId: e2eSessionId,
                  device: `${Platform.OS}:${String(Platform.Version)}`,
                  events: batch,
                },
                {
                  "content-type": "application/json",
                  authorization: `Bearer ${runnerAuth}`,
                },
                nearUnlimitedTimeoutMs
              );
              if (!response.ok) {
                throw new Error(String(data?.message || data?.error || `HTTP ${response.status}`));
              }
              acceptedTotal += Number(data?.accepted || batch.length);
            }
            uploadStatus = `uploaded:${acceptedTotal}@${candidate}`;
            uploaded = true;
            break;
          } catch (error) {
            lastError = diagErrorMessage(error);
            pushE2e("codex_ws_e2e_upload_try_error", {
              endpoint: `${candidate}/client-logs`,
              message: lastError,
            });
          }
        }
        if (!uploaded) {
          uploadStatus = `upload_error:${lastError || "unknown_error"}`;
          pushE2e("codex_ws_e2e_upload_error", {
            message: lastError || "unknown_error",
            runnerBase,
            fallbackRunnerBase,
          });
        }
      }

      setCodexWsE2eStatus(uploadStatus);
      Alert.alert(
        "Codex WS E2E Result",
        `${summary}\nlogs=${uploadStatus}\nsession=${e2eSessionId}`
      );
    } catch (error) {
      const message = diagErrorMessage(error);
      pushE2e("codex_ws_e2e_error", {
        message,
        elapsedMs: Math.max(0, Date.now() - startedAt),
      });
      setCodexWsE2eStatus(`error:${message}`);
      setError(message);
      Alert.alert("Codex WS E2E Error", `${message}\nsession=${e2eSessionId}`);
    } finally {
      setCodexWsE2eLoading(false);
    }
  }

  async function testHardcodedCodexWsHandshakeOnly() {
    if (codexWsHandshakeProbeLoading) return;
    const targetWsUrl = codexWsUrl.trim() || defaultCodexWsUrl;
    const targetWsToken = codexWsToken.trim();
    setCodexWsHandshakeProbeLoading(true);
    setError("");
    setCodexWsHandshakeProbeStatus("connecting");
    setReplyDebug(
      `codex_ws_handshake:start url=${targetWsUrl} token=${targetWsToken ? "yes" : "no"} env=${executionEnvironment} expoGo=${isExpoGo}`
    );
    const activeWs = codexHandshakeProbeSocketRef.current;
    if (activeWs) {
      codexHandshakeProbeSocketRef.current = null;
      try {
        activeWs.close();
      } catch {}
    }
    try {
      const preflightStatus = await uploadCodexWsPreflightLog({
        phase: "handshake_before_ws_connect",
        targetWsUrl,
        targetWsToken,
      });
      setReplyDebug((prev) => (
        prev ? `${prev} | preflight=${preflightStatus}` : `preflight=${preflightStatus}`
      ));
      const result = await probeCodexWebSocketHandshakeOnly({
        wsUrl: targetWsUrl,
        wsToken: targetWsToken,
        timeoutMs: nearUnlimitedTimeoutMs,
      });
      setCodexWsHandshakeProbeLoading(false);
      setCodexWsHandshakeProbeStatus("open");
      setReplyDebug(
        `codex_ws_handshake:open url=${targetWsUrl} readyState=${result.readyStateAtOpen} env=${executionEnvironment} expoGo=${isExpoGo}`
      );
      Alert.alert(
        "Codex WS Handshake OK",
        `url=${targetWsUrl}\nreadyState=${result.readyStateAtOpen}\nexecutionEnvironment=${executionEnvironment}\nexpoGo=${isExpoGo}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCodexWsHandshakeProbeLoading(false);
      setCodexWsHandshakeProbeStatus("error");
      setReplyDebug(`codex_ws_handshake:throw ${message}`);
      setError(message);
      Alert.alert("Codex WS Handshake Error", message);
    }
  }

  return {
    testHardcodedCodexWsConnection,
    uploadCodexWsPreflightLog,
    runCodexWsDiagnosticsAndUpload,
    runRunner8788ReachabilitySuite,
    runCodexWsE2eTurnAndUpload,
    testHardcodedCodexWsHandshakeOnly,
  };
}
