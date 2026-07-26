const mockDigest = jest.fn(async (_algorithm: string, value: string) => `hash:${value}`);
const mockPermission = jest.fn();
const mockRequestPermission = jest.fn();
const mockPrepare = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockList = jest.fn();
const mockSearch = jest.fn();
const mockGet = jest.fn();
const mockReceive = jest.fn();
const mockUpdateLedger = jest.fn();
const mockAppState = { currentState: "active", addEventListener: jest.fn(() => ({ remove: jest.fn() })) };

jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "sha256" }, CryptoEncoding: { HEX: "hex" },
  digestStringAsync: (algorithm: string, value: string) => mockDigest(algorithm, value),
}));
jest.mock("react-native", () => ({ AppState: mockAppState }));
jest.mock("./calendarService", () => ({
  getCalendarPermission: () => mockPermission(), requestCalendarPermission: () => mockRequestPermission(),
  prepareCalendarWrite: (...args: unknown[]) => mockPrepare(...args),
  createEvent: (...args: unknown[]) => mockCreate(...args), updateEvent: (...args: unknown[]) => mockUpdate(...args), deleteEvent: (...args: unknown[]) => mockDelete(...args),
  listCalendars: () => mockList(), searchEvents: (...args: unknown[]) => mockSearch(...args), getEvent: (...args: unknown[]) => mockGet(...args),
}));
jest.mock("./calendarWriteLedger", () => ({
  receiveCalendarWrite: (...args: unknown[]) => mockReceive(...args), updateCalendarWrite: (...args: unknown[]) => mockUpdateLedger(...args),
}));

import { createCalendarToolHandler, parseCalendarToolCall } from "./calendarToolHandler";

const ok = { ok: true as const, data: null };
const view = { title: "actual", start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T01:00:00.000Z", allDay: false, timeZone: "UTC", location: null, notes: null, calendarId: "cal", lastModifiedAt: "v1", recurring: false, allowsModifications: true };
const call = { appServerRequestId: 42, callId: "call", threadId: "thread", turnId: "turn", namespace: null, tool: "calendar_create_event" as const, arguments: { title: "model text" } };

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  mockAppState.currentState = "active";
  mockPermission.mockResolvedValue(ok);
  mockRequestPermission.mockResolvedValue(ok);
  mockPrepare.mockResolvedValue({ ok: true, data: view });
  mockCreate.mockResolvedValue({ ok: true, data: { eventId: "event", lastModifiedAt: "v2" } });
  mockReceive.mockResolvedValue({ kind: "received" });
  mockUpdateLedger.mockResolvedValue(undefined);
});

test("strict parser keeps typed ids and rejects malformed calls", async () => {
  await expect(parseCalendarToolCall({ id: "42", method: "item/tool/call", params: { callId: "c", threadId: "t", turnId: "u", namespace: null, tool: "calendar_list_calendars", arguments: {} } })).resolves.toMatchObject({ appServerRequestId: "42" });
  await expect(parseCalendarToolCall({ id: 42, method: "item/tool/call", params: { callId: "c", threadId: "t", turnId: "u", namespace: null, tool: "unknown", arguments: {} } })).resolves.toBeNull();
});

test("rejects namespace and preparation failures before confirmation", async () => {
  const confirmWrite = jest.fn();
  const handler = createCalendarToolHandler({ isForeground: () => true, confirmWrite });
  await expect(handler.handle({ ...call, namespace: "not-top-level" })).resolves.toMatchObject({ error: { code: "invalid_arguments" } });
  mockPrepare.mockResolvedValueOnce({ ok: false, error: { code: "event_changed", message: "changed", retryable: false } });
  await expect(handler.handle(call)).resolves.toMatchObject({ error: { code: "event_changed" } });
  expect(confirmWrite).not.toHaveBeenCalled();
});

test("requests permission on first foreground use but never prompts from background", async () => {
  mockPermission.mockResolvedValueOnce({ ok: false, error: { code: "calendar_permission_undetermined" } });
  mockList.mockResolvedValueOnce({ ok: true, data: { calendars: [] } });
  const readCall = { ...call, tool: "calendar_list_calendars" as const, arguments: {} };
  await expect(createCalendarToolHandler({
    isForeground: () => true,
    confirmWrite: async () => true,
  }).handle(readCall)).resolves.toMatchObject({ ok: true });
  expect(mockRequestPermission).toHaveBeenCalledTimes(1);

  mockPermission.mockResolvedValueOnce({ ok: false, error: { code: "calendar_permission_undetermined" } });
  await expect(createCalendarToolHandler({
    isForeground: () => false,
    confirmWrite: async () => true,
  }).handle(readCall)).resolves.toMatchObject({ error: { code: "foreground_required" } });
  expect(mockRequestPermission).toHaveBeenCalledTimes(1);
});

test("rechecks foreground state after approval before executing", async () => {
  let foreground = true;
  const handler = createCalendarToolHandler({
    isForeground: () => foreground,
    confirmWrite: async () => { foreground = false; return true; },
  });
  await expect(handler.handle(call)).resolves.toMatchObject({ error: { code: "foreground_required" } });
  expect(mockCreate).not.toHaveBeenCalled();
});

test("uses deterministic canonical hashes and ignores a late EventKit result after execution timeout", async () => {
  jest.useFakeTimers();
  let finishEventKit!: (value: unknown) => void;
  mockCreate.mockReturnValue(new Promise((resolve) => { finishEventKit = resolve; }));
  const handler = createCalendarToolHandler({ isForeground: () => true, confirmWrite: async () => true });
  const pending = handler.handle({ ...call, arguments: { b: 2, a: ["e\u0301", 1] } });
  await Promise.resolve();
  await jest.advanceTimersByTimeAsync(120_000);
  finishEventKit({ ok: true, data: { eventId: "late", lastModifiedAt: null } });
  await expect(pending).resolves.toMatchObject({ error: { code: "result_unknown" } });
  expect(mockReceive.mock.calls[0][1]).toContain('{"a":["é",1],"b":2}');
  expect(mockUpdateLedger).toHaveBeenLastCalledWith(expect.any(String), "result_unknown", expect.objectContaining({ error: expect.objectContaining({ code: "result_unknown" }) }));
});

test("pre-executing timeout cancels confirmation and never calls EventKit", async () => {
  jest.useFakeTimers();
  const handler = createCalendarToolHandler({
    isForeground: () => true,
    confirmWrite: ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(false), { once: true })),
  });
  const pending = handler.handle(call);
  await Promise.resolve();
  await jest.advanceTimersByTimeAsync(120_000);
  await expect(pending).resolves.toMatchObject({ error: { code: "request_cancelled" } });
  expect(mockCreate).not.toHaveBeenCalled();
});
