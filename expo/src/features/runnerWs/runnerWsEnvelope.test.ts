import { encodeRunnerWsLlmRpc, parseRunnerWsEnvelope } from "./llmAdapter";
import { encodeRunnerWsTtsStart } from "./ttsAdapter";
import { isRunnerWsMessage } from "./types";

test("encodes operationId on LLM RPC envelopes when provided", () => {
  const message = JSON.parse(encodeRunnerWsLlmRpc(
    { jsonrpc: "2.0", id: 1, method: "turn/start" },
    "thread-1",
    { requestId: "req-1", operationId: "op-1", sessionId: "session-1" }
  ));

  expect(message).toMatchObject({
    channel: "llm",
    op: "rpc",
    requestId: "req-1",
    operationId: "op-1",
    sessionId: "session-1",
    threadId: "thread-1",
  });
});

test("keeps existing LLM RPC envelope shape when operationId is omitted", () => {
  const message = JSON.parse(encodeRunnerWsLlmRpc(
    { jsonrpc: "2.0", id: 1, method: "turn/start" },
    "thread-1",
    { requestId: "req-1" }
  ));

  expect(message.operationId).toBeUndefined();
});

test("encodes operationId on TTS start envelopes when provided", () => {
  const message = JSON.parse(encodeRunnerWsTtsStart(
    { text: "hello" },
    { requestId: "req-1", operationId: "op-1", sessionId: "session-1", streamId: "stream-1" }
  ));

  expect(message).toMatchObject({
    channel: "tts",
    op: "start",
    requestId: "req-1",
    operationId: "op-1",
    sessionId: "session-1",
    streamId: "stream-1",
  });
});

test("rejects non-string operationId on client envelopes", () => {
  const invalid = {
    channel: "llm",
    op: "rpc",
    operationId: 123,
    payload: {},
  };

  expect(isRunnerWsMessage(invalid)).toBe(false);
  expect(parseRunnerWsEnvelope(JSON.stringify(invalid))).toBeNull();
});
