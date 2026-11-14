import { getVoiceOrchestrators, subscribeVoiceOrchestrators } from "../utils/voiceOrchestratorClient";
import { useEffect, useRef, useState } from "react";
import { useRunnerWebSocketManager, useRunnerWebSocketSnapshot } from "../../runnerWs/RunnerWebSocketContext";
import type { VoiceOrchestrator } from "../components/VoiceOrchestratorIcon";
import { mutatePersistedSettings, SIRI_VOICE_ORCHESTRATORS_FIELD } from "../utils/persistedSettingsFile";
import { useConversation } from "../contexts/ConversationContext";

export type OrchestratorActivity = {
  id: string;
  orchestratorId: string | null;
  sessionRef?: { backendId: string; nativeSessionId: string };
  kind: string;
  status: string;
  label: string;
  startedAt: number | string;
};

type ActivitySnapshot = {
  instanceId: string;
  revision: number;
  activities: OrchestratorActivity[];
};

export function activityTargetDiagnostic(activity: OrchestratorActivity) {
  return {
    backendId: ["codex", "claude"].includes(activity.sessionRef?.backendId || "")
      ? activity.sessionRef!.backendId : "other",
    sessionIdPrefix: activity.sessionRef?.nativeSessionId.match(/^[0-9a-f]{8}(?=-)/i)?.[0] || null,
    status: ["running", "completed", "failed", "interrupted", "unknown"].includes(activity.status)
      ? activity.status : "other",
  };
}

function isActivitySnapshot(value: unknown): value is ActivitySnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<ActivitySnapshot>;
  return typeof snapshot.instanceId === "string" && Number.isSafeInteger(snapshot.revision)
    && Array.isArray(snapshot.activities) && snapshot.activities.every((activity) =>
      activity && typeof activity.id === "string" && typeof activity.label === "string"
      && typeof activity.status === "string" && typeof activity.kind === "string"
      && (activity.orchestratorId === null || typeof activity.orchestratorId === "string")
      && (!activity.sessionRef || (typeof activity.sessionRef.backendId === "string"
        && typeof activity.sessionRef.nativeSessionId === "string")));
}

