#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const YOUTUBE_API_KEY = String(process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_DATA_API_KEY || "").trim();
const PAGE_SIZE = Math.max(1, Math.min(20, Number(process.env.YOUTUBE_FAVORITES_PAGE_SIZE || 5)));
const FAVORITES_TOTAL_COUNT = Math.max(1, Math.min(200, Number(process.env.YOUTUBE_FAVORITES_TOTAL_COUNT || 25)));
const MAX_PAGE_INDEX_CHARS = 12;
const MAX_SESSION_ID_CHARS = 120;
const DEFAULT_SESSION_KEY = "__default__";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "../..");
const DEFAULT_FAVORITES_STATE_PATH = "private_runner/logs/youtube_favorites_paging_state.json";
const FAVORITES_STATE_PATH_INPUT = String(process.env.YOUTUBE_FAVORITES_STATE_PATH || "").trim();
const FAVORITES_STATE_TTL_MS = Math.max(
  0,
  Number(process.env.YOUTUBE_FAVORITES_STATE_TTL_MS || 15 * 60 * 1000)
);
const FAVORITE_CHANNELS_SEED = [
  {
    key: "horiemon",
    channelId: "UCXjTiSGclQLVVU83GVrRM4w",
    channelRef: "ホリエモン",
    aliases: ["ホリエモン", "堀江貴文 ホリエモン", "堀江貴文ホリエモン"],
  },
  {
    key: "newspicks",
    channelId: "UCfTnJmRQP79C4y_BMF_XrlA",
    channelRef: "News Picks",
    aliases: ["News Picks", "NewsPicks", "ニューズピックス", "ニュースピックス"],
  },
  {
    key: "kensuu_speak",
    channelId: "UCdhJxokoEAfVaXK3xRZ9aHQ",
    channelRef: "ケンスウスピーク",
    aliases: ["ケンスウスピーク", "けんすう", "けんすう@AI時代の生き方"],
  },
  {
    key: "minowa",
    channelId: "UCDYj0iXVuKwd4bf9GSKgrfw",
    channelRef: "箕輪厚介",
    aliases: ["箕輪厚介", "箕輪世界観チャンネル", "箕輪世界観チャンネル。"],
  },
  {
    key: "kigyo_no_rirekisho",
    channelId: "UCmr-3xtixLI8NcBfv33yZoQ",
    channelRef: "@kigyo-no-rirekisho",
    aliases: ["@kigyo-no-rirekisho", "kigyo-no-rirekisho", "起業の履歴書", "起業の履歴書【AI解説】"],
  },
  {
    key: "ai_masaou",
    channelId: "UCvHpETRVi1tXeRJoYiXHJqw",
    channelRef: "@ai_masaou",
    aliases: ["@ai_masaou", "ai_masaou", "まさおAIじっくり解説ch"],
  },
  {
    key: "takahiro_anno",
    channelId: "UCiMwbmcCSMORJ-85XWhStBw",
    channelRef: "@安野貴博",
    aliases: ["@安野貴博", "安野貴博", "安野貴博の自由研究"],
  },
  {
    key: "ai_seitai",
    channelId: "UCVAkt5l6kD4igMdVoEGTGIg",
    channelRef: "@ai.seitai",
    aliases: ["@ai.seitai", "ai.seitai", "AI整体師"],
  },
  {
    key: "aivtuber2866",
    channelId: "UCZQVTC3uLCyuJUOcRlguazA",
    channelRef: "@aivtuber2866",
    aliases: ["@aivtuber2866", "aivtuber2866"],
  },
  {
    key: "monozukuritarou",
    channelId: "UCY9KXoezyo6cp-YwguOOCcg",
    channelRef: "@monozukuritarou",
    aliases: ["@monozukuritarou", "monozukuritarou"],
  },
  {
    key: "mrvr",
    channelId: "UCwZsAkQT2C_PSmuD0JaFeLw",
    channelRef: "@MrVR",
    aliases: ["@MrVR", "MrVR"],
  },
  {
    key: "kabunokaidoki",
    channelId: "UCoADGOCHt0bH5K-S8eL_kwg",
    channelRef: "@kabunokaidoki",
    aliases: ["@kabunokaidoki", "kabunokaidoki"],
  },
  {
    key: "kuuki_design",
    channelId: "UChXxbzzxzUHn7RRlgX0jaIQ",
    channelRef: "@KuukiDesign",
    aliases: ["@KuukiDesign", "KuukiDesign"],
  },
  {
    key: "jigokukaigainanmin2",
    channelId: "UCiVc9ZYawbkUxXkcs8D5A2w",
    channelRef: "@jigokukaigainanmin2",
    aliases: ["@jigokukaigainanmin2", "jigokukaigainanmin2"],
  },
  {
    key: "newyorkstyle_acchi",
    channelId: "UCSEgVs6Ja_vdk8qOFnIBlww",
    channelRef: "@NEWYORKSTYLE_acchi",
    aliases: ["@NEWYORKSTYLE_acchi", "NEWYORKSTYLE_acchi"],
  },
  {
    key: "tesla_news_japan",
    channelId: "UCEuTex6zeJXiaPkJmNGT2QQ",
    channelRef: "@TeslaNewsJapan",
    aliases: ["@TeslaNewsJapan", "TeslaNewsJapan"],
  },
];

