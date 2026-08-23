# Agent承認要求 Push通知 設計

## 文書情報

- 状態: 実装済み、自動テスト・iOS実機検証済み
- 対象ブランチ: `feat/neutral-approval-push`
- 基準: `origin/main` c6367b0、2026-08-23
- 対象: neutral Agent経路（Claude / Codex共通）
- 参照実装: raw Codexの承認Push送信・応答endpoint

## 結論

AgentServiceへprovider非依存のrun event observerを1点追加し、Serverが`action.requested`を観測してPushを送る。Push固有処理をBackendやAgentServiceへ入れない。

既存アプリは`approvalId`をopaqueとして既存の`/push/approvals/:id/respond`へそのまま返している。したがってneutral専用endpointやSwiftの分岐は追加せず、同じendpointがID種別をRunner内で振り分ける。

raw/neutralのAPNs送信ループは共通化し、pending確認方法だけを呼び出し側から渡す。これにより重複実装とPush transport/nativeの分岐追加を避ける。

ただしneutral clientは現在、`action.requested`で承認UIの回答をawaitしてevent queueを止め、server起点の`action.resolved`を処理しない。Push側で先に回答できるようになるとstale dialogから再回答してturnを中断し得るため、clientの共通action lifecycleだけは修正する。

## 1. 根本原因

neutral経路の`action.requested`はrunごとのWebSocket subscriberにしか届かない。アプリがバックグラウンドなら購読先UIが承認要求に気付けない。

不足しているのはBackend別Push処理ではなく、Serverが全runの共通eventを観測する上流点である。

- Backendは承認要求を正しく`action.requested`としてemit済み
- AgentServiceはactiveActionsとstale lifecycleを正しく管理済み
- Serverにはraw Codex専用Pushしかなく、AgentService eventへの接続が無い

## 2. 責務境界

```text
ClaudeBackend ─┐
               ├─ action.requested ─ AgentService ─ generic observer ─ Server ─ APNs
CodexBackend  ─┘                                             ↑
                                                             └─ Push応答HTTP
                                                                  ↓
                                                    AgentService.respondToAction
```

- Backend: provider protocolと承認decisionだけ
- AgentService: event生成、activeActions、汎用observer通知だけ
- Server: device、APNs、pending Push ID、HTTP認証、応答変換
- App native: 既存category、Face ID、background responderをそのまま使用
- Agent client: server起点の`action.resolved`で待機UIを閉じ、再回答しない

## 3. AgentService observer

`createAgentService`へoptionalな`onRunEvent(event)`を追加する。

契約:

- `publish()`で生成・保存した全AgentEventを1回通知する
- callback呼び出し自体は`publish()`内で同期的に開始し、戻り値のPromiseはawaitしない。Serverは`action.requested`のentry登録を最初のawaitより前に済ませる
- providerやevent typeを絞らず、そのまま渡す
- observerのthrow/rejectでrun、subscriber、Backend処理を失敗させない
- subscriber向けreplayとは別物で、observerへ過去eventを再送しない
- Push、APNs、HTTPという語彙をAgentServiceへ入れない

`createPrivateRunnerAgentRuntime`は既存の組み立て境界としてcallbackをAgentServiceへ渡すだけとする。新しいobserver classやevent busは作らない。

## 4. Server側pending管理

Serverはneutral承認だけを次のprocess-local Mapで追跡する。

```text
Map<approvalId, {
  runId,
  requestId,
  sessionRef,
  title,
  responding
}>
```

### 登録

observerが次をすべて満たす`action.requested`を受けた場合だけ登録する。

- `requestId`がある
- `sessionRef`がある
- `decisions`に`allow`と`deny`がある
- `kind !== "dynamic_tool"`

`approvalId`は`agent-approval:${randomUUID()}`とする。raw IDは`relay_...:<rpcId>`なのでprefixが衝突せず、requestIdの再利用や古い通知が新しい要求へ一致することもない。アプリは内部形式を解釈しない。

### 解決・終了

- `action.resolved`で同じrunId/requestIdのentryを削除
- terminal eventで同runの残存entryを削除
- Runner再起動後はrun自体が継続不能なのでMapを復元しない

このMapはPush deliveryのstale判定用であり、承認状態の正本ではない。正本はAgentServiceのactiveActions。

## 5. Push送信

rawの`sendApprovalRequestPush`にあるdevice列挙・APNs送信・410 device削除を、raw/neutral共通の小さな送信関数へまとめる。

共通関数が受け取るもの:

