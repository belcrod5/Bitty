# Turn 完了通知の一元化設計(PUSH / in-app 通知)

## 背景と根本原因

turn 完了時の通知(in-app WS 通知 + APNs PUSH)は、現在 **runner-ws relay の観測点1箇所にしか実装されていない**。

- `server-runtime.mjs` の `observeCodexRelayCompletionNotification()`(現行 11222 行付近)が、アプリ WS relay を流れる `item/agentMessage/delta` / `item/completed` / `turn/completed` を観測し、`broadcastRunnerWsTurnCompletedNotification()` と `sendTurnCompletedPush()`(現行 11267 行付近の唯一の呼び出し)を実行する。

一方、turn の実行経路は relay 以外にも存在し、これらは**どの観測点も通らないため通知が一切出ない**:

1. queued turn(`runCodexQueuedTurn()`、現行 7121 行付近): 復旧実行。`createCodexRpcClient` の `onNotification` は `turn/started` しか見ていない。
2. location schedule 発火(`createLocationScheduleService` の `executeTurn` 配線、現行 1303 行付近): 同上。

根本原因は「**完了の観測と通知が relay という1経路の実装に埋め込まれており、実行経路が増えるたびに通知実装が漏れる**」構造にある。本設計はこれを上流で解決する。

## 方針(2段の一本化)

```text
[経路1] relay(アプリ操作のturn)
    observeCodexRelayCompletionNotification ──────────────┐
                                                          │
[経路2] queued turn        ─┐                             ├─→ notifyTurnCompleted()  ← 唯一の通知出口
                            ├─ runRunnerInitiatedTurn ────┘      (dedup → WS broadcast → APNs push)
[経路3] location schedule  ─┘   (完了テキスト捕捉込み)
```

1. **実行の一本化**: Runner 自身が開始する turn(queued turn・schedule 発火・将来の Runner 発実行)は、必ず共通ヘルパー `runRunnerInitiatedTurn()` を通す。完了テキストの捕捉は実行境界 `executeCodexTurn()` 自体が行う。
2. **通知の一本化**: 通知の出口は新モジュールの `notifyTurnCompleted()` ただ1つ。relay 観測点もこの関数を呼ぶ形に書き換える。dedup をこの関数内に持つため、同一 turn を複数の経路が観測しても通知は1回になる。

これにより「新しい実行経路を追加するときは `runRunnerInitiatedTurn()` を使う(使わなければ通知されない、は relay のような“観測型”経路のみ)」という単純な規約になる。

## 変更点 1: `createCodexRpcClient` に複数リスナー対応を追加

対象: `private_runner/src/server-runtime.mjs`(現行 6857 行付近)

- 使用箇所がなくなった単一 `onNotification` オプションは削除する。
- 内部に `notificationListeners = new Set()` を追加し、`ws.on("message")` の notification 分岐(現行 6907–6915 行付近)で全リスナーへ `(method, params)` を dispatch する。リスナー例外は握り潰し、他リスナーと RPC 処理を止めない。
- 返り値オブジェクトに `addNotificationListener(fn)` を追加する。戻り値は解除関数 `() => void`。

```js
// 追加 API(返り値オブジェクトに追加)
addNotificationListener(fn: (method: string, params: object) => void): () => void
```

## 変更点 2: `executeCodexTurn` が完了テキストを捕捉して返す

対象: `private_runner/src/codex-turn-execution.mjs`

- `client.addNotificationListener` を必須依存とする(存在しない client が渡されたら `throw new Error("client.addNotificationListener is required")`。テスト用フェイクの更新漏れを早期検出するため)。
- `turn/start` リクエスト送信の**前**にリスナーを登録し、以下を捕捉する。ロジックは relay 観測点(現行 11234–11244 行付近)と同一セマンティクスにする:
  - `item/agentMessage/delta`: `params.delta` を文字列連結で蓄積。
  - `item/completed`: `params.item.type === "agentMessage"` のとき、item から本文を抽出して蓄積値を**置き換える**(抽出は後述の `extractCodexAgentMessageText` を共通利用)。
  - スレッド ID の照合は行わない(この client は当該 turn 専用の接続であり、他 thread の通知は流れない)。
