import { VoiceControl, type VoiceSurface, type VoiceTarget, type VoiceSnapshot } from "./voiceControl";
import type { RunnerWsMessage } from "../runnerWs/types";
import type { RunnerWebSocketManager } from "../runnerWs/RunnerWebSocketManager";
import { recordHttpNetworkUsage, subscribeNetworkUsageIdleObservations, updateNetworkUsageObservationAppState,
  type NetworkUsageIdleObservation } from "../ws/networkUsageMetrics";

const a: VoiceTarget = { kind: "orchestrator", orchestratorId: "main" };
const b: VoiceTarget = { kind: "session", sessionRef: { backendId: "claude", nativeSessionId: "chat-b" }, cwd: "/work" };
function fixture() {
  const sent: RunnerWsMessage[] = [];
  let state = { connected: true, appState: "active", generation: 1, clientInstanceId: "device-a" };
  let receive: (m: RunnerWsMessage) => void = () => {};
  let changed = () => {};
  const manager = {
    getSnapshot: () => state,
    subscribeSnapshot: (fn: typeof changed) => { changed = fn; return () => {}; },
    subscribe: (_filter: unknown, fn: typeof receive) => { receive = fn; return () => {}; },
    request: jest.fn(async () => ({ op: "app.control.register.result", payload: { version: 1, connectionGeneration: `connection-${state.generation}` } })),
    send: (m: RunnerWsMessage) => { sent.push(m); },
  } as unknown as RunnerWebSocketManager;
  const control = new VoiceControl(manager);
  const navigation = { preflight: jest.fn(async (_target: VoiceTarget): Promise<string | null> => null),
    open: jest.fn(async (_target: VoiceTarget): Promise<false | { panelId?: string }> => ({ panelId: "popup" })),
    announce: jest.fn(async () => {}), releaseSpeech: jest.fn(async (_target: VoiceTarget, _panelId?: string) => {}), diag: jest.fn((_operationId: string, _stage: string, _reason?: string) => {}) };
  control.configure(navigation);
  const stop = control.start();
  const surface = (id: string, target: VoiceTarget, panelId?: string) => {
    const state = { target, draft: "", busy: false, canStart: true,
      snapshot: { desired: "stopped", observed: "stopped" } as VoiceSnapshot };
    const value: VoiceSurface = { id, panelId, target: () => state.target, snapshot: () => state.snapshot,
      draft: () => state.draft, busy: () => state.busy, canStart: () => state.canStart,
      controlVersion: () => 1, hasPermission: jest.fn(async () => true),
      disarm: jest.fn(async () => { state.snapshot = { desired: "stopped", observed: "stopped" }; }),
      start: jest.fn(async () => { state.snapshot = { desired: "listening", observed: "recording" }; }),
      announce: jest.fn(async () => {}), notice: jest.fn() };
    const unregister = control.register(value);
    return { value, state, unregister };
  };
  const source = surface("source", a);
  const command = (action: "stop" | "handoff", extra: Record<string, unknown> = {}, id = `epoch.${sent.length}`) => {
    const origin = control.origin(undefined, a);
    receive({ channel: "control", op: "app.control.execute", operationId: id, payload: {
      action, surfaceId: "source", expectedGeneration: origin?.ownerGeneration,
      connectionGeneration: "connection-1", expiresAt: new Date(Date.now() + 1_000).toISOString(),
      ...(action === "handoff" ? { target: b } : {}), ...extra,
    } });
    return id;
  };
  const result = (id: string) => sent.filter((m) => m.op === "app.control.result" && m.operationId === id).at(-1)?.payload as Record<string, unknown> | undefined;
  const updateConnection = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; changed(); };
  const begin = async () => { await Promise.resolve(); await control.acquire("source"); await source.value.start(); };
  return { control, source, surface, sent, command, result, updateConnection, navigation, begin, stop, receive, manager };
}
const settle = async (ms = 0) => { await jest.advanceTimersByTimeAsync(ms); };
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test("stop disarms a reply wait immediately and ACKs only after native release; same surface keeps TTS", async () => {
  const f = fixture(); await f.begin();
  f.source.state.snapshot = { desired: "listening", observed: "waiting" };
  let release!: () => void;
  f.source.value.disarm = jest.fn(() => {
    f.source.state.snapshot = { desired: "stopped", observed: "unknown" };
    return new Promise((resolve) => { release = () => { f.source.state.snapshot.observed = "stopped"; resolve(); }; });
  });
  const id = f.command("stop");
  expect(f.source.state.snapshot.desired).toBe("stopped");
  expect(f.result(id)).toBeUndefined();
  release(); await settle();
  expect(f.result(id)).toMatchObject({ status: "applied", desired: "stopped", observed: "stopped", target: a });
  expect(f.control.allowsSpeech("source", a)).toBe(true);
  expect(f.navigation.releaseSpeech).not.toHaveBeenCalled();
  const calls = (f.source.value.disarm as jest.Mock).mock.calls.length;
  f.command("stop", {}, id); await settle();
  expect(f.source.value.disarm).toHaveBeenCalledTimes(calls);
  f.stop();
});

