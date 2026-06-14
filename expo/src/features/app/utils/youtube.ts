const YOUTUBE_FLOATING_PLAYER_WIDTH = 176;
const YOUTUBE_FLOATING_PLAYER_HEIGHT = 110;
const YOUTUBE_FLOATING_PLAYER_MARGIN = 12;
const YOUTUBE_EMBED_ORIGIN = "https://bitty-embed.local";

export function extractYouTubeVideoIds(raw: string) {
  const text = String(raw || "");
  const pattern = /[{\uFF5B]\s*youtube\s*[:\uFF1A]\s*([A-Za-z0-9_-]{11})\s*[}\uFF5D]/gi;
  const out: string[] = [];
  const seen = new Set<string>();
  let match = pattern.exec(text);
  while (match) {
    const videoId = String(match[1] || "").trim();
    if (videoId && !seen.has(videoId)) {
      seen.add(videoId);
      out.push(videoId);
    }
    match = pattern.exec(text);
  }
  return out;
}

export function stripYouTubeTags(raw: string) {
  return String(raw || "")
    .replace(/[\{\uFF5B]\s*youtube\s*[:\uFF1A]\s*[A-Za-z0-9_-]{1,32}\s*[\}\uFF5D]/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeYouTubeVideoIds(rawIds: unknown) {
  const ids = Array.isArray(rawIds) ? rawIds : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of ids) {
    const videoId = String(item || "").trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
    if (seen.has(videoId)) continue;
    seen.add(videoId);
    out.push(videoId);
  }
  return out;
}

function resolveYouTubeFloatingPlayerBounds(layout: { width: number; height: number }) {
  const width = Number(layout?.width || 0);
  const height = Number(layout?.height || 0);
  const minX = YOUTUBE_FLOATING_PLAYER_MARGIN;
  const minY = YOUTUBE_FLOATING_PLAYER_MARGIN;
  const maxX = Math.max(
    minX,
    width - YOUTUBE_FLOATING_PLAYER_WIDTH - YOUTUBE_FLOATING_PLAYER_MARGIN
  );
  const maxY = Math.max(
    minY,
    height - YOUTUBE_FLOATING_PLAYER_HEIGHT - YOUTUBE_FLOATING_PLAYER_MARGIN
  );
  return { minX, minY, maxX, maxY };
}

export function clampYouTubeFloatingPlayerPosition(
  position: { x: number; y: number },
  layout: { width: number; height: number }
) {
  const { minX, minY, maxX, maxY } = resolveYouTubeFloatingPlayerBounds(layout);
  return {
    x: Math.max(minX, Math.min(maxX, Number(position?.x || 0))),
    y: Math.max(minY, Math.min(maxY, Number(position?.y || 0))),
  };
}

export function resolveDefaultYouTubeFloatingPlayerPosition(layout: { width: number; height: number }) {
  const { minY, maxX } = resolveYouTubeFloatingPlayerBounds(layout);
  return { x: maxX, y: minY };
}

export function isSameStringArray(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function buildYouTubeEmbedHtml(videoId: string, session: number) {
  const normalized = String(videoId || "").trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(normalized)) return "";
  const safeSession = Number.isFinite(Number(session)) ? Math.max(0, Number(session)) : 0;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
    <style>
      html, body { margin: 0; padding: 0; background: #0f172a; height: 100%; }
      .wrap { position: fixed; inset: 0; }
      #player { width: 100%; height: 100%; }
      #player iframe { width: 100%; height: 100%; border: 0; }
    </style>
  </head>
  <body>
    <div class="wrap"><div id="player"></div></div>
    <script>
      (function () {
        var videoId = ${JSON.stringify(normalized)};
        var session = ${safeSession};
        var origin = ${JSON.stringify(YOUTUBE_EMBED_ORIGIN)};
        var player = null;
        function post(type, extra) {
          try {
            if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) return;
            var payload = Object.assign({ type: type, videoId: videoId, session: session }, extra || {});
            window.ReactNativeWebView.postMessage(JSON.stringify(payload));
          } catch {}
        }
        function playPlayer() {
          if (!player) return;
          try {
            player.playVideo();
          } catch {}
        }
        function seekPlayer(seconds) {
          if (!player) return;
          var time = Number(seconds);
          if (!Number.isFinite(time) || time <= 0) return;
          try {
            player.seekTo(time, true);
          } catch {}
        }
        function setPlayerVolume(volume, muted) {
          if (!player) return;
          var volumeNum = Number(volume);
          if (Number.isFinite(volumeNum)) {
            var normalizedVolume = Math.max(0, Math.min(100, Math.round(volumeNum)));
            try {
              if (typeof player.setVolume === "function") {
                player.setVolume(normalizedVolume);
              }
            } catch {}
            try {
              if (normalizedVolume <= 0 && typeof player.mute === "function") {
                player.mute();
              } else if (normalizedVolume > 0 && typeof player.unMute === "function") {
                player.unMute();
              }
            } catch {}
          }
          if (typeof muted === "boolean") {
            try {
              if (muted && typeof player.mute === "function") {
                player.mute();
              } else if (!muted && typeof player.unMute === "function") {
                player.unMute();
              }
            } catch {}
          }
        }
        function postProgress() {
          if (!player) return;
          var currentTime = 0;
          var muted = undefined;
          var volume = undefined;
          try {
            currentTime = Number(player.getCurrentTime && player.getCurrentTime()) || 0;
          } catch {}
          try {
            muted = player.isMuted && !!player.isMuted();
          } catch {}
          try {
            volume = Number(player.getVolume && player.getVolume());
          } catch {}
          post("youtube_progress", {
            currentTime: currentTime > 0 ? currentTime : 0,
            muted: muted,
            volume: Number.isFinite(volume) ? volume : undefined,
          });
        }
        function handleNativeMessage(event) {
          var raw = event && event.data;
          if (typeof raw !== "string") return;
          var payload = null;
          try {
            payload = JSON.parse(raw);
          } catch {
            return;
          }
          if (!payload || typeof payload !== "object") return;
          if (payload.type === "youtube_play") {
            seekPlayer(payload.seekTo);
            playPlayer();
            return;
          }
          if (payload.type === "youtube_set_volume") {
            setPlayerVolume(payload.volume, payload.muted);
          }
        }
        window.addEventListener("message", handleNativeMessage);
        document.addEventListener("message", handleNativeMessage);
        window.onYouTubeIframeAPIReady = function () {
          try {
            player = new window.YT.Player("player", {
              videoId: videoId,
              playerVars: {
                autoplay: 1,
                playsinline: 1,
                rel: 0,
                controls: 1,
                fs: 1,
                enablejsapi: 1,
                origin: origin,
              },
              events: {
                onReady: function (event) {
                  try {
                    event.target.playVideo();
                  } catch {}
                  post("youtube_ready");
                  postProgress();
                },
                onAutoplayBlocked: function () {
                  post("youtube_autoplay_blocked");
                },
                onStateChange: function (event) {
                  if (!window.YT || !window.YT.PlayerState) return;
                  if (event.data === window.YT.PlayerState.PLAYING) {
                    post("youtube_playing", {
                      muted: player && typeof player.isMuted === "function" ? !!player.isMuted() : undefined,
                      currentTime: player && typeof player.getCurrentTime === "function"
                        ? Number(player.getCurrentTime()) || 0
                        : 0,
                    });
                    return;
                  }
                  if (event.data === window.YT.PlayerState.BUFFERING) {
                    post("youtube_buffering");
                    return;
                  }
                  if (event.data === window.YT.PlayerState.PAUSED) {
                    post("youtube_paused");
                    return;
                  }
                  if (event.data === window.YT.PlayerState.ENDED) {
                    post("youtube_ended");
                  }
                },
                onError: function (event) {
                  post("youtube_error", { code: Number(event && event.data) || 0 });
                },
              },
            });
          } catch (error) {
            post("youtube_error", { message: String((error && error.message) || error || "player_init_failed") });
          }
        };
        var tag = document.createElement("script");
        tag.src = "https://www.youtube.com/iframe_api";
        tag.async = true;
        document.head.appendChild(tag);
        setInterval(postProgress, 600);
      })();
    </script>
  </body>
</html>`;
}

export function formatYouTubePublishedDate(raw: string) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) return text;
  return date.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function formatYouTubeViewCount(value: number | null) {
  if (!Number.isFinite(Number(value))) return "";
  return new Intl.NumberFormat("ja-JP").format(Number(value));
}
