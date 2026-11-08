# Private Runner 認証入口一覧

この一覧は認証切替時の監査用であり、routing設定ではない。HTTP listenerはloopback専用のTunnel入口、LANはペアリング済みCAのHTTPS、Mac CLIは所有者専用UDSである。全HTTP methodと全pathを共通gateへ通し、以下の明示例外以外は認証を必須にする。将来pathを追加しても未認証で業務handlerへ到達しない。

## 明示例外と本人認証API

| Method | Path | 必要な資格 |
| --- | --- | --- |
| GET | `/health` | Authorizationなしの場合は稼働有無 `{ok:true}` のみ |
| POST | `/auth/login/start`, `/auth/login/complete` | Bitty session不要。メールcode・TOTP・単回challengeで発行 |
| POST | `/auth/recovery/start`, `/auth/recovery/prepare`, `/auth/recovery/complete` | Bitty session不要。メールcode＋復旧code＋新TOTPで全失効 |
| GET | `/auth/session`, `/auth/devices` | 有効session |
| POST | `/auth/reauth/start`, `/auth/reauth/complete`, `/auth/logout` | 有効session。再認証は同じsessionへbind |
| DELETE | `/auth/devices/:sessionId` | 有効session。他端末なら5分以内の再認証 |
| POST | `/auth/setup/start`, `/auth/setup/prepare`, `/auth/setup/complete`, `/auth/setup/reset` | UDS listener内部context＋local credentialのみ。HTTP / LANは不可 |

未登録、鍵欠損、store異常、認証service未初期化では認証必須経路を拒否する。旧Runner token、query token、CF資格情報だけでは業務APIに入れない。GET `/health` でもAuthorizationを送った場合は検証し、詳細を未認証へ返さない。

## 業務HTTP

下表の全経路は有効session、またはUDS上のlocal credentialを必要とする。認証後のmethod検証、path parameter検証、owner・workspace ACLは各既存業務境界を維持する。

| 所有するhandler | Pathとmethod |
| --- | --- |
| `server-runtime.mjs` 稼働・診断 | GET `/health`（詳細）, `/codex-ws-debug`, `/runner/connection-events`, `/config/limits`, `/app/status-snapshot`, `/codex-cli/status`, `/git/changed-files` |
| 同 scripts | POST `/scripts/execute`, `/scripts/start`, `/scripts/kill`; GET `/scripts/jobs` |
| 同 Codex認証 | GET `/codex-auth/profiles`; POST `/codex-auth/switch`, `/codex-auth/registrations`, `/codex-auth/profiles/:id/reauth`; GET / POST / DELETE `/codex-auth/registrations/:id`; DELETE `/codex-auth/profiles/:id`（既存regexで検証） |
| 同 queue / job | GET / POST `/codex/queued-turns`; POST `/codex/queued-turns/:id/cancel`; GET `/jobs`; GET / POST `/jobs/:id[/action]` |
| 同 client / directory | GET / POST `/client-state`; GET `/directories`; POST `/directory-identities/migrate` |
| 同 session | POST `/session-summaries`, `/sessions/read`, `/sessions/unread-count`, `/sessions/unread-state`, `/voice/unread-state`; GET `/session-messages` |
| 同 Push / log | POST `/push/devices`, `/client-logs`; DELETE `/push/devices/:id`。登録はsessionへbind、別session登録の置換・削除は直近再認証 |
| 同 file / audio | GET / POST / PUT / PATCH / DELETE `/workspace/files`; GET / HEAD `/files/media`, `/tts-media/:id`; GET `/voices`; POST `/tts`, `/youtube-videos` |
| `agent/agent-transport.mjs` | GET `/agent/backends/status`, `/agent/sessions`, `/agent/session-history/search`, `/agent/session-conversation`, `/agent/session-history`, `/agent/workspaces`; POST `/agent/workspaces/prepare`, `/agent/workspaces/confirm`, `/agent/workspaces/revoke`, `/agent/session-mode` |
| `app-control-service.mjs` | GET `/app-control/contexts/:context`, `/app-control/operations/:id`; POST `/app-control/operations` |
| `codex-schedule-http.mjs` | GET / PUT / POST `/codex-schedules`; GET `/codex-schedules/summary`; PATCH / DELETE `/codex-schedules/:id` |
| `skia-board-http.mjs` | GET `/skia-board`; POST `/skia-board/ops`, `/skia-board/import`, `/skia-board/ingest-directories` |
| `google-cloud-http.mjs` | GET `/google-cloud/status`; POST `/google-cloud/auth/start`, `/google-cloud/auth/cancel`, `/google-cloud/auth/disconnect`; PUT `/google-cloud/settings` |
| `stt-settings.mjs` | GET / PUT / PATCH `/stt/settings`（同pathの既存設定操作を含む） |
| `stt-correction.mjs` | GET `/stt/models`; POST `/stt/correct` |
| `approval-push-service.mjs` | POST `/push/approvals/:id/respond` |

同prefixで未対応のmethod・pathも、認証より先に業務dispatchへ渡さない。認証後の未対応要求は既存handlerの404 / 405で拒否する。

## WebSocketと配送

| 入口 | 契約 |
| --- | --- |
| `/runner-ws` | HTTPと同じsession検証。agent / llm / tts / relay / controlの全channelを接続sessionへbind |
| `/stream-stt`, `/stream-tts` | 同じ検証。失効・期限切れでstreamを切断 |
| 旧 `/codex-ws` と未知のWS path | 拒否。query tokenへのfallbackなし |
| APNs全配送 | approval、turn completion、widget refreshが同じsend境界を使う。登録のAPNs tokenとsessionの組が一致し、最後の同期admissionでsessionが有効な場合だけ送信 |

WSはupgradeだけでなくmessage受理・outgoing送信時に失効を反映する。新規送信を止めても、失効前にAPNsが受理した通知の回収は保証しない。

## クライアントと固定owner

JSのHTTP / WS、Swift共通connection、Widget、native Push応答、native STTが同じoriginに結び付いた端末sessionを使う。旧field保存へ戻らない。ログアウト・再登録時は旧socketとcache sourceを無効化する。

`bitty-history`、配布済み`bitty-session`、schedule CLI、Claude / Codex子processは同じ絶対UDS pathを共有する。HTTP fallbackはない。これらとremote sessionは永続owner IDへ解決し、session tokenからownerを再計算しない。過去のACP storeに別subjectがあれば所有者登録を停止し、自動統合しない。