function normalizeFavoriteChannels(seed) {
  const source = Array.isArray(seed) ? seed : [];
  const normalized = source.map((item, index) => ({
    key: String(item?.key || "").trim(),
    channelId: String(item?.channelId || "").trim(),
    channelRef: String(item?.channelRef || "").trim(),
    aliases: Array.isArray(item?.aliases) ? item.aliases : [],
    order: index,
  })).filter((item) => (
    item.key &&
    /^[A-Za-z0-9_-]{24}$/.test(item.channelId) &&
    item.channelRef
  ));
  const seen = new Set();
  const deduped = [];
  for (const item of normalized) {
    if (seen.has(item.channelId)) continue;
    seen.add(item.channelId);
    deduped.push(item);
  }
  return deduped;
}

function resolveMaxVideosPerChannel(totalCount, channelCount) {
  if (!Number.isInteger(channelCount) || channelCount <= 0) return 1;
  const base = Math.ceil(totalCount / channelCount);
  return Math.max(1, Math.min(50, base + 3));
}

const FAVORITE_CHANNELS = normalizeFavoriteChannels(FAVORITE_CHANNELS_SEED);
const MAX_VIDEOS_PER_CHANNEL = resolveMaxVideosPerChannel(FAVORITES_TOTAL_COUNT, FAVORITE_CHANNELS.length);

function resolveFavoritesStatePath() {
  const input = FAVORITES_STATE_PATH_INPUT || DEFAULT_FAVORITES_STATE_PATH;
  if (path.isAbsolute(input)) return path.resolve(input);
  return path.resolve(WORKSPACE_ROOT, input);
}

const FAVORITES_STATE_PATH = resolveFavoritesStatePath();

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function makeError(code, message, extra = {}, pagingOverrides = {}) {
  const totalPages = resolveTotalPages(FAVORITES_TOTAL_COUNT);
  const currentPageIndex = clampPageIndex(
    Number.isFinite(Number(pagingOverrides?.currentPageIndex))
      ? Number(pagingOverrides.currentPageIndex)
      : 0,
    totalPages
  );
  return {
    ok: false,
    error: {
      code: String(code || "unknown_error"),
      message: String(message || "unknown error"),
      ...extra,
    },
    channels: [],
    results: [],
    paging: {
      currentPageIndex,
    },
  };
}

function resolveTotalPages(totalChannels) {
  return Math.max(1, Math.ceil(Math.max(0, Number(totalChannels || 0)) / PAGE_SIZE));
}

