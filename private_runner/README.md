# Private Runner (auth.json / openai-codex)

ローカルまたは自前環境でのみ動かす想定の API サーバーです。現在は `runner` 単体起動で、LLMは `runner -> /runner-ws` または legacy `/codex-ws` -> `codex app-server` の中継を使います。

## 認証モデル（setup と deploy の分離）
この runner は API キー入力ではなく、`codex login` の OAuth ログイン状態を使います。

- setup フェーズでのみ `codex login` を実行する
- deploy/backend フェーズではログイン処理を実行しない
- backend は setup 済みの auth cache (`CODEX_HOME/auth.json`) を読むだけ
- LLM 呼び出しは `openai-codex-responses` 経路（`/backend-api/codex/responses`）を使う

フローは OAuth 2.0 Authorization Code Flow with PKCE です。

## Setup フェーズ（CODEX_HOME）
`setup-codex-auth.mjs` は `private_runner/.env` を読み込みます。
既定の `.env.example` は Codex CLI と同じ `CODEX_HOME=$HOME/.codex` を使います。
事前に `codex` CLI をインストールして、shell から実行できる状態にしてください。

```bash
# 通常のブラウザOAuth
node setup-codex-auth.mjs

# headless向け（必要時）
node setup-codex-auth.mjs --device-auth
```

CLI履歴を共有する既定モード:

```bash
CODEX_HOME=$HOME/.codex CODEX_BIN=codex node setup-codex-auth.mjs
```

履歴を分離したい場合のみ専用ディレクトリを指定します:

```bash
CODEX_HOME=/secure/path/codex-home CODEX_BIN=codex node setup-codex-auth.mjs
```

完了確認（共有モード例）:
```bash
CODEX_HOME=$HOME/.codex codex login status -c 'cli_auth_credentials_store="file"'
```

## Deploy フェーズ（backend はログインしない）
- `CODEX_HOME` ディレクトリを secrets として backend 実行環境へ渡す
- backend 起動時に同じ `CODEX_HOME` を設定する
- backend は OAuth profile を読んで `openai-codex-responses` を呼び出す（ログイン処理は行わない）

## 必要なキー（このrunner用）
- 必須: `RUNNER_TOKEN`（`/runner-ws` `/codex-ws` `/stream-tts` `/stt` `/tts` `/client-logs` 保護用のBearerトークン）
  - `run-local.sh` では既定で `RUNNER_TOKEN_MODE=random` のため、起動ごとにランダム生成し、Expo向けPairing QRで渡します。
  - 固定tokenで検証する場合だけ `RUNNER_TOKEN_MODE=env` と `RUNNER_TOKEN` をlocal `.env` に設定します。
  - detached起動時はQRをログへ残さないため、起動後に `private_runner/run-local.sh pairing-qr` で表示します。
- 不要: `OPENAI_API_KEY`（このrunnerはCodex認証を利用するため）
- `/stt` を使う場合のみ必須: `GROQ_API_KEY`
- `/tts` は `ttsProvider` で `elevenlabs` / `google` / `aivisspeech` を切替可能
- ElevenLabs を使う場合のみ必須: `ELEVENLABS_API_KEY`
- Google Cloud TTS を使う場合のみ必須: `GOOGLE_CLOUD_PROJECT_ID`
- `youtube_search` / `youtube_channel_latest` / `youtube_favorites` は `YOUTUBE_API_KEY` 推奨（未設定時は gcloud トークンへフォールバック）
- AivisSpeech を使う場合: runner を macOS で動かし、`AIVISSPEECH_API_BASE_URL` は localhost に設定。AivisSpeech の WAV 出力を MP3 配信用に変換するため、runner ホストに `ffmpeg` も必要

## モデル / think 設定
- `OPENAI_CODEX_MODEL` は既定 `openai-codex/gpt-5.4-mini`
- `OPENAI_CODEX_REASONING_EFFORT` で think 強度を指定可能（`none|low|medium|high|xhigh`）
- `OPENAI_CODEX_OAUTH_PROFILE` で利用する OAuth profile を選択可能（既定 `default`）

実運用で確認した互換:
- `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna`: `none`, `low`, `medium`, `high`, `xhigh`
  （API はさらに `max` をサポートするが、本 runner は未対応。公表仕様。実機確認待ち）
