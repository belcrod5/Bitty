import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
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
  calendar_read_only: "指定したカレンダーは書き込みできません。",
  event_changed: "予定が確認時から変更されています。再取得して確認してください。",
  event_version_unavailable: "予定の更新日時を確認できないため操作できません。",
  recurring_event_write_unsupported: "繰り返し予定は変更・削除できません。カレンダーアプリで編集してください。",
  request_conflict: "同じ要求に異なる内容が届いたため実行しませんでした。",
  result_unknown: "予定の変更結果を確認できません。自動再試行は行いません。",
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
    async execute(tool, input, signal, requestId) {
      const method = {
        calendar_list_calendars: "listCalendars", calendar_search_events: "searchEvents", calendar_get_event: "getEvent",
        calendar_create_event: "createEvent", calendar_update_event: "updateEvent", calendar_delete_event: "deleteEvent",
      }[tool];
      if (!method) throw iCloudError("invalid_arguments");
      const isWrite = /_(create|update|delete)_event$/.test(tool);
      const run = async () => {
        checkOwner();
        if (!state?.enabled) throw iCloudError("icloud_not_connected");
        if (signal?.aborted) throw iCloudError("request_cancelled", 408);
        const snapshot = state, client = clientFactory({ account: snapshot.account, password: snapshot.password });
        if (isWrite) {
          if (typeof requestId !== "string" || !/^[a-f0-9]{64}$/.test(requestId)) throw iCloudError("invalid_arguments");
          await validate(directory, "directory", 0o700);
          const hash = (value) => createHash("sha256").update(value).digest("hex");
          const identity = hash(JSON.stringify([owner(), snapshot.account, requestId]));
          const argumentsHash = hash(JSON.stringify([tool, input], (_key, value) => value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value));
          const receipt = path.join(root, `write-${identity}.json`);
          let handle;
          try { handle = await fs.open(receipt, "wx", 0o600); }
          catch (error) {
            if (error.code !== "EEXIST") throw iCloudError("icloud_storage_unavailable", 503);
            let saved;
            try {
              if ((await validate(receipt, "file", 0o600)).size > 65536) throw new Error();
              const previous = await fs.open(receipt, constants.O_RDONLY | constants.O_NOFOLLOW);
              try { saved = JSON.parse(await previous.readFile("utf8")); } finally { await previous.close(); }
            } catch { throw iCloudError("result_unknown"); }
            if (saved.argumentsHash !== argumentsHash) throw iCloudError("request_conflict");
            if (!saved.result) throw iCloudError("result_unknown");
            checkOwner();
            if (saved.result.error) throw iCloudError(saved.result.error);
            return saved.result.data;
          }
          try { await handle.writeFile(JSON.stringify({ argumentsHash })); await handle.sync(); }
          catch { throw iCloudError("icloud_storage_unavailable", 503); }
          finally { await handle.close(); }
          const parent = await fs.open(root, "r");
          try { await parent.sync(); } finally { await parent.close(); }
          let result;
          try { checkOwner(); result = { data: await client[method](input, signal, requestId) }; }
          catch (error) { result = { error: Object.hasOwn(ICLOUD_MESSAGES, error?.code) ? error.code : "result_unknown" }; }
          const temporary = path.join(root, `${randomUUID()}.tmp`);
          try {
            const output = await fs.open(temporary, "wx", 0o600);
            try { await output.writeFile(JSON.stringify({ argumentsHash, result })); await output.sync(); }
            finally { await output.close(); }
            await fs.rename(temporary, receipt);
            const parent = await fs.open(root, "r");
            try { await parent.sync(); } finally { await parent.close(); }
          } catch { throw iCloudError("result_unknown", 503); }
          finally { await fs.unlink(temporary).catch(() => {}); }
          checkOwner();
          if (result.error) throw iCloudError(result.error);
          return result.data;
        }
        const result = method === "listCalendars" ? await client[method](signal) : await client[method](input, signal);
        await queue; checkOwner();
        if (signal?.aborted) throw iCloudError("request_cancelled", 408);
        if (state !== snapshot || !state?.enabled) throw iCloudError("icloud_not_connected");
        return result;
      };
      if (isWrite) return change(run);
      await initialize(); await queue;
      return run();
    },
  };
}
