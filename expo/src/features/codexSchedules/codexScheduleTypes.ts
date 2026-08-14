import { isReasoningEffort, type ReasoningEffort } from "../app/utils/settingsParsers";

export type CodexScheduleReasoningEffort = ReasoningEffort;
export type CodexScheduleRrule = null | "FREQ=DAILY" | "FREQ=WEEKLY" | "FREQ=MONTHLY" | "FREQ=YEARLY";
export type CodexScheduleRepeat = "none" | "daily" | "weekly" | "monthly" | "yearly";

export type CodexScheduleDefinition = {
  id: string;
  name: string;
  enabled: boolean;
  startLocal: string;
  timeZone: string;
  rrule: CodexScheduleRrule;
  cwd: string;
  modelRef: string;
  reasoningEffort: CodexScheduleReasoningEffort;
  prompt: string;
};

export type CodexScheduleDispatch = {
  occurrenceAt: string;
  claimedAt: string;
  definitionHash: string;
  status: "claimed" | "fired" | "failed" | "failed_uncertain_after_restart";
  threadId: string | null;
  turnId: string | null;
  errorCode: string;
  errorMessage: string;
  updatedAt: string;
};

export type CodexSchedule = CodexScheduleDefinition & {
  nextOccurrenceAt: string | null;
  lastDispatch: CodexScheduleDispatch | null;
};

export type CodexScheduleSnapshot = {
  revision: number;
  schedules: CodexSchedule[];
};

const RRULE_BY_REPEAT: Record<CodexScheduleRepeat, CodexScheduleRrule> = {
  none: null,
  daily: "FREQ=DAILY",
  weekly: "FREQ=WEEKLY",
  monthly: "FREQ=MONTHLY",
  yearly: "FREQ=YEARLY",
};

export const CODEX_SCHEDULE_REPEAT_OPTIONS: readonly { value: CodexScheduleRepeat; label: string }[] = [
  { value: "none", label: "なし" },
  { value: "daily", label: "毎日" },
  { value: "weekly", label: "毎週" },
  { value: "monthly", label: "毎月" },
  { value: "yearly", label: "毎年" },
];

export function codexScheduleRepeatToRrule(repeat: CodexScheduleRepeat): CodexScheduleRrule {
  return RRULE_BY_REPEAT[repeat];
}