- `gpt-5.4`: `none`, `low`, `medium`, `high`, `xhigh`
- `gpt-5`: `minimal`, `low`, `medium`, `high`
- `gpt-5-codex`: `low`, `medium`, `high`

## 参考: 別コンポーネントで必要なキー
- STT（Groq）を別Workerやサーバーで実行する場合: `GROQ_API_KEY`
- Cloudflareへデプロイする場合: `CF_ACCOUNT_ID`, `CF_API_TOKEN`（CI/CLI構成次第）

## 起動
```bash
cp private_runner/.env.example private_runner/.env
# .env を編集して CODEX_HOME を設定
# public Tunnel経由で使う場合は RUNNER_PUBLIC_URL とCloudflare Access service tokenをKeychainへ設定
private_runner/run-local.sh start
# 停止
private_runner/run-local.sh stop
# 再起動
private_runner/run-local.sh restart
# 状態確認（ポート重複・ヘルス）
private_runner/run-local.sh status
# ログ
tail -f private_runner/logs/run-local.log
```

`start` / `restart` は起動直前に既存の実行ログを初期化します。セッション索引などの状態ファイルは保持されます。

## クライアント診断ログ
`POST /client-logs` で受けたイベントは JSONL で保存されます。

- 保存先: `private_runner/logs/client_auto_logs/<runner起動時刻>.jsonl`
- 保存世代: `CLIENT_APP_LOG_MAX_FILES`（既定 `10`）
- 主要ソース:
  - `app_auto`: 自動録音系ログ（診断モード中心）
  - `session_diag`: セッション履歴/復元/stream再開の恒久低頻度ログ
- 詳細イベント:
  - `session_diag` の詳細イベントは `CLIENT_APP_LOG_SESSION_DIAG_DETAIL_ENABLED=1` で保存ON（既定OFF）
  - クライアント送信自体を抑止する場合は Expo 側で `EXPO_PUBLIC_SESSION_DIAG_DETAIL_EVENTS=1` を有効化（既定OFF）
  - 既定OFF時は `session_open_perf_*` の中間計測イベント（thread_read / hydrated / state_apply / mark_read）が保存対象外
- 代表イベント（`session_diag`）:
  - `session_restore_*` / `runner_session_messages_*`
  - `reply_stream_relay_observer_*`（再起動後のcodex relay復帰）
  - `stream_resume_sync_*`
  - `session_reload_requested`（手動再読み込み）
- 運用方針: 通常運用は詳細OFF、調査時だけ詳細ONにしてログ過多を防ぐ

補足:
- `codex_ws_proxy` デバッグログも `CODEX_WS_PROXY_DEBUG_LOG_MAX_FILES`（既定 `10`）で世代ローテーションされます。

確認コマンド例:
```bash
cd /path/to/bitty
LATEST=$(ls -t private_runner/logs/client_auto_logs/*.jsonl | head -n 1)
rg -n '"source":"session_diag"' "$LATEST" | tail -n 200
```

運用メモ（重要）:
- `runner` と `codex app-server` は同じ OS ユーザーで起動してください。
- `run-local.sh restart` は停止対象 PID への signal 権限と `CODEX_HOME` の書き込み権限を事前確認し、不足時は `requires elevated execution` で終了します。
- 認証アカウント切替後の再起動は既定で sudo を使いません（`CODEX_AUTH_SWITCH_REQUIRE_SUDO=0`）。
- 認証アカウント切替時の restart は既存サービスを再利用せず、必ず停止・再起動します。

## サーバー構成（現在）
- runner（既定: 8788）: `/runner-ws` `/codex-ws` `/stream-tts` `/stt` `/tts` `/voices` `/client-logs` `/youtube-videos` など
- codex app-server（既定: 4500）: JSON-RPC本体
- 推奨接続先（iOS）: `ws://<MacのLocalHostName>.local:8788/runner-ws`
- 互換接続先（iOS）: `ws://<Mac LAN IP>:8788/codex-ws`
- iOS/Expo は `RUNNER_TOKEN` をURL queryへ載せず、WebSocket handshakeの `Authorization: Bearer <RUNNER_TOKEN>` で送ります。
- 実機からローカル接続する場合、runner は `HOST=0.0.0.0` で待ち受けます。`.local` が使えないネットワークでは、Expo側が `/health` の1回確認に失敗した時だけCloudflare Tunnel接続へ戻します。

