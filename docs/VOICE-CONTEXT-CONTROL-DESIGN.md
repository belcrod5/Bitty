# 音声長期会話の文脈管理 v1 設計

状態: 実装契約（2026-09-29 更新）。音声応答は通常チャットと同じ Codex の MCP／apps 設定を継承し、コマンド・ファイル変更の承認要求を既存の UI に渡す。応答ごとに新規 ephemeral thread を作るため、**tool／reasoning item と承認状態のターン間継続は保証しない**。長期記憶は応答用 cwd の `voice-memory/` に有限保存し、応答へ毎回注入しない。

生成途中の文字を使う TTS への変更は [Skia 音声会話の逐次 TTS 設計](VOICE-STREAMING-TTS-DESIGN.md) に記録し、実装は PR #147 に含まれる。本書の「delta を TTS に使わない」という記述は v1 の実装時点の仕様を示す。

## 2つの方式と v1 の選択

| 名称 | 対象 | 文脈の所有者 |
| --- | --- | --- |
| **既存のセッションIDで管理** | 左ドロワー、Skia の既存セッションカードから開くチャット | 現行の Agent Service／Codex native session。UI・API・保存・継続動線を変えない。 |
| **自前コンテキスト配列** | Skia 下部ツール右の新アイコンから開く音声長期会話 | Runner が応答用 cwd に有限の原文と項目別メモリーを保存する。アプリは論理会話IDと現在の送信IDだけを保持する。 |

