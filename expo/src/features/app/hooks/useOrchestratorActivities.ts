import { getVoiceOrchestrators, subscribeVoiceOrchestrators } from "../utils/voiceOrchestratorClient";
import { useEffect, useRef, useState } from "react";
import { useRunnerWebSocketManager, useRunnerWebSocketSnapshot } from "../../runnerWs/RunnerWebSocketContext";
import type { VoiceOrchestrator } from "../components/VoiceOrchestratorIcon";
import { mutatePersistedSettings, SIRI_VOICE_ORCHESTRATORS_FIELD } from "../utils/persistedSettingsFile";

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
  const { connected, generation, appState } = useRunnerWebSocketSnapshot();
  const [activities, setActivities] = useState<OrchestratorActivity[]>([]);
  const [orchestrators, setOrchestrators] = useState<VoiceOrchestrator[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const siriNamesKey = useRef("");
  const credentials = useRef({ runnerUrl, runnerToken });

  useEffect(() => {
    setActivities([]);
    if (credentials.current.runnerUrl !== runnerUrl || credentials.current.runnerToken !== runnerToken) {
      credentials.current = { runnerUrl, runnerToken };
      setOrchestrators([]);
      setSelectedId("");
    }
    if (!enabled || !connected || appState !== "active") return;

    let current = true;
    let latest: ActivitySnapshot | null = null;
    let notificationReceived = false;
    const retiredInstances = new Set<string>();
    const applySnapshot = (value: unknown, fromNotification: boolean) => {
      if (!current || !isActivitySnapshot(value)) return;
      if (retiredInstances.has(value.instanceId)) return;
      if (!fromNotification && notificationReceived && latest?.instanceId !== value.instanceId) return;
      if (latest?.instanceId === value.instanceId && value.revision <= latest.revision) return;
      if (latest && latest.instanceId !== value.instanceId) retiredInstances.add(latest.instanceId);
      latest = value;
      if (fromNotification) notificationReceived = true;
      setActivities(value.activities);
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
    };
  }, [manager, connected, generation, appState, runnerUrl, runnerToken, enabled]);

  return { activities, orchestrators, selectedId };
}
