# WebSocket Singleton Design

## 1. Current Source Facts

- Expo creates real sockets through `expo/src/features/ws/webSocketAuth.ts`.
  `createWebSocketWithOptionalAuth()` is a factory only. It does not own lifecycle,
  reconnect, routing, or subscriptions.
- LLM turn execution creates its own socket in
  `expo/src/features/codex/client/turn.ts`, then closes it when the turn succeeds,
  fails, or is interrupted. It also owns reconnect/resume logic locally.
- Relay observation creates another socket in
  `expo/src/features/codex/client/turnRelayObserver.ts`. It has its own heartbeat,
  reconnect, and resume handling.
- One-shot Codex operations such as `rpcSession`, `compact`, `probe`, and
  diagnostics also create temporary WebSockets.
- Stream TTS currently creates a separate WebSocket in
  `expo/src/features/app/hooks/useSynthesizeSpeechStreamController.ts`.
  It can use `/stream-tts` or the `tts` channel on `/runner-ws`, then closes the
  socket when the stream is done.
- The existing runner WebSocket types already include `tts` and `streamId` in
  `expo/src/features/runnerWs/types.ts`. The singleton should reuse this envelope
  instead of inventing another message format.
- Those types do not currently have `operationId`. It must be added before
  moving start-style LLM/TTS operations onto the singleton.
- Server `/runner-ws` currently accepts multi-channel JSON, but its per-connection
  state is still partly single-purpose: one `llmRelay` and one `attachedTtsJobId`
  are stored for a connection. A true app-wide singleton needs these server-side
  attachments to be keyed by `threadId` / `streamId`, not by the WebSocket itself.
- Server `/runner-ws` already sends `control:ready` after connection. Client code
  must not treat `onopen` as fully usable until this message is received.
- Current `tts:start` creates the server job immediately and returns
  `job_started` with the server `streamId`. If the socket disconnects before that
  response, the client has no durable way to discover which `streamId` was
  created.
- App foreground/background state is already observed in
  `expo/src/features/app/hooks/useAppStateAutoRecoveryController.ts`, but it is
  focused on recording/TTS recovery. It does not own a global WebSocket lifecycle.

## 2. Server Capability Facts

- `private_runner/README.md` documents `/runner-ws` as the integrated endpoint.
- `/runner-ws` already uses an envelope:

```json
{
  "channel": "llm",
  "op": "rpc",
  "requestId": "optional-client-request-id",
  "threadId": "optional-thread-id",
  "seq": 0,
  "payload": {}
}
```

- The server supports these `/runner-ws` channels today:
  `control`, `llm`, `relay`, and `tts`.
- The server still exposes legacy `WS /stream-tts`.
- TTS audio bytes are not sent through WebSocket. Stream TTS returns `audioUrl`,
  and the audio body is served separately from `/tts-media/<id>`.
- Non-stream TTS is HTTP `POST /tts`.
- STT audio upload is HTTP `POST /stt` with `FormData`.
- Buffered client logs are HTTP `POST /client-logs`.

## 3. Target Boundary

Use one app-wide WebSocket connection for all JSON message traffic that uses
WebSocket:

- `control`: ready, ping, pong, server status, errors
- `llm`: Codex JSON-RPC envelope traffic
- `relay`: attach/resume/seq events for thread observation
- `tts`: stream TTS control events such as start, progress, done, error, and
  `audioUrl` notification

The rule is intentionally broad: if it is a WebSocket JSON message, it belongs
to the singleton manager. Do not create a second feature-specific WebSocket for
JSON control traffic. If a future feature needs to send a very large JSON
payload over WebSocket, stop and discuss whether that payload should be moved to
HTTP or another data API instead.

Do not move heavy binary or bulk transport into this singleton:

- TTS audio body stays on HTTP `/tts-media/<id>`.
- Normal TTS synthesis stays on HTTP `POST /tts`.
- STT audio upload stays on HTTP `POST /stt`.
- Buffered/heavy client logs stay on HTTP `POST /client-logs`.
- Legacy `WS /stream-tts` should be migrated into the singleton when stream TTS
  is moved, because its control payloads are JSON. Only the audio body remains
  outside the singleton.

## 4. Proposed Client Shape

Add a real manager under `expo/src/features/runnerWs/`:

- `RunnerWebSocketManager.ts`
  - owns the single `WebSocket | null`
  - owns connect/reconnect/disconnect
  - owns foreground/background lifecycle hooks
  - owns heartbeat/ping status
  - rejects `send` / `request` while reconnecting or disconnected
  - owns message routing to subscribers
  - never closes just because a screen unsubscribed
