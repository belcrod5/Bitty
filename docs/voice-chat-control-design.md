# 声だけで会話先を移り、話し終えたらマイクを閉じる

状態: 実装・自動検証済み。2026-10-18 の `origin/main` (`fb6c7ea`) を基点とする。実機での一続きの音声会話と実 LLM の受入確認は未実施。

## 1. この設計でできるようにする一続きの体験

ユーザーは、通常チャットかメインのオーケストレーションで音声会話をしている。
途中で昨日の相談の続きを思い出し、「昨日の〇〇のチャットを開いて、音声で話したい」と頼む。
AI は必要なときだけ候補を探し、二つあれば声で確認する。選ぶまでは元の会話に話せる。
選んだ後はアプリが会話先とマイクを一緒に切り替え、話せる状態になったことを知らせる。
ユーザーの次の発話はその相談先だけに届く。
用が済んだら「メインのオーケストレーターへ戻って」と頼んで戻り、最後に「音声入力を止めて」と頼む。
マイクと自動再開が止まり、その後に独り言を言っても収録・送信されない。

この体験を **既存の `bitty-session-orchestrator` スキル + CLI + 発話元アプリへの Runner API** で実現する。
スキルは言葉を意図と対象へ結び付け、アプリは実際の会話先とマイクを一致させる。
新しい function 定義を毎ターン列挙せず、詳細な手順は必要なときに読む。

原依頼の「別のチャットにしゃべれる」「別のオーケストレーションにしゃべれる」は、まず **ユーザー自身が会話先を移り、その後も対話を続ける体験** と解釈する。
「あのチャットを開いて音声入力モードにして」という例から、この解釈が一続きの使い方になるためである。
「B に『明日でお願いします』とだけ伝えて」は、画面を移らず一言を代理送信する別の体験であり、同じ切り替えとして扱わない（第5節）。

## 2. 最小の物語: 話し終えたので、音声入力を止める

通常チャットでも音声オーケストレーションでも、この物語から検証する。

| 場面 | ユーザーに見える・聞こえること | 内部で必要なこと / 次の声の行き先 |
| --- | --- | --- |
| 依頼前 | A の会話画面。音声入力が有効で、発話後には返信と再録音が続く | マイクの所有者はこの端末の A。LLM/TTS 待ちで実録音が一時停止していても、継続入力の意図は有効 |
| 「音声入力を止めて」 | 発話が A に送られる | A の LLM がスキルを読み、発話元に結び付いた context で `control stop` を1回呼ぶ。停止依頼を別チャットへ送らない |
| 実行中 | 音声入力の表示が停止処理へ変わる | CLI → Runner → 発話元アプリ。共通音声処理が補正・送信候補・再開予約を解除し、native のマイク終了を待つ。LLM の返答終了は待たない |
| 完了 | アプリのマイク表示が停止。確認済みの結果を受け、A が「音声入力を止めました」と返答・読み上げできる | マイク停止だけでは LLM/TTS を中断しない。TTS 後も再録音しない |
| その後、独り言を言う | A の画面はそのまま | 音声は収録も送信もしない。wake word 待受も残さない。再開には既存の手動 UI 等が必要 |

LLM に届いて初めて効く操作である。通常チャットで `autoReplyAfterStt: false` の場合、認識文字は draft に残るため、既存の送信操作が必要になる。
音声だけで完結する受入対象は自動送信付きの音声会話とする。未送信文字から停止命令を拾う分類器は追加しない。
未送信の本文は停止後も画面に残す。既に Runner に受理された turn は取り消さない。

停止結果を確認できなければ「止めました」と言わず、確認できないことを表示・返答する。
接続が生きていればアプリの現在状態も照会する。別端末や別 panel の停止へ切り替えない。

## 3. 本来の物語: 昨日の相談へ移り、戻って、終了する

### 3.1 思い出した相談先を、声で選ぶ

出発点 A は通常チャット、またはメインのオーケストレーション。どちらも音声入力が有効である。
ユーザーが「昨日の〇〇のチャットを開いて、音声で話したい」と頼む。

1. A の LLM はスキルを読み、既知の対象 ID があれば再検索せず使う。
2. ID がなければ既存の workspace / session 一覧からタイトル・provider・workspace を絞る。「昨日」の内容確認が必要な場合だけ `bitty-history` を読む。オーケストレーターは既存一覧から id / name を得る。
3. 例えば「〇〇の設計相談」と「〇〇の不具合調査」が残ったら、「設計相談と不具合調査のどちらですか」と A が声で聞く。元画面と継続音声入力は維持する。TTS 中の一時停止・再開は既存の会話動作に従う。
4. ユーザーの「設計相談のほう」は A に届く。新しい turn の context で対象 B を確定し、切り替えを1回要求する。前の turn の context は再利用しない。