export function useOrchestratorActivities(runnerUrl: string, runnerToken: string, enabled: boolean) {
  const manager = useRunnerWebSocketManager();
  const { logSessionDiag } = useConversation();
  const diagnosticLogger = useRef(logSessionDiag);
  diagnosticLogger.current = logSessionDiag;
  const { connected, generation, appState } = useRunnerWebSocketSnapshot();
  const [activities, setActivities] = useState<OrchestratorActivity[]>([]);
  const [orchestrators, setOrchestrators] = useState<VoiceOrchestrator[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const siriNamesKey = useRef("");
  const credentials = useRef({ runnerUrl, runnerToken });
  const snapshotMetadata = useRef<{ instancePrefix: string | null; revision: number } | null>(null);

  useEffect(() => {
    snapshotMetadata.current = null;
    setActivities([]);
    if (credentials.current.runnerUrl !== runnerUrl || credentials.current.runnerToken !== runnerToken) {
      credentials.current = { runnerUrl, runnerToken };
      setOrchestrators([]);
      setSelectedId("");
    }
    const subscribed = enabled && connected && appState === "active";
    try { diagnosticLogger.current("orchestrator_activity_subscription", {
      subscribed, enabled, connected, appState, generation,
    }, { throttleMs: 0 }); } catch { /* Diagnostics cannot change subscriptions. */ }
    if (!subscribed) return;

    let current = true;
    let latest: ActivitySnapshot | null = null;
    let notificationReceived = false;
    const retiredInstances = new Set<string>();
    const applySnapshot = (value: unknown, fromNotification: boolean) => {
      const snapshot = isActivitySnapshot(value) ? value : null;
      const logDecision = (decision: "accepted" | "rejected", reason?: string) => {
        try { diagnosticLogger.current("orchestrator_activity_snapshot", {
          source: fromNotification ? "notification" : "response", decision, reason,
          instancePrefix: snapshot?.instanceId.match(/^[0-9a-f]{8}(?=-)/i)?.[0] || null,
          revision: snapshot?.revision ?? null,
          activityCount: snapshot?.activities.length ?? null,
          targets: snapshot?.activities.filter((activity) => activity.sessionRef).slice(0, 8)
            .map(activityTargetDiagnostic) || [],
        }, { throttleMs: 0 }); } catch { /* Diagnostics cannot change snapshot ordering. */ }
      };
      if (!current) { logDecision("rejected", "subscription_stopped"); return; }
      if (!snapshot) { logDecision("rejected", "invalid_snapshot"); return; }
      if (retiredInstances.has(snapshot.instanceId)) { logDecision("rejected", "retired_instance"); return; }
      if (!fromNotification && notificationReceived && latest?.instanceId !== snapshot.instanceId) {
        logDecision("rejected", "superseded_response"); return;
      }
      if (latest?.instanceId === snapshot.instanceId && snapshot.revision <= latest.revision) {
        logDecision("rejected", "stale_revision"); return;
      }
      if (latest && latest.instanceId !== snapshot.instanceId) retiredInstances.add(latest.instanceId);
      latest = snapshot;
      if (fromNotification) notificationReceived = true;
      snapshotMetadata.current = {
        instancePrefix: snapshot.instanceId.match(/^[0-9a-f]{8}(?=-)/i)?.[0] || null,
        revision: snapshot.revision,
      };
      logDecision("accepted");
      setActivities(snapshot.activities);
    };
    const applyMetadata = (value: unknown) => {
      if (!current || !value || typeof value !== "object") return;
      const metadata = value as { orchestrators?: unknown; selectedId?: unknown };
      const items = metadata.orchestrators;
      if (Array.isArray(items) && typeof metadata.selectedId === "string") {
        setSelectedId(metadata.selectedId);
        const orchestrators = items.flatMap((item): VoiceOrchestrator[] => {
          if (!item || typeof item !== "object" || typeof item.id !== "string") return [];
          return [{ id: item.id, name: typeof item.name === "string" ? item.name : "?",
            icon: typeof item.icon === "string" ? item.icon : "",
            unreadCount: typeof item.unreadCount === "number" ? item.unreadCount : 0,
            learningUnreadCount: Number.isSafeInteger(item.learningUnreadCount) && item.learningUnreadCount >= 0
              ? item.learningUnreadCount : 0 }];
        });
        setOrchestrators(orchestrators);
        const names = orchestrators.map(({ id, name }) => ({ id, name }));
        const key = JSON.stringify([runnerUrl, names]);
        if (siriNamesKey.current !== key) {
          siriNamesKey.current = key;
          void mutatePersistedSettings((current) => ({ ...current,
            [SIRI_VOICE_ORCHESTRATORS_FIELD]: { runnerUrl, orchestrators: names },
          })).catch(() => { siriNamesKey.current = ""; });
        }
      }
    };
    const unsubscribeActivity = manager.subscribe(
      { channel: "control", op: "orchestrator_activity_updated" },
      (message) => applySnapshot(message.payload, true),
    );
    const unsubscribeMetadata = subscribeVoiceOrchestrators(manager, applyMetadata);
    void manager.request({ channel: "control", op: "orchestrator_activity_snapshot" })
      .then((response) => {
        if (response.op === "orchestrator_activity_snapshot") applySnapshot(response.payload, false);
      }).catch(() => undefined);
    void getVoiceOrchestrators(manager).catch(() => undefined);
    return () => {
      current = false;
      unsubscribeActivity();
      unsubscribeMetadata();
      try { diagnosticLogger.current("orchestrator_activity_subscription", {
        subscribed: false, reason: "cleanup", generation,
      }, { throttleMs: 0 }); } catch { /* Diagnostics cannot change cleanup. */ }
    };
  }, [manager, connected, generation, appState, runnerUrl, runnerToken, enabled]);

  return { activities, orchestrators, selectedId, activitySnapshot: snapshotMetadata.current };
}
