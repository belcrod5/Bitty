#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const DEFAULT_MAX_RESULTS = 3;
const MAX_RESULTS = 10;
const YOUTUBE_API_KEY = String(process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_DATA_API_KEY || "").trim();
const BUILTIN_CHANNEL_ALIASES = [
  {
    channelId: "UCXjTiSGclQLVVU83GVrRM4w",
    aliases: [
      "ホリエモン",
      "堀江貴文 ホリエモン",
      "堀江貴文ホリエモン",
    ],
  },
  {
    channelId: "UCfTnJmRQP79C4y_BMF_XrlA",
    aliases: [
      "NewsPicks",
      "News Picks",
      "NewsPicks /ニューズピックス",
      "ニューズピックス",
      "ニュースピックス",
    ],
  },
  {
    channelId: "UCdhJxokoEAfVaXK3xRZ9aHQ",
    aliases: [
      "ケンスウスピーク",
      "けんすう",
      "けんすうスピーク",
      "けんすう@AI時代の生き方",
    ],
  },
  {
    channelId: "UCDYj0iXVuKwd4bf9GSKgrfw",
    aliases: [
      "箕輪厚介",
      "箕輪世界観チャンネル",
      "箕輪世界観チャンネル。",
    ],
  },
  {
    channelId: "UCmr-3xtixLI8NcBfv33yZoQ",
    aliases: [
      "@kigyo-no-rirekisho",
      "kigyo-no-rirekisho",
      "起業の履歴書",
      "起業の履歴書【AI解説】",
    ],
  },
  {
    channelId: "UCvHpETRVi1tXeRJoYiXHJqw",
    aliases: [
      "@ai_masaou",
      "ai_masaou",
      "まさおAIじっくり解説ch",
      "まさおAI",
    ],
  },
  {
    channelId: "UCiMwbmcCSMORJ-85XWhStBw",
    aliases: [
      "@安野貴博",
      "安野貴博",
      "安野貴博の自由研究",
    ],
  },
  {
    channelId: "UCVAkt5l6kD4igMdVoEGTGIg",
    aliases: [
      "@ai.seitai",
      "ai.seitai",
      "AI整体師",
    ],
  },
];

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function normalizeText(raw) {
  return String(raw || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min || i > max) return fallback;
  return i;
}

function makeError(code, message, extra = {}) {
  return {
    ok: false,
    error: {
      code: String(code || "unknown_error"),
      message: String(message || "unknown error"),
      ...extra,
    },
    channels: [],
    results: [],
  };
}

function isChannelId(value) {
  return /^UC[A-Za-z0-9_-]{22}$/.test(String(value || "").trim());
}

function parseAliasEntries(raw) {
  if (!raw || typeof raw !== "object") return [];
  const out = [];
  for (const [aliasRaw, channelIdRaw] of Object.entries(raw)) {
    const alias = String(aliasRaw || "").trim();
    const channelId = String(channelIdRaw || "").trim();
    if (!alias || !isChannelId(channelId)) continue;
    out.push({ alias, channelId });
  }
  return out;
}

function buildAliasMap() {
  const map = new Map();
  for (const item of BUILTIN_CHANNEL_ALIASES) {
    const channelId = String(item?.channelId || "").trim();
    if (!isChannelId(channelId)) continue;
    for (const aliasRaw of Array.isArray(item?.aliases) ? item.aliases : []) {
      const alias = String(aliasRaw || "").trim();
      if (!alias) continue;
      map.set(normalizeText(alias), channelId);
    }
  }

  const envRaw = String(process.env.YOUTUBE_CHANNEL_ALIASES_JSON || "").trim();
  if (!envRaw) return map;
  try {
    const parsed = JSON.parse(envRaw);
    for (const entry of parseAliasEntries(parsed)) {
      map.set(normalizeText(entry.alias), entry.channelId);
    }
  } catch {
    // Ignore invalid JSON to keep tool behavior stable.
  }
  return map;
}

