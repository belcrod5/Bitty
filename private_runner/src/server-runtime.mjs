import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createReadStream, promises as fs } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { createLlmFileBrowseTools } from "./llm-file-browse-tools.mjs";
import { createLlmFileExecutionTools } from "./llm-file-execution-tools.mjs";
import { createLlmFilePatchTools } from "./llm-file-patch-tools.mjs";
import { createLlmAcpSessionStore } from "./llm-acp-session-store.mjs";
import { createLlmCliRolloutWriter } from "./llm-cli-rollout-writer.mjs";
import { createLlmCliSessionIndex } from "./llm-cli-session-index.mjs";
import { createLlmSessionRolloutReaders } from "./llm-session-rollout-readers.mjs";
import { createWorkspaceFilesService } from "./workspace-files.mjs";

const SERVER_FILE_PATH = fileURLToPath(import.meta.url);
const SERVER_DIR = path.dirname(SERVER_FILE_PATH);
const WORKSPACE_ROOT = path.resolve(SERVER_DIR, "../..");

const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || "127.0.0.1";
const RUNNER_TOKEN = process.env.RUNNER_TOKEN || "";
const RUNNER_MOCK = process.env.RUNNER_MOCK === "1";
const RUNNER_SKIP_SERVER_START = process.env.RUNNER_SKIP_SERVER_START === "1";
const RUNNER_WS_PATH = "/runner-ws";
const RUNNER_WS_CHANNELS = new Set(["llm", "tts", "relay", "control"]);
const CODEX_WS_PROXY_UPSTREAM_URL = String(
  process.env.CODEX_WS_PROXY_UPSTREAM_URL || "ws://127.0.0.1:4500"
).trim();
const CODEX_WS_PROXY_UPSTREAM_TOKEN = String(process.env.CODEX_WS_PROXY_UPSTREAM_TOKEN || "").trim();
const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_CODEX_ROUTE = "openai-codex-responses";
const OPENAI_CODEX_MODEL_REF = String(
  process.env.OPENAI_CODEX_MODEL || process.env.CODEX_MODEL || "openai-codex/gpt-5.4-mini"
).trim();
const OPENAI_CODEX_REASONING_EFFORT = String(
  process.env.OPENAI_CODEX_REASONING_EFFORT || process.env.CODEX_REASONING_EFFORT || "low"
).trim().toLowerCase();
const OPENAI_CODEX_RESPONSES_BASE_URL = (
  process.env.OPENAI_CODEX_RESPONSES_BASE_URL || "https://chatgpt.com/backend-api/codex"
).replace(/\/+$/, "");
const OPENAI_CODEX_INSTRUCTIONS = String(process.env.OPENAI_CODEX_INSTRUCTIONS || "").trim();
const OPENAI_CODEX_INSTRUCTIONS_FALLBACK = [
  "You are a coding assistant operating in file-tools mode.",
  "Follow this loop: observe -> small edit(apply_patch) -> verify -> diff -> finalize.",
  "Observe with list_dir/search_text/read_file_range, edit with apply_patch, verify with run_tests, and inspect changes with git_diff.",
  "Prefer minimal, precise edits and avoid broad or destructive commands.",
].join(" ");
const OPENAI_CODEX_OAUTH_PROFILE = String(process.env.OPENAI_CODEX_OAUTH_PROFILE || "default").trim();
const NEAR_UNLIMITED_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h
const CODEX_CLI_STATUS_HTTP_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.CODEX_CLI_STATUS_HTTP_TIMEOUT_MS || 12000)
);
const CODEX_CLI_STATUS_CACHE_TTL_MS = Math.max(0, Number(process.env.CODEX_CLI_STATUS_CACHE_TTL_MS || 60000));
const CODEX_CLI_WHAM_USAGE_URL = String(
  process.env.CODEX_CLI_WHAM_USAGE_URL || "https://chatgpt.com/backend-api/wham/usage"
).trim();
const OPENAI_CODEX_TIMEOUT_MS = Number(
  process.env.OPENAI_CODEX_TIMEOUT_MS || process.env.CODEX_TIMEOUT_MS || NEAR_UNLIMITED_TIMEOUT_MS
);
const CODEX_QUEUE_WAIT_FOR_COMPACT_MAX_MS = Math.max(
  1000,
  Number(process.env.CODEX_QUEUE_WAIT_FOR_COMPACT_MAX_MS || 30000)
);
const OPENAI_CODEX_UPSTREAM_MAX_RETRIES = Math.max(
  0,
  Number(process.env.OPENAI_CODEX_UPSTREAM_MAX_RETRIES || 3)
);
const OPENAI_CODEX_UPSTREAM_RETRY_BASE_MS = Math.max(
  100,
  Number(process.env.OPENAI_CODEX_UPSTREAM_RETRY_BASE_MS || 700)
);
const OPENAI_CODEX_UPSTREAM_RETRY_MAX_MS = Math.max(
  OPENAI_CODEX_UPSTREAM_RETRY_BASE_MS,
  Number(process.env.OPENAI_CODEX_UPSTREAM_RETRY_MAX_MS || 4000)
);
const OPENAI_CODEX_TOKEN_REFRESH_SKEW_SEC = Number(process.env.OPENAI_CODEX_TOKEN_REFRESH_SKEW_SEC || 120);
const OPENAI_CODEX_ORIGINATOR = process.env.OPENAI_CODEX_ORIGINATOR || "bitty_private_runner";
const OPENAI_CODEX_VERSION = process.env.OPENAI_CODEX_VERSION || "runner/1";
const CLI_SESSION_META_ORIGINATOR = String(process.env.CLI_SESSION_META_ORIGINATOR || "codex-tui").trim() || "codex-tui";
const CLI_SESSION_META_SOURCE = String(process.env.CLI_SESSION_META_SOURCE || "cli").trim().toLowerCase() === "exec"
  ? "exec"
  : "cli";
const CLI_SESSION_META_VERSION = String(process.env.CLI_SESSION_META_VERSION || "0.125.0").trim() || "0.125.0";
const DEFAULT_CODEX_HOME = path.resolve(os.homedir(), ".codex");
const CODEX_HOME = path.resolve(process.env.CODEX_HOME || DEFAULT_CODEX_HOME);
const CODEX_AUTH_PATH = path.join(CODEX_HOME, "auth.json");
const CODEX_AUTH_PROFILES_DIR = path.join(CODEX_HOME, "profiles");
const CODEX_AUTH_PROFILE_SUFFIX = "_auth.json";
const CODEX_AUTH_SWITCH_LOCK_PATH = path.join(CODEX_AUTH_PROFILES_DIR, ".switch.lock");
const CODEX_AUTH_ACTIVE_ID_PATH = path.join(CODEX_AUTH_PROFILES_DIR, ".active_auth_id");
const CODEX_AUTH_SWITCH_RESTART_SCRIPT_PATH = path.resolve(WORKSPACE_ROOT, "private_runner/run-local.sh");
const CODEX_AUTH_SWITCH_RESTART_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.CODEX_AUTH_SWITCH_RESTART_TIMEOUT_MS || 8000)
);
const CODEX_AUTH_SWITCH_REQUIRE_SUDO = !["0", "false", "no", "off"].includes(
  String(process.env.CODEX_AUTH_SWITCH_REQUIRE_SUDO ?? "0").trim().toLowerCase()
);
const CODEX_CLI_SESSIONS_DIR = path.resolve(
  process.env.CODEX_CLI_SESSIONS_DIR || path.join(os.homedir(), ".codex", "sessions")
);
const OPENAI_OAUTH_ISSUER = process.env.OPENAI_OAUTH_ISSUER || "https://auth.openai.com";
const OPENAI_OAUTH_TOKEN_URL = `${OPENAI_OAUTH_ISSUER.replace(/\/+$/, "")}/oauth/token`;
const MAX_TRANSCRIPT_CHARS = Number(process.env.MAX_TRANSCRIPT_CHARS || 8000);
const MAX_MESSAGES_TOTAL_CHARS = Number(process.env.MAX_MESSAGES_TOTAL_CHARS || 24000);
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_API_BASE_URL = process.env.GROQ_API_BASE_URL || "https://api.groq.com/openai/v1";
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo";
const GROQ_STT_LANGUAGE = normalizeSttLanguage(process.env.GROQ_STT_LANGUAGE || "ja");
const GROQ_STT_TIMEOUT_MS = Math.max(1000, Number(process.env.GROQ_STT_TIMEOUT_MS || NEAR_UNLIMITED_TIMEOUT_MS));
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_API_BASE_URL = process.env.ELEVENLABS_API_BASE_URL || "https://api.elevenlabs.io";
const ELEVENLABS_TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || "eleven_multilingual_v2";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
const ELEVENLABS_OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || "mp3_44100_128";
const AIVISSPEECH_API_BASE_URL = process.env.AIVISSPEECH_API_BASE_URL || "http://127.0.0.1:10101";
const AIVISSPEECH_SPEAKER = String(process.env.AIVISSPEECH_SPEAKER || "").trim();
const AIVISSPEECH_APP_PATH = path.resolve(
  process.env.AIVISSPEECH_APP_PATH || "/Applications/AivisSpeech.app"
);
const AIVISSPEECH_READY_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.AIVISSPEECH_READY_TIMEOUT_MS || NEAR_UNLIMITED_TIMEOUT_MS)
);
const AIVISSPEECH_READY_POLL_MS = Math.max(
  200,
  Number(process.env.AIVISSPEECH_READY_POLL_MS || 700)
);
const TTS_PROVIDER_RAW = String(process.env.TTS_PROVIDER || "elevenlabs").trim().toLowerCase();
const GOOGLE_CLOUD_PROJECT_ID = String(process.env.GOOGLE_CLOUD_PROJECT_ID || "").trim();
const YOUTUBE_API_KEY = String(process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_DATA_API_KEY || "").trim();
const GOOGLE_CLOUD_TTS_API_BASE_URL =
  process.env.GOOGLE_CLOUD_TTS_API_BASE_URL || "https://texttospeech.googleapis.com";
const GOOGLE_CLOUD_TTS_LANGUAGE_CODE = process.env.GOOGLE_CLOUD_TTS_LANGUAGE_CODE || "ja-JP";
const GOOGLE_CLOUD_TTS_VOICE_NAME = process.env.GOOGLE_CLOUD_TTS_VOICE_NAME || "ja-JP-Neural2-B";
const GOOGLE_CLOUD_TTS_AUDIO_ENCODING = process.env.GOOGLE_CLOUD_TTS_AUDIO_ENCODING || "MP3";
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES || 25 * 1024 * 1024);
const MAX_WORKSPACE_UPLOAD_BYTES = Number(
  process.env.MAX_WORKSPACE_UPLOAD_BYTES || 25 * 1024 * 1024
);
const MAX_TTS_CHARS = Number(process.env.MAX_TTS_CHARS || 5000);
const STREAM_TTS_SEGMENT_MAX_CHARS = Math.max(
  24,
  Number(process.env.STREAM_TTS_SEGMENT_MAX_CHARS || 70)
);
const STREAM_TTS_SEGMENT_MIN_CHARS = Math.max(
  8,
  Number(process.env.STREAM_TTS_SEGMENT_MIN_CHARS || 12)
);
const STREAM_TTS_SEGMENT_FORCE_SPLIT_WINDOW_CHARS = Math.max(
  8,
  Number(process.env.STREAM_TTS_SEGMENT_FORCE_SPLIT_WINDOW_CHARS || 22)
);
const STREAM_TTS_SEGMENT_MAX_EST_MS = Math.max(
  300,
  Number(process.env.STREAM_TTS_SEGMENT_MAX_EST_MS || 1200)
);
const STREAM_TTS_EST_BASE_CHARS_PER_SEC = Math.max(
  1,
  Number(process.env.STREAM_TTS_EST_BASE_CHARS_PER_SEC || 7.5)
);
const TTS_MEDIA_DIR = path.resolve(
  WORKSPACE_ROOT,
  process.env.TTS_MEDIA_DIR || "private_runner/.cache/tts-media"
);
const TTS_MEDIA_TTL_MS = Math.max(
  10000,
  Number(process.env.TTS_MEDIA_TTL_MS || 10 * 60 * 1000)
);
const TTS_MEDIA_SWEEP_INTERVAL_MS = Math.max(
  5000,
  Number(process.env.TTS_MEDIA_SWEEP_INTERVAL_MS || 60 * 1000)
);
const TTS_MEDIA_MAX_ENTRIES = Math.max(
  16,
  Number(process.env.TTS_MEDIA_MAX_ENTRIES || 512)
);
const RUNNER_LOG_REQUESTS = process.env.RUNNER_LOG_REQUESTS !== "0";
const SUPPORTED_TTS_PROVIDERS = new Set(["elevenlabs", "google", "aivisspeech"]);
const TTS_PROVIDER = SUPPORTED_TTS_PROVIDERS.has(TTS_PROVIDER_RAW) ? TTS_PROVIDER_RAW : "elevenlabs";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const DEFAULT_LLM_FILE_ROOT = path.resolve(WORKSPACE_ROOT, process.env.LLM_FILE_ROOT || "llm_root");
const DEFAULT_LLM_FILE_ROOT_RELATIVE = toUnixPath(path.relative(WORKSPACE_ROOT, DEFAULT_LLM_FILE_ROOT)) || ".";
const LLM_FILE_MAX_READ_BYTES = Number(process.env.LLM_FILE_MAX_READ_BYTES || 65536);
const LLM_FILE_DEFAULT_READ_BYTES = Number(process.env.LLM_FILE_DEFAULT_READ_BYTES || 8192);
const CLIENT_FILE_CONTENT_MAX_BYTES = 5 * 1024 * 1024;
const LLM_FILE_MAX_READ_LINES = Math.max(1, Number(process.env.LLM_FILE_MAX_READ_LINES || 400));
const LLM_FILE_MAX_TOOL_ROUNDS_DEFAULT = Number(process.env.LLM_FILE_MAX_TOOL_ROUNDS || 500);
let llmFileMaxToolRoundsRuntime = LLM_FILE_MAX_TOOL_ROUNDS_DEFAULT;
let codexCliStatusCache = {
  fetchedAtMs: 0,
  snapshot: null,
};
const LLM_FILE_MAX_FIND_RESULTS = Number(process.env.LLM_FILE_MAX_FIND_RESULTS || 500);
const LLM_FILE_MAX_SEARCH_RESULTS = Number(process.env.LLM_FILE_MAX_SEARCH_RESULTS || 200);
const LLM_FILE_MAX_SCAN_FILES = Number(process.env.LLM_FILE_MAX_SCAN_FILES || 5000);
const DIRECTORY_EXPLORER_MAX_ENTRIES = Number(process.env.DIRECTORY_EXPLORER_MAX_ENTRIES || 500);
const SCRIPT_EXEC_TIMEOUT_MS_DEFAULT = 2 * 60 * 1000;
const SCRIPT_EXEC_TIMEOUT_MS_MAX = 10 * 60 * 1000;
const SCRIPT_JOB_MAX_STORED = Math.max(10, Number(process.env.SCRIPT_JOB_MAX_STORED || 120));
const SCRIPT_JOB_KILL_GRACE_MS = Math.max(200, Number(process.env.SCRIPT_JOB_KILL_GRACE_MS || 700));
const LLM_FILE_MAX_EDIT_FILE_BYTES = Number(process.env.LLM_FILE_MAX_EDIT_FILE_BYTES || 2 * 1024 * 1024);
const LLM_FILE_ENABLE_LEGACY_WRITE_TOOLS = String(process.env.LLM_FILE_ENABLE_LEGACY_WRITE_TOOLS || "0").trim() === "1";
const LLM_FILE_ENABLE_MEDIA_TOOL = String(process.env.LLM_FILE_ENABLE_MEDIA_TOOL || "1").trim() !== "0";
const LLM_EXECUTION_SESSION_ID_MAX_CHARS = 120;
const LLM_FILE_AUDIT_LOG_PATH = path.resolve(
  WORKSPACE_ROOT,
  process.env.LLM_FILE_AUDIT_LOG_PATH || "private_runner/logs/llm_tool_audit.jsonl"
);
const LLM_REQUEST_LOG_ENABLED = process.env.LLM_REQUEST_LOG_ENABLED !== "0";
const LLM_REQUEST_LOG_MAX_FILES = Math.max(1, Number(process.env.LLM_REQUEST_LOG_MAX_FILES || 10));
const LLM_REQUEST_LOG_DIR = path.resolve(
  WORKSPACE_ROOT,
  process.env.LLM_REQUEST_LOG_DIR || "private_runner/logs/llm_request_payloads"
);
const RUNNER_SESSION_STARTED_AT = new Date();
const RUNNER_SESSION_STAMP = formatDateForFilename(RUNNER_SESSION_STARTED_AT);
const LLM_REQUEST_LOG_PATH = path.join(LLM_REQUEST_LOG_DIR, `${RUNNER_SESSION_STAMP}.jsonl`);
const CLIENT_APP_LOG_DIR = path.resolve(
  WORKSPACE_ROOT,
  process.env.CLIENT_APP_LOG_DIR || "private_runner/logs/client_auto_logs"
);
const CLIENT_APP_LOG_PATH = path.join(CLIENT_APP_LOG_DIR, `${RUNNER_SESSION_STAMP}.jsonl`);
const CLIENT_APP_LOG_MAX_FILES = Math.max(1, Number(process.env.CLIENT_APP_LOG_MAX_FILES || 10));
const CLIENT_APP_LOG_SESSION_DIAG_DETAIL_ENABLED = (
  String(process.env.CLIENT_APP_LOG_SESSION_DIAG_DETAIL_ENABLED || "0").trim() === "1"
);
const workspaceFilesService = createWorkspaceFilesService({
  workspaceRoot: WORKSPACE_ROOT,
  maxUploadBytes: MAX_WORKSPACE_UPLOAD_BYTES,
});
const CODEX_WS_PROXY_DEBUG_LOG_DIR = path.resolve(
  WORKSPACE_ROOT,
  process.env.CODEX_WS_PROXY_DEBUG_LOG_DIR || "private_runner/logs/codex_ws_proxy"
);
const CODEX_WS_PROXY_DEBUG_LOG_PATH = path.join(
  CODEX_WS_PROXY_DEBUG_LOG_DIR,
  `${RUNNER_SESSION_STAMP}.jsonl`
);
const CODEX_WS_PROXY_DEBUG_LOG_MAX_FILES = Math.max(
  1,
  Number(process.env.CODEX_WS_PROXY_DEBUG_LOG_MAX_FILES || 10)
);
const CODEX_WS_PROXY_DEBUG_BUFFER_MAX = Math.max(
  50,
  Number(process.env.CODEX_WS_PROXY_DEBUG_BUFFER_MAX || 500)
);
const CODEX_WS_RELAY_EVENT_MAX = Math.max(
  100,
  Number(process.env.CODEX_WS_RELAY_EVENT_MAX || 6000)
);
const CODEX_WS_RELAY_IDLE_TTL_MS = Math.max(
  10000,
  Number(process.env.CODEX_WS_RELAY_IDLE_TTL_MS || 5 * 60 * 1000)
);
const CODEX_WS_RELAY_COMPLETED_TTL_MS = Math.max(
  5000,
  Number(process.env.CODEX_WS_RELAY_COMPLETED_TTL_MS || 60 * 1000)
);
const CODEX_WS_RELAY_MAX_ACTIVE = Math.max(
  8,
  Number(process.env.CODEX_WS_RELAY_MAX_ACTIVE || 64)
);
const CLIENT_APP_LOG_MAX_EVENTS_PER_REQUEST = Math.max(
  1,
  Number(process.env.CLIENT_APP_LOG_MAX_EVENTS_PER_REQUEST || 200)
);
const CLIENT_APP_LOG_MAX_EVENT_NAME_CHARS = Math.max(
  24,
  Number(process.env.CLIENT_APP_LOG_MAX_EVENT_NAME_CHARS || 80)
);
const CLIENT_APP_LOG_MAX_STRING_CHARS = Math.max(
  64,
  Number(process.env.CLIENT_APP_LOG_MAX_STRING_CHARS || 1200)
);
const CLIENT_APP_LOG_SEND_TRACE_EVENTS = new Set([
  "chat_composer_primary_button_pressed",
  "chat_composer_send_action_dispatched",
  "reply_send_requested",
  "reply_send_dispatch_to_guard",
  "reply_send_guard_enter",
  "reply_send_guard_queued_after_session_restore",
  "reply_send_guard_blocked_missing_panel_snapshot",
  "reply_send_guard_blocked_missing_panel_session_snapshot",
  "reply_send_guard_dispatch_panel_snapshot",
  "reply_send_guard_blocked_session_alignment_failed",
  "reply_send_guard_blocked_missing_session_id",
  "reply_send_guard_unverified_session_restore_start",
  "reply_send_guard_unverified_session_restore_failed",
  "reply_send_guard_dispatch_main",
  "reply_http_send_skipped",
  "reply_http_request_start",
]);
const LLM_FILE_SKILL_SCAN_MAX = Number(process.env.LLM_FILE_SKILL_SCAN_MAX || 200);
const LLM_FILE_SKIP_SCAN_DIRS = new Set([".git", "node_modules", ".expo"]);
const LLM_FILE_GLOB_MATCHER_VERSION = "glob-v2";
const TOOL_APPROVAL_TIMEOUT_MS = Number(
  process.env.TOOL_APPROVAL_TIMEOUT_MS || 86400000
);
let toolApprovalTimeoutMsRuntime = TOOL_APPROVAL_TIMEOUT_MS;
const LLM_JOB_RESULT_TTL_MS = Math.max(60000, Number(process.env.LLM_JOB_RESULT_TTL_MS || 86400000));
const LLM_JOB_MAX_ACTIVE = Math.max(1, Number(process.env.LLM_JOB_MAX_ACTIVE || 3));
const LLM_JOB_MAX_STORED = Math.max(10, Number(process.env.LLM_JOB_MAX_STORED || 50));
const LLM_JOB_EVENT_MAX = Math.max(100, Number(process.env.LLM_JOB_EVENT_MAX || 5000));
const LLM_JOB_SESSION_ACTIVE_POLICY = String(
  process.env.LLM_JOB_SESSION_ACTIVE_POLICY || "cancel_and_replace"
).trim().toLowerCase();
const LLM_JOB_CLIENT_REQUEST_ID_MAX_CHARS = 120;
const COMMAND_EXEC_BIN_DIR = path.resolve(
  WORKSPACE_ROOT,
  process.env.COMMAND_EXEC_BIN_DIR || "private_runner/bin"
);
const COMMAND_APPROVAL_POLICY_PATH = path.resolve(
  WORKSPACE_ROOT,
  process.env.COMMAND_APPROVAL_POLICY_PATH || "private_runner/command_approval_policy.json"
);
const DEFAULT_SANDBOXED_COMMANDS = [
  "git",
  "npm",
  "pnpm",
  "yarn",
  "node",
  "python",
  "python3",
  "npx",
  "toolrun",
  "firebase",
  "which",
  "pytest",
  "go",
  "cargo",
  "make",
  "ls",
  "cat",
  "rg",
  "sed",
  "awk",
  "head",
  "tail",
  "wc",
  "echo",
];
const SANDBOXED_RUN_ALLOWED_COMMANDS = new Set(
  String(process.env.SANDBOXED_RUN_ALLOWED_COMMANDS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
);
if (SANDBOXED_RUN_ALLOWED_COMMANDS.size === 0) {
  for (const command of DEFAULT_SANDBOXED_COMMANDS) {
    SANDBOXED_RUN_ALLOWED_COMMANDS.add(command);
  }
}
const SANDBOXED_RUN_DENY_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mv",
  "dd",
  "mkfs",
  "mount",
  "umount",
  "shutdown",
  "reboot",
  "halt",
  "sudo",
  "su",
  "chmod",
  "chown",
  "kill",
  "killall",
  "pkill",
  "ssh",
  "scp",
  "curl",
  "wget",
]);
const SANDBOXED_RUN_DEFAULT_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.SANDBOXED_RUN_DEFAULT_TIMEOUT_MS || NEAR_UNLIMITED_TIMEOUT_MS)
);
const SANDBOXED_RUN_MAX_TIMEOUT_MS = Math.max(
  SANDBOXED_RUN_DEFAULT_TIMEOUT_MS,
  Number(process.env.SANDBOXED_RUN_MAX_TIMEOUT_MS || NEAR_UNLIMITED_TIMEOUT_MS)
);
const SANDBOXED_RUN_MAX_ARGS = Math.max(1, Number(process.env.SANDBOXED_RUN_MAX_ARGS || 64));
const SANDBOXED_RUN_MAX_ARG_LENGTH = Math.max(8, Number(process.env.SANDBOXED_RUN_MAX_ARG_LENGTH || 4000));
const SANDBOXED_RUN_MAX_OUTPUT_BYTES = Math.max(1024, Number(process.env.SANDBOXED_RUN_MAX_OUTPUT_BYTES || 65536));
const SANDBOXED_RUN_AUTO_APPROVE_COMMANDS = new Set(
  String(process.env.SANDBOXED_RUN_AUTO_APPROVE_COMMANDS || "which")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
);
const TOOL_APPROVAL_CACHE_MAX_SESSIONS = Math.max(
  1,
  Number(process.env.TOOL_APPROVAL_CACHE_MAX_SESSIONS || 200)
);
const RUN_TESTS_DEFAULT_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.RUN_TESTS_DEFAULT_TIMEOUT_MS || NEAR_UNLIMITED_TIMEOUT_MS)
);
const RUN_TESTS_MAX_TIMEOUT_MS = Math.max(
  RUN_TESTS_DEFAULT_TIMEOUT_MS,
  Number(process.env.RUN_TESTS_MAX_TIMEOUT_MS || NEAR_UNLIMITED_TIMEOUT_MS)
);
const SESSION_ROOT_BINDING_ENABLED = String(process.env.SESSION_ROOT_BINDING_ENABLED || "0").trim() !== "0";
const ACP_SESSION_STORE_PATH = path.resolve(
  WORKSPACE_ROOT,
  process.env.ACP_SESSION_STORE_PATH || "private_runner/logs/acp_sessions.json"
);
const CLI_SESSION_INDEX_PATH = path.resolve(
  WORKSPACE_ROOT,
  process.env.CLI_SESSION_INDEX_PATH || "private_runner/logs/cli_sessions_index.json"
);
const CLI_SESSION_SCAN_MAX_FILES = Math.max(100, Number(process.env.CLI_SESSION_SCAN_MAX_FILES || 5000));
const SESSIONS_LIST_MAX_LIMIT = Math.max(10, Number(process.env.SESSIONS_LIST_MAX_LIMIT || 500));
const SESSIONS_LIST_DEFAULT_LIMIT = Math.max(
  1,
  Math.min(SESSIONS_LIST_MAX_LIMIT, Number(process.env.SESSIONS_LIST_DEFAULT_LIMIT || 200))
);
const SESSION_MESSAGES_MAX_LIMIT = Math.max(20, Number(process.env.SESSION_MESSAGES_MAX_LIMIT || 400));
const SESSION_MESSAGES_DEFAULT_LIMIT = Math.max(
  1,
  Math.min(SESSION_MESSAGES_MAX_LIMIT, Number(process.env.SESSION_MESSAGES_DEFAULT_LIMIT || 200))
);
const SESSION_ROLLOUT_MAX_READ_BYTES = Math.max(
  128 * 1024,
  Number(process.env.SESSION_ROLLOUT_MAX_READ_BYTES || 8 * 1024 * 1024)
);
const SESSION_SUMMARY_HEAD_MAX_READ_BYTES = Math.max(
  64 * 1024,
  Number(process.env.SESSION_SUMMARY_HEAD_MAX_READ_BYTES || 512 * 1024)
);
const SESSION_SUMMARY_TAIL_MAX_READ_BYTES = Math.max(
  64 * 1024,
  Number(process.env.SESSION_SUMMARY_TAIL_MAX_READ_BYTES || 512 * 1024)
);
let commandApprovalPolicyCache = null;
let commandApprovalPolicyCacheSignature = "";
let commandApprovalPolicyLastWarning = "";
const CLI_SESSION_INDEX_REFRESH_MIN_INTERVAL_MS = Math.max(
  500,
  Number(process.env.CLI_SESSION_INDEX_REFRESH_MIN_INTERVAL_MS || 5000)
);
let llmRequestLogInitPromise = null;
let llmRequestLogWriteQueue = Promise.resolve();
let clientAppLogInitPromise = null;
let clientAppLogWriteQueue = Promise.resolve();
let codexWsProxyDebugLogInitPromise = null;
let codexWsProxyDebugWriteQueue = Promise.resolve();
const codexWsProxyDebugBuffer = [];
let aivisSpeechBootPromise = null;
let ttsMediaDirReadyPromise = null;
let ttsMediaSweepTimer = null;
let ttsMediaSweepInFlight = false;
const ttsMediaEntries = new Map();
const toolApprovedKeysBySessionId = new Map();
const llmJobsById = new Map();
const llmJobOrder = [];
const scriptJobsById = new Map();
const scriptJobOrder = [];
const codexQueuedTurnsById = new Map();
const codexQueuedTurnOrder = [];
const codexRunningTurnByThreadId = new Map();
const codexCompactByThreadId = new Map();
const codexQueueDrainTimerByThreadId = new Map();
if (TTS_PROVIDER_RAW && TTS_PROVIDER_RAW !== TTS_PROVIDER) {
  console.warn(`[config] invalid TTS_PROVIDER=${TTS_PROVIDER_RAW}, fallback=${TTS_PROVIDER}`);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function makeApiError(status, error, message, extra = {}) {
  const err = new Error(String(message || error || "api_error"));
  err.apiStatus = Number(status) || 500;
  err.apiPayload = {
    error: String(error || "api_error"),
    ...(message ? { message: String(message) } : {}),
    ...(extra && typeof extra === "object" ? extra : {}),
  };
  return err;
}

function isApiError(err) {
  return Boolean(
    err &&
    typeof err === "object" &&
    Number.isFinite(Number(err.apiStatus)) &&
    err.apiPayload &&
    typeof err.apiPayload === "object"
  );
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function formatDateForFilename(date = new Date()) {
  const y = String(date.getFullYear()).padStart(4, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${y}${m}${d}_${hh}${mm}${ss}_${ms}`;
}

function isOpenAICodexRetryableStatus(status) {
  const code = Number(status || 0);
  return code === 408 || code === 409 || code === 425 || code === 429 || code === 500 || code === 502 || code === 503 || code === 504;
}

function isOpenAICodexRetryableMessage(message) {
  const s = String(message || "").toLowerCase();
  if (!s) return false;
  const hints = [
    "openai-codex responses failed (429)",
    "openai-codex responses failed (500)",
    "openai-codex responses failed (502)",
    "openai-codex responses failed (503)",
    "openai-codex responses failed (504)",
    "openai-codex responses returned empty body",
    "failed to parse openai-codex response payload",
    "upstream connect error",
    "connection refused",
    "remote connection failure",
    "transport failure",
    "delayed connect error",
    "fetch failed",
    "socket hang up",
    "econnreset",
    "etimedout",
    "timeout",
    "abort",
    "network",
    "temporarily unavailable",
  ];
  return hints.some((hint) => s.includes(hint));
}

function openAICodexRetryDelayMs(nextAttemptIndex) {
  const n = Math.max(1, Number(nextAttemptIndex || 1));
  const raw = OPENAI_CODEX_UPSTREAM_RETRY_BASE_MS * (2 ** (n - 1));
  const capped = Math.min(OPENAI_CODEX_UPSTREAM_RETRY_MAX_MS, raw);
  const jitter = 0.85 + Math.random() * 0.3;
  return Math.max(100, Math.round(capped * jitter));
}

async function waitForOpenAICodexRetry(reason, nextAttemptIndex, opts = {}) {
  const max = OPENAI_CODEX_UPSTREAM_MAX_RETRIES;
  const delayMs = openAICodexRetryDelayMs(nextAttemptIndex);
  if (RUNNER_LOG_REQUESTS) {
    console.warn(
      `[openai-codex] transient upstream failure: ${String(reason || "-")} (retry ${nextAttemptIndex}/${max} in ${delayMs}ms)`
    );
  }
  if (opts.signal?.aborted) return false;
  await sleep(delayMs);
  if (opts.signal?.aborted) return false;
  return true;
}

function parseAuthToken(req) {
  const h = req.headers.authorization || "";
  const [kind, token] = h.split(" ");
  if (kind !== "Bearer" || !token) return "";
  return token;
}

function buildPrompt(transcript) {
  return String(transcript || "").trim();
}

function normalizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const role = String(item?.role || "").trim().toLowerCase();
    const content = String(item?.content || "").trim();
    if (!content) return null;
    if (role !== "user" && role !== "assistant" && role !== "system") return null;
    return { role, content };
  }).filter(Boolean);
}

function buildPromptFromMessages(messages) {
  const lines = messages.map((m) => {
    if (m.role === "assistant") return `Assistant: ${m.content}`;
    if (m.role === "system") return `System: ${m.content}`;
    return `User: ${m.content}`;
  });
  return lines.join("\n");
}

function isCodexAuthErrorMessage(message) {
  const s = String(message || "").toLowerCase();
  if (!s) return false;
  const hints = [
    "codex login",
    "not logged in",
    "unauthorized",
    "authentication",
    "oauth",
    "refresh token",
    "access token",
    "token exchange",
    "token",
    "401",
    "403",
    "auth.json",
    "oauth profile",
  ];
  return hints.some((hint) => s.includes(hint));
}

function codexAuthHelp() {
  return [
    "Runner host で `codex login` を実行し、ブラウザ OAuth (Authorization Code + PKCE) を完了してください。",
    "通常は localhost callback (例: 127.0.0.1) で完了します。",
    "headless/remote などで callback を受けられない場合は、CLI が求める redirect URL か code を貼り戻して完了してください。",
    "`codex login status` でログイン状態を確認できます。",
  ];
}

function parseOpenAICodexModelRef(rawModelRef) {
  const modelRef = String(rawModelRef || "").trim();
  if (!modelRef) {
    throw new Error("OPENAI_CODEX_MODEL is required (example: openai-codex/gpt-5.4-mini)");
  }
  const hasProviderPrefix = modelRef.includes("/");
  if (!hasProviderPrefix) {
    return {
      modelRef: `${OPENAI_CODEX_PROVIDER}/${modelRef}`,
      model: modelRef,
      provider: OPENAI_CODEX_PROVIDER,
    };
  }

  const [provider, model] = modelRef.split("/", 2);
  if (provider !== OPENAI_CODEX_PROVIDER || !model) {
    throw new Error(
      `OPENAI_CODEX_MODEL must be "<model>" or "${OPENAI_CODEX_PROVIDER}/<model>" (received: ${modelRef})`
    );
  }
  return {
    modelRef: `${provider}/${model}`,
    model,
    provider,
  };
}

const OPENAI_CODEX_MODEL_INFO = parseOpenAICodexModelRef(OPENAI_CODEX_MODEL_REF);
const OPENAI_CODEX_DEFAULT_REASONING_EFFORT = normalizeReasoningEffort(OPENAI_CODEX_REASONING_EFFORT);
const OPENAI_CODEX_CONTEXT_WINDOW_TOKENS_DEFAULT = Math.max(
  1000,
  Number(process.env.OPENAI_CODEX_CONTEXT_WINDOW_TOKENS_DEFAULT || 400000)
);
const OPENAI_CODEX_MODEL_CONTEXT_WINDOW_TOKENS = {
  "gpt-5.4-mini": Math.max(
    1000,
    Number(process.env.OPENAI_CODEX_CONTEXT_WINDOW_GPT_5_4_MINI || OPENAI_CODEX_CONTEXT_WINDOW_TOKENS_DEFAULT)
  ),
  "gpt-5.4": Math.max(
    1000,
    Number(process.env.OPENAI_CODEX_CONTEXT_WINDOW_GPT_5_4 || 1050000)
  ),
  "gpt-5.3-codex": Math.max(
    1000,
    Number(process.env.OPENAI_CODEX_CONTEXT_WINDOW_GPT_5_3_CODEX || OPENAI_CODEX_CONTEXT_WINDOW_TOKENS_DEFAULT)
  ),
  "gpt-5.3-codex-spark": Math.max(
    1000,
    Number(process.env.OPENAI_CODEX_CONTEXT_WINDOW_GPT_5_3_CODEX_SPARK || 128000)
  ),
  "gpt-5-codex": Math.max(
    1000,
    Number(process.env.OPENAI_CODEX_CONTEXT_WINDOW_GPT_5_CODEX || OPENAI_CODEX_CONTEXT_WINDOW_TOKENS_DEFAULT)
  ),
  "gpt-5": Math.max(
    1000,
    Number(process.env.OPENAI_CODEX_CONTEXT_WINDOW_GPT_5 || OPENAI_CODEX_CONTEXT_WINDOW_TOKENS_DEFAULT)
  ),
  "gpt-5-chat-latest": Math.max(
    1000,
    Number(process.env.OPENAI_CODEX_CONTEXT_WINDOW_GPT_5_CHAT_LATEST || 128000)
  ),
  "gpt-5.3-chat-latest": Math.max(
    1000,
    Number(process.env.OPENAI_CODEX_CONTEXT_WINDOW_GPT_5_3_CHAT_LATEST || 128000)
  ),
};

const OPENAI_CODEX_MODEL_CONTEXT_WINDOW_MATCHERS = [
  { prefix: "gpt-5.4-mini", key: "gpt-5.4-mini" },
  { prefix: "gpt-5.4", key: "gpt-5.4" },
  { prefix: "gpt-5.3-codex-spark", key: "gpt-5.3-codex-spark" },
  { prefix: "gpt-5.3-codex", key: "gpt-5.3-codex" },
  { prefix: "gpt-5-codex", key: "gpt-5-codex" },
  { prefix: "gpt-5-chat-latest", key: "gpt-5-chat-latest" },
  { prefix: "gpt-5.3-chat-latest", key: "gpt-5.3-chat-latest" },
];

function decodeJwtPayload(token) {
  const raw = String(token || "").trim();
  const parts = raw.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function resolveClientId(tokens = {}) {
  const accessPayload = decodeJwtPayload(tokens.access_token);
  if (typeof accessPayload?.client_id === "string" && accessPayload.client_id) {
    return accessPayload.client_id;
  }
  const idPayload = decodeJwtPayload(tokens.id_token);
  const aud = idPayload?.aud;
  if (Array.isArray(aud) && typeof aud[0] === "string" && aud[0]) {
    return aud[0];
  }
  if (typeof aud === "string" && aud) {
    return aud;
  }
  return "";
}

function resolveAccountId(tokens = {}) {
  if (tokens.account_id) return String(tokens.account_id);
  const accessPayload = decodeJwtPayload(tokens.access_token);
  const auth = accessPayload?.["https://api.openai.com/auth"];
  if (auth && typeof auth === "object" && typeof auth.chatgpt_account_id === "string") {
    return auth.chatgpt_account_id;
  }
  return "";
}

function isTokenExpiringSoon(accessToken, skewSec = OPENAI_CODEX_TOKEN_REFRESH_SKEW_SEC) {
  const payload = decodeJwtPayload(accessToken);
  const exp = Number(payload?.exp || 0);
  if (!exp) return true;
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec >= exp - Math.max(30, Number(skewSec) || 0);
}

async function readOAuthAuthJson() {
  let raw;
  try {
    raw = await fs.readFile(CODEX_AUTH_PATH, "utf8");
  } catch (err) {
    throw new Error(
      `OAuth profile is missing. run 'codex login' with CODEX_HOME=${CODEX_HOME} (${err instanceof Error ? err.message : String(err)})`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`auth.json is invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parsed;
}

function resolveOAuthProfileRecord(authJson, profileName = OPENAI_CODEX_OAUTH_PROFILE) {
  const normalized = String(profileName || "default").trim();
  if (authJson?.profiles && typeof authJson.profiles === "object") {
    const profileKey = normalized || "default";
    const record = authJson.profiles[profileKey];
    if (!record || typeof record !== "object") {
      throw new Error(`OAuth profile not found in auth.json: ${profileKey}`);
    }
    return {
      key: profileKey,
      record,
      setRecord(nextRecord) {
        authJson.profiles[profileKey] = nextRecord;
      },
    };
  }
  return {
    key: normalized || "default",
    record: authJson,
    setRecord(nextRecord) {
      Object.keys(authJson).forEach((k) => delete authJson[k]);
      Object.assign(authJson, nextRecord);
    },
  };
}

let oauthRefreshInFlight = null;

async function refreshOAuthTokens({ force = false } = {}) {
  if (oauthRefreshInFlight) return oauthRefreshInFlight;
  oauthRefreshInFlight = (async () => {
    const authJson = await readOAuthAuthJson();
    const profile = resolveOAuthProfileRecord(authJson);
    const currentRecord = profile.record && typeof profile.record === "object" ? profile.record : {};
    const currentTokens = currentRecord.tokens && typeof currentRecord.tokens === "object"
      ? currentRecord.tokens
      : {};
    const refreshToken = String(currentTokens.refresh_token || "").trim();
    if (!refreshToken) {
      throw new Error("refresh_token is missing in OAuth profile");
    }

    if (!force && !isTokenExpiringSoon(currentTokens.access_token)) {
      const accountId = resolveAccountId(currentTokens);
      if (!accountId) {
        throw new Error("chatgpt account id is missing in OAuth profile");
      }
      return {
        accessToken: String(currentTokens.access_token || ""),
        accountId,
      };
    }

    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", refreshToken);
    const clientId = resolveClientId(currentTokens);
    if (clientId) {
      body.set("client_id", clientId);
    }

    const response = await fetch(OPENAI_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const raw = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(`oauth token refresh failed (${response.status}): ${raw}`);
    }

    let tokenResult;
    try {
      tokenResult = JSON.parse(raw);
    } catch {
      throw new Error("oauth token refresh returned non-JSON response");
    }

    const nextTokens = {
      ...currentTokens,
      access_token: String(tokenResult?.access_token || ""),
      refresh_token: String(tokenResult?.refresh_token || refreshToken),
      id_token: String(tokenResult?.id_token || currentTokens.id_token || ""),
      account_id: String(currentTokens.account_id || ""),
    };

    if (!nextTokens.access_token) {
      throw new Error("oauth token refresh returned empty access_token");
    }
    nextTokens.account_id = resolveAccountId(nextTokens);
    if (!nextTokens.account_id) {
      throw new Error("oauth token refresh returned token without chatgpt_account_id");
    }

    const nextRecord = {
      ...currentRecord,
      tokens: nextTokens,
      last_refresh: new Date().toISOString(),
    };
    profile.setRecord(nextRecord);
    if (authJson === profile.record) {
      authJson.last_refresh = nextRecord.last_refresh;
    }
    await fs.writeFile(CODEX_AUTH_PATH, `${JSON.stringify(authJson, null, 2)}\n`, "utf8");

    return {
      accessToken: nextTokens.access_token,
      accountId: nextTokens.account_id,
    };
  })();

  try {
    return await oauthRefreshInFlight;
  } finally {
    oauthRefreshInFlight = null;
  }
}

function normalizeReasoningEffort(raw, opts = {}) {
  const warnInvalid = opts.warnInvalid !== false;
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  if (value === "minimal") return "low";
  if (value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  if (warnInvalid) {
    console.warn(`[config] invalid OPENAI_CODEX_REASONING_EFFORT=${value}, ignored`);
  }
  return "";
}

function resolveCodexRequestOptions(rawModelRef, rawReasoningEffort) {
  const modelRefInput = String(rawModelRef || "").trim();
  const modelInfo = modelRefInput ? parseOpenAICodexModelRef(modelRefInput) : OPENAI_CODEX_MODEL_INFO;
  const reasoningInput = String(rawReasoningEffort || "").trim();
  if (!reasoningInput) {
    return {
      modelInfo,
      reasoningEffort: OPENAI_CODEX_DEFAULT_REASONING_EFFORT,
    };
  }
  const normalizedReasoning = normalizeReasoningEffort(reasoningInput, { warnInvalid: false });
  if (!normalizedReasoning) {
    throw new Error("reasoningEffort must be one of: none, low, medium, high, xhigh");
  }
  return {
    modelInfo,
    reasoningEffort: normalizedReasoning,
  };
}

function normalizeReplyExecutionRequest(raw) {
  const body = raw && typeof raw === "object" ? raw : {};
  const transcript = String(body.transcript || "").trim();
  const systemPrompt = "";
  const directory = String(body.directory || "").trim();
  const rootDir = directory || String(body.rootDir || "").trim();
  const sessionId = normalizeLlmExecutionSessionId(body.sessionId);
  const messages = normalizeMessages(body.messages);

  let codexOptions;
  try {
    codexOptions = resolveCodexRequestOptions(body.modelRef, body.reasoningEffort);
  } catch (err) {
    throw makeApiError(400, "invalid_llm_option", errorMessage(err));
  }

  if (!transcript && messages.length === 0) {
    throw makeApiError(400, "transcript_required");
  }
  const totalMessageChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalMessageChars > MAX_MESSAGES_TOTAL_CHARS) {
    throw makeApiError(400, "messages_too_long", "", { max: MAX_MESSAGES_TOTAL_CHARS });
  }
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    throw makeApiError(400, "transcript_too_long", "", { max: MAX_TRANSCRIPT_CHARS });
  }

  return {
    transcript,
    systemPrompt,
    rootDir,
    sessionId,
    messages,
    codexOptions,
  };
}

function normalizeLlmExecutionSessionId(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value.length > LLM_EXECUTION_SESSION_ID_MAX_CHARS) {
    throw makeApiError(400, "invalid_session_id", "", {
      max: LLM_EXECUTION_SESSION_ID_MAX_CHARS,
    });
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw makeApiError(400, "invalid_session_id", "sessionId contains unsupported characters");
  }
  return value;
}

function generateLlmExecutionSessionId(date = new Date()) {
  const dateMs = Number(date instanceof Date ? date.getTime() : Date.now());
  const safeMs = Number.isFinite(dateMs) && dateMs > 0 ? Math.floor(dateMs) : Date.now();
  const tsHex = safeMs.toString(16).padStart(12, "0").slice(-12);
  const randomHex = randomBytes(10).toString("hex");
  const randPart1 = randomHex.slice(0, 3);
  const randPart2Raw = Number.parseInt(randomHex.slice(3, 7), 16);
  const randPart2 = ((Number.isFinite(randPart2Raw) ? randPart2Raw : 0) & 0x3fff) | 0x8000;
  const randPart3 = randomHex.slice(7, 19).padEnd(12, "0");
  return `${tsHex.slice(0, 8)}-${tsHex.slice(8, 12)}-7${randPart1}-${randPart2
    .toString(16)
    .padStart(4, "0")}-${randPart3}`;
}

function normalizeSessionRootRelativePath(rawRootRelativePath) {
  const value = toUnixPath(String(rawRootRelativePath || "").trim());
  return value || ".";
}

function normalizeSessionUpdatedAt(rawUpdatedAt) {
  const value = String(rawUpdatedAt || "").trim();
  if (!value) return "";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString();
}

const {
  bindSessionToRootDir,
  getAcpSessionStoreStats,
  listAcpSessionsForDirectory,
  markAcpSessionRead,
  resolveSessionIdForRootDir,
} = createLlmAcpSessionStore({
  acpSessionStorePath: ACP_SESSION_STORE_PATH,
  compareSessionHistoryEntries,
  generateLlmExecutionSessionId,
  makeApiError,
  normalizeLlmExecutionSessionId,
  normalizeSessionRootRelativePath,
  normalizeSessionUpdatedAt,
  sessionRootBindingEnabled: SESSION_ROOT_BINDING_ENABLED,
  workspaceRoot: WORKSPACE_ROOT,
});

function normalizeSessionSource(rawSource, fallback = "all") {
  const value = String(rawSource || "").trim().toLowerCase();
  if (value === "acp" || value === "cli" || value === "all") return value;
  return fallback;
}

function normalizeSessionListLimit(rawLimit) {
  const value = String(rawLimit ?? "").trim();
  if (!value) return SESSIONS_LIST_DEFAULT_LIMIT;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw makeApiError(400, "invalid_limit", "limit must be a positive integer", {
      max: SESSIONS_LIST_MAX_LIMIT,
    });
  }
  return Math.min(SESSIONS_LIST_MAX_LIMIT, n);
}

const {
  buildTokenCountPayloadFromContextUsage,
  normalizeSessionMessagesLimit,
  readCliSessionSummaryFromRolloutFile,
  readSessionContextUsageFromRolloutFile,
  readSessionMetaFromRolloutFile,
  readSessionMessagesFromRolloutFile,
} = createLlmSessionRolloutReaders({
  makeApiError,
  normalizeReasoningEffort,
  normalizeSessionUpdatedAt,
  normalizeTokenCount,
  parseOpenAICodexModelRef,
  sessionMessagesDefaultLimit: SESSION_MESSAGES_DEFAULT_LIMIT,
  sessionMessagesMaxLimit: SESSION_MESSAGES_MAX_LIMIT,
  sessionRolloutMaxReadBytes: SESSION_ROLLOUT_MAX_READ_BYTES,
  sessionSummaryHeadMaxReadBytes: SESSION_SUMMARY_HEAD_MAX_READ_BYTES,
  sessionSummaryTailMaxReadBytes: SESSION_SUMMARY_TAIL_MAX_READ_BYTES,
});

function toDirectoryHandlePath(workspaceReal, targetReal) {
  const relRaw = path.relative(workspaceReal, targetReal);
  const rel = toUnixPath(relRaw);
  if (!rel) return ".";
  if (rel === ".." || rel.startsWith("../")) {
    return toUnixPath(path.resolve(targetReal)) || "/";
  }
  return rel;
}

function toWorkspaceRelativeFromAbsolutePath(rawAbsolutePath) {
  const absolutePath = path.resolve(String(rawAbsolutePath || "").trim());
  if (!absolutePath) return "";
  const relativeRaw = path.relative(WORKSPACE_ROOT, absolutePath);
  if (relativeRaw === "") return ".";
  const relativePath = toUnixPath(relativeRaw);
  if (!relativePath || relativePath.startsWith("../") || relativePath === "..") {
    return "";
  }
  return normalizeSessionRootRelativePath(relativePath);
}

async function listLlmDirectories(rawPath) {
  const requestedPath = String(rawPath || "").trim() || DEFAULT_LLM_FILE_ROOT_RELATIVE;
  let resolved = null;
  try {
    resolved = await resolveToolRoot(requestedPath, { create: false });
  } catch (err) {
    const code = String(err?.code || "").toUpperCase();
    if (code === "ENOENT") {
      throw makeApiError(404, "directory_not_found", "directory not found");
    }
    throw err;
  }
  const rootAbs = path.parse(resolved.rootReal).root || path.sep;
  let rootReal = rootAbs;
  try {
    rootReal = await fs.realpath(rootAbs);
  } catch {}
  const explorerRoot = {
    rootReal,
    relativeRoot: toDirectoryHandlePath(resolved.workspaceReal, rootReal),
  };
  let dirEntries = [];
  try {
    dirEntries = await fs.readdir(resolved.rootReal, { withFileTypes: true });
  } catch (err) {
    throw makeApiError(500, "directory_list_failed", errorMessage(err));
  }
  const directories = [];
  const files = [];
  for (const entry of dirEntries) {
    if (entry.name.startsWith(".") && entry.name !== ".agents") continue;
    const childAbs = path.join(resolved.rootReal, entry.name);
    if (entry.isDirectory()) {
      if (LLM_FILE_SKIP_SCAN_DIRS.has(entry.name)) continue;
      let childReal = childAbs;
      try {
        childReal = await fs.realpath(childAbs);
      } catch {
        continue;
      }
      directories.push({
        name: entry.name,
        path: toDirectoryHandlePath(resolved.workspaceReal, childReal),
      });
      continue;
    }
    if (!entry.isFile()) continue;
    files.push({
      name: entry.name,
      path: toDirectoryHandlePath(resolved.workspaceReal, childAbs),
    });
  }
  directories.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  const limitedDirectories = directories.slice(0, Math.max(1, DIRECTORY_EXPLORER_MAX_ENTRIES));
  const limitedFiles = files.slice(0, Math.max(1, DIRECTORY_EXPLORER_MAX_ENTRIES));
  const entries = [
    ...limitedDirectories.map((item) => ({
      ...item,
      kind: "dir",
    })),
    ...limitedFiles.map((item) => ({
      ...item,
      kind: "file",
    })),
  ];
  let parentPath = "";
  if (resolved.rootReal !== explorerRoot.rootReal) {
    const parentAbs = path.dirname(resolved.rootReal);
    let parentReal = parentAbs;
    try {
      parentReal = await fs.realpath(parentAbs);
    } catch {}
    parentPath = toDirectoryHandlePath(resolved.workspaceReal, parentReal);
  }
  return {
    basePath: resolved.relativeRoot,
    parentPath,
    rootPath: explorerRoot.relativeRoot,
    directories: limitedDirectories,
    files: limitedFiles,
    entries,
    truncated: (
      directories.length > limitedDirectories.length ||
      files.length > limitedFiles.length
    ),
    maxEntries: Math.max(1, DIRECTORY_EXPLORER_MAX_ENTRIES),
  };
}

function compareSessionHistoryEntries(a, b) {
  const aUpdatedAt = normalizeSessionUpdatedAt(a?.updatedAt) || new Date(0).toISOString();
  const bUpdatedAt = normalizeSessionUpdatedAt(b?.updatedAt) || new Date(0).toISOString();
  if (aUpdatedAt !== bUpdatedAt) return bUpdatedAt.localeCompare(aUpdatedAt);
  const aSource = String(a?.source || "").trim();
  const bSource = String(b?.source || "").trim();
  if (aSource !== bSource) return aSource.localeCompare(bSource);
  return String(b?.sessionId || "").localeCompare(String(a?.sessionId || ""));
}

const {
  ensureCliSessionIndexLoaded,
  findCliSessionIndexEntryBySessionId,
  getCliSessionIndexStats,
  listCliSessionsForDirectory,
  markCliSessionRead,
  resolveCliSessionEntryDirectory,
  selectCliSessionIndexEntryBySessionId,
  upsertCliSessionIndexEntryFromRolloutFile,
} = createLlmCliSessionIndex({
  cliSessionIndexPath: CLI_SESSION_INDEX_PATH,
  cliSessionIndexRefreshMinIntervalMs: CLI_SESSION_INDEX_REFRESH_MIN_INTERVAL_MS,
  cliSessionScanMaxFiles: CLI_SESSION_SCAN_MAX_FILES,
  codeCliSessionsDir: CODEX_CLI_SESSIONS_DIR,
  compareSessionHistoryEntries,
  normalizeLlmExecutionSessionId,
  normalizeReasoningEffort,
  normalizeSessionRootRelativePath,
  normalizeSessionUpdatedAt,
  toUnixPath,
  toWorkspaceRelativeFromAbsolutePath,
});

async function listLlmSessions(rawDirectory, opts = {}) {
  const requestedDirectory = normalizeSessionRootRelativePath(rawDirectory || DEFAULT_LLM_FILE_ROOT_RELATIVE);
  const source = normalizeSessionSource(opts?.source, "acp");
  const limit = normalizeSessionListLimit(opts?.limit);
  const sessions = [];
  if (source === "acp" || source === "all") {
    sessions.push(...await listAcpSessionsForDirectory(requestedDirectory));
  }
  if (source === "cli" || source === "all") {
    sessions.push(...await listCliSessionsForDirectory(requestedDirectory));
  }
  sessions.sort(compareSessionHistoryEntries);
  const limited = sessions.slice(0, limit);
  const enriched = [];
  for (const item of limited) {
    const sourceName = String(item?.source || "").trim().toLowerCase();
    const filePath = String(item?.filePath || "").trim();
    if (sourceName === "cli" && filePath) {
      let summary = {
        firstUserMessage: "",
        contextUsage: null,
        modelRef: "",
        reasoningEffort: "",
      };
      try {
        summary = await readCliSessionSummaryFromRolloutFile(filePath);
      } catch {
        summary = {
          firstUserMessage: "",
          contextUsage: null,
          modelRef: "",
          reasoningEffort: "",
        };
      }
      enriched.push({
        ...item,
        firstUserMessage: String(summary.firstUserMessage || "").trim(),
        contextUsage: summary.contextUsage || null,
        modelRef: String(summary.modelRef || "").trim(),
        reasoningEffort: String(summary.reasoningEffort || "").trim(),
      });
      continue;
    }
    enriched.push({
      ...item,
      firstUserMessage: "",
      contextUsage: null,
      modelRef: "",
      reasoningEffort: "",
    });
  }
  const serializedSessions = enriched.map((item) => {
    const cloned = { ...item };
    delete cloned.filePath;
    return cloned;
  });
  const latestSessionId = limited.length > 0
    ? String(limited[0]?.sessionId || "").trim()
    : "";
  return {
    directory: requestedDirectory,
    source,
    limit,
    latestSessionId,
    sessions: serializedSessions,
  };
}

async function markLlmSessionRead(rawSessionId, opts = {}) {
  const startedAtMs = Date.now();
  const sessionId = normalizeLlmExecutionSessionId(rawSessionId);
  if (!sessionId) {
    throw makeApiError(400, "invalid_session_id", "sessionId is required");
  }
  const directory = normalizeSessionRootRelativePath(opts?.directory || DEFAULT_LLM_FILE_ROOT_RELATIVE);
  const source = normalizeSessionSource(opts?.source, "all");
  const lastReadAt = normalizeSessionUpdatedAt(opts?.lastReadAt) || new Date().toISOString();
  let acpUpdated = false;
  let cliUpdated = false;
  let acpPhaseMs = 0;
  let cliLookupMs = 0;
  let cliRewriteMs = 0;
  let cliPersistMs = 0;
  let cliEntryFound = false;

  if (source === "acp" || source === "all") {
    const acpResult = await markAcpSessionRead(sessionId, lastReadAt);
    acpUpdated = Boolean(acpResult?.updated);
    acpPhaseMs = Math.max(0, Number(acpResult?.elapsedMs || 0));
  }

  if (source === "cli" || source === "all") {
    const cliResult = await markCliSessionRead(sessionId, { directory, lastReadAt });
    cliUpdated = Boolean(cliResult?.updated);
    cliLookupMs = Math.max(0, Number(cliResult?.lookupMs || 0));
    cliRewriteMs = Math.max(0, Number(cliResult?.rewriteMs || 0));
    cliPersistMs = Math.max(0, Number(cliResult?.persistMs || 0));
    cliEntryFound = Boolean(cliResult?.entryFound);
  }

  return {
    sessionId,
    directory,
    source,
    lastReadAt,
    updated: acpUpdated || cliUpdated,
    acpUpdated,
    cliUpdated,
    diagnostics: {
      totalMs: Math.max(0, Date.now() - startedAtMs),
      acpPhaseMs,
      cliLookupMs,
      cliRewriteMs,
      cliPersistMs,
      cliEntryFound,
    },
  };
}

const {
  appendAppConversationToCliRollout,
} = createLlmCliRolloutWriter({
  buildTokenCountPayloadFromContextUsage,
  cliSessionMetaOriginator: CLI_SESSION_META_ORIGINATOR,
  cliSessionMetaSource: CLI_SESSION_META_SOURCE,
  cliSessionMetaVersion: CLI_SESSION_META_VERSION,
  codeCliSessionsDir: CODEX_CLI_SESSIONS_DIR,
  ensureCliSessionIndexLoaded,
  normalizeLlmExecutionSessionId,
  normalizeReasoningEffort,
  normalizeSessionRootRelativePath,
  normalizeSessionUpdatedAt,
  selectCliSessionIndexEntryBySessionId,
  toWorkspaceRelativeFromAbsolutePath,
  upsertCliSessionIndexEntryFromRolloutFile,
  workspaceRoot: WORKSPACE_ROOT,
});

async function listLlmSessionMessages(rawSessionId, opts = {}) {
  const startedAt = Date.now();
  const sessionId = normalizeLlmExecutionSessionId(rawSessionId);
  if (!sessionId) {
    throw makeApiError(400, "invalid_session_id", "sessionId is required");
  }
  const source = normalizeSessionSource(opts?.source, "all");
  const limit = (
    opts?.limit === null || Number.isFinite(Number(opts?.limit))
  )
    ? (opts?.limit === null ? null : normalizeSessionMessagesLimit(opts?.limit))
    : normalizeSessionMessagesLimit(opts?.limit);
  const directoryRaw = String(opts?.directory || "").trim();
  const requestedDirectory = directoryRaw ? normalizeSessionRootRelativePath(directoryRaw) : "";

  const shouldCheckCli = source === "cli" || source === "acp" || source === "all";
  let cliEntry = null;
  const cliLookupStartedAt = Date.now();
  if (shouldCheckCli) {
    cliEntry = await findCliSessionIndexEntryBySessionId(sessionId, { directory: requestedDirectory });
  }
  const cliLookupMs = Math.max(0, Date.now() - cliLookupStartedAt);
  if (!cliEntry) {
    return {
      sessionId,
      source,
      directory: requestedDirectory || "",
      cwd: "",
      updatedAt: "",
      found: false,
      limit: limit === null ? "all" : limit,
      messages: [],
      contextUsage: null,
      modelRef: "",
      reasoningEffort: "",
      diagnostics: {
        totalMs: Math.max(0, Date.now() - startedAt),
        cliLookupMs,
      },
    };
  }
  const readParallelStartedAt = Date.now();
  const messagesPromise = (async () => {
    const t0 = Date.now();
    const result = await readSessionMessagesFromRolloutFile(cliEntry.filePath, { limit });
    return { result, elapsedMs: Math.max(0, Date.now() - t0) };
  })();
  const contextPromise = (async () => {
    const t0 = Date.now();
    const result = await readSessionContextUsageFromRolloutFile(cliEntry.filePath);
    return { result, elapsedMs: Math.max(0, Date.now() - t0) };
  })();
  const metaPromise = (async () => {
    const t0 = Date.now();
    const result = await readSessionMetaFromRolloutFile(cliEntry.filePath);
    return { result, elapsedMs: Math.max(0, Date.now() - t0) };
  })();
  const [messagesTimed, contextTimed, metaTimed] = await Promise.all([
    messagesPromise,
    contextPromise,
    metaPromise,
  ]);
  const readParallelMs = Math.max(0, Date.now() - readParallelStartedAt);
  const messagesResult = messagesTimed.result;
  const contextUsage = contextTimed.result;
  const meta = metaTimed.result;
  const messages = Array.isArray(messagesResult?.messages) ? messagesResult.messages : [];
  const messageDiagnostics = messagesResult?.diagnostics && typeof messagesResult.diagnostics === "object"
    ? messagesResult.diagnostics
    : null;
  const diagnostics = {
    ...(messageDiagnostics || {}),
    cliLookupMs,
    messagesReadMs: messagesTimed.elapsedMs,
    contextUsageReadMs: contextTimed.elapsedMs,
    metaReadMs: metaTimed.elapsedMs,
    readParallelMs,
    totalMs: Math.max(0, Date.now() - startedAt),
    messageCount: messages.length,
  };
  return {
    sessionId,
    source: "cli",
    directory: resolveCliSessionEntryDirectory(cliEntry),
    cwd: String(cliEntry.cwd || ""),
    updatedAt: normalizeSessionUpdatedAt(cliEntry.updatedAt) || "",
    found: true,
    limit: limit === null ? "all" : limit,
    messages,
    contextUsage: contextUsage || null,
    modelRef: String(meta?.modelRef || "").trim(),
    reasoningEffort: String(meta?.reasoningEffort || "").trim(),
    diagnostics,
  };
}

function splitPseudoTextDeltas(text) {
  const source = String(text || "");
  const chunks = [];
  let buf = "";
  for (const ch of source) {
    buf += ch;
    if (isTtsBoundaryChar(ch) || buf.length >= 18) {
      chunks.push(buf);
      buf = "";
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function buildOpenAICodexResponseRequest(prompt, opts = {}) {
  const modelInfo = opts.modelInfo || OPENAI_CODEX_MODEL_INFO;
  const reasoningEffort = String(opts.reasoningEffort || OPENAI_CODEX_DEFAULT_REASONING_EFFORT || "").trim();
  const body = {
    model: modelInfo.model,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: String(prompt || ""),
          },
        ],
      },
    ],
    store: false,
    stream: true,
  };
  body.instructions = resolveOpenAICodexInstructions();
  const effort = normalizeReasoningEffort(reasoningEffort, { warnInvalid: false });
  if (effort) {
    body.reasoning = { effort };
  }
  return body;
}

function resolveOpenAICodexInstructions(...candidates) {
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (normalized) return normalized;
  }
  if (OPENAI_CODEX_INSTRUCTIONS) return OPENAI_CODEX_INSTRUCTIONS;
  return OPENAI_CODEX_INSTRUCTIONS_FALLBACK;
}

function extractOpenAICodexCompletedText(event) {
  if (event?.type !== "response.completed") return "";
  const output = Array.isArray(event?.response?.output) ? event.response.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string" && c.text) {
        return c.text;
      }
    }
  }
  return "";
}

function parseSseEventBlock(block) {
  const lines = String(block || "").split(/\r?\n/);
  let eventName = "";
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  const data = dataLines.join("\n").trim();
  return { eventName, data };
}

async function runCodexStream(prompt, opts = {}) {
  const onText = typeof opts.onText === "function" ? opts.onText : null;
  const onMode = typeof opts.onMode === "function" ? opts.onMode : null;
  const externalSignal = opts.signal;
  const modelInfo = opts.modelInfo || OPENAI_CODEX_MODEL_INFO;
  const reasoningEffort = String(opts.reasoningEffort || OPENAI_CODEX_DEFAULT_REASONING_EFFORT || "").trim();

  const payload = buildOpenAICodexResponseRequest(prompt, {
    modelInfo,
    reasoningEffort,
  });
  let streamedReply = "";
  let completedReply = "";
  let seenDelta = false;
  let modeSent = false;
  let done = false;
  let triedAuthRefresh = false;
  let upstreamRetryCount = 0;

  while (true) {
    const auth = await refreshOAuthTokens({ force: triedAuthRefresh });
    const requestId = randomUUID();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPENAI_CODEX_TIMEOUT_MS);
    const abortHandler = () => controller.abort();
    if (externalSignal) externalSignal.addEventListener("abort", abortHandler);

    try {
      const response = await fetch(`${OPENAI_CODEX_RESPONSES_BASE_URL}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          "chatgpt-account-id": auth.accountId,
          "content-type": "application/json",
          accept: "text/event-stream",
          originator: OPENAI_CODEX_ORIGINATOR,
          version: OPENAI_CODEX_VERSION,
          "x-client-request-id": requestId,
          "x-openai-codex-route": OPENAI_CODEX_ROUTE,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        const status = Number(response.status || 0);
        if (!triedAuthRefresh && (status === 401 || status === 403)) {
          triedAuthRefresh = true;
          continue;
        }
        if (
          isOpenAICodexRetryableStatus(status) &&
          upstreamRetryCount < OPENAI_CODEX_UPSTREAM_MAX_RETRIES
        ) {
          upstreamRetryCount += 1;
          const keepGoing = await waitForOpenAICodexRetry(`status=${status}`, upstreamRetryCount, {
            signal: externalSignal,
          });
          if (!keepGoing) {
            throw new Error("openai-codex retry aborted");
          }
          continue;
        }
        throw new Error(`openai-codex responses failed (${status}): ${bodyText}`);
      }
      if (!response.body) {
        throw new Error("openai-codex responses returned empty stream");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        sseBuffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

        while (true) {
          const splitAt = sseBuffer.indexOf("\n\n");
          if (splitAt < 0) break;
          const block = sseBuffer.slice(0, splitAt);
          sseBuffer = sseBuffer.slice(splitAt + 2);
          const parsed = parseSseEventBlock(block);
          if (!parsed.data || parsed.data === "[DONE]") {
            done = true;
            continue;
          }

          let event;
          try {
            event = JSON.parse(parsed.data);
          } catch {
            continue;
          }

          if (event?.type === "response.output_text.delta" && typeof event?.delta === "string") {
            seenDelta = true;
            if (!modeSent && onMode) {
              onMode("native_delta");
              modeSent = true;
            }
            streamedReply += event.delta;
            if (onText) onText(event.delta, "native");
            continue;
          }

          if (event?.type === "response.completed") {
            done = true;
            const completedText = extractOpenAICodexCompletedText(event);
            if (completedText) completedReply = completedText;
          }
        }
      }

      if (sseBuffer.trim()) {
        const parsed = parseSseEventBlock(sseBuffer.trim());
        if (parsed.data && parsed.data !== "[DONE]") {
          try {
            const event = JSON.parse(parsed.data);
            if (event?.type === "response.output_text.delta" && typeof event?.delta === "string") {
              seenDelta = true;
              if (!modeSent && onMode) {
                onMode("native_delta");
                modeSent = true;
              }
              streamedReply += event.delta;
              if (onText) onText(event.delta, "native");
            }
            if (event?.type === "response.completed") {
              done = true;
              const completedText = extractOpenAICodexCompletedText(event);
              if (completedText) completedReply = completedText;
            }
          } catch {}
        }
      }

      break;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!triedAuthRefresh && isCodexAuthErrorMessage(errMsg)) {
        triedAuthRefresh = true;
        continue;
      }
      if (
        !externalSignal?.aborted &&
        isOpenAICodexRetryableMessage(errMsg) &&
        upstreamRetryCount < OPENAI_CODEX_UPSTREAM_MAX_RETRIES
      ) {
        upstreamRetryCount += 1;
        const keepGoing = await waitForOpenAICodexRetry(errMsg, upstreamRetryCount, {
          signal: externalSignal,
        });
        if (!keepGoing) {
          throw new Error("openai-codex retry aborted");
        }
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener("abort", abortHandler);
    }
  }

  if (!seenDelta && completedReply && onText) {
    if (!modeSent && onMode) {
      onMode("pseudo_delta");
      modeSent = true;
    }
    const pseudoChunks = splitPseudoTextDeltas(completedReply);
    for (const chunk of pseudoChunks) {
      streamedReply += chunk;
      onText(chunk, "pseudo");
      await sleep(12);
    }
  }

  const reply = String(streamedReply || completedReply || "").trim();
  if (!done && !reply) {
    throw new Error("openai-codex stream did not complete");
  }
  if (!reply) {
    throw new Error("openai-codex returned empty response");
  }
  return reply;
}

async function runCodex(prompt, opts = {}) {
  return runCodexStream(prompt, opts);
}

function normalizeSttLanguage(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  return value.split(/[-_]/)[0];
}

async function runGroqStt(audioBuffer, opts = {}) {
  const mimeType = opts.mimeType || "audio/m4a";
  const fileName = opts.fileName || "recording.m4a";
  const language = normalizeSttLanguage(opts.language);

  const form = new FormData();
  form.set("model", GROQ_STT_MODEL);
  form.set("file", new Blob([audioBuffer], { type: mimeType }), fileName);
  if (language) {
    form.set("language", language);
  }

  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => {
    timeoutController.abort();
  }, GROQ_STT_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${GROQ_API_BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${GROQ_API_KEY}`,
      },
      signal: timeoutController.signal,
      body: form,
    });
  } catch (err) {
    const isAbort = String(err?.name || "").toLowerCase() === "aborterror";
    if (isAbort) {
      throw new Error(`groq stt timeout (${GROQ_STT_TIMEOUT_MS}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutTimer);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(`groq stt failed (${response.status}): ${bodyText}`);
  }

  const data = await response.json();
  const text = String(data?.text || "").trim();
  if (!text) {
    throw new Error("groq stt returned empty transcript");
  }
  return text;
}

function elevenOutputFormatToMimeType(outputFormat) {
  const value = String(outputFormat || "").toLowerCase();
  if (value.startsWith("mp3_")) return "audio/mpeg";
  if (value.startsWith("wav_")) return "audio/wav";
  if (value.startsWith("ogg_")) return "audio/ogg";
  if (value.startsWith("pcm_")) return "audio/pcm";
  return "application/octet-stream";
}

function googleAudioEncodingToMimeType(audioEncoding) {
  const value = String(audioEncoding || "").toUpperCase();
  if (value === "MP3") return "audio/mpeg";
  if (value === "LINEAR16") return "audio/wav";
  if (value === "OGG_OPUS") return "audio/ogg";
  if (value === "MULAW") return "audio/basic";
  if (value === "ALAW") return "audio/basic";
  return "application/octet-stream";
}

function resolveTtsProvider(rawProvider) {
  const v = String(rawProvider || "").trim().toLowerCase();
  if (!v) return TTS_PROVIDER;
  return v;
}

function isSupportedTtsProvider(provider) {
  return SUPPORTED_TTS_PROVIDERS.has(provider);
}

function ensureAivisSpeechLocalMode() {
  let apiBaseUrl;
  try {
    apiBaseUrl = new URL(AIVISSPEECH_API_BASE_URL);
  } catch {
    throw new Error("AIVISSPEECH_API_BASE_URL must be a valid URL");
  }
  const hostname = apiBaseUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (process.platform !== "darwin") {
    throw new Error("aivisspeech is only supported on macOS in this runner");
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error("AIVISSPEECH_API_BASE_URL must point to localhost in local-mac mode");
  }
  return apiBaseUrl;
}

async function launchAivisSpeechAppFront() {
  await fs.access(AIVISSPEECH_APP_PATH);
  await new Promise((resolve, reject) => {
    const child = spawn("open", ["-a", AIVISSPEECH_APP_PATH], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      if (stdout.length >= 500) return;
      stdout += String(chunk || "").slice(0, 500 - stdout.length);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length >= 800) return;
      stderr += String(chunk || "").slice(0, 800 - stderr.length);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join(" | ");
      reject(new Error(`open -a failed (code=${String(code)})${detail ? `: ${detail}` : ""}`));
    });
  });
}

async function probeAivisSpeechReady(apiBaseUrl, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(300, Number(timeoutMs) || 1500));
  try {
    const response = await fetch(new URL("/speakers", apiBaseUrl), {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForAivisSpeechReady(apiBaseUrl, timeoutMs = AIVISSPEECH_READY_TIMEOUT_MS) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || AIVISSPEECH_READY_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (await probeAivisSpeechReady(apiBaseUrl, 1200)) {
      return true;
    }
    await sleep(AIVISSPEECH_READY_POLL_MS);
  }
  return false;
}

async function ensureAivisSpeechReady() {
  const apiBaseUrl = ensureAivisSpeechLocalMode();
  if (await probeAivisSpeechReady(apiBaseUrl, 1000)) {
    return apiBaseUrl;
  }

  if (!aivisSpeechBootPromise) {
    aivisSpeechBootPromise = (async () => {
      try {
        await launchAivisSpeechAppFront();
      } catch (err) {
        throw makeApiError(
          503,
          "aivisspeech_launch_failed",
          `failed to launch AivisSpeech app at ${AIVISSPEECH_APP_PATH}: ${errorMessage(err)}`
        );
      }

      const ready = await waitForAivisSpeechReady(apiBaseUrl, AIVISSPEECH_READY_TIMEOUT_MS);
      if (!ready) {
        throw makeApiError(
          503,
          "aivisspeech_not_ready",
          `AivisSpeech is not ready after ${AIVISSPEECH_READY_TIMEOUT_MS}ms (${String(apiBaseUrl)})`
        );
      }
    })().finally(() => {
      aivisSpeechBootPromise = null;
    });
  }

  await aivisSpeechBootPromise;
  return apiBaseUrl;
}

function normalizeAivisSpeechSpeakerId(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const speakerId = Number(value);
  if (!Number.isInteger(speakerId)) {
    throw new Error(`invalid aivisspeech speaker id: ${value}`);
  }
  return String(speakerId);
}

function resolveAivisSpeechDefaultVoiceId(voices = []) {
  try {
    const configured = normalizeAivisSpeechSpeakerId(AIVISSPEECH_SPEAKER);
    if (configured) return configured;
  } catch (err) {
    console.warn(
      `[config] invalid AIVISSPEECH_SPEAKER=${AIVISSPEECH_SPEAKER}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  return String(voices[0]?.voiceId || "");
}

function parseRequestUrl(req) {
  return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
}

function resolvePublicBaseUrl(req, reqUrl) {
  const forwardedProtoHeader = String(req?.headers?.["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const forwardedHostHeader = String(req?.headers?.["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const protocol = forwardedProtoHeader === "https" ? "https" : "http";
  const host = forwardedHostHeader || String(req?.headers?.host || reqUrl?.host || `${HOST}:${PORT}`);
  return `${protocol}://${host}`;
}

function resolveAudioExtensionFromMimeType(mimeType) {
  const normalized = String(mimeType || "").trim().toLowerCase();
  if (!normalized) return "bin";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("aac")) return "aac";
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("mp4") || normalized.includes("m4a")) return "m4a";
  return "bin";
}

function buildTtsMediaUrl(baseUrl, mediaKey) {
  const normalizedBase = String(baseUrl || "").replace(/\/+$/, "");
  const normalizedId = encodeURIComponent(String(mediaKey || "").trim());
  return `${normalizedBase}/tts-media/${normalizedId}`;
}

async function ensureTtsMediaDir() {
  if (!ttsMediaDirReadyPromise) {
    ttsMediaDirReadyPromise = fs.mkdir(TTS_MEDIA_DIR, { recursive: true });
  }
  await ttsMediaDirReadyPromise;
}

async function removeTtsMediaEntry(mediaKey, entry) {
  if (!entry || typeof entry !== "object") return;
  ttsMediaEntries.delete(mediaKey);
  try {
    await fs.unlink(entry.filePath);
  } catch {}
}

async function sweepTtsMediaEntries() {
  if (ttsMediaSweepInFlight) return;
  ttsMediaSweepInFlight = true;
  try {
    const now = Date.now();
    for (const [mediaKey, entry] of ttsMediaEntries.entries()) {
      if (Number(entry.expiresAt || 0) > now) continue;
      await removeTtsMediaEntry(mediaKey, entry);
    }
    const overflow = ttsMediaEntries.size - TTS_MEDIA_MAX_ENTRIES;
    if (overflow > 0) {
      const oldest = Array.from(ttsMediaEntries.entries())
        .sort((a, b) => Number(a[1]?.createdAt || 0) - Number(b[1]?.createdAt || 0))
        .slice(0, overflow);
      for (const [mediaKey, entry] of oldest) {
        await removeTtsMediaEntry(mediaKey, entry);
      }
    }
  } finally {
    ttsMediaSweepInFlight = false;
  }
}

function ensureTtsMediaSweepTimer() {
  if (ttsMediaSweepTimer) return;
  ttsMediaSweepTimer = setInterval(() => {
    void sweepTtsMediaEntries();
  }, TTS_MEDIA_SWEEP_INTERVAL_MS);
  if (typeof ttsMediaSweepTimer.unref === "function") {
    ttsMediaSweepTimer.unref();
  }
}

async function registerTtsMedia(audioBuffer, mimeType, publicBaseUrl) {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length <= 0) {
    throw new Error("tts media buffer is empty");
  }
  await ensureTtsMediaDir();
  await sweepTtsMediaEntries();
  ensureTtsMediaSweepTimer();

  const mediaId = randomUUID();
  const ext = resolveAudioExtensionFromMimeType(mimeType);
  const mediaKey = `${mediaId}.${ext}`;
  const filePath = path.join(TTS_MEDIA_DIR, `${mediaId}.${ext}`);
  await fs.writeFile(filePath, audioBuffer);
  ttsMediaEntries.set(mediaKey, {
    filePath,
    mimeType: String(mimeType || "application/octet-stream"),
    ext,
    createdAt: Date.now(),
    expiresAt: Date.now() + TTS_MEDIA_TTL_MS,
  });
  return {
    mediaId: mediaKey,
    audioUrl: buildTtsMediaUrl(publicBaseUrl, mediaKey),
    audioBytes: audioBuffer.length,
  };
}

function parseDebugAuthToken(req, reqUrl) {
  const bearer = parseAuthToken(req);
  if (bearer) return bearer;
  return String(reqUrl.searchParams.get("token") || "").trim();
}

function parseSingleByteRange(rangeHeader, totalBytes) {
  const header = String(rangeHeader || "").trim();
  const total = Number(totalBytes);
  if (!header || !Number.isFinite(total) || total <= 0) return null;
  if (!header.toLowerCase().startsWith("bytes=")) return null;
  const raw = header.slice(6).trim();
  if (!raw || raw.includes(",")) return null;
  const [startRaw, endRaw] = raw.split("-", 2);
  const hasStart = String(startRaw || "").trim() !== "";
  const hasEnd = String(endRaw || "").trim() !== "";

  let start = 0;
  let end = total - 1;

  if (hasStart) {
    start = Number.parseInt(startRaw, 10);
    if (!Number.isFinite(start) || start < 0) return null;
    if (hasEnd) {
      end = Number.parseInt(endRaw, 10);
      if (!Number.isFinite(end) || end < start) return null;
    }
  } else if (hasEnd) {
    const suffixLen = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return null;
    start = Math.max(0, total - suffixLen);
    end = total - 1;
  } else {
    return null;
  }

  if (start >= total) return null;
  end = Math.min(end, total - 1);
  return { start, end };
}

const CLIENT_MEDIA_MIME_BY_EXT = new Map([
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".mkv", "video/x-matroska"],
  [".avi", "video/x-msvideo"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".bmp", "image/bmp"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
]);

function getClientMediaMimeType(filePath) {
  return CLIENT_MEDIA_MIME_BY_EXT.get(path.extname(String(filePath || "")).toLowerCase()) || "";
}

function buildInlineContentDisposition(rawFileName) {
  const fileName = String(rawFileName || "").trim() || "media";
  const asciiFileName = fileName.replace(/[^A-Za-z0-9._-]+/g, "_") || "media";
  const encodedFileName = encodeURIComponent(fileName).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `inline; filename="${asciiFileName}"; filename*=UTF-8''${encodedFileName}`;
}

function canSendWs(ws) {
  return ws && ws.readyState === 1;
}

function sendWsJson(ws, payload) {
  if (!canSendWs(ws)) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

function sendRunnerWsEnvelope(ws, message) {
  return sendWsJson(ws, message);
}

function sendRunnerWsTtsEnvelope(ws, job, event) {
  const eventType = String(event?.type || "event").trim() || "event";
  return sendRunnerWsEnvelope(ws, {
    channel: "tts",
    op: eventType,
    streamId: String(job?.jobId || event?.jobId || ""),
    sessionId: String(job?.sessionId || event?.sessionId || ""),
    seq: Number.isFinite(Number(event?.eventSeq)) ? Math.max(0, Math.floor(Number(event.eventSeq))) : undefined,
    payload: event,
  });
}

function runnerWsErrorEnvelope(error, message, extra = {}) {
  const envelope = {
    channel: "control",
    op: "error",
    payload: {
      error: String(error || "runner_ws_error"),
      message: String(message || error || "runner_ws_error"),
      ...(extra && typeof extra === "object" ? extra : {}),
    },
  };
  if (extra && typeof extra === "object") {
    for (const key of ["requestId", "sessionId", "threadId", "streamId"]) {
      const value = typeof extra[key] === "string" ? extra[key].trim() : "";
      if (value) envelope[key] = value;
    }
  }
  return envelope;
}

function normalizeRunnerWsOptionalString(value, key) {
  if (value === undefined || value === null) return { ok: true, value: "" };
  if (typeof value !== "string") {
    return { ok: false, error: `${key} must be a string` };
  }
  return { ok: true, value: value.trim() };
}

function parseRunnerWsEnvelope(raw, isBinary) {
  if (isBinary) {
    return { ok: false, error: "binary messages are not supported" };
  }
  let payload;
  try {
    payload = JSON.parse(String(raw || ""));
  } catch {
    return { ok: false, error: "message must be valid JSON" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "message must be a JSON object" };
  }
  const channel = String(payload.channel || "").trim();
  if (!RUNNER_WS_CHANNELS.has(channel)) {
    return { ok: false, error: "channel must be one of llm, tts, relay, control" };
  }
  const op = String(payload.op || "").trim();
  if (!op) {
    return { ok: false, error: "op is required" };
  }
  const message = { channel, op };
  for (const key of ["requestId", "sessionId", "threadId", "streamId"]) {
    const normalized = normalizeRunnerWsOptionalString(payload[key], key);
    if (!normalized.ok) return { ok: false, error: normalized.error };
    if (normalized.value) message[key] = normalized.value;
  }
  if (payload.seq !== undefined && payload.seq !== null) {
    const seq = Number(payload.seq);
    if (!Number.isFinite(seq) || seq < 0 || Math.floor(seq) !== seq) {
      return { ok: false, error: "seq must be a non-negative integer" };
    }
    message.seq = seq;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "payload")) {
    message.payload = payload.payload;
  }
  return { ok: true, message };
}

function jobNowIso() {
  return new Date().toISOString();
}

function llmJobSummary(job) {
  if (!job || typeof job !== "object") return null;
  const errorPayload = job.error && typeof job.error === "object" ? job.error : null;
  return {
    jobId: String(job.jobId || ""),
    sessionId: String(job.sessionId || ""),
    status: String(job.status || ""),
    createdAt: String(job.createdAt || ""),
    updatedAt: String(job.updatedAt || ""),
    completedAt: String(job.completedAt || "") || null,
    startedAt: String(job.startedAt || "") || null,
    mode: String(job.mode || "") || null,
    endpoint: String(job.endpoint || ""),
    route: String(job.route || ""),
    modelRef: String(job.modelRef || ""),
    clientRequestId: String(job.clientRequestId || ""),
    lastEventSeq: Number.isFinite(Number(job.lastEventSeq)) ? Number(job.lastEventSeq) : 0,
    reply: String(job.reply || ""),
    toolCalls: Number.isFinite(Number(job.toolCalls)) ? Number(job.toolCalls) : 0,
    rootRelativePath: String(job.rootRelativePath || ""),
    selectedSkillPath: String(job.selectedSkillPath || ""),
    contextUsage: job.contextUsage && typeof job.contextUsage === "object" ? job.contextUsage : undefined,
    error: errorPayload ? {
      error: String(errorPayload.error || "job_failed"),
      message: String(errorPayload.message || "job failed"),
      detail: String(errorPayload.detail || ""),
    } : null,
    pendingApprovalCount: job.pendingApprovals instanceof Map ? job.pendingApprovals.size : 0,
  };
}

function llmJobSnapshot(job, opts = {}) {
  const summary = llmJobSummary(job);
  if (!summary) return null;
  const includeEvents = opts.includeEvents === true;
  const sinceSeqRaw = Number(opts.sinceSeq || 0);
  const sinceSeq = Number.isFinite(sinceSeqRaw) ? Math.max(0, Math.floor(sinceSeqRaw)) : 0;
  const events = Array.isArray(job.events) ? job.events : [];
  const nextSeq = Number.isFinite(Number(job.nextEventSeq)) ? Number(job.nextEventSeq) : (events.length + 1);
  return {
    ...summary,
    nextEventSeq: nextSeq,
    events: includeEvents
      ? events.filter((event) => Number(event?.eventSeq || 0) > sinceSeq)
      : [],
  };
}

function pruneLlmJobStorage() {
  const now = Date.now();
  while (llmJobOrder.length > 0) {
    const oldestId = llmJobOrder[0];
    const oldest = llmJobsById.get(oldestId);
    if (!oldest) {
      llmJobOrder.shift();
      continue;
    }
    const done = oldest.status === "completed" || oldest.status === "failed" || oldest.status === "cancelled";
    const completedAtTs = oldest.completedAt ? Date.parse(String(oldest.completedAt)) : NaN;
    const ttlExpired = done && Number.isFinite(completedAtTs)
      ? (completedAtTs + LLM_JOB_RESULT_TTL_MS) < now
      : false;
    const overStored = llmJobOrder.length > LLM_JOB_MAX_STORED;
    if (!ttlExpired && !overStored) break;
    if (oldest.pendingApprovals instanceof Map && oldest.pendingApprovals.size > 0) break;
    if (oldest.subscribers instanceof Set && oldest.subscribers.size > 0) break;
    llmJobOrder.shift();
    llmJobsById.delete(oldestId);
  }
}

function activeLlmJobCount() {
  let count = 0;
  for (const job of llmJobsById.values()) {
    const status = String(job?.status || "");
    if (status === "queued" || status === "running" || status === "waiting_approval") {
      count += 1;
    }
  }
  return count;
}

function normalizeLlmClientRequestId(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value.length > LLM_JOB_CLIENT_REQUEST_ID_MAX_CHARS) {
    throw makeApiError(400, "invalid_client_request_id", "", {
      max: LLM_JOB_CLIENT_REQUEST_ID_MAX_CHARS,
    });
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw makeApiError(
      400,
      "invalid_client_request_id",
      "clientRequestId contains unsupported characters"
    );
  }
  return value;
}

function isActiveLlmJobStatus(statusRaw) {
  const status = String(statusRaw || "");
  return status === "queued" || status === "running" || status === "waiting_approval";
}

function findActiveLlmJobBySessionId(sessionIdRaw) {
  const sessionId = normalizeLlmExecutionSessionId(sessionIdRaw);
  if (!sessionId) return null;
  for (let i = llmJobOrder.length - 1; i >= 0; i -= 1) {
    const jobId = llmJobOrder[i];
    const job = llmJobsById.get(jobId);
    if (!job) continue;
    if (String(job.sessionId || "") !== sessionId) continue;
    if (!isActiveLlmJobStatus(job.status)) continue;
    return job;
  }
  return null;
}

function findLlmJobByClientRequestId(clientRequestIdRaw, opts = {}) {
  const clientRequestId = normalizeLlmClientRequestId(clientRequestIdRaw);
  if (!clientRequestId) return null;
  const sessionId = normalizeLlmExecutionSessionId(opts.sessionId);
  for (let i = llmJobOrder.length - 1; i >= 0; i -= 1) {
    const jobId = llmJobOrder[i];
    const job = llmJobsById.get(jobId);
    if (!job) continue;
    if (String(job.clientRequestId || "") !== clientRequestId) continue;
    if (sessionId && String(job.sessionId || "") !== sessionId) continue;
    return job;
  }
  return null;
}

function createLlmJob(payload = {}, meta = {}) {
  pruneLlmJobStorage();
  if (activeLlmJobCount() >= LLM_JOB_MAX_ACTIVE) {
    throw makeApiError(
      429,
      "job_capacity_exceeded",
      `too many active jobs (max=${LLM_JOB_MAX_ACTIVE})`,
      { maxActiveJobs: LLM_JOB_MAX_ACTIVE }
    );
  }
  const createdAt = jobNowIso();
  const jobId = `llmjob_${randomUUID()}`;
  const job = {
    jobId,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    startedAt: "",
    completedAt: "",
    mode: String(meta.mode || ""),
    endpoint: String(meta.endpoint || "/stream-tts"),
    route: "",
    modelRef: "",
    clientRequestId: String(meta.clientRequestId || ""),
    sessionId: String(payload?.sessionId || ""),
    requestPayload: payload && typeof payload === "object" ? payload : {},
    reply: "",
    toolCalls: 0,
    rootRelativePath: "",
    selectedSkillPath: "",
    contextUsage: null,
    lastEventSeq: 0,
    nextEventSeq: 1,
    events: [],
    subscribers: new Set(),
    pendingApprovals: new Map(),
    abortController: new AbortController(),
    runPromise: null,
    error: null,
  };
  llmJobsById.set(jobId, job);
  llmJobOrder.push(jobId);
  return job;
}

function getLlmJobById(rawJobId) {
  const jobId = String(rawJobId || "").trim();
  if (!jobId) return null;
  return llmJobsById.get(jobId) || null;
}

function llmJobSetStatus(job, status) {
  if (!job) return;
  job.status = String(status || job.status || "");
  job.updatedAt = jobNowIso();
  if ((job.status === "completed" || job.status === "failed" || job.status === "cancelled") && !job.completedAt) {
    job.completedAt = job.updatedAt;
  }
}

function llmJobPruneEvents(job) {
  if (!job || !Array.isArray(job.events)) return;
  if (job.events.length <= LLM_JOB_EVENT_MAX) return;
  const removableIndexes = [];
  for (let i = 0; i < job.events.length; i += 1) {
    const t = String(job.events[i]?.type || "");
    if (t === "progress" || t === "text_delta" || t === "segment_queued" || t === "segment_tts_started" || t === "segment_tts_done") {
      removableIndexes.push(i);
    }
  }
  let removeCount = job.events.length - LLM_JOB_EVENT_MAX;
  while (removeCount > 0 && removableIndexes.length > 0) {
    const idx = removableIndexes.shift();
    if (!Number.isInteger(idx)) continue;
    if (!job.events[idx]) continue;
    job.events[idx] = null;
    removeCount -= 1;
  }
  if (removeCount > 0) {
    for (let i = 0; i < job.events.length && removeCount > 0; i += 1) {
      if (!job.events[i]) continue;
      job.events[i] = null;
      removeCount -= 1;
    }
  }
  job.events = job.events.filter(Boolean);
}

function llmJobEmit(job, payload) {
  if (!job || !payload || typeof payload !== "object") return false;
  const event = {
    ...payload,
    eventSeq: job.nextEventSeq,
    at: String(payload?.at || jobNowIso()),
  };
  job.nextEventSeq += 1;
  job.lastEventSeq = Number(event.eventSeq || 0);
  job.updatedAt = String(event.at || jobNowIso());
  job.events.push(event);
  llmJobPruneEvents(job);
  const subscribers = job.subscribers instanceof Set ? Array.from(job.subscribers.values()) : [];
  for (const subscriber of subscribers) {
    if (isRunnerWsEnvelopeClient(subscriber)) {
      sendRunnerWsTtsEnvelope(subscriber, job, event);
    } else {
      sendWsJson(subscriber, event);
    }
  }
  return true;
}

function llmJobAttachSubscriber(job, ws, opts = {}) {
  if (!job || !ws) return false;
  if (!(job.subscribers instanceof Set)) job.subscribers = new Set();
  job.subscribers.add(ws);
  const sinceSeqRaw = Number(opts.sinceSeq || 0);
  const sinceSeq = Number.isFinite(sinceSeqRaw) ? Math.max(0, Math.floor(sinceSeqRaw)) : 0;
  const snapshot = llmJobSnapshot(job, { includeEvents: false });
  const snapshotEvent = {
    type: "job_snapshot",
    ...snapshot,
  };
  if (isRunnerWsEnvelopeClient(ws)) {
    sendRunnerWsTtsEnvelope(ws, job, snapshotEvent);
  } else {
    sendWsJson(ws, snapshotEvent);
  }
  for (const event of job.events) {
    if (Number(event?.eventSeq || 0) <= sinceSeq) continue;
    if (isRunnerWsEnvelopeClient(ws)) {
      sendRunnerWsTtsEnvelope(ws, job, event);
    } else {
      sendWsJson(ws, event);
    }
  }
  return true;
}

function llmJobDetachSubscriber(job, ws) {
  if (!job || !ws) return false;
  if (!(job.subscribers instanceof Set)) return false;
  return job.subscribers.delete(ws);
}

function llmJobCancel(job, reason = "cancelled") {
  if (!job) return false;
  if (job.abortController && !job.abortController.signal.aborted) {
    job.abortController.abort();
  }
  llmJobSetStatus(job, "cancelled");
  llmJobEmit(job, {
    type: "cancelled",
    reason: String(reason || "cancelled"),
    message: String(reason || "cancelled"),
  });
  for (const [requestId, pending] of job.pendingApprovals.entries()) {
    job.pendingApprovals.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(new Error("job cancelled"));
  }
  pruneLlmJobStorage();
  return true;
}

function isTtsBoundaryChar(ch) {
  return (
    ch === "。" ||
    ch === "、" ||
    ch === "！" ||
    ch === "？" ||
    ch === "!" ||
    ch === "?" ||
    ch === "." ||
    ch === "," ||
    ch === "\n"
  );
}

function isSoftTtsSplitChar(ch) {
  return ch === " " || ch === "　" || ch === "：" || ch === ":" || ch === ";" || ch === "；";
}

function findStreamTtsSplitIndex(buffer, maxChars) {
  const text = String(buffer || "");
  if (!text) return -1;
  const hardLimit = Math.max(1, Math.min(maxChars, text.length));
  const softStart = Math.max(0, hardLimit - STREAM_TTS_SEGMENT_FORCE_SPLIT_WINDOW_CHARS);
  for (let i = hardLimit - 1; i >= softStart; i -= 1) {
    if (isTtsBoundaryChar(text[i])) return i;
  }
  for (let i = hardLimit - 1; i >= softStart; i -= 1) {
    if (isSoftTtsSplitChar(text[i])) return i;
  }
  return hardLimit - 1;
}

function normalizeSpeedScaleForTtsEstimate(speedScale) {
  const value = Number(speedScale);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(0.5, Math.min(2.0, value));
}

function resolveStreamTtsSegmentTargetChars(speedScale) {
  const normalizedSpeedScale = normalizeSpeedScaleForTtsEstimate(speedScale);
  const estimatedChars = Math.floor(
    (STREAM_TTS_SEGMENT_MAX_EST_MS / 1000) * STREAM_TTS_EST_BASE_CHARS_PER_SEC * normalizedSpeedScale
  );
  return Math.max(
    STREAM_TTS_SEGMENT_MIN_CHARS,
    Math.min(
      STREAM_TTS_SEGMENT_MAX_CHARS,
      Number.isFinite(estimatedChars) && estimatedChars > 0
        ? estimatedChars
        : STREAM_TTS_SEGMENT_MIN_CHARS
    )
  );
}

function estimateStreamTtsSegmentDurationMs(text, speedScale) {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) return 0;
  const normalizedSpeedScale = normalizeSpeedScaleForTtsEstimate(speedScale);
  const charsPerSec = Math.max(0.1, STREAM_TTS_EST_BASE_CHARS_PER_SEC * normalizedSpeedScale);
  return Math.max(0, Math.round((normalizedText.length / charsPerSec) * 1000));
}

function stripYouTubeTags(raw) {
  return String(raw || "").replace(/[{\uFF5B]\s*youtube\s*[:\uFF1A]\s*[A-Za-z0-9_-]{1,32}\s*[}\uFF5D]/gi, "");
}

function stripMarkdownAndUrlsForTts(raw) {
  return String(raw || "")
    .replace(/[{\uFF5B]?\s*youtube\s*[:\uFF1A]\s*[A-Za-z0-9_-]{0,64}\s*[}\uFF5D]?/gi, " ")
    .replace(/```([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/\bhttps?\s*[:\uFF1A]\s*\/\/[^\s]+/gi, " ")
    .replace(/\bwww\.[^\s]+/gi, " ")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|jp|io|co|dev|ai|app|gg|tv|info|biz|xyz|me|ly)(?:\/[^\s]*)?/gi, " ")
    .replace(/(?:https?:\/\/|www\.)[^\s<>"')\]}]+/gi, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)([^*_]+)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/^[ \t]*(?:-{3,}|_{3,}|\*{3,})[ \t]*$/gm, "")
    .replace(/[`*_#~|[\]{}()<>]/g, " ")
    .replace(/\\/g, "");
}

function sanitizeTtsInputText(raw) {
  return stripMarkdownAndUrlsForTts(stripYouTubeTags(raw))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function sanitizeStreamTtsText(raw) {
  return sanitizeTtsInputText(raw).replace(/[。、\r\n]/g, "").trim();
}

function normalizeStreamTtsMode(raw) {
  const mode = String(raw || "").trim().toLowerCase();
  if (mode === "text") return "text";
  return "reply";
}

function parseOptionalSpeedScale(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error("speedScale must be a number");
  }
  if (value <= 0) {
    throw new Error("speedScale must be greater than 0");
  }
  return Math.max(0.5, Math.min(2.0, value));
}

async function runCommandCapture(bin, args, opts = {}) {
  const result = await runCommandWithCapture(bin, args, {
    timeoutMs: Number(opts.timeoutMs || NEAR_UNLIMITED_TIMEOUT_MS),
    cwd: opts.cwd,
    env: opts.env,
    maxOutputBytes: Number(opts.maxOutputBytes || 128 * 1024),
  });
  if (result.timedOut) {
    throw new Error(`${bin} timed out after ${result.timeoutMs}ms`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`${bin} exited with code ${result.exitCode}: ${result.stderr.trim()}`);
  }
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function splitCommandLine(raw) {
  const input = String(raw || "").trim();
  if (!input) return [];
  const parts = [];
  let token = "";
  let quote = "";
  let escaping = false;
  for (const ch of input) {
    if (escaping) {
      token += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = "";
      } else {
        token += ch;
      }
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (token) {
        parts.push(token);
        token = "";
      }
      continue;
    }
    token += ch;
  }
  if (quote) {
    throw makeToolError("invalid_command_line", "unclosed quote in command line");
  }
  if (escaping) {
    token += "\\";
  }
  if (token) parts.push(token);
  return parts;
}

async function runCommandWithCapture(bin, args, opts = {}) {
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs || NEAR_UNLIMITED_TIMEOUT_MS));
  const cwd = opts.cwd ? path.resolve(opts.cwd) : undefined;
  const env = opts.env && typeof opts.env === "object" ? opts.env : process.env;
  const maxOutputBytes = Math.max(256, Number(opts.maxOutputBytes || 65536));

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let stdout = "";
  let stderr = "";
  const startedAt = Date.now();
  let resolved = false;

  try {
    const runResult = await new Promise((resolve) => {
      const child = spawn(bin, args, {
        env,
        cwd,
        signal: controller.signal,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const finish = (payload) => {
        if (resolved) return;
        resolved = true;
        resolve(payload);
      };
      child.stdout.on("data", (d) => {
        const chunk = String(d || "");
        if (stdout.length < maxOutputBytes) {
          stdout += chunk.slice(0, Math.max(0, maxOutputBytes - stdout.length));
        }
      });
      child.stderr.on("data", (d) => {
        const chunk = String(d || "");
        if (stderr.length < maxOutputBytes) {
          stderr += chunk.slice(0, Math.max(0, maxOutputBytes - stderr.length));
        }
      });
      child.on("error", (err) => finish({
        exitCode: -1,
        error: err instanceof Error ? err.message : String(err),
      }));
      child.on("close", (code) => {
        finish({
          exitCode: Number.isFinite(Number(code)) ? Number(code) : -1,
          error: "",
        });
      });
    });
    return {
      command: String(bin || ""),
      args: Array.isArray(args) ? args.map((item) => String(item || "")) : [],
      timeoutMs,
      timedOut,
      durationMs: Date.now() - startedAt,
      exitCode: Number(runResult?.exitCode ?? -1),
      stdout,
      stderr: runResult?.error
        ? `${stderr}\n${String(runResult.error)}`.trim()
        : stderr,
    };
  } catch (err) {
    return {
      command: String(bin || ""),
      args: Array.isArray(args) ? args.map((item) => String(item || "")) : [],
      timeoutMs,
      timedOut,
      durationMs: Date.now() - startedAt,
      exitCode: -1,
      stdout,
      stderr: `${stderr}\n${errorMessage(err)}`.trim(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function clampPercent(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function computeLeftPercent(windowObj) {
  const usedPercent = Number(windowObj?.used_percent);
  if (!Number.isFinite(usedPercent)) return 0;
  return clampPercent(100 - usedPercent);
}

function formatLimitBar(leftPercent, width = 10) {
  const normalizedWidth = Math.max(4, Math.min(40, Number(width) || 10));
  const pct = clampPercent(leftPercent);
  const filled = pct >= 100
    ? normalizedWidth
    : Math.max(0, Math.min(normalizedWidth - 1, Math.round((pct / 100) * normalizedWidth)));
  return `[${"█".repeat(filled)}${"░".repeat(Math.max(0, normalizedWidth - filled))}]`;
}

function formatResetAt(resetAtSeconds, opts = {}) {
  const resetSec = Number(resetAtSeconds);
  if (!Number.isFinite(resetSec) || resetSec <= 0) return "-";
  const includeDate = opts.includeDate === true;
  const date = new Date(resetSec * 1000);
  const timeText = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  if (!includeDate) return timeText;
  const dateText = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
  }).format(date);
  return `${timeText} on ${dateText}`;
}

function buildCodexStatusFromWham(whamUsage) {
  const rateLimit = whamUsage?.rate_limit && typeof whamUsage.rate_limit === "object"
    ? whamUsage.rate_limit
    : null;
  const primaryWindow = rateLimit?.primary_window && typeof rateLimit.primary_window === "object"
    ? rateLimit.primary_window
    : null;
  const secondaryWindow = rateLimit?.secondary_window && typeof rateLimit.secondary_window === "object"
    ? rateLimit.secondary_window
    : null;
  if (!primaryWindow || !secondaryWindow) {
    throw new Error("wham usage payload missing primary/secondary windows");
  }

  const primaryLeft = computeLeftPercent(primaryWindow);
  const secondaryLeft = computeLeftPercent(secondaryWindow);
  const primaryValue = `${formatLimitBar(primaryLeft)} ${primaryLeft}% left`;
  const secondaryValue = `${formatLimitBar(secondaryLeft)} ${secondaryLeft}% left`;
  const primaryReset = formatResetAt(primaryWindow?.reset_at, { includeDate: false });
  const secondaryReset = formatResetAt(secondaryWindow?.reset_at, { includeDate: true });

  const statusText = [
    `5h limit: ${primaryValue}`,
    `(resets ${primaryReset})`,
    `Weekly limit: ${secondaryValue}`,
    `(resets ${secondaryReset})`,
  ].join("\n");

  return {
    statusText,
    limitLines: [
      {
        section: "default",
        label: "5h limit",
        value: `${primaryValue} (resets ${primaryReset})`,
      },
      {
        section: "default",
        label: "Weekly limit",
        value: `${secondaryValue} (resets ${secondaryReset})`,
      },
    ],
    primaryLeft,
    secondaryLeft,
  };
}

async function fetchWhamUsage(accessToken, accountId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CODEX_CLI_STATUS_HTTP_TIMEOUT_MS);
  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    };
    if (String(accountId || "").trim()) {
      headers["ChatGPT-Account-Id"] = String(accountId).trim();
    }
    const response = await fetch(CODEX_CLI_WHAM_USAGE_URL, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const raw = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(`wham usage failed (${response.status}): ${raw}`);
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error("wham usage returned non-JSON response");
    }
    return payload;
  } catch (err) {
    const isAbort = String(err?.name || "").toLowerCase() === "aborterror";
    if (isAbort) {
      throw new Error(`wham usage timeout (${CODEX_CLI_STATUS_HTTP_TIMEOUT_MS}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCodexCliStatusSnapshot() {
  const startedAt = Date.now();
  let triedAuthRefresh = false;
  while (true) {
    const auth = await refreshOAuthTokens({ force: triedAuthRefresh });
    const whamUsage = await fetchWhamUsage(auth.accessToken, auth.accountId);
    if (!whamUsage?.rate_limit && !triedAuthRefresh) {
      triedAuthRefresh = true;
      continue;
    }
    const formatted = buildCodexStatusFromWham(whamUsage);
    return {
      statusText: formatted.statusText,
      limitLines: formatted.limitLines,
      fetchedAt: new Date().toISOString(),
      exitCode: 0,
      durationMs: Date.now() - startedAt,
    };
  }
}

function parseGitChangedFileList(rawStdout, opts = {}) {
  const nulTerminated = opts?.nulTerminated === true;
  const out = [];
  const seen = new Set();
  const lines = nulTerminated
    ? String(rawStdout || "").split("\0")
    : String(rawStdout || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const filePath = String(rawLine || "").trim();
    if (!filePath) continue;
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    out.push(filePath);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function runGitChangedFileListCommand(args, opts = {}) {
  const cwd = String(opts?.cwd || "").trim() || WORKSPACE_ROOT;
  const gitArgs = ["-C", cwd, "-c", "core.quotepath=false", ...args];
  const result = await runCommandWithCapture("git", gitArgs, {
    timeoutMs: Math.max(10000, SANDBOXED_RUN_DEFAULT_TIMEOUT_MS),
    maxOutputBytes: Math.max(SANDBOXED_RUN_MAX_OUTPUT_BYTES, 512 * 1024),
  });
  if (result.timedOut) {
    throw new Error(`git command timed out: git ${args.join(" ")}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`git command failed (${result.exitCode}): git ${args.join(" ")} ${result.stderr || ""}`.trim());
  }
  return parseGitChangedFileList(result.stdout || "", {
    nulTerminated: gitArgs.includes("-z"),
  });
}

async function fetchGitBranchName(cwd) {
  const result = await runCommandWithCapture("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
    timeoutMs: Math.max(10000, SANDBOXED_RUN_DEFAULT_TIMEOUT_MS),
    maxOutputBytes: 8 * 1024,
  });
  if (result.timedOut) {
    throw new Error("git command timed out: git rev-parse --abbrev-ref HEAD");
  }
  if (result.exitCode !== 0) {
    throw new Error(`git command failed (${result.exitCode}): git rev-parse --abbrev-ref HEAD ${result.stderr || ""}`.trim());
  }
  return String(result.stdout || "").trim().split(/\r?\n/)[0] || "HEAD";
}

async function fetchGitChangedFilesSnapshot(rawDirectory) {
  const directory = String(rawDirectory || "").trim();
  let cwd = WORKSPACE_ROOT;
  if (directory) {
    try {
      const resolved = await resolveToolRoot(directory, { create: false });
      cwd = resolved.rootReal;
    } catch (err) {
      const code = String(err?.code || "").toUpperCase();
      if (code === "ENOENT") {
        throw makeApiError(404, "directory_not_found", "directory not found");
      }
      throw makeApiError(400, "directory_invalid", errorMessage(err));
    }
  }
  const [branchName, stagedFiles, unstagedDiffFiles, untrackedFiles] = await Promise.all([
    fetchGitBranchName(cwd),
    runGitChangedFileListCommand(["diff", "--name-only", "--staged", "-z"], { cwd }),
    runGitChangedFileListCommand(["diff", "--name-only", "-z"], { cwd }),
    runGitChangedFileListCommand(["ls-files", "--others", "--exclude-standard", "-z"], { cwd }),
  ]);
  const unstagedSet = new Set();
  for (const filePath of unstagedDiffFiles) unstagedSet.add(filePath);
  for (const filePath of untrackedFiles) unstagedSet.add(filePath);
  const unstagedFiles = Array.from(unstagedSet).sort((a, b) => a.localeCompare(b));
  return {
    branchName,
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    fetchedAt: new Date().toISOString(),
  };
}

async function executeWorkspaceShellScript(rawPath) {
  const target = await resolveWorkspaceShellScriptTarget(rawPath);
  const result = await runCommandWithCapture("bash", [target.resolved.realPath], {
    cwd: target.cwdAbs,
    timeoutMs: target.timeoutMs,
    maxOutputBytes: Math.max(SANDBOXED_RUN_MAX_OUTPUT_BYTES, 1024 * 1024),
  });
  return {
    ok: result.exitCode === 0 && !result.timedOut,
    path: target.resolved.relativePath,
    command: "bash",
    args: [target.resolved.relativePath],
    cwd: toUnixPath(path.relative(target.workspaceReal, target.cwdAbs)) || ".",
    timeoutMs: target.timeoutMs,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function resolveScriptExecutionTimeoutMs() {
  return Math.max(
    1000,
    Math.min(
      SCRIPT_EXEC_TIMEOUT_MS_MAX,
      Number(process.env.SCRIPT_EXEC_TIMEOUT_MS || SCRIPT_EXEC_TIMEOUT_MS_DEFAULT)
    )
  );
}

async function resolveWorkspaceShellScriptTarget(rawPath) {
  const requestedPath = String(rawPath || "").trim();
  if (!requestedPath) {
    throw makeApiError(400, "path_required", "path is required");
  }
  const workspaceReal = await getWorkspaceRealPath();
  let resolved;
  try {
    resolved = await resolvePathWithinToolRoot(workspaceReal, requestedPath, { defaultPath: "." });
  } catch (err) {
    throw makeApiError(400, classifyPathResolutionError(err), errorMessage(err));
  }
  let stat;
  try {
    stat = await fs.stat(resolved.realPath);
  } catch (err) {
    const code = classifyFsError(err, "script_stat_failed");
    const status = code === "not_found" ? 404 : 400;
    throw makeApiError(status, code, errorMessage(err));
  }
  if (!stat.isFile()) {
    throw makeApiError(400, "not_a_file", "path is not a file");
  }
  if (!resolved.relativePath.toLowerCase().endsWith(".sh")) {
    throw makeApiError(400, "script_extension_invalid", "only .sh files can be executed");
  }
  const cwdAbs = path.dirname(resolved.realPath);
  const timeoutMs = resolveScriptExecutionTimeoutMs();
  return {
    workspaceReal,
    resolved,
    cwdAbs,
    timeoutMs,
  };
}

function appendScriptJobOutput(current, chunk, maxBytes) {
  const base = String(current || "");
  if (!chunk || base.length >= maxBytes) return base;
  const limit = Math.max(0, maxBytes - base.length);
  if (limit <= 0) return base;
  return base + String(chunk).slice(0, limit);
}

function formatScriptJobStatus(job) {
  if (!job) return "failed";
  if (job.status === "running" && job.killRequestedAtMs) return "stopping";
  if (job.status === "running") return "running";
  if (job.timedOut) return "timed_out";
  if (job.killRequestedAtMs) return "killed";
  return Number(job.exitCode) === 0 ? "completed" : "failed";
}

function toScriptJobSnapshot(job) {
  const startedAtMs = Number(job?.startedAtMs || 0);
  const finishedAtMs = Number(job?.finishedAtMs || 0);
  const durationMs = finishedAtMs > 0
    ? Math.max(0, finishedAtMs - startedAtMs)
    : Math.max(0, Date.now() - startedAtMs);
  return {
    jobId: String(job?.jobId || ""),
    path: String(job?.path || ""),
    command: "bash",
    args: [String(job?.path || "")],
    cwd: String(job?.cwd || "."),
    pid: Number(job?.pid || 0),
    status: formatScriptJobStatus(job),
    timeoutMs: Number(job?.timeoutMs || 0),
    startedAtMs,
    startedAt: startedAtMs > 0 ? new Date(startedAtMs).toISOString() : "",
    finishedAtMs: finishedAtMs > 0 ? finishedAtMs : 0,
    finishedAt: finishedAtMs > 0 ? new Date(finishedAtMs).toISOString() : "",
    durationMs,
    exitCode: Number.isFinite(Number(job?.exitCode)) ? Number(job.exitCode) : null,
    timedOut: Boolean(job?.timedOut),
    signal: String(job?.signal || ""),
    killRequested: Boolean(job?.killRequestedAtMs),
    killRequestedAtMs: Number(job?.killRequestedAtMs || 0),
    killReason: String(job?.killReason || ""),
    stdout: String(job?.stdout || ""),
    stderr: String(job?.stderr || ""),
  };
}

function trimStoredScriptJobs() {
  if (scriptJobOrder.length <= SCRIPT_JOB_MAX_STORED) return;
  for (let idx = 0; idx < scriptJobOrder.length && scriptJobOrder.length > SCRIPT_JOB_MAX_STORED; ) {
    const jobId = scriptJobOrder[idx];
    const job = scriptJobsById.get(jobId);
    if (job && job.status === "running") {
      idx += 1;
      continue;
    }
    scriptJobOrder.splice(idx, 1);
    scriptJobsById.delete(jobId);
  }
}

function requestScriptJobTermination(job, reason = "manual") {
  if (!job || job.status !== "running") return false;
  if (!job.killRequestedAtMs) {
    job.killRequestedAtMs = Date.now();
    job.killReason = String(reason || "manual");
  }
  const child = job.child;
  if (!child || child.killed) return false;
  try {
    child.kill("SIGTERM");
  } catch {}
  if (job.killForceTimer) clearTimeout(job.killForceTimer);
  job.killForceTimer = setTimeout(() => {
    if (job.status !== "running") return;
    try {
      child.kill("SIGKILL");
    } catch {}
  }, SCRIPT_JOB_KILL_GRACE_MS);
  return true;
}

async function startWorkspaceShellScript(rawPath) {
  const target = await resolveWorkspaceShellScriptTarget(rawPath);
  const maxOutputBytes = Math.max(SANDBOXED_RUN_MAX_OUTPUT_BYTES, 1024 * 1024);
  const startedAtMs = Date.now();
  const jobId = `script_${randomUUID()}`;
  const job = {
    jobId,
    path: target.resolved.relativePath,
    cwd: toUnixPath(path.relative(target.workspaceReal, target.cwdAbs)) || ".",
    timeoutMs: target.timeoutMs,
    status: "running",
    startedAtMs,
    finishedAtMs: 0,
    durationMs: 0,
    exitCode: null,
    timedOut: false,
    signal: "",
    pid: 0,
    stdout: "",
    stderr: "",
    killRequestedAtMs: 0,
    killReason: "",
    timeoutTimer: null,
    killForceTimer: null,
    child: null,
  };

  scriptJobsById.set(jobId, job);
  scriptJobOrder.push(jobId);
  trimStoredScriptJobs();

  try {
    const child = spawn("bash", [target.resolved.realPath], {
      cwd: target.cwdAbs,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.child = child;
    job.pid = Number(child?.pid || 0);

    const finalize = ({ exitCode, signal, appendError }) => {
      if (job.status !== "running") return;
      if (appendError) {
        job.stderr = appendScriptJobOutput(job.stderr, `\n${appendError}`.trim(), maxOutputBytes);
      }
      job.status = "finished";
      job.finishedAtMs = Date.now();
      job.durationMs = Math.max(0, job.finishedAtMs - job.startedAtMs);
      job.exitCode = Number.isFinite(Number(exitCode)) ? Number(exitCode) : -1;
      job.signal = String(signal || "");
      if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
      if (job.killForceTimer) clearTimeout(job.killForceTimer);
      job.timeoutTimer = null;
      job.killForceTimer = null;
      trimStoredScriptJobs();
    };

    child.stdout.on("data", (chunk) => {
      job.stdout = appendScriptJobOutput(job.stdout, String(chunk || ""), maxOutputBytes);
    });
    child.stderr.on("data", (chunk) => {
      job.stderr = appendScriptJobOutput(job.stderr, String(chunk || ""), maxOutputBytes);
    });
    child.on("error", (err) => {
      finalize({
        exitCode: -1,
        signal: "",
        appendError: errorMessage(err),
      });
    });
    child.on("close", (code, signal) => {
      finalize({
        exitCode: code,
        signal,
        appendError: "",
      });
    });

    job.timeoutTimer = setTimeout(() => {
      if (job.status !== "running") return;
      job.timedOut = true;
      requestScriptJobTermination(job, "timeout");
    }, target.timeoutMs);
  } catch (err) {
    job.status = "finished";
    job.finishedAtMs = Date.now();
    job.durationMs = Math.max(0, job.finishedAtMs - job.startedAtMs);
    job.exitCode = -1;
    job.stderr = appendScriptJobOutput(job.stderr, errorMessage(err), maxOutputBytes);
  }

  return toScriptJobSnapshot(job);
}

function listWorkspaceShellScriptJobs() {
  const jobs = [];
  for (let idx = scriptJobOrder.length - 1; idx >= 0; idx -= 1) {
    const jobId = scriptJobOrder[idx];
    const job = scriptJobsById.get(jobId);
    if (!job) continue;
    jobs.push(toScriptJobSnapshot(job));
  }
  return jobs;
}

function killWorkspaceShellScriptJob(rawJobId) {
  const jobId = String(rawJobId || "").trim();
  if (!jobId) {
    throw makeApiError(400, "job_id_required", "jobId is required");
  }
  const job = scriptJobsById.get(jobId);
  if (!job) {
    throw makeApiError(404, "job_not_found", "job not found");
  }
  const running = job.status === "running";
  if (running) {
    requestScriptJobTermination(job, "manual");
  }
  return {
    ok: true,
    running,
    ...toScriptJobSnapshot(job),
  };
}

function normalizeCodexAuthId(rawAuthId) {
  const authId = String(rawAuthId || "").trim();
  if (!authId) {
    throw makeApiError(400, "auth_id_required", "authId is required");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(authId)) {
    throw makeApiError(
      400,
      "auth_id_invalid",
      "authId must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/"
    );
  }
  return authId;
}

function parseAuthIdFromProfileFileName(fileName) {
  const normalized = String(fileName || "").trim();
  if (!normalized.endsWith(CODEX_AUTH_PROFILE_SUFFIX)) return "";
  const authId = normalized.slice(0, -CODEX_AUTH_PROFILE_SUFFIX.length);
  try {
    return normalizeCodexAuthId(authId);
  } catch {
    return "";
  }
}

function authProfilePathForId(authId) {
  return path.join(CODEX_AUTH_PROFILES_DIR, `${authId}${CODEX_AUTH_PROFILE_SUFFIX}`);
}

async function readActiveAuthIdMarker() {
  try {
    const raw = await fs.readFile(CODEX_AUTH_ACTIVE_ID_PATH, "utf8");
    return normalizeCodexAuthId(raw);
  } catch {
    return "";
  }
}

async function writeActiveAuthIdMarker(authId) {
  await fs.mkdir(CODEX_AUTH_PROFILES_DIR, { recursive: true });
  await fs.writeFile(CODEX_AUTH_ACTIVE_ID_PATH, `${authId}\n`, { encoding: "utf8", mode: 0o600 });
}

function resetCodexAuthRuntimeCache() {
  codexCliStatusCache = {
    fetchedAtMs: 0,
    snapshot: null,
  };
  oauthRefreshInFlight = null;
}

async function listCodexAuthProfileCandidates() {
  const entries = await fs.readdir(CODEX_AUTH_PROFILES_DIR, { withFileTypes: true }).catch((err) => {
    if (String(err?.code || "") === "ENOENT") return [];
    throw err;
  });
  const profiles = [];
  for (const entry of entries) {
    if (!entry || !entry.isFile?.()) continue;
    const authId = parseAuthIdFromProfileFileName(entry.name);
    if (!authId) continue;
    profiles.push({
      authId,
      fileName: entry.name,
      filePath: path.join(CODEX_AUTH_PROFILES_DIR, entry.name),
    });
  }
  profiles.sort((a, b) => a.authId.localeCompare(b.authId));
  return profiles;
}

async function resolveCurrentAuthIdFromProfiles(profileCandidates) {
  if (!Array.isArray(profileCandidates) || profileCandidates.length <= 0) return "";
  const authIdSet = new Set(profileCandidates.map((item) => item.authId));
  const markerAuthId = await readActiveAuthIdMarker();
  if (markerAuthId && authIdSet.has(markerAuthId)) {
    return markerAuthId;
  }
  try {
    const activeRealPath = await fs.realpath(CODEX_AUTH_PATH);
    for (const profile of profileCandidates) {
      const profileRealPath = await fs.realpath(profile.filePath).catch(() => "");
      if (profileRealPath && profileRealPath === activeRealPath) {
        return profile.authId;
      }
    }
  } catch {}

  const activeRaw = await fs.readFile(CODEX_AUTH_PATH, "utf8").catch(() => "");
  const activeTrimmed = activeRaw.trim();
  if (!activeTrimmed) return "";
  for (const profile of profileCandidates) {
    const profileRaw = await fs.readFile(profile.filePath, "utf8").catch(() => "");
    if (profileRaw.trim() === activeTrimmed) {
      return profile.authId;
    }
  }
  return "";
}

async function listCodexAuthProfilesSnapshot() {
  const candidates = await listCodexAuthProfileCandidates();
  const currentAuthId = await resolveCurrentAuthIdFromProfiles(candidates);
  return {
    currentAuthId,
    profiles: candidates.map((item) => ({
      authId: item.authId,
      fileName: item.fileName,
      isCurrent: Boolean(currentAuthId && item.authId === currentAuthId),
    })),
    fetchedAt: new Date().toISOString(),
  };
}

async function acquireCodexAuthSwitchLock() {
  await fs.mkdir(CODEX_AUTH_PROFILES_DIR, { recursive: true });
  let handle;
  try {
    handle = await fs.open(CODEX_AUTH_SWITCH_LOCK_PATH, "wx", 0o600);
  } catch (err) {
    if (String(err?.code || "") === "EEXIST") {
      throw makeApiError(409, "auth_switch_busy", "another auth switch is in progress");
    }
    throw err;
  }
  try {
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
  } catch (err) {
    await handle.close().catch(() => {});
    await fs.unlink(CODEX_AUTH_SWITCH_LOCK_PATH).catch(() => {});
    throw err;
  }
  return async () => {
    await handle.close().catch(() => {});
    await fs.unlink(CODEX_AUTH_SWITCH_LOCK_PATH).catch(() => {});
  };
}

async function restartRunnerForAuthSwitch() {
  const restartEnv = {
    ...process.env,
    RUN_LOCAL_REUSE_EXISTING: "0",
  };
  const bin = CODEX_AUTH_SWITCH_REQUIRE_SUDO ? "sudo" : CODEX_AUTH_SWITCH_RESTART_SCRIPT_PATH;
  const args = CODEX_AUTH_SWITCH_REQUIRE_SUDO
    ? [
        "-n",
        "env",
        "RUN_LOCAL_REUSE_EXISTING=0",
        CODEX_AUTH_SWITCH_RESTART_SCRIPT_PATH,
        "restart",
        "--mode",
        "full",
      ]
    : ["restart", "--mode", "full"];
  const result = await runCommandWithCapture(bin, args, {
    timeoutMs: CODEX_AUTH_SWITCH_RESTART_TIMEOUT_MS,
    cwd: WORKSPACE_ROOT,
    env: restartEnv,
    maxOutputBytes: 64 * 1024,
  });
  if (result.timedOut) {
    throw new Error(`restart command timed out (${result.timeoutMs}ms)`);
  }
  if (result.exitCode !== 0) {
    const stderrText = String(result.stderr || "").trim();
    const stdoutText = String(result.stdout || "").trim();
    throw new Error(
      `restart command failed (${result.exitCode}): ${stderrText || stdoutText || "no output"}`
    );
  }
  return {
    command: CODEX_AUTH_SWITCH_REQUIRE_SUDO
      ? `${bin} ${args.join(" ")}`.trim()
      : `RUN_LOCAL_REUSE_EXISTING=0 ${bin} ${args.join(" ")}`.trim(),
  };
}

async function switchCodexAuthProfile(authIdRaw) {
  const authId = normalizeCodexAuthId(authIdRaw);
  const releaseLock = await acquireCodexAuthSwitchLock();
  let tmpAuthPath = "";
  try {
    const profilePath = authProfilePathForId(authId);
    const profileRaw = await fs.readFile(profilePath, "utf8").catch((err) => {
      if (String(err?.code || "") === "ENOENT") {
        throw makeApiError(404, "auth_profile_not_found", `auth profile not found: ${authId}`);
      }
      throw err;
    });
    try {
      JSON.parse(profileRaw);
    } catch (err) {
      throw makeApiError(
        400,
        "auth_profile_invalid_json",
        `auth profile JSON is invalid: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    tmpAuthPath = `${CODEX_AUTH_PATH}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmpAuthPath, profileRaw.endsWith("\n") ? profileRaw : `${profileRaw}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tmpAuthPath, CODEX_AUTH_PATH);
    await fs.chmod(CODEX_AUTH_PATH, 0o600).catch(() => {});
    await writeActiveAuthIdMarker(authId);
    resetCodexAuthRuntimeCache();
    const restart = await restartRunnerForAuthSwitch();
    const snapshot = await listCodexAuthProfilesSnapshot();
    return {
      authId,
      restart,
      snapshot,
    };
  } finally {
    if (tmpAuthPath) {
      await fs.unlink(tmpAuthPath).catch(() => {});
    }
    await releaseLock();
  }
}

async function getGoogleCloudAccessToken() {
  try {
    const adc = await runCommandCapture("gcloud", ["auth", "application-default", "print-access-token"]);
    if (adc.stdout) return adc.stdout;
  } catch {}

  const fallback = await runCommandCapture("gcloud", ["auth", "print-access-token"]);
  if (!fallback.stdout) {
    throw new Error("failed to acquire Google Cloud access token from gcloud");
  }
  return fallback.stdout;
}

function googleTtsHeaders(accessToken) {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json; charset=utf-8",
  };
  if (GOOGLE_CLOUD_PROJECT_ID) {
    headers["x-goog-user-project"] = GOOGLE_CLOUD_PROJECT_ID;
  }
  return headers;
}

function normalizeYouTubeVideoIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const id = String(item || "").trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 20) break;
  }
  return out;
}

function parseYouTubeViewCount(raw) {
  const value = Number(String(raw ?? "").trim());
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

async function fetchYouTubeVideosMetadata(videoIds) {
  const normalizedIds = normalizeYouTubeVideoIds(videoIds);
  if (normalizedIds.length === 0) {
    throw makeApiError(400, "video_ids_required", "videoIds must include at least one YouTube video ID");
  }
  const url = new URL("https://youtube.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet,statistics");
  url.searchParams.set("id", normalizedIds.join(","));
  url.searchParams.set("maxResults", String(Math.min(normalizedIds.length, 20)));
  url.searchParams.set(
    "fields",
    "items(id,snippet/channelTitle,snippet/publishedAt,statistics/viewCount)"
  );
  const requestHeaders = {
    accept: "application/json",
  };
  if (YOUTUBE_API_KEY) {
    url.searchParams.set("key", YOUTUBE_API_KEY);
  } else {
    const accessToken = await getGoogleCloudAccessToken();
    requestHeaders.authorization = `Bearer ${accessToken}`;
    if (GOOGLE_CLOUD_PROJECT_ID) {
      requestHeaders["x-goog-user-project"] = GOOGLE_CLOUD_PROJECT_ID;
    }
  }
  const response = await fetch(url, {
    method: "GET",
    headers: requestHeaders,
  });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    if (
      !YOUTUBE_API_KEY &&
      response.status === 403 &&
      /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions|Insufficient Permission/i.test(bodyText)
    ) {
      throw new Error(
        "youtube videos failed (403): insufficient auth scopes for gcloud token. set YOUTUBE_API_KEY in private_runner/.env"
      );
    }
    throw new Error(`youtube videos failed (${response.status}): ${bodyText}`);
  }
  const data = await response.json().catch(() => ({}));
  const items = Array.isArray(data?.items) ? data.items : [];
  const results = items.map((item) => ({
    videoId: String(item?.id || "").trim(),
    channelTitle: String(item?.snippet?.channelTitle || "").trim(),
    publishedAt: String(item?.snippet?.publishedAt || "").trim(),
    viewCount: parseYouTubeViewCount(item?.statistics?.viewCount),
  })).filter((item) => /^[A-Za-z0-9_-]{11}$/.test(item.videoId));
  return results;
}

async function runGoogleCloudTts(text, opts = {}) {
  const languageCode = String(opts.languageCode || GOOGLE_CLOUD_TTS_LANGUAGE_CODE).trim();
  const voiceName = String(opts.voiceId || opts.voiceName || GOOGLE_CLOUD_TTS_VOICE_NAME).trim();
  const audioEncoding = String(opts.audioEncoding || GOOGLE_CLOUD_TTS_AUDIO_ENCODING).trim().toUpperCase();
  const speedScale = typeof opts.speedScale === "number" ? opts.speedScale : undefined;
  const accessToken = await getGoogleCloudAccessToken();

  const response = await fetch(`${GOOGLE_CLOUD_TTS_API_BASE_URL}/v1/text:synthesize`, {
    method: "POST",
    headers: googleTtsHeaders(accessToken),
    body: JSON.stringify({
      input: { text },
      voice: {
        languageCode,
        name: voiceName,
      },
      audioConfig: {
        audioEncoding,
        ...(typeof speedScale === "number" ? { speakingRate: speedScale } : {}),
      },
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(`google tts failed (${response.status}): ${bodyText}`);
  }

  const data = await response.json().catch(() => ({}));
  const audioContent = String(data?.audioContent || "").trim();
  if (!audioContent) {
    throw new Error("google tts returned empty audio");
  }

  return {
    audioBuffer: Buffer.from(audioContent, "base64"),
    voiceId: voiceName,
    languageCode,
    audioEncoding,
    speedScale,
  };
}

async function listGoogleCloudVoices(opts = {}) {
  const languageCode = String(opts.languageCode || GOOGLE_CLOUD_TTS_LANGUAGE_CODE).trim();
  const accessToken = await getGoogleCloudAccessToken();
  const url = new URL(`${GOOGLE_CLOUD_TTS_API_BASE_URL}/v1/voices`);
  if (languageCode) {
    url.searchParams.set("languageCode", languageCode);
  }

  const response = await fetch(url, {
    method: "GET",
    headers: googleTtsHeaders(accessToken),
  });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(`google voices failed (${response.status}): ${bodyText}`);
  }

  const data = await response.json().catch(() => ({}));
  const rawVoices = Array.isArray(data?.voices) ? data.voices : [];
  return rawVoices.map((voice) => ({
    voiceId: String(voice?.name || ""),
    name: String(voice?.name || ""),
    category: String(voice?.ssmlGender || ""),
    previewUrl: "",
    languageCodes: Array.isArray(voice?.languageCodes) ? voice.languageCodes : [],
  })).filter((voice) => voice.voiceId);
}

async function listAivisSpeechVoices() {
  const apiBaseUrl = await ensureAivisSpeechReady();
  const response = await fetch(new URL("/speakers", apiBaseUrl), {
    method: "GET",
  });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(`aivisspeech voices failed (${response.status}): ${bodyText}`);
  }

  const data = await response.json().catch(() => []);
  const rawSpeakers = Array.isArray(data) ? data : [];
  const voices = [];
  for (const speaker of rawSpeakers) {
    const speakerName = String(speaker?.name || "").trim();
    const styles = Array.isArray(speaker?.styles) ? speaker.styles : [];
    for (const style of styles) {
      const voiceId = normalizeAivisSpeechSpeakerId(style?.id);
      if (!voiceId) continue;
      const styleName = String(style?.name || "").trim();
      const styleType = String(style?.type || "").trim();
      voices.push({
        voiceId,
        name: styleName ? `${speakerName} / ${styleName}` : speakerName,
        category: styleType || speakerName,
        previewUrl: "",
      });
    }
  }
  return voices;
}

async function resolveAivisSpeechSpeakerId(preferredVoiceId) {
  const candidate = normalizeAivisSpeechSpeakerId(preferredVoiceId || AIVISSPEECH_SPEAKER);
  if (candidate) return candidate;

  const voices = await listAivisSpeechVoices();
  const fallbackVoiceId = String(voices[0]?.voiceId || "");
  if (!fallbackVoiceId) {
    throw new Error("aivisspeech voice is unavailable. install a model and check /speakers");
  }
  return fallbackVoiceId;
}

async function runAivisSpeechTts(text, opts = {}) {
  const apiBaseUrl = await ensureAivisSpeechReady();
  const speakerId = await resolveAivisSpeechSpeakerId(opts.voiceId || "");
  const speedScale = typeof opts.speedScale === "number" ? opts.speedScale : undefined;

  const audioQueryUrl = new URL("/audio_query", apiBaseUrl);
  audioQueryUrl.searchParams.set("speaker", speakerId);
  audioQueryUrl.searchParams.set("text", text);
  const audioQueryRes = await fetch(audioQueryUrl, {
    method: "POST",
  });
  if (!audioQueryRes.ok) {
    const bodyText = await audioQueryRes.text().catch(() => "");
    throw new Error(`aivisspeech audio_query failed (${audioQueryRes.status}): ${bodyText}`);
  }

  const audioQuery = await audioQueryRes.json().catch(() => null);
  if (!audioQuery || typeof audioQuery !== "object") {
    throw new Error("aivisspeech audio_query returned invalid payload");
  }
  if (typeof speedScale === "number") {
    audioQuery.speedScale = speedScale;
  }

  const synthesisUrl = new URL("/synthesis", apiBaseUrl);
  synthesisUrl.searchParams.set("speaker", speakerId);
  const synthesisRes = await fetch(synthesisUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(audioQuery),
  });
  if (!synthesisRes.ok) {
    const bodyText = await synthesisRes.text().catch(() => "");
    throw new Error(`aivisspeech synthesis failed (${synthesisRes.status}): ${bodyText}`);
  }

  const audioBuffer = Buffer.from(await synthesisRes.arrayBuffer());
  if (!audioBuffer.length) {
    throw new Error("aivisspeech synthesis returned empty audio");
  }

  return {
    audioBuffer,
    voiceId: speakerId,
    speedScale: Number.isFinite(Number(audioQuery.speedScale))
      ? Number(audioQuery.speedScale)
      : undefined,
  };
}

async function runElevenLabsTts(text, opts = {}) {
  const voiceId = opts.voiceId || ELEVENLABS_VOICE_ID;
  const modelId = opts.modelId || ELEVENLABS_TTS_MODEL;
  const outputFormat = opts.outputFormat || ELEVENLABS_OUTPUT_FORMAT;

  const url = new URL(`${ELEVENLABS_API_BASE_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}`);
  url.searchParams.set("output_format", outputFormat);

  const payload = {
    text,
    model_id: modelId,
  };
  if (typeof opts.applyLanguageTextNormalization === "boolean") {
    payload.apply_language_text_normalization = opts.applyLanguageTextNormalization;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(`elevenlabs tts failed (${response.status}): ${bodyText}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  if (!audioBuffer.length) {
    throw new Error("elevenlabs tts returned empty audio");
  }

  return {
    audioBuffer,
    voiceId,
    modelId,
    outputFormat,
  };
}

async function listElevenLabsVoices() {
  const response = await fetch(`${ELEVENLABS_API_BASE_URL}/v1/voices`, {
    method: "GET",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
    },
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(`elevenlabs voices failed (${response.status}): ${bodyText}`);
  }

  const data = await response.json().catch(() => ({}));
  const rawVoices = Array.isArray(data?.voices) ? data.voices : [];
  return rawVoices.map((voice) => ({
    voiceId: String(voice?.voice_id || ""),
    name: String(voice?.name || ""),
    category: String(voice?.category || ""),
    previewUrl: String(voice?.preview_url || ""),
    labels: voice?.labels && typeof voice.labels === "object" ? voice.labels : {},
  })).filter((voice) => voice.voiceId);
}

function validateTtsProviderRequirements(ttsProvider, endpointName) {
  if (ttsProvider === "elevenlabs" && !ELEVENLABS_API_KEY) {
    return {
      status: 500,
      payload: {
        error: "tts_key_missing",
        message: `ELEVENLABS_API_KEY is required for ${endpointName} when ttsProvider=elevenlabs`,
      },
    };
  }
  if (ttsProvider === "google" && !GOOGLE_CLOUD_PROJECT_ID) {
    return {
      status: 500,
      payload: {
        error: "tts_project_missing",
        message: `GOOGLE_CLOUD_PROJECT_ID is required for ${endpointName} when ttsProvider=google`,
      },
    };
  }
  return null;
}

async function runTtsByProvider(ttsProvider, text, opts = {}) {
  if (ttsProvider === "google") {
    const tts = await runGoogleCloudTts(text, {
      voiceId: opts.voiceId || undefined,
      languageCode: opts.languageCode || undefined,
      audioEncoding: opts.audioEncoding || undefined,
      speedScale: typeof opts.speedScale === "number" ? opts.speedScale : undefined,
    });
    return {
      audioBuffer: tts.audioBuffer,
      mimeType: googleAudioEncodingToMimeType(tts.audioEncoding),
      provider: "google",
      voiceId: tts.voiceId,
      languageCode: tts.languageCode,
      audioEncoding: tts.audioEncoding,
      speedScale: tts.speedScale,
    };
  }

  if (ttsProvider === "aivisspeech") {
    const tts = await runAivisSpeechTts(text, {
      voiceId: opts.voiceId || undefined,
      speedScale: typeof opts.speedScale === "number" ? opts.speedScale : undefined,
    });
    return {
      audioBuffer: tts.audioBuffer,
      mimeType: "audio/wav",
      provider: "aivisspeech",
      voiceId: tts.voiceId,
      speedScale: tts.speedScale,
    };
  }

  const tts = await runElevenLabsTts(text, {
    voiceId: opts.voiceId || undefined,
    modelId: opts.modelId || undefined,
    outputFormat: opts.outputFormat || undefined,
    applyLanguageTextNormalization: opts.applyLanguageTextNormalization,
  });
  return {
    audioBuffer: tts.audioBuffer,
    mimeType: elevenOutputFormatToMimeType(tts.outputFormat),
    provider: "elevenlabs",
    voiceId: tts.voiceId,
    modelId: tts.modelId,
    outputFormat: tts.outputFormat,
  };
}

let workspaceRealPathPromise = null;
let agentSkillContextPromise = null;

const LLM_FILE_TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "list_dir",
    description: "指定ディレクトリ配下の一覧を取得します。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "ルートからの相対パス。省略時は '.'。" },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "find_files",
    description: "glob でファイルを検索します。`**/name` は root直下の `name` にも一致します。",
    parameters: {
      type: "object",
      properties: {
        glob: { type: "string", description: "glob パターン。例: **/*.md" },
        path: { type: "string", description: "探索開始ディレクトリ。" },
      },
      required: ["glob"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "search_text",
    description: "テキストを検索します。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "検索文字列。" },
        path: { type: "string", description: "探索開始ディレクトリ。" },
        glob: { type: "string", description: "対象ファイルglob。" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_file_range",
    description: "テキストファイルの行範囲を読み取ります（1-based、両端含む）。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "ファイルの相対パス。" },
        start_line: { type: "number", minimum: 1, description: "開始行（1-based）。" },
        end_line: { type: "number", minimum: 1, description: "終了行（1-based、両端含む）。" },
      },
      required: ["path", "start_line", "end_line"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "apply_patch",
    description: "Begin-End Patch または unified diff を適用します。",
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string", description: "パッチ本文。" },
      },
      required: ["patch"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "run_tests",
    description: "テストコマンドを実行し、成功/失敗に関係なく結果を返します。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "任意。特定テスト対象やコマンド。" },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "run_command_sandboxed",
    description: "allowlist に含まれるコマンドを制限付きで実行します。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "実行コマンド名。" },
        args: {
          type: "array",
          description: "コマンド引数配列。shell展開はされません。",
          items: { type: "string" },
        },
        cwd: { type: "string", description: "実行ディレクトリ（rootからの相対パス）。省略時は '.'。" },
        timeoutMs: { type: "number", minimum: 1000, description: "タイムアウト(ms)。" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "git_diff",
    description: "git diff を取得します。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "対象パス（任意）。省略時は root 全体。" },
        staged: { type: "boolean", description: "true の場合は --staged を使用。" },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_file",
    description: "テキストファイルをページング読取します。失敗時は `ok:false` と `code` が返ります。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "ファイルの相対パス。" },
        offset: { type: "number", minimum: 0, description: "読み取り開始オフセット。" },
        limit: { type: "number", minimum: 1, description: `最大読取バイト数。上限 ${LLM_FILE_MAX_READ_BYTES}` },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "write_file",
    description: "テキストファイルを書き込みます。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "ファイルの相対パス。" },
        content: { type: "string", description: "書き込む内容。" },
        mode: {
          type: "string",
          enum: ["overwrite", "append", "create"],
          description: "overwrite=上書き, append=追記, create=新規作成のみ",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "edit_file",
    description: "oldText/newText 置換でファイルを編集します。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "ファイルの相対パス。" },
        edits: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              oldText: { type: "string" },
              newText: { type: "string" },
              replaceAll: { type: "boolean" },
            },
            required: ["oldText", "newText"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "media",
    description: "クライアント側のメディア再生を操作します（stop/next/prev）。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["stop", "next", "prev"],
          description: "メディア操作。stop=停止, next=次へ, prev=前へ。",
        },
        target: {
          type: "string",
          enum: ["all", "youtube", "tts"],
          description: "操作対象。省略時は stop=all, next/prev=youtube。",
        },
        reason: {
          type: "string",
          description: "操作理由のメモ（任意）。",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];
const LLM_FILE_TOOL_DEFINITION_MAP = new Map(
  LLM_FILE_TOOL_DEFINITIONS.map((tool) => [String(tool.name), tool])
);

function getEnabledLlmFileToolNames() {
  const names = [
    "list_dir",
    "search_text",
    "find_files",
    "read_file_range",
    "apply_patch",
    "run_tests",
    "run_command_sandboxed",
    "git_diff",
  ];
  if (LLM_FILE_ENABLE_MEDIA_TOOL) {
    names.push("media");
  }
  if (LLM_FILE_ENABLE_LEGACY_WRITE_TOOLS) {
    names.push("write_file");
    names.push("edit_file");
  }
  return names;
}

function buildCodexBuiltinTools() {
  return [];
}

function getCodexToolDefinitions() {
  const enabledNames = getEnabledLlmFileToolNames();
  const fileTools = [];
  for (const name of enabledNames) {
    const def = LLM_FILE_TOOL_DEFINITION_MAP.get(name);
    if (def) fileTools.push(def);
  }
  const builtinTools = buildCodexBuiltinTools();
  if (builtinTools.length <= 0) return fileTools;
  return [...fileTools, ...builtinTools];
}

function toUnixPath(value) {
  return String(value || "").split(path.sep).join("/");
}

function clamp(value, min, max) {
  if (!Number.isFinite(Number(value))) return min;
  const n = Number(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function normalizeCommandApproval(raw, fallback = "required") {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "none" || value === "skip" || value === "auto") return "none";
  if (value === "required" || value === "ask") return "required";
  return fallback === "none" ? "none" : "required";
}

function normalizeCommandApprovalPolicy(raw) {
  const root = raw && typeof raw === "object" ? raw : {};
  const defaultApproval = normalizeCommandApproval(root.defaultApproval, "required");
  const commands = {};
  const rawCommands = root.commands && typeof root.commands === "object" ? root.commands : {};
  for (const [rawCommand, rawPolicy] of Object.entries(rawCommands)) {
    const command = String(rawCommand || "").trim().toLowerCase();
    if (!command) continue;
    const policyObj = rawPolicy && typeof rawPolicy === "object"
      ? rawPolicy
      : { approval: String(rawPolicy || "") };
    const approval = normalizeCommandApproval(policyObj.approval, defaultApproval);
    const firstArgPolicies = {};
    const rawFirstArg = policyObj.firstArgPolicies && typeof policyObj.firstArgPolicies === "object"
      ? policyObj.firstArgPolicies
      : {};
    for (const [rawArg, rawArgPolicy] of Object.entries(rawFirstArg)) {
      const argKey = String(rawArg || "").trim().toLowerCase();
      if (!argKey) continue;
      const argApproval = rawArgPolicy && typeof rawArgPolicy === "object"
        ? normalizeCommandApproval(rawArgPolicy.approval, approval)
        : normalizeCommandApproval(rawArgPolicy, approval);
      firstArgPolicies[argKey] = { approval: argApproval };
    }
    commands[command] = { approval, firstArgPolicies };
  }
  return { defaultApproval, commands };
}

async function loadCommandApprovalPolicy() {
  const fallback = {
    defaultApproval: "required",
    commands: {},
  };
  try {
    const stat = await fs.stat(COMMAND_APPROVAL_POLICY_PATH);
    const signature = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
    if (commandApprovalPolicyCache && commandApprovalPolicyCacheSignature === signature) {
      return commandApprovalPolicyCache;
    }
    const raw = await fs.readFile(COMMAND_APPROVAL_POLICY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const normalized = normalizeCommandApprovalPolicy(parsed);
    commandApprovalPolicyCache = normalized;
    commandApprovalPolicyCacheSignature = signature;
    commandApprovalPolicyLastWarning = "";
    return normalized;
  } catch (err) {
    if (err?.code === "ENOENT") {
      return fallback;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (commandApprovalPolicyLastWarning !== message) {
      commandApprovalPolicyLastWarning = message;
      console.warn(`[command_approval_policy] fallback to default: ${message}`);
    }
    return fallback;
  }
}

async function resolveCommandApprovalPolicyForCommand(command, args = []) {
  const policy = await loadCommandApprovalPolicy();
  const commandKey = String(command || "").trim().toLowerCase();
  const commandPolicy = policy.commands[commandKey] || null;
  let approval = commandPolicy?.approval || policy.defaultApproval;
  let key = commandKey;
  const firstArg = String(args[0] || "").trim().toLowerCase();
  if (firstArg && commandPolicy?.firstArgPolicies?.[firstArg]) {
    const sub = commandPolicy.firstArgPolicies[firstArg];
    approval = sub.approval || approval;
    key = `${commandKey}:${firstArg}`;
  }
  return {
    approval: approval === "none" ? "none" : "required",
    key,
  };
}

function getToolApprovalSessionSet(sessionId, create = false) {
  const normalized = normalizeLlmExecutionSessionId(sessionId);
  if (!normalized) return null;
  let current = toolApprovedKeysBySessionId.get(normalized);
  if (!current && create) {
    if (toolApprovedKeysBySessionId.size >= TOOL_APPROVAL_CACHE_MAX_SESSIONS) {
      const firstKey = toolApprovedKeysBySessionId.keys().next().value;
      if (firstKey) {
        toolApprovedKeysBySessionId.delete(firstKey);
      }
    }
    current = new Set();
    toolApprovedKeysBySessionId.set(normalized, current);
  }
  return current || null;
}

function hasToolApprovalInSession(sessionId, approvalKey) {
  const key = String(approvalKey || "").trim();
  if (!key) return false;
  const set = getToolApprovalSessionSet(sessionId, false);
  return Boolean(set && set.has(key));
}

function rememberToolApprovalInSession(sessionId, approvalKey) {
  const key = String(approvalKey || "").trim();
  if (!key) return;
  const set = getToolApprovalSessionSet(sessionId, true);
  if (!set) return;
  set.add(key);
}

async function resolveSandboxedRunApprovalPolicy(command, args = []) {
  const commandKey = String(command || "").trim().toLowerCase();
  if (!commandKey) {
    return { approval: "required", key: "" };
  }
  if (commandKey === "toolrun") {
    return resolveCommandApprovalPolicyForCommand(commandKey, args);
  }
  if (SANDBOXED_RUN_AUTO_APPROVE_COMMANDS.has(commandKey)) {
    return { approval: "none", key: commandKey };
  }
  const firstArg = String(args[0] || "").trim().toLowerCase();
  return {
    approval: "required",
    key: firstArg ? `${commandKey}:${firstArg}` : commandKey,
  };
}

function isPathInsideRoot(root, target) {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  const rel = path.relative(normalizedRoot, normalizedTarget);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function getWorkspaceRealPath() {
  if (!workspaceRealPathPromise) {
    workspaceRealPathPromise = fs.realpath(WORKSPACE_ROOT).catch(() => WORKSPACE_ROOT);
  }
  return workspaceRealPathPromise;
}

async function pathExists(absPath) {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

function summarizeValueForAudit(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 2) return "[truncated]";
  if (typeof value === "string") {
    if (value.length <= 180) return value;
    return `${value.slice(0, 180)}...[${value.length} chars]`;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => summarizeValueForAudit(item, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "content" || k === "audioUrl") {
        out[k] = typeof v === "string" ? `[redacted:${v.length}]` : "[redacted]";
        continue;
      }
      out[k] = summarizeValueForAudit(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function extractYouTubeVideoIdsFromToolResult(toolName, normalizedArgs, output) {
  const normalizedToolName = String(toolName || "").trim();
  if (normalizedToolName !== "run_command_sandboxed") return [];
  const command = String(normalizedArgs?.command || "").trim().toLowerCase();
  const args = Array.isArray(normalizedArgs?.args) ? normalizedArgs.args.map((item) => String(item || "").trim().toLowerCase()) : [];
  if (command !== "toolrun") return [];
  const toolrunToolName = String(args[0] || "");
  if (
    toolrunToolName !== "youtube_search" &&
    toolrunToolName !== "youtube_channel_latest" &&
    toolrunToolName !== "youtube_favorites"
  ) return [];

  const stdout = String(output?.result?.stdout || "").trim();
  if (!stdout) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  const out = [];
  const seen = new Set();
  for (const item of results) {
    const videoId = String(item?.videoId || "").trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
    if (seen.has(videoId)) continue;
    seen.add(videoId);
    out.push(videoId);
  }
  return out;
}

function extractMediaControlFromToolResult(toolName, output) {
  const normalizedToolName = String(toolName || "").trim();
  if (normalizedToolName !== "media") return null;
  const result = output?.result && typeof output.result === "object" ? output.result : null;
  const action = String(result?.action || "").trim().toLowerCase();
  if (action !== "stop" && action !== "next" && action !== "prev") return null;
  const target = String(result?.target || "").trim().toLowerCase();
  if (target !== "all" && target !== "youtube" && target !== "tts") return null;
  const reason = String(result?.reason || "").trim();
  return {
    action,
    target,
    reason: reason || undefined,
  };
}

function classifyToolCategory(toolName) {
  const name = String(toolName || "").trim();
  if (
    name === "list_dir" ||
    name === "find_files" ||
    name === "search_text" ||
    name === "read_file" ||
    name === "read_file_range"
  ) {
    return "observe";
  }
  if (
    name === "apply_patch" ||
    name === "write_file" ||
    name === "edit_file"
  ) {
    return "edit";
  }
  if (name === "run_tests") {
    return "verify";
  }
  if (name === "git_diff") {
    return "diff";
  }
  return "safety";
}

function normalizeReplyExecutionRequestForLog(req) {
  const normalized = req && typeof req === "object" ? req : {};
  const codexOptions = normalized.codexOptions && typeof normalized.codexOptions === "object"
    ? normalized.codexOptions
    : {};
  const modelInfo = codexOptions.modelInfo && typeof codexOptions.modelInfo === "object"
    ? codexOptions.modelInfo
    : {};
  const messages = Array.isArray(normalized.messages) ? normalized.messages : [];
  return {
    transcript: String(normalized.transcript || ""),
    systemPrompt: String(normalized.systemPrompt || ""),
    directory: String(normalized.rootDir || ""),
    rootDir: String(normalized.rootDir || ""),
    sessionId: String(normalized.sessionId || ""),
    messages,
    modelRef: String(modelInfo.modelRef || ""),
    model: String(modelInfo.model || ""),
    reasoningEffort: String(codexOptions.reasoningEffort || ""),
  };
}

async function pruneOldJsonlFiles(logDir, keepCount, preservePath = "") {
  if (!logDir) return;
  const resolvedPreservePath = preservePath ? path.resolve(preservePath) : "";
  const maxKeepCount = Math.max(0, Math.floor(Number(keepCount || 0)));
  let entries = [];
  try {
    entries = await fs.readdir(logDir, { withFileTypes: true });
  } catch {
    return;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".jsonl")) continue;
    const absPath = path.join(logDir, entry.name);
    try {
      const stat = await fs.stat(absPath);
      files.push({
        absPath,
        mtimeMs: Number(stat.mtimeMs || 0),
        name: entry.name,
      });
    } catch {}
  }
  files.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return b.name.localeCompare(a.name);
  });
  const stale = files.slice(maxKeepCount);
  for (const item of stale) {
    if (resolvedPreservePath && item.absPath === resolvedPreservePath) continue;
    try {
      await fs.unlink(item.absPath);
    } catch {}
  }
}

async function ensureLlmRequestLogInitialized() {
  if (!LLM_REQUEST_LOG_ENABLED) return;
  if (!llmRequestLogInitPromise) {
    llmRequestLogInitPromise = (async () => {
      await fs.mkdir(LLM_REQUEST_LOG_DIR, { recursive: true });
      await pruneOldJsonlFiles(LLM_REQUEST_LOG_DIR, LLM_REQUEST_LOG_MAX_FILES - 1, LLM_REQUEST_LOG_PATH);
      const sessionEntry = {
        type: "session_started",
        timestamp: RUNNER_SESSION_STARTED_AT.toISOString(),
        startedAt: RUNNER_SESSION_STARTED_AT.toISOString(),
        sessionFile: path.basename(LLM_REQUEST_LOG_PATH),
        pid: process.pid,
      };
      await fs.appendFile(LLM_REQUEST_LOG_PATH, `${JSON.stringify(sessionEntry)}\n`, "utf8");
    })().catch((err) => {
      llmRequestLogInitPromise = null;
      throw err;
    });
  }
  return llmRequestLogInitPromise;
}

function appendLlmRequestLog(entry) {
  if (!LLM_REQUEST_LOG_ENABLED) return Promise.resolve();
  const payload = entry && typeof entry === "object" ? entry : { message: String(entry || "") };
  llmRequestLogWriteQueue = llmRequestLogWriteQueue
    .then(async () => {
      await ensureLlmRequestLogInitialized();
      await fs.appendFile(
        LLM_REQUEST_LOG_PATH,
        `${JSON.stringify({ timestamp: new Date().toISOString(), ...payload })}\n`,
        "utf8"
      );
    })
    .catch((err) => {
      console.error("[llm-request-log] failed", err);
    });
  return llmRequestLogWriteQueue;
}

async function appendLlmToolAuditLog(entry) {
  const dir = path.dirname(LLM_FILE_AUDIT_LOG_PATH);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(LLM_FILE_AUDIT_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
}

function truncateClientLogString(raw, max = CLIENT_APP_LOG_MAX_STRING_CHARS) {
  const text = String(raw || "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...(truncated:${text.length - max})`;
}

function sanitizeClientLogValue(raw, depth = 0) {
  if (raw === null || raw === undefined) return raw;
  if (typeof raw === "string") return truncateClientLogString(raw);
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "boolean") return raw;
  if (depth >= 4) return truncateClientLogString(raw);
  if (Array.isArray(raw)) {
    return raw.slice(0, 64).map((item) => sanitizeClientLogValue(item, depth + 1));
  }
  if (typeof raw === "object") {
    const entries = Object.entries(raw).slice(0, 80);
    const out = {};
    for (const [key, value] of entries) {
      out[String(key)] = sanitizeClientLogValue(value, depth + 1);
    }
    return out;
  }
  return truncateClientLogString(raw);
}

function pickClientSendTracePayloadField(payload, key) {
  if (!payload || typeof payload !== "object") return "";
  const value = payload[key];
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value || "").trim();
}

function logClientSendTrace(source, sessionId, event) {
  if (String(source || "").trim() !== "session_diag") return;
  if (!CLIENT_APP_LOG_SEND_TRACE_EVENTS.has(String(event?.event || ""))) return;
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  const requestTraceId = pickClientSendTracePayloadField(payload, "requestTraceId");
  const panelId = pickClientSendTracePayloadField(payload, "panelId");
  const action = pickClientSendTracePayloadField(payload, "action");
  const reason = pickClientSendTracePayloadField(payload, "reason");
  const requestSeq = pickClientSendTracePayloadField(payload, "requestSeq");
  const transcriptChars = pickClientSendTracePayloadField(payload, "transcriptChars");
  const parts = [
    `event=${event.event}`,
    panelId ? `panel=${panelId}` : "",
    action ? `action=${action}` : "",
    reason ? `reason=${reason}` : "",
    requestTraceId ? `trace=${requestTraceId}` : "",
    requestSeq ? `seq=${requestSeq}` : "",
    transcriptChars ? `chars=${transcriptChars}` : "",
    sessionId ? `session=${sessionId}` : "",
  ].filter(Boolean);
  console.info(`[client-send-diag] ${parts.join(" ")}`);
}

function normalizeClientAppLogEvent(raw, index = 0) {
  const item = raw && typeof raw === "object" ? raw : {};
  const seqRaw = Number(item.seq);
  const seq = Number.isFinite(seqRaw) ? Math.max(0, Math.floor(seqRaw)) : index + 1;
  const event = truncateClientLogString(item.event || "unknown", CLIENT_APP_LOG_MAX_EVENT_NAME_CHARS);
  const atRaw = String(item.at || "").trim();
  const at = atRaw || new Date().toISOString();
  return {
    seq,
    at,
    event,
    payload: sanitizeClientLogValue(item.payload && typeof item.payload === "object" ? item.payload : {}),
    screen: truncateClientLogString(item.screen || "", 24),
    autoEnabled: Boolean(item.autoEnabled),
    autoState: truncateClientLogString(item.autoState || "", 32),
    autoEvent: truncateClientLogString(item.autoEvent || "", 64),
    ttsPlaying: Boolean(item.ttsPlaying),
    ttsLoading: Boolean(item.ttsLoading),
    replyLoading: Boolean(item.replyLoading),
  };
}

const SESSION_DIAG_DETAIL_EVENTS = new Set([
  "session_open_perf_thread_read_done",
  "session_open_perf_messages_hydrated",
  "session_open_perf_state_apply_queued",
  "session_open_perf_mark_read_async_done",
  "session_open_perf_mark_read_async_error",
]);

function shouldPersistClientAppLogEvent(sourceRaw, eventRaw) {
  const source = String(sourceRaw || "").trim();
  if (source !== "session_diag") return true;
  if (CLIENT_APP_LOG_SESSION_DIAG_DETAIL_ENABLED) return true;
  const eventName = String(eventRaw || "").trim();
  return !SESSION_DIAG_DETAIL_EVENTS.has(eventName);
}

async function ensureClientAppLogInitialized() {
  if (!clientAppLogInitPromise) {
    clientAppLogInitPromise = (async () => {
      await fs.mkdir(CLIENT_APP_LOG_DIR, { recursive: true });
      await pruneOldJsonlFiles(CLIENT_APP_LOG_DIR, CLIENT_APP_LOG_MAX_FILES - 1, CLIENT_APP_LOG_PATH);
    })().catch((err) => {
      clientAppLogInitPromise = null;
      throw err;
    });
  }
  return clientAppLogInitPromise;
}

function appendClientAppLogs(entry) {
  const payload = entry && typeof entry === "object" ? entry : {};
  clientAppLogWriteQueue = clientAppLogWriteQueue
    .then(async () => {
      const eventsRaw = Array.isArray(payload.events) ? payload.events : [];
      if (eventsRaw.length <= 0) return;
      const source = truncateClientLogString(payload.source || "unknown", 48);
      const events = eventsRaw
        .slice(0, CLIENT_APP_LOG_MAX_EVENTS_PER_REQUEST)
        .map((item, index) => normalizeClientAppLogEvent(item, index))
        .filter((item) => shouldPersistClientAppLogEvent(source, item.event));
      if (events.length <= 0) return;
      await ensureClientAppLogInitialized();
      const base = {
        timestamp: new Date().toISOString(),
        source,
        sessionId: truncateClientLogString(payload.sessionId || "", 80),
        device: truncateClientLogString(payload.device || "", 80),
        remoteAddress: truncateClientLogString(payload.remoteAddress || "", 80),
      };
      const lines = events.map((event) => JSON.stringify({
        ...base,
        ...event,
      }));
      for (const event of events) {
        logClientSendTrace(source, base.sessionId, event);
      }
      await fs.appendFile(CLIENT_APP_LOG_PATH, `${lines.join("\n")}\n`, "utf8");
    })
    .catch((err) => {
      console.error("[client-app-log] failed", err);
    });
  return clientAppLogWriteQueue;
}

async function ensureCodexWsProxyDebugLogInitialized() {
  if (!codexWsProxyDebugLogInitPromise) {
    codexWsProxyDebugLogInitPromise = (async () => {
      await fs.mkdir(CODEX_WS_PROXY_DEBUG_LOG_DIR, { recursive: true });
      await pruneOldJsonlFiles(
        CODEX_WS_PROXY_DEBUG_LOG_DIR,
        CODEX_WS_PROXY_DEBUG_LOG_MAX_FILES - 1,
        CODEX_WS_PROXY_DEBUG_LOG_PATH
      );
    })().catch((err) => {
      codexWsProxyDebugLogInitPromise = null;
      throw err;
    });
  }
  return codexWsProxyDebugLogInitPromise;
}

function appendCodexWsProxyDebug(event, payload = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    event: truncateClientLogString(event || "unknown", 80),
    payload: sanitizeClientLogValue(payload && typeof payload === "object" ? payload : {}),
  };
  codexWsProxyDebugBuffer.push(entry);
  if (codexWsProxyDebugBuffer.length > CODEX_WS_PROXY_DEBUG_BUFFER_MAX) {
    codexWsProxyDebugBuffer.splice(0, codexWsProxyDebugBuffer.length - CODEX_WS_PROXY_DEBUG_BUFFER_MAX);
  }
  codexWsProxyDebugWriteQueue = codexWsProxyDebugWriteQueue
    .then(async () => {
      await ensureCodexWsProxyDebugLogInitialized();
      await fs.appendFile(CODEX_WS_PROXY_DEBUG_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
    })
    .catch((err) => {
      console.error("[codex-ws-debug] failed", err);
    });
  return codexWsProxyDebugWriteQueue;
}

function listCodexWsProxyDebug(limitRaw) {
  const raw = Number(limitRaw);
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(200, Math.floor(raw))) : 50;
  return codexWsProxyDebugBuffer.slice(-limit);
}

function isProbablyBinary(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  let suspicious = 0;
  for (const b of sample) {
    if (b === 0) return true;
    if (b < 7 || (b > 14 && b < 32)) suspicious += 1;
  }
  return suspicious / sample.length > 0.2;
}

function escapeRegExp(raw) {
  return String(raw || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeUrl(raw) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(raw || "").trim());
}

function buildCommandPreview(command, args = []) {
  const cmd = String(command || "").trim();
  const rawArgs = Array.isArray(args) ? args : [];
  const joined = [cmd, ...rawArgs.map((item) => String(item || ""))]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (joined.length <= 180) return joined;
  return `${joined.slice(0, 180)}...`;
}

function buildCommandExecutionEnv(opts = {}) {
  const env = { ...process.env };
  const rawPath = String(env.PATH || "");
  const entries = rawPath
    .split(path.delimiter)
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (!entries.includes(COMMAND_EXEC_BIN_DIR)) {
    entries.unshift(COMMAND_EXEC_BIN_DIR);
  }
  env.PATH = entries.join(path.delimiter);
  const llmSessionId = normalizeLlmExecutionSessionId(opts.llmSessionId);
  if (llmSessionId) {
    env.YOUTUBE_FAVORITES_SESSION_ID = llmSessionId;
  } else {
    delete env.YOUTUBE_FAVORITES_SESSION_ID;
  }
  return env;
}

function makeToolError(code, message, details = {}) {
  const err = new Error(String(message || "tool failed"));
  err.toolErrorCode = String(code || "tool_error");
  err.toolErrorDetails = details && typeof details === "object" ? details : {};
  return err;
}

async function resolveToolRoot(rawRootDir, opts = {}) {
  const rootInput = String(rawRootDir || "").trim();
  const rootAbs = rootInput
    ? (path.isAbsolute(rootInput) ? path.resolve(rootInput) : path.resolve(WORKSPACE_ROOT, rootInput))
    : DEFAULT_LLM_FILE_ROOT;
  if (opts.create !== false) {
    await fs.mkdir(rootAbs, { recursive: true });
  }
  const rootReal = await fs.realpath(rootAbs);
  const workspaceReal = await getWorkspaceRealPath();
  return {
    rootAbs,
    rootReal,
    workspaceReal,
    relativeRoot: toDirectoryHandlePath(workspaceReal, rootReal),
  };
}

async function resolvePathWithinToolRoot(rootReal, rawPath, opts = {}) {
  const defaultPath = opts.defaultPath || ".";
  const requested = rawPath === undefined || rawPath === null || rawPath === ""
    ? defaultPath
    : String(rawPath);
  if (requested.includes("\u0000")) {
    throw new Error("path must not include NUL");
  }
  if (path.isAbsolute(requested)) {
    throw new Error("path must be relative");
  }
  const absPath = path.resolve(rootReal, requested);
  if (!isPathInsideRoot(rootReal, absPath)) {
    throw new Error("path escapes root directory");
  }
  if (opts.allowMissing) {
    const parentAbs = path.dirname(absPath);
    if (opts.ensureParentDir) {
      await fs.mkdir(parentAbs, { recursive: true });
    }
    const parentReal = await fs.realpath(parentAbs);
    if (!isPathInsideRoot(rootReal, parentReal)) {
      throw new Error("path parent escapes root directory");
    }
    try {
      const realPath = await fs.realpath(absPath);
      if (!isPathInsideRoot(rootReal, realPath)) {
        throw new Error("path escapes root directory by symlink");
      }
      return {
        absPath,
        realPath,
        exists: true,
        relativePath: toUnixPath(path.relative(rootReal, realPath)) || ".",
      };
    } catch (err) {
      if (err && typeof err === "object" && err.code === "ENOENT") {
        return {
          absPath,
          realPath: absPath,
          exists: false,
          relativePath: toUnixPath(path.relative(rootReal, absPath)) || ".",
        };
      }
      throw err;
    }
  }

  const realPath = await fs.realpath(absPath);
  if (!isPathInsideRoot(rootReal, realPath)) {
    throw new Error("path escapes root directory by symlink");
  }
  return {
    absPath,
    realPath,
    exists: true,
    relativePath: toUnixPath(path.relative(rootReal, realPath)) || ".",
  };
}

function classifyPathResolutionError(err) {
  const msg = String(err instanceof Error ? err.message : err || "").toLowerCase();
  if (!msg) return "path_resolution_failed";
  if (msg.includes("path must not include nul")) return "path_contains_nul";
  if (msg.includes("path must be relative")) return "path_not_relative";
  if (msg.includes("escapes root directory")) return "path_escapes_root";
  if (msg.includes("path parent escapes root directory")) return "path_parent_escapes_root";
  return "path_resolution_failed";
}

function classifyFsError(err, fallback = "filesystem_error") {
  const code = String(err?.code || "").toUpperCase();
  if (code === "ENOENT") return "not_found";
  if (code === "EISDIR") return "not_a_file";
  if (code === "ENOTDIR") return "not_a_directory";
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  if (code === "EMFILE" || code === "ENFILE") return "too_many_open_files";
  return fallback;
}

function normalizeToolExecutionError(err, fallbackCode, fallbackMessage, details = {}) {
  if (err && typeof err === "object" && typeof err.toolErrorCode === "string") {
    return {
      code: err.toolErrorCode,
      message: err instanceof Error ? err.message : String(err),
      details: err.toolErrorDetails && typeof err.toolErrorDetails === "object" ? err.toolErrorDetails : details,
    };
  }
  return {
    code: fallbackCode,
    message: err instanceof Error ? err.message : String(err || fallbackMessage || fallbackCode),
    details,
  };
}

const {
  runFindFilesTool,
  runListDirTool,
  runReadFileTool,
  runSearchTextTool,
} = createLlmFileBrowseTools({
  classifyFsError,
  classifyPathResolutionError,
  clamp,
  escapeRegExp,
  globMatcherVersion: LLM_FILE_GLOB_MATCHER_VERSION,
  isProbablyBinary,
  makeToolError,
  maxEditFileBytes: LLM_FILE_MAX_EDIT_FILE_BYTES,
  maxFindResults: LLM_FILE_MAX_FIND_RESULTS,
  maxReadBytes: LLM_FILE_MAX_READ_BYTES,
  maxScanFiles: LLM_FILE_MAX_SCAN_FILES,
  maxSearchResults: LLM_FILE_MAX_SEARCH_RESULTS,
  normalizeToolExecutionError,
  readDefaultBytes: LLM_FILE_DEFAULT_READ_BYTES,
  resolvePathWithinToolRoot,
  toUnixPath,
});

async function resolveClientFilePath(rawPath, rawRootDir = "") {
  const requestedPath = String(rawPath || "").trim();
  if (!requestedPath) {
    throw makeApiError(400, "path_required", "path is required");
  }
  const workspaceReal = await getWorkspaceRealPath();
  const rootInput = String(rawRootDir || "").trim();
  try {
    const rootReal = rootInput
      ? (await resolveToolRoot(rootInput, { create: false })).rootReal
      : workspaceReal;
    if (path.isAbsolute(requestedPath)) {
      const targetReal = await fs.realpath(path.resolve(requestedPath));
      if (!isPathInsideRoot(rootReal, targetReal)) {
        throw new Error("path escapes root directory");
      }
      return {
        realPath: targetReal,
        rootReal,
        relativePath: toUnixPath(path.relative(rootReal, targetReal)) || ".",
      };
    }
    const workspaceCandidate = await fs.realpath(path.resolve(workspaceReal, requestedPath)).catch(() => "");
    if (workspaceCandidate && isPathInsideRoot(rootReal, workspaceCandidate)) {
      return {
        realPath: workspaceCandidate,
        rootReal,
        relativePath: toUnixPath(path.relative(rootReal, workspaceCandidate)) || ".",
      };
    }
    return {
      ...await resolvePathWithinToolRoot(rootReal, requestedPath, { defaultPath: "." }),
      rootReal,
    };
  } catch (err) {
    throw makeApiError(400, classifyPathResolutionError(err), errorMessage(err));
  }
}

async function readClientTextFile(rawPath, rawRootDir = "") {
  const resolved = await resolveClientFilePath(rawPath, rawRootDir);
  let stat;
  try {
    stat = await fs.stat(resolved.realPath);
  } catch (err) {
    const code = classifyFsError(err, "read_stat_failed");
    throw makeApiError(code === "not_found" ? 404 : 400, code, errorMessage(err));
  }
  if (!stat.isFile()) {
    throw makeApiError(400, "not_a_file", "path is not a file");
  }
  if (stat.size > CLIENT_FILE_CONTENT_MAX_BYTES) {
    throw makeApiError(413, "file_too_large", `file is larger than ${CLIENT_FILE_CONTENT_MAX_BYTES} bytes`, {
      path: resolved.relativePath,
      totalBytes: stat.size,
      maxBytes: CLIENT_FILE_CONTENT_MAX_BYTES,
    });
  }
  const content = await fs.readFile(resolved.realPath);
  if (content.length > CLIENT_FILE_CONTENT_MAX_BYTES) {
    throw makeApiError(413, "file_too_large", `file is larger than ${CLIENT_FILE_CONTENT_MAX_BYTES} bytes`, {
      path: resolved.relativePath,
      totalBytes: content.length,
      maxBytes: CLIENT_FILE_CONTENT_MAX_BYTES,
    });
  }
  if (isProbablyBinary(content)) {
    throw makeApiError(400, "binary_file", "binary files cannot be copied as text", {
      path: resolved.relativePath,
    });
  }
  return {
    ok: true,
    path: resolved.relativePath,
    bytesRead: content.length,
    totalBytes: content.length,
    content: content.toString("utf8"),
  };
}

async function sendClientMediaFile(req, res, rawPath, rawRootDir = "") {
  const resolved = await resolveClientFilePath(rawPath, rawRootDir);
  let stat;
  try {
    stat = await fs.stat(resolved.realPath);
  } catch (err) {
    const code = classifyFsError(err, "read_stat_failed");
    throw makeApiError(code === "not_found" ? 404 : 400, code, errorMessage(err));
  }
  if (!stat.isFile()) {
    throw makeApiError(400, "not_a_file", "path is not a file");
  }
  const mimeType = getClientMediaMimeType(resolved.realPath);
  if (!mimeType) {
    throw makeApiError(415, "unsupported_media_type", "file is not a supported media type");
  }

  const totalBytes = Number(stat.size || 0);
  const fileName = path.basename(resolved.realPath);
  const baseHeaders = {
    "content-type": mimeType,
    "content-disposition": buildInlineContentDisposition(fileName),
    "cache-control": "no-store",
    "accept-ranges": "bytes",
  };
  if (totalBytes <= 0) {
    res.writeHead(200, {
      ...baseHeaders,
      "content-length": "0",
    });
    res.end();
    return;
  }
  const rangeHeader = String(req.headers.range || "").trim();
  let statusCode = 200;
  let start = 0;
  let end = Math.max(0, totalBytes - 1);

  if (rangeHeader) {
    const range = parseSingleByteRange(rangeHeader, totalBytes);
    if (!range) {
      res.writeHead(416, {
        ...baseHeaders,
        "content-range": `bytes */${totalBytes}`,
        "content-length": "0",
      });
      res.end();
      return;
    }
    statusCode = 206;
    start = range.start;
    end = range.end;
  }

  const contentLength = Math.max(0, end - start + 1);
  res.writeHead(statusCode, {
    ...baseHeaders,
    "content-length": String(contentLength),
    ...(statusCode === 206 ? { "content-range": `bytes ${start}-${end}/${totalBytes}` } : {}),
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(resolved.realPath, { start, end });
  stream.on("error", (err) => {
    console.error("[files/media] stream failed", err);
    res.destroy(err);
  });
  stream.pipe(res);
}

const {
  runApplyPatchTool,
  runReadFileRangeTool,
} = createLlmFilePatchTools({
  classifyFsError,
  classifyPathResolutionError,
  isProbablyBinary,
  makeToolError,
  maxReadLines: LLM_FILE_MAX_READ_LINES,
  resolvePathWithinToolRoot,
  toUnixPath,
});

const {
  runCommandSandboxedTool,
  runEditFileTool,
  runGitDiffTool,
  runMediaTool,
  runTestsTool,
  runWriteFileTool,
} = createLlmFileExecutionTools({
  buildCommandExecutionEnv,
  buildCommandPreview,
  clamp,
  isPathInsideRoot,
  isProbablyBinary,
  makeToolError,
  maxEditFileBytes: LLM_FILE_MAX_EDIT_FILE_BYTES,
  pathExists,
  resolvePathWithinToolRoot,
  resolveSandboxedRunApprovalPolicy,
  runCommandWithCapture,
  runTestsDefaultTimeoutMs: RUN_TESTS_DEFAULT_TIMEOUT_MS,
  runTestsMaxTimeoutMs: RUN_TESTS_MAX_TIMEOUT_MS,
  sandboxedRunAllowedCommands: SANDBOXED_RUN_ALLOWED_COMMANDS,
  sandboxedRunDefaultTimeoutMs: SANDBOXED_RUN_DEFAULT_TIMEOUT_MS,
  sandboxedRunDenyCommands: SANDBOXED_RUN_DENY_COMMANDS,
  sandboxedRunMaxArgLength: SANDBOXED_RUN_MAX_ARG_LENGTH,
  sandboxedRunMaxArgs: SANDBOXED_RUN_MAX_ARGS,
  sandboxedRunMaxOutputBytes: SANDBOXED_RUN_MAX_OUTPUT_BYTES,
  sandboxedRunMaxTimeoutMs: SANDBOXED_RUN_MAX_TIMEOUT_MS,
  splitCommandLine,
  toUnixPath,
});

function normalizeToolPathArg(rawPath, ctx = {}) {
  if (rawPath === undefined || rawPath === null) return rawPath;
  const original = String(rawPath);
  if (!original.trim()) return "";
  let normalized = original.trim().replace(/\\/g, "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  const aliases = Array.isArray(ctx.rootPathAliases) ? ctx.rootPathAliases : [];
  for (const aliasRaw of aliases) {
    const alias = String(aliasRaw || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, "");
    if (!alias) continue;
    if (normalized === alias) return ".";
    if (normalized.startsWith(`${alias}/`)) {
      return normalized.slice(alias.length + 1);
    }
  }
  return normalized;
}

function normalizeToolArgsForExecution(rawArgs, ctx = {}) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
  const normalizedArgs = { ...args };
  if (Object.prototype.hasOwnProperty.call(normalizedArgs, "path")) {
    normalizedArgs.path = normalizeToolPathArg(normalizedArgs.path, ctx);
  }
  if (Object.prototype.hasOwnProperty.call(normalizedArgs, "cwd")) {
    normalizedArgs.cwd = normalizeToolPathArg(normalizedArgs.cwd, ctx);
  }
  return normalizedArgs;
}

async function executeLlmFileToolCall(name, rawArgs, ctx, opts = {}) {
  const normalizedArgs = opts.normalizedArgs && typeof opts.normalizedArgs === "object"
    ? opts.normalizedArgs
    : normalizeToolArgsForExecution(rawArgs, ctx);
  if (name === "list_dir") return runListDirTool(normalizedArgs, ctx);
  if (name === "find_files") return runFindFilesTool(normalizedArgs, ctx);
  if (name === "search_text") return runSearchTextTool(normalizedArgs, ctx);
  if (name === "read_file_range") return runReadFileRangeTool(normalizedArgs, ctx);
  if (name === "apply_patch") return runApplyPatchTool(normalizedArgs, ctx);
  if (name === "run_tests") return runTestsTool(normalizedArgs, ctx);
  if (name === "run_command_sandboxed") return runCommandSandboxedTool(normalizedArgs, ctx, opts);
  if (name === "git_diff") return runGitDiffTool(normalizedArgs, ctx);
  if (name === "read_file") return runReadFileTool(normalizedArgs, ctx);
  if (name === "write_file") {
    if (!LLM_FILE_ENABLE_LEGACY_WRITE_TOOLS) throw new Error("unsupported tool: write_file");
    return runWriteFileTool(normalizedArgs, ctx);
  }
  if (name === "edit_file") {
    if (!LLM_FILE_ENABLE_LEGACY_WRITE_TOOLS) throw new Error("unsupported tool: edit_file");
    return runEditFileTool(normalizedArgs, ctx);
  }
  if (name === "media") return runMediaTool(normalizedArgs, ctx);
  throw new Error(`unsupported tool: ${name}`);
}

function extractResponseOutputItems(responsePayload) {
  if (Array.isArray(responsePayload?.output)) return responsePayload.output;
  if (Array.isArray(responsePayload?.response?.output)) return responsePayload.response.output;
  return [];
}

function summarizeResponsePayloadForDebug(responsePayload) {
  const payload = responsePayload && typeof responsePayload === "object" ? responsePayload : {};
  const items = extractResponseOutputItems(payload);
  const itemTypes = items.map((item) => String(item?.type || "?"));
  const messageContentTypes = [];
  for (const item of items) {
    if (item?.type !== "message") continue;
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      messageContentTypes.push(String(c?.type || "?"));
    }
  }
  const snapshot = {
    topKeys: Object.keys(payload || {}).slice(0, 24),
    id: String(payload?.id || ""),
    object: String(payload?.object || ""),
    status: String(payload?.status || ""),
    model: String(payload?.model || ""),
    error: payload?.error || null,
    incompleteDetails: payload?.incomplete_details || null,
    outputTextType: typeof payload?.output_text,
    outputTextPreview: typeof payload?.output_text === "string" ? payload.output_text.slice(0, 120) : "",
    outputLength: items.length,
    outputItemTypes: itemTypes.slice(0, 24),
    messageContentTypes: messageContentTypes.slice(0, 40),
  };
  try {
    return JSON.stringify(snapshot);
  } catch {
    return String(snapshot);
  }
}

function extractResponseOutputText(responsePayload) {
  const directOutputText = responsePayload?.output_text;
  if (typeof directOutputText === "string" && directOutputText.trim()) {
    return directOutputText.trim();
  }
  const nestedOutputText = responsePayload?.response?.output_text;
  if (typeof nestedOutputText === "string" && nestedOutputText.trim()) {
    return nestedOutputText.trim();
  }
  const items = extractResponseOutputItems(responsePayload);
  const chunks = [];
  for (const item of items) {
    if (item?.type === "message") {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const c of content) {
        if (typeof c?.text === "string" && c.text) {
          chunks.push(c.text);
          continue;
        }
        if (typeof c?.output_text === "string" && c.output_text) {
          chunks.push(c.output_text);
          continue;
        }
        if (typeof c?.refusal === "string" && c.refusal) {
          chunks.push(c.refusal);
        }
      }
      continue;
    }
    if (item?.type === "refusal" && typeof item?.refusal === "string" && item.refusal) {
      chunks.push(item.refusal);
      continue;
    }
    if (item?.type === "output_text" && typeof item?.text === "string" && item.text) {
      chunks.push(item.text);
      continue;
    }
    if (typeof item?.output_text === "string" && item.output_text) {
      chunks.push(item.output_text);
      continue;
    }
    if (typeof item?.text === "string" && item.text) {
      chunks.push(item.text);
    }
  }
  return chunks.join("").trim();
}

function extractResponseFunctionCalls(responsePayload) {
  const items = extractResponseOutputItems(responsePayload);
  const calls = [];
  for (const item of items) {
    if (item?.type !== "function_call") continue;
    const name = String(item?.name || "").trim();
    if (!name) continue;
    calls.push({
      name,
      callId: String(item?.call_id || item?.id || randomUUID()),
      argumentsText: typeof item?.arguments === "string"
        ? item.arguments
        : JSON.stringify(item?.arguments || {}),
    });
  }
  return calls;
}

function normalizeTokenCount(rawValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function resolveCodexModelContextWindowTokens(modelNameRaw) {
  const modelName = String(modelNameRaw || "").trim().toLowerCase();
  if (!modelName) return OPENAI_CODEX_CONTEXT_WINDOW_TOKENS_DEFAULT;
  if (OPENAI_CODEX_MODEL_CONTEXT_WINDOW_TOKENS[modelName]) {
    return OPENAI_CODEX_MODEL_CONTEXT_WINDOW_TOKENS[modelName];
  }
  for (const matcher of OPENAI_CODEX_MODEL_CONTEXT_WINDOW_MATCHERS) {
    if (modelName.startsWith(matcher.prefix)) {
      return OPENAI_CODEX_MODEL_CONTEXT_WINDOW_TOKENS[matcher.key];
    }
  }
  return OPENAI_CODEX_CONTEXT_WINDOW_TOKENS_DEFAULT;
}

function extractResponseContextUsage(responsePayload, modelNameRaw) {
  const usage = responsePayload?.usage && typeof responsePayload.usage === "object"
    ? responsePayload.usage
    : null;
  if (!usage) return null;
  const inputTokens = normalizeTokenCount(usage.input_tokens);
  const outputTokens = normalizeTokenCount(usage.output_tokens);
  const totalTokens = normalizeTokenCount(usage.total_tokens) || Math.max(0, inputTokens + outputTokens);
  const inputDetails = usage?.input_tokens_details && typeof usage.input_tokens_details === "object"
    ? usage.input_tokens_details
    : null;
  const outputDetails = usage?.output_tokens_details && typeof usage.output_tokens_details === "object"
    ? usage.output_tokens_details
    : null;
  const cachedInputTokens = normalizeTokenCount(inputDetails?.cached_tokens);
  const reasoningOutputTokens = normalizeTokenCount(outputDetails?.reasoning_tokens);
  const contextWindowTokens = resolveCodexModelContextWindowTokens(modelNameRaw);
  const usedRatio = contextWindowTokens > 0
    ? Math.max(0, Math.min(1, totalTokens / contextWindowTokens))
    : 0;
  const usedPct = Math.max(0, Math.min(100, Math.round(usedRatio * 100)));
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    contextWindowTokens,
    usedRatio,
    usedPct,
  };
}

function parseResponsePayload(rawBody) {
  const text = String(rawBody || "").trim();
  if (!text) {
    throw new Error("openai-codex responses returned empty body");
  }
  try {
    return JSON.parse(text);
  } catch {
    let lastCompleted = null;
    const outputItemsByIndex = new Map();
    const outputItemsNoIndex = [];
    const blocks = text.split(/\n\n+/);
    for (const block of blocks) {
      const parsed = parseSseEventBlock(block);
      if (!parsed?.data || parsed.data === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(parsed.data);
      } catch {
        continue;
      }
      if (
        (event?.type === "response.output_item.done" || event?.type === "response.output_item.added") &&
        event?.item &&
        typeof event.item === "object"
      ) {
        const idx = Number(event?.output_index);
        if (Number.isInteger(idx) && idx >= 0) {
          outputItemsByIndex.set(idx, event.item);
        } else {
          outputItemsNoIndex.push(event.item);
        }
      }
      if (event?.type === "response.completed" && event?.response) {
        lastCompleted = event.response;
      }
    }
    const reconstructedItems = [
      ...Array.from(outputItemsByIndex.entries())
        .sort((a, b) => a[0] - b[0])
        .map((entry) => entry[1]),
      ...outputItemsNoIndex,
    ];
    if (lastCompleted) {
      const hasOutput = Array.isArray(lastCompleted?.output) && lastCompleted.output.length > 0;
      if (!hasOutput && reconstructedItems.length > 0) {
        return {
          ...lastCompleted,
          output: reconstructedItems,
        };
      }
      return lastCompleted;
    }
    if (reconstructedItems.length > 0) {
      return {
        output: reconstructedItems,
        status: "completed",
      };
    }
    throw new Error("failed to parse openai-codex response payload");
  }
}

async function createOpenAICodexResponseJson(payload) {
  let triedAuthRefresh = false;
  let upstreamRetryCount = 0;
  while (true) {
    const auth = await refreshOAuthTokens({ force: triedAuthRefresh });
    const requestId = randomUUID();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPENAI_CODEX_TIMEOUT_MS);
    try {
      const response = await fetch(`${OPENAI_CODEX_RESPONSES_BASE_URL}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          "chatgpt-account-id": auth.accountId,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          originator: OPENAI_CODEX_ORIGINATOR,
          version: OPENAI_CODEX_VERSION,
          "x-client-request-id": requestId,
          "x-openai-codex-route": OPENAI_CODEX_ROUTE,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const rawBody = await response.text().catch(() => "");
      if (!response.ok) {
        const status = Number(response.status || 0);
        if (!triedAuthRefresh && (status === 401 || status === 403)) {
          triedAuthRefresh = true;
          continue;
        }
        if (
          isOpenAICodexRetryableStatus(status) &&
          upstreamRetryCount < OPENAI_CODEX_UPSTREAM_MAX_RETRIES
        ) {
          upstreamRetryCount += 1;
          const keepGoing = await waitForOpenAICodexRetry(`status=${status}`, upstreamRetryCount);
          if (!keepGoing) {
            throw new Error("openai-codex retry aborted");
          }
          continue;
        }
        throw new Error(`openai-codex responses failed (${status}): ${rawBody}`);
      }
      return parseResponsePayload(rawBody);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!triedAuthRefresh && isCodexAuthErrorMessage(errMsg)) {
        triedAuthRefresh = true;
        continue;
      }
      if (
        isOpenAICodexRetryableMessage(errMsg) &&
        upstreamRetryCount < OPENAI_CODEX_UPSTREAM_MAX_RETRIES
      ) {
        upstreamRetryCount += 1;
        const keepGoing = await waitForOpenAICodexRetry(errMsg, upstreamRetryCount);
        if (!keepGoing) {
          throw new Error("openai-codex retry aborted");
        }
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseSkillMeta(content, skillPathAbs) {
  const lines = String(content || "").split(/\r?\n/);
  let name = "";
  let description = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) {
      if (!name) {
        name = trimmed.replace(/^#+\s*/, "").trim();
      }
      continue;
    }
    if (!description) {
      description = trimmed.replace(/^[-*]\s*/, "").trim();
    }
    if (name && description) break;
  }
  return {
    name: name || path.basename(path.dirname(skillPathAbs)),
    description: description || "No description",
  };
}

async function findRepoRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (await pathExists(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }
    current = parent;
  }
}

function collectAncestorDirsToRoot(startDir, stopDir) {
  const out = [];
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  while (true) {
    out.push(current);
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out.reverse();
}

async function scanSkillCatalog(repoRootAbs) {
  const catalog = [];
  const stack = [repoRootAbs];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") && entry.name !== ".agents") continue;
        if (LLM_FILE_SKIP_SCAN_DIRS.has(entry.name)) continue;
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== "SKILL.md") continue;
      let content = "";
      try {
        content = await fs.readFile(fullPath, "utf8");
      } catch {
        continue;
      }
      const meta = parseSkillMeta(content, fullPath);
      catalog.push({
        name: meta.name,
        description: meta.description,
        absPath: fullPath,
        relPath: toUnixPath(path.relative(repoRootAbs, fullPath)),
      });
      if (catalog.length >= LLM_FILE_SKILL_SCAN_MAX) {
        return catalog;
      }
    }
  }
  return catalog;
}

async function loadAgentSkillContext() {
  const cwd = path.resolve(process.cwd());
  const repoRootAbs = await findRepoRoot(cwd);
  const repoRootReal = await fs.realpath(repoRootAbs).catch(() => repoRootAbs);
  const dirs = collectAncestorDirsToRoot(cwd, repoRootAbs);
  const agentDocs = [];
  for (const dir of dirs) {
    for (const fileName of ["AGENT.md", "AGENTS.md"]) {
      const absPath = path.join(dir, fileName);
      if (!(await pathExists(absPath))) continue;
      let content = "";
      try {
        content = await fs.readFile(absPath, "utf8");
      } catch {
        continue;
      }
      agentDocs.push({
        absPath,
        relPath: toUnixPath(path.relative(repoRootAbs, absPath)),
        content,
      });
    }
  }
  const skillCatalog = await scanSkillCatalog(repoRootAbs);
  return {
    cwd,
    repoRootAbs,
    repoRootReal,
    agentDocs,
    skillCatalog,
  };
}

async function getAgentSkillContext() {
  if (!agentSkillContextPromise) {
    agentSkillContextPromise = loadAgentSkillContext().catch((err) => {
      agentSkillContextPromise = null;
      throw err;
    });
  }
  return agentSkillContextPromise;
}

function renderAgentDocs(agentDocs) {
  if (!Array.isArray(agentDocs) || agentDocs.length === 0) return "";
  const blocks = [];
  for (const doc of agentDocs) {
    blocks.push(`[${doc.relPath}]`);
    blocks.push(String(doc.content || "").trim());
  }
  return blocks.join("\n\n---\n\n");
}

function renderSkillCatalogSummary(skillCatalog) {
  if (!Array.isArray(skillCatalog) || skillCatalog.length === 0) {
    return "SKILL catalog: (none)";
  }
  const lines = skillCatalog.slice(0, LLM_FILE_SKILL_SCAN_MAX).map((skill) => (
    `- ${skill.name}: ${skill.description} (${skill.relPath})`
  ));
  return `SKILL catalog:\n${lines.join("\n")}`;
}

function scoreSkillMatch(skill, userText) {
  const text = String(userText || "").toLowerCase();
  if (!text) return 0;
  let score = 0;
  const name = String(skill?.name || "").toLowerCase();
  const desc = String(skill?.description || "").toLowerCase();
  const relPath = String(skill?.relPath || "").toLowerCase();
  if (name && text.includes(name)) score += 8;
  if (relPath && text.includes(relPath)) score += 6;
  const keywords = desc
    .split(/[\s、。,.!?:;()"'`]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
    .slice(0, 8);
  for (const keyword of keywords) {
    if (text.includes(keyword)) score += 1;
  }
  return score;
}

function selectSingleBestSkill(skillCatalog, userText) {
  if (!Array.isArray(skillCatalog) || skillCatalog.length === 0) return null;
  const scored = skillCatalog.map((skill) => ({
    skill,
    score: scoreSkillMatch(skill, userText),
    depth: String(skill?.relPath || "").split("/").length,
  })).filter((item) => item.score > 0);
  if (scored.length === 0) return null;
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.depth - a.depth;
  });
  const best = scored[0];
  const second = scored[1];
  if (best.score < 4) return null;
  if (second && best.score <= second.score + 1) return null;
  return best.skill;
}

async function maybeReadSelectedSkill({ agentSkillContext, userText }) {
  const selected = selectSingleBestSkill(agentSkillContext.skillCatalog, userText);
  if (!selected) {
    return { selectedSkill: null, selectedSkillContent: "" };
  }
  const skillRealPath = await fs.realpath(selected.absPath).catch(() => selected.absPath);
  if (!isPathInsideRoot(agentSkillContext.repoRootReal, skillRealPath)) {
    return { selectedSkill: null, selectedSkillContent: "" };
  }
  const relToRepo = toUnixPath(path.relative(agentSkillContext.repoRootReal, skillRealPath));
  const readResult = await runReadFileTool(
    { path: relToRepo, offset: 0, limit: LLM_FILE_MAX_READ_BYTES },
    { rootReal: agentSkillContext.repoRootReal }
  );
  const selectedSkillContent = readResult && typeof readResult.content === "string"
    ? readResult.content
    : "";
  return {
    selectedSkill: selected,
    selectedSkillContent,
  };
}

function buildLlmFileToolInstructions({
  systemPrompt = "",
}) {
  return resolveOpenAICodexInstructions(systemPrompt);
}

function buildReplyInputText({ transcript, messages }) {
  return messages.length > 0
    ? buildPromptFromMessages(messages)
    : buildPrompt(transcript);
}

async function loadRootAgentMarkdown(rootReal) {
  const filePath = path.join(rootReal, "AGENT.md");
  let content = "";
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
  return String(content || "").trim();
}

function mergeSystemPrompts(_appSystemPrompt, rootAgentPrompt) {
  return String(rootAgentPrompt || "").trim();
}

function buildEffectiveMessages({ transcript, messages }) {
  const baseMessages = Array.isArray(messages) ? messages : [];
  const normalizedBase = baseMessages.filter((m) => (
    m &&
    (m.role === "user" || m.role === "assistant" || m.role === "system") &&
    String(m.content || "").trim()
  ));
  const conversation = normalizedBase.length > 0
    ? normalizedBase
    : (String(transcript || "").trim() ? [{ role: "user", content: String(transcript || "").trim() }] : []);
  const nonSystemMessages = conversation.filter((m) => m.role !== "system");
  return nonSystemMessages;
}

function extractLastUserText({ transcript, messages }) {
  if (messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") return messages[i].content;
    }
    return messages[messages.length - 1].content;
  }
  return transcript;
}

async function runCodexWithFileTools({
  transcript,
  messages,
  instructions,
  sessionId: requestedSessionId,
  codexOptions,
  resolvedRoot,
  requestToolApproval,
  onToolCall,
  onProgress,
  testHooks,
}) {
  const root = resolvedRoot || await resolveToolRoot("");
  const normalizedRootRel = toUnixPath(root.relativeRoot || "");
  const basenameAlias = toUnixPath(path.basename(root.rootReal || ""));
  const rootPathAliases = Array.from(
    new Set(
      [
        normalizedRootRel && normalizedRootRel !== "." ? normalizedRootRel : "",
        normalizedRootRel && !normalizedRootRel.includes("/") ? basenameAlias : "",
      ].filter(Boolean)
    )
  );
  const runnerInstructions = buildLlmFileToolInstructions({
    systemPrompt: instructions,
  });
  const inputText = buildReplyInputText({ transcript, messages });
  const initialInput = [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: inputText,
        },
      ],
    },
  ];

  const sessionId = normalizeLlmExecutionSessionId(requestedSessionId) || generateLlmExecutionSessionId();
  const toolContext = {
    rootReal: root.rootReal,
    rootPathAliases,
    sessionId,
    requestToolApproval: typeof requestToolApproval === "function"
      ? requestToolApproval
      : null,
  };
  const emitToolCall = typeof onToolCall === "function" ? onToolCall : null;
  const emitProgress = typeof onProgress === "function" ? onProgress : null;
  const createCodexResponse = typeof testHooks?.createCodexResponse === "function"
    ? testHooks.createCodexResponse
    : createOpenAICodexResponseJson;
  const executeToolCall = typeof testHooks?.executeToolCall === "function"
    ? testHooks.executeToolCall
    : executeLlmFileToolCall;
  const maxToolRounds = Number.isInteger(Number(testHooks?.maxToolRounds)) && Number(testHooks.maxToolRounds) > 0
    ? Number(testHooks.maxToolRounds)
    : llmFileMaxToolRoundsRuntime;
  const emitProgressEvent = (stage, payload = {}) => {
    if (!emitProgress) return;
    emitProgress({
      stage: String(stage || ""),
      at: new Date().toISOString(),
      ...payload,
    });
  };
  let toolCalls = 0;
  let latestContextUsage = null;
  const history = [...initialInput];

  for (let round = 0; round < maxToolRounds; round += 1) {
    const roundIndex = round + 1;
    emitProgressEvent("round_start", {
      round: roundIndex,
      maxToolRounds,
      toolCalls,
      message: `round ${roundIndex}/${maxToolRounds} started`,
    });
    const payload = {
      model: codexOptions.modelInfo.model,
      input: history,
      tools: getCodexToolDefinitions(),
      tool_choice: "auto",
      store: false,
      stream: true,
    };
    payload.instructions = runnerInstructions;
    const effort = normalizeReasoningEffort(codexOptions.reasoningEffort, { warnInvalid: false });
    if (effort) {
      payload.reasoning = { effort };
    }
    emitProgressEvent("model_request_started", {
      round: roundIndex,
      maxToolRounds,
      toolCalls,
      message: `round ${roundIndex}: waiting model response`,
    });
    void appendLlmRequestLog({
      type: "codex_request_payload",
      source: "runCodexWithFileTools",
      sessionId,
      round,
      modelRef: codexOptions.modelInfo.modelRef,
      reasoningEffort: codexOptions.reasoningEffort,
      payload,
    });
    const responsePayload = await createCodexResponse(payload);
    const contextUsage = extractResponseContextUsage(responsePayload, codexOptions?.modelInfo?.model);
    if (contextUsage) {
      latestContextUsage = contextUsage;
    }
    const functionCalls = extractResponseFunctionCalls(responsePayload);
    emitProgressEvent("model_response_received", {
      round: roundIndex,
      maxToolRounds,
      toolCalls,
      pendingToolCalls: functionCalls.length,
      message: functionCalls.length > 0
        ? `round ${roundIndex}: ${functionCalls.length} tool call(s) requested`
        : `round ${roundIndex}: final response received`,
    });
    if (functionCalls.length === 0) {
      const reply = extractResponseOutputText(responsePayload);
      if (!reply) {
        if (RUNNER_LOG_REQUESTS) {
          console.warn(`[reply-empty] payload=${summarizeResponsePayloadForDebug(responsePayload)}`);
        }
        throw new Error("openai-codex returned empty response");
      }
      emitProgressEvent("final_response_ready", {
        round: roundIndex,
        maxToolRounds,
        toolCalls,
        message: "final response ready",
      });
      return {
        reply,
        sessionId,
        rootRelativePath: root.relativeRoot,
        selectedSkillPath: "",
        toolCalls,
        contextUsage: latestContextUsage,
      };
    }

    for (const call of functionCalls) {
      toolCalls += 1;
      let args = {};
      let parseErrorMessage = "";
      let normalizedArgsForAudit = {};
      try {
        args = call.argumentsText ? JSON.parse(call.argumentsText) : {};
      } catch {
        parseErrorMessage = "tool arguments must be valid JSON";
      }
      if (!parseErrorMessage) {
        normalizedArgsForAudit = normalizeToolArgsForExecution(args, toolContext);
      }
      if (emitToolCall) {
        emitToolCall({
          phase: "start",
          toolName: call.name,
          callId: call.callId,
          argsSummary: summarizeValueForAudit(parseErrorMessage ? args : normalizedArgsForAudit),
          parseError: parseErrorMessage || undefined,
        });
      }
      emitProgressEvent("tool_start", {
        round: roundIndex,
        maxToolRounds,
        toolCalls,
        toolName: call.name,
        message: `tool ${call.name} started`,
      });
      const startedAt = Date.now();
      let status = "ok";
      let output;
      if (parseErrorMessage) {
        status = "error";
        output = {
          ok: false,
          error: "invalid_tool_arguments",
          code: "invalid_tool_arguments",
          message: parseErrorMessage,
        };
      } else {
        try {
          const result = await executeToolCall(call.name, args, toolContext, {
            callId: call.callId,
            normalizedArgs: normalizedArgsForAudit,
          });
          output = { ok: true, result };
        } catch (err) {
          status = "error";
          const normalized = normalizeToolExecutionError(
            err,
            "tool_execution_failed",
            "tool execution failed",
            {
              toolName: call.name,
            }
          );
          const normalizedMessage = String(normalized.message || "");
          const requiresStreamApproval =
            call.name === "run_command_sandboxed" &&
            /requires interactive approval over \/stream-tts/i.test(normalizedMessage);
          if (requiresStreamApproval && !toolContext.requestToolApproval) {
            throw makeApiError(
              409,
              "interactive_approval_required",
              normalizedMessage,
              {
                toolName: call.name,
                requiredEndpoint: "/stream-tts",
              }
            );
          }
          output = {
            ok: false,
            error: "tool_execution_failed",
            code: normalized.code,
            message: normalized.message,
            details: normalized.details,
          };
        }
      }
      const durationMs = Date.now() - startedAt;
      const outputObj = output && typeof output === "object" ? output : null;
      const resultCode = status === "ok"
        ? String(outputObj?.result?.code || "ok")
        : String(outputObj?.code || outputObj?.error || "tool_execution_failed");
      const toolCategory = classifyToolCategory(call.name);
      const youtubeVideoIds = status === "ok"
        ? extractYouTubeVideoIdsFromToolResult(call.name, normalizedArgsForAudit, output)
        : [];
      const mediaControl = status === "ok"
        ? extractMediaControlFromToolResult(call.name, output)
        : null;
      if (emitToolCall) {
        emitToolCall({
          phase: "done",
          toolName: call.name,
          callId: call.callId,
          status,
          durationMs,
          resultSummary: summarizeValueForAudit(output),
          youtubeVideoIds: youtubeVideoIds.length > 0 ? youtubeVideoIds : undefined,
          mediaControl: mediaControl || undefined,
          errorCode: status === "error" ? resultCode : undefined,
          errorMessage: status === "error"
            ? String(outputObj?.message || outputObj?.error || "tool_execution_failed")
            : undefined,
        });
      }
      emitProgressEvent("tool_done", {
        round: roundIndex,
        maxToolRounds,
        toolCalls,
        toolName: call.name,
        status,
        durationMs,
        message: `tool ${call.name} ${status}`,
      });
      await appendLlmToolAuditLog({
        timestamp: new Date().toISOString(),
        sessionId,
        callId: call.callId,
        toolName: call.name,
        tool_category: toolCategory,
        argsRedacted: summarizeValueForAudit(args),
        normalizedArgsRedacted: summarizeValueForAudit(normalizedArgsForAudit),
        resultSummary: summarizeValueForAudit(output),
        status,
        resultCode,
        durationMs,
        rootRelativePath: root.relativeRoot,
      }).catch((err) => {
        console.error("[llm-tool-audit] failed", err);
      });
      history.push({
        type: "function_call",
        call_id: call.callId,
        name: call.name,
        arguments: call.argumentsText,
      });
      history.push({
        type: "function_call_output",
        call_id: call.callId,
        output: JSON.stringify(output),
      });
    }
    emitProgressEvent("round_complete", {
      round: roundIndex,
      maxToolRounds,
      toolCalls,
      message: `round ${roundIndex} completed`,
    });
  }
  emitProgressEvent("tool_loop_exceeded", {
    maxToolRounds,
    toolCalls,
    message: `tool loop exceeded max rounds (${maxToolRounds})`,
  });
  throw new Error(`tool loop exceeded max rounds (${maxToolRounds})`);
}

function buildMockReplyFromRequest(req) {
  return `[mock] ${req.messages.length > 0 ? req.messages[req.messages.length - 1]?.content || "" : req.transcript}`;
}

const ASSISTANT_THINKING_PREFIX = "思考中...\n\n";

function prependAssistantThinkingText(rawText) {
  const text = String(rawText || "");
  if (text.startsWith("思考中...")) return text;
  return text ? `${ASSISTANT_THINKING_PREFIX}${text}` : ASSISTANT_THINKING_PREFIX;
}

function stripAssistantThinkingPrefix(rawText) {
  const text = String(rawText || "");
  if (text.startsWith(ASSISTANT_THINKING_PREFIX)) {
    return text.slice(ASSISTANT_THINKING_PREFIX.length);
  }
  if (text.startsWith("思考中...")) {
    return text.slice("思考中...".length).replace(/^\s+/, "");
  }
  return text;
}

function appendAssistantThinkingBodyText(baseRaw, additionRaw) {
  const base = String(baseRaw || "");
  const addition = String(additionRaw || "");
  if (!base) return prependAssistantThinkingText(addition);
  if (!addition) return base;
  if (addition.startsWith(base)) return addition;
  const additionBody = stripAssistantThinkingPrefix(addition);
  if (!additionBody) return base;
  if (base.endsWith(additionBody)) return base;
  const separator = base.endsWith("\n") || additionBody.startsWith("\n") ? "" : "\n\n";
  return `${base}${separator}${additionBody}`;
}

function buildReplyHttpPayload(result) {
  const payload = {
    reply: result.reply,
    provider: result.provider,
    route: result.route,
    modelRef: result.modelRef,
  };
  if (result.mode === "file-tools") {
    payload.rootRelativePath = result.rootRelativePath;
    payload.sessionId = result.sessionId;
    payload.selectedSkillPath = result.selectedSkillPath || undefined;
    payload.toolCalls = Number(result.toolCalls || 0);
    payload.contextUsage = result.contextUsage && typeof result.contextUsage === "object"
      ? result.contextUsage
      : undefined;
  }
  return payload;
}

async function runReplyUsecase(req, opts = {}) {
  const stream = Boolean(opts.stream);
  const onText = typeof opts.onText === "function" ? opts.onText : null;
  const onMode = typeof opts.onMode === "function" ? opts.onMode : null;
  const onToolCall = typeof opts.onToolCall === "function" ? opts.onToolCall : null;
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  const requestToolApproval = typeof opts.requestToolApproval === "function"
    ? opts.requestToolApproval
    : null;
  const signal = opts.signal;
  let validatedRoot = null;
  try {
    validatedRoot = await resolveToolRoot(req.rootDir);
  } catch (err) {
    throw makeApiError(500, "root_dir_invalid", errorMessage(err));
  }
  const rootAgentPrompt = await loadRootAgentMarkdown(validatedRoot.rootReal);
  const mergedSystemPrompt = mergeSystemPrompts(req.systemPrompt, rootAgentPrompt);
  const effectiveMessages = buildEffectiveMessages({
    transcript: req.transcript,
    messages: req.messages,
  });
  const effectiveSessionId = await resolveSessionIdForRootDir(req.sessionId, validatedRoot.relativeRoot);
  await bindSessionToRootDir(effectiveSessionId, validatedRoot.relativeRoot);
  const effectiveReq = {
    ...req,
    sessionId: effectiveSessionId,
    instructions: mergedSystemPrompt,
    messages: effectiveMessages,
  };

  if (RUNNER_MOCK) {
    const mockReplyRaw = buildMockReplyFromRequest(effectiveReq);
    const reply = prependAssistantThinkingText(mockReplyRaw);
    const sessionId = effectiveSessionId;
    const lastUserText = String(extractLastUserText({
      transcript: effectiveReq.transcript,
      messages: effectiveReq.messages,
    }) || "").trim();
    await appendAppConversationToCliRollout({
      sessionId,
      cwd: validatedRoot.rootReal,
      directory: validatedRoot.relativeRoot,
      userText: lastUserText,
      assistantText: reply,
      modelRef: "mock",
      reasoningEffort: effectiveReq.codexOptions.reasoningEffort,
    }).catch((err) => {
      console.error("[session-rollout] append failed", err);
    });
    if (stream && onMode) onMode("mock_delta");
    if (stream && onText) {
      const chunks = splitMockStreamChunks(reply);
      for (const chunk of chunks) {
        if (signal?.aborted) break;
        onText(chunk, "mock");
        await sleep(40);
      }
    }
    return {
      mode: "file-tools",
      reply,
      provider: "mock",
      route: "mock",
      modelRef: "mock",
      rootRelativePath: validatedRoot?.relativeRoot,
      toolCalls: 0,
      sessionId,
      selectedSkillPath: undefined,
      contextUsage: null,
    };
  }

  const fileResult = await runCodexWithFileTools({
    transcript: effectiveReq.transcript,
    messages: effectiveReq.messages,
    instructions: effectiveReq.instructions,
    sessionId: effectiveReq.sessionId,
    codexOptions: effectiveReq.codexOptions,
    resolvedRoot: validatedRoot,
    requestToolApproval,
    onToolCall,
    onProgress,
  });
  const lastUserText = String(extractLastUserText({
    transcript: effectiveReq.transcript,
    messages: effectiveReq.messages,
  }) || "").trim();
  await appendAppConversationToCliRollout({
    sessionId: fileResult.sessionId || effectiveSessionId,
    cwd: validatedRoot.rootReal,
    directory: validatedRoot.relativeRoot,
    userText: lastUserText,
    assistantText: prependAssistantThinkingText(String(fileResult.reply || "").trim()),
    contextUsage: fileResult.contextUsage || null,
    modelRef: effectiveReq.codexOptions.modelInfo.modelRef,
    reasoningEffort: effectiveReq.codexOptions.reasoningEffort,
  }).catch((err) => {
    console.error("[session-rollout] append failed", err);
  });
  if (stream && onMode) onMode("file_tools_pseudo");
  const reply = prependAssistantThinkingText(fileResult.reply);
  if (stream && onText) {
    const chunks = splitPseudoTextDeltas(reply);
    for (const chunk of chunks) {
      if (signal?.aborted) break;
      onText(chunk, "pseudo");
      await sleep(12);
    }
  }
  return {
    mode: "file-tools",
    reply,
    provider: OPENAI_CODEX_PROVIDER,
    route: OPENAI_CODEX_ROUTE,
    modelRef: effectiveReq.codexOptions.modelInfo.modelRef,
    rootRelativePath: fileResult.rootRelativePath || validatedRoot.relativeRoot,
    sessionId: fileResult.sessionId || effectiveSessionId,
    selectedSkillPath: fileResult.selectedSkillPath || "",
    toolCalls: fileResult.toolCalls,
    contextUsage: fileResult.contextUsage || null,
  };
}

async function handleReplyHttpEndpoint(req, res, opts = {}) {
  const logLabel = String(opts.logLabel || "reply");
  const internalErrorCode = String(opts.internalErrorCode || "runner_failed");

  try {
    const body = await readJsonBody(req);
    const normalized = normalizeReplyExecutionRequest(body);
    void appendLlmRequestLog({
      type: "app_request_normalized",
      channel: "http",
      endpoint: `/${logLabel}`,
      remoteAddress: req.socket?.remoteAddress || "",
      request: normalizeReplyExecutionRequestForLog(normalized),
    });
    if (RUNNER_LOG_REQUESTS) {
      console.log(
        `[${logLabel}] mode=file-tools transcriptChars=${normalized.transcript.length}`
      );
    }

    const result = await runReplyUsecase(normalized, { stream: false });
    if (RUNNER_LOG_REQUESTS) {
      console.log(
        `[${logLabel}] success mode=file-tools root=${result.rootRelativePath} toolCalls=${Number(result.toolCalls || 0)} sessionId=${result.sessionId}`
      );
    }
    return json(res, 200, buildReplyHttpPayload(result));
  } catch (err) {
    console.error(`[${logLabel}] failed`, err);
    if (isApiError(err)) {
      return json(res, err.apiStatus, err.apiPayload);
    }
    if (!RUNNER_MOCK && isCodexAuthErrorMessage(errorMessage(err))) {
      return json(res, 503, {
        error: "codex_auth_required",
        message: "Codex authentication is required on the runner host",
        help: codexAuthHelp(),
      });
    }
    return json(res, 500, {
      error: internalErrorCode,
      message: errorMessage(err),
    });
  }
}

function notFound(res) {
  json(res, 404, { error: "not_found" });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function splitMockStreamChunks(text) {
  const chunks = [];
  let rest = String(text || "");
  while (rest) {
    chunks.push(rest.slice(0, 16));
    rest = rest.slice(16);
  }
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactCodexInputPreview(value, maxChars = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function normalizeCodexQueueEffort(value) {
  const effort = String(value || "").trim().toLowerCase();
  return ["low", "medium", "high", "xhigh"].includes(effort) ? effort : "";
}

function normalizeCodexQueueApprovalPolicy(value) {
  const policy = String(value || "").trim();
  return policy === "never" ? "never" : "on-request";
}

function normalizeCodexQueueModel(value) {
  return String(value || "").trim();
}

function normalizeCodexQueueWaitForCompactMs(value) {
  const ms = Math.floor(Number(value || 0));
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, CODEX_QUEUE_WAIT_FOR_COMPACT_MAX_MS);
}

function isCodexCompactRunning(threadIdRaw) {
  const threadId = String(threadIdRaw || "").trim();
  if (!threadId) return false;
  const compact = codexCompactByThreadId.get(threadId);
  return compact?.status === "running";
}

function codexCompactSnapshot(compact) {
  if (!compact) return null;
  return {
    compactId: compact.compactId,
    threadId: compact.threadId,
    status: compact.status,
    method: compact.method || "",
    errorMessage: compact.errorMessage || "",
    createdAtMs: compact.createdAtMs,
    startedAtMs: compact.startedAtMs,
    completedAtMs: compact.completedAtMs || null,
    updatedAtMs: compact.updatedAtMs,
  };
}

function codexQueuedTurnSnapshot(turn) {
  return {
    queuedTurnId: turn.queuedTurnId,
    threadId: turn.threadId,
    status: turn.status,
    inputPreview: turn.inputPreview,
    cwd: turn.cwd || "",
    model: turn.model || "",
    effort: turn.effort || "",
    approvalPolicy: turn.approvalPolicy || "",
    sourcePanelId: turn.sourcePanelId || "",
    clientRequestId: turn.clientRequestId || "",
    errorMessage: turn.errorMessage || "",
    turnId: turn.turnId || "",
    createdAtMs: turn.createdAtMs,
    startedAtMs: turn.startedAtMs || null,
    completedAtMs: turn.completedAtMs || null,
    cancelledAtMs: turn.cancelledAtMs || null,
    waitForCompactUntilMs: turn.waitForCompactUntilMs || null,
    updatedAtMs: turn.updatedAtMs,
  };
}

function listCodexQueuedTurnSnapshots(threadIdRaw = "") {
  const threadId = String(threadIdRaw || "").trim();
  return codexQueuedTurnOrder
    .map((id) => codexQueuedTurnsById.get(id))
    .filter((turn) => turn && (!threadId || turn.threadId === threadId))
    .map(codexQueuedTurnSnapshot);
}

function codexQueueSnapshot(threadIdRaw = "") {
  const threadId = String(threadIdRaw || "").trim();
  const compact = threadId ? codexCompactByThreadId.get(threadId) : null;
  return {
    compact: codexCompactSnapshot(compact),
    queuedTurns: listCodexQueuedTurnSnapshots(threadId),
  };
}

function broadcastCodexQueueSnapshot(threadIdRaw = "") {
  const threadId = String(threadIdRaw || "").trim();
  if (typeof runnerWsActiveClients === "undefined") return;
  const payload = codexQueueSnapshot(threadId);
  for (const client of Array.from(runnerWsActiveClients)) {
    sendRunnerWsEnvelope(client, {
      channel: "control",
      op: "codex_queue_snapshot",
      threadId,
      payload,
    });
  }
}

function markCodexQueuedTurn(turn, patch) {
  Object.assign(turn, patch, { updatedAtMs: Date.now() });
  broadcastCodexQueueSnapshot(turn.threadId);
  return turn;
}

function createCodexRpcClient({ signal, onNotification } = {}) {
  const headers = {};
  if (CODEX_WS_PROXY_UPSTREAM_TOKEN) {
    headers.authorization = `Bearer ${CODEX_WS_PROXY_UPSTREAM_TOKEN}`;
  }
  const ws = new WebSocket(CODEX_WS_PROXY_UPSTREAM_URL, { headers });
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  const close = (code = 1000, reason = "closed") => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      entry.reject(new Error("Codex app-server request cancelled"));
      if (entry.timeout) clearTimeout(entry.timeout);
    }
    pending.clear();
    safeWsClose(ws, code, reason);
  };
  const openPromise = new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
    ws.on("close", (code, reasonBuf) => {
      const reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString("utf8") : String(reasonBuf || "");
      if (closed) return;
      closed = true;
      const message = `Codex app-server WebSocket closed code=${Number(code) || 0} reason=${reason || "-"}`;
      for (const entry of pending.values()) {
        entry.reject(new Error(message));
        if (entry.timeout) clearTimeout(entry.timeout);
      }
      pending.clear();
    });
  });
  ws.on("message", (data) => {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data ?? "");
    if (!text) return;
    let message = null;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message?.method) {
      try {
        onNotification?.(String(message.method), message.params ?? {});
      } catch {}
      return;
    }
    const id = Number(message?.id);
    if (!Number.isInteger(id)) return;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (entry.timeout) clearTimeout(entry.timeout);
    if (message.error) {
      entry.reject(new Error(String(message.error?.message || message.error || "Codex RPC failed")));
    } else {
      entry.resolve(message.result);
    }
  });
  const send = (payload) => {
    if (closed || ws.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server WebSocket is not open");
    }
    ws.send(JSON.stringify(payload));
  };
  const request = (method, params = {}, timeoutMs = 30000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex RPC timeout: ${method}`));
        }, Math.floor(Number(timeoutMs)))
        : null;
      pending.set(id, { resolve, reject, timeout });
      try {
        send({ id, method, params });
      } catch (error) {
        pending.delete(id);
        if (timeout) clearTimeout(timeout);
        reject(error);
      }
    });
  };
  const notify = (method, params = {}) => send({ method, params });
  if (signal) {
    if (signal.aborted) close(1000, "aborted");
    signal.addEventListener("abort", () => close(1000, "aborted"), { once: true });
  }
  return { ws, openPromise, request, notify, close };
}

async function initializeCodexRpcClient(client, clientName) {
  await client.openPromise;
  await client.request("initialize", {
    clientInfo: {
      name: clientName,
      title: clientName,
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: false,
      optOutNotificationMethods: [],
    },
  }, 30000);
  client.notify("initialized", {});
}

function parseCodexThreadStatus(params) {
  const values = [
    params?.status,
    params?.state,
    params?.phase,
    params?.thread?.status,
    params?.thread?.state,
    params?.thread?.phase,
    params?.turn?.status,
    params?.turn?.state,
    params?.turn?.phase,
  ];
  const status = values.map((value) => String(value || "").trim().toLowerCase()).find(Boolean) || "";
  if (["idle", "ready", "completed", "complete", "done", "succeeded", "success"].includes(status)) return "idle";
  if (["active", "running", "busy", "processing", "working", "compacting", "inprogress", "in_progress", "starting", "queued"].includes(status)) return "active";
  return "";
}

function noteCodexCompactStarted(threadIdRaw, methodRaw = "thread/compact/start") {
  const threadId = String(threadIdRaw || "").trim();
  if (!threadId) return null;
  const existing = codexCompactByThreadId.get(threadId);
  if (existing?.status === "running") return existing;
  const now = Date.now();
  const compact = {
    compactId: `codexcompact_${randomUUID()}`,
    threadId,
    status: "running",
    method: String(methodRaw || "thread/compact/start").trim(),
    errorMessage: "",
    createdAtMs: now,
    startedAtMs: now,
    completedAtMs: null,
    updatedAtMs: now,
    sawActivity: false,
  };
  codexCompactByThreadId.set(threadId, compact);
  broadcastCodexQueueSnapshot(threadId);
  void appendCodexWsProxyDebug("codex_compact_state", {
    stage: "started",
    compactId: compact.compactId,
    threadId,
    method: compact.method,
  });
  return compact;
}

function noteCodexCompactActivity(threadIdRaw) {
  const compact = codexCompactByThreadId.get(String(threadIdRaw || "").trim());
  if (compact?.status !== "running") return;
  compact.sawActivity = true;
  compact.updatedAtMs = Date.now();
}

function noteCodexCompactCompleted(threadIdRaw, methodRaw = "thread/compact/start") {
  const threadId = String(threadIdRaw || "").trim();
  if (!threadId) return;
  const compact = codexCompactByThreadId.get(threadId);
  if (!compact || compact.status !== "running") return;
  compact.status = "completed";
  compact.method = String(methodRaw || compact.method || "thread/compact/start").trim();
  compact.completedAtMs = Date.now();
  compact.updatedAtMs = compact.completedAtMs;
  broadcastCodexQueueSnapshot(threadId);
  drainCodexQueuedTurns(threadId);
  void appendCodexWsProxyDebug("codex_compact_state", {
    stage: "completed",
    compactId: compact.compactId,
    threadId,
    method: compact.method,
  });
}

function noteCodexCompactFailed(threadIdRaw, messageRaw) {
  const threadId = String(threadIdRaw || "").trim();
  if (!threadId) return;
  const compact = codexCompactByThreadId.get(threadId);
  if (!compact || compact.status !== "running") return;
  compact.status = "failed";
  compact.errorMessage = String(messageRaw || "compact failed").trim();
  compact.completedAtMs = Date.now();
  compact.updatedAtMs = compact.completedAtMs;
  failWaitingCodexQueuedTurns(threadId, `compact failed: ${compact.errorMessage}`);
  broadcastCodexQueueSnapshot(threadId);
  void appendCodexWsProxyDebug("codex_compact_state", {
    stage: "failed",
    compactId: compact.compactId,
    threadId,
    message: compact.errorMessage,
  });
}

function isCodexCompactItemType(value) {
  return String(value || "").trim().toLowerCase().includes("compact");
}

function observeCodexCompactClientRpc(relay, meta) {
  if (!meta || (meta.method !== "thread/compact/start" && meta.method !== "thread/compact")) return;
  const threadId = String(meta.threadId || relay?.threadId || "").trim();
  noteCodexCompactStarted(threadId, meta.method);
}

function observeCodexCompactUpstreamRpc(relay, meta, responseRpcMethodRaw = "") {
  if (!meta) return;
  const threadId = String(meta.threadId || relay?.threadId || "").trim();
  if (!threadId) return;
  const responseRpcMethod = String(responseRpcMethodRaw || "").trim();
  if (responseRpcMethod === "thread/compact/start" || responseRpcMethod === "thread/compact") {
    if (meta.hasError) {
      noteCodexCompactFailed(threadId, meta.errorMessage || `${responseRpcMethod} failed`);
      return;
    }
    if (responseRpcMethod === "thread/compact" && meta.hasResult) {
      noteCodexCompactCompleted(threadId, responseRpcMethod);
      return;
    }
  }
  if (meta.method === "thread/compacted") {
    noteCodexCompactCompleted(threadId, "thread/compact/start");
    return;
  }
  if (meta.method === "item/started" && isCodexCompactItemType(meta.itemType)) {
    noteCodexCompactActivity(threadId);
    return;
  }
  if (meta.method === "item/completed" && isCodexCompactItemType(meta.itemType)) {
    noteCodexCompactCompleted(threadId, "thread/compact/start");
    return;
  }
  if (meta.method === "thread/status/changed") {
    const status = parseCodexThreadStatus({ status: meta.threadStatus });
    if (status === "active") {
      noteCodexCompactActivity(threadId);
      return;
    }
    const compact = codexCompactByThreadId.get(threadId);
    if (status === "idle" && compact?.sawActivity) {
      noteCodexCompactCompleted(threadId, "thread/compact/start");
      return;
    }
    return;
  }
  if (meta.method === "turn/completed") {
    const compact = codexCompactByThreadId.get(threadId);
    if (compact?.sawActivity) {
      noteCodexCompactCompleted(threadId, "thread/compact/start");
    }
  }
}

async function runCodexQueuedTurn(turn) {
  const abortController = new AbortController();
  markCodexQueuedTurn(turn, {
    status: "running",
    startedAtMs: Date.now(),
    abortController,
  });
  codexRunningTurnByThreadId.set(turn.threadId, turn.queuedTurnId);
  // App-server notifications already reach the relay's upstream socket.
  const client = createCodexRpcClient({
    signal: abortController.signal,
    onNotification: (method, params) => {
      if (method === "turn/started") {
        const turnId = String(params?.turn?.id || params?.turnId || "").trim();
        if (turnId) markCodexQueuedTurn(turn, { turnId });
      }
    },
  });
  try {
    await initializeCodexRpcClient(client, "private-runner-codex-queued-turn");
    let activeThreadId = turn.threadId;
    if (activeThreadId) {
      await client.request("thread/resume", {
        threadId: activeThreadId,
        cwd: turn.cwd || undefined,
        persistExtendedHistory: false,
      }, 30000).catch(() => null);
    }
    const params = {
      threadId: activeThreadId,
      input: [{ type: "text", text: turn.inputText }],
      cwd: turn.cwd || undefined,
      approvalPolicy: turn.approvalPolicy,
    };
    if (turn.model) params.model = turn.model;
    if (turn.effort) params.effort = turn.effort;
    const started = await client.request("turn/start", params, 30000);
    const turnId = String(started?.turn?.id || turn.turnId || "").trim();
    if (turnId) markCodexQueuedTurn(turn, { turnId });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, NEAR_UNLIMITED_TIMEOUT_MS);
      const previousOnMessage = client.ws.listeners("message").slice();
      client.ws.removeAllListeners("message");
      client.ws.on("message", (data) => {
        for (const listener of previousOnMessage) listener(data);
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data ?? "");
        if (!text) return;
        try {
          const message = JSON.parse(text);
          if (message?.method === "turn/completed" || message?.method === "turn/interrupted") {
            clearTimeout(timer);
            resolve();
          }
        } catch {}
      });
      client.ws.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
      client.ws.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    if (turn.status !== "cancelled") {
      markCodexQueuedTurn(turn, {
        status: "completed",
        completedAtMs: Date.now(),
        abortController: null,
      });
    }
  } catch (error) {
    if (turn.status === "cancelled") return;
    markCodexQueuedTurn(turn, {
      status: "failed",
      errorMessage: errorMessage(error),
      completedAtMs: Date.now(),
      abortController: null,
    });
  } finally {
    client.close(1000, "turn_done");
    if (codexRunningTurnByThreadId.get(turn.threadId) === turn.queuedTurnId) {
      codexRunningTurnByThreadId.delete(turn.threadId);
    }
    drainCodexQueuedTurns(turn.threadId);
  }
}

function failWaitingCodexQueuedTurns(threadIdRaw, message) {
  const threadId = String(threadIdRaw || "").trim();
  for (const turn of codexQueuedTurnsById.values()) {
    if (turn.threadId !== threadId) continue;
    if (turn.status !== "queued" && turn.status !== "waiting_compact") continue;
    markCodexQueuedTurn(turn, {
      status: "failed",
      errorMessage: message,
      completedAtMs: Date.now(),
    });
  }
}

function scheduleCodexQueueDrain(threadIdRaw, delayMsRaw) {
  const threadId = String(threadIdRaw || "").trim();
  if (!threadId || codexQueueDrainTimerByThreadId.has(threadId)) return;
  const delayMs = Math.max(1, Math.min(CODEX_QUEUE_WAIT_FOR_COMPACT_MAX_MS, Math.floor(Number(delayMsRaw || 1))));
  const timer = setTimeout(() => {
    codexQueueDrainTimerByThreadId.delete(threadId);
    drainCodexQueuedTurns(threadId);
  }, delayMs);
  codexQueueDrainTimerByThreadId.set(threadId, timer);
}

function drainCodexQueuedTurns(threadIdRaw) {
  const threadId = String(threadIdRaw || "").trim();
  if (!threadId || isCodexCompactRunning(threadId) || codexRunningTurnByThreadId.has(threadId)) return;
  const compact = codexCompactByThreadId.get(threadId);
  for (const id of codexQueuedTurnOrder) {
    const turn = codexQueuedTurnsById.get(id);
    if (!turn || turn.threadId !== threadId) continue;
    if (turn.status !== "queued" && turn.status !== "waiting_compact") continue;
    const compactCompletedAfterQueue = compact?.status === "completed" &&
      Number(compact.completedAtMs || 0) >= Number(turn.createdAtMs || 0);
    const compactFailedAfterQueue = compact?.status === "failed" &&
      Number(compact.completedAtMs || 0) >= Number(turn.createdAtMs || 0);
    if (turn.status === "waiting_compact" && turn.waitForCompactUntilMs && !compactCompletedAfterQueue) {
      const remainingMs = Math.max(0, Number(turn.waitForCompactUntilMs) - Date.now());
      if (remainingMs > 0 && !compactFailedAfterQueue) {
        scheduleCodexQueueDrain(threadId, remainingMs);
        return;
      }
      markCodexQueuedTurn(turn, {
        status: "failed",
        errorMessage: compactFailedAfterQueue
          ? `compact failed: ${compact.errorMessage || "unknown"}`
          : "compact did not start before queue wait timeout",
        completedAtMs: Date.now(),
      });
      continue;
    }
    void runCodexQueuedTurn(turn);
    return;
  }
}

function enqueueCodexTurn(body) {
  const threadId = String(body?.threadId || "").trim();
  const inputText = String(body?.inputText || body?.text || "").trim();
  if (!threadId) throw makeApiError(400, "thread_id_required", "threadId is required");
  if (!inputText) throw makeApiError(400, "input_text_required", "inputText is required");
  const waitForCompactMs = normalizeCodexQueueWaitForCompactMs(body?.waitForCompactMs);
  const compactRunning = isCodexCompactRunning(threadId);
  if (body?.onlyIfCompacting && !compactRunning && waitForCompactMs <= 0) {
    return { queued: false, reason: "not_compacting", turn: null };
  }
  const clientRequestId = String(body?.clientRequestId || "").trim();
  if (clientRequestId) {
    const duplicate = Array.from(codexQueuedTurnsById.values()).find((turn) => (
      turn.threadId === threadId && turn.clientRequestId === clientRequestId
    ));
    if (duplicate) {
      return { queued: true, reason: "duplicate", turn: duplicate };
    }
  }
  const now = Date.now();
  const turn = {
    queuedTurnId: `codexq_${randomUUID()}`,
    threadId,
    status: (compactRunning || waitForCompactMs > 0) ? "waiting_compact" : "queued",
    inputText,
    inputPreview: compactCodexInputPreview(inputText),
    cwd: String(body?.cwd || body?.directory || "").trim(),
    model: normalizeCodexQueueModel(body?.model || body?.modelRef),
    effort: normalizeCodexQueueEffort(body?.effort || body?.reasoningEffort),
    approvalPolicy: normalizeCodexQueueApprovalPolicy(body?.approvalPolicy),
    sourcePanelId: String(body?.sourcePanelId || body?.panelId || "").trim(),
    clientRequestId,
    errorMessage: "",
    turnId: "",
    createdAtMs: now,
    startedAtMs: null,
    completedAtMs: null,
    cancelledAtMs: null,
    waitForCompactUntilMs: waitForCompactMs > 0 ? now + waitForCompactMs : null,
    updatedAtMs: now,
    abortController: null,
  };
  codexQueuedTurnsById.set(turn.queuedTurnId, turn);
  codexQueuedTurnOrder.push(turn.queuedTurnId);
  broadcastCodexQueueSnapshot(threadId);
  drainCodexQueuedTurns(threadId);
  return { queued: true, reason: "queued", turn };
}

function cancelCodexQueuedTurn(queuedTurnIdRaw) {
  const queuedTurnId = String(queuedTurnIdRaw || "").trim();
  const turn = codexQueuedTurnsById.get(queuedTurnId);
  if (!turn) throw makeApiError(404, "queued_turn_not_found", `queued turn not found: ${queuedTurnId}`);
  if (turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled") {
    return turn;
  }
  if (turn.status === "running" && turn.abortController) {
    turn.abortController.abort();
  }
  markCodexQueuedTurn(turn, {
    status: "cancelled",
    cancelledAtMs: Date.now(),
    completedAtMs: Date.now(),
    abortController: null,
  });
  drainCodexQueuedTurns(turn.threadId);
  return turn;
}

async function handleStreamTtsSession(startPayload, opts = {}) {
  const signal = opts.signal;
  const endpoint = String(opts.endpoint || "/stream-tts");
  const remoteAddress = String(opts.remoteAddress || "");
  const publicBaseUrl = String(opts.publicBaseUrl || "").trim() || `http://${HOST}:${PORT}`;
  const requestToolApproval = typeof opts.requestToolApproval === "function"
    ? opts.requestToolApproval
    : null;
  const emit = typeof opts.emit === "function" ? opts.emit : (() => false);
  const emitEvent = (payload) => {
    if (!payload || typeof payload !== "object") return false;
    return emit(payload);
  };
  const sessionMode = normalizeStreamTtsMode(startPayload?.mode);
  let normalizedReplyReq;
  let transcript = "";
  let directText = "";
  if (sessionMode === "reply") {
    try {
      normalizedReplyReq = normalizeReplyExecutionRequest(startPayload);
    } catch (err) {
      if (isApiError(err)) {
        emitEvent({
          type: "error",
          ...err.apiPayload,
        });
        return;
      }
      emitEvent({
        type: "error",
        error: "invalid_request",
        message: errorMessage(err),
      });
      return;
    }
    transcript = normalizedReplyReq.transcript;
    void appendLlmRequestLog({
      type: "app_request_normalized",
      channel: "ws",
      endpoint,
      remoteAddress,
      request: normalizeReplyExecutionRequestForLog(normalizedReplyReq),
    });
  } else {
    directText = String(startPayload?.text || "").trim();
    if (!directText) {
      emitEvent({
        type: "error",
        error: "text_required",
        message: "text is required when mode=text",
      });
      return;
    }
    if (directText.length > MAX_TTS_CHARS) {
      emitEvent({
        type: "error",
        error: "text_too_long",
        max: MAX_TTS_CHARS,
      });
      return;
    }
    transcript = directText;
  }
  const ttsProvider = resolveTtsProvider(startPayload?.ttsProvider);
  const voiceId = String(startPayload?.voiceId || "").trim();
  const modelId = String(startPayload?.modelId || "").trim();
  const outputFormat = String(startPayload?.outputFormat || "").trim();
  const languageCode = String(startPayload?.languageCode || "").trim();
  const audioEncoding = String(startPayload?.audioEncoding || "").trim();
  const applyLanguageTextNormalization =
    typeof startPayload?.applyLanguageTextNormalization === "boolean"
      ? startPayload.applyLanguageTextNormalization
      : undefined;
  let speedScale;
  try {
    speedScale = parseOptionalSpeedScale(startPayload?.speedScale);
  } catch (err) {
    emitEvent({
      type: "error",
      error: "speed_scale_invalid",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!isSupportedTtsProvider(ttsProvider)) {
    emitEvent({
      type: "error",
      error: "tts_provider_invalid",
      message: `Unsupported ttsProvider: ${ttsProvider}`,
      supportedProviders: Array.from(SUPPORTED_TTS_PROVIDERS),
    });
    return;
  }

  const ttsValidation = validateTtsProviderRequirements(ttsProvider, "/stream-tts");
  if (ttsValidation) {
    emitEvent({ type: "error", ...ttsValidation.payload });
    return;
  }

  if (RUNNER_LOG_REQUESTS) {
    console.log(
      `[stream-tts] mode=${sessionMode === "reply" ? "file-tools" : "text"} transcriptChars=${transcript.length}`
    );
  }

  let reply = "";
  let pendingSegmentBuffer = "";
  let chunkSeq = 0;
  const streamSegmentTargetChars = resolveStreamTtsSegmentTargetChars(speedScale);
  const normalizedStreamSpeedScale = normalizeSpeedScaleForTtsEstimate(speedScale);
  let ttsChain = Promise.resolve();
  let ttsChainFailure = null;
  let usecaseResult = null;

  function enqueueSegment(rawSegment) {
    const segment = String(rawSegment || "");
    const ttsText = sanitizeStreamTtsText(segment);
    if (!ttsText) return;
    const currentSeq = chunkSeq;
    chunkSeq += 1;
    const estimatedDurationMs = estimateStreamTtsSegmentDurationMs(ttsText, normalizedStreamSpeedScale);
    const chunkChars = ttsText.length;
    const rawChars = segment.length;
    emitEvent({
      type: "segment_queued",
      seq: currentSeq,
      text: ttsText,
      rawText: segment,
      chunkChars,
      rawChars,
      estimatedDurationMs,
      segmentTargetChars: streamSegmentTargetChars,
      segmentMaxEstMs: STREAM_TTS_SEGMENT_MAX_EST_MS,
      speedScale: normalizedStreamSpeedScale,
    });
    ttsChain = ttsChain.then(async () => {
      if (ttsChainFailure || signal?.aborted) return;
      emitEvent({
        type: "segment_tts_started",
        seq: currentSeq,
        text: ttsText,
        rawText: segment,
        chunkChars,
        rawChars,
        estimatedDurationMs,
        segmentTargetChars: streamSegmentTargetChars,
        segmentMaxEstMs: STREAM_TTS_SEGMENT_MAX_EST_MS,
        speedScale: normalizedStreamSpeedScale,
      });
      try {
        const tts = await runTtsByProvider(ttsProvider, ttsText, {
          voiceId: voiceId || undefined,
          modelId: modelId || undefined,
          outputFormat: outputFormat || undefined,
          languageCode: languageCode || undefined,
          audioEncoding: audioEncoding || undefined,
          applyLanguageTextNormalization,
          speedScale,
        });
        const media = await registerTtsMedia(tts.audioBuffer, tts.mimeType, publicBaseUrl);
        emitEvent({
          type: "audio_chunk",
          seq: currentSeq,
          text: ttsText,
          rawText: segment,
          audioUrl: media.audioUrl,
          audioBytes: media.audioBytes,
          mimeType: tts.mimeType,
          provider: tts.provider,
          voiceId: tts.voiceId,
          speedScale: tts.speedScale,
          chunkChars,
          rawChars,
          estimatedDurationMs,
          segmentTargetChars: streamSegmentTargetChars,
          segmentMaxEstMs: STREAM_TTS_SEGMENT_MAX_EST_MS,
        });
        emitEvent({
          type: "segment_tts_done",
          seq: currentSeq,
          text: ttsText,
          rawText: segment,
          chunkChars,
          rawChars,
          estimatedDurationMs,
          segmentTargetChars: streamSegmentTargetChars,
          segmentMaxEstMs: STREAM_TTS_SEGMENT_MAX_EST_MS,
          speedScale: normalizedStreamSpeedScale,
        });
      } catch (err) {
        if (isApiError(err)) {
          ttsChainFailure = err;
          return;
        }
        const rawMessage = err instanceof Error ? err.message : String(err);
        ttsChainFailure = new Error(
          `stream-tts segment failed: seq=${currentSeq} provider=${ttsProvider} message=${rawMessage}`
        );
      }
    });
  }

  function flushReadySegments(force = false) {
    while (pendingSegmentBuffer) {
      let splitIndex = -1;
      for (let i = 0; i < pendingSegmentBuffer.length; i += 1) {
        if (isTtsBoundaryChar(pendingSegmentBuffer[i])) {
          splitIndex = i;
          break;
        }
      }
      if (splitIndex < 0) break;
      const segment = pendingSegmentBuffer.slice(0, splitIndex + 1);
      pendingSegmentBuffer = pendingSegmentBuffer.slice(splitIndex + 1);
      enqueueSegment(segment);
    }
    if (force && pendingSegmentBuffer.trim()) {
      enqueueSegment(pendingSegmentBuffer);
      pendingSegmentBuffer = "";
    }
  }

  const handleTextDelta = (delta, source = "unknown") => {
    if (!delta) return;
    reply += delta;
    pendingSegmentBuffer += delta;
    emitEvent({ type: "text_delta", delta, source });
    flushReadySegments(false);
  };

  emitEvent({
    type: "started",
    provider: sessionMode === "reply" ? (RUNNER_MOCK ? "mock" : OPENAI_CODEX_PROVIDER) : ttsProvider,
    route: sessionMode === "reply" ? (RUNNER_MOCK ? "mock" : OPENAI_CODEX_ROUTE) : "stream-tts:text",
    modelRef: sessionMode === "reply"
      ? (RUNNER_MOCK ? "mock" : normalizedReplyReq.codexOptions.modelInfo.modelRef)
      : undefined,
    mode: sessionMode === "reply" ? "file-tools" : "text",
  });
  if (sessionMode !== "reply") {
    emitEvent({ type: "stream_mode", mode: "direct_text" });
  }

  try {
    if (sessionMode === "reply") {
      usecaseResult = await runReplyUsecase(normalizedReplyReq, {
        stream: true,
        signal,
        requestToolApproval,
        onText: handleTextDelta,
        onProgress: (event) => {
          const stage = String(event?.stage || "").trim();
          if (!stage) return;
          emitEvent({
            type: "progress",
            stage,
            at: String(event?.at || ""),
            message: String(event?.message || ""),
            round: Number.isFinite(Number(event?.round)) ? Number(event.round) : undefined,
            maxToolRounds: Number.isFinite(Number(event?.maxToolRounds))
              ? Number(event.maxToolRounds)
              : undefined,
            toolCalls: Number.isFinite(Number(event?.toolCalls)) ? Number(event.toolCalls) : undefined,
            pendingToolCalls: Number.isFinite(Number(event?.pendingToolCalls))
              ? Number(event.pendingToolCalls)
              : undefined,
            toolName: String(event?.toolName || "") || undefined,
            status: String(event?.status || "") || undefined,
            durationMs: Number.isFinite(Number(event?.durationMs)) ? Number(event.durationMs) : undefined,
          });
        },
        onMode: (mode) => {
          emitEvent({ type: "stream_mode", mode });
        },
        onToolCall: (event) => {
          const phase = String(event?.phase || "").trim().toLowerCase();
          if (phase !== "start" && phase !== "done") return;
          emitEvent({
            type: "tool_call",
            phase,
            toolName: String(event?.toolName || ""),
            callId: String(event?.callId || ""),
            status: String(event?.status || ""),
            durationMs: Number(event?.durationMs || 0),
            argsSummary: event?.argsSummary,
            resultSummary: event?.resultSummary,
            youtubeVideoIds: Array.isArray(event?.youtubeVideoIds) ? event.youtubeVideoIds : undefined,
            mediaControl: event?.mediaControl && typeof event.mediaControl === "object"
              ? event.mediaControl
              : undefined,
            parseError: String(event?.parseError || ""),
            errorMessage: String(event?.errorMessage || ""),
          });
        },
      });
    } else {
      reply = directText;
      pendingSegmentBuffer = directText;
    }
  } catch (err) {
    if (isApiError(err)) {
      emitEvent({
        type: "error",
        ...err.apiPayload,
      });
      return;
    }
    throw err;
  }

  if (sessionMode === "reply" && RUNNER_LOG_REQUESTS) {
    console.log(
      `[stream-tts] success mode=file-tools root=${usecaseResult.rootRelativePath} toolCalls=${Number(usecaseResult.toolCalls || 0)} sessionId=${usecaseResult.sessionId}`
    );
  }

  if (!reply.trim() && usecaseResult?.reply) {
    reply = String(usecaseResult.reply);
  }
  flushReadySegments(true);
  await ttsChain;
  if (ttsChainFailure) {
    throw ttsChainFailure;
  }

  if (signal?.aborted) return;
  emitEvent({
    type: "done",
    reply: reply.trim(),
    provider: usecaseResult?.provider || ttsProvider || (RUNNER_MOCK ? "mock" : OPENAI_CODEX_PROVIDER),
    route: usecaseResult?.route || (sessionMode === "reply" ? (RUNNER_MOCK ? "mock" : OPENAI_CODEX_ROUTE) : "stream-tts:text"),
    modelRef: usecaseResult?.modelRef || (
      sessionMode === "reply"
        ? (RUNNER_MOCK ? "mock" : normalizedReplyReq.codexOptions.modelInfo.modelRef)
        : undefined
    ),
    rootRelativePath: usecaseResult?.rootRelativePath || undefined,
    sessionId: usecaseResult?.sessionId || undefined,
    selectedSkillPath: usecaseResult?.selectedSkillPath || undefined,
    toolCalls: Number(usecaseResult?.toolCalls || 0),
    contextUsage: usecaseResult?.contextUsage && typeof usecaseResult.contextUsage === "object"
      ? usecaseResult.contextUsage
      : undefined,
  });
}

function listLlmJobs(limit = 20) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20));
  const items = [];
  for (let i = llmJobOrder.length - 1; i >= 0 && items.length < safeLimit; i -= 1) {
    const jobId = llmJobOrder[i];
    const job = llmJobsById.get(jobId);
    if (!job) continue;
    const summary = llmJobSummary(job);
    if (summary) items.push(summary);
  }
  return items;
}

function settleJobPendingApproval(job, requestId, value, isError = false) {
  if (!job || !(job.pendingApprovals instanceof Map)) return false;
  const pending = job.pendingApprovals.get(requestId);
  if (!pending) return false;
  job.pendingApprovals.delete(requestId);
  clearTimeout(pending.timer);
  if (isError) pending.reject(value);
  else pending.resolve(value);
  if (job.status === "waiting_approval" && job.pendingApprovals.size === 0) {
    llmJobSetStatus(job, "running");
  }
  return true;
}

function rejectAllJobPendingApprovals(job, message = "approval channel closed") {
  if (!job || !(job.pendingApprovals instanceof Map)) return;
  for (const [requestId, pending] of job.pendingApprovals.entries()) {
    job.pendingApprovals.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(new Error(String(message || "approval channel closed")));
  }
}

function startLlmStreamJob(startPayload, opts = {}) {
  const endpoint = String(opts.endpoint || "/stream-tts");
  const remoteAddress = String(opts.remoteAddress || "");
  const publicBaseUrl = String(opts.publicBaseUrl || "").trim() || `http://${HOST}:${PORT}`;
  const mode = normalizeStreamTtsMode(startPayload?.mode);
  const normalizedSessionId = normalizeLlmExecutionSessionId(startPayload?.sessionId);
  const normalizedClientRequestId = normalizeLlmClientRequestId(startPayload?.clientRequestId);

  if (normalizedClientRequestId) {
    const existingByRequestId = findLlmJobByClientRequestId(normalizedClientRequestId, {
      sessionId: normalizedSessionId,
    });
    if (existingByRequestId) {
      if (RUNNER_LOG_REQUESTS) {
        console.log(
          `[stream-tts] dedupe_hit clientRequestId=${normalizedClientRequestId} sessionId=${normalizedSessionId || "-"} jobId=${existingByRequestId.jobId} status=${existingByRequestId.status}`
        );
      }
      return existingByRequestId;
    }
  }

  if (normalizedSessionId) {
    const existingActiveBySession = findActiveLlmJobBySessionId(normalizedSessionId);
    if (existingActiveBySession) {
      if (LLM_JOB_SESSION_ACTIVE_POLICY === "cancel_and_replace") {
        llmJobCancel(existingActiveBySession, `superseded_by_new_request:${normalizedSessionId}`);
      } else if (LLM_JOB_SESSION_ACTIVE_POLICY === "reject") {
        throw makeApiError(
          409,
          "session_active_job_exists",
          `active job already exists for sessionId=${normalizedSessionId}`,
          { sessionId: normalizedSessionId, activeJobId: existingActiveBySession.jobId }
        );
      }
    }
  }

  const job = createLlmJob(startPayload, {
    mode,
    endpoint,
    clientRequestId: normalizedClientRequestId,
  });
  if (normalizedSessionId) {
    job.sessionId = normalizedSessionId;
  }
  const requestToolApproval = (request = {}) => new Promise((resolve, reject) => {
    const toolName = String(request.toolName || "run_command_sandboxed");
    const approvalKey = String(request.approvalKey || "").trim();
    const sessionId = normalizeLlmExecutionSessionId(request.sessionId);
    if (approvalKey && sessionId && hasToolApprovalInSession(sessionId, approvalKey)) {
      if (RUNNER_LOG_REQUESTS) {
        console.log(`[approval] skipped_by_session_cache jobId=${job.jobId} tool=${toolName} sessionId=${sessionId} key=${approvalKey}`);
      }
      resolve({ approved: true, cached: true });
      return;
    }
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      if (RUNNER_LOG_REQUESTS) {
        console.warn(`[approval] timeout jobId=${job.jobId} requestId=${requestId} tool=${toolName}`);
      }
      settleJobPendingApproval(
        job,
        requestId,
        new Error(`${toolName} approval timed out after ${toolApprovalTimeoutMsRuntime}ms`),
        true
      );
    }, toolApprovalTimeoutMsRuntime);
    job.pendingApprovals.set(requestId, {
      resolve,
      reject,
      timer,
      toolName,
      approvalKey,
      sessionId,
    });
    llmJobSetStatus(job, "waiting_approval");
    llmJobEmit(job, {
      type: "tool_approval_required",
      requestId,
      toolName,
      callId: String(request.callId || ""),
      command: String(request.command || ""),
      args: Array.isArray(request.args) ? request.args.map((item) => String(item || "")) : [],
      reason: String(request.reason || ""),
      approvalKey,
      approvalMode: String(request.approvalMode || "required"),
      cwd: String(request.cwd || "."),
      timeoutMs: Number(request.timeoutMs || SANDBOXED_RUN_DEFAULT_TIMEOUT_MS),
      message: String(request.message || ""),
    });
  });

  const emitFromSession = (payload) => {
    if (!payload || typeof payload !== "object") return false;
    const type = String(payload.type || "");
    if (type === "started") {
      job.route = String(payload.route || "");
      job.modelRef = String(payload.modelRef || "");
      job.sessionId = String(payload.sessionId || job.sessionId || "");
      llmJobSetStatus(job, "running");
    } else if (type === "done") {
      job.reply = String(payload.reply || "");
      job.route = String(payload.route || job.route || "");
      job.modelRef = String(payload.modelRef || job.modelRef || "");
      job.sessionId = String(payload.sessionId || job.sessionId || "");
      job.toolCalls = Number.isFinite(Number(payload.toolCalls)) ? Number(payload.toolCalls) : job.toolCalls;
      job.rootRelativePath = String(payload.rootRelativePath || job.rootRelativePath || "");
      job.selectedSkillPath = String(payload.selectedSkillPath || job.selectedSkillPath || "");
      job.contextUsage = payload.contextUsage && typeof payload.contextUsage === "object"
        ? payload.contextUsage
        : (job.contextUsage || null);
      llmJobSetStatus(job, "completed");
    } else if (type === "error") {
      job.error = {
        error: String(payload.error || "stream_tts_failed"),
        message: String(payload.message || payload.error || "stream_tts_failed"),
        detail: String(payload.detail || payload.message || ""),
      };
      llmJobSetStatus(job, "failed");
    }
    return llmJobEmit(job, payload);
  };

  llmJobEmit(job, {
    type: "job_started",
    jobId: job.jobId,
    mode,
    endpoint,
    remoteAddress,
    message: `job ${job.jobId} started`,
  });

  job.runPromise = (async () => {
    llmJobSetStatus(job, "running");
    job.startedAt = jobNowIso();
    try {
      await handleStreamTtsSession(startPayload, {
        signal: job.abortController.signal,
        requestToolApproval,
        endpoint,
        remoteAddress,
        publicBaseUrl,
        emit: emitFromSession,
      });
      if (job.status === "running" || job.status === "waiting_approval") {
        if (job.error) llmJobSetStatus(job, "failed");
        else llmJobSetStatus(job, "completed");
      }
    } catch (err) {
      if (job.abortController.signal.aborted && job.status === "cancelled") {
        return;
      }
      const rawMessage = err instanceof Error ? err.message : String(err);
      job.error = {
        error: "stream_tts_failed",
        message: rawMessage,
        detail: rawMessage,
      };
      llmJobSetStatus(job, "failed");
      llmJobEmit(job, {
        type: "error",
        error: "stream_tts_failed",
        message: rawMessage,
        detail: rawMessage,
      });
    } finally {
      if (job.status === "cancelled") {
        rejectAllJobPendingApprovals(job, "job cancelled");
      } else if (job.status === "failed") {
        rejectAllJobPendingApprovals(job, "job failed");
      }
      pruneLlmJobStorage();
    }
  })();

  return job;
}

const server = http.createServer(async (req, res) => {
  const reqUrl = parseRequestUrl(req);
  const pathname = reqUrl.pathname;

  if (RUNNER_LOG_REQUESTS) {
    console.log(`[request] ${req.method} ${req.url} from ${req.socket.remoteAddress || "unknown"}`);
  }

  if (req.method === "GET" && pathname === "/health") {
    let llmFileRoot = "";
    try {
      const root = await resolveToolRoot("");
      llmFileRoot = root.relativeRoot;
    } catch {
      llmFileRoot = "";
    }
    return json(res, 200, {
      ok: true,
      mode: RUNNER_MOCK ? "mock" : OPENAI_CODEX_PROVIDER,
      route: RUNNER_MOCK ? "mock" : OPENAI_CODEX_ROUTE,
      modelRef: RUNNER_MOCK ? "mock" : OPENAI_CODEX_MODEL_INFO.modelRef,
      llmFileRoot,
    });
  }

  if (req.method === "GET" && pathname === "/codex-ws-debug") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseDebugAuthToken(req, reqUrl) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    const limit = Number(reqUrl.searchParams.get("limit") || 50);
    return json(res, 200, {
      ok: true,
      events: listCodexWsProxyDebug(limit),
      logPath: path.relative(WORKSPACE_ROOT, CODEX_WS_PROXY_DEBUG_LOG_PATH),
      bufferSize: codexWsProxyDebugBuffer.length,
    });
  }

  if (req.method === "GET" && pathname === "/config/limits") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    return json(res, 200, {
      llm: {
        timeoutMs: OPENAI_CODEX_TIMEOUT_MS,
        upstreamMaxRetries: OPENAI_CODEX_UPSTREAM_MAX_RETRIES,
        upstreamRetryBaseMs: OPENAI_CODEX_UPSTREAM_RETRY_BASE_MS,
        upstreamRetryMaxMs: OPENAI_CODEX_UPSTREAM_RETRY_MAX_MS,
        toolMaxRounds: llmFileMaxToolRoundsRuntime,
      },
      approval: {
        timeoutMs: toolApprovalTimeoutMsRuntime,
      },
      stt: {
        groqTimeoutMs: GROQ_STT_TIMEOUT_MS,
      },
      tts: {
        maxChars: MAX_TTS_CHARS,
        segmentMaxEstMs: STREAM_TTS_SEGMENT_MAX_EST_MS,
      },
    });
  }

  if (req.method === "POST" && pathname === "/config/limits") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    try {
      const body = await readJsonBody(req);
      const rawToolMaxRounds = body?.llm?.toolMaxRounds ?? body?.toolMaxRounds;
      const rawApprovalTimeoutMs = body?.approval?.timeoutMs ?? body?.approvalTimeoutMs;
      if (typeof rawToolMaxRounds === "undefined" && typeof rawApprovalTimeoutMs === "undefined") {
        return json(res, 400, {
          error: "invalid_request",
          message: "at least one of llm.toolMaxRounds/toolMaxRounds or approval.timeoutMs/approvalTimeoutMs is required",
        });
      }
      if (typeof rawToolMaxRounds !== "undefined") {
        const parsed = Number(rawToolMaxRounds);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
          return json(res, 400, {
            error: "invalid_tool_max_rounds",
            message: "toolMaxRounds must be an integer between 1 and 1000",
          });
        }
        llmFileMaxToolRoundsRuntime = parsed;
      }
      if (typeof rawApprovalTimeoutMs !== "undefined") {
        const parsedApprovalTimeoutMs = Number(rawApprovalTimeoutMs);
        if (!Number.isInteger(parsedApprovalTimeoutMs) || parsedApprovalTimeoutMs < 1000 || parsedApprovalTimeoutMs > 86400000) {
          return json(res, 400, {
            error: "invalid_approval_timeout_ms",
            message: "approvalTimeoutMs must be an integer between 1000 and 86400000",
          });
        }
        toolApprovalTimeoutMsRuntime = parsedApprovalTimeoutMs;
      }
      return json(res, 200, {
        ok: true,
        llm: {
          toolMaxRounds: llmFileMaxToolRoundsRuntime,
        },
        approval: {
          timeoutMs: toolApprovalTimeoutMsRuntime,
        },
      });
    } catch (err) {
      return json(res, 400, {
        error: "invalid_json",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (req.method === "GET" && pathname === "/codex-cli/status") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    try {
      const forceRefresh = String(reqUrl.searchParams.get("force") || "").trim() === "1";
      const cacheFresh = (
        !forceRefresh &&
        CODEX_CLI_STATUS_CACHE_TTL_MS > 0 &&
        codexCliStatusCache.snapshot &&
        (Date.now() - Number(codexCliStatusCache.fetchedAtMs || 0)) <= CODEX_CLI_STATUS_CACHE_TTL_MS
      );
      if (cacheFresh) {
        return json(res, 200, {
          ok: true,
          cached: true,
          ...codexCliStatusCache.snapshot,
        });
      }
      const snapshot = await fetchCodexCliStatusSnapshot();
      codexCliStatusCache = {
        fetchedAtMs: Date.now(),
        snapshot,
      };
      return json(res, 200, {
        ok: true,
        cached: false,
        ...snapshot,
      });
    } catch (err) {
      return json(res, 500, {
        error: "codex_cli_status_failed",
        message: errorMessage(err),
      });
    }
  }

  if (req.method === "GET" && pathname === "/git/changed-files") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    try {
      const directory = String(reqUrl.searchParams.get("directory") || "").trim();
      const snapshot = await fetchGitChangedFilesSnapshot(directory);
      return json(res, 200, {
        ok: true,
        ...snapshot,
      });
    } catch (err) {
      if (isApiError(err)) {
        return json(res, err.apiStatus, err.apiPayload);
      }
      return json(res, 500, {
        error: "git_changed_files_failed",
        message: errorMessage(err),
      });
    }
  }

  if (req.method === "POST" && pathname === "/scripts/execute") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    try {
      const body = await readJsonBody(req);
      const result = await executeWorkspaceShellScript(body?.path);
      return json(res, 200, {
        ...result,
      });
    } catch (err) {
      if (isApiError(err)) {
        return json(res, err.apiStatus, err.apiPayload);
      }
      return json(res, 500, {
        error: "script_execute_failed",
        message: errorMessage(err),
      });
    }
  }

  if (req.method === "GET" && pathname === "/scripts/jobs") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    try {
      return json(res, 200, {
        ok: true,
        jobs: listWorkspaceShellScriptJobs(),
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (isApiError(err)) {
        return json(res, err.apiStatus, err.apiPayload);
      }
      return json(res, 500, {
        error: "scripts_jobs_failed",
        message: errorMessage(err),
      });
    }
  }

  if (req.method === "POST" && pathname === "/scripts/start") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    try {
      const body = await readJsonBody(req);
      const job = await startWorkspaceShellScript(body?.path);
      return json(res, 200, {
        ok: true,
        job,
      });
    } catch (err) {
      if (isApiError(err)) {
        return json(res, err.apiStatus, err.apiPayload);
      }
      return json(res, 500, {
        error: "script_start_failed",
        message: errorMessage(err),
      });
    }
  }

  if (req.method === "POST" && pathname === "/scripts/kill") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    try {
      const body = await readJsonBody(req);
      const payload = killWorkspaceShellScriptJob(body?.jobId);
      return json(res, 200, payload);
    } catch (err) {
      if (isApiError(err)) {
        return json(res, err.apiStatus, err.apiPayload);
      }
      return json(res, 500, {
        error: "script_kill_failed",
        message: errorMessage(err),
      });
    }
  }

  if (req.method === "GET" && pathname === "/codex-auth/profiles") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    try {
      const snapshot = await listCodexAuthProfilesSnapshot();
      return json(res, 200, {
        ok: true,
        currentAuthId: snapshot.currentAuthId,
        profiles: snapshot.profiles,
        fetchedAt: snapshot.fetchedAt,
      });
    } catch (err) {
      if (isApiError(err)) {
        return json(res, err.apiStatus, err.apiPayload);
      }
      return json(res, 500, {
        error: "codex_auth_profiles_failed",
        message: errorMessage(err),
      });
    }
  }

  if (req.method === "POST" && pathname === "/codex-auth/switch") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    try {
      const body = await readJsonBody(req);
      const authId = normalizeCodexAuthId(body?.authId);
      const switchResult = await switchCodexAuthProfile(authId);
      return json(res, 200, {
        ok: true,
        authId: switchResult.authId,
        currentAuthId: switchResult.snapshot.currentAuthId,
        profiles: switchResult.snapshot.profiles,
        fetchedAt: switchResult.snapshot.fetchedAt,
        restart: {
          scheduled: true,
          command: switchResult.restart.command,
        },
      });
    } catch (err) {
      if (isApiError(err)) {
        return json(res, err.apiStatus, err.apiPayload);
      }
      return json(res, 500, {
        error: "codex_auth_switch_failed",
        message: errorMessage(err),
      });
    }
  }

  if (req.method === "GET" && pathname === "/codex/queued-turns") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    const threadId = String(reqUrl.searchParams.get("threadId") || "").trim();
    return json(res, 200, {
      ok: true,
      queue: codexQueueSnapshot(threadId),
    });
  }

  if (req.method === "POST" && pathname === "/codex/queued-turns") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    try {
      const body = await readJsonBody(req);
      const result = enqueueCodexTurn(body);
      return json(res, result.queued ? 202 : 200, {
        ok: true,
        queued: result.queued,
        reason: result.reason,
        queuedTurn: result.turn ? codexQueuedTurnSnapshot(result.turn) : null,
        queue: codexQueueSnapshot(String(body?.threadId || "").trim()),
      });
    } catch (err) {
      if (isApiError(err)) {
        return json(res, err.apiStatus, err.apiPayload);
      }
      return json(res, 500, {
        error: "codex_queue_enqueue_failed",
        message: errorMessage(err),
      });
    }
  }

  if (req.method === "POST" && pathname.startsWith("/codex/queued-turns/")) {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    const parts = pathname.split("/").filter(Boolean);
    const queuedTurnId = String(parts[2] || "").trim();
    const action = String(parts[3] || "").trim().toLowerCase();
    if (action !== "cancel") {
      return json(res, 404, { error: "not_found" });
    }
    try {
      const turn = cancelCodexQueuedTurn(queuedTurnId);
      return json(res, 200, {
        ok: true,
        queuedTurn: codexQueuedTurnSnapshot(turn),
        queue: codexQueueSnapshot(turn.threadId),
      });
    } catch (err) {
      if (isApiError(err)) {
        return json(res, err.apiStatus, err.apiPayload);
      }
      return json(res, 500, {
        error: "codex_queue_cancel_failed",
        message: errorMessage(err),
      });
    }
  }

  if (req.method === "GET" && pathname === "/jobs") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    const rawLimit = Number(reqUrl.searchParams.get("limit") || 20);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.floor(rawLimit))) : 20;
    return json(res, 200, {
      jobs: listLlmJobs(limit),
    });
  }

  if ((req.method === "GET" || req.method === "POST") && pathname.startsWith("/jobs/")) {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    const parts = pathname.split("/").filter(Boolean);
    const jobId = String(parts[1] || "").trim();
    const action = String(parts[2] || "").trim().toLowerCase();
    if (!jobId) {
      return json(res, 400, {
        error: "job_id_required",
        message: "job id is required",
      });
    }
    const job = getLlmJobById(jobId);
    if (!job) {
      return json(res, 404, {
        error: "job_not_found",
        message: `job not found: ${jobId}`,
      });
    }
    if (req.method === "GET" && !action) {
      const sinceSeqRaw = Number(reqUrl.searchParams.get("sinceSeq") || 0);
      const sinceSeq = Number.isFinite(sinceSeqRaw) ? Math.max(0, Math.floor(sinceSeqRaw)) : 0;
      return json(res, 200, {
        job: llmJobSnapshot(job, {
          includeEvents: true,
          sinceSeq,
        }),
      });
    }
    if (req.method === "POST" && action === "cancel") {
      llmJobCancel(job, "cancel requested");
      return json(res, 200, {
        ok: true,
        job: llmJobSummary(job),
      });
    }
  }

  if (req.method === "GET" && pathname === "/directories") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    try {
      const pathParam = String(reqUrl.searchParams.get("path") || "").trim();
      const payload = await listLlmDirectories(pathParam || DEFAULT_LLM_FILE_ROOT_RELATIVE);
      return json(res, 200, payload);
    } catch (err) {
      if (isApiError(err)) {
        return json(res, err.apiStatus, err.apiPayload);
      }
      return json(res, 500, {
        error: "directories_failed",
        message: errorMessage(err),
      });
    }
  }

  if (
    (req.method === "POST" || req.method === "PATCH" || req.method === "DELETE") &&
    pathname === "/workspace/files"
  ) {
    return workspaceFilesService.handleRequest(req, res, {
      expectedToken: RUNNER_TOKEN,
      receivedToken: parseAuthToken(req),
      pathname,
    });
  }

  if (req.method === "GET" && pathname === "/files/content") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    try {
      const pathParam = String(reqUrl.searchParams.get("path") || "").trim();
      const rootDirParam = String(reqUrl.searchParams.get("rootDir") || "").trim();
      const payload = await readClientTextFile(pathParam, rootDirParam);
      return json(res, 200, payload);
    } catch (err) {
      if (isApiError(err)) {
        return json(res, err.apiStatus, err.apiPayload);
      }
      return json(res, 500, {
        error: "file_content_failed",
        message: errorMessage(err),
      });
    }
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/files/media") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseDebugAuthToken(req, reqUrl) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    try {
      const pathParam = String(reqUrl.searchParams.get("path") || "").trim();
      const rootDirParam = String(reqUrl.searchParams.get("rootDir") || "").trim();
      await sendClientMediaFile(req, res, pathParam, rootDirParam);
      return;
    } catch (err) {
      if (isApiError(err)) {
        return json(res, err.apiStatus, err.apiPayload);
      }
      return json(res, 500, {
        error: "file_media_failed",
        message: errorMessage(err),
      });
    }
  }

  if (req.method === "GET" && pathname === "/sessions") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    try {
      const directory = String(reqUrl.searchParams.get("directory") || "").trim() || DEFAULT_LLM_FILE_ROOT_RELATIVE;
      const source = normalizeSessionSource(reqUrl.searchParams.get("source"), "all");
      const limit = normalizeSessionListLimit(reqUrl.searchParams.get("limit"));
      const payload = await listLlmSessions(directory, { source, limit });
      return json(res, 200, payload);
    } catch (err) {
      if (isApiError(err)) {
        return json(res, err.apiStatus, err.apiPayload);
      }
      return json(res, 500, {
        error: "sessions_failed",
        message: errorMessage(err),
      });
    }
  }

  if (req.method === "POST" && pathname === "/sessions/read") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    try {
      const routeStartedAtMs = Date.now();
      const bodyReadStartedAtMs = Date.now();
      const body = await readJsonBody(req);
      const bodyReadMs = Math.max(0, Date.now() - bodyReadStartedAtMs);
      const markReadStartedAtMs = Date.now();
      const payload = await markLlmSessionRead(body?.sessionId, {
        directory: body?.directory,
        source: body?.source,
        lastReadAt: body?.lastReadAt,
      });
      const markReadMs = Math.max(0, Date.now() - markReadStartedAtMs);
      const routeTotalMs = Math.max(0, Date.now() - routeStartedAtMs);
      const diagnostics = payload?.diagnostics && typeof payload.diagnostics === "object"
        ? payload.diagnostics
        : {};
      return json(res, 200, {
        ok: true,
        ...payload,
        diagnostics: {
          ...diagnostics,
          routeBodyReadMs: bodyReadMs,
          routeMarkReadMs: markReadMs,
          routeTotalMs,
        },
      });
    } catch (err) {
      if (isApiError(err)) {
        return json(res, err.apiStatus, err.apiPayload);
      }
      return json(res, 500, {
        error: "session_read_failed",
        message: errorMessage(err),
      });
    }
  }

  if (req.method === "GET" && pathname === "/session-messages") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    try {
      const routeStartedAt = Date.now();
      const sessionId = String(reqUrl.searchParams.get("sessionId") || "").trim();
      const source = normalizeSessionSource(reqUrl.searchParams.get("source"), "all");
      const directory = String(reqUrl.searchParams.get("directory") || "").trim();
      const limit = normalizeSessionMessagesLimit(reqUrl.searchParams.get("limit"));
      const payloadStartedAt = Date.now();
      const payload = await listLlmSessionMessages(sessionId, {
        source,
        directory,
        limit,
      });
      const payloadBuildMs = Math.max(0, Date.now() - payloadStartedAt);
      const diagnostics = payload?.diagnostics && typeof payload.diagnostics === "object"
        ? payload.diagnostics
        : {};
      const responsePayload = {
        ...payload,
        diagnostics: {
          ...diagnostics,
          routePayloadBuildMs: payloadBuildMs,
          routeTotalMs: Math.max(0, Date.now() - routeStartedAt),
        },
      };
      const serializeStartedAt = Date.now();
      const body = JSON.stringify(responsePayload);
      const serializeMs = Math.max(0, Date.now() - serializeStartedAt);
      const routeTotalMs = Math.max(0, Date.now() - routeStartedAt);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
        "x-session-messages-serialize-ms": String(serializeMs),
        "x-session-messages-response-bytes": String(Buffer.byteLength(body)),
        "x-session-messages-route-total-ms": String(routeTotalMs),
      });
      res.end(body);
      return;
    } catch (err) {
      if (isApiError(err)) {
        return json(res, err.apiStatus, err.apiPayload);
      }
      return json(res, 500, {
        error: "session_messages_failed",
        message: errorMessage(err),
      });
    }
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname.startsWith("/tts-media/")) {
    let mediaKey = "";
    try {
      mediaKey = decodeURIComponent(pathname.slice("/tts-media/".length)).trim();
    } catch {
      mediaKey = "";
    }
    if (!mediaKey) {
      return notFound(res);
    }
    const entry = ttsMediaEntries.get(mediaKey);
    if (!entry) {
      return notFound(res);
    }
    if (Number(entry.expiresAt || 0) <= Date.now()) {
      await removeTtsMediaEntry(mediaKey, entry);
      return notFound(res);
    }
    try {
      const file = await fs.readFile(entry.filePath);
      const totalBytes = file.byteLength;
      const baseHeaders = {
        "content-type": String(entry.mimeType || "application/octet-stream"),
        "content-disposition": buildInlineContentDisposition(`tts.${String(entry.ext || "bin")}`),
        "cache-control": "no-store",
        "accept-ranges": "bytes",
      };
      const rangeHeader = String(req.headers.range || "").trim();
      if (rangeHeader) {
        const range = parseSingleByteRange(rangeHeader, totalBytes);
        if (!range) {
          res.writeHead(416, {
            ...baseHeaders,
            "content-range": `bytes */${totalBytes}`,
            "content-length": "0",
          });
          res.end();
          return;
        }
        const chunk = file.subarray(range.start, range.end + 1);
        res.writeHead(206, {
          ...baseHeaders,
          "content-length": chunk.byteLength,
          "content-range": `bytes ${range.start}-${range.end}/${totalBytes}`,
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        res.end(chunk);
        return;
      }
      res.writeHead(200, {
        ...baseHeaders,
        "content-length": totalBytes,
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(file);
      return;
    } catch {
      await removeTtsMediaEntry(mediaKey, entry);
      return notFound(res);
    }
  }

  if (req.method === "POST" && pathname === "/reply") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }

    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    return handleReplyHttpEndpoint(req, res, {
      logLabel: "reply",
      internalErrorCode: "runner_failed",
    });
  }

  if (req.method === "POST" && pathname === "/reply-files") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }

    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    return handleReplyHttpEndpoint(req, res, {
      logLabel: "reply-files",
      internalErrorCode: "runner_files_failed",
    });
  }

  if (req.method === "POST" && pathname === "/client-logs") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    try {
      const body = await readJsonBody(req);
      const eventsRaw = Array.isArray(body?.events) ? body.events : [];
      if (eventsRaw.length <= 0) {
        return json(res, 400, {
          error: "events_required",
          message: "events must be a non-empty array",
        });
      }
      if (eventsRaw.length > CLIENT_APP_LOG_MAX_EVENTS_PER_REQUEST) {
        return json(res, 400, {
          error: "too_many_events",
          max: CLIENT_APP_LOG_MAX_EVENTS_PER_REQUEST,
        });
      }
      await appendClientAppLogs({
        source: body?.source,
        sessionId: body?.sessionId,
        device: body?.device,
        remoteAddress: req.socket?.remoteAddress || "",
        events: eventsRaw,
      });
      return json(res, 200, {
        ok: true,
        accepted: eventsRaw.length,
        logPath: path.relative(WORKSPACE_ROOT, CLIENT_APP_LOG_PATH),
      });
    } catch (err) {
      console.error("[client-logs] failed", err);
      return json(res, 500, {
        error: "client_logs_failed",
        message: errorMessage(err),
      });
    }
  }

  if (req.method === "POST" && pathname === "/stt") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }

    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }

    if (!GROQ_API_KEY) {
      return json(res, 500, {
        error: "stt_key_missing",
        message: "GROQ_API_KEY is required for /stt",
      });
    }

    try {
      const contentType = String(req.headers["content-type"] || "").toLowerCase();
      let audioBuffer = Buffer.alloc(0);
      let mimeType = "audio/m4a";
      let fileName = "recording.m4a";
      let language = normalizeSttLanguage(GROQ_STT_LANGUAGE);

      if (!contentType.includes("multipart/form-data")) {
        return json(res, 415, {
          error: "stt_multipart_required",
          message: "Use multipart/form-data with file field",
        });
      }

      const requestForForm = new Request(`http://runner.local${pathname}`, {
        method: req.method,
        headers: req.headers,
        body: req,
        duplex: "half",
      });
      const form = await requestForForm.formData();
      const filePart = form.get("file");
      if (!filePart || typeof filePart.arrayBuffer !== "function") {
        return json(res, 400, { error: "audio_required" });
      }
      const ab = await filePart.arrayBuffer();
      audioBuffer = Buffer.from(ab);
      mimeType = String(filePart.type || form.get("mimeType") || mimeType).trim() || mimeType;
      fileName = String(filePart.name || form.get("fileName") || fileName).trim() || fileName;
      language = normalizeSttLanguage(String(form.get("language") || GROQ_STT_LANGUAGE));

      if (!audioBuffer.length) {
        return json(res, 400, { error: "audio_empty" });
      }
      if (audioBuffer.length > MAX_AUDIO_BYTES) {
        return json(res, 400, {
          error: "audio_too_large",
          max: MAX_AUDIO_BYTES,
        });
      }

      const transcript = await runGroqStt(audioBuffer, { mimeType, fileName, language });
      return json(res, 200, {
        transcript,
        provider: "groq",
        language: language || undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = /timeout/i.test(message);
      console.error("[stt] failed", { message, isTimeout });
      return json(res, isTimeout ? 504 : 500, {
        error: isTimeout ? "stt_timeout" : "stt_failed",
        message,
      });
    }
  }

  if (req.method === "GET" && pathname === "/voices") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }

    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }

    try {
      const ttsProvider = resolveTtsProvider(reqUrl.searchParams.get("ttsProvider"));
      if (!isSupportedTtsProvider(ttsProvider)) {
        return json(res, 400, {
          error: "tts_provider_invalid",
          message: `Unsupported ttsProvider: ${ttsProvider}`,
          supportedProviders: Array.from(SUPPORTED_TTS_PROVIDERS),
        });
      }

      if (ttsProvider === "elevenlabs" && !ELEVENLABS_API_KEY) {
        return json(res, 500, {
          error: "tts_key_missing",
          message: "ELEVENLABS_API_KEY is required for /voices when ttsProvider=elevenlabs",
        });
      }

      if (ttsProvider === "google" && !GOOGLE_CLOUD_PROJECT_ID) {
        return json(res, 500, {
          error: "tts_project_missing",
          message: "GOOGLE_CLOUD_PROJECT_ID is required for /voices when ttsProvider=google",
        });
      }

      const voices = ttsProvider === "google"
        ? await listGoogleCloudVoices()
        : ttsProvider === "aivisspeech"
          ? await listAivisSpeechVoices()
          : await listElevenLabsVoices();
      const defaultVoiceId = ttsProvider === "google"
        ? GOOGLE_CLOUD_TTS_VOICE_NAME
        : ttsProvider === "aivisspeech"
          ? resolveAivisSpeechDefaultVoiceId(voices)
          : ELEVENLABS_VOICE_ID;
      return json(res, 200, {
        voices,
        defaultVoiceId,
        provider: ttsProvider,
      });
    } catch (err) {
      console.error("[voices] failed", err);
      if (isApiError(err)) {
        return json(res, err.apiStatus, err.apiPayload);
      }
      return json(res, 500, {
        error: "voices_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (req.method === "POST" && pathname === "/tts") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }

    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }

    try {
      const body = await readJsonBody(req);
      const ttsProvider = resolveTtsProvider(body.ttsProvider);
      const sourceText = String(body.text || "").trim();
      const text = sanitizeTtsInputText(sourceText);
      const voiceId = String(body.voiceId || "").trim();
      const modelId = String(body.modelId || "").trim();
      const outputFormat = String(body.outputFormat || "").trim();
      const languageCode = String(body.languageCode || "").trim();
      const audioEncoding = String(body.audioEncoding || "").trim();
      const applyLanguageTextNormalization =
        typeof body.applyLanguageTextNormalization === "boolean"
          ? body.applyLanguageTextNormalization
          : undefined;
      let speedScale;
      try {
        speedScale = parseOptionalSpeedScale(body.speedScale);
      } catch (err) {
        return json(res, 400, {
          error: "speed_scale_invalid",
          message: err instanceof Error ? err.message : String(err),
        });
      }

      if (!isSupportedTtsProvider(ttsProvider)) {
        return json(res, 400, {
          error: "tts_provider_invalid",
          message: `Unsupported ttsProvider: ${ttsProvider}`,
          supportedProviders: Array.from(SUPPORTED_TTS_PROVIDERS),
        });
      }

      if (ttsProvider === "elevenlabs" && !ELEVENLABS_API_KEY) {
        return json(res, 500, {
          error: "tts_key_missing",
          message: "ELEVENLABS_API_KEY is required for /tts when ttsProvider=elevenlabs",
        });
      }

      if (ttsProvider === "google" && !GOOGLE_CLOUD_PROJECT_ID) {
        return json(res, 500, {
          error: "tts_project_missing",
          message: "GOOGLE_CLOUD_PROJECT_ID is required for /tts when ttsProvider=google",
        });
      }

      if (!text) {
        return json(res, 400, { error: "text_required" });
      }
      if (text.length > MAX_TTS_CHARS) {
        return json(res, 400, {
          error: "text_too_long",
          max: MAX_TTS_CHARS,
        });
      }

      const tts = await runTtsByProvider(ttsProvider, text, {
        voiceId: voiceId || undefined,
        modelId: modelId || undefined,
        outputFormat: outputFormat || undefined,
        languageCode: languageCode || undefined,
        audioEncoding: audioEncoding || undefined,
        applyLanguageTextNormalization,
        speedScale,
      });
      const publicBaseUrl = resolvePublicBaseUrl(req, reqUrl);
      const media = await registerTtsMedia(tts.audioBuffer, tts.mimeType, publicBaseUrl);
      return json(res, 200, {
        audioUrl: media.audioUrl,
        audioBytes: media.audioBytes,
        mimeType: tts.mimeType,
        provider: tts.provider,
        voiceId: tts.voiceId,
        modelId: tts.modelId,
        outputFormat: tts.outputFormat,
        languageCode: tts.languageCode,
        audioEncoding: tts.audioEncoding,
        speedScale: tts.speedScale,
      });
    } catch (err) {
      console.error("[tts] failed", err);
      if (isApiError(err)) {
        return json(res, err.apiStatus, err.apiPayload);
      }
      return json(res, 500, {
        error: "tts_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (req.method === "POST" && pathname === "/youtube-videos") {
    if (!RUNNER_TOKEN) {
      return json(res, 500, {
        error: "runner_token_missing",
        message: "RUNNER_TOKEN is required",
      });
    }
    if (parseAuthToken(req) !== RUNNER_TOKEN) {
      return json(res, 401, { error: "unauthorized" });
    }
    try {
      const body = await readJsonBody(req);
      const videoIds = normalizeYouTubeVideoIds(body?.videoIds);
      if (videoIds.length === 0) {
        return json(res, 400, {
          error: "video_ids_required",
          message: "videoIds must include at least one YouTube video ID",
        });
      }
      const results = await fetchYouTubeVideosMetadata(videoIds);
      return json(res, 200, {
        results,
      });
    } catch (err) {
      console.error("[youtube-videos] failed", err);
      if (isApiError(err)) {
        return json(res, err.apiStatus, err.apiPayload);
      }
      return json(res, 500, {
        error: "youtube_videos_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return notFound(res);
});

const runnerWsEnvelopeClients = new WeakSet();
const runnerWsActiveClients = new Set();
const runnerWsServer = new WebSocketServer({ noServer: true });
const wsServer = new WebSocketServer({ noServer: true });
const codexProxyWsServer = new WebSocketServer({ noServer: true });

runnerWsServer.on("connection", (ws, req) => {
  const reqUrl = req ? parseRequestUrl(req) : { pathname: RUNNER_WS_PATH };
  const remote = String(req?.socket?.remoteAddress || "unknown");
  const publicBaseUrl = resolvePublicBaseUrl(req, reqUrl);
  const connectionId = `runner_ws_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const protocolList = req?.headers?.["sec-websocket-protocol"];
  const protocols = Array.isArray(protocolList)
    ? protocolList
    : (protocolList ? String(protocolList).split(",").map((item) => item.trim()).filter(Boolean) : []);
  let llmRelay = null;
  let attachedTtsJobId = "";
  runnerWsActiveClients.add(ws);
  runnerWsEnvelopeClients.add(ws);
  codexWsRelayClientMode.set(ws, "runner-ws-envelope");

  function resolveAttachedTtsJob() {
    if (!attachedTtsJobId) return null;
    return getLlmJobById(attachedTtsJobId);
  }

  function attachRunnerWsTtsJob(job, sinceSeq = 0) {
    if (!job) return false;
    const previous = resolveAttachedTtsJob();
    if (previous && previous.jobId !== job.jobId) {
      llmJobDetachSubscriber(previous, ws);
    }
    attachedTtsJobId = job.jobId;
    llmJobAttachSubscriber(job, ws, { sinceSeq });
    return true;
  }

  function detachRunnerWsTtsJob() {
    const attached = resolveAttachedTtsJob();
    if (attached) {
      llmJobDetachSubscriber(attached, ws);
    }
    attachedTtsJobId = "";
  }

  function attachRunnerWsToRelay(relay, options = {}) {
    if (!relay || relay.closed) return 0;
    if (llmRelay && llmRelay !== relay) {
      removeClientFromRelay(llmRelay, ws);
    }
    llmRelay = relay;
    return attachClientToCodexRelay(relay, ws, {
      replayAfterSeq: options.replayAfterSeq || 0,
      replayApprovalOnlyWhenSeqZero: Boolean(options.replayApprovalOnlyWhenSeqZero),
      envelopeMode: true,
    });
  }

  function ensureRunnerWsLlmRelay() {
    if (llmRelay && !llmRelay.closed) return llmRelay;
    llmRelay = createCodexRelayWithUpstream({
      endpoint: RUNNER_WS_PATH,
      remote,
      upstreamUrl: CODEX_WS_PROXY_UPSTREAM_URL,
      protocols,
    });
    attachRunnerWsToRelay(llmRelay, { replayAfterSeq: 0 });
    return llmRelay;
  }

  function normalizeRunnerWsLlmRpcPayload(payload) {
    if (typeof payload === "string") {
      const trimmed = payload.trim();
      if (!trimmed) return { ok: false, error: "payload must not be empty" };
      return { ok: true, text: trimmed };
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, error: "payload must be a JSON-RPC object" };
    }
    try {
      return { ok: true, text: JSON.stringify(payload) };
    } catch {
      return { ok: false, error: "payload must be JSON serializable" };
    }
  }

  sendRunnerWsEnvelope(ws, {
    channel: "control",
    op: "ready",
    sessionId: connectionId,
    payload: {
      endpoint: RUNNER_WS_PATH,
      channels: Array.from(RUNNER_WS_CHANNELS),
    },
  });

  ws.on("message", (raw, isBinary) => {
    const parsed = parseRunnerWsEnvelope(raw, isBinary);
    if (!parsed.ok) {
      sendRunnerWsEnvelope(
        ws,
        runnerWsErrorEnvelope("invalid_envelope", parsed.error, { endpoint: RUNNER_WS_PATH })
      );
      return;
    }

    const message = parsed.message;
    if (message.channel === "control" && message.op === "ping") {
      const activeRelays = Array.from(codexWsRelaysById.values())
        .filter((relay) => relay && !relay.closed);
      const statusRelay = (llmRelay && !llmRelay.closed ? llmRelay : null)
        || activeRelays
          .slice()
          .sort((a, b) => Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0))[0]
        || null;
      const lastRelayEvent = statusRelay?.eventLog?.length
        ? statusRelay.eventLog[statusRelay.eventLog.length - 1]
        : null;
      const upstreamReadyState = Number(statusRelay?.upstreamWs?.readyState);
      const codexQueuedCount = Array.from(codexQueuedTurnsById.values())
        .filter((turn) => turn && (turn.status === "queued" || turn.status === "waiting_compact")).length;
      const codexRunningQueuedTurnCount = Array.from(codexQueuedTurnsById.values())
        .filter((turn) => turn && turn.status === "running").length;
      const codexCompactRunningCount = Array.from(codexCompactByThreadId.values())
        .filter((compact) => compact && compact.status === "running").length;
      sendRunnerWsEnvelope(ws, {
        channel: "control",
        op: "pong",
        requestId: message.requestId,
        sessionId: message.sessionId || connectionId,
        payload: {
          endpoint: RUNNER_WS_PATH,
          at: new Date().toISOString(),
          status: {
            runnerWsConnectionCount: runnerWsActiveClients.size,
            activeRelayCount: activeRelays.length,
            relayClientCount: statusRelay?.clients?.size || 0,
            upstreamOpen: statusRelay ? Boolean(statusRelay.upstreamOpen) : undefined,
            upstreamReadyState: Number.isFinite(upstreamReadyState) ? upstreamReadyState : undefined,
            upstreamQueueCount: Array.isArray(statusRelay?.pendingToUpstream)
              ? statusRelay.pendingToUpstream.length
              : 0,
            lastSeq: Number(statusRelay?.lastSeq || 0),
            pendingRpcCount: statusRelay?.requestIdByRpcId instanceof Map
              ? statusRelay.requestIdByRpcId.size
              : 0,
            pendingApprovalCount: statusRelay?.pendingApprovalRequestIds instanceof Set
              ? statusRelay.pendingApprovalRequestIds.size
              : 0,
            codexQueuedTurnCount: codexQueuedCount,
            codexRunningQueuedTurnCount,
            codexCompactRunningCount,
            turnState: String(statusRelay?.turnStatus || (
              statusRelay?.turnCompleted ? "completed" : (statusRelay?.turnStarted ? "running" : "")
            )),
            lastEventAtMs: Number(lastRelayEvent?.atMs || 0),
          },
        },
      });
      return;
    }

    if (message.channel === "relay" && (message.op === "attach" || message.op === "resume")) {
      const threadId = String(message.threadId || "").trim();
      const replayAfterSeq = Number.isFinite(Number(message.seq || 0))
        ? Math.max(0, Math.floor(Number(message.seq || 0)))
        : 0;
      const relay = pickBestRelayForThread(threadId);
      if (!threadId || !relay || relay.closed) {
        sendCodexRelayControl(null, ws, {
          type: "runner_relay_resume_miss",
          threadId,
          resumeFromSeq: replayAfterSeq,
        });
        return;
      }
      attachRunnerWsToRelay(relay, {
        replayAfterSeq,
        replayApprovalOnlyWhenSeqZero: replayAfterSeq === 0,
      });
      return;
    }

    if (message.channel === "llm" && message.op === "rpc") {
      const normalized = normalizeRunnerWsLlmRpcPayload(message.payload);
      if (!normalized.ok) {
        sendRunnerWsEnvelope(
          ws,
          runnerWsErrorEnvelope("invalid_llm_rpc_payload", normalized.error, {
            requestId: message.requestId || "",
            sessionId: message.sessionId || "",
            threadId: message.threadId || "",
          })
        );
        return;
      }
      const relay = ensureRunnerWsLlmRelay();
      const requestId = String(message.requestId || "").trim();
      const meta = parseCodexRpcMeta(normalized.text, false);
      if (requestId) {
        sendRunnerWsLlmRpcAck(relay, ws, {
          op: "llm_rpc_received",
          requestId,
          method: meta?.method || "",
          id: Number.isInteger(meta?.id) ? Number(meta.id) : null,
          threadId: message.threadId || meta?.threadId || relay.threadId || "",
          state: "received",
        });
      }
      void appendCodexWsProxyDebug("runner_ws_llm_rpc_received", {
        remote,
        endpoint: RUNNER_WS_PATH,
        relayId: relay.relayId,
        requestId,
        method: meta?.method || "",
        id: Number.isInteger(meta?.id) ? Number(meta.id) : null,
        threadId: message.threadId || meta?.threadId || relay.threadId || "",
      });
      if (message.threadId) {
        bindCodexRelayThreadMapping(relay, message.threadId, { allowSwitch: true });
        cleanupNoClientRelaysForThread(message.threadId, relay, "runner_ws_llm_rebind");
      }
      forwardCodexRelayClientData(relay, normalized.text, false, {
        remote,
        endpoint: RUNNER_WS_PATH,
        requestId,
      });
      if (requestId) {
        sendRunnerWsLlmRpcAck(relay, ws, {
          op: "llm_rpc_forwarded",
          requestId,
          method: meta?.method || "",
          id: Number.isInteger(meta?.id) ? Number(meta.id) : null,
          threadId: message.threadId || meta?.threadId || relay.threadId || "",
          state: "forwarded",
        });
      }
      return;
    }

    if (message.channel === "tts" && message.op === "attach") {
      const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
      const jobId = String(message.streamId || payload?.jobId || "").trim();
      const sinceSeqRaw = Number.isFinite(Number(message.seq))
        ? Number(message.seq)
        : Number(payload?.sinceSeq || 0);
      const sinceSeq = Number.isFinite(sinceSeqRaw) ? Math.max(0, Math.floor(sinceSeqRaw)) : 0;
      const job = getLlmJobById(jobId);
      if (!job) {
        sendRunnerWsEnvelope(ws, {
          channel: "tts",
          op: "error",
          streamId: jobId,
          payload: {
            type: "error",
            error: "job_not_found",
            message: `job not found: ${jobId}`,
          },
        });
        return;
      }
      attachRunnerWsTtsJob(job, sinceSeq);
      sendRunnerWsEnvelope(ws, {
        channel: "tts",
        op: "attached",
        streamId: job.jobId,
        seq: sinceSeq,
        payload: {
          type: "attached",
          jobId: job.jobId,
          status: job.status,
          sinceSeq,
        },
      });
      return;
    }

    if (message.channel === "tts" && message.op === "tool_approval_decision") {
      const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
      const requestId = String(payload?.requestId || message.requestId || "").trim();
      if (!requestId) return;
      const targetJobId = String(message.streamId || payload?.jobId || attachedTtsJobId || "").trim();
      if (!targetJobId) return;
      const job = getLlmJobById(targetJobId);
      if (!job) return;
      const pending = job.pendingApprovals.get(requestId) || null;
      const approved = Boolean(payload?.approved);
      const note = String(payload?.note || "").trim();
      const settled = settleJobPendingApproval(job, requestId, { approved, note }, false);
      if (approved && settled && pending?.approvalKey && pending?.sessionId) {
        rememberToolApprovalInSession(pending.sessionId, pending.approvalKey);
      }
      return;
    }

    if (message.channel === "tts" && message.op === "start") {
      const payload = message.payload && typeof message.payload === "object" ? message.payload : null;
      if (!payload) {
        sendRunnerWsEnvelope(
          ws,
          runnerWsErrorEnvelope("invalid_tts_start_payload", "payload must be a stream-tts start object", {
            requestId: message.requestId || "",
            sessionId: message.sessionId || "",
            streamId: message.streamId || "",
          })
        );
        return;
      }
      try {
        const job = startLlmStreamJob(payload, {
          endpoint: RUNNER_WS_PATH,
          remoteAddress: remote,
          publicBaseUrl,
        });
        attachRunnerWsTtsJob(job, 0);
        sendRunnerWsEnvelope(ws, {
          channel: "tts",
          op: "job_started",
          requestId: message.requestId || "",
          streamId: job.jobId,
          sessionId: String(job.sessionId || ""),
          payload: {
            type: "job_started",
            jobId: job.jobId,
            status: job.status,
          },
        });
      } catch (err) {
        if (isApiError(err)) {
          sendRunnerWsEnvelope(ws, {
            channel: "tts",
            op: "error",
            requestId: message.requestId || "",
            sessionId: message.sessionId || "",
            streamId: message.streamId || "",
            payload: {
              type: "error",
              ...err.apiPayload,
            },
          });
          return;
        }
        const rawMessage = err instanceof Error ? err.message : String(err);
        sendRunnerWsEnvelope(ws, {
          channel: "tts",
          op: "error",
          requestId: message.requestId || "",
          sessionId: message.sessionId || "",
          streamId: message.streamId || "",
          payload: {
            type: "error",
            error: "stream_tts_failed",
            message: rawMessage,
            detail: rawMessage,
          },
        });
      }
      return;
    }

    sendRunnerWsEnvelope(
      ws,
      runnerWsErrorEnvelope("channel_not_implemented", `${message.channel}:${message.op} is not implemented yet`, {
        channel: message.channel,
        op: message.op,
        requestId: message.requestId || "",
        sessionId: message.sessionId || "",
        threadId: message.threadId || "",
        streamId: message.streamId || "",
      })
    );
  });

  ws.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error || "runner_ws_error");
    if (llmRelay) {
      removeClientFromRelay(llmRelay, ws);
      cleanupOrScheduleDetachedRelay(llmRelay, "runner_ws_error");
    } else {
      codexWsRelayClientMode.delete(ws);
    }
    detachRunnerWsTtsJob();
    runnerWsActiveClients.delete(ws);
    runnerWsEnvelopeClients.delete(ws);
    void appendCodexWsProxyDebug("runner_ws_error", {
      remote,
      endpoint: reqUrl.pathname,
      connectionId,
      message,
    });
  });

  ws.on("close", () => {
    detachRunnerWsTtsJob();
    runnerWsActiveClients.delete(ws);
    runnerWsEnvelopeClients.delete(ws);
    if (!llmRelay) {
      codexWsRelayClientMode.delete(ws);
      return;
    }
    removeClientFromRelay(llmRelay, ws);
    cleanupOrScheduleDetachedRelay(llmRelay, "runner_ws_detached");
  });
});

wsServer.on("connection", (ws, req) => {
  sendWsJson(ws, { type: "ready" });
  const wsReqUrl = req ? parseRequestUrl(req) : { pathname: "/stream-tts" };
  const wsEndpoint = String(wsReqUrl?.pathname || "/stream-tts");
  const wsRemoteAddress = String(req?.socket?.remoteAddress || "");
  const wsPublicBaseUrl = resolvePublicBaseUrl(req, wsReqUrl);

  let started = false;
  let attachedJobId = "";

  function resolveAttachedJob() {
    if (!attachedJobId) return null;
    return getLlmJobById(attachedJobId);
  }

  function attachJob(job, sinceSeq = 0) {
    if (!job) return false;
    const previous = resolveAttachedJob();
    if (previous && previous.jobId !== job.jobId) {
      llmJobDetachSubscriber(previous, ws);
    }
    attachedJobId = job.jobId;
    llmJobAttachSubscriber(job, ws, { sinceSeq });
    return true;
  }

  ws.on("close", () => {
    const attached = resolveAttachedJob();
    if (attached) {
      llmJobDetachSubscriber(attached, ws);
    }
  });

  ws.on("error", () => {
    const attached = resolveAttachedJob();
    if (attached) {
      llmJobDetachSubscriber(attached, ws);
    }
  });

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let payload;
    try {
      payload = JSON.parse(String(raw || ""));
    } catch {
      sendWsJson(ws, {
        type: "error",
        error: "invalid_json",
        message: "first message must be valid JSON",
      });
      return;
    }

    const messageType = String(payload?.type || "");

    if (!started && messageType !== "start" && messageType !== "attach") {
      sendWsJson(ws, {
        type: "error",
        error: "invalid_message",
        message: "first message must be {\"type\":\"start\", ...} or {\"type\":\"attach\", ...}",
      });
      return;
    }

    if (messageType === "attach") {
      const jobId = String(payload?.jobId || "").trim();
      const sinceSeqRaw = Number(payload?.sinceSeq || 0);
      const sinceSeq = Number.isFinite(sinceSeqRaw) ? Math.max(0, Math.floor(sinceSeqRaw)) : 0;
      if (!jobId) {
        sendWsJson(ws, {
          type: "error",
          error: "job_id_required",
          message: "jobId is required",
        });
        return;
      }
      const job = getLlmJobById(jobId);
      if (!job) {
        sendWsJson(ws, {
          type: "error",
          error: "job_not_found",
          message: `job not found: ${jobId}`,
        });
        return;
      }
      started = true;
      attachJob(job, sinceSeq);
      sendWsJson(ws, {
        type: "attached",
        jobId: job.jobId,
        status: job.status,
        sinceSeq,
      });
      return;
    }

    if (messageType === "tool_approval_decision") {
      const requestId = String(payload?.requestId || "").trim();
      if (!requestId) return;
      const targetJobId = String(payload?.jobId || attachedJobId || "").trim();
      if (!targetJobId) return;
      const job = getLlmJobById(targetJobId);
      if (!job) return;
      const pending = job.pendingApprovals.get(requestId) || null;
      const approved = Boolean(payload?.approved);
      const note = String(payload?.note || "").trim();
      const settled = settleJobPendingApproval(job, requestId, { approved, note }, false);
      if (approved && settled && pending?.approvalKey && pending?.sessionId) {
        rememberToolApprovalInSession(pending.sessionId, pending.approvalKey);
      }
      if (RUNNER_LOG_REQUESTS) {
        console.log(
          `[approval] decision jobId=${targetJobId} requestId=${requestId} approved=${approved} settled=${settled} note=${JSON.stringify(note)}`
        );
      }
      return;
    }

    if (started) return;

    if (messageType !== "start") return;
    started = true;
    try {
      const job = startLlmStreamJob(payload, {
        endpoint: wsEndpoint,
        remoteAddress: wsRemoteAddress,
        publicBaseUrl: wsPublicBaseUrl,
      });
      attachJob(job, 0);
      sendWsJson(ws, {
        type: "job_started",
        jobId: job.jobId,
        status: job.status,
      });
    } catch (err) {
      if (isApiError(err)) {
        sendWsJson(ws, {
          type: "error",
          ...err.apiPayload,
        });
        return;
      }
      const rawMessage = err instanceof Error ? err.message : String(err);
      sendWsJson(ws, {
        type: "error",
        error: "stream_tts_failed",
        message: rawMessage,
        detail: rawMessage,
      });
    }
  });
});

const codexWsRelaysById = new Map();
const codexWsRelayIdByThreadId = new Map();
const codexWsRelayClientMode = new WeakMap();
let codexWsRelayCounter = 0;

function codexRelayNowMs() {
  return Date.now();
}

function createCodexWsRelayId() {
  codexWsRelayCounter += 1;
  return `relay_${codexRelayNowMs()}_${codexWsRelayCounter}`;
}

function safeWsSend(ws, data, options) {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(data, options);
    return true;
  } catch {
    return false;
  }
}

function safeWsClose(ws, code = 1000, reason = "closed") {
  const normalizedCode = Number.isFinite(Number(code)) ? Number(code) : 1000;
  const normalizedReason = String(reason || "closed");
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(normalizedCode, normalizedReason);
    }
  } catch {}
}

function sendRelayControl(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function isRunnerWsEnvelopeClient(ws) {
  return runnerWsEnvelopeClients.has(ws);
}

function isCodexRelayEnvelopeClient(ws) {
  return codexWsRelayClientMode.get(ws) === "runner-ws-envelope" || isRunnerWsEnvelopeClient(ws);
}

function parseCodexRelayJsonPayload(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return String(text || "");
  }
}

function pickFirstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function extractImageGenerationCompactSummary(item) {
  const readImageUrl = (candidate) => {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      return trimmed || "";
    }
    if (!candidate || typeof candidate !== "object") return "";
    return pickFirstNonEmptyString(
      candidate.url,
      candidate.imageUrl,
      candidate.image_url,
      candidate.uri,
      candidate.src
    );
  };
  const readImageCollection = (candidate) => {
    if (!Array.isArray(candidate)) return { count: 0, coverImageUrl: "" };
    const count = candidate.length;
    let coverImageUrl = "";
    for (const entry of candidate) {
      const next = readImageUrl(entry);
      if (next) {
        coverImageUrl = next;
        break;
      }
    }
    return { count, coverImageUrl };
  };
  const candidates = [
    item.images,
    item.imageUrls,
    item.results,
    item.generatedImages,
    item.output?.images,
    item.output?.results,
    item.payload?.images,
    item.payload?.results,
  ];
  for (const candidate of candidates) {
    const summary = readImageCollection(candidate);
    if (summary.count > 0) return summary;
  }
  const directUrl = pickFirstNonEmptyString(
    item.coverImageUrl,
    item.thumbnailUrl,
    item.previewUrl,
    item.imageUrl,
    item.image_url
  );
  if (directUrl) {
    return { count: 1, coverImageUrl: directUrl };
  }
  return { count: 0, coverImageUrl: "" };
}

function compactImageGenerationItemForResume(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const summary = extractImageGenerationCompactSummary(item);
  const compact = {
    id: pickFirstNonEmptyString(item.id),
    type: "imageGeneration",
    status: pickFirstNonEmptyString(item.status, item.state, item.phase),
    createdAt: pickFirstNonEmptyString(item.createdAt),
    startedAt: pickFirstNonEmptyString(item.startedAt),
    completedAt: pickFirstNonEmptyString(item.completedAt),
    updatedAt: pickFirstNonEmptyString(item.updatedAt),
    error: item.error && typeof item.error === "object"
      ? {
          message: pickFirstNonEmptyString(item.error.message),
          code: pickFirstNonEmptyString(item.error.code),
        }
      : undefined,
    summary: {
      count: Number.isFinite(Number(summary.count)) ? Number(summary.count) : 0,
      coverImageUrl: summary.coverImageUrl || undefined,
    },
  };
  if (!compact.id) delete compact.id;
  if (!compact.status) delete compact.status;
  if (!compact.createdAt) delete compact.createdAt;
  if (!compact.startedAt) delete compact.startedAt;
  if (!compact.completedAt) delete compact.completedAt;
  if (!compact.updatedAt) delete compact.updatedAt;
  if (!compact.error?.message && !compact.error?.code) delete compact.error;
  if (!compact.summary.count && !compact.summary.coverImageUrl) delete compact.summary;
  return compact;
}

function sanitizeRunnerResumePayload(payload, responseRpcMethod) {
  if (String(responseRpcMethod || "").trim() !== "thread/resume") return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const result = payload.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return payload;
  const thread = result.thread;
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) return payload;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  if (turns.length === 0) return payload;
  for (const turn of turns) {
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) continue;
    const items = Array.isArray(turn.items) ? turn.items : [];
    if (items.length === 0) continue;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      if (String(item.type || "").trim() !== "imageGeneration") continue;
      items[i] = compactImageGenerationItemForResume(item);
    }
  }
  return payload;
}

function sendCodexRelayControl(relay, ws, payload) {
  if (!isCodexRelayEnvelopeClient(ws)) {
    return sendRelayControl(ws, payload);
  }
  const type = String(payload?.type || "").trim();
  const relayId = String(payload?.relayId || relay?.relayId || "").trim();
  const threadId = String(payload?.threadId || relay?.threadId || "").trim();
  if (type === "runner_relay_seq") {
    return sendRunnerWsEnvelope(ws, {
      channel: "relay",
      op: "seq",
      threadId,
      seq: Number(payload?.seq || 0),
      payload: { relayId },
    });
  }
  if (type === "runner_relay_attached") {
    return sendRunnerWsEnvelope(ws, {
      channel: "relay",
      op: "attached",
      threadId,
      seq: Number(payload?.latestSeq || 0),
      payload: {
        relayId,
        latestSeq: Number(payload?.latestSeq || 0),
        replayAfterSeq: Number(payload?.replayAfterSeq || 0),
        replayed: Number(payload?.replayed || 0),
        turnCompleted: Boolean(payload?.turnCompleted),
      },
    });
  }
  if (type === "runner_relay_resume_miss") {
    return sendRunnerWsEnvelope(ws, {
      channel: "relay",
      op: "resume_miss",
      threadId,
      seq: Number(payload?.resumeFromSeq || 0),
      payload: {
        resumeFromSeq: Number(payload?.resumeFromSeq || 0),
      },
    });
  }
  if (type === "runner_relay_closed") {
    return sendRunnerWsEnvelope(ws, {
      channel: "relay",
      op: "closed",
      threadId,
      payload: {
        relayId,
        reason: String(payload?.reason || "relay_closed"),
      },
    });
  }
  return sendRunnerWsEnvelope(ws, {
    channel: "relay",
    op: type.replace(/^runner_relay_/, "") || "event",
    threadId,
    payload,
  });
}

function sendRunnerWsLlmRpcAck(relay, ws, params = {}) {
  if (!isRunnerWsEnvelopeClient(ws) || !relay) return false;
  const requestId = String(params.requestId || "").trim();
  if (!requestId) return false;
  const op = String(params.op || "").trim();
  if (!op) return false;
  const method = String(params.method || "").trim();
  const threadId = String(params.threadId || relay.threadId || "").trim();
  const state = String(params.state || "").trim();
  const idRaw = Number(params.id);
  const ackPayload = {
    relayId: relay.relayId,
    method,
    id: Number.isInteger(idRaw) ? idRaw : undefined,
    threadId,
    state,
  };
  return sendRunnerWsEnvelope(ws, {
    channel: "control",
    op,
    requestId,
    threadId: threadId || undefined,
    payload: ackPayload,
  });
}

function sendCodexRelayRpcToClient(relay, ws, text, seq, options = {}) {
  if (!isCodexRelayEnvelopeClient(ws)) {
    const delivered = safeWsSend(ws, text, { binary: false });
    if (!delivered) return false;
    if (Number.isFinite(Number(seq)) && Number(seq) > 0) {
      sendCodexRelayControl(relay, ws, {
        type: "runner_relay_seq",
        relayId: relay.relayId,
        threadId: relay.threadId || "",
        seq: Number(seq),
      });
    }
    return true;
  }
  const responseRpcMethod = String(options.responseRpcMethod || "").trim();
  const parsedPayload = parseCodexRelayJsonPayload(text);
  const envelopePayload = sanitizeRunnerResumePayload(parsedPayload, responseRpcMethod);
  return sendRunnerWsEnvelope(ws, {
    channel: "llm",
    op: "rpc",
    threadId: relay.threadId || "",
    seq: Number.isFinite(Number(seq)) ? Number(seq) : undefined,
    payload: envelopePayload,
  });
}

function parseCodexRpcMeta(rawData, isBinary) {
  if (isBinary) return null;
  try {
    const pickFirstString = (...values) => {
      for (const value of values) {
        if (typeof value !== "string") continue;
        const trimmed = value.trim();
        if (trimmed) return trimmed;
      }
      return "";
    };
    const pickFirstBoolean = (...values) => {
      for (const value of values) {
        if (typeof value === "boolean") return value;
      }
      return null;
    };
    const buildCompactDebug = (method, params) => {
      if (!params || typeof params !== "object") return "";
      const compactRelatedMethods = new Set([
        "thread/status/changed",
        "thread/compacted",
        "thread/tokenUsage/updated",
        "item/started",
        "item/completed",
        "turn/completed",
        "error",
      ]);
      if (!compactRelatedMethods.has(method)) return "";
      const status = pickFirstString(
        params.status,
        params.state,
        params.phase,
        params.thread?.status,
        params.thread?.state,
        params.thread?.phase,
        params.turn?.status,
        params.turn?.state,
        params.turn?.phase
      );
      const idle = pickFirstBoolean(
        params.idle,
        params.thread?.idle,
        params.turn?.idle,
        params.isIdle,
        params.thread?.isIdle,
        params.turn?.isIdle
      );
      const busy = pickFirstBoolean(
        params.busy,
        params.thread?.busy,
        params.turn?.busy
      );
      const itemId = pickFirstString(params.item?.id);
      const itemType = pickFirstString(params.item?.type);
      const note = pickFirstString(
        params.message,
        params.error?.message
      );
      const debug = {
        keys: Object.keys(params).slice(0, 12),
        status,
        idle,
        busy,
        itemId,
        itemType,
        note: note ? note.slice(0, 140) : "",
      };
      try {
        return JSON.stringify(debug);
      } catch {
        return "";
      }
    };
    const text = Buffer.isBuffer(rawData)
      ? rawData.toString("utf8")
      : String(rawData ?? "");
    if (!text || text.length > 200000) return null;
    const payload = JSON.parse(text);
    const method = typeof payload?.method === "string" ? payload.method : "";
    const id = Number.isFinite(Number(payload?.id)) ? Number(payload.id) : null;
    const hasError = !!payload?.error;
    const hasResult = Object.prototype.hasOwnProperty.call(payload || {}, "result");
    const errorCode = Number.isFinite(Number(payload?.error?.code))
      ? Number(payload.error.code)
      : null;
    const errorMessage = typeof payload?.error?.message === "string"
      ? payload.error.message.trim()
      : "";
    const params = payload?.params && typeof payload.params === "object" ? payload.params : null;
    const result = payload?.result && typeof payload.result === "object" ? payload.result : null;
    const threadId = pickFirstString(
      params?.threadId,
      params?.thread_id,
      params?.sessionId,
      params?.session_id,
      params?.thread?.id,
      params?.thread?.threadId,
      params?.thread?.thread_id,
      params?.turn?.threadId,
      params?.turn?.thread_id,
      params?.turn?.thread?.id,
      result?.threadId,
      result?.thread_id,
      result?.sessionId,
      result?.session_id,
      result?.thread?.id,
      result?.thread?.threadId,
      result?.thread?.thread_id,
      result?.turn?.threadId,
      result?.turn?.thread_id,
      result?.turn?.thread?.id
    );
    const statusRaw = params
      ? pickFirstString(
        params.status,
        params.state,
        params.phase,
        params.thread?.status,
        params.thread?.state,
        params.thread?.phase,
        params.turn?.status,
        params.turn?.state,
        params.turn?.phase
      )
      : "";
    const threadStatus = statusRaw ? statusRaw.toLowerCase() : "";
    const itemId = params ? pickFirstString(params.item?.id) : "";
    const itemType = params ? pickFirstString(params.item?.type) : "";
    const turnStartModel =
      method === "turn/start" && typeof params?.model === "string"
        ? String(params.model)
        : "";
    const turnStartEffort =
      method === "turn/start" && typeof params?.effort === "string"
        ? String(params.effort)
        : "";
    const compactDebug = method ? buildCompactDebug(method, params) : "";
    return {
      method: method || "",
      id,
      hasError,
      hasResult,
      errorCode,
      errorMessage,
      threadId,
      threadStatus,
      itemId,
      itemType,
      turnStartModel,
      turnStartEffort,
      compactDebug,
    };
  } catch {
    return null;
  }
}

function isTerminalTurnStatus(statusRaw) {
  const status = String(statusRaw || "").trim().toLowerCase();
  return (
    status === "completed" ||
    status === "failed" ||
    status === "error" ||
    status === "interrupted" ||
    status === "cancelled" ||
    status === "canceled" ||
    status === "aborted" ||
    status === "stopped"
  );
}

function releaseCodexRelayThreadMapping(relay) {
  const knownThreadId = String(relay?.threadId || "").trim();
  if (!knownThreadId) return;
  const mapped = codexWsRelayIdByThreadId.get(knownThreadId);
  if (mapped === relay.relayId) {
    codexWsRelayIdByThreadId.delete(knownThreadId);
  }
}

function bindCodexRelayThreadMapping(relay, threadIdRaw, options = {}) {
  const nextThreadId = String(threadIdRaw || "").trim();
  if (!nextThreadId) return;
  const allowSwitch = Boolean(options.allowSwitch);
  if (relay.threadId === nextThreadId) return;
  if (relay.threadId && !allowSwitch) return;
  releaseCodexRelayThreadMapping(relay);
  relay.threadId = nextThreadId;
  codexWsRelayIdByThreadId.set(nextThreadId, relay.relayId);
}

function shouldBindRelayThreadFromUpstreamMethod(methodRaw) {
  const method = String(methodRaw || "").trim();
  if (!method) return false;
  if (method.startsWith("item/")) return true;
  if (method === "turn/started" || method === "turn/completed" || method === "turn/interrupted") return true;
  return false;
}

function isCodexRelayThreadMismatch(relayThreadIdRaw, eventThreadIdRaw) {
  const relayThreadId = String(relayThreadIdRaw || "").trim();
  const eventThreadId = String(eventThreadIdRaw || "").trim();
  return Boolean(relayThreadId && eventThreadId && relayThreadId !== eventThreadId);
}

function setCodexAgentMessageText(item, text) {
  if (!item || typeof item !== "object") return false;
  item.text = text;
  if (item.message && typeof item.message === "object") {
    item.message.text = text;
  }
  return true;
}

function normalizeCodexAgentMessageItemAssistantThinking(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return 0;
  if (String(item.type || "").trim() !== "agentMessage") return 0;
  const text = extractCodexAgentMessageText(item);
  if (!text || text.startsWith("思考中...")) return 0;
  setCodexAgentMessageText(item, prependAssistantThinkingText(text));
  return 1;
}

function normalizeCodexTurnAssistantThinkingMessages(turn) {
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return 0;
  let normalized = 0;
  const itemLists = [
    Array.isArray(turn.items) ? turn.items : null,
    Array.isArray(turn.output) ? turn.output : null,
  ].filter(Boolean);
  for (const items of itemLists) {
    for (const item of items) {
      normalized += normalizeCodexAgentMessageItemAssistantThinking(item);
    }
  }
  return normalized;
}

function normalizeCodexThreadAssistantThinkingMessages(thread) {
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) return 0;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  let normalized = 0;
  for (const turn of turns) {
    normalized += normalizeCodexTurnAssistantThinkingMessages(turn);
  }
  return normalized;
}

function normalizeCodexThreadReadAssistantThinkingRpcText(textRaw, responseRpcMethod) {
  const method = String(responseRpcMethod || "").trim();
  if (method !== "thread/read" && method !== "thread/resume") return String(textRaw || "");
  const text = String(textRaw || "");
  if (!text) return text;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return text;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return text;
  const result = payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
    ? payload.result
    : null;
  if (!result) return text;
  const candidates = [
    result.thread,
    result.data && typeof result.data === "object" && !Array.isArray(result.data) ? result.data.thread : null,
    result.data,
    result,
  ];
  let normalized = 0;
  for (const candidate of candidates) {
    normalized += normalizeCodexThreadAssistantThinkingMessages(candidate);
  }
  if (normalized <= 0) return text;
  return JSON.stringify(payload);
}

function getCodexTurnStartedId(payload) {
  const params = payload?.params && typeof payload.params === "object" ? payload.params : {};
  return pickFirstNonEmptyString(
    params.turnId,
    params.turn_id,
    params.turn?.id,
    params.turn?.turnId
  );
}

function getCodexAgentMessageItemIdFromParams(params) {
  return pickFirstNonEmptyString(
    params?.item?.id,
    params?.itemId,
    params?.item_id
  );
}

function normalizeCodexRelayAssistantThinkingRpcTexts(relay, textRaw) {
  const text = String(textRaw || "");
  if (!relay || !text) return [text];
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return [text];
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [text];
  const method = String(payload.method || "").trim();
  const params = payload.params && typeof payload.params === "object" ? payload.params : null;
  if (method === "turn/started") {
    const turnId = getCodexTurnStartedId(payload);
    if (
      relay.assistantThinkingTurnActive &&
      (!turnId || String(relay.assistantThinkingTurnId || "") === turnId)
    ) {
      return [text];
    }
    relay.assistantThinkingTurnId = turnId || "";
    relay.assistantThinkingTurnActive = true;
    relay.assistantThinkingBodyText = "";
    relay.assistantThinkingBodyTextByItemId = new Map();
    relay.assistantThinkingCurrentItemId = "";
    relay.assistantThinkingPrefixSent = false;
    return [text];
  }
  if (method === "turn/completed") {
    relay.assistantThinkingTurnActive = false;
    return [text];
  }
  if (method === "item/started") {
    const item = params?.item && typeof params.item === "object" ? params.item : null;
    if (String(item?.type || "").trim() === "agentMessage") {
      const itemId = getCodexAgentMessageItemIdFromParams(params);
      if (itemId) {
        relay.assistantThinkingCurrentItemId = itemId;
        if (!(relay.assistantThinkingBodyTextByItemId instanceof Map)) {
          relay.assistantThinkingBodyTextByItemId = new Map();
        }
        if (!relay.assistantThinkingBodyTextByItemId.has(itemId)) {
          relay.assistantThinkingBodyTextByItemId.set(itemId, "");
        }
      }
    }
    return [text];
  }
  if (method === "item/agentMessage/delta") {
    if (!params || typeof params.delta !== "string") return [text];
    const delta = String(params.delta || "");
    if (!delta) return [text];
    if (!(relay.assistantThinkingBodyTextByItemId instanceof Map)) {
      relay.assistantThinkingBodyTextByItemId = new Map();
    }
    const itemId = getCodexAgentMessageItemIdFromParams(params) ||
      String(relay.assistantThinkingCurrentItemId || "").trim() ||
      "__agent_message__";
    if (!relay.assistantThinkingBodyTextByItemId.has(itemId)) {
      relay.assistantThinkingBodyTextByItemId.set(itemId, "");
    }
    if (relay.assistantThinkingPrefixSent) {
      const nextItemText = `${String(relay.assistantThinkingBodyTextByItemId.get(itemId) || "")}${delta}`;
      relay.assistantThinkingBodyTextByItemId.set(itemId, nextItemText);
      relay.assistantThinkingBodyText = nextItemText;
      return [text];
    }
    relay.assistantThinkingPrefixSent = true;
    if (delta.startsWith("思考中...")) {
      const nextItemText = `${String(relay.assistantThinkingBodyTextByItemId.get(itemId) || "")}${delta}`;
      relay.assistantThinkingBodyTextByItemId.set(itemId, nextItemText);
      relay.assistantThinkingBodyText = nextItemText;
      return [text];
    }
    params.delta = prependAssistantThinkingText(delta);
    const nextItemText = `${String(relay.assistantThinkingBodyTextByItemId.get(itemId) || "")}${String(params.delta || "")}`;
    relay.assistantThinkingBodyTextByItemId.set(itemId, nextItemText);
    relay.assistantThinkingBodyText = nextItemText;
    return [JSON.stringify(payload)];
  }
  if (method !== "item/completed") return [text];
  const item = params?.item && typeof params.item === "object" ? params.item : null;
  if (String(item?.type || "").trim() !== "agentMessage") return [text];
  const agentText = extractCodexAgentMessageText(item);
  if (!agentText) return [text];
  if (!(relay.assistantThinkingBodyTextByItemId instanceof Map)) {
    relay.assistantThinkingBodyTextByItemId = new Map();
  }
  const itemId = getCodexAgentMessageItemIdFromParams(params) ||
    String(relay.assistantThinkingCurrentItemId || "").trim() ||
    "__agent_message__";
  const priorBodyText = String(relay.assistantThinkingBodyTextByItemId.get(itemId) || "");
  const normalizedText = priorBodyText
    ? appendAssistantThinkingBodyText(priorBodyText, agentText)
    : (relay.assistantThinkingPrefixSent ? agentText : prependAssistantThinkingText(agentText));
  relay.assistantThinkingBodyTextByItemId.set(itemId, normalizedText);
  relay.assistantThinkingBodyText = normalizedText;
  relay.assistantThinkingPrefixSent = true;
  if (normalizedText === agentText) return [text];
  setCodexAgentMessageText(item, normalizedText);
  return [JSON.stringify(payload)];
}

function pickBestRelayForThread(threadIdRaw) {
  const threadId = String(threadIdRaw || "").trim();
  if (!threadId) return null;
  let best = null;
  for (const relay of Array.from(codexWsRelaysById.values())) {
    if (!relay || relay.closed) continue;
    if (String(relay.threadId || "").trim() !== threadId) continue;
    if (!best) {
      best = relay;
      continue;
    }
    const relayPendingApprovals = relay.pendingApprovalRequestIds instanceof Set
      ? relay.pendingApprovalRequestIds.size
      : 0;
    const bestPendingApprovals = best.pendingApprovalRequestIds instanceof Set
      ? best.pendingApprovalRequestIds.size
      : 0;
    if (relayPendingApprovals !== bestPendingApprovals) {
      if (relayPendingApprovals > bestPendingApprovals) best = relay;
      continue;
    }
    if (Boolean(relay.turnCompleted) !== Boolean(best.turnCompleted)) {
      if (!relay.turnCompleted) best = relay;
      continue;
    }
    if (Boolean(relay.upstreamOpen) !== Boolean(best.upstreamOpen)) {
      if (relay.upstreamOpen) best = relay;
      continue;
    }
    if (Number(relay.lastSeq) !== Number(best.lastSeq)) {
      if (Number(relay.lastSeq) > Number(best.lastSeq)) best = relay;
      continue;
    }
    if (Number(relay.updatedAtMs) !== Number(best.updatedAtMs)) {
      if (Number(relay.updatedAtMs) > Number(best.updatedAtMs)) best = relay;
      continue;
    }
    if (relay.clients.size !== best.clients.size) {
      if (relay.clients.size > best.clients.size) best = relay;
    }
  }
  return best;
}

function cleanupNoClientRelaysForThread(threadIdRaw, currentRelay, reason = "duplicate_thread_relay") {
  const threadId = String(threadIdRaw || "").trim();
  if (!threadId) return;
  for (const relay of Array.from(codexWsRelaysById.values())) {
    if (!relay || relay.closed || relay === currentRelay) continue;
    if (String(relay.threadId || "").trim() !== threadId) continue;
    if (relay.clients.size > 0) continue;
    void appendCodexWsProxyDebug("duplicate_thread_relay_cleanup", {
      relayId: relay.relayId,
      currentRelayId: currentRelay?.relayId || "",
      threadId,
      reason,
      turnStarted: Boolean(relay.turnStarted),
      turnCompleted: Boolean(relay.turnCompleted),
      upstreamOpen: Boolean(relay.upstreamOpen),
      lastSeq: Number(relay.lastSeq) || 0,
    });
    cleanupCodexRelay(relay, reason);
  }
}

function removeClientFromRelay(relay, clientWs) {
  if (!relay || !clientWs) return;
  relay.clients.delete(clientWs);
  codexWsRelayClientMode.delete(clientWs);
  relay.updatedAtMs = codexRelayNowMs();
}

function cleanupOrScheduleDetachedRelay(relay, reason = "client_detached") {
  if (!relay || relay.closed || relay.clients.size > 0) return;
  if (!relay.turnStarted && !relay.turnCompleted) {
    void appendCodexWsProxyDebug("pre_turn_relay_cleanup", {
      relayId: relay.relayId,
      reason,
      threadId: relay.threadId || "",
      upstreamOpen: Boolean(relay.upstreamOpen),
      lastSeq: Number(relay.lastSeq) || 0,
    });
    cleanupCodexRelay(relay, `${reason}_pre_turn`);
    return;
  }
  scheduleCodexRelayCleanup(relay, reason);
}

function cleanupCodexRelay(relay, reason = "cleanup") {
  if (!relay || relay.closed) return;
  relay.closed = true;
  if (relay.cleanupTimer) {
    clearTimeout(relay.cleanupTimer);
    relay.cleanupTimer = null;
  }
  releaseCodexRelayThreadMapping(relay);
  codexWsRelaysById.delete(relay.relayId);
  for (const client of Array.from(relay.clients)) {
    sendCodexRelayControl(relay, client, {
      type: "runner_relay_closed",
      relayId: relay.relayId,
      threadId: relay.threadId || "",
      reason,
    });
    safeWsClose(client, 1000, "relay_closed");
  }
  relay.clients.clear();
  if (relay.requestIdByRpcId instanceof Map) {
    relay.requestIdByRpcId.clear();
  }
  if (relay.requestMethodByRpcId instanceof Map) {
    relay.requestMethodByRpcId.clear();
  }
  safeWsClose(relay.upstreamWs, 1000, reason);
}

function scheduleCodexRelayCleanup(relay, reason) {
  if (!relay || relay.closed) return;
  if (relay.cleanupTimer) {
    clearTimeout(relay.cleanupTimer);
    relay.cleanupTimer = null;
  }
  const ttlMs = relay.turnCompleted
    ? CODEX_WS_RELAY_COMPLETED_TTL_MS
    : CODEX_WS_RELAY_IDLE_TTL_MS;
  relay.cleanupTimer = setTimeout(() => {
    cleanupCodexRelay(relay, reason || "relay_ttl");
  }, ttlMs);
}

function parseRelayApprovalRequestEvent(rawData) {
  const raw = typeof rawData === "string" ? rawData : String(rawData ?? "");
  const text = raw.trim();
  if (!text || text.length > 200000) return null;
  try {
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== "object") return null;
    const method = String(payload.method || "").trim();
    if (!method.endsWith("/requestApproval")) return null;
    const rpcIdRaw = Number(payload.id);
    const rpcId = Number.isInteger(rpcIdRaw) ? rpcIdRaw : null;
    return {
      method,
      rpcId,
    };
  } catch {
    return null;
  }
}

function shouldReplayCodexRelayEvent(relay, eventEntry) {
  const approvalMeta = parseRelayApprovalRequestEvent(eventEntry?.data);
  if (!approvalMeta) return true;
  if (!Number.isInteger(approvalMeta.rpcId)) return false;
  return relay?.pendingApprovalRequestIds instanceof Set
    && relay.pendingApprovalRequestIds.has(approvalMeta.rpcId);
}

function attachClientToCodexRelay(relay, clientWs, options = {}) {
  if (!relay || relay.closed || !clientWs) return 0;
  const replayAfterSeqRaw = Number(options.replayAfterSeq || 0);
  const replayAfterSeq = Number.isFinite(replayAfterSeqRaw)
    ? Math.max(0, Math.floor(replayAfterSeqRaw))
    : 0;
  const replayApprovalOnlyWhenSeqZero = Boolean(options.replayApprovalOnlyWhenSeqZero);
  if (relay.cleanupTimer) {
    clearTimeout(relay.cleanupTimer);
    relay.cleanupTimer = null;
  }
  if (options.envelopeMode) {
    codexWsRelayClientMode.set(clientWs, "runner-ws-envelope");
  } else {
    codexWsRelayClientMode.delete(clientWs);
  }
  relay.clients.add(clientWs);
  relay.updatedAtMs = codexRelayNowMs();
  let replayed = 0;
  if (replayAfterSeq > 0 && relay.eventLog.length > 0) {
    for (const eventEntry of relay.eventLog) {
      if (eventEntry.seq <= replayAfterSeq) continue;
      if (!shouldReplayCodexRelayEvent(relay, eventEntry)) continue;
      if (!sendCodexRelayRpcToClient(relay, clientWs, eventEntry.data, eventEntry.seq)) break;
      replayed += 1;
    }
  }
  if (replayed === 0 && replayAfterSeq === 0 && replayApprovalOnlyWhenSeqZero && relay.eventLog.length > 0) {
    let latestApprovalEvent = null;
    for (const eventEntry of relay.eventLog) {
      if (!eventEntry) continue;
      const approvalMeta = parseRelayApprovalRequestEvent(eventEntry.data);
      if (!approvalMeta) continue;
      if (!shouldReplayCodexRelayEvent(relay, eventEntry)) continue;
      if (!latestApprovalEvent || Number(eventEntry.seq || 0) > Number(latestApprovalEvent.seq || 0)) {
        latestApprovalEvent = eventEntry;
      }
    }
    if (latestApprovalEvent) {
      if (sendCodexRelayRpcToClient(relay, clientWs, latestApprovalEvent.data, Number(latestApprovalEvent.seq || 0))) {
        replayed = 1;
      }
    }
  }
  sendCodexRelayControl(relay, clientWs, {
    type: "runner_relay_attached",
    relayId: relay.relayId,
    threadId: relay.threadId || "",
    latestSeq: relay.lastSeq,
    replayAfterSeq,
    replayed,
    turnCompleted: relay.turnCompleted,
  });
  return replayed;
}

function createCodexRelayContext(params) {
  const relayId = createCodexWsRelayId();
  const relay = {
    relayId,
    createdAtMs: codexRelayNowMs(),
    updatedAtMs: codexRelayNowMs(),
    endpoint: params.endpoint,
    remote: params.remote,
    upstreamUrl: params.upstreamUrl,
    upstreamWs: params.upstreamWs,
    upstreamOpen: false,
    pendingToUpstream: [],
    clients: new Set(),
    threadId: "",
    turnStatus: "",
    turnStarted: false,
    turnCompleted: false,
    lastAgentMessageText: "",
    assistantThinkingPrefixSent: false,
    assistantThinkingBodyText: "",
    assistantThinkingBodyTextByItemId: new Map(),
    assistantThinkingCurrentItemId: "",
    assistantThinkingTurnActive: false,
    assistantThinkingTurnId: "",
    turnCompletedNotificationSent: false,
    pendingApprovalRequestIds: new Set(),
    requestIdByRpcId: new Map(),
    requestMethodByRpcId: new Map(),
    lastSeq: 0,
    eventLog: [],
    cleanupTimer: null,
    closed: false,
  };
  codexWsRelaysById.set(relayId, relay);
  if (codexWsRelaysById.size > CODEX_WS_RELAY_MAX_ACTIVE) {
    const candidates = Array.from(codexWsRelaysById.values())
      .filter((item) => item !== relay && item.clients.size === 0)
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs);
    for (const stale of candidates) {
      if (codexWsRelaysById.size <= CODEX_WS_RELAY_MAX_ACTIVE) break;
      cleanupCodexRelay(stale, "relay_limit");
    }
  }
  return relay;
}

function parseCodexRpcObject(rawData, isBinary, maxChars = 200000) {
  if (isBinary) return null;
  const text = Buffer.isBuffer(rawData)
    ? rawData.toString("utf8")
    : String(rawData ?? "");
  if (!text || text.length > maxChars) return null;
  try {
    const payload = JSON.parse(text);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function extractCodexAgentMessageText(itemRaw) {
  if (!itemRaw || typeof itemRaw !== "object" || Array.isArray(itemRaw)) return "";
  const item = itemRaw;
  const directText = pickFirstNonEmptyString(item.text, item.message?.text);
  if (directText) return directText;
  const content = Array.isArray(item.content) ? item.content : [];
  const chunks = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    if (String(part.type || "").trim() === "localImage") {
      const localPath = pickFirstNonEmptyString(part.path);
      if (localPath) chunks.push(`[localImage] ${localPath}`);
      continue;
    }
    const text = pickFirstNonEmptyString(part.text, part.value);
    if (text) chunks.push(text);
  }
  return chunks.join("").trim();
}

function compactLlmCompletionPreview(textRaw, maxChars = 180) {
  const text = String(textRaw || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function broadcastRunnerWsTurnCompletedNotification(relay, payload) {
  if (!payload?.threadId || !payload?.previewText) return false;
  if (typeof runnerWsActiveClients === "undefined") return false;
  let sent = 0;
  for (const client of Array.from(runnerWsActiveClients)) {
    if (sendRunnerWsEnvelope(client, {
      channel: "llm",
      op: "turn_completed_notification",
      sessionId: payload.sessionId || payload.threadId,
      threadId: payload.threadId,
      payload,
    })) {
      sent += 1;
    }
  }
  void appendCodexWsProxyDebug("llm_turn_completed_notification", {
    relayId: relay?.relayId || "",
    threadId: payload.threadId,
    previewChars: String(payload.previewText || "").length,
    sent,
  });
  return sent > 0;
}

function observeCodexRelayCompletionNotification(relay, rpcPayload, meta) {
  if (!relay || !rpcPayload || typeof rpcPayload !== "object") return;
  const method = String(rpcPayload.method || meta?.method || "").trim();
  const params = rpcPayload.params && typeof rpcPayload.params === "object"
    ? rpcPayload.params
    : {};
  if (method === "turn/started") {
    relay.lastAgentMessageText = "";
    relay.turnCompletedNotificationSent = false;
    return;
  }
  if (method === "item/agentMessage/delta") {
    const delta = String(params.delta || "");
    if (delta) relay.lastAgentMessageText = `${relay.lastAgentMessageText || ""}${delta}`;
    return;
  }
  if (method === "item/completed") {
    const item = params.item && typeof params.item === "object" ? params.item : null;
    if (String(item?.type || "").trim() !== "agentMessage") return;
    const text = extractCodexAgentMessageText(item);
    if (text) relay.lastAgentMessageText = text;
    return;
  }
  if (method !== "turn/completed") return;
  if (relay.turnCompletedNotificationSent) return;
  const threadId = pickFirstNonEmptyString(
    meta?.threadId,
    params.threadId,
    params.thread_id,
    params.sessionId,
    params.session_id,
    params.thread?.id,
    params.thread?.threadId,
    relay.threadId
  );
  const previewText = compactLlmCompletionPreview(relay.lastAgentMessageText);
  if (!threadId || !previewText) return;
  relay.turnCompletedNotificationSent = true;
  broadcastRunnerWsTurnCompletedNotification(relay, {
    sessionId: threadId,
    threadId,
    previewText,
    completedAt: new Date().toISOString(),
  });
}

function handleCodexRelayUpstreamMessage(relay, data, isBinary, params = {}) {
  if (!relay || relay.closed) return;
  const remote = String(params.remote || relay.remote || "unknown");
  const endpoint = String(params.endpoint || relay.endpoint || "/codex-ws");
  relay.updatedAtMs = codexRelayNowMs();
  const meta = parseCodexRpcMeta(data, isBinary);
  const rpcPayload = parseCodexRpcObject(data, isBinary);
  const metaThreadId = String(meta?.threadId || "").trim();
  const relayThreadId = String(relay.threadId || "").trim();
  if (isCodexRelayThreadMismatch(relayThreadId, metaThreadId)) {
    void appendCodexWsProxyDebug("upstream_to_client_rpc_ignored_thread_mismatch", {
      relayId: relay.relayId,
      remote,
      endpoint,
      method: meta?.method || "",
      threadId: metaThreadId,
      relayThreadId,
    });
    return;
  }
  if (!meta && !isBinary) {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data ?? "");
    if (text) {
      const trimmed = text.trim();
      const maybeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
      void appendCodexWsProxyDebug("upstream_to_client_rpc_unparsed", {
        relayId: relay.relayId,
        remote,
        endpoint,
        textChars: text.length,
        maybeJson,
        head: text.slice(0, 160),
      });
    }
  }
  const responseRpcId = meta && Number.isInteger(meta.id) ? Number(meta.id) : null;
  const responseRequestId = (
    responseRpcId !== null &&
    relay.requestIdByRpcId instanceof Map
  ) ? String(relay.requestIdByRpcId.get(responseRpcId) || "").trim() : "";
  const responseRpcMethod = (
    responseRpcId !== null &&
    relay.requestMethodByRpcId instanceof Map
  ) ? String(relay.requestMethodByRpcId.get(responseRpcId) || "").trim() : "";
  if (
    responseRequestId &&
    responseRpcId !== null &&
    relay.requestIdByRpcId instanceof Map &&
    (Boolean(meta?.hasResult) || Boolean(meta?.hasError))
  ) {
    relay.requestIdByRpcId.delete(responseRpcId);
  }
  if (
    responseRpcId !== null &&
    relay.requestMethodByRpcId instanceof Map &&
    (Boolean(meta?.hasResult) || Boolean(meta?.hasError))
  ) {
    relay.requestMethodByRpcId.delete(responseRpcId);
  }
  if (meta && (meta.method || meta.id !== null)) {
    if (meta.threadId && shouldBindRelayThreadFromUpstreamMethod(meta.method)) {
      bindCodexRelayThreadMapping(relay, meta.threadId);
    }
    if (meta.method && meta.method.endsWith("/requestApproval")) {
      const approvalRpcId = Number(meta.id);
      if (Number.isInteger(approvalRpcId)) {
        relay.pendingApprovalRequestIds.add(approvalRpcId);
      }
    }
    if (meta.method === "turn/completed") {
      relay.turnStatus = String(meta.threadStatus || "");
      if (isTerminalTurnStatus(meta.threadStatus) || !meta.threadStatus) {
        relay.turnCompleted = true;
      }
    } else if (meta.method === "turn/started") {
      relay.turnStarted = true;
      relay.turnCompleted = false;
    } else if (meta.threadStatus) {
      relay.turnStatus = String(meta.threadStatus || "");
      if (isTerminalTurnStatus(meta.threadStatus)) {
        relay.turnCompleted = true;
      }
    }
    observeCodexCompactUpstreamRpc(relay, meta, responseRpcMethod);
    void appendCodexWsProxyDebug("upstream_to_client_rpc", {
      relayId: relay.relayId,
      remote,
      endpoint,
      requestId: responseRequestId,
      method: meta.method || "",
      id: meta.id,
      hasError: meta.hasError,
      hasResult: meta.hasResult,
      errorCode: meta.errorCode,
      errorMessage: meta.errorMessage || "",
      threadId: meta.threadId || relay.threadId || "",
      threadStatus: meta.threadStatus || "",
      itemId: meta.itemId || "",
      itemType: meta.itemType || "",
      compactDebug: meta.compactDebug || "",
    });
  }
  let outgoingTexts = [];
  if (!isBinary) {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data ?? "");
    const normalizedThreadText = normalizeCodexThreadReadAssistantThinkingRpcText(
      text,
      responseRpcMethod
    );
    outgoingTexts = normalizeCodexRelayAssistantThinkingRpcTexts(relay, normalizedThreadText);
  }
  if (!isBinary) {
    const subscribers = Array.from(relay.clients);
    for (const text of outgoingTexts) {
      if (!text) continue;
      const outgoingPayload = parseCodexRpcObject(text, false) || rpcPayload;
      observeCodexRelayCompletionNotification(relay, outgoingPayload, meta);
      relay.lastSeq += 1;
      relay.eventLog.push({
        seq: relay.lastSeq,
        atMs: codexRelayNowMs(),
        data: text,
      });
      if (relay.eventLog.length > CODEX_WS_RELAY_EVENT_MAX) {
        relay.eventLog.splice(0, relay.eventLog.length - CODEX_WS_RELAY_EVENT_MAX);
      }
      for (const subscriber of subscribers) {
        sendCodexRelayRpcToClient(relay, subscriber, text, relay.lastSeq, {
          responseRpcMethod,
        });
        if (responseRequestId) {
          sendRunnerWsLlmRpcAck(relay, subscriber, {
            op: "llm_rpc_upstream_response",
            requestId: responseRequestId,
            method: meta?.method || "",
            id: responseRpcId,
            threadId: meta?.threadId || relay.threadId || "",
            state: meta?.hasError ? "error" : "result",
          });
        }
      }
    }
    return;
  }
  observeCodexRelayCompletionNotification(relay, rpcPayload, meta);
  for (const subscriber of Array.from(relay.clients)) {
    if (!isCodexRelayEnvelopeClient(subscriber)) {
      safeWsSend(subscriber, data, { binary: isBinary });
    }
  }
}

function attachCodexRelayUpstreamHandlers(relay, params = {}) {
  if (!relay?.upstreamWs) return;
  const upstreamWs = relay.upstreamWs;
  const remote = String(params.remote || relay.remote || "unknown");
  const endpoint = String(params.endpoint || relay.endpoint || "/codex-ws");
  const upstreamUrl = String(params.upstreamUrl || relay.upstreamUrl || CODEX_WS_PROXY_UPSTREAM_URL);
  upstreamWs.on("open", () => {
    if (relay.closed) return;
    relay.upstreamOpen = true;
    relay.updatedAtMs = codexRelayNowMs();
    void appendCodexWsProxyDebug("upstream_ws_opened", {
      relayId: relay.relayId,
      remote,
      endpoint,
      upstreamUrl,
      pendingMessages: relay.pendingToUpstream.length,
    });
    if (relay.pendingToUpstream.length > 0) {
      for (const item of relay.pendingToUpstream.splice(0, relay.pendingToUpstream.length)) {
        if (relay.upstreamWs.readyState !== WebSocket.OPEN) break;
        relay.upstreamWs.send(item.data, { binary: Boolean(item.isBinary) });
      }
    }
  });

  upstreamWs.on("message", (data, isBinary) => {
    handleCodexRelayUpstreamMessage(relay, data, isBinary, {
      remote,
      endpoint,
    });
  });

  upstreamWs.on("close", (code, reasonBuf) => {
    const reason = Buffer.isBuffer(reasonBuf)
      ? reasonBuf.toString("utf8")
      : String(reasonBuf || "");
    relay.upstreamOpen = false;
    relay.updatedAtMs = codexRelayNowMs();
    if (RUNNER_LOG_REQUESTS) {
      console.log(
        `[codex-ws-proxy] upstream closed code=${Number(code)} reason=${reason || "-"} relay=${relay.relayId}`
      );
    }
    void appendCodexWsProxyDebug("upstream_ws_closed", {
      relayId: relay.relayId,
      remote,
      code: Number(code),
      reason: reason || "-",
      endpoint,
      upstreamUrl,
      threadId: relay.threadId || "",
    });
    for (const subscriber of Array.from(relay.clients)) {
      safeWsClose(subscriber, Number(code) || 1000, reason || "upstream_closed");
    }
    if (relay.clients.size === 0) {
      cleanupCodexRelay(relay, "upstream_closed_no_clients");
    } else {
      relay.turnCompleted = true;
      scheduleCodexRelayCleanup(relay, "upstream_closed");
    }
  });

  upstreamWs.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error || "upstream_error");
    if (RUNNER_LOG_REQUESTS) {
      console.warn(`[codex-ws-proxy] upstream error: ${message} relay=${relay.relayId}`);
    }
    void appendCodexWsProxyDebug("upstream_ws_error", {
      relayId: relay.relayId,
      remote,
      message,
      endpoint,
      upstreamUrl,
      threadId: relay.threadId || "",
    });
    relay.turnCompleted = true;
    scheduleCodexRelayCleanup(relay, "upstream_error");
    for (const subscriber of Array.from(relay.clients)) {
      safeWsClose(subscriber, 1011, "upstream_error");
    }
  });
}

function createCodexRelayWithUpstream(params = {}) {
  const endpoint = String(params.endpoint || "/codex-ws");
  const remote = String(params.remote || "unknown");
  const upstreamUrl = String(params.upstreamUrl || CODEX_WS_PROXY_UPSTREAM_URL);
  const protocols = Array.isArray(params.protocols) ? params.protocols : [];
  const upstreamHeaders = {};
  if (CODEX_WS_PROXY_UPSTREAM_TOKEN) {
    upstreamHeaders.authorization = `Bearer ${CODEX_WS_PROXY_UPSTREAM_TOKEN}`;
  }
  const upstreamWs = new WebSocket(upstreamUrl, protocols, {
    headers: upstreamHeaders,
  });
  const relay = createCodexRelayContext({
    endpoint,
    remote,
    upstreamUrl,
    upstreamWs,
  });
  attachCodexRelayUpstreamHandlers(relay, {
    remote,
    endpoint,
    upstreamUrl,
  });
  return relay;
}

function forwardCodexRelayClientData(relay, data, isBinary, params = {}) {
  if (!relay || relay.closed) return;
  const remote = String(params.remote || relay.remote || "unknown");
  const endpoint = String(params.endpoint || relay.endpoint || "/codex-ws");
  const requestId = String(params.requestId || "").trim();
  relay.updatedAtMs = codexRelayNowMs();
  const meta = parseCodexRpcMeta(data, isBinary);
  const shouldLogForwardState = (method) => (
    method === "initialize" ||
    method === "thread/resume" ||
    method === "thread/start" ||
    method === "turn/start"
  );
  const logForwardState = (state) => {
    if (!meta || (!meta.method && meta.id === null)) return;
    if (!shouldLogForwardState(meta.method)) return;
    void appendCodexWsProxyDebug("client_to_upstream_rpc_forward_state", {
      relayId: relay.relayId,
      remote,
      endpoint,
      requestId,
      method: meta.method || "",
      id: meta.id,
      threadId: meta.threadId || relay.threadId || "",
      state,
      upstreamOpen: Boolean(relay.upstreamOpen),
      upstreamReadyState: Number(relay.upstreamWs?.readyState),
      pendingMessages: Array.isArray(relay.pendingToUpstream) ? relay.pendingToUpstream.length : 0,
    });
  };
  if (meta && (meta.method || meta.id !== null)) {
    if (requestId && Number.isInteger(meta.id) && relay.requestIdByRpcId instanceof Map) {
      relay.requestIdByRpcId.set(Number(meta.id), requestId);
    }
    if (meta.method && Number.isInteger(meta.id) && relay.requestMethodByRpcId instanceof Map) {
      relay.requestMethodByRpcId.set(Number(meta.id), String(meta.method || "").trim());
    }
    if (meta.threadId) {
      const allowSwitch = (
        meta.method === "thread/resume" ||
        meta.method === "turn/start" ||
        meta.method === "thread/start"
      );
      if (allowSwitch) {
        bindCodexRelayThreadMapping(relay, meta.threadId, { allowSwitch: true });
        cleanupNoClientRelaysForThread(meta.threadId, relay, `client_${meta.method}`);
      } else if (!relay.threadId && meta.method && meta.method !== "thread/read") {
        bindCodexRelayThreadMapping(relay, meta.threadId);
      }
    }
    if (!meta.method && Number.isInteger(meta.id)) {
      relay.pendingApprovalRequestIds.delete(Number(meta.id));
    }
    if (meta.method === "turn/start") {
      relay.turnStarted = true;
      relay.turnCompleted = false;
    }
    observeCodexCompactClientRpc(relay, meta);
    void appendCodexWsProxyDebug("client_to_upstream_rpc", {
      relayId: relay.relayId,
      remote,
      endpoint,
      requestId,
      method: meta.method || "",
      id: meta.id,
      hasError: meta.hasError,
      hasResult: meta.hasResult,
      errorCode: meta.errorCode,
      errorMessage: meta.errorMessage || "",
      threadId: meta.threadId || relay.threadId || "",
      threadStatus: meta.threadStatus || "",
      itemId: meta.itemId || "",
      itemType: meta.itemType || "",
      turnStartModel: meta.turnStartModel || "",
      turnStartEffort: meta.turnStartEffort || "",
      compactDebug: meta.compactDebug || "",
    });
  }
  if (!relay.upstreamOpen) {
    logForwardState("queued_waiting_upstream_open");
    relay.pendingToUpstream.push({ data, isBinary });
    return;
  }
  if (relay.upstreamWs.readyState !== WebSocket.OPEN) {
    logForwardState("dropped_upstream_not_open");
    return;
  }
  logForwardState("sent_to_upstream");
  relay.upstreamWs.send(data, { binary: isBinary });
}

codexProxyWsServer.on("connection", (clientWs, req) => {
  const reqUrl = parseRequestUrl(req);
  const remote = String(req?.socket?.remoteAddress || "unknown");
  const upstreamUrl = CODEX_WS_PROXY_UPSTREAM_URL;
  const requestToken = String(reqUrl.searchParams.get("token") || "").trim();
  const authToken = parseAuthToken(req);
  const protocolList = req.headers["sec-websocket-protocol"];
  const protocols = Array.isArray(protocolList)
    ? protocolList
    : (protocolList ? String(protocolList).split(",").map((item) => item.trim()).filter(Boolean) : []);
  const resumeThreadId = String(reqUrl.searchParams.get("resumeThreadId") || "").trim();
  const resumeFromSeqRaw = Number(
    reqUrl.searchParams.get("resumeFromSeq") ||
    reqUrl.searchParams.get("lastSeq") ||
    0
  );
  const resumeFromSeq = Number.isFinite(resumeFromSeqRaw)
    ? Math.max(0, Math.floor(resumeFromSeqRaw))
    : 0;
  const upstreamHeaders = {};
  if (CODEX_WS_PROXY_UPSTREAM_TOKEN) {
    upstreamHeaders.authorization = `Bearer ${CODEX_WS_PROXY_UPSTREAM_TOKEN}`;
  }

  let relay = null;
  if (resumeThreadId) {
    const mappedRelayId = codexWsRelayIdByThreadId.get(resumeThreadId) || "";
    const mappedRelay = mappedRelayId ? (codexWsRelaysById.get(mappedRelayId) || null) : null;
    const bestRelay = pickBestRelayForThread(resumeThreadId);
    if (bestRelay && !bestRelay.closed) {
      relay = bestRelay;
      if (!mappedRelay || mappedRelay.relayId !== bestRelay.relayId) {
        void appendCodexWsProxyDebug("proxy_resume_relay_selected", {
          remote,
          endpoint: reqUrl.pathname,
          resumeThreadId,
          resumeFromSeq,
          mappedRelayId: mappedRelayId || "",
          selectedRelayId: bestRelay.relayId,
          selectedLastSeq: Number(bestRelay.lastSeq) || 0,
          selectedTurnCompleted: Boolean(bestRelay.turnCompleted),
          selectedUpstreamOpen: Boolean(bestRelay.upstreamOpen),
          selectedClients: bestRelay.clients.size,
        });
      }
    } else if (mappedRelay && !mappedRelay.closed) {
      relay = mappedRelay;
    }
  }

  if (resumeThreadId && !relay) {
    void appendCodexWsProxyDebug("proxy_resume_miss", {
      remote,
      endpoint: reqUrl.pathname,
      resumeThreadId,
      resumeFromSeq,
    });
    sendRelayControl(clientWs, {
      type: "runner_relay_resume_miss",
      threadId: resumeThreadId,
      resumeFromSeq,
    });
    safeWsClose(clientWs, 4404, "relay_not_found");
    return;
  }

  if (!relay) {
    const upstreamWs = new WebSocket(upstreamUrl, protocols, {
      headers: upstreamHeaders,
    });
    relay = createCodexRelayContext({
      endpoint: reqUrl.pathname,
      remote,
      upstreamUrl,
      upstreamWs,
    });
    attachCodexRelayUpstreamHandlers(relay, {
      remote,
      endpoint: reqUrl.pathname,
      upstreamUrl,
    });
  }

  if (RUNNER_LOG_REQUESTS) {
    console.log(
      `[codex-ws-proxy] connect from=${remote} endpoint=${reqUrl.pathname} relay=${relay.relayId} upstream=${upstreamUrl} resumeThread=${resumeThreadId || "-"}`
    );
  }
  const replayed = attachClientToCodexRelay(relay, clientWs, {
    replayAfterSeq: resumeFromSeq,
    replayApprovalOnlyWhenSeqZero: Boolean(resumeThreadId) && resumeFromSeq === 0,
  });
  void appendCodexWsProxyDebug("proxy_connection_opened", {
    relayId: relay.relayId,
    remote,
    endpoint: reqUrl.pathname,
    url: req?.url || "",
    host: String(req?.headers?.host || ""),
    hasQueryToken: !!requestToken,
    hasAuthHeaderToken: !!authToken,
    protocolCount: protocols.length,
    upstreamUrl,
    resumeThreadId: resumeThreadId || "",
    resumeFromSeq,
    replayed,
    threadId: relay.threadId || "",
  });

  clientWs.on("message", (data, isBinary) => {
    forwardCodexRelayClientData(relay, data, isBinary, {
      remote,
      endpoint: reqUrl.pathname,
    });
  });

  clientWs.on("close", (code, reasonBuf) => {
    const reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString("utf8") : String(reasonBuf || "");
    removeClientFromRelay(relay, clientWs);
    void appendCodexWsProxyDebug("client_ws_closed", {
      relayId: relay.relayId,
      remote,
      code: Number(code),
      reason: reason || "-",
      remainingClients: relay.clients.size,
      threadId: relay.threadId || "",
    });
    cleanupOrScheduleDetachedRelay(relay, "client_detached");
  });

  clientWs.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error || "client_error");
    removeClientFromRelay(relay, clientWs);
    void appendCodexWsProxyDebug("client_ws_error", {
      relayId: relay.relayId,
      remote,
      message,
      remainingClients: relay.clients.size,
      threadId: relay.threadId || "",
    });
    cleanupOrScheduleDetachedRelay(relay, "client_error");
  });
});

server.on("upgrade", (req, socket, head) => {
  const reqUrl = parseRequestUrl(req);
  const remoteAddress = String(req.socket.remoteAddress || "unknown");
  const authToken = parseAuthToken(req);
  const queryToken = String(reqUrl.searchParams.get("token") || "").trim();
  const providedToken = authToken || queryToken;
  if (RUNNER_LOG_REQUESTS) {
    console.log(`[request] WS ${reqUrl.pathname} from ${remoteAddress}`);
  }
  void appendCodexWsProxyDebug("upgrade_request", {
    remoteAddress,
    endpoint: reqUrl.pathname,
    url: req.url || "",
    host: String(req.headers.host || ""),
    hasAuthHeaderToken: !!authToken,
    hasQueryToken: !!queryToken,
    tokenSource: authToken ? "authorization" : (queryToken ? "query" : "none"),
    tokenLength: providedToken.length,
  });
  const isRunnerWsPath = reqUrl.pathname === RUNNER_WS_PATH;
  const isStreamTtsPath = reqUrl.pathname === "/stream-tts";
  const isCodexProxyPath = reqUrl.pathname === "/codex-ws";
  if (!isRunnerWsPath && !isStreamTtsPath && !isCodexProxyPath) {
    void appendCodexWsProxyDebug("upgrade_rejected", {
      remoteAddress,
      endpoint: reqUrl.pathname,
      reason: "path_not_supported",
    });
    socket.destroy();
    return;
  }

  if (!RUNNER_TOKEN) {
    void appendCodexWsProxyDebug("upgrade_rejected", {
      remoteAddress,
      endpoint: reqUrl.pathname,
      reason: "runner_token_missing",
    });
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!providedToken || providedToken !== RUNNER_TOKEN) {
    void appendCodexWsProxyDebug("upgrade_rejected", {
      remoteAddress,
      endpoint: reqUrl.pathname,
      reason: !providedToken ? "token_missing" : "token_mismatch",
      tokenSource: authToken ? "authorization" : (queryToken ? "query" : "none"),
      tokenLength: providedToken.length,
    });
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  if (isRunnerWsPath) {
    void appendCodexWsProxyDebug("upgrade_accepted", {
      remoteAddress,
      endpoint: reqUrl.pathname,
      route: "runner-ws",
    });
    runnerWsServer.handleUpgrade(req, socket, head, (ws) => {
      runnerWsServer.emit("connection", ws, req);
    });
    return;
  }

  if (isCodexProxyPath) {
    void appendCodexWsProxyDebug("upgrade_accepted", {
      remoteAddress,
      endpoint: reqUrl.pathname,
      route: "codex-ws-proxy",
    });
    codexProxyWsServer.handleUpgrade(req, socket, head, (ws) => {
      codexProxyWsServer.emit("connection", ws, req);
    });
    return;
  }

  void appendCodexWsProxyDebug("upgrade_accepted", {
    remoteAddress,
    endpoint: reqUrl.pathname,
    route: "stream-tts",
  });
  wsServer.handleUpgrade(req, socket, head, (ws) => {
    wsServer.emit("connection", ws, req);
  });
});

async function initializeLlmFileRuntime() {
  try {
    const root = await resolveToolRoot("");
    const context = await getAgentSkillContext();
    console.log(
      `[llm-files] root=${root.relativeRoot} agentDocs=${context.agentDocs.length} skills=${context.skillCatalog.length}`
    );
  } catch (err) {
    console.warn(
      `[llm-files] initialization warning: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function initializeLlmRequestLogRuntime() {
  if (!LLM_REQUEST_LOG_ENABLED) return;
  try {
    await ensureLlmRequestLogInitialized();
    console.log(
      `[llm-request-log] session=${path.relative(WORKSPACE_ROOT, LLM_REQUEST_LOG_PATH)} maxFiles=${LLM_REQUEST_LOG_MAX_FILES}`
    );
  } catch (err) {
    console.warn(
      `[llm-request-log] initialization warning: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function initializeClientAppLogRuntime() {
  try {
    await ensureClientAppLogInitialized();
    console.log(
      `[client-app-log] file=${path.relative(WORKSPACE_ROOT, CLIENT_APP_LOG_PATH)} maxFiles=${CLIENT_APP_LOG_MAX_FILES} sessionDiagDetail=${CLIENT_APP_LOG_SESSION_DIAG_DETAIL_ENABLED ? "on" : "off"}`
    );
  } catch (err) {
    console.warn(
      `[client-app-log] initialization warning: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function initializeAcpSessionStoreRuntime() {
  if (!SESSION_ROOT_BINDING_ENABLED) return;
  try {
    const stats = await getAcpSessionStoreStats();
    console.log(
      `[session-store] file=${path.relative(WORKSPACE_ROOT, ACP_SESSION_STORE_PATH)} sessions=${stats.sessions} directories=${stats.directories}`
    );
  } catch (err) {
    console.warn(
      `[session-store] initialization warning: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function initializeCliSessionIndexRuntime() {
  try {
    const stats = await getCliSessionIndexStats();
    console.log(
      `[cli-session-index] file=${path.relative(WORKSPACE_ROOT, CLI_SESSION_INDEX_PATH)} entries=${stats.entries} sessionsDir=${CODEX_CLI_SESSIONS_DIR}`
    );
  } catch (err) {
    console.warn(
      `[cli-session-index] initialization warning: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function initializeTtsMediaRuntime() {
  try {
    await ensureTtsMediaDir();
    const files = await fs.readdir(TTS_MEDIA_DIR).catch(() => []);
    for (const name of files) {
      const filePath = path.join(TTS_MEDIA_DIR, name);
      try {
        await fs.unlink(filePath);
      } catch {}
    }
    ensureTtsMediaSweepTimer();
    console.log(
      `[tts-media] dir=${path.relative(WORKSPACE_ROOT, TTS_MEDIA_DIR)} ttlMs=${TTS_MEDIA_TTL_MS} maxEntries=${TTS_MEDIA_MAX_ENTRIES}`
    );
  } catch (err) {
    console.warn(
      `[tts-media] initialization warning: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function initializeCodexWsDebugRuntime() {
  try {
    await ensureCodexWsProxyDebugLogInitialized();
    console.log(
      `[codex-ws-debug] file=${path.relative(WORKSPACE_ROOT, CODEX_WS_PROXY_DEBUG_LOG_PATH)} bufferMax=${CODEX_WS_PROXY_DEBUG_BUFFER_MAX} maxFiles=${CODEX_WS_PROXY_DEBUG_LOG_MAX_FILES}`
    );
  } catch (err) {
    console.warn(
      `[codex-ws-debug] initialization warning: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

if (!RUNNER_SKIP_SERVER_START) {
  void initializeLlmRequestLogRuntime();
  void initializeClientAppLogRuntime();
  void initializeLlmFileRuntime();
  void initializeAcpSessionStoreRuntime();
  void initializeCliSessionIndexRuntime();
  void initializeTtsMediaRuntime();
  void initializeCodexWsDebugRuntime();

  server.listen(PORT, HOST, () => {
    console.log(
      `private runner server listening on http://${HOST}:${PORT} (mode=${
        RUNNER_MOCK ? "mock" : OPENAI_CODEX_PROVIDER
      })`
    );
  });
}

export const __TESTING__ = {
  shouldReplayCodexRelayEvent,
  isCodexRelayThreadMismatch,
  handleCodexRelayUpstreamMessage,
  resolveToolRoot,
  resolvePathWithinToolRoot,
  resolveClientFilePath,
  getClientMediaMimeType,
  buildInlineContentDisposition,
  runListDirTool,
  runFindFilesTool,
  runSearchTextTool,
  runReadFileTool,
  runReadFileRangeTool,
  runApplyPatchTool,
  runTestsTool,
  runCommandSandboxedTool,
  runGitDiffTool,
  extractYouTubeVideoIdsFromToolResult,
  runCodexWithFileTools,
  executeLlmFileToolCall,
  appendAppConversationToCliRollout,
  listLlmSessions,
  listLlmSessionMessages,
};