「自前コンテキスト配列」は、Codex App Server の **新規 ephemeral thread を応答ターンごとに開始**し、最新10完了ペアを `thread/inject_items` で順序通り注入してから、今回の確定発話だけを `turn/start` で渡す。項目別 topic は応答用 cwd の `voice-memory/` に保存し、必要時にモデルが読む。既存 thread の `thread/resume`、`thread/fork`、`thread/compact/start` は使わず、Responses API の直接呼び出しにも切り替えない。[公式 App Server 文書](https://learn.chatgpt.com/docs/app-server)、[隔離検証](APP-SERVER-CONTEXT-VERIFICATION.md)。

ローカルの隔離 App Server と模擬モデルでは、ephemeral thread の開始、最新10完了ペアと今回発話の順序、cwd のメモリーファイル、topic 更新まで確認した。対象 Runner で ephemeral／権限制約が使えなければ音声モードを利用不可として止め、managed thread や Responses API へ黙って代替しない。

## 入口と識別子

- 新規の物理 endpoint は作らず、既存の認証付き `/runner-ws` の `agent` channel を使う。新しい `voice.open` は Runner にある唯一の音声論理会話を取得し、なければ UUID を発行して `active.json` に同期保存する。**v1 は一 Runner に一つの音声論理会話で固定**し、会話の新規作成・切替・削除 UI は作らない。同じ Runner token の端末は同じ会話を開く。`voice.open` の返値は `logicalConversationId`、固定の `contextMode: "self_context_array"`、直近の送信状態。
- ターン受付は既存と同じ `agent / turn.start`。音声側の payload は `{ backendId: "codex", logicalConversationId, clientOperationId, input: { blocks: [{ type: "text", text }] } }` とし、本文は非空の text block 一つだけとする。外枠の `operationId` と payload の `clientOperationId` は同じ UUID でなければ拒否する。`backendId` は provider であり方式ではない。`sessionRef`、クライアント指定 `cwd`、画像、`model`／`effort`／`policyProfileId` 等の自由指定は受け付けない。モデルとエフォートは Runner の保存済み音声設定から選び、初期値は `gpt-6-luna`／`low`。STT の `chirp_3` は変更しない。論理IDがある場合だけ Runner の入口で保存済み方式を照合して音声専用サービスへ一度振り分ける。論理IDがない既存の `turn.start` は今の Agent Service にそのまま渡す。現行 `normalizeAgentStartRequest` には論理IDがないので、この分岐は正規化より前に置き、Agent Service／Codex Backend 内へ方式判定を広げない。
- 送信IDはアプリが確定発話ごとに発行する UUID。受理確認を得るまで保持し、通信再送では同じIDと同じ本文を使う。Runner はIDと本文の組を照合し、同一なら現在状態または保存済み結果を返し、本文が異なれば競合エラーにする。別IDのターンは同一論理会話内で同時実行せず `busy` を返す。
- `turn.start` は永続化後に既存と同じ外枠 `{ channel: "agent", op: "turn.accepted", requestId, operationId, streamId, payload }` を返す。音声では外枠の `operationId` と payload の `clientOperationId` を送信IDにし、`streamId`／`payload.runId` も送信IDとする。payload に `logicalConversationId` と保存済み `status`（初回は `accepted`、同ID再送では terminal も可）、完了済みなら `text` を付ける。完了時は `op: "voice.turn.completed"` と `payload: { logicalConversationId, clientOperationId, text }`、失敗時は `op: "voice.turn.failed"` と `payload: { logicalConversationId, clientOperationId, status, code }` を送る。切断後は `voice.status` に論理IDと送信IDを渡し、`requestId` を引き継いだ `voice.status.result` にその送信IDの `status` と完了済みなら `text` を返す。送信ID未発見は `op: "error"`／`code: "not_found"` とし、この場合だけ同ID・同本文を再送する。`voice.open` の応答は `voice.open.result`。新 op は `agent.hello` の対応操作にも列挙する。画面は差分テキストを描画しないので音声側の delta 配信は v1 に不要。`voice.open`／`voice.status` は保存済み状態を返すだけで新しい生成を始めない。通常チャットの event 契約は変更しない。

`voice.open.result`、`voice.status.result`、`turn.accepted`、`voice.turn.completed/failed` の payload には `estimatedContextUsagePercent`、`unsummarizedMessageCount`、`memoryCharacterCount` を載せる。算定と表示の境界は後述する。

## 設定とクリア

設定画面は認証済み Runner WS の `voice.settings` で現在の `model`／`effort` と Codex App Server の動的モデル一覧を取得する。`voice.settings.update` はモデルとエフォートを一緒に受け、Runner が最新の一覧と対応エフォートを検証して `active.json` に原子的に保存する。応答・curatorの両方にその設定を使う。実行中の音声ターンがある間は更新を拒否する。通常チャットのモデル設定とは独立する。

`voice.settings.result` は `storedMessageCount` と `memoryCharacterCount` を返す。前者は正本に保存された受理済み発話数と完了応答数の和（失敗ターンの発話も含む）で、`unsummarizedMessageCount` とは別である。各クリア結果も両値を返し、設定画面は成功応答で表示を更新する。

`voice.memory.clear` は項目別メモリーを空にし、保持中の raw ペアから再処理できる cursor へ戻す。`voice.messages.clear` は項目別メモリーを保ち、旧出典を旧会話IDで名前空間化してから、空の正本ログと cursor 0 を持つ新しい論理会話IDへ切り替える。旧ログと旧 raw は削除し、切断中の端末による旧IDの再送は拒否する。応答用の作業領域は保持する。どちらのクリアも実行中ターンを拒否し、進行中の更新を中止する。

モデル一覧に文脈窓の値はないため、`estimatedContextUsagePercent` は初期モデル以外では `null` と表示する。800,000 bytes の入力境界はどのモデルでも token 上限を保証しない。実モデルが文脈超過を返した場合はターン失敗として扱う。

実装箇所の目安: [`server-runtime.mjs`](../private_runner/src/server-runtime.mjs) の認証済み Runner WS 入口で上記の一回の分岐を置き、音声専用の受付・保存・App Server 処理を別ファイルにまとめる。[`agent-transport.mjs`](../private_runner/src/agent/agent-transport.mjs) は対応 op の広告だけ追加し、[`codex-turn-execution.mjs`](../private_runner/src/codex-turn-execution.mjs) の通常チャット処理は変更しない。既存の `createCodexRpcClient` による認証・App Server 接続を再利用する。

## 保存と文脈選択

保存先は `private_runner/logs/voice_context/v1/`。`active.json` に唯一の論理会話IDと方式を保存し、そのIDのサブディレクトリに次を置く。worktree の `private_runner/logs` は main 側を指す共有 symlink なので、[worktree 手順](GIT-WORKTREE.md)どおり同じ main を共有する Runner は一つだけ稼働させる。複数 Runner 同時更新は v1 対象外。

| ファイル | 責務 |
| --- | --- |
| `events.jsonl` | 正本。送信ID、受理した確定発話、状態遷移、完了応答、対応する native thread／turn ID を時系列で追記する。STT 途中結果、TTS 音声、tool／reasoning item は保存しない。 |
| `memory-pending.json` | 項目更新待ちの処理対象ペアと既存topicを持つ一時ファイル。正本ではない。 |
| `workspaces/<ID>/voice-memory/index.md` | 有効なtopic世代、`recent.json`、有限rawへの入口。 |
| `voice-memory/generations/<世代>/` | `index.md`、`topics/*.md`、cursor・digestを持つstate。現行と直前の最大2世代だけ保持する。 |
| `voice-memory/raw/<会話ID>/*.jsonl` | 10ペア単位の原文segment。通常30ペア、更新失敗中は最大40ペアまで保持する。 |
| `voice-memory/recent.json` | 応答注入と同じ最新10完了ペアを、必要時の参照用に保存する。 |

`events.jsonl` は一行一 event とし、全行に `seq`（連番）、`at`（時刻）、`clientOperationId`、`type` を置く。`pairSeq` は完了した user／assistant ペアにだけ1から連番で付く。`memory-pending.json` は処理範囲、対象ペア、既存topicを持ち、確定時に同じ範囲のrawと再照合する。`active.json` は論理会話ID、方式、workspace初期化状態を持ち、モデル設定やクリア復旧用IDを必要時だけ加える。旧 `MEMORY.md` は読み込まず、現行 `voice-memory` を安全に開いた後に削除する。

発話は `turn.start` 受付時に `accepted` event を追記・同期してから確認応答する。完了応答は対応 native thread／turn の `item/completed` で最終本文を集め、成功した `turn/completed` と空でない本文を確認した後に同じ送信IDの `completed` event として追記・同期し、それからアプリへ通知する。生成途中の delta は正本にも TTS にも使わず、応答本文を途中で切って完了扱いにしない。追記は一会話内で直列化し、再起動時は正本を読み直す。書きかけの末尾行だけは受理済みと見なさず、原本を保全して復旧する。破損した確定行やディスク満杯は黙って飛ばさず受付を停止する。

応答への会話由来入力は最新10完了ペア（最大20メッセージ）と今回の確定発話とし、topicは毎回注入しない。完了ペアは `completed` event を同期した後、rawへ同期し、その成功後だけ100イベント運用ログを剪定できる。固定指示、最新10ペア、今回発話の UTF-8 合計が **800,000 bytes** を超えたら `voice_context_too_large` で拒否する。この境界は実モデルのtoken上限を保証しない。

未処理ペアが10件を超えたら、古い超過分と既存topicを `memory-pending.json` に原子的に書き、別の ephemeral thread で非同期更新する。未処理tailは渡さず、今回の処理範囲だけをcuratorの根拠にする。通常の一時的な会話はtopicを増やさずcursorだけ進めてよい。curatorは変更topicだけをJSONで返し、Runnerがファイル名、サイズ、出典、indexとの一致を検証する。候補世代の全ファイルを同期後に有効pointerを原子的に切り替え、その後だけ処理済みで直近30ペアより古いraw segmentを削除する。失敗時はcursorとrawを維持して再試行し、40ペアに達したら原文を捨てず新規受付を `voice_memory_full` で止める。

Runner の3指標は、初期モデルについて最新10完了ペア、今回発話、指示の UTF-8 bytes を token 数の保守的な代用値として算出する割合（他モデルは `null`）、未処理ペア数×2、現行topic本文の Unicode コードポイント数である。推定使用率はモデルが必要時に読むファイルや App Server 側の隠れた入力を含まない。

毎回、空の ephemeral thread に最新10完了ペアを `thread/inject_items` で置き、`turn/start.input` に今回発話を一度だけ置く。system instructionも毎回適用する。項目別メモリーの場所と必要時に読む方針は、設定画面のsystem instructionでユーザーが管理する。curatorも応答とは別の ephemeral thread で実行する。

## ターンの失敗・再送

1. Runner は同一会話の操作を直列化し、送信IDで既存の `accepted`／terminal event を検索する。同IDの再送は生成せず保存済み状態を返す。
2. 発話受理時に旧curatorを中止する。今回発話と指示が800,000 bytesを超えれば `preflight_failed` を記録する。curator失敗自体では完了ペアを落とさず、次の機会に再試行する。
3. native 要求の前に `dispatching` を同期して記録する。新規 ephemeral `thread/start` → `turn/start` の順に実行し、返った native ID を正本に記録する。成功本文は `completed` event、raw、recentの順に耐久化する。
4. アプリの WS だけが切れた場合、Runner はターンを続けて結果を保存する。再接続後の `voice.status` で `accepted`／`running`／`completed`／失敗状態を返し、同じ送信IDでは再生成しない。Runner 再起動時に `accepted` の後に `dispatching` がなければ、native 要求前と確定できるため `preflight_failed`（`code: "runner_restarted_before_dispatch"`）を追記する。`dispatching` 以降で terminal event がなければ、送信されたか不明で ephemeral native thread を照合・復元できないため `unknown` として扱い、自動再実行しない。後者の判定は既存 Agent Service の `operation_status_unknown` と同じ保守的な考え方だが、音声専用の保存状態で表す。新しい送信IDの発話は許可するが、未完了発話・未確認応答は直近ペアへ入れない。画面は `unknown` を「前の返答を確認できません」と示す。同IDは常に保存済みの失敗状態または `unknown` を返す。

正本ログには送信IDごとの event を一度だけ追記し、端末の TTS 成否は応答確定と分ける。TTS 失敗・画面離脱でも `completed` 応答は消さない。端末が結果を受け取る前に落ちた場合は `voice.status` で完了本文を取り直せるが、再起動後に自動読み上げはしない。

## 音声画面

[`SkiaMiniBoardScreen.tsx`](../expo/src/features/app/screens/SkiaMiniBoardScreen.tsx) の既存ツール群の右に音声アイコンを置く。ボードのアイコンを1回押すと、ボード上に既存の [`StreamingSttFooter.tsx`](../expo/src/features/app/components/StreamingSttFooter.tsx) だけをすぐ重ね、接続の準備が整い次第録音を自動開始する。ボードからの画面遷移は行わない。フッターの停止ボタンで録音と表示を終了する。既存のカード起動・左ドロワーは変えない。見出し・外枠・再生ボタン・別のマイクボタン・会話本文リスト・テキスト入力・作業ディレクトリ選択は表示しない。処理中／エラーはフッター内の文字で示す。

Skia 側のフッター本体は左右20pt・下20ptの余白を確保し、チャット画面と同じ220msのフェードで表示・非表示を切り替える。余白は iOS の `SafeAreaView` 自体ではなく、その内側の通常の `View` に適用する。外側の光彩は画面端で一部切れる可能性があるため実機で確認する。チャット画面の配置やアニメーションは変更しない。

返答生成中は `RESPONDING`、読み上げ中は `SPEAKING` を、文字列を一文字ずつ増減して表示する。Text の transform は使わない。生成中はシアン系の速い光、読み上げ中は暖色系の遅い光とし、光の幅・ぼかし・透明度をそれぞれ脈動させる。スピナーは表示しない。「動きを減らす」設定では文字を全文静止表示し、状態演出の光を静止させる。これらは音声操作だけが共通フッターの任意 prop で指定し、通常チャットのフッターは変えない。

音声操作も既存の [`useStreamingStt.ts`](../expo/src/features/stt/useStreamingStt.ts) を使い、STT が自然に完了した確定発話だけを送る。共通フッターの停止は両画面で STT セッションを即時中断し、停止後の確定待ち・自動送信はしない。チャット画面では表示済みの文字を入力欄の下書きに残す。`sendTranscript` の `onAccepted` は Runner が `accepted` を永続化した返答を受けた時だけ呼ぶ。`replyLoading` は受理から応答確定または失敗まで true。月間 STT 使用時間の右に、推定文脈使用率・未処理メッセージ件数・topic本文文字数を共通 [`StreamingSttFooter.tsx`](../expo/src/features/app/components/StreamingSttFooter.tsx) 内で表示する。音声操作だけが Runner 値を任意 prop で渡し、フッターには算定処理や新たな録音中限定表示条件を置かない。`ChatScreen` は prop を渡さず既存表示のままにする。完了本文は [`AppRoot.tsx`](../expo/src/features/app/AppRoot.tsx) が既に持つ `synthesizeSpeechStream(text, { messageId: clientOperationId })` へ渡す。実際の合成入口は [`useSynthesizeSpeechStreamController.ts`](../expo/src/features/app/hooks/useSynthesizeSpeechStreamController.ts) であり、新しい TTS 経路を作らない。`panelId`／通常チャットの `sessionId` は渡さず、論理会話IDを native session ID と偽装しない。TTS 呼出し直前から開始待ちを含めて、既存の `isTtsPlaybackActive = ttsPlaying || ttsLoading || ttsQueueProcessing` と合わせた状態を hook の `ttsPlaybackActive` に渡し、再生終了まで録音を止める。再生終了後に hook の既存サイクルで録音を再開する。TTS 失敗時も応答本文は Runner の正本に残すが、音声画面に再生ボタンは置かない。フッターの停止を明示的に押した時は録音・再生を止め、`voice.turn.interrupt` で Runner の生成と TTS を中断する。未完了の返答は正本へ保存せず、遅れて届く完了通知は無視する。WS 切断だけでは Runner の生成と保存を止めない。画面の単純なアンマウントでは録音・再生を止めるが、Runner の生成と保存は継続する。既存チャットの自動読み上げ設定とは独立して、この音声操作で完了した応答は常に読み上げる。既存チャットの TTS 波形・状態への誤投影がなく音声操作で再生終了を検出できることを統合テストする。

## 権限とリリース条件

クライアントからファイルパスや `cwd` を受け取らない。Runner は正本 `v1/` と兄弟の `workspaces/<初期論理会話ID>/` を永続 `cwd` とし、その中の `voice-memory/` をRunner自身が管理する。保持メッセージのクリア後も同じ作業領域とtopicを使う。既存パスがsymlink・非ディレクトリ・別所有者なら拒否する。curatorは別の永続 `summary-workspace/` を使う。両方の作業領域は初回読み込み時に `.git` を準備し、親リポジトリの `AGENTS.md` を読み込まない。ログは専用ディレクトリを0700、ファイルを0600とする。

応答用の `thread/start` は `ephemeral: true`、`approvalPolicy: "on-request"`、`sandbox: "workspace-write"` とする。音声専用の MCP ゼロ件要求・apps 無効化・ツールイベントによる中断を適用せず、Codex の設定を継承する。`turn/start` も `approvalPolicy: "on-request"` とし、App Server からのコマンド実行／ファイル変更承認要求を Runner WS の `voice.approval.request` で端末に送り、通常チャットで使う承認 UI の決定を `voice.approval.decision` で返す。承認経路が切れた場合は実行を継続しない。固定指示には「何かを実行するときは、必ずユーザに確認してから実行してください」を残すが、実際の承認は App Server の要求と UI で扱う。承認が必要かどうかは Codex の policy／sandbox にも依存し、全ツール実行の事前確認をこの指示文だけで保証しない。

非同期curatorは会話応答とは別の ephemeral thread で、`approvalPolicy: "never"`、`sandbox: "read-only"` とする。専用設定では apps／plugins／web searchを無効化し、既存MCPも全件無効にする。未知の形式、有効なMCP、ツール・承認イベントがあれば結果を保存しない。`turn/start.sandboxPolicy` は `{ type: "readOnly", networkAccess: false }` とする。

受入テストは、30/40ペアの保持境界、更新の遅延・失敗・中止、pointer切替前後の停止と再開、raw欠落のfail-closed、同ID再送、クリア後の出典名前空間、応答workspaceの再起動保持を含める。隔離App Serverと模擬モデルで、応答上流に最新10完了ペアと今回発話が順序通り届くこと、cwdにpointer/topic/recent/rawがあること、curatorが別threadでtopic世代を更新することを検査する。

隔離App Serverと模擬モデルによる統合は検証済み。実モデルでの自動topic品質、実機TTS、system instructionによる必要時読出しは本番確認が必要である。複数論理会話、tool／reasoning itemと承認状態のターン間継続は対象外とする。
