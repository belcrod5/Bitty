import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { runnerLoginKey } from "./runner-login-store.mjs";

export const ICLOUD_MESSAGES = {
  icloud_credentials_invalid: "Apple Accountのメールアドレスと、発行したアプリ用パスワード（英字16文字）を入力してください。通常のパスワードは使えません。",
  icloud_authentication_failed: "iCloudの認証に失敗しました（HTTP 401）。Apple Accountとアプリ用パスワードを確認してください。",
  icloud_access_denied: "iCloudがアクセスを拒否しました（HTTP 403）。アカウントのアクセス権限を確認してください。",
  icloud_connection_failed: "iCloudに接続できません。ネットワークを確認して接続テストをやり直してください。",
  icloud_response_invalid: "iCloudの応答を読み取れませんでした。",
  icloud_response_too_large: "iCloudの応答が上限を超えました。検索期間を短くしてください。",
  icloud_storage_unavailable: "iCloudの認証情報を安全に保存・読み取りできません。RunnerのKeychainと保存先の権限を確認してください。",
  icloud_test_required: "入力した情報で接続テストをやり直してください。",
  icloud_not_connected: "iCloudカレンダーが有効になっていません。設定で接続してください。",
  icloud_read_only: "iCloudカレンダーは読み取り専用です。予定の変更はカレンダーアプリで行ってください。",
  invalid_date_range: "日時の範囲が正しくありません。最大31日間を指定してください。",
  request_cancelled: "カレンダーの要求を中止しました。",
  invalid_arguments: "入力内容が正しくありません。",
  calendar_not_found: "指定したカレンダーが見つかりません。",
  event_not_found: "指定した予定が見つかりません。",
};
export function iCloudError(code, status = 400) {
  return Object.assign(new Error(ICLOUD_MESSAGES[code] || ICLOUD_MESSAGES.icloud_connection_failed), { code, status });
}