LLM本線:
- iOS/Expo からは `/runner-ws` の `llm:rpc` envelope 経由で `thread/*` と `turn/start` を使います。runner から codex app-server への upstream は raw JSON-RPC のままです。
- Expo側で常時接続の補助WebSocketは作りません。会話、診断、TTSなど実際の操作が必要な時だけ、同じ認証ヘッダー付きWebSocket生成経路を使います。
- `/codex-ws` は legacy 互換経路です。raw JSON-RPC と `runner_relay_*` control message を維持しています。
- `/reply` と `/reply-files` は legacy 互換APIです。
- `/runner-ws` と `/codex-ws` は resumable relay 対応です。`/runner-ws` は `relay:resume` envelope、`/codex-ws` は `resumeThreadId=<threadId>&resumeFromSeq=<lastSeq>` query で、保持中イベントの未受信分を再送して live stream に合流します。

resumable relay 環境変数:
- `CODEX_WS_RELAY_EVENT_MAX`（既定: `6000`）: threadごとの保持イベント数
- `CODEX_WS_RELAY_IDLE_TTL_MS`（既定: `1800000`）: クライアント切断後に upstream relay を保持する時間
- `CODEX_WS_RELAY_COMPLETED_TTL_MS`（既定: `60000`）: turn完了後の保持時間
- `CODEX_WS_RELAY_MAX_ACTIVE`（既定: `64`）: 同時保持relay上限

起動例:
```bash
private_runner/run-local.sh start --mode full
```

Cloudflare Tunnel も同時に起動する場合だけ、明示的に opt-in します:
```bash
private_runner/run-local.sh start --mode full --cloudflare-tunnel
```

## Google Cloud TTS ローカル認証（ADC）
Google Cloud TTS を `ttsProvider=google` で使う場合は、runner ホストで ADC を作成してください。

```bash
gcloud init
gcloud auth application-default login
gcloud config set project your-google-cloud-project-id
```

`.env` には最低限この2つを設定します:
- `TTS_PROVIDER=elevenlabs` または `google` または `aivisspeech`
- `GOOGLE_CLOUD_PROJECT_ID=your-google-cloud-project-id`

## YouTube ツール認証
`youtube_search` / `youtube_channel_latest` / `youtube_favorites` は、公開データ取得用途では `YOUTUBE_API_KEY` 利用を推奨します。
アプリ表示用の `/youtube-videos`（`videos.list`）も同じ認証方針です。

```bash
# private_runner/.env
YOUTUBE_API_KEY=your-youtube-data-api-key
```

`YOUTUBE_API_KEY` 未設定時は `gcloud auth application-default print-access-token` を試し、失敗時は `gcloud auth print-access-token` にフォールバックします。

## Localhost E2E（runner + Expo）
1. runner を起動（repo root から）
```bash
private_runner/run-local.sh start --mode full
```

2. 健康確認
```bash
curl -sS http://127.0.0.1:8788/health
```

3. `/reply` 確認（legacy）
```bash
curl -sS -X POST http://127.0.0.1:8788/reply \
  -H "Authorization: Bearer <RUNNER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"transcript":"こんにちは","systemPrompt":"返答は1文で"}'
```

4. `/reply-files` 確認（legacy）
```bash
curl -sS -X POST http://127.0.0.1:8788/reply-files \
  -H "Authorization: Bearer <RUNNER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"transcript":"llm_root に hello.txt を作成して hello と書いて","rootDir":"llm_root"}'
```

5. `/stt` 確認（`GROQ_API_KEY` 設定時）
推奨（バイナリ直送 / multipart）:
```bash
curl -sS -X POST http://127.0.0.1:8788/stt \
  -H "Authorization: Bearer <RUNNER_TOKEN>" \
  -F "file=@/path/to/recording.m4a;type=audio/m4a" \
  -F "language=ja"
```
`application/json` は非対応です（`415 stt_multipart_required`）。

6. `/tts` 確認（ElevenLabs）
```bash
curl -sS -X POST http://127.0.0.1:8788/tts \
  -H "Authorization: Bearer <RUNNER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"ttsProvider":"elevenlabs","text":"こんにちは、これはAPIテストです。","modelId":"eleven_multilingual_v2","voiceId":"JBFqnCBsd6RMkjVDRZzb"}'
```

