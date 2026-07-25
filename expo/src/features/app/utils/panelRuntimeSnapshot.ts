import type { RegisteredDirectoryEntry } from "../components/AppDrawer";
import type { PanelRuntimeSnapshot } from "../contexts/PanelRuntimeStoreContext";
import type { ConversationMessage } from "../types/appTypes";
import { deriveSessionExecutionStatusType } from "./sessionExecutionStatus";
import { normalizeModelRef } from "./settingsParsers";

export type PanelRuntimeSnapshotPatch = Partial<Omit<PanelRuntimeSnapshot, "conversationMessages">> & {
  conversationMessages?: ConversationMessage[];
};

export function normalizeRuntimePanelId(panelIdRaw: unknown) {
  const panelId = String(panelIdRaw || "").trim();
  return !panelId || panelId === "main" ? "" : panelId;
}

export function parseDirectoryMarkerColor(raw: unknown): RegisteredDirectoryEntry["markerColor"] {
  const value = String(raw || "").trim().toLowerCase();
  return value === "gray" || value === "red" || value === "yellow" || value === "green" || value === "black"
    ? value
    : "none";
}

export function cloneConversationMessages(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.map((message) => ({
    ...message,
    youtubeVideoIds: Array.isArray(message.youtubeVideoIds) ? [...message.youtubeVideoIds] : undefined,
    ttsWaveform: Array.isArray(message.ttsWaveform) ? [...message.ttsWaveform] : undefined,
    sttMeta: message.sttMeta ? { ...message.sttMeta } : undefined,
  }));
}

export function buildPanelRuntimeSnapshot(params: {
  panelId: string;
  base: PanelRuntimeSnapshot;
  patch?: PanelRuntimeSnapshotPatch;
  isCompactRunning: (sessionId: string) => boolean;
}): PanelRuntimeSnapshot {
  const { base, isCompactRunning } = params;
  const patch = params.patch || {};
  const contextUsedPctRaw = Object.prototype.hasOwnProperty.call(patch, "contextUsedPct")
    ? patch.contextUsedPct
    : base.contextUsedPct;
  const contextUsedPct = contextUsedPctRaw !== null && contextUsedPctRaw !== undefined && Number.isFinite(Number(contextUsedPctRaw))
    ? Math.max(0, Math.min(100, Math.round(Number(contextUsedPctRaw))))
    : null;
  const selectedSessionId = String(patch.selectedSessionId ?? base.selectedSessionId ?? "").trim();
  const isResponding = typeof patch.isResponding === "boolean" ? patch.isResponding : Boolean(base.isResponding);
  const snapshot: PanelRuntimeSnapshot = {
    panelId: normalizeRuntimePanelId(params.panelId),
    selectedSessionId,
    selectedDirectoryPath: String(patch.selectedDirectoryPath ?? base.selectedDirectoryPath ?? "").trim(),
    selectedDirectoryDisplayName: String(patch.selectedDirectoryDisplayName ?? base.selectedDirectoryDisplayName ?? "").trim(),
    selectedSessionTitle: String(patch.selectedSessionTitle ?? base.selectedSessionTitle ?? "").trim(),
    selectedSessionUpdatedAt: String(patch.selectedSessionUpdatedAt ?? base.selectedSessionUpdatedAt ?? "").trim(),
    selectedSessionMarkerColor: parseDirectoryMarkerColor(patch.selectedSessionMarkerColor ?? base.selectedSessionMarkerColor),
    selectedThreadStatusType: deriveSessionExecutionStatusType({
      threadStatusType: patch.selectedThreadStatusType ?? base.selectedThreadStatusType,
      isResponding,
      isCompactRunning: isCompactRunning(selectedSessionId),
    }),
    modelRef: normalizeModelRef(patch.modelRef ?? base.modelRef),
    reasoningEffort: String(patch.reasoningEffort ?? base.reasoningEffort ?? "").trim(),
    contextUsedPct,
    isResponding,
    isHydrating: typeof patch.isHydrating === "boolean" ? patch.isHydrating : Boolean(base.isHydrating),
    inheritedConversationMessages: cloneConversationMessages(
      Array.isArray(patch.inheritedConversationMessages) ? patch.inheritedConversationMessages : base.inheritedConversationMessages || []
    ),
    conversationMessages: cloneConversationMessages(
      Array.isArray(patch.conversationMessages) ? patch.conversationMessages : base.conversationMessages
    ),
  };
  const requestStartedAtMs = Number(patch.requestStartedAtMs ?? base.requestStartedAtMs ?? 0);
  if (snapshot.isResponding && Number.isFinite(requestStartedAtMs) && requestStartedAtMs > 0) {
    snapshot.requestStartedAtMs = requestStartedAtMs;
  }
  const scrollOffsetY = patch.scrollOffsetY ?? base.scrollOffsetY;
  const scrollViewportHeight = patch.scrollViewportHeight ?? base.scrollViewportHeight;
  const scrollNearBottom = patch.scrollNearBottom ?? base.scrollNearBottom;
  const ttsPlaybackMessageId = patch.ttsPlaybackMessageId ?? base.ttsPlaybackMessageId;
  if (typeof scrollOffsetY === "number") snapshot.scrollOffsetY = scrollOffsetY;
  if (typeof scrollViewportHeight === "number") snapshot.scrollViewportHeight = scrollViewportHeight;
  if (typeof scrollNearBottom === "boolean") snapshot.scrollNearBottom = scrollNearBottom;
  if (typeof ttsPlaybackMessageId === "string") snapshot.ttsPlaybackMessageId = ttsPlaybackMessageId;
  return snapshot;
}
