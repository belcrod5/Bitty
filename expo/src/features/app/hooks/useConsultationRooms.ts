import { useCallback, useEffect, useRef, useState } from "react";
import type { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import type { VoiceTurnTraceData } from "../components/VoiceTurnTrace";

export type ConsultationProgress = VoiceTurnTraceData & { roomId: string; runId: string; generation: number; seq: number; textInterrupted?: boolean };
export type ConsultationRoom = {
  id: string; question: string; participants: string[]; profiles: Record<string, { orchestratorId: string; name: string; introduction?: string }>; template: string;
  generation: number; turns: number; maxTurns: number; revision: number; state: "idle" | "running" | "paused" | "stopped"; reason: string;
  messages: { id: string; seq: number; speakerId: string; source: string; text: string; at?: string; outputTokens?: number }[];
  steps?: { runId: string; orchestratorId: string; action: string; trace?: VoiceTurnTraceData }[];
  run: { id: string; orchestratorId: string; progress?: ConsultationProgress } | null;
  resetConfirmation?: { required?: boolean };
};
export type ConsultationRoomSummary = Pick<ConsultationRoom, "id" | "question" | "participants" | "profiles" | "generation" | "turns" | "maxTurns" | "revision" | "state" | "reason"> & {
  lastMessage?: ConsultationRoom["messages"][number];
};
export type ConsultationProgressDelta = {
  roomId: string; runId: string; generation: number; baseSeq: number; seq: number;
  message?: { id: string; phase: string | null; offset: number; append: string; truncated?: boolean };
  tool?: Partial<VoiceTurnTraceData["tools"][number]> & { id: string };
  toolOutput?: { id: string; offset: number; append: string };
  textInterrupted?: boolean;
};

export function applyConsultationProgressDelta(previous: ConsultationProgress, change: ConsultationProgressDelta): ConsultationProgress | null {
  if (change.baseSeq !== previous.seq || change.seq !== previous.seq + 1) return null;
  const next = { ...previous, seq: change.seq, messages: [...previous.messages], tools: [...previous.tools] };
  if (change.message) {
    const value = change.message, index = next.messages.findIndex((item) => item.id === value.id);
    const before = index < 0 ? { id: value.id, text: "", phase: null } : next.messages[index];
    if (value.offset !== before.text.length || typeof value.append !== "string") return null;
    const item = { ...before, phase: value.phase, text: before.text + value.append, truncated: value.truncated };
    if (index < 0) next.messages.push(item); else next.messages[index] = item;
  }
  if (change.tool) {
    const value = change.tool, index = next.tools.findIndex((item) => item.id === value.id);
    if (index < 0) {
      if (!value.type || !value.name || !value.status) return null;
      next.tools.push(value as VoiceTurnTraceData["tools"][number]);
    } else next.tools[index] = { ...next.tools[index], ...value };
  }
  if (change.toolOutput) {
    const value = change.toolOutput, index = next.tools.findIndex((item) => item.id === value.id);
    if (index < 0 || value.offset !== (next.tools[index].output || "").length || typeof value.append !== "string") return null;
    next.tools[index] = { ...next.tools[index], output: (next.tools[index].output || "") + value.append };
  }
  if (change.textInterrupted) next.textInterrupted = true;
  return next;
}

export function useConsultationRooms({ manager, connected, generation, selectedRoom, send, onError }: {
  manager: RunnerWebSocketManager; connected: boolean; generation: number; selectedRoom: string;
  send: (operation: string, payload?: Record<string, unknown>) => Promise<unknown>; onError: (message: string) => void;
}) {
  const [rooms, setRooms] = useState<ConsultationRoomSummary[]>([]);
  const [details, setDetails] = useState<Record<string, ConsultationRoom>>({});
  const roomSnapshots = useRef(details);
  const [defaultTemplate, setDefaultTemplate] = useState("");
  const [negotiation, setNegotiation] = useState<{ id: string; modern: boolean } | null>(null);
  const lease = useRef("");
  const selected = useRef(selectedRoom);
  const selectionEpoch = useRef(0);
  if (selected.current !== selectedRoom) selectionEpoch.current += 1;
  selected.current = selectedRoom;
  const requests = useRef(new Map<string, Promise<void>>());
  const applySummary = useCallback((value: ConsultationRoomSummary) => {
    const { id, question, participants, profiles, generation, turns, maxTurns, revision, state, reason, lastMessage } = value;
    value = { id, question, participants, profiles, generation, turns, maxTurns, revision, state, reason, lastMessage };
    setRooms((current) => {
      const previous = current.find((room) => room.id === value.id);
      return previous && previous.revision > value.revision ? current : [value, ...current.filter((room) => room.id !== value.id)];
    });
  }, []);
  const applyRoom = useCallback((value: ConsultationRoom) => {
    const previous = roomSnapshots.current[value.id];
    if (previous && previous.revision > value.revision) return;
    if (previous?.generation === value.generation && previous.run?.id === value.run?.id && value.run && value.state !== "stopped"
      && previous.run?.progress && previous.run.progress.seq > (value.run.progress?.seq || 0)) value = { ...value, run: { ...value.run, progress: previous.run.progress } };
    roomSnapshots.current = { ...roomSnapshots.current, [value.id]: value };
    setDetails(roomSnapshots.current);
    if (!previous || previous.revision !== value.revision) applySummary({ ...value, lastMessage: value.messages.at(-1) });
  }, [applySummary]);
  const loadRoom = useCallback((roomId: string) => {
    const activeLease = lease.current;
    if (!negotiation || negotiation.id !== activeLease) return Promise.resolve();
    const epoch = selectionEpoch.current, key = `${activeLease}:${epoch}:${roomId}`;
    const pending = requests.current.get(key);
    if (pending) return pending;
    const work = send("get", { roomId, ...(negotiation.modern ? { subscriptionId: activeLease } : {}) }).then((value) => {
      if (lease.current === activeLease && selectionEpoch.current === epoch && selected.current === roomId) applyRoom(value as ConsultationRoom);
    }).catch((cause) => { if (lease.current === activeLease && selectionEpoch.current === epoch && selected.current === roomId) onError(cause instanceof Error ? cause.message : "相談を読み込めません"); })
      .finally(() => { if (requests.current.get(key) === work) requests.current.delete(key); });
    requests.current.set(key, work);
    return work;
  }, [send, applyRoom, onError, negotiation]);
  useEffect(() => {
    const accept = (message: { operationId?: string }) => !message.operationId || message.operationId === lease.current;
    const changed = manager.subscribe({ channel: "agent", op: "voice.consultations.changed" }, (message) => {
      const value = message.payload as ConsultationRoom;
      if (accept(message) && value?.id && Array.isArray(value.messages)) applyRoom(value);
    });
    const summary = manager.subscribe({ channel: "agent", op: "voice.consultations.summary" }, (message) => {
      if (accept(message)) applySummary(message.payload as ConsultationRoomSummary);
    });
    const fullProgress = manager.subscribe({ channel: "agent", op: "voice.consultations.progress" }, (message) => {
      const progress = message.payload as ConsultationProgress, room = roomSnapshots.current[progress?.roomId];
      if (!accept(message) || !room || room.generation !== progress.generation || room.run?.id !== progress.runId
        || room.state !== "running" || (room.run.progress?.seq || 0) >= progress.seq) return;
      applyRoom({ ...room, run: { ...room.run, progress } });
    });
    const delta = manager.subscribe({ channel: "agent", op: "voice.consultations.progress.delta" }, (message) => {
      const change = message.payload as ConsultationProgressDelta;
      if (!accept(message) || !change?.roomId || change.roomId !== selected.current) return;
      const room = roomSnapshots.current[change.roomId];
      if (room && change.generation < room.generation) return;
      if (!room || room.generation !== change.generation || room.run?.id !== change.runId) { void loadRoom(change.roomId); return; }
      if (room.state !== "running" || change.seq <= (room.run.progress?.seq || 0)) return;
      const previous = room.run.progress || { roomId: room.id, runId: room.run.id, generation: room.generation, seq: 0, messages: [], tools: [] };
      const progress = applyConsultationProgressDelta(previous, change);
      if (!progress) { void loadRoom(room.id); return; }
      applyRoom({ ...room, run: { ...room.run, progress } });
    });
    return () => { changed(); summary(); fullProgress(); delta(); };
  }, [manager, applyRoom, applySummary, loadRoom]);
  useEffect(() => {
    if (!connected) { void manager.connect().catch(() => {}); return; }
    const id = `consultation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    lease.current = id; setNegotiation(null);
    // Revisions belong to this connection's store epoch. A restored Runner
    // can legitimately start again at a lower revision.
    selectionEpoch.current += 1;
    roomSnapshots.current = {}; setDetails({}); setRooms([]);
    let current = true;
    void send("list", { updates: "delta", subscriptionId: id, roomId: selected.current }).then((payload) => {
      if (!current || lease.current !== id) return;
      const value = payload as { rooms: (ConsultationRoom | ConsultationRoomSummary)[]; defaultTemplate: string; updates?: string; subscriptionId?: string };
      const supported = value.updates === "delta" && value.subscriptionId === id;
      setNegotiation({ id, modern: supported }); setDefaultTemplate(value.defaultTemplate);
      for (const room of value.rooms) {
        if ("messages" in room) applyRoom(room); else applySummary(room);
      }
    }).catch((cause) => { if (current) onError(cause instanceof Error ? cause.message : "相談を読み込めません"); });
    return () => { current = false; if (lease.current === id) lease.current = ""; void send("unsubscribe", { subscriptionId: id }).catch(() => {}); };
  }, [manager, connected, generation, send, applyRoom, applySummary, onError]);
  useEffect(() => {
    if (!connected || !negotiation || negotiation.id !== lease.current) return;
    if (selectedRoom) {
      if (negotiation.modern || !roomSnapshots.current[selectedRoom]) void loadRoom(selectedRoom);
    } else if (negotiation.modern) void send("get", { roomId: "", subscriptionId: lease.current }).catch(() => {});
  }, [connected, generation, negotiation, selectedRoom, loadRoom, send]);
  return { rooms, room: details[selectedRoom], roomSnapshots, applyRoom, defaultTemplate };
}