7. `/tts` 確認（Google Cloud TTS）
```bash
curl -sS -X POST http://127.0.0.1:8788/tts \
  -H "Authorization: Bearer <RUNNER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"ttsProvider":"google","text":"こんにちは、これはGoogle Cloud TTSテストです。","languageCode":"ja-JP","voiceId":"ja-JP-Neural2-B","audioEncoding":"MP3"}'
```

8. `/tts` 確認（AivisSpeech / macOS localhost）
```bash
curl -sS -X POST http://127.0.0.1:8788/tts \
  -H "Authorization: Bearer <RUNNER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"ttsProvider":"aivisspeech","text":"こんにちは、これはAivisSpeechテストです。","voiceId":"888753760"}'
```

9. Expo アプリ起動
```bash
cd expo
npm run ios
```

10. アプリ入力値
- iOS Simulator: `Runner URL = http://127.0.0.1:8788`
- 実機: `Runner URL = http://<MacのLocalHostName>.local:8788`
- `Runner Token` は Pairing QR の token。固定token検証時だけ、`RUNNER_TOKEN_MODE=env` にして `.env` の `RUNNER_TOKEN` と同じ値を使う
- Appには次のUXオプションがあります:
  - `LLM Model` プルダウンで `openai-codex/gpt-5.6-sol` / `openai-codex/gpt-5.6-terra` / `openai-codex/gpt-5.6-luna` / `openai-codex/gpt-5.4-mini` / `openai-codex/gpt-5.4` / `openai-codex/gpt-5.3-codex` / `openai-codex/gpt-5.3-codex-spark` を選択
  - `Think` プルダウンで `low|medium|high|xhigh` を選択
  - 上記2つの設定は端末内に保存され次回起動時に復元
  - `TTS Provider` を `elevenlabs` / `google` / `aivisspeech` で切替
  - `Load Voices (/voices)` で選択中 provider の音声一覧取得
  - 取得した音声から `voiceId` を選択して `/tts` に反映
  - `TTS Speed` で読み上げ速度を調整（設定は保存され次回起動時に復元）
  - `Send + Stream TTS (WS)` で返答生成と句読点区切りTTSを同時実行
  - ストリーム処理の進捗（mode / text_delta数 / segment状態）を画面表示
  - `Start Auto Recording` で metering ベースの自動録音/自動文字起こし
  - 録音停止後に自動文字起こし（設定は端末保存・次回復元）
  - 文字起こし後に自動送信（設定は端末保存・次回復元）
  - 返答後に自動音声再生（/tts）（設定は端末保存・次回復元）
  - `Log Settings JSON` で現在設定をJSONとして Expo terminal に出力（他端末への初期値共有用）
  - `Read Reply (/tts)` で手動再生
  - 最新10件の履歴表示
  - エラー表示方針（開発時）: App画面にはエラー文言を出さず、Expoのterminalログ（`console.error`）で確認
  - エラー表示方針（開発時）: runner側エラーは runner起動terminalのログで確認

## API
### GET /health
- 生存確認

### GET /config/limits
- Header: `Authorization: Bearer <RUNNER_TOKEN>`
- 実行時の上限・タイムアウト設定を返します（秘密情報は含みません）。
- Response:
```json
{
  "llm": {
    "timeoutMs": 1800000,
    "upstreamMaxRetries": 3,
    "upstreamRetryBaseMs": 700,
    "upstreamRetryMaxMs": 4000,
    "toolMaxRounds": 500
  },
  "approval": {
    "timeoutMs": 86400000
  },
  "stt": {
    "groqTimeoutMs": 120000
  },
  "tts": {
    "maxChars": 5000,
    "segmentMaxEstMs": 1200
  }
}
```

### POST /config/limits
- Header: `Authorization: Bearer <RUNNER_TOKEN>`
- 実行時の上限設定を更新します（runnerプロセス再起動で `.env` 値に戻ります）。
- Body:
```json
{
  "llm": {
    "toolMaxRounds": 500
  },
  "approval": {
    "timeoutMs": 86400000
  }
}
```
- `toolMaxRounds` は `1-1000` の整数。
- `approval.timeoutMs` は `1000-86400000` の整数。