- `approvalId`
- `sessionId`、任意の`backendId`、`directory`
- title/body
- `isPending()` callback

`isPending()`は必ず次の2地点で再確認する。

1. device一覧取得後
2. 各deviceへの送信直前

rawは`relay.pendingApprovalRequestIds`、neutralはServerのpending Mapに同じentryがあり`responding === false`であることを確認する。回答開始・中断・完了後のstale Pushを同じ規則で防ぐ。

neutral payload:

```json
{
  "aps": {
    "alert": { "title": "<workspace名または承認リクエスト>", "body": "<action title 120字以内>" },
    "sound": "default",
    "category": "APPROVAL_REQUEST",
    "interruption-level": "time-sensitive"
  },
  "approvalId": "agent-approval:<uuid>",
  "backendId": "claude",
  "sessionId": "<nativeSessionId>",
  "directory": "<canonicalCwd>"
}
```

- bodyはneutral eventの`payload.title`を既存と同じ120字へ縮める
- input全文やtokenを載せない
- directoryは既存agent session bindingからServer側で読む
- binding取得失敗時もPush自体は送り、title/directoryだけfallbackする

## 6. Push応答

既存`POST /push/approvals/:approvalId/respond`を維持する。Bearer token、Push無効時のno-op、request body `{ approved: boolean }`も変更しない。

処理順:

1. 認証とbody検証
2. `approvalId`が`agent-approval:`ならneutral pending Mapを検索
3. body読取後、回答直前に同じentryがあり`responding === false`か再確認し、同期的に`responding = true`へ予約する
4. `agentService.respondToAction({ runId, requestId, decision: approved ? "allow" : "deny" })`
5. raw IDなら既存relay処理をそのまま実行

同じ通知への並行HTTP応答は、最初の1件だけが手順3の予約に成功する。2件目以降はAgentServiceを呼ばず409にする。`respondToAction`が予期せず失敗した場合は、Mapがまだ同じentryを指しているときだけ`responding = false`へ戻して再試行可能にする。処理中に`action.resolved`またはterminal eventがentryを削除した場合は復元しない。`action_expired`ではentryを削除して409にする。

応答:

- 成功: 200 `{ "ok": true, "enabled": true, "approved": <boolean> }`（既存JS responderが`ok: true`を成功条件にするためrawと同じshape）
- 解決済み、期限切れ、turn終了、重複回答: 409 `approval_not_pending`
- malformed ID/body: 400
- 認証失敗: 401
- `action_expired`は409へ正規化
- その他の内部エラーだけ500

live WebSocketとPushが競合しても、AgentServiceのactiveActions検証が最終防衛線になる。

## 7. アプリ互換

Pushのtransport部分は現行コードがすでに必要条件を満たす。

- JS `respondToPushApproval()`はapprovalIdを解析せずURL encodeして既存endpointへPOSTする
- Swift `PushApprovalResponder`も同じ
- `APPROVAL_REQUEST` category、approve/deny action、Face ID分岐を再利用できる
- notification metadataは`backendId`を既に解釈できる
- 通知tap時は`backendId + sessionId`でneutral historyを開ける

### 7.1 neutral action lifecycle

`expo/src/features/agent/client.ts`のapproval処理をrequest単位で追跡する。

```text
Map<requestId, {
  request,
  resolvedByServer
}>
```

- `action.requested`の承認UI待ちはevent queueから切り離す。失敗は既存`finish(..., interruptRun:true)`へ返す
- `onApprovalRequest()`を待つ前にMapへ登録する
- `action.resolved`を受けたら該当entryを`resolvedByServer`にし、`onApprovalRequestResolved(request)`でUI待機を解除する
- UI Promiseが`cancel`等で戻っても、`resolvedByServer`なら`action.respond`を送らず終了する
- `action.resolved`到着前にUI回答が競合して`action.respond`のerror payloadが`code: "action_expired"`になった場合も、「他経路で解決済み」としてUIを閉じ、turnをinterruptしない
- 自分が`action.respond`した通常経路は既存どおりresponse成功後にUIを閉じる
- terminal eventでも残るapproval UIを閉じ、後から回答を送らない
- dynamic toolの`result`経路は変更しない

これにより、Push・別client・同一clientのどれが先に回答しても、遅いUIは閉じるだけで二重回答しない。`action.resolved`はprovider共通eventなのでPush固有分岐はclientへ入れない。

Swift/native responder、Push endpoint形式、notification categoryは変更不要。ただしTypeScript client変更があるため、実機検証にはアプリビルドが必要。

## 8. 変更対象