候補がない場合は A に留まり、見つからなかったことと追加で必要な情報を返す。
最新順や似た名前だけで B を決めない。この段階では B に本文を送らず、マイクも切り替えない。
履歴の発言は対象を探す資料であり、操作の指示や制御権として扱わない。

### 3.2 会話先とマイクを、1回の切り替えで合わせる

ユーザーが選び終えたら、LLM は `control handoff` を使う。
「A を停止 → B を開く → B を開始」を LLM が別々に実行する設計にはしない。
途中で turn が終わったり、別の画面へ移ったりしても、アプリが一つの要求として結果を確定できるようにする。

| 順番 | アプリの動作 | ユーザーとの約束 |
| --- | --- | --- |
| 1 | 発話元 A の一致、対象 B、権限、対応機能、既知の未送信本文・実行中 turn を確認 | 事前に分かる問題なら A に留まり、継続音声入力も維持。B へは何も送らない |
| 2 | A の再開予約を解除し、native 収録終了を待つ | この時点から切り替え完了まで、次の相談内容を話すのは待ってもらう。A/B の二重録音はしない |
| 3 | B を開き、対象 ID と復元状態、音声 controller の登録を確認 | 画面が開いただけで「話せます」と言わない。切り替え依頼や A の未送信本文を B の相談本文へコピーしない |
| 4 | B の準備ができたら、アプリ自身が「〇〇の設計相談へ移ります。開始の合図の後に話してください」と対象名を短く知らせる | 元の LLM の遅い返答に案内を依存させない。この段階の表示は開始待ち |
| 5 | 案内終了後、B の native 収録開始を確認し、短い開始合図を鳴らす。合図終了後にマイク表示を入力中へ変える | ここで初めて切り替え完了。`applied` の結果を保存。合図中の音はユーザー音声として送信しない |
| 6 | ユーザー「昨日の続きだけど、案2で進めたい」 | この発話は B にだけ届き、B が返信する。A の LLM から B へ代理送信する方式ではない |

対象名の案内はアプリの遷移結果に基づく短い通知で、追加 LLM 呼出を必要としない。
既存音声画面の「開始しました」は収録開始前に再生されるため、完了の証明として再利用しない。
案内中は録音せず、その TTS の後に native を開始する。開始合図は TTS preemption を起こさないローカル効果音とする。
既存 [recordStart](../expo/src/features/app/types/appTypes.ts) の音源を再利用できるが、[playUiSfx](../expo/src/features/app/hooks/useUiSfxController.ts) は現状完了を返さないため、そのまま正確な合図境界とは扱わない。
実装ではこの操作に対応する再生完了・取消を確認し、合図中の入力を共通 transport の開始処理内で STT へ渡さず、再生終了後に入力可能とする。
案内や合図自身が次のユーザー発話として B に送信されないことを実機で検証する。新しい汎用通知基盤は作らない。
開始合図だけが再生できなかった場合は実際の native 状態と通知失敗を分けて返し、開始済みの録音を「開始失敗」と偽らない。画面には実状態を表示する。
開始待ち・失敗・入力中を画面でも区別し、ユーザーが話し始める時点を明確にする。

事前確認後に復元や開始が失敗したら、元のマイクは停止したままとする。
アプリは「現在は B の画面、音声入力は停止」のように実際の現在地と状態を通知し、結果にも返す。
元へ自動的に戻して録音を再開しない。未送信本文が後から判明した場合も勝手に送信・削除・結合しない。
native 停止自体を確認できない場合は、新しいマイクを開始せず、実状態不明を報告する。
停止後の失敗はアプリ自身の短い音声通知と表示で知らせる。入力が停止しているため、再試行には文字入力・既存の手動 UI が必要であり、声で再依頼できるとは案内しない。

### 3.3 戻る、別のオーケストレーターへ移る、終える

B での相談後、「メインのオーケストレーターへ戻って」と頼む。
主オーケストレーターを id で確定し、同じ `control handoff` で戻る。対象が曖昧なら B で確認する。
戻ったことと入力開始をアプリが知らせた後の声は、メインのオーケストレーションにだけ届く。
最後に「音声入力を止めて」と頼み、第2節と同じ停止で会話を終える。

