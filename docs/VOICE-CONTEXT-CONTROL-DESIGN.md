# 音声長期会話の文脈管理 v1 設計

状態: v1 の実装契約。v1 は **利用者にファイル・コマンド等のツール操作 UI を提供せず、tool state の継続も保証しない音声会話**。Codex 組み込みの read-only tool が動く可能性はある。実モデルへの送信、認証・承認・TTS の統合動作は未実測で、リリース前の確認が必要。コード実装は本書の対象外。

## 2つの方式と v1 の選択

| 名称 | 対象 | 文脈の所有者 |
| --- | --- | --- |
| **既存のセッションIDで管理** | 左ドロワー、Skia の既存セッションカードから開くチャット | 現行の Agent Service／Codex native session。UI・API・保存・継続動線を変えない。 |
| **自前コンテキスト配列** | Skia 下部ツール右の新アイコンから開く音声長期会話 | Runner が正本ログから今回渡すメッセージ配列を選ぶ。アプリは論理会話IDと現在の送信IDだけを保持する。 |

v1 の「自前コンテキスト配列」は、Codex App Server の **新規 ephemeral thread を応答ターンごとに開始**し、選んだメモリーと直近メッセージを `thread/inject_items`、今回の確定発話を `turn/start` で渡す。既存 thread の `thread/resume`、`thread/fork`、`thread/compact/start` をこの方式の履歴置換には使わない。Responses API の直接呼び出しにも切り替えない。`thread/inject_items` は追記であり、既存 thread の古い先頭を自由に置換できないためである。[公式 App Server 文書](https://learn.chatgpt.com/docs/app-server)、[隔離検証](APP-SERVER-CONTEXT-VERIFICATION.md)。

ローカルの `codex-cli 0.156.0` では ephemeral thread の開始・注入、模擬提供先への入力、模擬応答での turn 完了まで確認した。実モデルでの成立は未確認。実装はこの方式に固定し、対象 Runner で ephemeral／注入／権限制約が使えなければ音声モードを利用不可として止める。managed thread や Responses API へ黙って代替しない。

## 入口と識別子

- 新規の物理 endpoint は作らず、既存の認証付き `/runner-ws` の `agent` channel を使う。新しい `voice.open` は Runner にある唯一の音声論理会話を取得し、なければ UUID を発行して `active.json` に同期保存する。**v1 は一 Runner に一つの音声論理会話で固定**し、会話の新規作成・切替・削除 UI は作らない。同じ Runner token の端末は同じ会話を開く。`voice.open` の返値は `logicalConversationId`、固定の `contextMode: "self_context_array"`、直近の送信状態。
- ターン受付は既存と同じ `agent / turn.start`。音声側の payload は `{ backendId: "codex", logicalConversationId, clientOperationId, input: { blocks: [{ type: "text", text }] } }` とし、本文は非空の text block 一つだけとする。外枠の `operationId` と payload の `clientOperationId` は同じ UUID でなければ拒否する。`backendId` は provider であり方式ではない。`sessionRef`、クライアント指定 `cwd`、画像、`model`／`effort`／`policyProfileId` 等の自由指定は受け付けず、モデルと effort は Runner の現行 Codex 既定値を使う。論理IDがある場合だけ Runner の入口で保存済み方式を照合して音声専用サービスへ一度振り分ける。論理IDがない既存の `turn.start` は今の Agent Service にそのまま渡す。現行 `normalizeAgentStartRequest` には論理IDがないので、この分岐は正規化より前に置き、Agent Service／Codex Backend 内へ方式判定を広げない。
- 送信IDはアプリが確定発話ごとに発行する UUID。受理確認を得るまで保持し、通信再送では同じIDと同じ本文を使う。Runner はIDと本文の組を照合し、同一なら現在状態または保存済み結果を返し、本文が異なれば競合エラーにする。別IDのターンは同一論理会話内で同時実行せず `busy` を返す。
- `turn.start` は永続化後に既存と同じ外枠 `{ channel: "agent", op: "turn.accepted", requestId, operationId, streamId, payload }` を返す。音声では外枠の `operationId` と payload の `clientOperationId` を送信IDにし、`streamId`／`payload.runId` も送信IDとする。payload に `logicalConversationId` と `status: "accepted"` を付ける。完了時は `op: "voice.turn.completed"` と `payload: { logicalConversationId, clientOperationId, text }`、失敗時は `op: "voice.turn.failed"` と `payload: { logicalConversationId, clientOperationId, status, code }` を送る。切断後は `voice.status` に論理IDと送信IDを渡し、`requestId` を引き継いだ `voice.status.result` にその送信IDの `status` と完了済みなら `text` を返す。`voice.open` の応答は `voice.open.result`。新 op は `agent.hello` の対応操作にも列挙する。画面は差分テキストを描画しないので音声側の delta 配信は v1 に不要。`voice.open`／`voice.status` は保存済み状態を返すだけで新しい生成を始めない。通常チャットの event 契約は変更しない。

実装箇所の目安: [`server-runtime.mjs`](../private_runner/src/server-runtime.mjs) の認証済み Runner WS 入口で上記の一回の分岐を置き、音声専用の受付・保存・App Server 処理を別ファイルにまとめる。[`agent-transport.mjs`](../private_runner/src/agent/agent-transport.mjs) は対応 op の広告だけ追加し、[`codex-turn-execution.mjs`](../private_runner/src/codex-turn-execution.mjs) の通常チャット処理は変更しない。既存の `createCodexRpcClient` による認証・App Server 接続を再利用する。

## 保存と文脈選択

保存先は `private_runner/logs/voice_context/v1/`。`active.json` に唯一の論理会話IDと方式を保存し、そのIDのサブディレクトリに次を置く。worktree の `private_runner/logs` は main 側を指す共有 symlink なので、[worktree 手順](GIT-WORKTREE.md)どおり同じ main を共有する Runner は一つだけ稼働させる。複数 Runner 同時更新は v1 対象外。

| ファイル | 責務 |
| --- | --- |
| `events.jsonl` | 正本。送信ID、受理した確定発話、状態遷移、完了応答、対応する native thread／turn ID を時系列で追記する。STT 途中結果、TTS 音声、tool／reasoning item は保存しない。 |
| `memory-pending.json` | 要約待ちの完了ペアだけを正本から作る一時ファイル。範囲の開始・終端ペア番号を含み、正本ではない。 |
| `MEMORY.md` | Runner が確定した要約。先頭の機械可読ヘッダーに「要約済み末尾ペア番号」を持ち、本文とヘッダーを一つの原子的置換で更新する。 |

`events.jsonl` は一行一 event とし、全行に `seq`（連番）、`at`（時刻）、`clientOperationId`、`type` を置く。最小形は `accepted` に `text`、`dispatching`、`native_started` に `threadId`／`turnId`、`completed` に `pairSeq`／`text`、`preflight_failed`／`failed`／`interrupted` に `code`。`pairSeq` は完了した user／assistant ペアにだけ 1 から連番で付く。`MEMORY.md` の初期値は `<!-- voice-context:v1 summarizedThroughPair=0 -->` と空本文で、cursor は event の `seq` ではなく `pairSeq` を指す。`memory-pending.json` は `{ "fromPairSeq": 1, "throughPairSeq": 3, "pairs": [...] }` の形とし、範囲と中身を正本から再検証する。`active.json` は `{ "logicalConversationId": "<UUID>", "contextMode": "self_context_array" }`。これら以外の索引ファイルを正本にしない。

発話は `turn.start` 受付時に `accepted` event を追記・同期してから確認応答する。完了応答は対応 native thread／turn の `item/completed` で最終本文を集め、成功した `turn/completed` と空でない本文を確認した後に同じ送信IDの `completed` event として追記・同期し、それからアプリへ通知する。生成途中の delta は正本にも TTS にも使わず、応答本文を途中で切って完了扱いにしない。追記は一会話内で直列化し、再起動時は正本を読み直す。書きかけの末尾行だけは受理済みと見なさず、原本を保全して復旧する。破損した確定行、`MEMORY.md` の不正なヘッダー、ディスク満杯は黙って飛ばさず受付を停止する。

文脈に入れる単位は **完了した user／assistant のペア**。直近最大 **5ペア＝10履歴メッセージ** を v1 の上限とする（従来の「10件」という説明例をここで具体化）。「固定の音声会話指示 + `MEMORY.md` 本文 + 選択ペア + 今回の発話」の UTF-8 合計には **32 KiB** の単一安全上限を置く。件数または総量を超えると、`MEMORY.md` の cursor の次から古い完了ペアを順に直近配列外へ移す。最低ペア数は設けない。固定指示と今回発話だけで総量を超える場合は受理前に拒否し、要約後も総量を満たせない場合は native turn を開始せず失敗にする。応答や要約を上限に合わせて黙って切らない。これは token 上限の保証ではないため、実モデルの context-length エラーも失敗として扱う。

直近配列外になった未要約の連続ペアだけを `memory-pending.json` に原子的に書く。別の要約エージェントはこのファイルの内容と旧 `MEMORY.md` を受け取り、事実・好み・未解決事項を統合した **本文だけ**を返す。要約エージェントに保存ファイルを書かせず、Runner が対象範囲とサイズを検証して `MEMORY.md` を原子的に更新する唯一の書き手になる。要約入力が長すぎる場合も範囲を黙って欠落させず失敗にする。成功後だけ一時ファイルを片付ける。失敗・再起動時は正本と cursor を基準に同じ範囲を再生成できる。要約は v1 では次の応答ターン前に直列実行し、会話と並列には走らせない。

毎回、空の ephemeral thread に要約本文があれば「以前の会話の要約」と明示した assistant message、続いて残したペアを user／assistant message として順に注入する。今回の発話は注入せず `turn/start.input` に一度だけ置く。要約済みペア、直近ペア、今回の発話は重複しない。要約エージェントも応答エージェントとは別の ephemeral thread で実行する。tool／reasoning の完全再生は v1 で保証しない。

## ターンの失敗・再送

1. Runner は同一会話の操作を直列化し、送信IDで既存の `accepted`／terminal event を検索する。同IDの再送は生成せず保存済み状態を返す。
2. 発話受理後、必要なら要約を確定する。要約に失敗した場合は `preflight_failed` を記録し、今回の native thread は作らない。その発話は未完了として次回文脈から除く。次の発話は新しい送信IDで受け付け、要約を再試行する。
3. native 要求の前に `dispatching` を同期して記録する。新規 ephemeral `thread/start` → `thread/inject_items` → `turn/start` の順に実行し、返った native ID を正本に記録する。成功通知と本文の保存後だけ `completed` とする。明示的な中断・失敗は `interrupted`／`failed` として記録する。
4. アプリの WS だけが切れた場合、Runner はターンを続けて結果を保存する。再接続後の `voice.status` で `accepted`／`running`／`completed`／失敗状態を返し、同じ送信IDでは再生成しない。Runner 再起動時に `accepted` の後に `dispatching` がなければ、native 要求前と確定できるため `preflight_failed`（`code: "runner_restarted_before_dispatch"`）を追記する。`dispatching` 以降で terminal event がなければ、送信されたか不明で ephemeral native thread を照合・復元できないため `unknown` として扱い、自動再実行しない。後者の判定は既存 Agent Service の `operation_status_unknown` と同じ保守的な考え方だが、音声専用の保存状態で表す。新しい送信IDの発話は許可するが、未完了発話・未確認応答は直近ペアへ入れない。画面は `unknown` を「前の返答を確認できません」と示す。同IDは常に保存済みの失敗状態または `unknown` を返す。

正本ログには送信IDごとの event を一度だけ追記し、端末の TTS 成否は応答確定と分ける。TTS 失敗・画面離脱でも `completed` 応答は消さない。端末が結果を受け取る前に落ちた場合は `voice.status` で完了本文を取り直せるが、再起動後に自動読み上げはしない。

## 音声画面

[`SkiaMiniBoardScreen.tsx`](../expo/src/features/app/screens/SkiaMiniBoardScreen.tsx) の既存ツール群の右に音声アイコンを置き、新しい画面へ遷移する。既存のカード起動・左ドロワーは変えない。画面にはマイク操作と既存の [`StreamingSttFooter.tsx`](../expo/src/features/app/components/StreamingSttFooter.tsx)、最小限の処理中／エラー表示、必要時の再生ボタンだけを置く。会話本文リスト・テキスト入力・作業ディレクトリ選択は表示しない。

新画面も既存の [`useStreamingStt.ts`](../expo/src/features/stt/useStreamingStt.ts) を使い、確定発話だけを送る。`sendTranscript` の `onAccepted` は Runner が `accepted` を永続化した返答を受けた時だけ呼ぶ。`replyLoading` は受理から応答確定または失敗まで true。完了本文は [`AppRoot.tsx`](../expo/src/features/app/AppRoot.tsx) が既に持つ `synthesizeSpeechStream(text, { messageId: clientOperationId })` へ渡す。実際の合成入口は [`useSynthesizeSpeechStreamController.ts`](../expo/src/features/app/hooks/useSynthesizeSpeechStreamController.ts) であり、新しい TTS 経路を作らない。`panelId`／通常チャットの `sessionId` は渡さず、論理会話IDを native session ID と偽装しない。TTS 呼出し直前から開始待ちを含めて、既存の `isTtsPlaybackActive = ttsPlaying || ttsLoading || ttsQueueProcessing` と合わせた状態を hook の `ttsPlaybackActive` に渡し、再生終了まで録音を止める。再生終了後に hook の既存サイクルで録音を再開する。TTS が開始できない／失敗した場合も応答を保持し、音声の再生だけを再試行できる。画面離脱時は録音・再生を止め、Runner の生成は継続して正本へ保存する。既存チャットの自動読み上げ設定とは独立して、この画面で完了した応答は常に読み上げる。既存チャットの TTS 波形・状態への誤投影がなく音声画面で再生終了を検出できることを統合テストする。

## 権限とリリース条件

クライアントからファイルパスや `cwd` を受け取らない。Runner は各 native turn 用に OS 一時領域へ空の専用 `cwd`（所有者のみアクセス）を作り、`realpath` で確定して App Server に渡し、終了時に片付ける。音声経路は Agent Service の新規セッション受付と workspace admission を通らないため、この内部 `cwd` を対象 Runner の App Server が受け入れるか統合試験で確認する。ログは専用ディレクトリを 0700、ファイルを 0600 とし、会話本文・token を通常の診断ログへ出さない。App Server の `thread/start` は `ephemeral: true`、`approvalPolicy: "never"`、`sandbox: "read-only"` とし、既存の [`codex-turn-execution.mjs`](../private_runner/src/codex-turn-execution.mjs) の calendar 経路と同様に `config.web_search: "disabled"`、apps 無効、`dynamicTools` 非指定、作成後の `mcpServerStatus/list(threadId)` が0件であることを要求する。`turn/start.sandboxPolicy` は `{ type: "readOnly", networkAccess: false }` とする（いずれも `codex-cli 0.156.0` 生成スキーマ上の値）。これは **書き込みと通信を制限するが、組み込み command／ファイル読取の非実行や資格情報の非読取は保証しない**。固定指示は会話応答を求め、tool／承認イベントが出たら Runner は中断・失敗とするが、検出前に動いた tool は取り消せない。v1 は既存 Codex の信頼境界で利用する設計であり、厳格なツール非実行・読取隔離を要件にするなら `permissionProfile` 等を別途検証し、この設計の実装を止めて改訂する。実ユーザーの作業リポジトリを暗黙の `cwd` にしない。

実装順は (1) 保存・cursor・選択・再送の純粋な Runner ロジック、(2) 入口の一回の dispatch と App Server 実行、(3) 音声画面と STT／TTS 接続、(4) 障害・回帰テスト。受入テストは、5ペア／32 KiB 境界と要約失敗、要約済み範囲の非重複、同ID再送・異本文競合、受理直後／dispatch後／完了直後の再起動、WS 切断、TTS 失敗、音声画面に本文リストがないこと、既存チャットの動線不変を含める。隔離した実 App Server と localhost 模擬モデル提供先で、次の上流 `input` の**会話由来 item** に `MEMORY.md` と選択ペア・今回発話だけが順に入り、古い識別子がないことを検査する。system／developer 指示など別の入力源まで消えるとは主張しない。

実モデルでの認証、ephemeral thread、sandbox、stream 完了、TTS、要約品質は未検証。これらのテストは認証・課金に触れるため、ユーザー承認後に実施する。失敗した場合は代替方式へ無断で切り替えず、本書と実装を再評価する。v1 は利用者向けツール操作・tool state 継続を提供しないが、Codex 組み込み read-only tool の動作は許容する。利用者が音声会話でファイル操作・コマンド実行を必要とする、または tool 非実行保証を必要とする場合は、範囲と安全境界を改訂する。別エージェントの要約を会話と並列にする機能、複数論理会話、tool／reasoning 完全再生は v1 後に分ける。