test("manual acquisition is exclusive and old generation/other connection cannot stop the new owner", async () => {
  const f = fixture(); await f.begin();
  const origin = f.control.origin(undefined, a)!;
  const destination = f.surface("destination", b, "popup");
  await f.control.acquire("destination"); await destination.value.start();
  expect(f.source.state.snapshot.observed).toBe("stopped");
  const id = f.command("stop", { expectedGeneration: origin.ownerGeneration }); await settle();
  expect(f.result(id)?.status).toBe("owner_changed");
  expect(destination.state.snapshot.observed).toBe("recording");
  const foreign = f.command("stop", { connectionGeneration: "another-device" }); await settle();
  expect(f.result(foreign)).toBeUndefined();
  expect(f.control.allowsSpeech("source", a)).toBe(false);
  expect(f.control.allowsSpeech("destination", b)).toBe(true);
  f.stop();
});

test("handoff releases A, uses the exact normal popup even with another panel of B, waits native ready, then confirms", async () => {
  const f = fixture(); await f.begin();
  const hidden = f.surface("hidden", b, "other-panel");
  const destination = f.surface("destination", b, "popup");
  destination.value.start = jest.fn(async () => { destination.state.snapshot = { desired: "listening", observed: "starting" }; });
  const before = f.control.origin(undefined, a)!.ownerGeneration;
  const id = f.command("handoff"); await settle(30);
  expect(f.source.state.snapshot.observed).toBe("stopped");
  expect(destination.value.start).toHaveBeenCalledTimes(1);
  expect(hidden.value.start).not.toHaveBeenCalled();
  expect(f.result(id)).toBeUndefined();
  destination.state.snapshot.observed = "recording"; await settle(30);
  expect(f.result(id)).toMatchObject({ status: "applied", target: b, desired: "listening", observed: "recording" });
  expect(Number(f.result(id)?.generation)).toBeGreaterThan(before);
  f.stop();
});

test.each(["draft_conflict", "target_busy", "target_not_found"])("preflight %s leaves A listening", async (reason) => {
  const f = fixture(); await f.begin();
  f.navigation.preflight.mockResolvedValue(reason);
  const id = f.command("handoff"); await settle();
  expect(f.result(id)?.status).toBe(reason);
  expect(f.source.state.snapshot.observed).toBe("recording");
  expect(f.navigation.open).not.toHaveBeenCalled();
  f.stop();
});

test("permission inspection never opens a remote OS prompt or releases source", async () => {
  const f = fixture(); await f.begin();
  (f.source.value.hasPermission as jest.Mock).mockResolvedValue(false);
  const id = f.command("handoff"); await settle();
  expect(f.result(id)?.status).toBe("permission_required");
  expect(f.source.state.snapshot.observed).toBe("recording");
  f.stop();
});

test("interim draft discovered at native teardown is preserved without navigation", async () => {
  const f = fixture(); await f.begin();
  f.source.value.disarm = jest.fn(async () => { f.source.state.draft = "unsent speech";
    f.source.state.snapshot = { desired: "stopped", observed: "stopped" }; });
  const id = f.command("handoff"); await settle();
  expect(f.result(id)).toMatchObject({ status: "draft_conflict", desired: "stopped" });
  expect(f.navigation.open).not.toHaveBeenCalled();
  expect(f.source.state.draft).toBe("unsent speech");
  f.stop();
});

test("same-target handoff reports waiting promptly, finishes after the caller reply/TTS, and never blocks the caller", async () => {
  const f = fixture(); await f.begin();
  f.source.state.busy = true; f.source.state.canStart = false;
  const id = f.command("handoff", { target: a }); await settle();
  expect(f.result(id)).toMatchObject({ status: "pending", reason: "waiting_for_caller_reply" });
  expect(f.navigation.releaseSpeech).not.toHaveBeenCalled();
  expect(f.source.value.start).toHaveBeenCalledTimes(1);
  f.source.state.busy = false; await settle(100);
  expect(f.result(id)?.status).toBe("pending");
  f.source.state.canStart = true; await settle(75);
  expect(f.result(id)).toMatchObject({ status: "applied", target: a, observed: "recording" });
  f.stop();
});