主オーケストレーターから「調査用オーケストレーターに切り替えて、そちらと話したい」と頼む場合も同じである。
変わるのは移動先の ID と画面の準備だけで、調査用オーケストレーターへ相談本文を代理送信しない。
通常チャット A から通常チャット B へ移る場合も同じで、Codex / Claude の違いは B の通常対話実行に残す。
通常→通常、通常→オーケストレーション、オーケストレーション→通常、オーケストレーション→別オーケストレーションを、この一つの物語の出発点・移動先の違いとして検証する。

## 4. この物語から必要になる最小実装

| 実際の依頼・場面 | 必要な責務 | 最小の実装 |
| --- | --- | --- |
| 「音声入力を止めて」 | 発話元の入力と自動再開を確実に解除 | 変更操作 `stop`。共通 STT の非同期停止と native 終了結果 |
| 「昨日の〇〇のチャット」 | 名前から対象 ID を確定し、必要なら声で確認 | 既存一覧・履歴検索をスキルから利用。オーケストレーター一覧だけ CLI に接続 |
| 「開いて、音声で話したい」 | 会話先・画面・マイクを一致させる | 変更操作 `handoff`。アプリ側の所有権移譲と実収録開始 ACK |
| 「メインへ戻って」 | 確定した戻り先へ同じ操作を適用 | 新しい return 操作は作らず、同じ `handoff` |
| 文字入力等で「今のこのチャットを音声入力にして」 | 同じ対象で入力を有効化 | 同一対象への `handoff`。再 mount せず開始に収束。完全停止後の音声再開を意味せず、独立した `start` も不要 |
| 曖昧・実行中・失敗 | 対象や完了を推測せず、会話を続けられる説明 | 読取の `status` / `result`、部分結果、アプリの通知。新しい変更操作は増やさない |

公開する変更操作は **`stop` と `handoff` の二つ** に絞る。
画面だけを開く独立 `open`、独立 `start` は原依頼の体験に必要でないため、今回は作らない。
対象の発見・状態照会・結果照会は、この二つを正しく実行するための補助であり、別の製品機能として増やさない。

最初に第2節の両画面での停止を検証し、その後、第3節の選択→切り替え→会話→帰還→停止を通す。
停止だけを作って全体完了とはしない。全体の完了条件は、この一続きの会話が成立することである。

## 5. 一言の伝言と、今回作らない体験

「B に『明日でお願いします』とだけ伝えて」は、A に留まり B に一度だけ本文を送る依頼である。
切り替えと取り違えず、`handoff` で画面やマイクを移さない。
既存 `send` は通常 Codex / Claude セッションへの送信に使えるが、音声オーケストレーションへの同等の本文転送は備えていない。
既存 API の有無をユーザー意図の判断根拠にはしない。伝言は会話先・返信の戻し先・再送の意味が異なるため、今回の直接対話の完成後に別の設計単位として扱う。
「B に話したい」だけで移動か伝言か判別できなければ、スキルは短く確認する。

このほか、新規チャット・新規オーケストレーター作成、別端末への操作、バックグラウンド録音開始、OS 権限の遠隔承認、常時待受・wake word、任意 UI 操作、録音ファイル転送は対象外とする。
音声コマンド専用の正規表現・ローカル分類器・追加 LLM も作らない。
明示された停止・切り替えに毎回の追加承認は挟まず、曖昧さの確認と OS 等の既存権限だけを扱う。

## 6. なぜスキル・CLI・API で分けるのか

| 境界 | 物語の中で担うこと | 持たせないこと |
| --- | --- | --- |
| スキル | 依頼を停止・移動・伝言に読み分ける。必要な一覧・履歴を調べ、対象を確認。結果に合った回答をする | 音声の状態機械、端末の推測、認可、独自の再試行 |
| CLI | 検証した引数と既存 token で API を呼び、operation ID と JSON 結果を返す | 自然言語判断、画面選択、独自キュー・音声状態 |
| Runner API | 発話元 turn との結合、期限・重複防止、1接続への配送、ACK と結果照会 | OS マイク操作、タイトルの曖昧一致、全端末 broadcast |
| アプリ共通の所有権境界 | 発話元の照合、画面遷移、マイクの排他、準備待ち、案内と結果通知 | セッション検索、自然言語解釈 |
| 共通 STT / transport | 再開予約・補正の解除、実収録の開始・終了、遅い callback の無効化、観測状態 | CLI / HTTP、別チャット・別端末の判断 |

