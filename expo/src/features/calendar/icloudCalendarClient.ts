import { runnerSettingsRequest } from "../app/utils/runnerSettingsRequest";

export type ICloudCalendarStatus = { configured: boolean; enabled: boolean; account: string; testedAt: string | null };
export type ICloudConnectionTest = { verificationToken: string; expiresAt: string; calendarCount: number; eventCount: number; truncated: boolean };

export async function requestICloudCalendar<T>(runnerUrl: string, runnerToken: string, path: string, init: RequestInit = {}): Promise<T> {
  let url: URL;
  try { url = new URL(runnerUrl); }
  catch { throw new Error("設定でRunnerの接続先を確認してください。"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("iCloudの認証情報を送るにはHTTPSのRunner接続を使ってください。");
  }
  const value = await runnerSettingsRequest(runnerUrl, runnerToken, `/calendar/icloud/${path}`, { ...init, redirect: "error" });
  const valid = path === "test"
    ? typeof value.verificationToken === "string" && /^[a-f0-9]{64}$/.test(value.verificationToken)
      && typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt))
      && Number.isSafeInteger(value.calendarCount) && Number(value.calendarCount) >= 0
      && Number.isSafeInteger(value.eventCount) && Number(value.eventCount) >= 0 && typeof value.truncated === "boolean"
    : typeof value.configured === "boolean" && typeof value.enabled === "boolean" && typeof value.account === "string"
      && (value.testedAt === null || (typeof value.testedAt === "string" && Number.isFinite(Date.parse(value.testedAt))))
      && (!value.enabled || value.configured);
  if (!valid) throw new Error("iCloud接続設定の応答を確認できませんでした。");
  return value as T;
}
