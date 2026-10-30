import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createVoiceConsultationService, consultationRoomSummary } from "../src/voice-consultation-service.mjs";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "consultation-transfer-"));
process.env.RUNNER_SKIP_SERVER_START = "1";
process.env.RUNNER_MOCK = "1";
process.env.RUNNER_TOKEN = "synthetic-token";
process.env.CODEX_WS_DEBUG_FILE = path.join(temp, "ws-debug.jsonl");
const { __TESTING__: runtime } = await import("../src/server-runtime.mjs");
test.after(async () => fs.rm(temp, { recursive: true, force: true }));
const fixture = (id = "room-a", revision = 1) => ({ id, revision, generation: 1, question: "Synthetic question", participants: ["main", "other"],
  profiles: { main: { orchestratorId: "main", name: "Main", introduction: "Intro" }, other: { orchestratorId: "other", name: "Other", introduction: "Intro" } },
  state: "running", reason: "", turns: 0, maxTurns: 9, template: "Synthetic", messages: [{ id: "message", source: "user", seq: 1, text: "Synthetic", speakerId: "user" }],
  steps: [], run: { id: `run-${id}`, orchestratorId: "main" } });
function socket() {
  const ws = new EventEmitter(); ws.readyState = 1; ws.sent = [];
  ws.send = (value) => { const parsed = JSON.parse(value); ws.sent.push(parsed); ws.emit("sent", parsed); };
  runtime.runnerWsServer.emit("connection", ws, { url: "/runner-ws", headers: { host: "127.0.0.1" }, socket: { remoteAddress: "test" } });
  ws.close = () => { ws.readyState = 3; ws.emit("close"); };
  return ws;
}
let requestId = 0;
async function request(ws, op, payload = {}) {
  const id = `request-${++requestId}`;
  const result = new Promise((resolve) => {
    const listener = (message) => { if (message.requestId === id) { ws.removeListener("sent", listener); resolve(message); } };
    ws.on("sent", listener);
  });
  ws.emit("message", JSON.stringify({ channel: "agent", op: `voice.consultations.${op}`, requestId: id, payload }), false);
  return result;
}

test("consultation recipients are subscribed, selected and lease-scoped; legacy list clients keep full updates", async (t) => {
  // Runtime service methods are replaced before any operation. The fixed live
  // consultations directory is never read or written by this integration test.
  t.mock.method(runtime.consultationService, "list", async ({ summaries = false } = {}) => ({ rooms: [summaries ? consultationRoomSummary(fixture()) : fixture()], defaultTemplate: "Synthetic" }));
  t.mock.method(runtime.consultationService, "get", async (id) => fixture(id));
  const inactive = socket(), list = socket(), selected = socket(), legacy = socket();
  try {
    await request(list, "list", { updates: "delta", subscriptionId: "list-lease" });
    await request(selected, "list", { updates: "delta", subscriptionId: "selected-lease" });
    await request(selected, "get", { roomId: "room-a", subscriptionId: "selected-lease" });
    await request(legacy, "list");
    for (const ws of [inactive, list, selected, legacy]) ws.sent = [];
    runtime.broadcastConsultationChanged(fixture());
    const progress = { roomId: "room-a", runId: "run-room-a", generation: 1, seq: 1, messages: [], tools: [] };
    const delta = { roomId: "room-a", runId: "run-room-a", generation: 1, baseSeq: 0, seq: 1, textInterrupted: true };
    runtime.broadcastConsultationProgress(progress, delta);
    assert.equal(inactive.sent.length, 0);
    assert.deepEqual(list.sent.map((entry) => entry.op), ["voice.consultations.summary"]);
    assert.equal(list.sent[0].payload.messages, undefined);
    assert.deepEqual(selected.sent.map((entry) => entry.op), ["voice.consultations.changed", "voice.consultations.progress.delta"]);
    assert.equal(selected.sent[1].operationId, "selected-lease");
    assert.deepEqual(legacy.sent.map((entry) => entry.op), ["voice.consultations.changed", "voice.consultations.progress"]);
    await request(selected, "list", { updates: "delta", subscriptionId: "new-lease" });
    assert.equal((await request(selected, "unsubscribe", { subscriptionId: "selected-lease" })).payload.removed, false);
    selected.sent = []; runtime.broadcastConsultationChanged(fixture());
    assert.equal(selected.sent[0].operationId, "new-lease");
    await request(selected, "unsubscribe", { subscriptionId: "new-lease" });
    selected.sent = []; runtime.broadcastConsultationChanged(fixture());
    assert.equal(selected.sent.length, 0);
  } finally { for (const ws of [inactive, list, selected, legacy]) ws.close(); }
});