### GET /jobs
- Header: `Authorization: Bearer <RUNNER_TOKEN>`
- 直近ジョブを返します。`limit` クエリで件数指定できます（`1-200`）。

### GET /jobs/:jobId
- Header: `Authorization: Bearer <RUNNER_TOKEN>`
- ジョブ詳細を返します。`sinceSeq` を指定すると、その seq より後のイベントのみ返します。

### POST /jobs/:jobId/cancel
- Header: `Authorization: Bearer <RUNNER_TOKEN>`
- 実行中ジョブをキャンセルします。

### POST /reply (legacy)
- Header: `Authorization: Bearer <RUNNER_TOKEN>`
- Body:
```json
{
  "transcript": "こんにちは",
  "systemPrompt": "返答は1文で",
  "rootDir": "llm_root",
  "fileTools": true,
  "modelRef": "openai-codex/gpt-5.4-mini",
  "reasoningEffort": "low",
  "messages": [
    { "role": "user", "content": "こんにちは" },
    { "role": "assistant", "content": "こんにちは。今日はどうしましたか？" },
    { "role": "user", "content": "おすすめの昼ごはんは？" }
  ]
}
```
- `messages` は任意。指定した場合は会話履歴（古い順）として利用され、`transcript` 単体より優先されます。
- `modelRef` は任意。省略時は `.env` の `OPENAI_CODEX_MODEL`（既定 `openai-codex/gpt-5.4-mini`）
- `reasoningEffort` は任意。`none|low|medium|high|xhigh` を指定可能。省略時は `.env` の `OPENAI_CODEX_REASONING_EFFORT`
- `fileTools` は任意。既定 `true`（`/reply` でも file tools を使います）。`false` の場合は通常会話モードのみ。
- `rootDir` は任意。省略時は `.env` の `LLM_FILE_ROOT`（既定: `llm_root`）
- `rootDir` は workspace 内のみ指定可能。workspace 外は拒否されます。
- path は `rootDir` 基準の相対パスのみを使います（`..` / 絶対パスは禁止）。
- `llm_root/...` のような root 名付き指定が来た場合はサーバー側で相対へ正規化して実行します。
- 利用可能なツール:
  - `list_dir`
  - `search_text`
  - `find_files`
  - `read_file_range`（1-based、両端含む。`end_line` 超過時は末尾へ自動クリップ。`start_line` 超過はエラー）
  - `apply_patch`
  - `run_tests`（非0終了でも `exitCode/stdout/stderr` を返却）
  - `run_command_sandboxed`（allowlist制限 + 既定承認必須。`which` は自動許可）
  - `git_diff`
  - `media`（`LLM_FILE_ENABLE_MEDIA_TOOL=1` のとき）
- `run_command_sandboxed` の許可コマンドは `SANDBOXED_RUN_ALLOWED_COMMANDS` で調整できます。
- `run_command_sandboxed` は `WS /stream-tts` の承認フローで実行します（同一 `sessionId` + `approvalKey` は再承認を省略）。
- 既定では `write_file` / `edit_file` は公開しません。
- `LLM_FILE_ENABLE_LEGACY_WRITE_TOOLS=1` で `write_file` / `edit_file` を再公開できます。
- `LLM_FILE_MAX_TOOL_ROUNDS` 既定値は `500`。これは「tool loop の round 上限」であり、実際の tool call 回数上限とは一致しない場合があります。
- 全 tool call は `LLM_FILE_AUDIT_LOG_PATH`（既定 `private_runner/logs/llm_tool_audit.jsonl`）へ監査ログ出力
  - 監査ログには `tool_category`（`observe|edit|verify|diff|safety`）を含みます。
- Response:
```json
{
  "reply": "こんにちは。今日はどのようにお手伝いしましょうか？",
  "provider": "openai-codex",
  "route": "openai-codex-responses",
  "modelRef": "openai-codex/gpt-5.4",
  "rootRelativePath": "llm_root",
  "sessionId": "uuid",
  "toolCalls": 1,
  "replyRepaired": false
}
```