通常チャットとオーケストレーションの両方が使う上流の音声処理と所有権を整える。
画面ごとに停止ワードを解釈したり、同じ制御を複製したりしない。
Runner の状態は配送と照会のための観測値であり、アプリの音声状態機械を複製しない。
汎用 action registry、任意メソッド RPC、一操作一スキルも作らない。

既存スキルは現在リポジトリ外の個人設定にある。実装時は `skills/bitty-session-orchestrator/` を管理原本に移管し、既存 CLI とコマンド互換を保つ。
個人の絶対パス・設置先からの repo 推測を除き、既存環境変数と明示設定を使う。
小さな配布入口から Codex / Claude の対応 directory へ配置し、version と差分を確認する。未管理のローカル変更を黙って上書きせず、二つの原本を並行保守しない。
管理原本と installer を実装し、Codex / Claude のスキルディレクトリへ配置した。既存の個人版は内容のダイジェスト照合後にバックアップ保存して移管した。Claude の `--safe-mode` は実環境の CLI help でもスキル無効と明記されており、このモードでの自動発見は対象外とする。既存の安全設定を緩めない。

常時はスキル名と短い説明だけとし、詳細コマンドは `references/app-control.md` の必要時読込に置く（[スキルの段階的読込](https://learn.chatgpt.com/docs/build-skills)）。
実行対象 turn には短い `controlContext` 参照を1個渡す。機能一覧と全引数を常時注入しない。
読込済みスキル本文は会話 context に残り得るため、継続 turn のコストはゼロとは言えない。
選定理由はユーザーの意向と既存 CLI・操作手順の再利用であり、他方式より省トークンという実測結果はまだない。

## 7. 既存コードから見える、上流で直すべき箇所

| 確認できた実装 | 今回の体験に足りない契約 |
| --- | --- |
| [useStreamingStt.ts](../expo/src/features/stt/useStreamingStt.ts) は両画面共通。同期 `stop()` は補正中に早期 return し、transport 終了を待たない。`abort()` は片付けるが内部失敗を握りつぶす | 「止めました」を裏付ける非同期 disarm と失敗伝播。既存片付けを一本化し wrapper を足さない |
| [iOS native](../expo/modules/bitty-stt-transport/ios/BittyStreamingSttModule.swift) は server ready を engine 開始前に通知。[macOS transport](../expo/src/features/stt/useStreamingSttTransport.macos.ts) は停止エラーを抑制 | ready を実収録開始成功に揃え、終了結果も返す。診断 event や `isCapturing()` の参照有無を成功の証明にしない |
| [ChatScreen.tsx](../expo/src/features/app/screens/ChatScreen.tsx) は AppRoot の音声登録に参加。[VoiceConversationScreen.tsx](../expo/src/features/app/screens/VoiceConversationScreen.tsx) は独自の開始案内・選択と cleanup を持ち、その登録に不参加 | 両画面が同じ対象付き所有権へ参加し、起動案内後の自動開始も共通境界を通る |
| [AppRoot.tsx](../expo/src/features/app/AppRoot.tsx) は音声 controller の Set、TTS のための全体停止、popup 遷移を持つ | 発話元の一意な owner、世代、対象登録、遷移と開始結果 |
| [RunnerWebSocketManager.ts](../expo/src/features/runnerWs/RunnerWebSocketManager.ts) は認証接続と再接続を持つ。heartbeat の `clientInstanceId` は制御権を保証しない | capability 登録、接続世代、対象付き命令と ACK |
| [server-runtime.mjs](../private_runner/src/server-runtime.mjs) に接続 ID と `voice.*` がある。`voice.turn.interrupt` は LLM 中断 | マイク停止との混同を避け、新しい有限操作の配送・結果台帳へ配線 |
| [agent-service.mjs](../private_runner/src/agent/agent-service.mjs) / [voice-context-service.mjs](../private_runner/src/voice-context-service.mjs) が対話 run を管理 | 実行中 turn だけに発話元 context を結び付ける。要約・分類・preflight に付けない |

TTS の [preparation controller](../expo/src/features/app/hooks/usePrepareTtsPlaybackSessionController.ts) は実録音前の接続中も止める必要がある。
共通 snapshot は `desired: stopped | listening` と `observed: stopped | waiting | starting | recording | unknown` を分け、接続中の状態も表す。
同じ snapshot を UI・所有権・ACK に使い、`armed`、接続の存在、実収録を混同しない。
旧 native は capability/version で除外し、成功を推測しない。

## 8. 実装契約: 発話元と対象を固定する

既存 Runner Bearer token を使い、新しい秘密 token や端末認証基盤は作らない。
ただし共通 subject の利用権と「今このマイクを操作する対象」は区別する。

1. アプリは認証済み WS に capability を登録し、Runner が接続世代を発行する。
2. turn 送信時の `origin` に `clientInstanceId / connectionGeneration / surfaceId / ownerGeneration / target` を付け、Runner がその送信 WS と照合して accepted run に結び付ける。
3. Runner は不透明な短い `controlContext` 参照を発行し、当該 invocation の trusted instruction に渡す。origin を CLI から上書きできない。
4. 新規操作はその run の実行中だけ受理し、終了・中断・期限切れ、切断・background・surface 解除・手動切り替えで参照を無効にする。受理済み操作の結果は operation ID で照会できる。

通常チャット初回の nativeSessionId が未確定なら、surface + accepted run へ仮結合し、同じ run の session 解決結果で補う。
Runner の `bindResolvedSession` とアプリ側 target の照合が済むまでは変更を配送しない。初回解決だけで owner generation を進めず、命令の期限内に解決できなければ失敗させる。
同じ session が複数 panel にある場合も origin の surface・世代を照合し、後から前面になった panel を追いかけない。
`CODEX_THREAD_ID` / `x-bitty-display-caller` は活動表示であり、制御対象や認可に流用しない。

通常対象は既存一覧の backendId + nativeSessionId + canonical cwd、オーケストレーターは既存 id で特定する。音声専用 session ID は作らない。

```json
{"kind":"session","sessionRef":{"backendId":"codex","nativeSessionId":"s-123"},"cwd":"/approved/work"}
```

```json
{"kind":"orchestrator","orchestratorId":"main"}
```

1 context が受理できる変更は1件。読取と同じ operation の照会は繰り返せる。
参照をユーザー本文・通常入力 hash・表示履歴へ混ぜず、共有 `process.env` や backend factory の可変値にも置かない。
[agent transport](../private_runner/src/agent/agent-transport.mjs) から `startTurn` に trusted run context を渡す。[Codex](../private_runner/src/codex-turn-execution.mjs) と音声の対話 `modelTurn` は、短い参照を `turn/start.additionalContext` の固定キー `bitty.appControl`（`kind: application`）へ毎回渡す。ロード済み thread の `thread/resume.developerInstructions` は変更が無視されるため、発話単位の参照の配送には使用しない。参照がない発話でも同じキーに「この発話では操作できず、過去の参照を再利用しない」と明記し、前回の状態を引き継がない。resume 失敗は握りつぶさず、発話を開始しない。[Claude](../private_runner/src/claude-backend.mjs) は発話ごとの process の既存 instruction 組立を利用する。

Codex の追加 context はその発話の user message 直前の developer message としてモデルへ届く。過去の developer message は provider 内部履歴に残るため、参照が存在しなくなるとは保証しない。短い参照の分だけ履歴とトークンが増える。現在の参照の明示と Runner 側の失効・世代照合で、古い参照による操作を拒否する。ユーザーの表示履歴や本文には加えず、履歴の書き換えも行わない。
native subagent は親が明示した同じ参照だけを使い、別セッションへの `send` には引き継がない。
履歴の古い参照、スケジュール、要約・分類・checklist preflight からは操作できない。
参照は誤配送防止であり、同じ Bearer を読める同一ユーザーのプロセス間を隔離する認証境界ではない。

[agent client の raw fallback](../expo/src/features/agent/client.ts) は agent service を通らないため、初期版の呼出元は neutral agent 経路に限定する。
raw に context を偽造せず、制御不能を明示し、新しい raw 専用経路は増やさない。
移動先として通常 Codex / Claude チャットを開くこととは別の制約である。旧アプリ・origin のない旧 turn は従来動作を維持する。

## 9. 実装契約: 一つのマイクと、切り替え後の生存期間

端末の録音 owner は一つ。AppRoot の既存登録境界に surface、target、generation、最新 hook snapshot と操作関数を持たせる。
手動開始、音声画面の自動開始、CLI 切り替えを同じ所有権取得に通し、hook の retry・返信後再開・前面復帰は所有権を保つ間だけ許す。
遠隔操作だけを直列化し、画面の直接 start を残す修正はしない。
owner generation は明示的な開始/停止意図・所有先の変更で進める。hook の sessionVersion と分け、通常の segment 確定・補正・返信後再録音では進めない。

`handoff` は第3節の順序に従い、元 native 終了前に先を開始しない。
別対象へ移る場合は、元 surface の新規読み上げ権限を失効させてから、元 target と message に一致する TTS stream・再生だけを解放する。呼出元 LLM の完了を待つ TTS と、CLI の完了を待つ LLM の循環待ちをここで除去する。native 音声の解放は共通の所有権取得 barrier に含め、取消後の手動録音も解放確認前に開始しない。`stop` と同対象への `handoff` は元の返答 TTS を維持する。
診断は `voice_control` の operationId・有限の stage / reason と、開始待機の TTS / 画面条件だけを記録する。会話本文・認証情報・controlContext は追加しない。
停止 await 後にも元 draft を再確認し、新たな本文があれば unmount せず停止済みの部分結果を返す。
オーケストレーション draft は画面 local state なので、保持用 store を新設せず、元に draft があれば遷移前に拒否する。
移動先 draft が restore 後に判明した場合は、元停止・画面移動までの部分結果とし、移動先を録音しない。
移動先の別 LLM turn が実行中なら `target_busy`。その終了まで予約しない。
権限未許可なら `permission_required` として既存手動 UI へ案内し、遠隔で初回 OS ダイアログを開かない。

同じ対象への `handoff` が呼出元 LLM の返信・TTS 待ちになる場合は、直ちに `pending / waiting_for_caller_reply` を返す。
スキルは完了 polling で自身の turn を塞がず、「この返答の後に開始します」と予定を伝えて終了する。
受理済み操作は run 終了後も元の期限内だけ生存し、アプリが実開始を確認して結果を確定する。期限超過なら開始しない。

`stop` は同じ owner の pending 開始・案内・handoff 待ちをキャンセルし、長い readiness 待ちの後ろに並べない。
別 owner へ移譲済みなら古い origin の停止は拒否する。unmount・background・disconnect でも開始待ちを解除する。
期限・世代は実行直前と非同期 callback で再確認し、期限切れの後から開始しない。既に開始した失敗なら停止完了を確認して結果へ含める。
切断中の命令を保存せず、再接続・前面復帰だけで遠隔録音を再実行しない。

移動元画面の unmount で、操作を呼んだ run・CLI・結果台帳を失わない。結果を元画面 callback / subscription の生存に依存させない。
元画面が所有する TTS は既存 cleanup に従う。遅い元 LLM 返答の自動 TTS は surface instance と target が現在の前面 interaction owner に一致する場合だけ許し、移動先マイクを preempt しない。
同一画面での停止は TTS 権限を失わせず、音声 owner generation の変化だけを TTS 抑制に使わない。元の返信本文は履歴に保存する。

## 10. 実装契約: CLI・配送・結果

以下の名前・パスは新規案。既存 `send` と Codex session mode 用の既存 `handoff --backend ...` は変更しない。

```sh
node <skill>/scripts/bitty-session.mjs orchestrators
node <skill>/scripts/bitty-session.mjs control status --context ctx_123
node <skill>/scripts/bitty-session.mjs control stop --context ctx_123
node <skill>/scripts/bitty-session.mjs control handoff --context ctx_123 < target.json
node <skill>/scripts/bitty-session.mjs control result --operation epochA.00000000-0000-4000-8000-000000000126
```

変更コマンドは選択肢であり、同じ context で順番に実行する例ではない。
`orchestrators` は既存 WS `voice.orchestrators.list` を再利用する。
context と operation の HTTP 境界は次だけにする。

- `GET /app-control/contexts/:id`: context と origin の観測状態。
- `POST /app-control/operations`: `stop` / `handoff` の受理。
- `GET /app-control/operations/:id`: 結果照会。

CLI は context 応答の Runner epoch と generation を取得し、`epoch.UUID` の operation ID を送信前に生成する。
LLM に世代を推測させない。ID のみ stderr に通知し、stdout は JSON 1個。本文・token を shell 引数へ入れない。

```json
{"operationId":"epochA.00000000-0000-4000-8000-000000000126","context":"ctx_123","action":"handoff","expectedGeneration":8,"target":{"kind":"orchestrator","orchestratorId":"main"}}
```

```json
{"channel":"control","op":"app.control.execute","operationId":"epochA.00000000-0000-4000-8000-000000000126","payload":{"action":"handoff","surfaceId":"panel-a","expectedGeneration":8,"connectionGeneration":3,"expiresAt":"2026-10-18T10:00:10Z","target":{"kind":"orchestrator","orchestratorId":"main"}}}
```

```json
{"channel":"control","op":"app.control.result","operationId":"epochA.00000000-0000-4000-8000-000000000126","payload":{"status":"applied","generation":9,"desired":"listening","observed":"recording","target":{"kind":"orchestrator","orchestratorId":"main"}}}
```

ACK は配送先の同じ接続・接続世代・operation ID からだけ受理する。HTTP 202 や WS 書込成功は操作完了ではない。

| 結果 | スキル / アプリの扱い |
| --- | --- |
| `applied` / `already_applied` | native を含め指定状態を確認済み。完了と伝えられる。既に止まっている停止も成功 |
| `pending` | 受付済み・開始待ち等。`result` で照会し、新しい操作 ID で再送しない。同一対象の返信待ちは第9節に従う |
| `target_not_found` / `target_ambiguous` | 対象を確定し直す。別候補を自動実行しない |
| `target_busy` / `draft_conflict` | 本文を処分せず、現在地・音声状態・拒否理由を返す |
| `stale_origin` / `owner_changed` / `context_expired` | 古い発話元を復活させず、別 owner を操作しない |
| `client_offline` / `client_background` / `permission_required` / `capability_unsupported` | 別端末へ送らず、実行できない条件を返す |
| `failed` / `operation_status_unknown` | 失敗と不明を区別し、観測状態を添える。成功を推測しない |
| `operation_conflict` | 同じ ID の異なる要求を HTTP 409 で拒否 |

Runner は subject + operation ID、要求 hash、origin、期限、最終結果を上限付き runtime cache に保持する。
同じ ID / 同じ要求は同じ結果、別要求は conflict。context 再検証より先に既受理 ID を照合し、自身の停止・移動で origin が無効になっても結果を返す。
live context の受理済み ID は最終結果 cache と別に context 終了まで保持し、結果が破棄されても再実行しない。アプリも接続中の重複実行を抑止する。
Runner 再起動前 epoch の ID は新規実行として受け付けない。cache 消失や ACK 喪失時は照会し、不明なら `operation_status_unknown`。同じ ID の POST を結果照会の代わりに使わない。
最終結果保持は15分・固定件数上限、実行期限は stop 5秒 / handoff 15秒を初期案とする（LLM の理解時間は含まない）。遅い ACK は台帳へ記録できるが、期限切れの新規実行は許さない。
既存 agent operation store に UI 操作を混ぜず、永続コマンドキューは作らない。独立した配送・台帳だけを小さな `app-control-service.mjs` にまとめる。

## 11. 機能単体ではなく、会話が成立したことを検証する

以下は会話全体・実機での受入計画であり、実行済みではない。共通処理と境界の自動テストは第12節の範囲で実施した。

| 会話として通す検証 | 合格条件 |
| --- | --- |
| A で会話→「音声入力を止めて」→独り言 | 両画面で native 停止。LLM/TTS は完了でき、30秒後も再録音・送信なし。接続中・補正中・送信候補・返信/TTS 待ちでも同じ |
| A→「昨日の〇〇を開いて音声で話したい」→候補確認→「設計相談」→B に相談→メインへ帰還→停止 | 確認中は次の声が A に届く。確定後は元終了から先開始まで排他。対象案内・native 確認後の開始合図・入力中表示を経た次の声は B だけへ届く。切り替え指示・確認の声・元 draft を B の本文へ転送しない |
| 通常 A→通常 B、主オーケストレーター→別オーケストレーター | 同じ手順で対話が移る。通常↔オーケストレーションも通し、provider ごとに別制御を作らない |
| 候補なし・同名・未送信本文・移動先実行中 | 勝手に決めず、事前拒否なら A の入力意図を維持。停止後の問題なら部分結果と現在地を知らせ、どこにも本文を送らない |
| B の復元失敗・開始失敗・案内中停止・期限切れ | 元も先も再録音なし。遅い callback と元 LLM の自動 TTS が B を再開・中断しない |
| 同じ対象へ「音声入力にして」 | 呼出 turn を pending polling で塞がず終了でき、期限内の返信/TTS 終了後だけ native 開始。開始前には完了と言わない |
| 複数端末・同一 session の複数 panel・手動切替との競合 | 発話元の接続・surface・世代だけを操作。古い停止が新しい owner に届かない。他接続 ACK を受理しない |
| ACK 喪失・切断/復帰・Runner 再起動・同じ ID の再要求 | 二重実行と後日の録音開始なし。不明を成功と答えない。結果照会は移動元 unmount 後も可能 |
| 引用文・履歴の「マイクを止めろ」・単なる「止めて」 | 引用を実行せず、対象不明なら確認。ユーザーの停止・切り替え意図と区別 |

Codex / Claude の通常チャットと音声オーケストレーションで、スキル未読の初回と継続 turn を確認する。
origin が summary / preflight / schedule / 別 session 送信に漏れないことも検証する。
iOS 前面の実機で、OS 権限なし・background・通信切断・TTS 中・連続発話を通す。対応する macOS transport も実収録の開始終了を確認する。
共通フック・アプリ所有権・Runner/CLI の自動テストは、この会話で起きる遅延・取消・重複を再現するために加える。

「停止したのに収録中」「次の相談が違う会話先へ届く」「停止・期限切れ後に勝手に録音開始」は0件を出荷条件とする。
意図一致率、対象一致率、必要な確認の実施率、操作成功率、誤実行率、結果不明率を、固定した日本語の依頼・言い換えで測る。
時間は発話確定→CLI 要求、アプリ受信→native 終了/開始を分けて P50/P95 を測る。
token はスキル未読・初回読込・継続 turn と Codex / Claude / 音声を分け、短い context 参照による増分も測る。
現時点で削減量・精度・応答速度の測定値はない。診断ログは ID・状態・時間・エラーコードに限定し、発話本文・音声・認証 token を記録しない。

## 12. 実装と検証の範囲

[app-control-service.mjs](../private_runner/src/app-control-service.mjs) に有限の操作配送・期限・結果台帳をまとめ、既存の認証と承認済み workspace / session を利用した。発話元の参照は受理された対話 invocation にだけ追加し、ユーザー本文・操作 hash・共有 provider 設定へ混ぜない。別接続の ACK、古い世代、期限切れ、再接続後の再実行を拒否する。

[voiceControl.ts](../expo/src/features/appControl/voiceControl.ts) と [useControlledStreamingStt.ts](../expo/src/features/appControl/useControlledStreamingStt.ts) に両画面のマイク所有権を接続した。既存の共通 STT で停止・補正・返信待ちを解除し、画面が閉じた後も native 終了待ちと失敗を保持する。移動先の開始はこの操作自身が行い、通常の画面初期自動開始へ委ねない。AppRoot / server-runtime / voice-context-service の関連のない分割や、永続コマンドキュー・汎用 RPC は追加していない。

管理原本の [スキル](../skills/bitty-session-orchestrator/SKILL.md) と CLI は既存の session / board 操作を維持し、stop / handoff とその補助読取だけを追加した。HTTPS または loopback HTTP に限定し、redirect、token の不正権限・形式、不正な対象指定を拒否する。POST の自動再送は行わない。installer は既定で dry-run、未管理の既存内容には照合と保存を要求する。

自動検証は Runner の認証・世代・期限・重複・初回 session 解決・provider 回帰、CLI / installer の一時 fixture、両画面の共有フック・マイク排他・遅い callback・停止後の再開防止・draft・macOS transport を対象とした。独立レビューと、親の結論を渡さないスキルの模擬操作確認も行った。TypeScript は通常・macOS の両設定を確認し、Swift は構文確認を行った。テストは偽 Runner / transport と一時ファイルを利用し、実マイク・実 LLM の操作や稼働中 Runner の変更は行っていない。実機で停止できなかった報告を受けた調査では、稼働中 API とアプリ診断ログのメタデータだけを読み取った。追加の回帰検証は実 RunnerWebSocketManager の handshake と、実 Codex app-server を一時領域・ローカルの偽 Responses provider で動かす境界テストを含む。後者はインストール済み Codex 0.160.1 の継続 thread で参照 A → B → 操作不可をモデル要求まで照合し、既存セッションや認証情報、実 LLM に接続しない。古い Codex で同じ追加 context 契約が使えるかは未検証。

残る受入確認は第11節の実機会話、TTS / 合図の回り込み、OS 権限、実際の provider におけるスキル発見・CLI 実行権限、token / 精度 / 応答時間の測定である。Claude の dontAsk profile は既存の `--safe-mode` によりスキル発見が無効で、この構成で操作が使えるとは保証しない。安全モードを外して対応したことにはしない。raw / legacy の呼出には発話元の制御権を発行しない。

Runner の `ws` と Expo の推移依存 `shell-quote` は監査で見つかった脆弱性の修正版へ狭く更新した。Expo の依存監査には今回の音声経路以外の既存警告が残るため、リポジトリ全体が監査上問題なしとは扱わない。