test.each(["stop", "expiry", "background", "disconnect", "cancel"])("%s cancels a pending start and late readiness cannot restart", async (event) => {
  const f = fixture(); await f.begin();
  f.source.state.busy = true; f.source.state.canStart = false;
  const id = f.command("handoff", { target: a }); await settle();
  if (event === "stop") { const stopped = f.command("stop"); await settle(); expect(f.result(stopped)?.status).toBe("applied"); }
  if (event === "expiry") await settle(1_100);
  if (event === "background") f.updateConnection({ appState: "background" });
  if (event === "disconnect") f.updateConnection({ connected: false });
  if (event === "cancel") f.receive({ channel: "control", op: "app.control.cancel", operationId: id, payload: { connectionGeneration: "connection-1", reason: "deadline_exceeded" } });
  f.source.state.busy = false; f.source.state.canStart = true;
  await settle(100);
  expect(f.source.value.start).toHaveBeenCalledTimes(1);
  expect(f.source.state.snapshot.observed).toBe("stopped");
  f.stop();
});

test("handoff result survives source unmount and original run completion", async () => {
  const f = fixture(); await f.begin();
  let destination: ReturnType<typeof f.surface>;
  f.navigation.open.mockImplementation(async () => {
    f.source.unregister(); destination = f.surface("destination", b, "popup"); return { panelId: "popup" };
  });
  const id = f.command("handoff"); await settle(75);
  expect(destination!.state.snapshot.observed).toBe("recording");
  expect(f.result(id)).toMatchObject({ status: "applied", target: b });
  expect(f.control.origin(undefined, a)).toBeUndefined();
  f.stop();
});

test("first session resolution keeps owner generation, later manual target replacement invalidates it", async () => {
  const f = fixture();
  const pending: VoiceTarget = { kind: "session", sessionRef: { backendId: "codex", nativeSessionId: null }, cwd: "/work" };
  f.source.state.target = pending;
  await f.begin();
  const first = f.control.origin(undefined, pending)!;
  f.source.state.target = { ...pending, sessionRef: { ...pending.sessionRef, nativeSessionId: "resolved" } };
  const resolved = f.control.origin(undefined, f.source.state.target)!;
  expect(resolved.ownerGeneration).toBe(first.ownerGeneration);
  f.source.state.target = b; await settle(50);
  expect(f.control.origin(undefined, b)!.ownerGeneration).toBeGreaterThan(resolved.ownerGeneration);
  expect(f.source.state.snapshot.observed).toBe("stopped");
  f.stop();
});

test("a typed turn on its registered stopped screen receives origin and can start after its reply", async () => {
  const f = fixture(); await settle();
  const origin = f.control.origin(undefined, a)!;
  expect(origin).toMatchObject({ surfaceId: "source", target: a });
  expect(f.source.value.start).not.toHaveBeenCalled();
  f.source.state.busy = true; f.source.state.canStart = false;
  const id = f.command("handoff", { target: a }); await settle();
  expect(f.result(id)).toMatchObject({ status: "pending", reason: "waiting_for_caller_reply" });
  f.source.state.busy = false; f.source.state.canStart = true; await settle(75);
  expect(f.result(id)).toMatchObject({ status: "applied", observed: "recording" });
  f.stop();
});

test("a typed turn in a different panel cannot acquire another live microphone", async () => {
  const f = fixture(); await f.begin();
  const destination = f.surface("typed-panel", b, "popup");
  expect(f.control.origin("popup", b)).toBeUndefined();
  expect(destination.value.disarm).not.toHaveBeenCalled();
  expect(f.source.state.snapshot.observed).toBe("recording");
  f.stop();
});

test("canceled same-target reply wait cannot disarm a newer manual recording", async () => {
  const f = fixture(); await f.begin();
  f.source.state.busy = true; f.source.state.canStart = false;
  const id = f.command("handoff", { target: a }); await settle();
  expect(f.result(id)?.reason).toBe("waiting_for_caller_reply");
  await f.control.acquire("source");
  f.source.state.busy = false; f.source.state.canStart = true;
  await f.source.value.start();
  const releases = (f.source.value.disarm as jest.Mock).mock.calls.length;
  await settle(50);
  expect(f.source.state.snapshot.observed).toBe("recording");
  expect(f.source.value.disarm).toHaveBeenCalledTimes(releases);
  expect(f.result(id)?.status).toBe("failed");
  f.stop();
});