### POST /reply-files (legacy)
- `/reply` と同じ file tools モードを明示的に使うための互換エンドポイントです。
- Header: `Authorization: Bearer <RUNNER_TOKEN>`
- Body:
```json
{
  "transcript": "llm_root に TODO.md を作って1行書いて",
  "systemPrompt": "必要ならファイルツールを使ってください",
  "rootDir": "llm_root",
  "modelRef": "openai-codex/gpt-5.4-mini",
  "reasoningEffort": "low",
  "messages": [
    { "role": "user", "content": "プロジェクトのメモを書きたい" }
  ]
}
```
- `rootDir` は任意。省略時は `.env` の `LLM_FILE_ROOT`（既定: `llm_root`）
- `rootDir` は workspace 内のみ指定可能。workspace 外は拒否されます。
- path は `rootDir` 基準の相対パスのみを使います（`..` / 絶対パスは禁止）。
- `llm_root/...` のような root 名付き指定が来た場合はサーバー側で相対へ正規化して実行します。
- 利用可能なツール:
  - `list_dir`
  - `search_text`
  - `find_files`
  - `read_file_range`（1-based、両端含む。`end_line` 超過時は末尾へ自動クリップ。`start_line` 超過はエラー）
  - `apply_patch`
  - `run_tests`（非0終了でも `exitCode/stdout/stderr` を返却）
  - `run_command_sandboxed`（allowlist制限 + 既定承認必須。`which` は自動許可）
  - `git_diff`
  - `media`（`LLM_FILE_ENABLE_MEDIA_TOOL=1` のとき）
- `run_command_sandboxed` の許可コマンドは `SANDBOXED_RUN_ALLOWED_COMMANDS` で調整できます。
- `run_command_sandboxed` は `WS /stream-tts` の承認フローで実行します（同一 `sessionId` + `approvalKey` は再承認を省略）。
- 既定では `write_file` / `edit_file` は公開しません。
- `LLM_FILE_ENABLE_LEGACY_WRITE_TOOLS=1` で `write_file` / `edit_file` を再公開できます。
- `LLM_FILE_MAX_TOOL_ROUNDS` 既定値は `500`。これは「tool loop の round 上限」であり、実際の tool call 回数上限とは一致しない場合があります。
- 全 tool call は `LLM_FILE_AUDIT_LOG_PATH`（既定 `private_runner/logs/llm_tool_audit.jsonl`）へ監査ログ出力
  - 監査ログには `tool_category`（`observe|edit|verify|diff|safety`）を含みます。
- Response:
```json
{
  "reply": "TODO.md を作成しました。",
  "provider": "openai-codex",
  "route": "openai-codex-responses",
  "modelRef": "openai-codex/gpt-5.4-mini",
  "rootRelativePath": "llm_root",
  "sessionId": "uuid",
  "toolCalls": 2,
  "replyRepaired": false
}
```

### POST /stt
- Header: `Authorization: Bearer <RUNNER_TOKEN>`
- Body: `multipart/form-data`
  - `file`: 音声ファイル（必須）
  - `language`: 文字起こし言語（任意）
- `language` は任意。未指定時は `GROQ_STT_LANGUAGE`（既定 `ja`）を利用。
- Response:
```json
{
  "transcript": "こんにちは",
  "provider": "groq",
  "language": "ja"
}
```

### POST /tts
- Header: `Authorization: Bearer <RUNNER_TOKEN>`
- Body:
```json
{
  "ttsProvider": "elevenlabs",
  "text": "こんにちは、これはAPIテストです。",
  "speedScale": 1.1,
  "modelId": "eleven_multilingual_v2",
  "voiceId": "JBFqnCBsd6RMkjVDRZzb",
  "outputFormat": "mp3_44100_128"
}
```
- `ttsProvider` 省略時は `.env` の `TTS_PROVIDER`（既定: `elevenlabs`）を利用
- `ttsProvider=google` の場合は以下を利用:
  - `voiceId`（例: `ja-JP-Neural2-B`）
  - `languageCode`（例: `ja-JP`）
  - `audioEncoding`（例: `MP3`）
- `ttsProvider=aivisspeech` の場合:
  - runner は macOS で起動
  - `AIVISSPEECH_API_BASE_URL` は localhost（例: `http://127.0.0.1:10101`）
  - `voiceId` は `/voices` で取得したスタイルID（省略時は `AIVISSPEECH_SPEAKER` or 先頭音声）
