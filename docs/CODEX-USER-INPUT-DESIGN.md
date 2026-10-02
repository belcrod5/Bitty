# Codex 質問・選択肢への回答対応 計画書

## 文書情報

- 初回調査: 2026-10-01
- 更新: 2026-10-02
- 状態: 通常チャット・オーケストレータともユーザーの実機確認済み。PR前のレビューと最終検証済み
- 確認したローカルCodex: `codex-cli 0.159.2`
- 対象: 通常Agent経路と、開いているオーケストレータの質問表示・回答・60秒の期限処理

## 現時点の方針

質問は必ず回答・復元する重要な要求として扱わない。現在開いているチャットで回答できれば回答し、見送った質問を追いかける機能は作らない。プッシュ通知も初期範囲から外す。

質問の期限管理とCodexへの応答・辞退処理はPrivate Runnerに集約する。クライアントは表示中のチャットとの照合、質問と残り時間の表示、回答・辞退の意思の送信を担当する。

通常Agent経路では、既存の要求保持・action通信・解除処理を利用できる。新しい通信路、永続ストア、汎用タイマーサービスは作らない。

無回答は`{ "answers": {} }`で返す。使用中と同じCodex 0.159.2の公式実装・テストで、空回答による質問待ち解除を確認した。ターン全体の中断は不要。モデルがその後に作業を続けるか終了するかの判断までは固定しない。

### 通常モードで質問を有効にする前提

2026-10-02の実機テスト後、Runnerログに`request_user_input is unavailable in Default mode`を確認した。モデルはツールを呼び出そうとしていたが、Codex内で拒否され、Runnerへの質問要求は発生していなかった。最初の実装では、この有効化の前提を確認できていなかった。

ローカルの`codex features list`で、`default_mode_request_user_input`が存在し、初期値がfalseであることを確認した。通常チャットの`thread/start`と`thread/resume`の`config`に`"features.default_mode_request_user_input": true`を渡す。Planモードへ変更せず、グローバル設定・アプリの設定項目も増やさない。専用のカレンダーschedule用configは既存のままとする。

このflagはCodex 0.159.2ではunder developmentのため、Codex更新時は動作を再確認する。ツールの有効化はモデルが毎回質問する保証ではない。

## 想定する挙動

1. Runnerが`item/tool/requestUserInput`を受信する。
2. 受信時刻を`startedAtMs`として記録し、質問とともにクライアントへ送る。Unix時刻の単位はミリ秒。これはRunnerでの要求受信時刻であり、LLM内部の生成開始時刻ではない。
3. Runnerは受信から60秒で期限切れにする。クライアントの接続・表示・回答待ち開始を待たない。
4. クライアントは現在開いているCodexチャットのポップアップに対応する質問だけ表示する。残り時間は`startedAtMs + 60_000`から算出し、受信時や再接続時に60秒へ戻さない。
5. 期限内に回答すれば、Runnerが元の要求へのtool responseとしてCodexへ返す。
6. 「見送る」・期限切れ時はRunnerが空回答を返し、既存の`action.resolved`でUIを解除する。

端末のカウントダウンは表示用とし、時刻ずれやアプリの休止があってもRunnerの期限を正とする。クライアントからタイムアウト通知を送る仕組みは作らない。期限後に届いた回答は受け付けない。

### 別チャットを開いている場合

質問を表示せず、Runnerの60秒期限に任せる。あとから表示するための専用キューや通知は作らない。

チャットを閉じた場合やバックグラウンドへ移った場合も、フォームだけ閉じてRunnerの期限に任せる。表示対象は通常チャットのポップアップと、開いているオーケストレータ。ボードのプレビューでは質問を表示しない。同時に複数の質問要求が届いても、表示中の要求だけを扱い、後続要求のキューは作らない。

どのチャットを開いているかはクライアントにしか分からないため、この表示判定はクライアントに残す。Runnerへ画面選択の状態を常時同期する仕組みは追加しない。

別チャットの質問を即座に辞退する必要が出た場合は、既存action通信で辞退の意思だけ送る。Codex向けの応答変換はRunnerで行う。即時辞退は初期必須にしない。

