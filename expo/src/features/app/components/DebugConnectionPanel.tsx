import { useCallback, useEffect, useRef, useState } from "react";
import { Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useAppSettings } from "../contexts/AppSettingsContext";
import { useDebugRuntime } from "../contexts/DebugRuntimeContext";
import { styles } from "../styles";
import {
  suggestCodexWsUrlFromRunnerUrl,
  suggestRunnerWsUrlFromRunnerUrl,
} from "../utils/urlResolvers";
import { useRunnerWs } from "../../runnerWs/RunnerWsProvider";

export function DebugConnectionPanel() {
  const runnerWs = useRunnerWs();
  const runnerWsPingRequestIdRef = useRef("");
  const runnerWsPingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [runnerWsPingStatus, setRunnerWsPingStatus] = useState("idle");
  const {
    codexWsProbeLoading,
    probeCurrentWs,
    codexWsHandshakeProbeLoading,
    probeHandshakeOnly,
    codexWsDiagLoading,
    runWsDiag,
    runner8788SuiteLoading,
    runAuxServerSuite,
    codexWsE2eLoading,
    runWsE2e,
    codexWsHandshakeProbeStatus,
    codexWsDiagStatus,
    runner8788SuiteStatus,
    codexWsE2eStatus,
    llmRuntimeLimitsLoading,
    loadLlmRuntimeLimits,
    llmToolMaxRoundsInput,
    changeLlmToolMaxRoundsInput,
    llmToolMaxRoundsSaving,
    updateLlmToolMaxRounds,
    llmRuntimeLimits,
    llmRuntimeLimitsError,
    llmToolLogCompact,
    toggleLlmToolLogCompact,
  } = useDebugRuntime();
  const {
    runnerUrl,
    llmDirectory,
    codexWsUrl,
    codexWsToken,
    runnerToken,
    executionEnvironment,
    isExpoGo,
    isDev,
    defaultCodexWsUrl,
    codexApprovalPolicy,
    selectedModelLabel,
    modelRef,
    reasoningEffort,
    changeRunnerUrl,
    changeLlmDirectory,
    changeCodexWsUrl,
    changeCodexWsToken,
    changeRunnerToken,
    selectCodexApprovalPolicy,
    openModelSelect,
    openThinkSelect,
  } = useAppSettings();

  const clearRunnerWsPingTimeout = useCallback(() => {
    if (!runnerWsPingTimeoutRef.current) return;
    clearTimeout(runnerWsPingTimeoutRef.current);
    runnerWsPingTimeoutRef.current = null;
  }, []);

  useEffect(() => {
    return runnerWs.subscribe({ channel: "control", op: "pong" }, (message) => {
      const requestId = String(message.requestId || "");
      const expectedRequestId = runnerWsPingRequestIdRef.current;
      if (!expectedRequestId || requestId !== expectedRequestId) return;
      clearRunnerWsPingTimeout();
      runnerWsPingRequestIdRef.current = "";
      setRunnerWsPingStatus(`pong ${requestId || "-"}`);
    });
  }, [clearRunnerWsPingTimeout, runnerWs.subscribe]);

  useEffect(() => {
    clearRunnerWsPingTimeout();
    runnerWsPingRequestIdRef.current = "";
    setRunnerWsPingStatus(runnerWs.enabled ? "idle" : "disabled");
  }, [clearRunnerWsPingTimeout, runnerWs.enabled, runnerWs.url]);

  useEffect(() => {
    return () => {
      clearRunnerWsPingTimeout();
    };
  }, [clearRunnerWsPingTimeout]);

  const pingRunnerWsProvider = useCallback(() => {
    const requestId = `debug-${Date.now()}`;
    clearRunnerWsPingTimeout();
    runnerWsPingRequestIdRef.current = requestId;
    const sent = runnerWs.send({
      channel: "control",
      op: "ping",
      requestId,
    });
    if (!sent) {
      setRunnerWsPingStatus("send_failed");
      return;
    }
    setRunnerWsPingStatus(`sent ${requestId}`);
    runnerWsPingTimeoutRef.current = setTimeout(() => {
      if (runnerWsPingRequestIdRef.current !== requestId) return;
      runnerWsPingTimeoutRef.current = null;
      setRunnerWsPingStatus(`timeout ${requestId}`);
    }, 3000);
  }, [clearRunnerWsPingTimeout, runnerWs.send]);

  const applyCodexWsRoute = useCallback(() => {
    const suggested = suggestCodexWsUrlFromRunnerUrl(runnerUrl, runnerToken);
    if (!suggested) return;
    changeCodexWsUrl(suggested);
  }, [changeCodexWsUrl, runnerToken, runnerUrl]);

  const applyRunnerWsRoute = useCallback(() => {
    const suggested = suggestRunnerWsUrlFromRunnerUrl(runnerUrl, runnerToken);
    if (!suggested) return;
    changeCodexWsUrl(suggested);
  }, [changeCodexWsUrl, runnerToken, runnerUrl]);

  return (
    <>
      <Text style={styles.label}>Aux Server URL (stt/tts/logs)</Text>
      <TextInput
        style={styles.input}
        value={runnerUrl}
        onChangeText={changeRunnerUrl}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.label}>LLM Transport</Text>
      <View style={styles.providerRow}>
        <View style={[styles.providerButton, styles.providerButtonSelected]}>
          <Text style={[styles.providerButtonText, styles.providerButtonTextSelected]}>
            codex app-server via runner-ws / codex-ws
          </Text>
        </View>
      </View>
      <Text style={styles.hint}>
        現在のLLM接続先: Codex app-server (JSON-RPC over WebSocket、runner-ws は envelope)
      </Text>
      <Text style={styles.hint}>
        executionEnvironment: {executionEnvironment} / expoGo: {String(isExpoGo)}
      </Text>
      {isExpoGo ? (
        <Text style={[styles.hint, { color: "#b91c1c" }]}>
          Expo Go では ios.infoPlist が反映されないため、Local Network / ATS 検証は development build が必要です。
        </Text>
      ) : null}

      <Text style={styles.label}>LLM Directory (rootDir)</Text>
      <TextInput
        style={styles.input}
        value={llmDirectory}
        onChangeText={changeLlmDirectory}
        placeholder="例: llm_root / llm_root/project-a"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Text style={styles.hint}>同じDirectoryでは同じsessionを自動再開</Text>

      <Text style={styles.label}>Codex WS URL</Text>
      <TextInput
        style={styles.input}
        value={codexWsUrl}
        onChangeText={changeCodexWsUrl}
        placeholder="ws://<host>:8788/codex-ws or /runner-ws"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View style={styles.row}>
        <TouchableOpacity style={styles.buttonSecondary} onPress={applyCodexWsRoute}>
          <Text style={styles.buttonText}>Use /codex-ws</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.buttonSecondary} onPress={applyRunnerWsRoute}>
          <Text style={styles.buttonText}>Use /runner-ws</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.label}>Codex WS Token (optional)</Text>
      <TextInput
        style={styles.input}
        value={codexWsToken}
        onChangeText={changeCodexWsToken}
        placeholder="capability token (Bearer)"
        autoCapitalize="none"
        autoCorrect={false}
      />
      {isDev ? (
        <>
          <Text style={styles.label}>Diagnostics (dev only)</Text>
          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.buttonSecondary, codexWsProbeLoading && styles.buttonDisabled]}
              onPress={probeCurrentWs}
              disabled={codexWsProbeLoading}
            >
              <Text style={styles.buttonText}>
                {codexWsProbeLoading
                  ? "Probing..."
                  : `Probe Current WS (${codexWsUrl.trim() || defaultCodexWsUrl})`}
              </Text>
            </TouchableOpacity>
          </View>
          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.buttonSecondary, codexWsHandshakeProbeLoading && styles.buttonDisabled]}
              onPress={probeHandshakeOnly}
              disabled={codexWsHandshakeProbeLoading}
            >
              <Text style={styles.buttonText}>
                {codexWsHandshakeProbeLoading
                  ? "Handshaking..."
                  : `Probe WS Handshake Only (${codexWsUrl.trim() || defaultCodexWsUrl})`}
              </Text>
            </TouchableOpacity>
          </View>
          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.buttonSecondary, codexWsDiagLoading && styles.buttonDisabled]}
              onPress={runWsDiag}
              disabled={codexWsDiagLoading}
            >
              <Text style={styles.buttonText}>
                {codexWsDiagLoading
                  ? "Running Multi-Diag..."
                  : "Run WS Multi-Diag + Upload Logs"}
              </Text>
            </TouchableOpacity>
          </View>
          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.buttonSecondary, runner8788SuiteLoading && styles.buttonDisabled]}
              onPress={runAuxServerSuite}
              disabled={runner8788SuiteLoading}
            >
              <Text style={styles.buttonText}>
                {runner8788SuiteLoading
                  ? "Running Aux Server Suite..."
                  : "Run Aux Server Reachability (HTTP+WS)"}
              </Text>
            </TouchableOpacity>
          </View>
          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.buttonSecondary, codexWsE2eLoading && styles.buttonDisabled]}
              onPress={runWsE2e}
              disabled={codexWsE2eLoading}
            >
              <Text style={styles.buttonText}>
                {codexWsE2eLoading
                  ? "Running E2E..."
                  : "Run Codex E2E Turn + Upload Logs"}
              </Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>WS handshake status: {codexWsHandshakeProbeStatus}</Text>
          <Text style={styles.hint}>WS multi-diag status: {codexWsDiagStatus}</Text>
          <Text style={styles.hint}>Aux server suite status: {runner8788SuiteStatus}</Text>
          <Text style={styles.hint}>WS E2E status: {codexWsE2eStatus}</Text>
          <Text style={styles.hint}>現在のCodex WS URL / Token設定で接続確認します。</Text>
          <Text style={styles.hint}>
            Runner WS Provider: enabled={String(runnerWs.enabled)} connected={String(runnerWs.snapshot.connected)} readyState={runnerWs.snapshot.readyState} reconnects={runnerWs.snapshot.reconnectCount}
          </Text>
          <Text style={styles.hint}>Runner WS Provider error: {runnerWs.snapshot.lastError || "-"}</Text>
          <Text style={styles.hint}>Runner WS Provider ping: {runnerWsPingStatus}</Text>
          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.buttonSecondary, (!runnerWs.enabled || !runnerWs.snapshot.connected) && styles.buttonDisabled]}
              onPress={pingRunnerWsProvider}
              disabled={!runnerWs.enabled || !runnerWs.snapshot.connected}
            >
              <Text style={styles.buttonText}>Ping Shared /runner-ws Provider</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : null}

      <Text style={styles.label}>Runner Token (aux server: stt/tts/logs)</Text>
      <TextInput
        style={styles.input}
        value={runnerToken}
        onChangeText={changeRunnerToken}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.label}>LLM Model</Text>
      <TouchableOpacity style={styles.selectButton} onPress={openModelSelect}>
        <Text style={styles.selectButtonText}>{selectedModelLabel}</Text>
      </TouchableOpacity>
      <Text style={styles.hint}>現在のモデル: {modelRef}</Text>

      <Text style={styles.label}>Think</Text>
      <TouchableOpacity style={styles.selectButton} onPress={openThinkSelect}>
        <Text style={styles.selectButtonText}>{reasoningEffort}</Text>
      </TouchableOpacity>
      <Text style={styles.hint}>現在のthink: {reasoningEffort}</Text>

      <Text style={styles.label}>Approval Policy (Codex app-server)</Text>
      <View style={styles.providerRow}>
        <TouchableOpacity
          style={[styles.providerButton, codexApprovalPolicy === "on-request" && styles.providerButtonSelected]}
          onPress={() => selectCodexApprovalPolicy("on-request")}
        >
          <Text
            style={[
              styles.providerButtonText,
              codexApprovalPolicy === "on-request" && styles.providerButtonTextSelected,
            ]}
          >
            on-request
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.providerButton, codexApprovalPolicy === "never" && styles.providerButtonSelected]}
          onPress={() => selectCodexApprovalPolicy("never")}
        >
          <Text
            style={[
              styles.providerButtonText,
              codexApprovalPolicy === "never" && styles.providerButtonTextSelected,
            ]}
          >
            never
          </Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.hint}>現在のapprovalPolicy: {codexApprovalPolicy}</Text>
      <View style={styles.row}>
        <TouchableOpacity
          style={[styles.buttonSecondary, llmRuntimeLimitsLoading && styles.buttonDisabled]}
          onPress={loadLlmRuntimeLimits}
          disabled={llmRuntimeLimitsLoading}
        >
          <Text style={styles.buttonText}>
            {llmRuntimeLimitsLoading ? "Loading..." : "Load LLM Limits (/config/limits)"}
          </Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.label}>LLM Tool Max Rounds (1 - 1000)</Text>
      <View style={styles.speedRow}>
        <TextInput
          style={[styles.input, styles.speedInput]}
          value={llmToolMaxRoundsInput}
          onChangeText={changeLlmToolMaxRoundsInput}
          keyboardType="number-pad"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity
          style={[styles.buttonSecondary, llmToolMaxRoundsSaving && styles.buttonDisabled]}
          onPress={updateLlmToolMaxRounds}
          disabled={llmToolMaxRoundsSaving}
        >
          <Text style={styles.buttonText}>{llmToolMaxRoundsSaving ? "Saving..." : "Apply /config/limits"}</Text>
        </TouchableOpacity>
      </View>
      {llmRuntimeLimits ? (
        <Text style={styles.hint}>
          limits: llmTimeout={llmRuntimeLimits.llmTimeoutMs ?? "-"}ms
          {" / "}toolMaxRounds={llmRuntimeLimits.toolMaxRounds ?? "-"}
          {" / "}approvalTimeout={llmRuntimeLimits.approvalTimeoutMs ?? "-"}ms
          {" / "}sttTimeout={llmRuntimeLimits.sttTimeoutMs ?? "-"}ms
        </Text>
      ) : null}
      {llmRuntimeLimitsError ? (
        <Text style={[styles.hint, { color: "#b91c1c" }]}>{llmRuntimeLimitsError}</Text>
      ) : null}
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>ツールログを簡易表示（1行）</Text>
        <Switch value={llmToolLogCompact} onValueChange={toggleLlmToolLogCompact} />
      </View>
    </>
  );
}