- `finally` でリスナーを解除する。
- 返り値を `{ threadId, turnId, lastAgentMessageText }` に拡張する(`lastAgentMessageText` は捕捉できなければ空文字)。既存の呼び出し元は `threadId`/`turnId` しか読まないため互換。
- `waitForTurnCompletion()` は socket close / abort / `turn/interrupted` でも resolve するため、リスナーで成功状態の `turn/completed` を明示確認する。未確認または失敗 status なら throw し、部分本文を成功通知しない。

## 変更点 3: 新モジュール `turn-completion-notification.mjs`(通知の唯一の出口)

新規ファイル: `private_runner/src/turn-completion-notification.mjs`(1,000 行未満を維持)

### 移動する既存コード

`server-runtime.mjs` から以下を**移動**する(コピーではなく移動。server-runtime 側は import に置き換え):

- `compactLlmCompletionPreview()`(現行 11060 行付近)— export する(`buildApprovalPushBody` が server-runtime 側で使い続けるため)。
- `derivePushDirectoryTitle()`(現行 11073 行付近)— approval PUSH も使うため export する。
- `sendTurnCompletedPush()`(現行 11080 行付近)— モジュール内部関数化(export しない。外部からの入口は `notifyTurnCompleted` のみ)。

`extractCodexAgentMessageText()` は PUSH/APNs の責務ではなく Codex RPC item の解釈なので、`codex-turn-execution.mjs` へ移して export し、実行境界と relay 観測の両方から使う。

### API

```js
export function createTurnCompletionNotifier({
  pushEnabled,        // boolean(PUSH_ENABLED)
  apnsClient,         // null 可
  pushSummarizer,     // null 可
  pushDeviceStore,    // listDevices()/removeDevice() を持つ
  broadcast,          // (payload) => boolean  在アプリWS通知の送信委譲(後述)
  log = console,      // warn を使用
  now = Date.now,     // dedup TTL 用(テスト注入)
}): {
  notifyTurnCompleted({
    threadId,          // 必須。空なら no-op
    turnId,            // 任意。dedup キーの一部
    sessionId,         // 任意。省略時 threadId
    agentMessageText,  // 生の完了テキスト。compact 前でよい
    directory,         // cwd。push タイトル導出用
    origin,            // "relay" | "queued_turn" | "location_schedule" | 将来の値。ログ用
  }): Promise<void>
}
```

### `notifyTurnCompleted` の内部処理(順序も含めて固定)

1. `threadId` を trim。空なら return。
2. `previewText = compactLlmCompletionPreview(agentMessageText)`(既定 180 文字)。空なら return(**失敗 turn・本文なし turn は通知しない**。現行 relay セマンティクスの維持)。
3. **dedup**: キーは `${threadId}|${turnId || "-"}`。`Map<key, timestampMs>` を保持し、登録済みなら return。TTL 6 時間、entry 数上限 1,000(超過時は古い順に削除。呼び出し頻度は低いので毎回線形掃除でよい)。relay 側の `relay.turnCompletedNotificationSent` フラグは**削除**し、この dedup に一本化する。
4. in-app WS 通知: `broadcast({ sessionId, threadId, previewText, completedAt: new Date().toISOString() })` を呼ぶ。戻り値は無視(送信先ゼロでも push は続行)。
5. APNs push: 移動した `sendTurnCompletedPush` 相当を実行(`pushEnabled`/`apnsClient`/`pushSummarizer` が欠ける場合はスキップ、デバイス列挙 → summarize → 送信、410 でデバイス削除、失敗は `log.warn`。現行実装をそのまま踏襲)。
6. 例外はすべて内部で捕捉して `log.warn`。呼び出し元へ throw しない(`void notifyTurnCompleted(...)` で fire-and-forget 可能にする)。

### server-runtime 側の生成

`apnsClient` / `pushSummarizer` / `pushDeviceStore` 生成後(現行 1324 行付近以降)に 1 インスタンス生成する:

```js
const turnCompletionNotifier = createTurnCompletionNotifier({
  pushEnabled: PUSH_ENABLED,
  apnsClient,
  pushSummarizer,
  pushDeviceStore,
  broadcast: (payload) => broadcastRunnerWsTurnCompletedNotification(null, payload),
});
```

`broadcastRunnerWsTurnCompletedNotification` は既に全 `runnerWsActiveClients` へ送る実装(現行 11198 行付近)なので変更不要。第1引数 relay はデバッグログの `relayId` にしか使っていないため null 許容のままでよい。

## 変更点 4: Runner 発実行の共通ヘルパー `runRunnerInitiatedTurn`

`server-runtime.mjs` に追加(場所は `runCodexQueuedTurn` の直前):

```js
async function runRunnerInitiatedTurn({
  clientName,        // 例 "private-runner-location-schedule"
  origin,            // notifier へ渡す
  signal,            // 任意(queued turn の abort 用)
  onTurnStarted,     // 任意(queued turn の turnId 記録用)
  request,           // { inputText, cwd, model, effort, approvalPolicy }
}) {
  const client = createCodexRpcClient({ signal });
  try {
    const result = await executeCodexTurn({ client, clientName, onTurnStarted, ...request });
    void turnCompletionNotifier.notifyTurnCompleted({
      threadId: result.threadId,
      turnId: result.turnId,
      agentMessageText: result.lastAgentMessageText,
      directory: request.cwd,
      origin,
    });
    return result;
  } finally {
    client.close(1000, "turn_done");
  }
}
```

- **成功時のみ**通知する(executeCodexTurn が throw したら通知せず throw を伝播。occurrence の failed 記録や queued turn のエラー処理は従来どおり呼び出し元)。
- 通知は `void`(実行結果の返却をブロックしない)。

### 適用箇所

1. **location schedule**(現行 1303 行付近の `executeTurn` 配線): client 生成〜close を `runRunnerInitiatedTurn({ clientName: "private-runner-location-schedule", origin: "location_schedule", request })` の呼び出しに置き換える。`location-schedule-service.mjs` 側は変更不要(返り値の `threadId`/`turnId` のみ使用しているため互換)。
2. **queued turn**(`runCodexQueuedTurn`、現行 7121 行付近): client 生成〜`executeCodexTurn` 呼び出しを `runRunnerInitiatedTurn({ clientName: 既存値, origin: "queued_turn", signal: abortController.signal, onTurnStarted: turnId 記録処理, request: 既存パラメータ })` に置き換える。既存の `onNotification` での `turn/started` 監視は `onTurnStarted` コールバック(executeCodexTurn が既に持つ)へ移す。

## 変更点 5: relay 観測点を notifier へ接続

`observeCodexRelayCompletionNotification()`(現行 11222 行付近)の `turn/completed` 分岐を次のように変更する:

- `relay.turnCompletedNotificationSent` フラグの参照・設定を削除(dedup は notifier に一本化)。
- `broadcastRunnerWsTurnCompletedNotification(...)` と `sendTurnCompletedPush(...)` の直接呼び出しを削除し、次に置き換える:

```js
void turnCompletionNotifier.notifyTurnCompleted({
  threadId,
  turnId: getCodexTurnStartedId(rpcPayload) || "",   // fallback の threadId 代入はやめ、空で渡す
  sessionId: threadId,
  agentMessageText: relay.lastAgentMessageText,      // compact は notifier 内で行う
  directory: relay.threadCwd,
  origin: "relay",
});
```

- 注意: 現行コードは `turnId` が取れないとき `threadId` を代入しているが、dedup キーの一貫性のため**空文字のまま渡す**(notifier 側で `"-"` に正規化)。同一 thread で turnId 不明の完了が連続するケースは relay の delta 蓄積リセット(`turn/started` で `relay.lastAgentMessageText` クリア、現行実装維持)があるため実害はない。
- `relay.lastAgentMessageText` の蓄積ロジック(delta 連結・item/completed 置き換え)は現状維持。ただし本文抽出は移動後の `extractCodexAgentMessageText` を import して使う。