test("unmount retains a native release barrier before any other surface can start", async () => {
  const f = fixture(); await f.begin();
  let release!: () => void;
  f.source.value.disarm = jest.fn(() => new Promise((resolve) => { release = resolve; }));
  f.source.unregister();
  const destination = f.surface("destination", b, "popup");
  let acquired = false;
  const acquisition = f.control.acquire("destination").then((value) => { acquired = value; });
  await settle();
  expect(acquired).toBe(false);
  release(); await acquisition;
  expect(acquired).toBe(true);
  await destination.value.start();
  expect(destination.state.snapshot.observed).toBe("recording");
  f.stop();
});

test("failed unmounted native release blocks a different microphone owner", async () => {
  const f = fixture(); await f.begin();
  f.source.value.disarm = jest.fn(async () => { throw new Error("release_failed"); });
  f.source.unregister();
  f.surface("destination", b, "popup");
  await expect(f.control.acquire("destination")).rejects.toThrow("release_failed");
  f.stop();
});

test.each(["pending", "failed"])("typed stop cannot confirm stopped while unmounted microphone release is %s", async (outcome) => {
  const f = fixture(); await f.begin();
  let release!: () => void;
  f.source.value.disarm = jest.fn(() => outcome === "failed" ? Promise.reject(new Error("release_failed"))
    : new Promise((resolve) => { release = resolve; }));
  f.source.unregister();
  const destination = f.surface("typed-stop", b, "popup");
  const origin = f.control.origin("popup", b)!;
  const id = `epoch.stop-${outcome}`;
  f.receive({ channel: "control", op: "app.control.execute", operationId: id, payload: {
    action: "stop", surfaceId: origin.surfaceId, expectedGeneration: origin.ownerGeneration,
    connectionGeneration: "connection-1", expiresAt: new Date(Date.now() + 1_000).toISOString(),
  } });
  await settle();
  if (outcome === "pending") { expect(f.result(id)).toBeUndefined(); await settle(1_100); }
  expect(f.result(id)).toMatchObject({ status: "failed", observed: "unknown" });
  expect(destination.state.snapshot.desired).toBe("stopped");
  if (release) { release(); await settle(); }
  f.stop();
});


test.each(["unmount", "manual_owner", "target_change"])("%s during native speech release cannot complete an old handoff", async (event) => {
  const f = fixture(); await f.begin();
  const destination = f.surface("destination", b, "popup");
  let finishSpeech!: () => void;
  f.navigation.releaseSpeech.mockImplementation(() => new Promise<void>((resolve) => { finishSpeech = resolve; }));
  const id = f.command("handoff"); await settle();
  expect(f.control.allowsSpeech("source", a)).toBe(false);
  expect(f.navigation.open).not.toHaveBeenCalled();
  if (event === "unmount") f.source.unregister();
  if (event === "target_change") { f.source.state.target = b; await settle(60); }
  const manualStart = event === "manual_owner" ? f.control.acquire("destination").then(async (acquired) => {
    if (acquired) await destination.value.start();
  }) : Promise.resolve();
  await settle();
  expect(destination.value.start).not.toHaveBeenCalled();
  finishSpeech(); await manualStart; await settle(100);
  expect(f.result(id)?.status).toBe("failed");
  expect(f.navigation.open).not.toHaveBeenCalled();
  expect(destination.value.start).toHaveBeenCalledTimes(event === "manual_owner" ? 1 : 0);
  if (event === "manual_owner") expect(destination.state.snapshot.observed).toBe("recording");
  f.stop();
});

test("handoff diagnostics expose finite stages and operation correlation without target identifiers", async () => {
  const f = fixture(); await f.begin();
  f.surface("destination", b, "popup");
  const id = f.command("handoff"); await settle(100);
  expect(f.navigation.diag.mock.calls.map((call) => call.slice(1))).toEqual([
    ["accepted", "handoff"], ["release_input"], ["release_speech"], ["open_target"], ["announce_target"], ["start_input"], ["result", "applied"],
  ]);
  expect(f.navigation.diag.mock.calls.every((call) => call[0] === id)).toBe(true);
  f.stop();
});

test("a remote voice command interrupts idle observation before executing or returning a result", async () => {
  const f = fixture(); await f.begin();
  updateNetworkUsageObservationAppState("active");
  updateNetworkUsageObservationAppState("background");
  updateNetworkUsageObservationAppState("active");
  const observations: NetworkUsageIdleObservation[] = [];
  const unsubscribe = subscribeNetworkUsageIdleObservations((value) => observations.push(value));
  observations.length = 0;
  recordHttpNetworkUsage("https://runner/client-state", 0, 20);
  const id = f.command("stop");
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({ endReason: "external_action", comparisonEligible: false,
    usage: { totalReceivedBytes: 20 } });
  await settle();
  expect(f.result(id)?.status).toBe("applied");
  unsubscribe();
  f.stop();
});