## コード調査に基づく変更箇所

### RunnerのCodex Backend

[codex-turn-execution.mjs](../private_runner/src/codex-turn-execution.mjs)には、Codexのserver requestを直接受け取るhandlerと、未回答要求を保持する`actionById`がある。

既存のdynamic tool・承認処理に`user_input`分岐を追加した。質問には承認用の`{ decision: "decline" }`を返さず、既存の要求保持に開始時刻・元のCodex request・タイマーを持たせる。

回答・辞退・期限切れ・Codexによる要求解除・ターン終了の各経路で、質問を一度だけ終了させてタイマーを解除する。解除通知と回答が競合しても、`action.resolved`を二重発行しない。新たな質問ストアへ状態を複製しない。

質問の表示前に、既存の`codexTurnEventMatches`で対象thread・turnを照合する。他のthread・turnの質問は空回答で解決し、クライアントへ表示要求を送らない。`turn/start`の応答より先に来た質問も、turn IDが確定してから同じ照合を通す。

[codex-app-server-client.mjs](../private_runner/src/codex-app-server-client.mjs)は、登録handlerの結果を元のrequest IDへのJSON-RPC応答として送る。Runnerが直接応答できるため、期限処理にクライアント経由の往復は必要ない。

### 既存action通信と解除

[agent-service.mjs](../private_runner/src/agent/agent-service.mjs)の`action.requested` / `action.respond` / `action.resolved`とactiveActionsを利用する。通常回答には既存の`decision: "result"`とJSONの`result`を利用できる。

`action.resolved`で未回答一覧から消えるため、質問専用の解除endpointは不要。「見送る」も`decision: "result"`と空回答を既存action通信に載せる。質問にはdynamic tool用の実行claimを要求しない。

共有処理には「dynamic tool以外は承認」と扱う条件がある。質問を承認・自動承認・承認通知へ混ぜないよう、必要な条件だけ修正する。承認の期限や挙動は変更しない。

### クライアント

[agent/client.ts](../expo/src/features/agent/client.ts)で質問actionを承認と区別する。小さな共通フォームで質問文・選択肢・必要な自由入力を表示する。複数質問、選択肢なし、`isOther`、`isSecret`も同じフォームで扱い、秘密の回答をログへ載せない。

回答待ちの表示は質問actionを基準とし、`waitingOnUserInput`専用の状態管理を追加しない。回答待ちでイベント処理自体を止めず、非ブロッキング質問でもCodexの進行を妨げない。

質問全体の期限は要求受信から60秒で固定し、質問ごとの画面移動で延長しない。

### オーケストレータ

通常チャットと通信経路が異なるため、通常Agent Backendへの統合は行わず、既存のオーケストレータ接続で受け渡す。

- [voice-context-service.mjs](../private_runner/src/voice-context-service.mjs)の会話用ephemeral threadにもDefaultモードの質問flagを設定する。質問受信時刻を記録し、現在のturnの要求だけを受け付ける。要約処理は対象外。
- 既存の承認bridgeを[voice-request-bridge.mjs](../private_runner/src/voice-request-bridge.mjs)へ改名し、同じ待ち要求の管理に質問を追加する。質問だけ60秒で空回答へ解決する。回答ID・operation ID・期限を検証し、回答・見送り・Codex側解除・ターン終了・接続切れで一度だけ片付ける。
- 同じRunner WebSocket上で`voice.userInput.request`・`voice.userInput.respond`・`voice.userInput.resolved`を使用する。新しい接続・永続ストアは作らない。
- [useVoiceUserInput.ts](../expo/src/features/app/hooks/useVoiceUserInput.ts)が通信を受け、既存の`useUserInputRequestController`と`UserInputModal`を共用する。ephemeral thread IDとは別に、表示中のorchestrator IDで照合する。
- オーケストレータ切り替え・画面を閉じる・管理画面を開く・バックグラウンドでは質問フォームを閉じ、あとから追いかけない。接続が切れた場合はRunnerが即座に空回答にする。再接続後の質問再送・表示保証は追加しない。
- scheduleから起動したオーケストレータには質問表示用hookを渡さず、質問は即座に空回答とする。既存のschedule承認は維持する。