- `speedScale` は任意（`0.5 ~ 2.0`、既定 `1.0`）
- Response:
```json
{
  "audioUrl": "http://127.0.0.1:8788/tts-media/<id>",
  "audioBytes": 12345,
  "mimeType": "audio/mpeg",
  "provider": "elevenlabs",
  "voiceId": "JBFqnCBsd6RMkjVDRZzb",
  "modelId": "eleven_multilingual_v2",
  "outputFormat": "mp3_44100_128"
}
```

### GET /voices
- Header: `Authorization: Bearer <RUNNER_TOKEN>`
- Query: `?ttsProvider=elevenlabs|google|aivisspeech`（省略時は `TTS_PROVIDER`）
- Response:
```json
{
  "voices": [
    {
      "voiceId": "JBFqnCBsd6RMkjVDRZzb",
      "name": "George",
      "category": "premade",
      "previewUrl": "https://..."
    }
  ],
  "defaultVoiceId": "JBFqnCBsd6RMkjVDRZzb",
  "provider": "elevenlabs"
}
```

### WS /runner-ws（統合 endpoint）
- URL: `ws://127.0.0.1:8788/runner-ws`
- 認証: WebSocket handshakeの `Authorization: Bearer <RUNNER_TOKEN>`
- Expo ↔ runner 間だけ envelope 化します。runner ↔ codex app-server upstream は raw JSON-RPC のままです。
- envelope:
```json
{
  "channel": "llm",
  "op": "rpc",
  "requestId": "optional-client-request-id",
  "threadId": "optional-thread-id",
  "seq": 0,
  "payload": {}
}
```
- channel:
  - `control`: `ready` / `ping` / `pong` / `error`
  - `llm`: codex app-server JSON-RPC payload の中継
  - `relay`: `attached` / `seq` / `resume` / `resume_miss` / `closed`
  - `tts`: stream TTS job の `start` / `attach` / `tool_approval_decision` と job event
- TTS 音声本体は WebSocket に載せず、従来どおり `audioUrl` を返します。

### WS /stream-tts（legacy 互換）
- URL: `ws://127.0.0.1:8788/stream-tts`
- 認証: WebSocket handshakeの `Authorization: Bearer <RUNNER_TOKEN>`
- 最初にクライアントから `start` メッセージを送信:
```json
{
  "type": "start",
  "transcript": "こんにちは",
  "systemPrompt": "返答は1文で",
  "rootDir": "llm_root",
  "fileTools": true,
  "modelRef": "openai-codex/gpt-5.4-mini",
  "reasoningEffort": "low",
  "messages": [
    { "role": "user", "content": "こんにちは" }
  ],
  "ttsProvider": "aivisspeech",
  "voiceId": "888753760",
  "speedScale": 1.1
}
```
- `fileTools` は任意。既定 `true`。
- `rootDir` は任意。省略時は `LLM_FILE_ROOT`（既定 `llm_root`）。
- `fileTools=true` の場合、`/reply` と同じ file tools 実行ループを使います。
- サーバーから返る主なイベント:
  - `ready`: 接続完了
  - `started`: 推論開始
  - `progress`: file-tools 進捗（`stage`, `round`, `maxToolRounds`, `toolCalls`, `pendingToolCalls`, `toolName`, `status`, `durationMs`, `message`）
  - `stream_mode`: `native_delta` / `pseudo_delta` / `file_tools_pseudo` / `mock_delta`
  - `tool_approval_required`: `run_command_sandboxed` 実行前の承認要求（`requestId`, `command`, `args`, `reason`, `approvalKey`, `approvalMode`, `message`）
  - `text_delta`: 逐次テキスト（`source: native|pseudo|mock`）
  - `segment_queued`: 句読点区切りチャンクをキュー投入
  - `segment_tts_started`: チャンクの音声生成開始
  - `segment_tts_done`: チャンクの音声生成完了
  - `audio_chunk`: 句読点（`。` / `、` / 改行）で区切った音声チャンク（`audioUrl` + `audioBytes`）
  - `done`: 返答完了（`toolCalls`, `rootRelativePath`, `sessionId` を含む）
  - `error`: エラー
- クライアントがサーバーへ返す承認イベント:
  - `tool_approval_decision`: `{ "type":"tool_approval_decision", "requestId":"...", "approved": true|false }`