export function codexScheduleRruleToRepeat(rrule: CodexScheduleRrule): CodexScheduleRepeat {
  const match = CODEX_SCHEDULE_REPEAT_OPTIONS.find((option) => RRULE_BY_REPEAT[option.value] === rrule);
  if (!match) throw new Error("Unsupported schedule recurrence");
  return match.value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} contains an unknown field`);
}

function text(value: unknown, label: string, max: number) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function iso(value: unknown, label: string) {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) throw new Error(`${label} is invalid`);
  return value;
}

function startLocal(value: unknown) {
  if (typeof value !== "string" || value !== value.trim()) throw new Error("startLocal is invalid");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00$/.exec(value);
  if (!match) throw new Error("startLocal is invalid");
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3]) || date.getHours() !== Number(match[4]) || date.getMinutes() !== Number(match[5])) {
    throw new Error("startLocal is invalid");
  }
  return value;
}

function parseDispatch(raw: unknown): CodexScheduleDispatch | null {
  if (raw === null) return null;
  const value = object(raw, "lastDispatch");
  exactKeys(value, ["occurrenceAt", "claimedAt", "definitionHash", "status", "threadId", "turnId", "errorCode", "errorMessage", "updatedAt"], "lastDispatch");
  const statuses = ["claimed", "fired", "failed", "failed_uncertain_after_restart"] as const;
  if (!statuses.includes(value.status as typeof statuses[number])) throw new Error("lastDispatch.status is invalid");
  const nullableId = (input: unknown, label: string) => input === null ? null : text(input, label, 10_000);
  const definitionHash = typeof value.definitionHash === "string" && /^[a-f0-9]{64}$/.test(value.definitionHash)
    ? value.definitionHash
    : (() => { throw new Error("lastDispatch.definitionHash is invalid"); })();
  const threadId = nullableId(value.threadId, "lastDispatch.threadId");
  const turnId = nullableId(value.turnId, "lastDispatch.turnId");
  if (value.status === "fired" && (!threadId || !turnId)) throw new Error("lastDispatch fired IDs are required");
  if (value.status === "claimed" && (threadId !== null || turnId !== null)) throw new Error("lastDispatch claimed IDs must be null");
  return {
    occurrenceAt: iso(value.occurrenceAt, "lastDispatch.occurrenceAt"),
    claimedAt: iso(value.claimedAt, "lastDispatch.claimedAt"),
    definitionHash,
    status: value.status as CodexScheduleDispatch["status"],
    threadId,
    turnId,
    errorCode: typeof value.errorCode === "string" && value.errorCode.length <= 200 ? value.errorCode : (() => { throw new Error("lastDispatch.errorCode is invalid"); })(),
    errorMessage: typeof value.errorMessage === "string" && value.errorMessage.length <= 1_000 ? value.errorMessage : (() => { throw new Error("lastDispatch.errorMessage is invalid"); })(),
    updatedAt: iso(value.updatedAt, "lastDispatch.updatedAt"),
  };
}

export function parseCodexScheduleDefinition(raw: unknown): CodexScheduleDefinition {
  const value = object(raw, "schedule");
  const keys = ["id", "name", "enabled", "startLocal", "timeZone", "rrule", "cwd", "modelRef", "reasoningEffort", "prompt"];
  exactKeys(value, keys, "schedule");
  const id = text(value.id, "id", 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error("id is invalid");
  const rrules: CodexScheduleRrule[] = [null, "FREQ=DAILY", "FREQ=WEEKLY", "FREQ=MONTHLY", "FREQ=YEARLY"];
  if (!rrules.includes(value.rrule as CodexScheduleRrule)) throw new Error("rrule is invalid");
  const reasoningEffort = value.reasoningEffort;
  if (typeof reasoningEffort !== "string" || reasoningEffort !== reasoningEffort.trim().toLowerCase() || !isReasoningEffort(reasoningEffort)) {
    throw new Error("reasoningEffort is invalid");
  }
  if (typeof value.enabled !== "boolean") throw new Error("enabled is invalid");
  const timeZone = text(value.timeZone, "timeZone", 100);
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date());
  } catch {
    throw new Error("timeZone is invalid");
  }
  return {
    id,
    name: text(value.name, "name", 100),
    enabled: value.enabled,
    startLocal: startLocal(value.startLocal),
    timeZone,
    rrule: value.rrule as CodexScheduleRrule,
    cwd: text(value.cwd, "cwd", 2_048),
    modelRef: text(value.modelRef, "modelRef", 1_000),
    reasoningEffort,
    prompt: text(value.prompt, "prompt", 24_000),
  };
}

export function parseCodexScheduleSnapshot(raw: unknown): CodexScheduleSnapshot {
  const root = object(raw, "response");
  exactKeys(root, ["ok", "revision", "schedules"], "response");
  if (root.ok !== true || !Number.isInteger(root.revision) || Number(root.revision) < 0 || !Array.isArray(root.schedules)) {
    throw new Error("schedule response is invalid");
  }
  if (root.schedules.length > 100) throw new Error("too many schedules");
  const ids = new Set<string>();
  const schedules = root.schedules.map((rawSchedule) => {
    const value = object(rawSchedule, "schedule");
    const definition = parseCodexScheduleDefinition(Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "nextOccurrenceAt" && key !== "lastDispatch"),
    ));
    exactKeys(value, [...Object.keys(definition), "nextOccurrenceAt", "lastDispatch"], "schedule");
    if (ids.has(definition.id)) throw new Error("duplicate schedule id");
    ids.add(definition.id);
    return {
      ...definition,
      nextOccurrenceAt: value.nextOccurrenceAt === null ? null : iso(value.nextOccurrenceAt, "nextOccurrenceAt"),
      lastDispatch: parseDispatch(value.lastDispatch),
    };
  });
  return { revision: Number(root.revision), schedules };
}

export function codexScheduleDefinitionOnly(schedule: CodexSchedule): CodexScheduleDefinition {
  const { nextOccurrenceAt: _next, lastDispatch: _last, ...definition } = schedule;
  return definition;
}

export function dateFromCodexScheduleStartLocal(value: string): Date {
  const parsed = startLocal(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00$/.exec(parsed)!;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
}

export function codexScheduleStartLocalFromDate(value: Date): string {
  const two = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${two(value.getMonth() + 1)}-${two(value.getDate())}T${two(value.getHours())}:${two(value.getMinutes())}:00`;
}
