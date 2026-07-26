const files = new Map<string, string>();
const mockGetInfoAsync = jest.fn(async (path: string) => ({ exists: files.has(path) }));
const mockReadAsStringAsync = jest.fn(async (path: string) => files.get(path) || "");
const mockWriteAsStringAsync = jest.fn(async (path: string, value: string) => { files.set(path, value); });
const mockMoveAsync = jest.fn(async ({ from, to }: { from: string; to: string }) => {
  const value = files.get(from);
  if (value === undefined) throw new Error("missing pending ledger");
  files.set(to, value);
  files.delete(from);
});

jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///documents/",
  getInfoAsync: (...args: [string]) => mockGetInfoAsync(...args),
  readAsStringAsync: (...args: [string]) => mockReadAsStringAsync(...args),
  writeAsStringAsync: (...args: [string, string]) => mockWriteAsStringAsync(...args),
  moveAsync: (args: { from: string; to: string }) => mockMoveAsync(args),
}));

import {
  receiveCalendarWrite,
  recoverCalendarWriteLedger,
  updateCalendarWrite,
} from "./calendarWriteLedger";

const ledgerPath = "file:///documents/calendar-write-ledger.json";

beforeEach(() => {
  files.clear();
  jest.clearAllMocks();
});

test("recovers received and executing writes safely after a crash", async () => {
  files.set(ledgerPath, JSON.stringify([
    { requestId: "received", requestHash: "a", state: "received", updatedAt: new Date().toISOString() },
    { requestId: "executing", requestHash: "b", state: "executing", updatedAt: new Date().toISOString() },
  ]));

  await recoverCalendarWriteLedger();

  const entries = JSON.parse(files.get(ledgerPath)!);
  expect(entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ requestId: "received", state: "failed", result: expect.objectContaining({ error: expect.objectContaining({ code: "request_cancelled" }) }) }),
    expect.objectContaining({ requestId: "executing", state: "result_unknown", result: expect.objectContaining({ error: expect.objectContaining({ code: "result_unknown" }) }) }),
  ]));
});

test("serializes duplicate/hash-conflicting writes and replays a terminal result", async () => {
  await expect(receiveCalendarWrite("same", "hash-a")).resolves.toEqual({ kind: "received" });
  await expect(receiveCalendarWrite("same", "hash-b")).resolves.toEqual({ kind: "conflict" });
  const result = { ok: false as const, error: { code: "request_cancelled" as const, message: "cancelled", retryable: false } };
  await updateCalendarWrite("same", "failed", result);
  await expect(receiveCalendarWrite("same", "hash-a")).resolves.toEqual({ kind: "terminal", result });
  expect(mockMoveAsync).toHaveBeenCalledWith({ from: `${ledgerPath}.pending`, to: ledgerPath });
});
