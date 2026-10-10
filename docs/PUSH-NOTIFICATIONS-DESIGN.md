# PUSH通知 設計ドキュメント

## 用途別アイコン・通知音（2026-10）

現在のリモート通知は次の5用途。分類は既存の `aps.category` をそのまま用い、
通知を作る2つのサービスから `push-notification-presentation.mjs` を共有する。
本文からの推測、送信先やAPNsクライアントでの用途判断は行わない。

| 用途 | category | 発生元 |
|---|---|---|
| 作業完了 | `TURN_COMPLETED` | Codex/Claude Agent、Codex relay、キュー実行、スケジュールCodex完了 |
| 音声会話完了 | `VOICE_COMPLETED` | 音声オーケストレーター |
| 承認要求 | `APPROVAL_REQUEST` | Agent action、Codex relay approval |
| スケジュール失敗 | `SCHEDULE_FAILED` | LLM・shell・オーケストレーターの実行失敗 |
| Codex利用上限 | `CODEX_USAGE_LIMIT` | アカウント利用状況サービスの新しい制限episode |

利用上限の重複抑止はアカウントサービスが所有し、スケジュールの利用上限失敗は
別途 `SCHEDULE_FAILED` を送らない。通常完了の既読判定、通知badge、承認buttons、
タップ時の遷移、前景での通知抑制は既存どおり。前景でOSの通知と音を出すのは
`SCHEDULE_FAILED` のみで、`CODEX_USAGE_LIMIT` はWS経由で利用状況表示を更新する。

初期素材は `expo/notifications/assets` のsimple案。Bittyの通常アイコンに用途マークを
合成したPNGと、用途別の短いPCM WAVを同梱する。PNG名はcategoryを小文字・ハイフンへ
変換したもの、音名は `bitty-<同じ名前>.wav`。候補の切替設定は設けない。

OS通知の画像はCommunication Notificationsのavatarを利用する。これはアプリアイコン
そのものを通知ごとに差し替えるAPIではない。合成PNGをavatarへ指定し、OSが表示位置と
小さいアプリアイコンの重なりを決める。用途別通知に `mutable-content: 1` を付け、
独立した `BittyNotificationService` が同梱PNGから `INSendMessageIntent` を作り、
incoming interactionのdonation完了後に元のcontentを `updating(from:)` へ渡す。
送信者IDは用途ごとの固定Bitty ID、連絡先IDは指定せず、表示名は元通知タイトルとする。

この方式はJSや画像ダウンロードを使わず、アプリが起動していない場合もリモート通知の
表示前に処理できる。元のcategory、userInfo、badge、thread、interruption levelが
変わった場合は加工を採用せず元通知を返す。音・本文は元contentから引き継がせ、
タイトル・副題はOSのcommunication表示仕様に従う。未知category、素材不足、
donation/update失敗、時間切れも元通知へ戻す。成功したcontentを再編集しない。

Communication Notificationsは画像装飾以外にSiriの学習、通知要約やFocusによる表示判断、
対応機器での読み上げにも関わる。5用途をBittyからの通信として扱うが、
`notifyRecipientAnyway` や架空の電話番号・メールアドレスは使わない。
表示・音・Focusの実際の動作は端末の通知設定とOSにも依存するため、実機確認が必要。

Expoのlocal plugin `withPushNotificationPresentation` がprebuildごとにNSEを再現する。
Apple公式sampleに合わせ、Communication Notifications entitlementと
`NSUserActivityTypes: [INSendMessageIntent]` はmainアプリへ付与する。
NSEへ不要なIntents extensionや権限、App Group、React Native依存は加えない。
新しいNSEの署名とmainのcapability更新を含むアプリ再ビルドが必要で、OTA更新だけでは動かない。
旧アプリへ送った場合は加工前の通知が表示され、未同梱の音名はOSの標準音へfallbackする。

ローカル通知は別経路：承認送信失敗（Swift/JS）とFace IDによるアプリ起動要求（Swift）。
NSEが対象とするのはリモート通知のみなので、これらをcommunication扱いには拡張しない。