function clampPageIndex(pageIndex, totalPages) {
  const max = Math.max(0, Number(totalPages || 1) - 1);
  const value = Number(pageIndex);
  if (!Number.isInteger(value)) return 0;
  if (value < 0) return 0;
  if (value > max) return max;
  return value;
}

function normalizePageIndex(rawPageIndex, totalPages) {
  const token = String(rawPageIndex || "").trim();
  if (!token) return 0;
  if (token.length > MAX_PAGE_INDEX_CHARS) {
    throw new Error(`pageIndex is too long (max ${MAX_PAGE_INDEX_CHARS})`);
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(token)) {
    throw new Error("pageIndex must be a non-negative integer string");
  }
  const pageIndex = Number(token);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new Error("pageIndex must be a non-negative integer string");
  }
  const max = Math.max(0, totalPages - 1);
  if (pageIndex > max) {
    throw new Error(`pageIndex is out of range (max ${max})`);
  }
  return pageIndex;
}

function toEpoch(publishedAt) {
  const epoch = Date.parse(String(publishedAt || ""));
  return Number.isFinite(epoch) ? epoch : Number.NEGATIVE_INFINITY;
}

function sanitizeSessionId(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value.length > MAX_SESSION_ID_CHARS) return "";
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) return "";
  return value;
}

function resolveSessionKey() {
  const sessionId = sanitizeSessionId(process.env.YOUTUBE_FAVORITES_SESSION_ID || "");
  return sessionId || DEFAULT_SESSION_KEY;
}

function isExpired(updatedAtRaw) {
  if (FAVORITES_STATE_TTL_MS <= 0) return false;
  const updatedAtMs = Date.parse(String(updatedAtRaw || ""));
  if (!Number.isFinite(updatedAtMs)) return true;
  return Date.now() - updatedAtMs > FAVORITES_STATE_TTL_MS;
}