test("detail initialization merges bounded snapshots and progress before starting suffix delivery", async (t) => {
  let resolveGet;
  t.mock.method(runtime.consultationService, "list", async () => ({ rooms: [], defaultTemplate: "Synthetic" }));
  t.mock.method(runtime.consultationService, "get", () => new Promise((resolve) => { resolveGet = resolve; }));
  const ws = socket();
  try {
    await request(ws, "list", { updates: "delta", subscriptionId: "race-lease" });
    const get = request(ws, "get", { roomId: "room-a", subscriptionId: "race-lease" });
    while (!resolveGet) await new Promise((resolve) => setImmediate(resolve));
    ws.sent = [];
    runtime.broadcastConsultationChanged(fixture("room-a", 2));
    const progress = { roomId: "room-a", runId: "run-room-a", generation: 1, seq: 7, messages: [{ id: "answer", text: "Buffered", phase: "final_answer" }], tools: [] };
    runtime.broadcastConsultationProgress(progress, { ...progress, baseSeq: 6 });
    assert.equal(ws.sent.length, 0, "no suffix can precede the snapshot it extends");
    resolveGet(fixture());
    const response = await get;
    assert.equal(response.payload.revision, 2);
    assert.equal(response.payload.run.progress.seq, 7);
    runtime.broadcastConsultationProgress({ ...progress, seq: 8 }, { roomId: "room-a", runId: "run-room-a", generation: 1, baseSeq: 7, seq: 8, textInterrupted: true });
    assert.equal(ws.sent.at(-1).op, "voice.consultations.progress.delta");
    assert.equal(ws.sent.at(-1).payload.baseSeq, 7);
  } finally { ws.close(); }
});

test("speech notifications reach only the connection that owns that room's speech subscription", async (t) => {
  t.mock.method(runtime.consultationService, "subscribeSpeech", async () => ({ subscribed: true }));
  t.mock.method(runtime.consultationService, "unsubscribeSpeech", async () => ({ removed: true }));
  const owner = socket(), other = socket(), subscriptionId = randomUUID();
  try {
    await request(owner, "speech.subscribe", { roomId: "room-a", subscriptionId, tts: { speedScale: 1 } });
    owner.sent = []; other.sent = [];
    runtime.broadcastConsultationSpeech({ roomId: "room-a", subscriptionId, status: "ready", jobId: "synthetic-job" });
    assert.equal(owner.sent.length, 1); assert.equal(other.sent.length, 0);
  } finally { owner.close(); other.close(); }
});

test("progress producers send actual capped suffixes, changed tools, and no notifications for no-ops", async (t) => {
  const participant = randomUUID(), deltas = [], full = [];
  let controls;
  const orchestrators = {
    list: async () => ({ orchestrators: [{ id: "main", name: "Main" }, { id: participant, name: "Other" }] }),
    open: async () => ({ logicalConversationId: "synthetic" }),
    start: async (_message, _done, _approval, options) => { controls = options; return { status: "running" }; },
    interrupt: async () => ({}),
  };
  const service = createVoiceConsultationService({ rootDir: path.join(temp, "synthetic-rooms"), orchestrators,
    onProgress: (snapshot, change) => { full.push(snapshot); deltas.push(change); } });
  t.after(() => service.close());
  const room = await service.create({ participants: ["main", participant] });
  await service.supplement(room.id, { messageId: randomUUID(), text: "Synthetic question" });
  while (!controls) await new Promise((resolve) => setImmediate(resolve));
  for (let index = 0; index < 100; index++) controls.onText("x".repeat(10), { itemId: "answer", phase: "final_answer" });
  controls.onText("y".repeat(40000), { itemId: "answer", phase: "final_answer" });
  controls.onText("ignored", { itemId: "answer", phase: "final_answer" });
  controls.onText("private", { itemId: "reasoning", phase: "analysis" });
  controls.onTextError(); controls.onTextError();
  controls.onToolEvent({ event: "started", item: { id: "tool", type: "commandExecution", command: "synthetic" }, threadId: "thread", turnId: "turn" });
  for (let i = 0; i < 10; i++) controls.onToolEvent({ event: "outputDelta", item: { id: "tool", type: "commandExecution", delta: "output" }, threadId: "thread", turnId: "turn" });
  await service.get(room.id); // Drains the existing exclusive update queue.
  assert.equal(deltas.filter((change) => change.message).length, 101);
  assert.equal(deltas.filter((change) => change.textInterrupted).length, 1);
  assert.equal(deltas[100].message.offset, 1000);
  assert.equal(deltas[100].message.append.length, 31000);
  assert.equal(full[100].messages[0].text.length, 32000);
  assert.ok(deltas.filter((change) => change.toolOutput).every((change) => !Object.hasOwn(change.tool, "output")));
  const priorBytes = full.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
  const deltaBytes = deltas.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
  assert.ok(deltaBytes < priorBytes / 5);
  console.info(`[consultation progress fixture] fullDecoded=${priorBytes} deltaDecoded=${deltaBytes}; same delivered updates, JSON payload bytes before compression`);
  const summary = consultationRoomSummary({ ...fixture(), messages: [{ ...fixture().messages[0], text: "😀".repeat(201) }] });
  assert.equal(Array.from(summary.lastMessage.text).length, 200);
  assert.equal(summary.lastMessage.text, "😀".repeat(199) + "…");
});