大きな`server-runtime.mjs`には既存接続への配線だけを足し、期限・回答検証・要求終了は小さな既存bridgeに集約する。無関係なファイル分割や汎用通信層は追加しない。

通常チャットとオーケストレータの回答検証は、[codex-user-input.mjs](../private_runner/src/codex-user-input.mjs)の同じ関数を使う。質問ID・文字列配列・空回答の契約を一か所に置き、通信経路ごとの検証の食い違いを避ける。待ち要求はそれぞれ既存の管理を使い、新しい共通ストアや通信frameworkは追加しない。

## 再接続・旧互換経路の扱い

既存activeActionsが再接続で届いた場合も、元の期限と現在表示中のチャットに従う。期限切れ・回答済み・解除済みの質問を復活させない。未回答質問の再表示を保証する専用機構は作らない。

Runner／app-serverの再起動後に質問を復元する永続化は行わない。既存の復旧方針に従う。

raw互換経路の回答UI・質問の追跡・再送制御は初期範囲から外す。[server-runtime.mjs](../private_runner/src/server-runtime.mjs)のRunner側relayで質問を識別して即座に空回答を返す。クライアントへ未対応質問を転送・保存しないため、クライアントの切断中も質問待ちを残さない。

## Codexの仕様と無回答の根拠

`waitingOnUserInput`は入力待ちを示すthreadのflag、`item/tool/requestUserInput`は質問を渡すserver request。質問内容の正本はrequest payloadとする。

確認した生成スキーマでは、質問要求に`threadId`、`turnId`、`itemId`、`questions`、`isBlocking`がある。回答は質問IDごとの文字列配列で、承認用の`allow` / `deny` / `decline`を質問に適用できない。

```json
{
  "answers": {
    "question_id": { "answers": ["選んだ回答"] }
  }
}
```

`autoResolutionMs`は同バージョンの生成スキーマで非推奨。公式資料はクライアント側で期限後に自動解決できることを説明しているが、Codex自体が必ず質問を流すことは保証していない。今回の60秒はBittyの方針としてRunnerで管理する。