参考：[Communication Notifications実装](https://developer.apple.com/documentation/usernotifications/implementing-communication-notifications)、
[Apple公式sample](https://developer.apple.com/documentation/UserNotifications/handling-communication-notifications-and-focus-status-updates)、
[NSEとmutable-content](https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications)。


状態: 相談中(ドラフト)
ブランチ: feat/push-notifications

## 1. 目的 / 非目的

- 目的: アプリが停止・バックグラウンド・WS切断中でも、private_runner側のイベント(ターン完了・承認リクエスト)をiOSのPUSH通知でユーザーへ届ける。承認リクエストは通知から直接返答できるようにする。
- 非目的: Android対応、クラウド中継サーバーの新設、既存のアプリ内通知(WS経由)の置き換え。

## 2. 決定事項

| 項目 | 決定 |
| --- | --- |
| 配信経路 | private_runner から APNs へ直接送信(HTTP/2 + ES256 JWT、Node組み込みモジュールのみ、新規npm依存なし) |
| 前提 | Apple Developer Program 加入済み。APNs認証キー(.p8)を発行して使用 |
| 対象イベント | ターン完了、承認リクエスト |
| 承認リクエスト | 通知のアクションボタン(承認/拒否)で、アプリを開かずに返答可能にする。expo-notificationsのJS層はバックグラウンドアクションを処理できないため、ローカルネイティブモジュール(Swift)が返答を送信する(§4.3) |
| 通知本文 | 応答プレビューを含める。runner側で gpt-5.6-luna (reasoning: low) により短文要約して送信。要約は既存Codex経路を再利用して呼び出す |
| 送信先 | 常に全登録デバイスへ送信。アプリ側がフォアグラウンド時は表示を抑制(runner側の接続判定は不要) |
| 通知の緊急度 | 承認リクエスト = time-sensitive(集中モード貫通)、ターン完了 = 通常 |
| 誤タップ対策 | 「承認にFace IDを要求」設定をアプリに追加(ON/OFF切替可) |

## 3. 全体構成

```
[iOSアプリ (Expo)]
  ├─ expo-notifications: 権限取得 / APNsデバイストークン取得 / 通知アクション処理
  └─ POST /push/devices ──→ [private_runner]
                               ├─ push-device-store: デバイストークン永続化 (JSON)
                               ├─ push-summarizer: gpt-5.6-luna low で本文要約
                               ├─ apns-client: HTTP/2 + ES256 JWT で APNs へ直接送信
                               └─ イベントフック:
                                    ・ターン完了 (broadcastRunnerWsTurnCompletedNotification 周辺)
                                    ・承認リクエスト (approval 転送/タイムアウト周辺)
                                          │
                                          ▼
                                     [APNs] ──→ iOS端末に通知表示
                                                  └─ アクション(承認/拒否) → runnerへ返答
```

## 4. アプリ側 (expo/)

### 4.1 パッケージ・設定
- `expo-notifications` を追加(既存構成で唯一の新規依存)。
- `expo/app.json` に plugin 追加 + `aps-environment` entitlement。`npx expo prebuild` でネイティブ再生成。
- App ID (`app.bitty.mobile`) に Push Notifications capability を追加(Apple Developerポータル)。
- EASは使わない。Expo Push Token ではなく `getDevicePushTokenAsync()` でネイティブAPNsトークンを取得する。

### 4.2 トークン登録フロー
1. 起動時(またはランナー接続確立時)に通知権限を確認・リクエスト。
2. APNsデバイストークンを取得。
3. `POST /push/devices` で runner に登録(既存Bearerトークン認証)。トークン変化時は再登録。
4. 端末側の識別子(deviceId)は生成して `expo-secure-store` に保存(`secureRunnerCredentials.ts` のパターンに倣う)。

### 4.3 通知の受信・タップ・アクション
- 通知カテゴリを2種定義:
  - `TURN_COMPLETED`: タップでアプリ起動 → 既存の再接続+イベントリプレイ(`runner_relay_attached`)で該当セッションへ遷移。
  - `APPROVAL_REQUEST`: アクションボタン「承認」「拒否」付き。本文タップ時はアプリを開いて既存の承認UI(`approvalFlow.ts`)を表示。
- **バックグラウンド返答はローカルネイティブモジュール(Swift)が担当**:
  - 背景: expo-notifications のiOSネイティブ実装(`NotificationCenterManager.swift`)は `UNUserNotificationCenterDelegate.didReceive` で completionHandler を即時同期呼び出しし、background task assertion も取らないため、バックグラウンドアクションのJS処理はfetch完了前にsuspendされる(アプリkill時はJS自体が起動しない。`registerTaskAsync` は content-available サイレント通知専用)。iOS自体はバックグラウンドアクションに実行時間を与えるので、ネイティブで処理すれば「アプリを開かずに返答」が成立する。
  - 実装: `expo/modules/bitty-push-approval`(autolinking対象のローカルexpo-module)。`ExpoAppDelegateSubscriber` の didFinishLaunching で `NotificationCenterManager.shared.addDelegate(...)` に自前の `NotificationDelegate` を登録し、`APPROVAL_REQUEST` の approve/deny アクションのみを処理。`UIApplication.beginBackgroundTask` で実行時間を確保し、Swiftの `URLSession` で直接 `POST /push/approvals/:id/respond` を送る(Bearer+CF-Accessヘッダー)。それ以外のカテゴリ/アクションは `didReceive` が false を返してJS層(EmitterModule)の既存動作に委ねる。
  - ネイティブからの資格情報取得: runnerUrl と Face ID設定は `<Documents>/bitty-settings.json`(JSと同一ファイル)、runnerToken / CF-Access client id・secret は expo-secure-store が書くKeychainエントリ(`kSecClassGenericPassword`, service `"app:no-auth"`(旧 `"app"`)、account/generic = キー名utf8)を直接読む。
- **「承認にFace IDを要求」設定(ON/OFF、アプリの設定画面に追加、既定OFF)**:
  - OFF: 「承認」はバックグラウンドアクション(ネイティブが即返答)。アクションに `isAuthenticationRequired` を付け、端末ロック中はロック解除を要求。
  - ON: 「承認」はアプリをフォアグラウンド起動し、JS側で Face ID(expo-local-authentication。生体認証UIはバックグラウンドでは出せない)成功時のみ返答を送信。コールドスタートでリスナー登録前にイベントが発火したケースは `getLastNotificationResponse()` で回収し、レスポンスIDで重複排除。
  - 「拒否」は安全側の操作なので、設定によらずバックグラウンドで即送信(ネイティブ)。認証オプションなし。
  - 設定により「承認」アクションのフォアグラウンド/バックグラウンドが変わるため、設定変更時にカテゴリを再登録する。ネイティブ側も同じ設定ファイルを参照し、ON時のapproveは処理しない(JS側とちょうど相補の分担)。
- 返答失敗時(runner到達不可・409等)はローカル通知「承認の送信に失敗しました」でユーザーに通知し、通知タップでアプリを開く導線にフォールバック(ネイティブ/JS両経路とも)。
- 既知の制限: 端末ロック中の「拒否」はKeychain(`kSecAttrAccessibleWhenUnlocked`)からトークンを読めず失敗通知になる場合がある(承認はロック解除を要求するため対象外)。

## 5. runner側 (private_runner/)

### 5.1 新規モジュール
- `src/apns-client.mjs`
  - .p8キーからES256 JWTを生成(組み込み `crypto`)、`api.push.apple.com` / `api.sandbox.push.apple.com` へ組み込み `http2` で送信。
  - JWTは約50分キャッシュ(Apple推奨: 20〜60分)。
  - `.env` 設定: `APNS_KEY_PATH` / `APNS_KEY_ID` / `APPLE_TEAM_ID` / `APNS_TOPIC`(既定 `app.bitty.mobile`)/ `APNS_ENV`(sandbox|production)。未設定時はPUSH機能を無効化(既存機能に影響なし)。
- `src/push-device-store.mjs`
  - デバイストークンのJSONファイル永続化。保存先: `private_runner/logs/push_devices.json`(既存の `logs/cli_sessions_index.json` パターンに倣う。Git管理外)。
  - レコード: `{ deviceId, apnsToken, env, registeredAt, lastSeenAt }`。deviceId をキーに冪等更新。
  - APNsから `410 Unregistered` が返ったトークンは自動削除。

### 5.1.1 テスト方針(固定)
- private_runner: `node:test` 形式で `private_runner/tests/` に追加(既存テストと同形式)。
  - `apns-client`: JWT生成(ヘッダ/クレーム/ES256署名検証)、環境別ホスト選択、410処理。HTTP/2送信はモック。
  - `push-device-store`: 登録・冪等更新・削除・破損ファイル復旧。
  - `push-summarizer`: 成功・タイムアウト・失敗時フォールバック(runCodexはスタブ注入)。
  - エンドポイント: 認証必須・入力検証。
- expo: 既存の `jest` 構成に倣い、トークン登録ロジック・通知ハンドラのユニットテストを追加。
- `src/push-summarizer.mjs`
  - ターン完了時の応答本文を gpt-5.6-luna (reasoning: low) で1〜2文に要約して通知本文にする。
  - **呼び出し経路(固定)**: 既存の `runCodex(prompt, opts)`(`server-runtime.mjs:1785`、Codex Responses API への単発呼び出し・既存OAuth再利用)を使う。
    `opts.modelInfo = parseOpenAICodexModelRef("openai-codex/gpt-5.6-luna")`、`opts.reasoningEffort = "low"` を渡す。
    モデルは `.env` の `PUSH_SUMMARY_MODEL`(既定 `openai-codex/gpt-5.6-luna`)で上書き可能にする。新規APIキー管理は追加しない。
  - 新規モジュールは `server-runtime.mjs` を import しない(巨大ファイルとの循環参照回避)。`runCodex` 等の依存は server-runtime 側から関数引数で注入する。
  - タイムアウト(例: 5秒)・失敗時は先頭N文字の切り詰めにフォールバック。要約失敗で通知が遅延・欠落しないことを優先。

### 5.2 送信APIエンドポイント(HTTP、既存Bearerトークン認証)
- `POST /push/devices` — デバイストークン登録・更新
- `DELETE /push/devices/:deviceId` — 登録解除(通知OFF設定用)
- PUSH機能無効時(APNS_*未設定)の応答は `200 { ok: true, enabled: false }` のソフトNo-op(エラーにしない。アプリ側は enabled で判定)
- `POST /push/approvals/:approvalId/respond` — 通知アクションからの承認/拒否返答。runner内の既存approval処理(codex-wsリレー)へ橋渡しする。期限切れ・返答済みの場合は 409 を返す。

### 5.3 イベントフックと送信条件
- ターン完了: `broadcastRunnerWsTurnCompletedNotification`(`server-runtime.mjs:10745` 周辺)に分岐追加。
- 承認リクエスト: approval RPC転送箇所(`server-runtime.mjs:7659` 周辺)にフック追加。承認待ちタイムアウト前に届くよう発生即時に送信。
- 送信条件: runner側では接続状態を判定せず、**常に全登録デバイスへ送信**する。
  - フォアグラウンドのデバイスでは、アプリ側の通知ハンドラ(expo-notifications の foreground handler)が表示を抑制し、既存のアプリ内通知カード(`LlmCompletionNotifications`)に任せる。
  - これにより runner にデバイス⇄WS接続の対応管理が不要になり、実装が単純化する。
- 重複抑止: 同一ターンにつきPUSHは1回(既存の `turnCompletedNotificationSent` フラグと同様の送信済み管理)。

## 6. 通知ペイロード設計

```jsonc
// ターン完了
{
  "aps": {
    "alert": { "title": "<作業ディレクトリ名>", "body": "<gpt-5.6-luna low による要約>" },
    "sound": "default",
    "category": "TURN_COMPLETED",
    "thread-id": "<sessionId>"
  },
  "sessionId": "...", "turnId": "..."
}

// 承認リクエスト
{
  "aps": {
    "alert": { "title": "<作業ディレクトリ名>", "body": "<コマンド/ツールの短い説明>" },
    "sound": "default",
    "category": "APPROVAL_REQUEST",
    "interruption-level": "time-sensitive"  // 集中モードを貫通(決定)。entitlementに time-sensitive 追加が必要
  },
  "approvalId": "...", "sessionId": "..."
}
```

- タイトルはセッションの作業ディレクトリパスの末尾セグメント(例: `/work/test_folder` → `test_folder`)。アプリ左ナビのディレクトリ既定表示名(`deriveDirectoryDisplayName`)と同じ導出ロジックをrunner側に持つ。runnerは codex-ws リレーを通る `thread/start`/`thread/resume`/`turn/start` の `cwd`(および upstream 応答の `thread.cwd`)からディレクトリを取得する。
- ディレクトリが取得できない/空の場合は固定タイトル(ターン完了=「タスク完了」、承認リクエスト=「承認リクエスト」)にフォールバック。通知種別の判別は body の内容で行う(bodyは現状維持)。
- プレビュー本文はAppleサーバーを経由する(ユーザー了承済み)。機微情報を減らすため要約を通し、生ログは送らない。

## 7. セキュリティ

- .p8キーはリポジトリ外(ローカルパス指定)。ログ・エラー出力にキー内容・トークン全文を出さない(末尾数桁のみ)。
- `/push/*` はすべて既存 `RUNNER_TOKEN` Bearer認証必須。
- `RUNNER_TOKEN_MODE=random` の場合、再起動でアプリ側トークンが変わるが、デバイストークン登録はdeviceIdで冪等に更新する。
- 承認返答APIは approvalId の有効性・未返答を検証してから処理。

## 8. 実装フェーズ案

- Phase 1: APNsクライアント + デバイストークン登録/永続化 + ターン完了PUSH(要約付き)
- Phase 2: 承認リクエストPUSH + 通知アクション(承認/拒否)返答 + Face ID要求設定
- Phase 3(任意): 設定UI拡張(通知ON/OFF・イベント種別選択)、エラーイベント通知

## 9. 運用メモ

- **APNS_ENV**: ローカル署名のDevelopmentビルド(現行の `build-expo-ios-device.sh`)は sandbox が既定。将来 TestFlight/Ad Hoc 配布する場合は production へ切替が必要(`.env` で明示)。
- time-sensitive 通知には entitlement `com.apple.developer.usernotifications.time-sensitive` の追加が必要(`app.json` 経由で prebuild に反映)。
- ユーザーはiOS設定からアプリ単位で time-sensitive を無効化できるため、貫通は保証ではない。
- **依存アップグレード時の注意**: `expo-secure-store` / `expo-notifications` をアップグレードした際は、ネイティブ承認応答(`expo/modules/bitty-push-approval`)が依存する内部実装(Keychainの保存形式・`NotificationCenterManager` のdelegate配線)が変わっていないか、実機でバックグラウンド承認/拒否の動作確認を行うこと。

## 10. 未決事項(相談ポイント)

なし(2026-07-13 時点ですべて解消)。実装開始の承認待ち。


## スケジュール実行の失敗通知

スケジュールの保存時とターン実行時は、Agentサービスの同じ検証処理でRunnerの
モデルカタログとモデルごとの推論強度を照合する。保存済み定義の読込では実行可否を
検証しないため、提供終了したモデルを含む定義も確認・無効化できる。

スケジュールサービスは、開始前の拒否と、LLM・スクリプト・オーケストレーターの
開始後の失敗を同じ発生回の失敗として記録し、一度だけ通知する。開始後の失敗では
開始時のIDを保持する。古い発生回の失敗が後から届いても新しい発生回の状態を上書き
せず、失敗した発生回について通知する。

APNsカテゴリは `SCHEDULE_FAILED`。タイトルは「スケジュール実行失敗」、本文は
スケジュール名と短いエラー内容とする。モデルや会話が作れない失敗も通知できるよう、
LLM要約や会話の未読判定を使わない。スクリプトの標準出力・標準エラーは本文に含めない。
全登録端末へ配信し、アプリがフォアグラウンドでもバナーを表示する。

ペイロードには `scheduleId`、`occurrenceAt`、`directory` を含め、LLMの開始済み会話ID
または指定先会話IDがあれば `backendId` と `sessionId` も含める。会話IDがある通知は
既存のタップ処理で該当会話を開く。新規会話の開始前に失敗した場合は会話IDがないため、
通知タップでアプリを開いてスケジュール一覧から確認する。

通知の送信失敗はログに残し、実行状態や後続スケジュールの起動を妨げない。
APNs設定・端末登録・通知許可がない場合の送信や、Runner再起動をまたぐ送信の再試行は行わない。