## 通知セマンティクス(全経路共通・変更なしの確認)

- 通知するのは「完了し、かつ agent 本文が非空」の turn のみ。失敗・中断・本文なしは通知しない。
- PUSH は `PUSH_ENABLED`(APNs 環境変数)無効時はスキップ、in-app WS 通知は常に試行。
- push 本文は `pushSummarizer.summarize(preview)`、タイトルは cwd 末尾ディレクトリ名(なければ「タスク完了」)。カテゴリ `TURN_COMPLETED`、`thread-id` グルーピング。すべて現行踏襲。
- 同一 `(threadId, turnId)` の通知は経路をまたいでも 1 回(新規保証。queued turn と relay の二重観測を dedup が吸収する)。

## 非ゴール

- approval request push(`sendApprovalRequestPush`)の一般化はしない(relay 専用のまま)。schedule 発火 turn が `approvalPolicy: "on-request"` で承認要求を出した場合に応答者がいない問題は本設計の対象外(既知の制約として別途扱う)。
- APNs クライアント・summarizer・device store の変更はしない。
- iOS アプリ側の変更はしない(既存の `TURN_COMPLETED` push と `turn_completed_notification` WS envelope をそのまま受ける)。
- app-server への常駐購読接続の新設はしない。

## テスト(実装 PR に含めること)

新規 `private_runner/tests/turn-completion-notification.test.mjs`(既存テストの流儀に合わせる):

1. `notifyTurnCompleted`: 正常系で `broadcast` と APNs 送信(フェイク)が1回ずつ呼ばれる。
2. 同一 `(threadId, turnId)` の2回目は no-op(broadcast も push も呼ばれない)。
3. `agentMessageText` 空 → no-op。`threadId` 空 → no-op。
4. `pushEnabled=false` → broadcast のみ実行、push はスキップ。
5. push 内部例外(listDevices throw)でも reject しない。
6. dedup TTL / 上限 1,000 の掃除。

既存テストの拡張:

7. `executeCodexTurn`: フェイク client に `addNotificationListener` を実装し、delta 連結・`item/completed` 置き換えの捕捉結果が `lastAgentMessageText` として返ることを検証。リスナー解除も検証。
8. location schedule focused テスト: 発火成功時に notifier が `origin: "location_schedule"`・正しい threadId/turnId/directory で1回呼ばれること。発火失敗時(executeTurn throw)は呼ばれないこと。
9. queued turn テスト: 完了時に notifier が1回呼ばれること。relay 観測と重なるケースで push が1回に抑止されること(dedup)。
10. relay 経路の既存テストが `turnCompletedNotificationSent` 削除後も通ること(必要ならフラグ参照のテストを dedup 検証に書き換え)。

## 受け入れ基準

1. location schedule 発火の完了で、登録済みデバイスに `TURN_COMPLETED` push と in-app WS 通知が届く(APNs 設定済み環境)。
2. 通常チャット(relay)の push 挙動は従来と同一(タイトル・本文・カテゴリ・dedup)。
3. queued turn 完了でも通知が出る。relay と二重に観測されても通知は1回。
4. `sendTurnCompletedPush` の直接呼び出しが `turn-completion-notification.mjs` 内の1箇所のみになる(`grep` で確認)。
5. Runner full tests + location schedule focused tests + Expo full Jest がすべて green。
6. 新規ファイルは 1,000 行未満。既存の責務ファイルからの移動はコピーを残さない。

## 実装メモ(ブレ防止)

- `turnCompletionNotifier` は APNs client / summarizer / device store の生成後に1回だけ生成し、location schedule と queued turn の両方から共有する。
- `runRunnerInitiatedTurn` 内で `client.close` を `finally` で必ず呼ぶ(現行 schedule 配線と同じ)。
- 通知処理を `await` しないこと(turn 実行の返却・occurrence 記録を通知の遅延でブロックしない)。
- 本設計による store スキーマ・API・iOS 側の変更は一切ない。