function parseChannelRefFromUrl(raw) {
  const input = String(raw || "").trim();
  if (!/^https?:\/\//i.test(input)) return null;
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = String(url.hostname || "").toLowerCase();
  if (!(host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com")) {
    return null;
  }

  const segments = String(url.pathname || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (segments.length <= 0) return null;

  const first = String(segments[0] || "");
  const second = String(segments[1] || "");
  if (first === "channel" && isChannelId(second)) {
    return { kind: "id", value: second, matchedBy: "url_channel_id" };
  }
  if (first.startsWith("@") && first.length > 1) {
    return { kind: "handle", value: first.slice(1), matchedBy: "url_handle" };
  }
  if (first === "user" && second) {
    return { kind: "username", value: second, matchedBy: "url_username" };
  }
  return null;
}

function parseChannelRef(channelRef, aliasMap) {
  const ref = String(channelRef || "").trim();
  if (!ref) return null;
  if (isChannelId(ref)) {
    return { kind: "id", value: ref, matchedBy: "id" };
  }
  if (ref.startsWith("@") && ref.length > 1) {
    return { kind: "handle", value: ref.slice(1), matchedBy: "handle" };
  }
  const fromUrl = parseChannelRefFromUrl(ref);
  if (fromUrl) return fromUrl;
  const byAlias = aliasMap.get(normalizeText(ref));
  if (byAlias) {
    return { kind: "id", value: byAlias, matchedBy: "alias" };
  }
  return null;
}

async function callYouTubeApi(pathname, params, accessToken, projectId) {
  const url = new URL(`https://youtube.googleapis.com${pathname}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const headers = {
    Accept: "application/json",
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  if (projectId && accessToken) {
    headers["X-Goog-User-Project"] = projectId;
  }

  const response = await fetch(url, { method: "GET", headers });
  const bodyText = await response.text();
  let json = {};
  try {
    json = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    json = {};
  }

  if (!response.ok) {
    const apiMessage = String(json?.error?.message || "").trim();
    throw new Error(`youtube_api_error:${response.status}:${apiMessage || "request failed"}`);
  }
  return json;
}

function getGcloudAccessToken(args) {
  try {
    return execFileSync("gcloud", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

function resolveYouTubeAuth(projectId) {
  if (YOUTUBE_API_KEY) {
    return {
      accessToken: "",
      apiKey: YOUTUBE_API_KEY,
      projectId,
    };
  }

  const adcToken = getGcloudAccessToken(["auth", "application-default", "print-access-token"]);
  if (adcToken) {
    return {
      accessToken: adcToken,
      apiKey: "",
      projectId,
    };
  }

  const userToken = getGcloudAccessToken(["auth", "print-access-token"]);
  if (userToken) {
    return {
      accessToken: userToken,
      apiKey: "",
      projectId,
    };
  }

  return null;
}

async function resolveChannel(channelRef, auth, aliasMap) {
  const parsed = parseChannelRef(channelRef, aliasMap);
  if (!parsed) return null;

  const params = {
    part: "snippet,contentDetails",
    fields: "items(id,snippet/title,contentDetails/relatedPlaylists/uploads)",
  };
  if (parsed.kind === "id") {
    params.id = parsed.value;
  } else if (parsed.kind === "handle") {
    params.forHandle = parsed.value;
  } else if (parsed.kind === "username") {
    params.forUsername = parsed.value;
  } else {
    return null;
  }

  if (auth.apiKey) {
    params.key = auth.apiKey;
  }

  const byRef = await callYouTubeApi("/youtube/v3/channels", params, auth.accessToken, auth.projectId);
  const first = Array.isArray(byRef?.items) ? byRef.items[0] : null;
  if (!first) return null;
  const channelId = String(first?.id || "").trim();
  const title = String(first?.snippet?.title || "").trim();
  const uploadsPlaylistId = String(first?.contentDetails?.relatedPlaylists?.uploads || "").trim();
  if (!channelId || !uploadsPlaylistId) return null;
  return {
    channelId,
    title,
    channelTitle: title,
    uploadsPlaylistId,
    matchedBy: parsed.matchedBy,
  };
}

async function fetchLatestVideosByChannel(channel, maxResults, auth) {
  const params = {
    part: "snippet,contentDetails",
    playlistId: channel.uploadsPlaylistId,
    maxResults: String(maxResults),
    fields: "items(contentDetails/videoId,snippet/resourceId/videoId,snippet/title,snippet/channelTitle,snippet/publishedAt)",
  };
  if (auth.apiKey) {
    params.key = auth.apiKey;
  }
  const response = await callYouTubeApi(
    "/youtube/v3/playlistItems",
    params,
    auth.accessToken,
    auth.projectId
  );

  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(response?.items) ? response.items : []) {
    const videoId = String(item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId || "").trim();
    const title = String(item?.snippet?.title || "").trim();
    if (!videoId || !title) continue;
    if (seen.has(videoId)) continue;
    seen.add(videoId);
    out.push({
      videoId,
      title,
      channelId: channel.channelId,
      channelTitle: String(item?.snippet?.channelTitle || channel.channelTitle || "").trim(),
      publishedAt: String(item?.snippet?.publishedAt || "").trim(),
    });
  }
  return out.sort((a, b) => {
    const left = Date.parse(String(a.publishedAt || ""));
    const right = Date.parse(String(b.publishedAt || ""));
    const leftSafe = Number.isFinite(left) ? left : 0;
    const rightSafe = Number.isFinite(right) ? right : 0;
    return rightSafe - leftSafe;
  });
}

async function main() {
  const channelRef = String(process.argv[2] || "").trim();
  const maxResultsRaw = String(process.argv[3] || "").trim();
  const maxResults = clampInt(maxResultsRaw || DEFAULT_MAX_RESULTS, 1, MAX_RESULTS, DEFAULT_MAX_RESULTS);
  if (!channelRef) {
    printJson(makeError("invalid_args", "channelRef is required"));
    return;
  }
  if (channelRef.length > 120) {
    printJson(makeError("invalid_args", "channelRef is too long (max 120)", { channelRef }));
    return;
  }
  if (/[^\P{C}\n\r\t]/u.test(channelRef)) {
    printJson(makeError("invalid_args", "channelRef must not include control characters", { channelRef }));
    return;
  }

  const projectId = String(process.env.GOOGLE_CLOUD_PROJECT_ID || "").trim();
  if (projectId) {
    process.env.CLOUDSDK_CORE_PROJECT = projectId;
  }

  const auth = resolveYouTubeAuth(projectId);
  if (!auth) {
    printJson(makeError(
      "auth_error",
      "failed to acquire YouTube credentials. set YOUTUBE_API_KEY or run gcloud auth application-default login"
    ));
    return;
  }

  const aliasMap = buildAliasMap();
  let channel = null;
  try {
    channel = await resolveChannel(channelRef, auth, aliasMap);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err || "request failed");
    printJson(makeError("youtube_api_error", message));
    return;
  }

  if (!channel) {
    printJson(makeError(
      "channel_not_found",
      `channel not found: ${channelRef}. use UC... channelId, @handle, or configured alias`,
      { channelRef }
    ));
    return;
  }

  let results = [];
  try {
    results = await fetchLatestVideosByChannel(channel, maxResults, auth);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err || "request failed");
    printJson(makeError("youtube_api_error", message, { channelId: channel.channelId }));
    return;
  }

  printJson({
    ok: true,
    channelRef,
    channels: [{
      channelId: channel.channelId,
      title: channel.title,
      channelTitle: channel.channelTitle,
      matchedBy: channel.matchedBy,
      resultCount: results.length,
    }],
    results,
  });
}

await main();