export function createICloudCalendarService({ directory, clientFactory, ownerSubjectId, keyProvider = runnerLoginKey, now = Date.now }) {
  const file = path.join(directory, "credentials.json");
  const drafts = new Map();
  let state = null, root, initialized = false, initializing, queue = Promise.resolve();
  const owner = () => typeof ownerSubjectId === "function" ? ownerSubjectId() : ownerSubjectId;
  const validate = async (target, kind, mode) => {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || (kind === "directory" ? !stat.isDirectory() : !stat.isFile())
      || (stat.mode & 0o777) !== mode || (process.getuid && stat.uid !== process.getuid())) throw iCloudError("icloud_storage_unavailable", 503);
    return stat;
  };
  const credentials = (input) => {
    const account = typeof input?.account === "string" ? input.account.trim() : "";
    const password = typeof input?.password === "string" ? input.password.replace(/[\s\p{White_Space}]/gu, "") : "";
    if (account.length > 254 || !/^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/.test(account)
      || !/^(?:[a-z]{16}|[a-z]{4}(?:-[a-z]{4}){3})$/.test(password)) throw iCloudError("icloud_credentials_invalid");
    return { account, password };
  };
  const key = async (create) => {
    const value = await keyProvider(root, { create });
    if (!Buffer.isBuffer(value) || value.length !== 32) throw iCloudError("icloud_storage_unavailable", 503);
    return value;
  };
  const checkOwner = () => {
    if (!owner() || (state && state.ownerSubjectId !== owner())) throw iCloudError("icloud_storage_unavailable", 503);
  };
  const status = () => {
    checkOwner();
    return { configured: Boolean(state), enabled: state?.enabled === true, account: state?.account || "", testedAt: state?.testedAt || null };
  };
  const initialize = () => {
    if (initialized) return Promise.resolve();
    if (initializing) return initializing;
    initializing = (async () => {
      try {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await validate(directory, "directory", 0o700);
        root = await fs.realpath(directory);
        try {
          const stat = await validate(file, "file", 0o600);
          if (stat.size > 16384) throw new Error();
          const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
          let encrypted;
          try { encrypted = JSON.parse(await handle.readFile("utf8")); } finally { await handle.close(); }
          if (encrypted.version !== 1) throw new Error();
          const decipher = createDecipheriv("aes-256-gcm", await key(false), Buffer.from(encrypted.iv, "base64"));
          decipher.setAAD(Buffer.from("bitty-icloud-calendar-v1"));
          decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
          state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.data, "base64")), decipher.final()]).toString("utf8"));
          credentials(state);
          if (typeof state.enabled !== "boolean" || !Number.isFinite(Date.parse(state.testedAt))) throw new Error();
          checkOwner();
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        initialized = true;
      } catch { initializing = null; throw iCloudError("icloud_storage_unavailable", 503); }
    })();
    return initializing;
  };
  const write = async (next) => {
    const temporary = path.join(root, `${randomUUID()}.tmp`);
    let handle;
    try {
      await validate(directory, "directory", 0o700);
      try { await validate(file, "file", 0o600); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (next) {
        const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", await key(true), iv);
        cipher.setAAD(Buffer.from("bitty-icloud-calendar-v1"));
        const data = Buffer.concat([cipher.update(JSON.stringify(next), "utf8"), cipher.final()]);
        handle = await fs.open(temporary, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }));
        await handle.sync(); await handle.close(); handle = null;
        await fs.rename(temporary, file);
      } else await fs.unlink(file).catch((error) => { if (error.code !== "ENOENT") throw error; });
      const parent = await fs.open(root, "r");
      try { await parent.sync(); } finally { await parent.close(); }
      state = next;
    } catch { throw iCloudError("icloud_storage_unavailable", 503); }
    finally { await handle?.close(); await fs.unlink(temporary).catch(() => {}); }
  };
  const change = (operation) => {
    const result = queue.then(async () => { await initialize(); checkOwner(); return operation(); });
    queue = result.catch(() => {});
    return result;
  };
  const checkConnection = async (value) => {
    const client = clientFactory(value);
    const signal = AbortSignal.timeout(30000);
    const calendars = await client.listCalendars(signal);
    const start = new Date(now()).toISOString(), end = new Date(now() + 7 * 86400000).toISOString();
    const sample = await client.searchEvents({ start, end }, signal);
    return { calendarCount: calendars.calendars.length, eventCount: sample.events.length, truncated: sample.truncated === true };
  };
  const binding = (context) => `${context?.ownerSubjectId || ""}:${context?.sessionId || (context?.local ? "local" : "")}`;
  return {
    initialize,
    async status() { await initialize(); await queue; return status(); },
    async test(input, context) {
      if (context?.ownerSubjectId !== owner()) throw iCloudError("icloud_test_required", 403);
      const value = credentials(input);
      const summary = await checkConnection(value);
      for (const [id, draft] of drafts) if (draft.expiresAt <= now() || draft.binding === binding(context)) drafts.delete(id);
      if (drafts.size >= 8) drafts.delete(drafts.keys().next().value);
      const verificationToken = randomBytes(32).toString("hex");
      drafts.set(verificationToken, { ...value, binding: binding(context), expiresAt: now() + 5 * 60000, testedAt: new Date(now()).toISOString() });
      setTimeout(() => drafts.delete(verificationToken), 5 * 60000).unref();
      return { verificationToken, expiresAt: new Date(now() + 5 * 60000).toISOString(), ...summary };
    },
    save(input, context) {
      return change(async () => {
        const draft = drafts.get(input?.verificationToken);
        if (!draft || draft.expiresAt <= now() || draft.binding !== binding(context) || context?.ownerSubjectId !== owner()) throw iCloudError("icloud_test_required");
        await write({ account: draft.account, password: draft.password, testedAt: draft.testedAt, enabled: true, ownerSubjectId: owner() });
        drafts.clear(); return status();
      });
    },
    setEnabled(enabled) {
      return change(async () => {
        if (typeof enabled !== "boolean" || !state) throw iCloudError("icloud_not_connected");
        if (enabled) await checkConnection(state);
        await write({ ...state, enabled }); return status();
      });
    },
    disconnect() { return change(async () => { await write(null); drafts.clear(); return status(); }); },
    async execute(tool, input, signal) {
      await initialize(); await queue; checkOwner();
      if (!state?.enabled) throw iCloudError("icloud_not_connected");
      const snapshot = state;
      const client = clientFactory({ account: snapshot.account, password: snapshot.password });
      let result;
      if (tool === "calendar_list_calendars") result = await client.listCalendars(signal);
      else if (tool === "calendar_search_events") result = await client.searchEvents(input, signal);
      else if (tool === "calendar_get_event") result = await client.getEvent(input, signal);
      else throw iCloudError("icloud_read_only");
      await queue; checkOwner();
      if (signal?.aborted) throw iCloudError("request_cancelled", 408);
      if (state !== snapshot || !state?.enabled) throw iCloudError("icloud_not_connected");
      return result;
    },
  };
}
