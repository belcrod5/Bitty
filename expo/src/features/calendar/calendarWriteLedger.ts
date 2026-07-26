import * as FileSystem from "expo-file-system/legacy";
import type {
  CalendarCreateResult,
  CalendarDeleteResult,
  CalendarErrorCode,
  CalendarToolResult,
  CalendarUpdateResult,
} from "./calendarToolSpecs";
import { calendarError } from "./calendarToolSpecs";

type WriteResult = CalendarToolResult<CalendarCreateResult | CalendarUpdateResult | CalendarDeleteResult>;
export type CalendarWriteLedgerEntry = {
  requestId: string;
  requestHash: string;
  state: "received" | "executing" | "succeeded" | "failed" | "result_unknown";
  result?: WriteResult;
  updatedAt: string;
};

const MAX_ENTRIES = 100;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
let queue: Promise<unknown> = Promise.resolve();

function paths() {
  const directory = FileSystem.documentDirectory;
  if (!directory) return null;
  const path = `${directory}calendar-write-ledger.json`;
  return { path, temporaryPath: `${path}.pending` };
}

function terminal(state: CalendarWriteLedgerEntry["state"]) {
  return state === "succeeded" || state === "failed" || state === "result_unknown";
}

function compact(entries: CalendarWriteLedgerEntry[]) {
  const cutoff = Date.now() - RETENTION_MS;
  return entries
    .filter((entry) => !terminal(entry.state) || Date.parse(entry.updatedAt) >= cutoff)
    .slice(-MAX_ENTRIES);
}

async function read(): Promise<CalendarWriteLedgerEntry[]> {
  const target = paths();
  if (!target) return [];
  const info = await FileSystem.getInfoAsync(target.path);
  if (!info.exists) return [];
  const parsed = JSON.parse(await FileSystem.readAsStringAsync(target.path));
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is CalendarWriteLedgerEntry => (
    entry && typeof entry === "object" && typeof entry.requestId === "string"
      && typeof entry.requestHash === "string" && typeof entry.state === "string"
  ));
}

async function write(entries: CalendarWriteLedgerEntry[]) {
  const target = paths();
  if (!target) return;
  await FileSystem.writeAsStringAsync(target.temporaryPath, JSON.stringify(compact(entries)));
  await FileSystem.moveAsync({ from: target.temporaryPath, to: target.path });
}

function mutate<T>(fn: (entries: CalendarWriteLedgerEntry[]) => Promise<T> | T) {
  const operation = queue.then(async () => {
    const entries = await read();
    const result = await fn(entries);
    await write(entries);
    return result;
  });
  queue = operation.catch(() => {});
  return operation;
}

function safeResult(code: CalendarErrorCode): WriteResult {
  return calendarError(code);
}

export async function recoverCalendarWriteLedger() {
  await mutate((entries) => {
    for (const entry of entries) {
      if (entry.state === "received") {
        entry.state = "failed";
        entry.result = safeResult("request_cancelled");
      } else if (entry.state === "executing") {
        entry.state = "result_unknown";
        entry.result = safeResult("result_unknown");
      } else {
        continue;
      }
      entry.updatedAt = new Date().toISOString();
    }
  });
}

export async function receiveCalendarWrite(requestId: string, requestHash: string) {
  return mutate((entries) => {
    const current = entries.find((entry) => entry.requestId === requestId);
    if (current && current.requestHash !== requestHash) return { kind: "conflict" as const };
    if (current && terminal(current.state)) return { kind: "terminal" as const, result: current.result! };
    if (current) return { kind: "pending" as const };
    entries.push({ requestId, requestHash, state: "received", updatedAt: new Date().toISOString() });
    return { kind: "received" as const };
  });
}

export async function updateCalendarWrite(
  requestId: string,
  state: CalendarWriteLedgerEntry["state"],
  result?: WriteResult
) {
  await mutate((entries) => {
    const entry = entries.find((candidate) => candidate.requestId === requestId);
    if (!entry || terminal(entry.state)) return;
    entry.state = state;
    entry.result = result;
    entry.updatedAt = new Date().toISOString();
  });
}
