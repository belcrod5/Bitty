import { useEffect, useRef, useState } from "react";
import { useRunnerWebSocketManager, useRunnerWebSocketSnapshot } from "../../runnerWs/RunnerWebSocketContext";
import type { VoiceOrchestrator } from "../components/VoiceOrchestratorIcon";

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
  const metadataRevision = useRef(0);
  const credentials = useRef({ runnerUrl, runnerToken });

  useEffect(() => {
    setActivities([]);
    if (credentials.current.runnerUrl !== runnerUrl || credentials.current.runnerToken !== runnerToken) {
      credentials.current = { runnerUrl, runnerToken };
      setOrchestrators([]);
    }
    if (!enabled || !connected || appState === "background") return;

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
      const items = (value as { orchestrators?: unknown }).orchestrators;
      if (Array.isArray(items)) setOrchestrators(items.flatMap((item): VoiceOrchestrator[] => {
        if (!item || typeof item !== "object" || typeof item.id !== "string") return [];
        return [{ id: item.id, name: typeof item.name === "string" ? item.name : "?",
          icon: typeof item.icon === "string" ? item.icon : "",
          unreadCount: typeof item.unreadCount === "number" ? item.unreadCount : 0 }];
      }));
    };
    const unsubscribeActivity = manager.subscribe(
      { channel: "control", op: "orchestrator_activity_updated" },
      (message) => applySnapshot(message.payload, true),
    );
    const unsubscribeMetadata = manager.subscribe(
      { channel: "agent", op: "voice.unread.changed" },
      (message) => {
        metadataRevision.current += 1;
        applyMetadata(message.payload);
      },
    );
    const revision = metadataRevision.current;
    void manager.request({ channel: "control", op: "orchestrator_activity_snapshot" })
      .then((response) => {
        if (response.op === "orchestrator_activity_snapshot") applySnapshot(response.payload, false);
      }).catch(() => undefined);
    void manager.request({ channel: "agent", op: "voice.orchestrators.list" })
      .then((response) => {
        if (revision === metadataRevision.current && response.op === "voice.orchestrators.list.result") {
          applyMetadata(response.payload);
        }
      }).catch(() => undefined);
    return () => {
      current = false;
      unsubscribeActivity();
      unsubscribeMetadata();
    };
  }, [manager, connected, generation, appState, runnerUrl, runnerToken, enabled]);

  return { activities, orchestrators };
}