公式資料: [Codex App Server — tool/requestUserInput](https://learn.chatgpt.com/docs/app-server#toolrequestuserinput)。回答やターン終了・中断による解除時に`serverRequest/resolved`が通知される。

2026-10-02のサブエージェント調査で、同じ公式タグ`rust-v0.159.2`の一次資料を確認した。

- TUIはタイムアウト時に空の回答マップを送り、`auto_resolution_expiry_emits_empty_answer`で確認している。[公式テスト](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/tui/src/bottom_pane/request_user_input/mod.rs#L1934-L1966)
- app-server/coreは空回答を通常のツール成功結果としてモデルへ返す。[公式handler](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/tools/handlers/request_user_input.rs#L87-L151)
- Planモードのブロッキング質問にも空回答を返して正常終了するテストがある。[公式テスト](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/tools/handlers/request_user_input_tests.rs#L222-L295)

Codex app-server自体にBittyの60秒期限を任せず、Runnerが計時して空回答を返す。未回答時に先頭の選択肢を勝手に選ぶ動作は作らない。

## 実装順序と検証

Codex Backendの質問保持・60秒期限・一度だけの終了、チャットポップアップのフォームとカウントダウン、raw経路の即時空回答を実装した。

フォームとその表示制御は独立した小さなcomponent/hookに置き、既存の大きなAppRootには接続と表示だけを追加した。通信・期限の汎用層、設定項目、永続化、プッシュ通知は追加していない。

実機確認は、Runnerの再起動と更新したクライアントの再読み込み後に行う。

1. チャットポップアップ内で選択肢のある質問を発生させ、回答と「見送る」を確認する。
2. 質問を60秒放置し、フォームが閉じて質問待ちが解除されることを確認する。
3. 別チャットを開いている場合・ポップアップを閉じた場合・アプリをバックグラウンドにした場合に、表示を追いかけず期限で解除されることを確認する。
4. 質問から60秒以内の再接続で、元の期限を維持することを確認する。

## 検証状況

2026-10-01の調査では、公式資料・Codex 0.159.2の生成スキーマ・関連コードを確認し、以下の既存テスト44件が成功した。

```sh
node --test private_runner/tests/codex-relay-approval-replay.test.mjs private_runner/tests/codex-app-server-client.test.mjs private_runner/tests/codex-turn-execution.test.mjs
```

2026-10-02の実装後、自動テストで回答・空回答・ブロッキング／非ブロッキングの60秒期限・クライアント不在・期限後の回答拒否・Codex側の解除・ターン終了のタイマー解除・再接続時の元期限・別チャットの無視・複数質問と秘密入力・rawの文字列／数値request IDを確認した。既存の承認・dynamic tool・relay・reply/observerの関連テストも成功した。

- Runner関連6ファイルのテスト: 121件成功
- クライアント関連7ファイル: 113件成功
- `npm run typecheck`、`npm run typecheck:macos`: 成功
- `git diff --check`: 成功

通常モードの有効化後、Runner関連121件を再実行して成功した。実際のCodex 0.159.2 app-serverと本実装のCodex Backendを接続し、質問要求の発行、新規チャットでの回答、再開チャットでの空回答による見送り、実時間60秒後の空回答とターン完了も確認した。60秒放置の計測結果は約60.1秒。モデル部分はローカルHTTPの模擬Responses APIで質問ツール呼び出しを返し、OpenAI APIやユーザーの認証情報は使用していない。

疎通実験用スクリプト: `/private/tmp/bitty-question-native-check.mjs`。一時的なCodex homeとapp-serverを起動して終了後に片付けるため、稼働中のRunnerやグローバル設定は変更しない。

通常チャットとオーケストレータの動作はユーザーの実機テストで確認済み（2026-10-02:「動作検証しました。問題なさそうです」）。こちらでは稼働中のRunner再起動・アプリビルドは行っていない。

オーケストレータ対応後の確認:

- Runner関連6ファイル: 199件成功。追加した中断時の質問解除テスト1件も成功（その関連4件を再確認）。
- クライアント関連9ファイル: 160件成功。共通フォームをオーケストレータ画面で表示し、選択して回答するテストを含む。
- `npm run typecheck`、`npm run typecheck:macos`、`git diff --check`: 成功。
- 実際のCodex 0.159.2 app-serverと`voice-context-service`・`voice-request-bridge`を接続し、回答・見送り・実時間60秒後の空回答とターン完了を確認。期限切れの計測は約60.13秒。モデルはローカルの模擬Responses APIで、OpenAI APIへの送信なし。

オーケストレータ疎通実験用スクリプト: `/private/tmp/bitty-orchestrator-native-check.mjs`。通常チャットの実験と同様、一時的なCodex homeを使い、稼働中のRunnerには接続しない。

## PR前の根本原因・簡潔さのレビュー

根本原因はRunnerが質問のserver requestを入力要求として処理せず、承認用の応答では質問を正しく解決できなかったこと。またDefaultモードでは質問ツール自体が初期設定で無効だったこと。質問受信・回答・期限・解除をRunnerの既存の要求管理に追加し、thread設定でツールを有効にすることで対応した。UI側でターンを止めたり、再試行したりして補う設計にはしていない。

レビューで通常チャットにもthread・turnの照合を追加し、回答検証の重複を削除した。共有フォーム・共有表示制御・共通の回答契約を使い、既存の二つの通信経路を無理に統合する新しい層は作らない。通知・永続化・質問キュー・設定項目・専用タイマーサービスも追加していない。

最終検証（2026-10-02）: Runner関連9ファイル268件、クライアント関連9ファイル160件成功。対象外のthread・turnの質問を表示せず解決する追加テストを含む。`npm run typecheck`・`npm run typecheck:macos`・`git diff --check`も成功。
