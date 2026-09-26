# 音声長期会話の文脈管理 v1 設計

状態: v1 の実装契約（2026-09-25 更新）。音声応答は通常チャットと同じ Codex の MCP／apps 設定を継承し、コマンド・ファイル変更の承認要求を既存の UI に渡す。応答ごとに新規 ephemeral thread を作るため、**tool／reasoning item と承認状態のターン間継続は保証しない**。実モデルによるツール実行、承認、TTS の統合動作は未検証で、リリース前の確認が必要。

## 2つの方式と v1 の選択

| 名称 | 対象 | 文脈の所有者 |
| --- | --- | --- |
| **既存のセッションIDで管理** | 左ドロワー、Skia の既存セッションカードから開くチャット | 現行の Agent Service／Codex native session。UI・API・保存・継続動線を変えない。 |
| **自前コンテキスト配列** | Skia 下部ツール右の新アイコンから開く音声長期会話 | Runner が正本ログから今回渡すメッセージ配列を選ぶ。アプリは論理会話IDと現在の送信IDだけを保持する。 |

v1 の「自前コンテキスト配列」は、Codex App Server の **新規 ephemeral thread を応答ターンごとに開始**し、確定済みメモリーと全未要約の完了メッセージを `thread/inject_items`、今回の確定発話を `turn/start` で渡す。既存 thread の `thread/resume`、`thread/fork`、`thread/compact/start` をこの方式の履歴置換には使わない。Responses API の直接呼び出しにも切り替えない。`thread/inject_items` は追記であり、既存 thread の古い先頭を自由に置換できないためである。[公式 App Server 文書](https://learn.chatgpt.com/docs/app-server)、[隔離検証](APP-SERVER-CONTEXT-VERIFICATION.md)。

ローカルの `codex-cli 0.156.0` では ephemeral thread の開始・注入、模擬提供先への入力、模擬応答での turn 完了まで確認した。実モデルでの成立は未確認。実装はこの方式に固定し、対象 Runner で ephemeral／注入／権限制約が使えなければ音声モードを利用不可として止める。managed thread や Responses API へ黙って代替しない。

## 入口と識別子

- 新規の物理 endpoint は作らず、既存の認証付き `/runner-ws` の `agent` channel を使う。新しい `voice.open` は Runner にある唯一の音声論理会話を取得し、なければ UUID を発行して `active.json` に同期保存する。**v1 は一 Runner に一つの音声論理会話で固定**し、会話の新規作成・切替・削除 UI は作らない。同じ Runner token の端末は同じ会話を開く。`voice.open` の返値は `logicalConversationId`、固定の `contextMode: "self_context_array"`、直近の送信状態。
- ターン受付は既存と同じ `agent / turn.start`。音声側の payload は `{ backendId: "codex", logicalConversationId, clientOperationId, input: { blocks: [{ type: "text", text }] } }` とし、本文は非空の text block 一つだけとする。外枠の `operationId` と payload の `clientOperationId` は同じ UUID でなければ拒否する。`backendId` は provider であり方式ではない。`sessionRef`、クライアント指定 `cwd`、画像、`model`／`effort`／`policyProfileId` 等の自由指定は受け付けない。モデルとエフォートは Runner の保存済み音声設定から選び、初期値は `gpt-6-luna`／`low`。STT の `chirp_3` は変更しない。論理IDがある場合だけ Runner の入口で保存済み方式を照合して音声専用サービスへ一度振り分ける。論理IDがない既存の `turn.start` は今の Agent Service にそのまま渡す。現行 `normalizeAgentStartRequest` には論理IDがないので、この分岐は正規化より前に置き、Agent Service／Codex Backend 内へ方式判定を広げない。
- 送信IDはアプリが確定発話ごとに発行する UUID。受理確認を得るまで保持し、通信再送では同じIDと同じ本文を使う。Runner はIDと本文の組を照合し、同一なら現在状態または保存済み結果を返し、本文が異なれば競合エラーにする。別IDのターンは同一論理会話内で同時実行せず `busy` を返す。
- `turn.start` は永続化後に既存と同じ外枠 `{ channel: "agent", op: "turn.accepted", requestId, operationId, streamId, payload }` を返す。音声では外枠の `operationId` と payload の `clientOperationId` を送信IDにし、`streamId`／`payload.runId` も送信IDとする。payload に `logicalConversationId` と保存済み `status`（初回は `accepted`、同ID再送では terminal も可）、完了済みなら `text` を付ける。完了時は `op: "voice.turn.completed"` と `payload: { logicalConversationId, clientOperationId, text }`、失敗時は `op: "voice.turn.failed"` と `payload: { logicalConversationId, clientOperationId, status, code }` を送る。切断後は `voice.status` に論理IDと送信IDを渡し、`requestId` を引き継いだ `voice.status.result` にその送信IDの `status` と完了済みなら `text` を返す。送信ID未発見は `op: "error"`／`code: "not_found"` とし、この場合だけ同ID・同本文を再送する。`voice.open` の応答は `voice.open.result`。新 op は `agent.hello` の対応操作にも列挙する。画面は差分テキストを描画しないので音声側の delta 配信は v1 に不要。`voice.open`／`voice.status` は保存済み状態を返すだけで新しい生成を始めない。通常チャットの event 契約は変更しない。

`voice.open.result`、`voice.status.result`、`turn.accepted`、`voice.turn.completed/failed` の payload には `estimatedContextUsagePercent`、`unsummarizedMessageCount`、`memoryCharacterCount` を載せる。算定と表示の境界は後述する。

## 設定とクリア

設定画面は認証済み Runner WS の `voice.settings` で現在の `model`／`effort` と Codex App Server の動的モデル一覧を取得する。`voice.settings.update` はモデルとエフォートを一緒に受け、Runner が最新の一覧と対応エフォートを検証して `active.json` に原子的に保存する。応答・要約の両方にその設定を使う。実行中の音声ターンがある間は更新を拒否する。通常チャットのモデル設定とは独立する。

`voice.settings.result` は `storedMessageCount` と `memoryCharacterCount` を返す。前者は正本に保存された受理済み発話数と完了応答数の和（失敗ターンの発話も含む）で、`unsummarizedMessageCount` とは別である。各クリア結果も両値を返し、設定画面は成功応答で表示を更新する。

`voice.memory.clear` は `MEMORY.md` を空本文・cursor 0 に戻し、正本 `events.jsonl` は残す。そのため、保持メッセージが10ペアを超えればメモリーが後で再生成される。`voice.messages.clear` は要約本文を保ち、空の正本ログとcursor 0を持つ新しい論理会話IDへ切り替える。旧ログは削除し、切断中の端末による旧IDの再送は拒否する。応答用の作業領域内のファイルは保持する。旧ログ削除中にRunnerが停止しても、`active.json` の旧IDマーカーから再開時に削除を完了する。どちらのクリアも実行中ターンを拒否し、進行中の要約を中止する。

モデル一覧に文脈窓の値はないため、`estimatedContextUsagePercent` は初期モデル以外では `null` と表示する。800,000 bytes の入力境界はどのモデルでも token 上限を保証しない。実モデルが文脈超過を返した場合はターン失敗として扱う。

実装箇所の目安: [`server-runtime.mjs`](../private_runner/src/server-runtime.mjs) の認証済み Runner WS 入口で上記の一回の分岐を置き、音声専用の受付・保存・App Server 処理を別ファイルにまとめる。[`agent-transport.mjs`](../private_runner/src/agent/agent-transport.mjs) は対応 op の広告だけ追加し、[`codex-turn-execution.mjs`](../private_runner/src/codex-turn-execution.mjs) の通常チャット処理は変更しない。既存の `createCodexRpcClient` による認証・App Server 接続を再利用する。

## 保存と文脈選択

保存先は `private_runner/logs/voice_context/v1/`。`active.json` に唯一の論理会話IDと方式を保存し、そのIDのサブディレクトリに次を置く。worktree の `private_runner/logs` は main 側を指す共有 symlink なので、[worktree 手順](GIT-WORKTREE.md)どおり同じ main を共有する Runner は一つだけ稼働させる。複数 Runner 同時更新は v1 対象外。

| ファイル | 責務 |
| --- | --- |
| `events.jsonl` | 正本。送信ID、受理した確定発話、状態遷移、完了応答、対応する native thread／turn ID を時系列で追記する。STT 途中結果、TTS 音声、tool／reasoning item は保存しない。 |
| `memory-pending.json` | 要約待ちの完了ペアだけを正本から作る一時ファイル。範囲の開始・終端ペア番号を含み、正本ではない。 |
| `MEMORY.md` | Runner が確定した要約。先頭の機械可読ヘッダーに「要約済み末尾ペア番号」を持つ。新しい範囲だけを要約して旧本文をそのまま残し、追加本文とヘッダーを一つの原子的置換で確定する。 |

`events.jsonl` は一行一 event とし、全行に `seq`（連番）、`at`（時刻）、`clientOperationId`、`type` を置く。最小形は `accepted` に `text`、`dispatching`、`native_started` に `threadId`／`turnId`、`completed` に `pairSeq`／`text`、`preflight_failed`／`failed`／`interrupted` に `code`。`pairSeq` は完了した user／assistant ペアにだけ 1 から連番で付く。`MEMORY.md` の初期値は `<!-- voice-context:v1 summarizedThroughPair=0 -->` と空本文で、cursor は event の `seq` ではなく `pairSeq` を指す。`memory-pending.json` は `{ "fromPairSeq": 1, "throughPairSeq": 3, "pairs": [...] }` の形とし、範囲と中身を正本から再検証する。`active.json` は `{ "logicalConversationId": "<UUID>", "contextMode": "self_context_array", "workspaceInitialized": true }` を初期形とし、選択済み `model`／`effort`、クリア後の `workspaceConversationId` と削除復旧用 `previousConversationId` を必要時だけ加える。既存の旧形は、作業領域を作って同期した後にマーカーを追加する。以降は領域が欠けても自動再作成しない。これら以外の索引ファイルを正本にしない。

発話は `turn.start` 受付時に `accepted` event を追記・同期してから確認応答する。完了応答は対応 native thread／turn の `item/completed` で最終本文を集め、成功した `turn/completed` と空でない本文を確認した後に同じ送信IDの `completed` event として追記・同期し、それからアプリへ通知する。生成途中の delta は正本にも TTS にも使わず、応答本文を途中で切って完了扱いにしない。追記は一会話内で直列化し、再起動時は正本を読み直す。書きかけの末尾行だけは受理済みと見なさず、原本を保全して復旧する。破損した確定行、`MEMORY.md` の不正なヘッダー、ディスク満杯は黙って飛ばさず受付を停止する。

文脈に入れる単位は **完了した user／assistant のペア**。未要約の完了ペアは、20履歴メッセージ（10ペア）を超えても、`MEMORY.md` への要約の成功・永続確定までは**全件を順に**今回の入力へ入れる。50メッセージ以上でも件数だけを理由に削らず、確定済みの要約範囲と重複させない。正本 `events.jsonl` からも削除しない。「固定の音声会話指示 + 確定済み `MEMORY.md` 本文 + 全未要約ペア + 今回の発話」の UTF-8 合計が **800,000 bytes** を超えたら、ペアや本文を黙って切らず `voice_context_too_large` で native turn 前に明示失敗する。固定指示と今回発話だけで超える場合は受付前に拒否する。このバイト境界は実モデルの token 上限を保証せず、実モデルの context-length エラーも失敗として扱う。

未要約の完了ペアが10件を超えたら、古い超過分を `memory-pending.json` に原子的に書き、応答を待たせず別の ephemeral thread で非同期要約する。要約エージェントには**新しい超過ペアだけ**を渡し、その範囲の事実・好み・未解決事項の要約本文だけを返させる。旧 `MEMORY.md` を再生成させない。Runner だけが pending の範囲・正本・cursor・サイズを再検証し、旧本文のバイト列を変えずに新しい要約を末尾へ追加して、cursor と一緒に原子的に確定する。成功確定後だけその範囲を次回入力から除く。要約入力または追加後のメモリーが800,000 bytesを超える場合は確定せず、未要約ペアを全件保持する。新しい発話を受理したら予約中・実行中の旧要約を中止し、task identity と cursor の照合で遅れた結果の書き込みも防いで再計画する。成功後だけ一時ファイルを片付ける。モデル／通信の失敗は本文を含まない段階・分類・試行回数・対象ペア範囲を記録し、応答と独立して1秒から最大60秒の間隔で再試行する。保存領域の読取・書込失敗や破損は再試行せず受付を停止する。再起動時は正本と cursor を基準に再生成できるが、要約が進まない間は上記の入力境界で明示失敗し得る。旧方式ですでに要約から落ちた内容はこの変更だけでは戻らず、正本イベントからの復旧は別途判断する。

Runner の3指標は、初期モデルについて可視テキストの UTF-8 bytes を token 数の保守的な代用値として 1,050,000-token のモデル文脈窓で割った切り上げ百分率（上限100%、他モデルは `null`）、確定済み未要約ペア数×2、機械可読ヘッダーを除く `MEMORY.md` 本文の Unicode コードポイント数である。推定使用率は App Server 側の隠れた入力や実測 token 数を含まず、実際の文脈窓使用率と混同しない。

毎回、空の ephemeral thread に確定済み要約本文があれば「以前の会話の要約」と明示した assistant message、続いて全未要約ペアを user／assistant message として順に注入する。今回の発話は注入せず `turn/start.input` に一度だけ置く。要約済みペア、未要約ペア、今回の発話は重複しない。要約エージェントも応答エージェントとは別の ephemeral thread で実行する。tool／reasoning の完全再生は v1 で保証しない。

## ターンの失敗・再送

1. Runner は同一会話の操作を直列化し、送信IDで既存の `accepted`／terminal event を検索する。同IDの再送は生成せず保存済み状態を返す。
2. 発話受理時に旧要約を中止する。今回の入力には確定済みメモリーと全未要約ペアを用い、要約完了を待たない。入力が800,000 bytesを超えれば `preflight_failed`（`code: "voice_context_too_large"`）を記録し、native thread は作らない。要約失敗自体では完了ペアを落とさず、次の機会に再試行する。
3. native 要求の前に `dispatching` を同期して記録する。新規 ephemeral `thread/start` → `thread/inject_items` → `turn/start` の順に実行し、返った native ID を正本に記録する。成功通知と本文の保存後だけ `completed` とする。明示的な中断・失敗は `interrupted`／`failed` として記録する。
4. アプリの WS だけが切れた場合、Runner はターンを続けて結果を保存する。再接続後の `voice.status` で `accepted`／`running`／`completed`／失敗状態を返し、同じ送信IDでは再生成しない。Runner 再起動時に `accepted` の後に `dispatching` がなければ、native 要求前と確定できるため `preflight_failed`（`code: "runner_restarted_before_dispatch"`）を追記する。`dispatching` 以降で terminal event がなければ、送信されたか不明で ephemeral native thread を照合・復元できないため `unknown` として扱い、自動再実行しない。後者の判定は既存 Agent Service の `operation_status_unknown` と同じ保守的な考え方だが、音声専用の保存状態で表す。新しい送信IDの発話は許可するが、未完了発話・未確認応答は直近ペアへ入れない。画面は `unknown` を「前の返答を確認できません」と示す。同IDは常に保存済みの失敗状態または `unknown` を返す。

正本ログには送信IDごとの event を一度だけ追記し、端末の TTS 成否は応答確定と分ける。TTS 失敗・画面離脱でも `completed` 応答は消さない。端末が結果を受け取る前に落ちた場合は `voice.status` で完了本文を取り直せるが、再起動後に自動読み上げはしない。

## 音声画面

[`SkiaMiniBoardScreen.tsx`](../expo/src/features/app/screens/SkiaMiniBoardScreen.tsx) の既存ツール群の右に音声アイコンを置く。ボードのアイコンを1回押すと、ボード上に既存の [`StreamingSttFooter.tsx`](../expo/src/features/app/components/StreamingSttFooter.tsx) だけをすぐ重ね、接続の準備が整い次第録音を自動開始する。ボードからの画面遷移は行わない。フッターの停止ボタンで録音と表示を終了する。既存のカード起動・左ドロワーは変えない。見出し・外枠・再生ボタン・別のマイクボタン・会話本文リスト・テキスト入力・作業ディレクトリ選択は表示しない。処理中／エラーはフッター内の文字で示す。

Skia 側のフッター本体は左右20pt・下20ptの余白を確保し、チャット画面と同じ220msのフェードで表示・非表示を切り替える。余白は iOS の `SafeAreaView` 自体ではなく、その内側の通常の `View` に適用する。外側の光彩は画面端で一部切れる可能性があるため実機で確認する。チャット画面の配置やアニメーションは変更しない。

返答生成中は `RESPONDING`、読み上げ中は `SPEAKING` を、文字列を一文字ずつ増減して表示する。Text の transform は使わない。生成中はシアン系の速い光、読み上げ中は暖色系の遅い光とし、光の幅・ぼかし・透明度をそれぞれ脈動させる。スピナーは表示しない。「動きを減らす」設定では文字を全文静止表示し、状態演出の光を静止させる。これらは音声操作だけが共通フッターの任意 prop で指定し、通常チャットのフッターは変えない。

音声操作も既存の [`useStreamingStt.ts`](../expo/src/features/stt/useStreamingStt.ts) を使い、STT が自然に完了した確定発話だけを送る。共通フッターの停止は両画面で STT セッションを即時中断し、停止後の確定待ち・自動送信はしない。チャット画面では表示済みの文字を入力欄の下書きに残す。`sendTranscript` の `onAccepted` は Runner が `accepted` を永続化した返答を受けた時だけ呼ぶ。`replyLoading` は受理から応答確定または失敗まで true。月間 STT 使用時間の右に、推定文脈使用率・未要約メッセージ件数・`MEMORY.md` 本文文字数を共通 [`StreamingSttFooter.tsx`](../expo/src/features/app/components/StreamingSttFooter.tsx) 内で表示する。音声操作だけが Runner 値を任意 prop で渡し、フッターには算定処理や新たな録音中限定表示条件を置かない。`ChatScreen` は prop を渡さず既存表示のままにする。完了本文は [`AppRoot.tsx`](../expo/src/features/app/AppRoot.tsx) が既に持つ `synthesizeSpeechStream(text, { messageId: clientOperationId })` へ渡す。実際の合成入口は [`useSynthesizeSpeechStreamController.ts`](../expo/src/features/app/hooks/useSynthesizeSpeechStreamController.ts) であり、新しい TTS 経路を作らない。`panelId`／通常チャットの `sessionId` は渡さず、論理会話IDを native session ID と偽装しない。TTS 呼出し直前から開始待ちを含めて、既存の `isTtsPlaybackActive = ttsPlaying || ttsLoading || ttsQueueProcessing` と合わせた状態を hook の `ttsPlaybackActive` に渡し、再生終了まで録音を止める。再生終了後に hook の既存サイクルで録音を再開する。TTS 失敗時も応答本文は Runner の正本に残すが、音声画面に再生ボタンは置かない。音声操作を閉じた時は録音・再生を止め、Runner の生成は継続して正本へ保存する。既存チャットの自動読み上げ設定とは独立して、この音声操作で完了した応答は常に読み上げる。既存チャットの TTS 波形・状態への誤投影がなく音声操作で再生終了を検出できることを統合テストする。

## 権限とリリース条件

クライアントからファイルパスや `cwd` を受け取らない。Runner は応答用に、正本 `v1/` と兄弟の `workspaces/<初期論理会話ID>/` を一つ作り、`active.json` の検証済みIDで参照する永続 `cwd` とする。保持メッセージのクリア後も同じ作業領域を使う。返答ごとの ephemeral thread は維持するが、そこで作ったファイルは次の返答と再起動後にも残す。作業場所に正本の `events.jsonl` や `MEMORY.md` は置かず、既存パスが symlink・非ディレクトリ・別所有者なら拒否する。要約は別の永続 `summary-workspace/` を使う。両方の作業領域は音声サービスの初回読み込み時に `.git` を準備し、親リポジトリの `AGENTS.md` を読み込まない。旧実装の `ephemeral-tmp/summary-XXXXXX` は再起動時に対象を限定して片付ける。音声経路は Agent Service の新規セッション受付と workspace admission を通らないため、この内部 `cwd` を対象 Runner の App Server が受け入れるか統合試験で確認する。ログは専用ディレクトリを 0700、ファイルを 0600 とし、会話本文・token を通常の診断ログへ出さない。実ユーザーの作業リポジトリを暗黙の `cwd` にしない。

応答用の `thread/start` は `ephemeral: true`、`approvalPolicy: "on-request"`、`sandbox: "workspace-write"` とする。音声専用の MCP ゼロ件要求・apps 無効化・ツールイベントによる中断を適用せず、Codex の設定を継承する。`turn/start` も `approvalPolicy: "on-request"` とし、App Server からのコマンド実行／ファイル変更承認要求を Runner WS の `voice.approval.request` で端末に送り、通常チャットで使う承認 UI の決定を `voice.approval.decision` で返す。承認経路が切れた場合は実行を継続しない。固定指示には「何かを実行するときは、必ずユーザに確認してから実行してください」を残すが、実際の承認は App Server の要求と UI で扱う。承認が必要かどうかは Codex の policy／sandbox にも依存し、全ツール実行の事前確認をこの指示文だけで保証しない。

非同期要約は会話応答とは別の ephemeral thread で、`approvalPolicy: "never"`、`sandbox: "read-only"` とする。要約専用の設定では apps／plugins／web search を無効化し、`config/read` で得た既存 MCP ごとに `enabled:false` を指定する。`mcpServerStatus/list` は無効化済み項目も返すため、空配列を要求せず、thread-scoped の全ページで全項目が `disabled` かつ tools／resources／resourceTemplates が空である場合だけ要約を開始する。未知の形式や有効項目は失敗扱いにする。App Server は Codex 組み込みツールをモデルへ提示し得るため、ツール・承認イベントが発生した場合も中断して結果を保存しない。要約の `turn/start.sandboxPolicy` は `{ type: "readOnly", networkAccess: false }`。この読取制限は外部ファイルの非読取まで保証しない。

実装順は (1) 保存・cursor・選択・再送の純粋な Runner ロジック、(2) 入口の一回の dispatch と App Server 実行、(3) 音声画面と STT／TTS 接続、(4) 障害・回帰テスト。受入テストは、20件から50件超への連続発話、要約の遅延・失敗・中止・逆順完了と確定前後の非重複、**複数回要約後も旧メモリー本文が完全一致すること**、800,000-byte 境界と明示失敗、同ID再送・異本文競合、受理直後／dispatch後／完了直後の再起動、WS 切断、応答作業場所のターン間・再起動後のファイル保持、要約作業場所の複数回・再起動後の再利用と旧一時領域だけの起動時回収、3指標の再接続更新と既存フッター表示、TTS 失敗、音声画面に本文リストがないこと、既存チャットの動線不変を含める。隔離した実 App Server と localhost 模擬モデル提供先で、次の上流 `input` の**会話由来 item** に確定済み `MEMORY.md` と全未要約ペア・今回発話だけが順に入り、未確定でも古いペアが欠落せず、要約済み範囲は重複しないことを検査する。system／developer 指示など別の入力源まで消えるとは主張しない。

実モデルでの認証、ephemeral thread、ツール実行・承認、stream 完了、TTS、要約品質は未検証。ユーザーが実機で再送した失敗ログから、旧実装の `capability_unsupported` は音声固有の MCP ゼロ件判定で `turn/start` 前に発生したと確定した。今回の変更後に実モデル・実機で解消したとはまだ確認していない。失敗した場合は本書と実装を再評価する。複数論理会話、tool／reasoning item と承認状態のターン間継続は v1 後に分ける。