- `RunnerWebSocketContext.tsx`
  - React provider/hook for UI and feature modules
  - exposes `send`, `subscribe`, `request`, `connect`, `disconnect`, `snapshot`
- Existing `llmAdapter.ts` / `types.ts`
  - keep envelope encoding/parsing helpers
  - extend types only if the manager needs stronger filters

Example API shape:

```ts
type RunnerWsEnvelope = {
  channel: "control" | "llm" | "relay" | "tts";
  op: string;
  operationId?: string;
  requestId?: string;
  sessionId?: string;
  threadId?: string;
  streamId?: string;
  payload?: unknown;
};

type RunnerWsFilter = {
  channel?: RunnerWsEnvelope["channel"];
  op?: string;
  operationId?: string;
  requestId?: string;
  sessionId?: string;
  threadId?: string;
  streamId?: string;
};

type RunnerWsConnectionSnapshot = {
  connectionState:
    | "idle"
    | "connecting"
    | "handshaking"
    | "ready"
    | "reconnecting"
    | "background"
    | "stopped";
  appState: "active" | "inactive" | "background" | "unknown";
  clientInstanceId: string;
  connectionId?: string;
  generation: number;
  pendingRequestCount: number;
  subscriptionCount: number;
  bufferedAmount: number;
  lastPongAt?: number;
  runnerWsConnectionCount?: number;
  lastError?: string;
};

type RunnerWsManager = {
  connect(): Promise<void>;
  disconnect(
    reason: "background" | "manual" | "logout" | "config-changed"
  ): void;
  send(message: RunnerWsEnvelope): void;
  request<TResponse>(
    message: RunnerWsEnvelope,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
    }
  ): Promise<TResponse>;
  subscribe(
    filter: RunnerWsFilter,
    handler: (message: RunnerWsEnvelope) => void
  ): () => void;
  getSnapshot(): RunnerWsConnectionSnapshot;
  subscribeSnapshot(handler: () => void): () => void;
};
```

The manager should match messages by explicit fields, not by string channel keys.
UI hooks can still expose convenience helpers such as `subscribeToThread(threadId,
handler)` if there are multiple real call sites.

Manager behavior rules:

- `connect()` is single-flight. Concurrent callers share the same connection
  attempt.
- `send()` throws immediately unless the manager state is `ready`.
- `request()` rejects immediately unless the manager state is `ready`.
- When the socket disconnects, every pending request is rejected.
- Timeout and abort always remove the request from the pending map.
- Messages are never queued while disconnected, reconnecting, or handshaking.
- `send()` returns `void`; callers must not depend on a generated id hidden in the
  return value.
- While AppState is `inactive`, existing in-flight traffic and control messages
  may continue, but new start-style operations must be rejected or held by the
  feature until AppState returns to `active`. Do not enqueue those starts in the
  manager.

`RunnerWebSocketContext` should contain only the stable manager instance. Do not
store received messages, TTS progress, or feature state directly in React
Context. Connection state should be read with an external-store subscription:

```ts
const snapshot = useSyncExternalStore(
  manager.subscribeSnapshot,
  manager.getSnapshot
);
```

Screens and feature controllers subscribe only to the messages they need, then
store display data in local state or a feature-owned store.

## 5. Logical Identity Rules

One physical WebSocket no longer identifies one feature operation. Every
long-running or request/response operation must have a client-generated logical
id before the first message is sent. These ids should be UUID-like opaque
strings; do not derive routing from the physical WebSocket instance.

- `operationId`
  - identifies one logical long-running operation before server ids exist.
  - required for start-style operations such as LLM session/turn start and
    `tts:start`.
  - used by the server as an idempotency key. Retrying the same start with the
    same `operationId` must not create a duplicate thread/job.
  - remains valid for status/attach/resume if the socket disconnects before the
    first server response is received.
- `requestId`
  - identifies one request/response operation.
  - required for `request()` calls.
  - may equal `operationId` for start messages, but start-message recovery must
    not depend on response matching alone. The server must persist the idempotent
    operation mapping.
- `sessionId`
  - identifies one logical LLM session before `threadId` exists.
  - required on LLM RPC traffic from the first `initialize` / `thread/start`
    message, not only after `activeThreadId` is known.
- `threadId`
  - identifies an established LLM thread once the server or upstream has created
    it.
  - cannot be the only routing key for initial LLM RPCs because it does not
    exist yet.
- `streamId`
  - identifies a TTS stream/job after it is known.
  - for `tts:start`, the client must include `operationId` so the `job_started`
    response and early events can be recovered without relying on a TTS-specific
    socket.