### run_command_sandboxed 承認ポリシー
- `.env` で `COMMAND_APPROVAL_POLICY_PATH`（既定: `private_runner/command_approval_policy.json`）を指定できます。
- 既定は `defaultApproval=required` です。
- `toolrun` を使う場合は `SANDBOXED_RUN_ALLOWED_COMMANDS` に `toolrun` を含めてください。
- `toolrun` の配置先は `COMMAND_EXEC_BIN_DIR`（既定: `private_runner/bin`）です。
- `toolrun` のツール定義は `TOOLRUN_MANIFEST_PATH`（既定: `private_runner/toolbox/manifest.json`）です。
- 例: `toolrun youtube_search ...` だけ無承認にする場合
```json
{
  "defaultApproval": "required",
  "commands": {
    "toolrun": {
      "approval": "required",
      "firstArgPolicies": {
        "youtube_search": { "approval": "none" }
      }
    }
  }
}
```

### toolrun / youtube_search / youtube_channel_latest / youtube_favorites / brave_search
- `toolrun` 本体: `private_runner/bin/toolrun`
- 実装: `private_runner/tools/toolrun.mjs`
- ツール定義: `private_runner/toolbox/manifest.json`
- YouTube検索スクリプト: `private_runner/tools/youtube_search.sh`
- `youtube_search.sh` は引数 `query`（必須）と `maxResults`（任意: 1-10）を受け取り、`YOUTUBE_API_KEY`（互換: `YOUTUBE_DATA_API_KEY`）優先で YouTube Data API v3 を呼びます。未設定時は gcloud トークンへフォールバックします。
- YouTubeチャンネル最新取得スクリプト: `private_runner/tools/youtube_channel_latest.mjs`
- `youtube_channel_latest.mjs` は引数 `channelRef`（必須）と `maxResults`（任意）を受け取り、`YOUTUBE_API_KEY` 優先で `channels.list` + `playlistItems.list` により最新動画を返します（`search.list` 不使用）。
- 第1引数 `channelRef` は `UC...` / `@handle` / YouTubeチャンネルURL / 登録済みエイリアスを受け付けます。
- `maxResults` は不正値でも失敗せず既定値（3）で処理します。
- 追加エイリアスは `YOUTUBE_CHANNEL_ALIASES_JSON='{"別名":"UC..."}'` で注入できます。
- チャンネル解決失敗時は `ok:false` + `error.code`（`channel_not_found`）を JSON で返します。
- YouTubeお気に入り取得スクリプト: `private_runner/tools/youtube_favorites.mjs`
- `youtube_favorites.mjs` は登録済みチャンネル群から、チャンネルごとに最新1件を返します。
- 第1引数 `pageIndex`（任意）は 0始まりのページ番号です（例: `"0"`, `"1"`）。
- 引数なし実行時は、会話セッション内の保存状態から次ページを返します。
- セッションIDは `YOUTUBE_FAVORITES_SESSION_ID` で受け取り、セッション単位でページ進捗を保存します。
- 1ページあたり件数は `YOUTUBE_FAVORITES_PAGE_SIZE` で設定できます（既定: `5`、範囲: `1-20`）。
- お気に入り総件数は `YOUTUBE_FAVORITES_TOTAL_COUNT` で設定できます（既定: `25`、範囲: `1-200`）。
- 状態保存先は `YOUTUBE_FAVORITES_STATE_PATH`（既定: `private_runner/logs/youtube_favorites_paging_state.json`）。
- 状態の有効期限は `YOUTUBE_FAVORITES_STATE_TTL_MS`（既定: 900000ms = 15分）。
- Brave検索スクリプト: `private_runner/tools/brave_search.sh`
- `brave_search.sh` は引数 `query`（必須）のみを受け取り、`count=5` / `country=JP` / `search_lang=jp` を固定で Brave Search API を呼びます。
- APIキーは runner の環境変数 `BRAVE_API_KEY`（または互換 `BRAVE_SEARCH_API_KEY`）からのみ読み取ります。

## テスト（mock）
```bash
RUNNER_MOCK=1 RUNNER_TOKEN=test node private_runner/server.mjs
```

## 認証エラー時の挙動
- 未ログインや認証失効で `openai-codex-responses` が失敗した場合、`codex-ws` および legacy `/reply` `/reply-files` は認証エラーを返します。
- 返却される `help` に沿って runner ホストで再ログインしてください。
