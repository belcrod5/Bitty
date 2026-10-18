import type { RunnerWebSocketManager } from "../runnerWs/RunnerWebSocketManager";
import type { RunnerWsMessage } from "../runnerWs/types";

export type VoiceTarget = { kind: "session"; sessionRef: { backendId: string; nativeSessionId: string | null }; cwd: string }
  | { kind: "orchestrator"; orchestratorId: string };
export type VoiceSnapshot = { desired: "stopped" | "listening"; observed: "stopped" | "waiting" | "starting" | "recording" | "unknown" };
export type AppControlOrigin = { clientInstanceId: string; connectionGeneration: string; surfaceId: string; ownerGeneration: number; target: VoiceTarget };
export type VoiceSurface = {
  id: string;
  panelId?: string;
  target: () => VoiceTarget;
  snapshot: () => VoiceSnapshot;
  draft: () => string;
  busy: () => boolean;
  canStart: () => boolean;
  controlVersion: () => number;
  hasPermission: () => Promise<boolean>;
  disarm: () => Promise<void>;
  start: () => Promise<void>;
  announce: (signal: AbortSignal) => Promise<void>;
  readyCue: () => Promise<void>;
  notice: (message: string) => void;
};
type Entry = { surface: VoiceSurface; generation: number; target: VoiceTarget };
type Result = VoiceSnapshot & { status: string; generation?: number; target?: VoiceTarget; reason?: string };
type Execution = { id: string; sourceId: string; connection: string; expires: number; cancelled: boolean; transferred: boolean; controller: AbortController; ownedGeneration?: number; target?: VoiceTarget; timer: ReturnType<typeof setTimeout> };
type Navigation = {
  preflight: (target: VoiceTarget) => Promise<string | null>;
  open: (target: VoiceTarget, signal: AbortSignal) => Promise<false | { panelId?: string }>;
  announce: (target: VoiceTarget, panelId: string | undefined, signal: AbortSignal) => Promise<void>;
  readyCue: () => Promise<void>;
  releaseSpeech?: (target: VoiceTarget, panelId: string | undefined) => Promise<void>;
  diag?: (operationId: string, stage: string, reason?: string) => void;
};
export function sameVoiceTarget(a: VoiceTarget, b: VoiceTarget) {
  return a.kind === b.kind && (a.kind === "orchestrator" ? a.orchestratorId === (b as typeof a).orchestratorId
    : a.sessionRef.backendId === (b as typeof a).sessionRef.backendId
      && a.sessionRef.nativeSessionId === (b as typeof a).sessionRef.nativeSessionId && a.cwd === (b as typeof a).cwd);
}
function isTarget(value: unknown): value is VoiceTarget {
  if (!value || typeof value !== "object") return false;
  const t = value as VoiceTarget;
  return t.kind === "orchestrator" ? typeof t.orchestratorId === "string" && !!t.orchestratorId
    : t.kind === "session" && typeof t.cwd === "string" && !!t.cwd && typeof t.sessionRef?.backendId === "string"
      && typeof t.sessionRef.nativeSessionId === "string" && !!t.sessionRef.nativeSessionId;
}

// One device microphone owner. This registry outlives every screen and source turn.
export class VoiceControl {
  private entries = new Map<string, Entry>();
  private owner: string | null = null;
  private interaction: { id: string; target: VoiceTarget } | null = null;
  private connection = "";
  private socketGeneration = -1;
  private foreground = true;
  private intent = 0;
  private generation = 0;
  private releaseBarrier: Promise<void> = Promise.resolve();
  private releasing = 0;
  private releaseFailed = false;
  private active = new Map<string, Execution>();
  private results = new Map<string, Result>();
  private navigation: Navigation | null = null;
  private stopSubscriptions: (() => void)[] = [];
  private publishTimer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshot = "";
  constructor(private manager: RunnerWebSocketManager) {}