Server operation map rules:

- Store `operationId -> threadId / streamId / jobId / status / createdAt /
  updatedAt` for start-style operations.
- If the same `operationId` start arrives again, return or attach to the existing
  operation instead of starting duplicate work.
- Allow `status`, `attach`, and `resume` by `operationId` while the server id is
  still unknown to the client.
- Delete completed/failed operation mappings after a TTL.
- Enforce a maximum number of operation mappings per server process and per
  `clientInstanceId` where available.

LLM JSON-RPC needs one additional rule: when multiple logical operations share
one physical socket, JSON-RPC `id` values must be unique on that socket. Existing
call sites often start ids at `1` because each owns a separate WebSocket today.
The singleton manager or the Codex client layer must allocate or rewrite wire ids
and map responses back to the logical caller.

Keep these ids separate:

- `operationId` / `requestId`: app-level logical operation, recovery, and
  idempotency.
- JSON-RPC `id`: physical WebSocket response matching only.

Existing caller JSON-RPC ids must not be forwarded unchanged onto the shared
socket. The manager or Codex client layer must map caller ids to collision-free
wire ids and map responses back to the caller's original id.

The server must treat relay/TTS completion as logical channel completion, not as
permission to close the singleton WebSocket. A failed or completed LLM relay
should emit a channel-scoped error/detach/done message. The physical WebSocket
should close only for connection-level failures or intentional app lifecycle
disconnects.

TTS liveness must be based on job state, not socket state. Replace
`streamSocketRef.current !== null` style checks with explicit
`streamId`/`jobId`/`status`/`lastSeq` state before moving stream TTS to the
singleton.

## 6. Lifecycle Rules

- App launch / active foreground:
  - create at most one socket for the normalized `/runner-ws` URL and token.
  - if one is already `CONNECTING` or `OPEN`, reuse it.
  - `onopen` moves the manager to `handshaking`, not `ready`.
  - after server `control:ready`, move to `ready`.
- No subscribers:
  - keep the socket open while the app is active.
  - do not auto-close on screen unmount.
- Socket close/error while active:
  - reconnect with bounded backoff and jitter.
  - keep one reconnect timer per manager instance.
  - ignore events from stale socket generations.
- App moves to `inactive`:
  - do not close the WebSocket just because the app is inactive.
  - pause new feature starts while inactive.
  - keep existing connection and pending requests alive unless the OS or network
    closes the socket.
- App moves to `background`:
  - close the socket intentionally.
  - clear reconnect timers.
  - do not create a second socket to keep work alive in the background.
  - long-running server work may continue, but the app side must treat the
    socket as detached while backgrounded.