async function readPagingStateFile() {
  let text = "";
  try {
    text = await fs.readFile(FAVORITES_STATE_PATH, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function resolveLegacyNextPageIndex(stateRoot, totalPages) {
  if (isExpired(stateRoot?.updatedAt)) return 0;
  const rawOffset = String(stateRoot?.nextOffset || "").trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(rawOffset)) return 0;
  const offset = Number(rawOffset);
  if (!Number.isInteger(offset) || offset < 0) return 0;
  return clampPageIndex(Math.floor(offset / PAGE_SIZE), totalPages);
}

function resolveSessionNextPageIndex(stateRoot, sessionKey, totalPages) {
  const sessions = stateRoot?.sessions;
  if (!sessions || typeof sessions !== "object") {
    return resolveLegacyNextPageIndex(stateRoot, totalPages);
  }
  const entry = sessions[sessionKey];
  if (!entry || typeof entry !== "object") {
    return 0;
  }
  if (isExpired(entry.updatedAt)) {
    return 0;
  }
  const rawPageIndex = String(entry.nextPageIndex || "").trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(rawPageIndex)) {
    return 0;
  }
  return clampPageIndex(Number(rawPageIndex), totalPages);
}

async function loadSavedNextPageIndex(sessionKey, totalPages) {
  const stateRoot = await readPagingStateFile();
  return resolveSessionNextPageIndex(stateRoot, sessionKey, totalPages);
}

async function saveNextPageIndex(sessionKey, nextPageIndex, totalPages) {
  const normalizedNextPageIndex = clampPageIndex(nextPageIndex, totalPages);
  const stateRoot = await readPagingStateFile();
  const sessions = stateRoot?.sessions && typeof stateRoot.sessions === "object"
    ? { ...stateRoot.sessions }
    : {};
  const nowIso = new Date().toISOString();
  sessions[sessionKey] = {
    nextPageIndex: String(normalizedNextPageIndex),
    updatedAt: nowIso,
  };

  if (FAVORITES_STATE_TTL_MS > 0) {
    for (const [key, value] of Object.entries(sessions)) {
      if (!value || typeof value !== "object") {
        delete sessions[key];
        continue;
      }
      if (isExpired(value.updatedAt)) {
        delete sessions[key];
      }
    }
  }

  const payload = {
    version: 2,
    updatedAt: nowIso,
    sessions,
  };
  const dir = path.dirname(FAVORITES_STATE_PATH);
  const tempPath = `${FAVORITES_STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tempPath, JSON.stringify(payload), "utf8");
  await fs.rename(tempPath, FAVORITES_STATE_PATH);
}

async function callYouTubeApi(pathname, params, accessToken, projectId) {
  const url = new URL(`https://youtube.googleapis.com${pathname}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const headers = { Accept: "application/json" };
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

async function fetchChannelsByIds(channelIds, auth) {
  const ids = Array.isArray(channelIds)
    ? [...new Set(channelIds.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
  if (ids.length === 0) return new Map();
  const params = {
    part: "snippet,contentDetails",
    id: ids.join(","),
    fields: "items(id,snippet/title,contentDetails/relatedPlaylists/uploads)",
    maxResults: String(Math.min(ids.length, 50)),
  };
  if (auth.apiKey) {
    params.key = auth.apiKey;
  }
  const response = await callYouTubeApi("/youtube/v3/channels", params, auth.accessToken, auth.projectId);
  const map = new Map();
  for (const item of Array.isArray(response?.items) ? response.items : []) {
    const channelId = String(item?.id || "").trim();
    if (!channelId) continue;
    map.set(channelId, {
      channelId,
      channelTitle: String(item?.snippet?.title || "").trim(),
      uploadsPlaylistId: String(item?.contentDetails?.relatedPlaylists?.uploads || "").trim(),
    });
  }
  return map;
}

async function fetchRecentVideosByPlaylistId(playlistId, channelInfo, auth, maxResults) {
  const params = {
    part: "snippet,contentDetails",
    playlistId,
    maxResults: String(Math.max(1, Math.min(50, Number(maxResults || 1)))),
    fields: "items(contentDetails/videoId,snippet/resourceId/videoId,snippet/title,snippet/channelTitle,snippet/publishedAt)",
  };
  if (auth.apiKey) {
    params.key = auth.apiKey;
  }
  const response = await callYouTubeApi("/youtube/v3/playlistItems", params, auth.accessToken, auth.projectId);
  const items = Array.isArray(response?.items) ? response.items : [];
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const videoId = String(item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId || "").trim();
    const title = String(item?.snippet?.title || "").trim();
    if (!videoId || !title) continue;
    out.push({
      videoId,
      title,
      channelId: channelInfo.channelId,
      channelTitle: String(item?.snippet?.channelTitle || channelInfo.channelTitle || "").trim(),
      publishedAt: String(item?.snippet?.publishedAt || "").trim(),
      videoOrder: i,
    });
  }
  return out;
}

async function main() {
  const rawPageIndexArg = String(process.argv[2] || "");
  if (/[^\P{C}\n\r\t]/u.test(rawPageIndexArg)) {
    printJson(makeError("invalid_args", "pageIndex must not include control characters", { pageIndex: rawPageIndexArg }));
    return;
  }
  const pageIndexArg = rawPageIndexArg.trim();
  const totalPages = resolveTotalPages(FAVORITES_TOTAL_COUNT);
  const sessionKey = resolveSessionKey();

  let pageIndex = 0;
  if (pageIndexArg) {
    try {
      pageIndex = normalizePageIndex(pageIndexArg, totalPages);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || "invalid pageIndex");
      printJson(makeError("invalid_args", message, { pageIndex: pageIndexArg }));
      return;
    }
  } else {
    pageIndex = await loadSavedNextPageIndex(sessionKey, totalPages);
  }

  const projectId = String(process.env.GOOGLE_CLOUD_PROJECT_ID || "").trim();
  if (projectId) {
    process.env.CLOUDSDK_CORE_PROJECT = projectId;
  }

  const auth = resolveYouTubeAuth(projectId);
  if (!auth) {
    printJson(makeError(
      "auth_error",
      "failed to acquire YouTube credentials. set YOUTUBE_API_KEY or run gcloud auth application-default login",
      {},
      { currentPageIndex: pageIndex }
    ));
    return;
  }

  const allChannels = FAVORITE_CHANNELS;
  const channelIds = allChannels.map((item) => item.channelId);

  let channelMetaMap = new Map();
  try {
    channelMetaMap = await fetchChannelsByIds(channelIds, auth);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err || "request failed");
    printJson(makeError("youtube_api_error", message, {}, { currentPageIndex: pageIndex }));
    return;
  }

  const resolvedChannels = allChannels.map((item, index) => {
    const meta = channelMetaMap.get(item.channelId) || {};
    return {
      key: item.key,
      channelId: item.channelId,
      channelRef: item.channelRef,
      aliases: item.aliases,
      order: Number.isInteger(item.order) ? item.order : index,
      channelTitle: String(meta.channelTitle || "").trim(),
      uploadsPlaylistId: String(meta.uploadsPlaylistId || "").trim(),
    };
  });

  const perChannel = await Promise.all(resolvedChannels.map(async (channel) => {
    if (!channel.uploadsPlaylistId) {
      return {
        channel,
        videos: [],
        error: "uploads_playlist_not_found",
      };
    }
    try {
      const videos = await fetchRecentVideosByPlaylistId(
        channel.uploadsPlaylistId,
        channel,
        auth,
        MAX_VIDEOS_PER_CHANNEL
      );
      return {
        channel,
        videos,
        error: videos.length > 0 ? "" : "latest_video_not_found",
      };
    } catch (err) {
      return {
        channel,
        videos: [],
        error: err instanceof Error ? err.message : String(err || "request failed"),
      };
    }
  }));

  const rankedVideos = perChannel
    .flatMap((item) => item.videos.map((video) => ({
      ...video,
      key: item.channel.key,
      channelRef: item.channel.channelRef,
      aliases: item.channel.aliases,
      channelOrder: item.channel.order,
      latestEpoch: toEpoch(video.publishedAt || ""),
    })))
    .sort((left, right) => {
      const diff = right.latestEpoch - left.latestEpoch;
      if (diff !== 0) return diff;
      const channelOrderDiff = left.channelOrder - right.channelOrder;
      if (channelOrderDiff !== 0) return channelOrderDiff;
      return left.videoOrder - right.videoOrder;
    });

  const seenVideoIds = new Set();
  const dedupedVideos = [];
  for (const item of rankedVideos) {
    if (!item.videoId) continue;
    if (seenVideoIds.has(item.videoId)) continue;
    seenVideoIds.add(item.videoId);
    dedupedVideos.push(item);
    if (dedupedVideos.length >= FAVORITES_TOTAL_COUNT) break;
  }

  const pageOffset = pageIndex * PAGE_SIZE;
  const pageItems = dedupedVideos.slice(pageOffset, pageOffset + PAGE_SIZE);

  const channels = pageItems.map((item) => ({
    key: item.key,
    channelId: item.channelId,
    channelRef: item.channelRef,
    channelTitle: item.channelTitle,
    aliases: item.aliases,
    latestVideoId: item.videoId || "",
    latestPublishedAt: item.publishedAt || "",
    error: "",
  }));

  const results = pageItems.map((item) => ({
    videoId: item.videoId,
    title: item.title,
    channelId: item.channelId,
    channelTitle: item.channelTitle,
    publishedAt: item.publishedAt,
    key: item.key,
    channelRef: item.channelRef,
  }));

  const nextPageIndex = pageIndex + 1 < totalPages ? pageIndex + 1 : 0;

  try {
    await saveNextPageIndex(sessionKey, nextPageIndex, totalPages);
  } catch {}

  printJson({
    ok: true,
    tool: "youtube_favorites",
    channels,
    results,
    paging: {
      currentPageIndex: pageIndex,
    },
  });
}

await main();
