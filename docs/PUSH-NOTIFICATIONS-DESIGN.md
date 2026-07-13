# PUSH通知 設計ドキュメント

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
| 承認リクエスト | 通知のアクションボタン(承認/拒否)で、アプリを開かずに返答可能にする |
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
  - `turn_completed`: タップでアプリ起動 → 既存の再接続+イベントリプレイ(`runner_relay_attached`)で該当セッションへ遷移。
  - `approval_request`: アクションボタン「承認」「拒否」付き。本文タップ時はアプリを開いて既存の承認UI(`approvalFlow.ts`)を表示。
- **「承認にFace IDを要求」設定(ON/OFF、アプリの設定画面に追加)**:
  - ON: 「承認」アクションはアプリをフォアグラウンド起動し、Face ID(expo-local-authentication)成功後に返答を送信。
  - OFF: バックグラウンドで即返答を送信。ただしiOS標準の `authenticationRequired` オプションを付け、端末ロック中はロック解除を要求する。
  - 「拒否」は安全側の操作なので、設定によらずバックグラウンドで即送信。
- 注意: アプリがユーザーによって完全終了(スワイプキル)されている場合、iOSはアクション応答時にアプリをバックグラウンド起動するが、ネットワーク到達性(ランナーへの接続可否)に依存する。失敗時は通知タップでアプリを開く導線にフォールバック。

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
    "alert": { "title": "タスク完了", "body": "<gpt-5.6-luna low による要約>" },
    "sound": "default",
    "category": "TURN_COMPLETED",
    "thread-id": "<sessionId>"
  },
  "sessionId": "...", "turnId": "..."
}

// 承認リクエスト
{
  "aps": {
    "alert": { "title": "承認リクエスト", "body": "<コマンド/ツールの短い説明>" },
    "sound": "default",
    "category": "APPROVAL_REQUEST",
    "interruption-level": "time-sensitive"  // 集中モードを貫通(決定)。entitlementに time-sensitive 追加が必要
  },
  "approvalId": "...", "sessionId": "..."
}
```

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

## 10. 未決事項(相談ポイント)

なし(2026-07-13 時点ですべて解消)。実装開始の承認待ち。