- App returns to `active`:
  - reconnect once.
  - wait for `control:ready`.
  - after `control:ready`, active features may explicitly reattach through their
    existing state (`operationId`, `threadId` + last relay `seq`,
    `streamId` + last TTS `seq`, or the feature's pending request state).
  - no message is queued or sent while reconnecting.

Connection states should be explicit:

- `idle`: manager created, no active socket yet.
- `connecting`: physical socket is being opened.
- `handshaking`: `onopen` fired, waiting for `control:ready`.
- `ready`: application messages may be sent.
- `reconnecting`: active app lost the socket and has one reconnect timer/attempt.
- `background`: intentionally disconnected because AppState is background.
- `stopped`: intentionally disconnected for manual stop, logout, or config
  change.

After a reconnect reaches `ready`, the manager emits a snapshot change. Feature
owners then send current-state recovery messages such as `relay:resume`,
`tts:attach`, or `operation status` by `operationId`. These are new sends after
readiness, not queued replay.

## 7. Migration Plan

1. Make server `/runner-ws` safe for a real singleton connection:
   - route `llm` relay attachment by `sessionId` before `threadId` exists, then
     by `threadId` after the thread is established, instead of one
     connection-level `llmRelay`.
   - require `operationId` on start-style LLM/TTS operations.
   - persist `operationId -> threadId / streamId / jobId` with TTL and capacity
     limits.
   - make repeated starts with the same `operationId` idempotent.
   - route `tts` start/attachment by `operationId` before server `streamId`
     exists, then by `streamId` after job creation,
     instead of one connection-level `attachedTtsJobId`.
   - do not close the physical singleton WebSocket when one logical relay or TTS
     job finishes; emit a channel-scoped message instead.
   - extend the existing envelope with `operationId`; otherwise preserve the
     envelope shape.
2. Introduce the manager and provider without changing feature behavior.
   Keep `createWebSocketWithOptionalAuth()` as the low-level factory.
3. Move diagnostics/status ping to the manager first. This is low risk and proves
   connection snapshots, heartbeat, `control:ready`, and AppState behavior.
4. Move relay observer traffic to the singleton. The existing `relay:resume`
   envelope already has `threadId` and `seq`, so this maps cleanly to
   subscriptions.
5. Move LLM turn JSON-RPC traffic to the singleton. Use `requestId` and JSON-RPC
   wire-id mapping so concurrent operations cannot consume each other's
   responses. Generate `operationId` and `sessionId` before the first LLM RPC,
   including initial `initialize` / `thread/start`.
6. Replace one-shot `rpcSession`, `compact`, and `probe` sockets with manager
   requests where practical.
7. Move stream TTS control JSON to the singleton `channel: "tts"`.
   The audio body remains outside the singleton on HTTP `/tts-media`.
   Replace `streamSocketRef` as a TTS liveness signal with stream/job state,
   because the singleton socket stays open after a TTS stream finishes. Require
   `operationId` on `tts:start` before server `streamId` is known.

## 8. Complexity Constraints

- Do not add this logic to `AppRoot.tsx`; it is already too large.
- Do not create thin wrappers around `WebSocket`. The new manager must own real
  behavior: lifecycle, routing, explicit disconnected errors, heartbeat, and
  reconnect.
- Do not create generic transport abstractions for HTTP. TTS audio bodies,
  STT uploads, and logs already have clear HTTP clients.
- Keep business decisions out of screens. Screens should subscribe and update
  local state; routing/reconnect belongs in the manager or Codex client layer.
- Preserve existing server envelope format unless a concrete bug requires a
  server change. `operationId` is a concrete server/client contract change needed
  for idempotent start recovery.
- Do not treat a single WebSocket as a single active feature. The physical
  connection is shared; logical ownership must be keyed by `channel` plus
  `operationId`, `threadId`, `streamId`, `requestId`, or `sessionId`.
- Do not put feature progress into `RunnerWebSocketContext`. The context provides
  the manager; features own their display state.
- Do not make `onopen` trigger feature resumes. Resumes happen only after
  `control:ready`.

## 9. Defensive Limits

- Client manager checks `ws.bufferedAmount` before sending and fails fast when it
  exceeds the configured limit.
- Client and server enforce one-message maximum size. The existing client parser
  has a 32MB envelope guard; align server parsing and manager sends with an
  explicit limit.
- Subscriber handler exceptions are caught and reported without stopping delivery
  to other subscribers.
- Pending request count has a hard maximum.
- Subscription cleanup and pending request cleanup are mandatory on unsubscribe,
  timeout, abort, disconnect, logout, and config changes.
- Server operation maps have TTL cleanup and maximum size limits.
- Every socket has a generation number. Events from stale generations are ignored.

## 10. Debug UI

Display singleton diagnostics in the existing connection/status UI rather than
adding state to feature screens.

The acceptance check is not global `runnerWsConnectionCount <= 1`, because that
can include other devices or connections waiting to close. The useful acceptance
check is:

```text
runnerWsConnectionCount for this clientInstanceId <= 1
```

Show these fields where available:

- `clientInstanceId`
- `connectionId`
- `generation`
- `connectionState`
- `runnerWsConnectionCount`
- `pendingRequestCount`
- `subscriptionCount`
- `lastPongAt`

Server `control:pong` should include enough identity data to support this:
`clientInstanceId`, `connectionId`, and the count scoped to that
`clientInstanceId`.

## 11. Confirmed Decisions

- `inactive` does not close the WebSocket. It only pauses new starts.
- `background` intentionally closes the client WebSocket and clears reconnect
  timers. Active server-side work is not force-interrupted only because the app
  backgrounded.
- When the app returns to `active`, the manager reconnects once, waits for
  `control:ready`, and then feature owners reattach/resume by stable ids such as
  `operationId`, `threadId` + `seq`, or `streamId` + `seq`.
- Start-style operations must be recoverable even if the socket disconnects
  before the first server response. `operationId` plus server-side idempotency is
  required for that case.
- While reconnecting or disconnected, the manager must reject all outbound
  `send` / `request` calls with an explicit disconnected/reconnecting error. It
  must not queue any message, including `relay:resume`, `tts:attach`, ping, user
  LLM requests, TTS starts, or tool approvals.
- After the socket is ready again, each owning feature may explicitly send the
  current recovery message it needs from current state. This is a new send after
  reconnect, not a replay of a queued message.