| ファイル | 変更 |
|---|---|
| `private_runner/src/agent/agent-service.mjs` | optional汎用observerをpublishへ接続 |
| `private_runner/src/agent/agent-runtime.mjs` | observer callbackを組み立て境界から渡す |
| `private_runner/src/approval-push-service.mjs` | pending Map、neutral Push、既存endpoint振り分け、raw/neutral送信共通化 |
| `private_runner/src/server-runtime.mjs` | approval Push serviceの依存注入、route・raw hook接続 |
| `private_runner/tests/agent-service.test.mjs` | observer契約テスト |
| Push関連Node tests | neutral送信、stale、応答、raw回帰 |
| `expo/src/features/agent/client.ts`とtest | `action.resolved`を受ける非blocking action lifecycle |

変更しない:

- `private_runner/src/claude-backend.mjs`
- `private_runner/src/codex-turn-execution.mjs`
- `private_runner/src/agent/agent-transport.mjs`
- `expo/modules/bitty-push-approval/`（Swift native responder）
- Push category・Push応答utility

## 9. テスト計画

### AgentService

- 全eventが順序どおりobserverへ1回届く
- subscriberが無くてもobserverへ届く
- observerのthrow/rejectがrunを失敗させない
- `action.requested`のpending登録が同期的に完了し、直後の解決と取りこぼさない
- observerへreplayを二重通知しない

### Push送信

- Claude/Codexの`action.requested`で同じ汎用経路から1回送信
- payloadにapprovalId/backendId/sessionId/category/time-sensitiveが入る
- dynamic toolやallow/denyを持たないactionでは送らない
- action.resolved/terminal後は送らない
- device一覧待機中に解決された場合、送信直前の再確認で送らない
- APNs 410 device削除とno-device動作

### 応答endpoint

- neutral approve→`allow`、deny→`deny`
- 回答済み・期限切れ・同時二重回答は409
- 同時二重HTTP応答ではAgentService呼び出しが1回だけになる
- neutral成功responseは既存responder互換の`ok: true`を返す
- malformed neutral ID、body、authの検証
- raw relay IDの既存応答に回帰がない
- Push無効時の既存no-opに回帰がない

### Expo agent client

- approval UI待機中も後続`action.resolved`/terminal eventを処理できる
- Push相当のserver resolutionでdialogを閉じ、`action.respond`を再送しない
- 自分で回答した通常経路は1回だけ送る
- server resolutionとUI回答の競合でturnをinterruptしない
- `action.resolved`より先に`action_expired` responseが届く競合でもturnをinterruptしない
- `events.resume.activeActions`から再表示したapprovalにも同じ規則を適用する
- dynamic toolの既存応答に回帰がない

### 実機

1. アプリをバックグラウンドにしてClaude承認要求→Push→通知から許可→実行継続
2. Codex neutralでも同じ
3. 通知とアプリ内dialogの片方で回答すると、もう片方は解決済み/409
4. turn中断・完了後の通知回答は409
5. 通知tapで正しいBackend/sessionを開く
6. raw Codex Push承認の回帰がない

## 10. 複雑性を増やさない判断

- BackendごとのPush実装を作らない
- neutral専用HTTP endpointを作らない
- Expo/SwiftへapprovalId形式の分岐を作らない
- clientへPush固有条件を作らず、共通`action.resolved` lifecycleを完成させる
- AgentServiceへpending Push MapやAPNs処理を持たせない
- 汎用event bus/classを作らずoptional callback 1つに留める
- raw/neutralでAPNs device loopを複製しない

## 11. 実装順

1. AgentService observerと単体テスト
2. runtime配線とServer pending管理
3. raw/neutral共通Push senderへ整理
4. 既存endpointへneutral dispatchを追加
5. neutral clientの非blocking action lifecycleとテスト
6. Node/Jest/typecheck、全体回帰、diff review
7. neutral Pushを有効にするRunnerと組み合わせる前に、このclient lifecycle修正を含むアプリをbuild/installする
8. ローカルコミットで停止し、ユーザー実機検証後にpush/PR

## 12. 完了条件

- Claude/Codex neutralの承認要求がバックグラウンド端末へ届く
- 通知からのallow/denyが共通AgentServiceへ戻る
- 回答済み要求のstale Push/二重回答を防げる
- Push/別clientが先に回答したとき、アプリ内dialogが閉じて再回答しない
- raw Codexの既存Pushが変わらない
- neutral IDをraw relay IDとして誤分類せず、raw IDをneutralとして誤分類しない
- BackendとAgent clientにPush固有分岐を追加しない