  announce(target: VoiceTarget, panelId: string | undefined, signal: AbortSignal) { return this.navigation?.announce(target, panelId, signal) ?? Promise.resolve(); }
  readyCue() { return this.navigation?.readyCue() ?? Promise.resolve(); }
  isArmed() { return Array.from(this.entries.values()).some((e) => e.surface.snapshot().desired === "listening"); }
  isSessionOpen() { return this.releasing > 0 || this.releaseFailed || Array.from(this.entries.values()).some((e) => ["starting", "recording", "unknown"].includes(e.surface.snapshot().observed)); }
  async disarmCapturing() { await Promise.all(Array.from(this.entries.values()).filter((e) => ["starting", "recording", "unknown"].includes(e.surface.snapshot().observed)).map((e) => this.release(e.surface))); await this.releaseBarrier; }
  async disarmAll() { for (const op of this.active.values()) this.cancel(op); await Promise.all(Array.from(this.entries.values()).map((e) => this.release(e.surface))); await this.releaseBarrier; }
  private release(surface: VoiceSurface) {
    this.releasing += 1;
    const pending = surface.disarm().then(() => { this.releasing -= 1; }, (error) => {
      this.releasing -= 1; this.releaseFailed = true; throw error;
    });
    // Preserve pending/failed native release even after its screen has unmounted.
    this.releaseBarrier = Promise.all([this.releaseBarrier, pending]).then(() => undefined);
    void this.releaseBarrier.catch(() => undefined);
    return pending;
  }
  configure(navigation: Navigation) { this.navigation = navigation; }
  start() {
    if (this.stopSubscriptions.length) return () => undefined;
    const changed = () => {
      const snapshot = this.manager.getSnapshot();
      const ready = snapshot.connected && snapshot.appState === "active";
      this.foreground = snapshot.appState === "active";
      if (!ready || snapshot.generation !== this.socketGeneration) {
        if (this.connection) this.invalidate();
        this.connection = "";
      }
      if (!ready) { this.socketGeneration = -1; return; }
      if (snapshot.generation === this.socketGeneration) return;
      this.socketGeneration = snapshot.generation;
      const generation = snapshot.generation;
      void this.manager.request({ channel: "control", op: "app.control.register", payload: {
        version: 1, clientInstanceId: snapshot.clientInstanceId,
      } }).then((message) => {
        const p = message.payload as { version?: number; connectionGeneration?: string } | undefined;
        if (this.manager.getSnapshot().generation !== generation || !this.manager.getSnapshot().connected
          || message.op !== "app.control.register.result" || p?.version !== 1 || typeof p.connectionGeneration !== "string") return;
        this.connection = p.connectionGeneration;
        this.publish(true);
      }).catch(() => undefined);
    };
    this.stopSubscriptions = [this.manager.subscribeSnapshot(changed), this.manager.subscribe({ channel: "control" }, (m) => {
      if (m.op === "app.control.execute") void this.execute(m);
      if (m.op === "app.control.cancel") {
        const op = this.active.get(String(m.operationId || ""));
        if (op && (m.payload as { connectionGeneration?: string })?.connectionGeneration === op.connection) this.cancel(op);
      }
    })];
    // Only state changes are sent. Polling also observes synchronous native-hook refs.
    this.publishTimer = setInterval(() => this.publish(), 50);
    changed();
    return () => {
      this.stopSubscriptions.splice(0).forEach((stop) => stop());
      if (this.publishTimer) clearInterval(this.publishTimer);
      this.publishTimer = null;
      this.invalidate();
      this.connection = "";
      this.socketGeneration = -1;
    };
  }
  register(surface: VoiceSurface) {
    const entry = { surface, generation: 0, target: surface.target() };
    this.entries.set(surface.id, entry);
    this.publish(true);
    return () => {
      if (this.entries.get(surface.id) !== entry) return;
      this.entries.delete(surface.id);
      if (this.interaction?.id === surface.id && !Array.from(this.active.values()).some((op) => op.transferred)) this.interaction = null;
      if (this.owner === surface.id) { this.owner = null; this.intent += 1; }
      for (const op of this.active.values()) if (op.sourceId === surface.id && !op.transferred) this.cancel(op);
      void this.release(surface).catch(() => surface.notice("マイクの停止を確認できませんでした。"));
      this.publish(true);
    };
  }
  private refresh(entry: Entry) {
    const target = entry.surface.target();
    if (sameVoiceTarget(entry.target, target)) return;
    const resolved = entry.target.kind === "session" && target.kind === "session"
      && entry.target.sessionRef.nativeSessionId === null && !!target.sessionRef.nativeSessionId
      && entry.target.cwd === target.cwd && entry.target.sessionRef.backendId === target.sessionRef.backendId;
    entry.target = target;
    if (!resolved) {
      entry.generation = ++this.generation;
      if (this.owner === entry.surface.id) {
        this.owner = null; this.intent += 1;
        void this.release(entry.surface).catch(() => entry.surface.notice("マイクの停止を確認できませんでした。"));
      }
      for (const op of this.active.values()) if (op.sourceId === entry.surface.id && !op.transferred) this.cancel(op);
    }
    if (resolved && this.interaction?.id === entry.surface.id) this.interaction.target = target;
  }
  pendingTarget(target: VoiceTarget) { return Array.from(this.active.values()).some((op) => !op.cancelled && op.target && sameVoiceTarget(op.target, target)); }
  isOwner(id: string) { return this.owner === id; }
  async acquire(id: string, operation?: Execution) {
    const destination = this.entries.get(id);
    if (!destination || !this.foreground) return false;
    if (Array.from(this.entries.values()).some((e) => e.surface.snapshot().observed === "unknown")) throw new Error("microphone_release_unconfirmed");
    if (!operation) for (const op of this.active.values()) this.cancel(op);
    const intent = ++this.intent;
    await this.releaseBarrier;
    if (intent !== this.intent || !this.entries.has(id) || !this.foreground || (operation && !this.valid(operation))) return false;
    const previous = this.owner ? this.entries.get(this.owner) : undefined;
    this.owner = id;
    destination.generation = ++this.generation;
    this.interaction = { id, target: destination.surface.target() };
    if (previous && previous !== destination) {
      previous.generation = ++this.generation;
      try { await this.release(previous.surface); }
      catch (error) { if (intent === this.intent) this.owner = null; throw error; }
    }
    if (intent !== this.intent || this.owner !== id || (operation && !this.valid(operation))) return false;
    this.publish(true);
    return true;
  }
  async stopSurface(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    for (const op of this.active.values()) if (op.sourceId === id || this.owner === id) this.cancel(op);
    entry.generation = ++this.generation;
    this.intent += 1;
    // Keep interaction ownership: stopping input must not suppress its answer/TTS.
    await this.release(entry.surface);
    this.publish(true);
  }
  origin(panelId: string | undefined, target: VoiceTarget): AppControlOrigin | undefined {
    if (!this.connection || !this.foreground) return;
    for (const candidate of this.entries.values()) this.refresh(candidate);
    const matches = Array.from(this.entries.values()).filter((candidate) => candidate.surface.panelId === panelId && sameVoiceTarget(candidate.target, target));
    if (matches.length !== 1 || matches[0].surface.controlVersion() !== 1) return;
    const entry = matches[0];
    if (this.owner !== entry.surface.id) {
      const previous = this.owner ? this.entries.get(this.owner) : undefined;
      // A typed request may name its own stopped screen, but cannot take another live microphone.
      if (previous && previous.surface.snapshot().observed !== "stopped") return;
      if (previous?.surface.snapshot().desired === "listening") return;
      if (previous) previous.generation = ++this.generation;
      entry.generation = ++this.generation;
      this.owner = entry.surface.id;
      this.interaction = { id: entry.surface.id, target: entry.target };
      this.publish(true);
    }
    return { clientInstanceId: this.manager.getSnapshot().clientInstanceId, connectionGeneration: this.connection,
      surfaceId: entry.surface.id, ownerGeneration: entry.generation, target: entry.target };
  }
  allowsSpeech(id?: string, target?: VoiceTarget, panelId?: string) {
    if (!this.interaction) return true;
    if (id) return this.interaction.id === id && (!target || sameVoiceTarget(this.interaction.target, target));
    const entry = this.entries.get(this.interaction.id);
    return !!entry && entry.surface.panelId === panelId && (!target || sameVoiceTarget(entry.surface.target(), target));
  }
  private publish(force = false) {
    if (!this.connection) return;
    for (const e of this.entries.values()) this.refresh(e);
    const payload = { connectionGeneration: this.connection, foreground: this.foreground,
      surfaces: Array.from(this.entries.values()).filter((e) => e.surface.controlVersion() === 1).map((e) => ({
        surfaceId: e.surface.id, generation: e.generation, target: e.target, ...e.surface.snapshot(),
      })) };
    const serialized = JSON.stringify(payload);
    if (!force && serialized === this.lastSnapshot) return;
    this.lastSnapshot = serialized;
    try { this.manager.send({ channel: "control", op: "app.control.update", payload }); } catch { /* Never queue recording intents. */ }
  }
  private valid(op: Execution) { return !op.cancelled && this.foreground && this.connection === op.connection && Date.now() < op.expires; }
  private cancel(op: Execution) {
    if (op.cancelled) return;
    op.cancelled = true;
    op.controller.abort();
    this.intent += 1;
    const entry = this.owner ? this.entries.get(this.owner) : undefined;
    if (entry) void this.release(entry.surface).catch(() => entry.surface.notice("マイクの停止を確認できませんでした。"));
  }
  private invalidate() {
    for (const op of this.active.values()) this.cancel(op);
    for (const e of this.entries.values()) {
      e.generation = ++this.generation;
      void this.release(e.surface).catch(() => e.surface.notice("マイクの停止を確認できませんでした。"));
    }
    this.owner = null;
    this.intent += 1;
  }
  private report(id: string, connection: string, result: Result) {
    this.navigation?.diag?.(id, "result", result.reason || result.status);
    this.results.set(id, result);
    if (this.results.size > 256) this.results.delete(this.results.keys().next().value!);
    if (connection !== this.connection) return;
    this.publish(true);
    try { this.manager.send({ channel: "control", op: "app.control.result", operationId: id,
      payload: { connectionGeneration: connection, ...result } }); } catch { /* Results are read from Runner's ledger. */ }
  }
  private async wait<T>(op: Execution, pending: Promise<T>): Promise<T> {
    let cancel = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new Error("operation_cancelled"));
      op.controller.signal.addEventListener("abort", cancel, { once: true });
      if (!this.valid(op)) cancel();
    });
    try { return await Promise.race([pending, cancelled]); }
    finally { op.controller.signal.removeEventListener("abort", cancel); }
  }
  private async until(op: Execution, reason: string, read: () => boolean) {
    if (!read()) this.navigation?.diag?.(op.id, "waiting", reason);
    while (this.valid(op)) {
      if (read()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("operation_cancelled");
  }
  private async execute(message: RunnerWsMessage) {
    const p = message.payload as { action?: string; surfaceId?: string; expectedGeneration?: number; connectionGeneration?: string;
      target?: VoiceTarget; expiresAt?: string; callerOperationId?: string } | undefined;
    const id = message.operationId;
    if (!id || !p || p.connectionGeneration !== this.connection || !this.connection) return;
    const previous = this.results.get(id);
    if (previous) { this.report(id, this.connection, previous); return; }
    if (this.active.has(id)) return;
    const entry = this.entries.get(p.surfaceId || "");
    const result = (status: string, reason?: string): Result => ({ status, reason,
      ...(entry?.surface.snapshot() || { desired: "stopped", observed: "unknown" }),
      ...((this.releasing > 0 || this.releaseFailed) ? { observed: "unknown" as const } : {}), generation: entry?.generation, target: entry?.surface.target() });
    const reject = (status: string) => this.report(id, this.connection, result(status));
    if (!this.foreground) return reject("client_background");
    if (!entry) return reject("stale_origin");
    this.refresh(entry);
    if (entry.generation !== p.expectedGeneration || (this.owner && this.owner !== entry.surface.id)) return reject("owner_changed");
    if (entry.surface.controlVersion() !== 1) return reject("capability_unsupported");
    const expires = Date.parse(p.expiresAt || "");
    if (!Number.isFinite(expires) || expires <= Date.now()) return reject("failed");
    if (p.action !== "stop" && (p.action !== "handoff" || !isTarget(p.target))) return reject("failed");
    const op: Execution = { id, sourceId: entry.surface.id, connection: this.connection, expires, cancelled: false, transferred: false, controller: new AbortController(), target: p.target,
      timer: setTimeout(() => this.cancel(op), Math.max(0, expires - Date.now())) };
    this.active.set(id, op);
    this.navigation?.diag?.(id, "accepted", p.action);
    let destination = entry;
    try {
      if (p.action === "stop") {
        for (const other of this.active.values()) if (other !== op) this.cancel(other);
        entry.generation = ++this.generation;
        op.ownedGeneration = entry.generation;
        this.intent += 1;
        await this.wait(op, this.release(entry.surface));
        await this.wait(op, this.releaseBarrier);
        this.report(id, op.connection, result(this.valid(op) ? "applied" : "failed"));
        return;
      }
      const target = p.target!;
      const self = sameVoiceTarget(entry.target, target);
      if (entry.surface.draft().trim()) return this.report(id, op.connection, result("draft_conflict"));
      if (!await this.wait(op, entry.surface.hasPermission())) return this.report(id, op.connection, result("permission_required"));
      if (!this.valid(op)) throw new Error("operation_cancelled");
      if (!self) {
        const rejection = this.navigation ? await this.wait(op, this.navigation.preflight(target)) : "failed";
        if (rejection) return this.report(id, op.connection, result(rejection));
        const mounted = Array.from(this.entries.values()).filter((e) => sameVoiceTarget(e.surface.target(), target));
        if (mounted.some((e) => e.surface.busy())) return this.report(id, op.connection, result("target_busy"));
        if (mounted.some((e) => e.surface.draft().trim())) return this.report(id, op.connection, result("draft_conflict"));
      }
      if (!this.valid(op) || entry.generation !== p.expectedGeneration) throw new Error("operation_cancelled");
      entry.generation = ++this.generation;
      op.ownedGeneration = entry.generation;
      this.navigation?.diag?.(id, "release_input");
      await this.wait(op, this.release(entry.surface));
      if (!this.valid(op)) throw new Error("operation_cancelled");
      if (entry.surface.draft().trim()) return this.report(id, op.connection, result("draft_conflict"));
      if (self && (entry.surface.busy() || !entry.surface.canStart())) {
        this.report(id, op.connection, result("pending", "waiting_for_caller_reply"));
        await this.until(op, "caller_reply", () => !entry.surface.busy() && entry.surface.canStart());
      }
      if (!self) {
        this.interaction = { id: "handoff", target };
        this.owner = null;
        // Disable late source attachments before awaiting its exact playback release.
        this.navigation?.diag?.(id, "release_speech");
        const speechRelease = (this.navigation!.releaseSpeech?.(entry.target, entry.surface.panelId) ?? Promise.resolve())
          .catch((error) => { this.releaseFailed = true; throw error; });
        // Native stop may still change audio mode after cancellation. New owners wait for it too.
        this.releaseBarrier = Promise.all([this.releaseBarrier, speechRelease]).then(() => undefined);
        void this.releaseBarrier.catch(() => undefined);
        await this.wait(op, speechRelease);
        if (!this.valid(op)) throw new Error("operation_cancelled");
        op.transferred = true;
        this.navigation?.diag?.(id, "open_target");
        const opened = await this.wait(op, this.navigation!.open(target, op.controller.signal));
        if (!opened) throw new Error("target_restore_failed");
        await this.until(op, "target_surface", () => {
          const matches = Array.from(this.entries.values()).filter((e) => sameVoiceTarget(e.surface.target(), target) && e.surface.panelId === opened.panelId);
          if (matches.length !== 1) return false;
          destination = matches[0];
          return true;
        });
        if (destination.surface.draft().trim()) return this.report(id, op.connection, { ...destination.surface.snapshot(), status: "draft_conflict", target });
        if (destination.surface.busy()) return this.report(id, op.connection, { ...destination.surface.snapshot(), status: "target_busy", target });
      }
      await this.until(op, "target_ready", () => destination.surface.canStart());
      if (!await this.acquire(destination.surface.id, op)) throw new Error("owner_changed");
      op.ownedGeneration = destination.generation;
      this.navigation?.diag?.(id, "announce_target");
      await this.wait(op, destination.surface.announce(op.controller.signal));
      await new Promise((resolve) => setTimeout(resolve, 25));
      await this.until(op, "target_ready", () => destination.surface.canStart());
      if (!this.valid(op)) throw new Error("operation_cancelled");
      this.navigation?.diag?.(id, "start_input");
      await this.wait(op, destination.surface.start());
      await this.until(op, "native_recording", () => destination.surface.snapshot().observed === "recording");
      await this.wait(op, destination.surface.readyCue());
      if (!this.valid(op) || !this.isOwner(destination.surface.id)) throw new Error("operation_cancelled");
      this.report(id, op.connection, { status: "applied", generation: destination.generation, target,
        ...destination.surface.snapshot() });
    } catch (error) {
      if (op.ownedGeneration !== undefined && destination.generation === op.ownedGeneration) {
        await this.wait(op, this.release(destination.surface)).catch(() => undefined);
        destination.surface.notice((this.releasing > 0 || this.releaseFailed || destination.surface.snapshot().observed === "unknown")
          ? "マイクの停止を確認できませんでした。画面で入力状態を確認してください。"
          : "音声の切り替えを完了できませんでした。入力は停止しています。画面から再開してください。");
      }
      this.report(id, op.connection, { ...destination.surface.snapshot(),
        ...((this.releasing > 0 || this.releaseFailed) ? { observed: "unknown" as const } : {}), status: "failed", generation: destination.generation,
        target: destination.surface.target(), reason: error instanceof Error && ["operation_cancelled", "owner_changed", "target_restore_failed", "microphone_release_unconfirmed"].includes(error.message) ? error.message : "control_failed" });
    } finally {
      clearTimeout(op.timer);
      this.active.delete(id);
    }
  }
}
const controls = new WeakMap<RunnerWebSocketManager, VoiceControl>();
export function getVoiceControl(manager: RunnerWebSocketManager) {
  let control = controls.get(manager);
  if (!control) { control = new VoiceControl(manager); controls.set(manager, control); }
  return control;
}
