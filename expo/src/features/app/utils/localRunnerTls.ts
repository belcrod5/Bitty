import { NativeEventEmitter, NativeModules, Platform } from "react-native";
import { runnerHttpsOrigin, runnerLocalOrigin } from "./urlResolvers";
import { utf8ByteLength } from "../../ws/networkUsageMetrics";

type NativeTlsModule = {
  configure: (origin: string, certificate: string) => Promise<void>;
  connect: (id: number, url: string, headers: Record<string, string>) => void;
  send: (id: number, data: string, binary: boolean) => Promise<void>;
  close: (id: number, code: number, reason: string) => void;
  addListener: (event: string) => void;
  removeListeners: (count: number) => void;
};
type SocketEvent = { id: number; type: "open" | "message" | "error" | "close";
  data?: string; binary?: boolean; code?: number; reason?: string; message?: string };

let readyOrigin = "";
let readyCertificate = "";
let configurationQueue: Promise<unknown> = Promise.resolve();
let nextSocketId = 0;

function nativeModule(): NativeTlsModule | undefined {
  return Platform.OS === "ios" ? NativeModules.BittyRunnerTLS : undefined;
}

export function isLocalRunnerTlsReady(url: unknown, certificate?: unknown): boolean {
  const origin = runnerHttpsOrigin(url);
  return !!origin && origin === readyOrigin && !!readyCertificate
    && (certificate === undefined || String(certificate || "").trim() === readyCertificate);
}

export function isLocalRunnerReady(url: unknown, certificate?: unknown): boolean {
  const origin = runnerLocalOrigin(url);
  return !!origin && (!runnerHttpsOrigin(origin) || isLocalRunnerTlsReady(origin, certificate));
}

export async function configureLocalRunnerTls(url: unknown, certificate: unknown): Promise<boolean> {
  const origin = runnerHttpsOrigin(url);
  const anchor = String(certificate || "").trim();
  const module = nativeModule();
  if (!module) return false;
  const operation = configurationQueue.then(async () => {
    if (origin && anchor && isLocalRunnerTlsReady(origin, anchor)) return true;
    readyOrigin = "";
    readyCertificate = "";
    if (!origin || !anchor) {
      await module.configure("", "");
      return false;
    }
    await module.configure(origin, anchor);
    readyOrigin = origin;
    readyCertificate = anchor;
    return true;
  });
  configurationQueue = operation.catch(() => undefined);
  return operation;
}

class LocalRunnerWebSocket {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  bufferedAmount = 0;
  binaryType: BinaryType = "arraybuffer";
  protocol = "";
  extensions = "";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  private readonly id = ++nextSocketId;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  private readonly subscription: { remove: () => void };

  constructor(readonly url: string, private readonly module: NativeTlsModule, headers: Record<string, string>) {
    this.subscription = new NativeEventEmitter(module).addListener("BittyRunnerWebSocket", (event: SocketEvent) => {
      if (event.id !== this.id) return;
      let emitted: Record<string, unknown> = { type: event.type, target: this };
      if (event.type === "open") this.readyState = this.OPEN;
      if (event.type === "message") {
        let data: string | ArrayBuffer = event.data || "";
        if (event.binary) {
          const bytes = Uint8Array.from(globalThis.atob(data), (char) => char.charCodeAt(0));
          data = bytes.buffer;
        }
        emitted = { ...emitted, data };
      }
      if (event.type === "error") emitted.message = event.message || "local_runner_websocket_failed";
      if (event.type === "close") {
        this.readyState = this.CLOSED;
        this.subscription.remove();
        emitted = { ...emitted, code: event.code || 1006, reason: event.reason || "", wasClean: event.code === 1000 };
      }
      this.dispatchEvent(emitted as unknown as Event);
    });
    try { module.connect(this.id, url, headers); }
    catch (error) { this.subscription.remove(); throw error; }
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (!listener) return;
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (listener) this.listeners.get(type)?.delete(listener);
  }
  dispatchEvent(event: Event) {
    const callback = this[`on${event.type}` as "onopen"];
    callback?.(event);
    for (const listener of this.listeners.get(event.type) || []) {
      if (typeof listener === "function") listener.call(this, event);
      else listener.handleEvent(event);
    }
    return true;
  }
  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (this.readyState !== this.OPEN) throw new Error("WebSocket is not open");
    const bytes = typeof data === "string" ? null : data instanceof ArrayBuffer
      ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const encoded = bytes ? globalThis.btoa(Array.from(bytes, (value) => String.fromCharCode(value)).join("")) : String(data);
    const length = bytes?.byteLength ?? utf8ByteLength(String(data));
    this.bufferedAmount += length;
    void this.module.send(this.id, encoded, !!bytes).catch(() => {
      this.dispatchEvent({ type: "error", target: this } as unknown as Event);
    }).finally(() => { this.bufferedAmount = Math.max(0, this.bufferedAmount - length); });
  }
  close(code = 1000, reason = "") {
    if (this.readyState >= this.CLOSING) return;
    this.readyState = this.CLOSING;
    this.module.close(this.id, code, reason);
  }
}

export function createLocalRunnerWebSocket(url: string, headers: Record<string, string>): WebSocket | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "wss:") return null;
  parsed.protocol = "https:";
  const origin = parsed.origin;
  const module = nativeModule();
  if (!module || !isLocalRunnerTlsReady(origin)) return null;
  return new LocalRunnerWebSocket(url, module, headers) as unknown as WebSocket;
}
