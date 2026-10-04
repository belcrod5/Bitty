# オーケストレータ活動表示：既存コードの修正計画

作成日: 2026-10-04。設計レビュー後、ユーザー承認を受けて実装中。[実装記録](orchestrator-activity-implementation-results.md)に製品コードとスキルの変更・検証結果を記録する。以下は承認された実装計画。

## 1. 目的と採用する前提

Bitty のセッションを調べる・会話するオーケストレータについて、「誰が、どのセッションに、何をしているか」を Skia ボードに表示する。native サブエージェントの活動には、親の登録オーケストレータのアイコンを使う。

Bitty への操作は `bitty-session-orchestrator` の CLI を使い、通常の実行環境と native サブエージェント機構を引き継ぐ。経路遵守は system prompt と SKILL.md の運用条件とする。LLM に実行元 ID・親 ID・アイコン ID を毎回指定させない。

既存 Bearer は引き続き認証・認可に使う。自動添付する native セッション ID は**表示の帰属情報**であり、認証 owner、workspace ACL、実行権限を変更しない。共有 Bearer の保持者による表示情報の偽装を防ぐ本人認証ではない。

初期の実装対象は、登録済み Bitty voice オーケストレータの Codex root とその native 子孫から行う CLI 操作、およびその native ツール通知。操作先セッションは Codex/Claude の両方を扱う。Claude を実行元オーケストレータとして扱う仕組みは今回の検証対象に含まれない。

## 2. 利用者に見える流れ

```text
ユーザー送信
↓
登録オーケストレータが実行開始
↓
Runner が native root ID と登録オーケストレータ ID を紐付ける
（モデルがツールを実行できるようになる前）
↓
親／native サブエージェントがスキル CLI を実行
↓
CLI が既存 Bearer と実行元 CODEX_THREAD_ID を自動添付
↓
認証済み Runner が実行元の native 親を辿る
↓
登録オーケストレータに帰属する活動を開始／終了
↓
既存 Runner WebSocket でアプリへ通知
↓
個別セッション: カード右上に親アイコンと状態
一覧・ボード全体: 画面固定位置に親アイコンと状態
```

native ツール通知は CLI とは別の入力になる。実行時の `threadId / turnId / item.id` から同じ帰属判定を使う。シェルコマンド本文や時間の近さから API 操作との対応を推定しない。

## 3. 現状から変える境界

パスは、この計画書の worktree ルートからの相対パス。外部スキルのみ絶対パスで示す。

| 既存ファイル／箇所 | 現状 | 修正計画 |
| --- | --- | --- |
| `/Users/daigo-nakamura/.codex/skills/bitty-session-orchestrator/scripts/bitty-session.mjs`: `http`, `runSocket` | HTTP/WS は共通 Bearer のみ付加 | 両方で表示用 `x-bitty-display-caller` を自動付加。値は `CODEX_THREAD_ID`。LLM 用 ID オプションは追加しない |
| 同スキル `SKILL.md` | CLI を使う指示がある | CLI 経路、環境継承、native 子利用、欠損時の表示条件を説明。毎回 ID を指定する指示は不要 |
| `private_runner/bin/bitty-history`: `runnerRequest` | スキルが履歴取得に使う既存 CLI。共通 Bearer のみ付加 | 同じ表示 header を付加し、search は global、read は対象カードへ帰属させる。履歴取得処理を複製しない |
| `private_runner/src/voice-context-service.mjs`: `modelTurn`, `runTurn` | `thread/start` 後に `turn/start`。`onStarted` は turn 応答後、`native_started` 保存用。既存 `observe` は root の応答・制御担当 | root 生成完了時に表示観測を開始する境界を追加。専用の活動通知 listener をモデル実行前に取り付け、root 応答 listener と分ける |
| `private_runner/src/voice-orchestrator-service.mjs`: `loadedContext`, `start`, registry update/remove | 登録 ID/name/icon を所有。`start` で子 Context に渡す hooks を構成 | 実行開始の表示観測へ登録 ID と operation ID を渡す。アイコン変更・削除を表示状態へ反映する。選択中 ID から実行者を推定しない |
| `private_runner/src/agent/agent-runtime.mjs`: HTTP handler 作成、`createWsConnection` | owner は token hash。HTTP と WS を構成 | 認証後に得た表示情報を渡す接続配線を追加。owner と `runEventObservers` は変更しない |
| `private_runner/src/agent/agent-transport.mjs`: `createAgentHttpHandler`, `createAgentWsConnection` | リクエスト・操作・run の受付境界 | HTTP の開始／応答完了・切断、WS の操作受付と run 紐付けを観測。表示処理の失敗を本来の操作へ伝播させない |
| `private_runner/src/skia-board-http.mjs`: `createSkiaBoardHttpHandler` | `board` と `board-remove` は agent HTTP を通らない | 認証済み board リクエストも同じ活動管理へ接続。ボード専用の帰属判定は作らない |
| `private_runner/src/server-runtime.mjs`: 各 service の組立て、`runnerWsServer.on("connection")`, 既存 broadcast | HTTP/WS・voice・board の構成箇所。`req` は WS connection 時点で利用できる | 活動管理を一つ生成し既存境界へ注入。認証済み WS の header を渡す。既存 envelope で snapshot と更新を送る。登録 create/update でも既存 metadata broadcast を呼ぶ |
| `expo/src/features/app/screens/SkiaMiniBoardScreen.tsx`: `BoardCard`, Canvas と固定 UI | カードは memo と `createPicture`、移動は shared value の transform。固定操作 UI も存在 | セッション右上へ活動バッジ。global 活動は board transform 外へ表示。ボードのパン・ズーム性能を維持 |
| `expo/src/features/app/components/VoiceOrchestratorIcon.tsx` | 登録画像と名前の先頭文字 fallback を描画 | global 表示で再利用。Skia カード描画は同じ icon/name 情報で描く。新しいアイコン体系を作らない |
| `expo/src/features/runnerWs/RunnerWebSocketManager.ts` | 汎用 `subscribe` / `request` と generation がある | 原則変更不要。既存機能で活動通知・snapshot を購読する |

`SkiaBoardContext.tsx` は永続ボード正本・revision・同期の責務を維持する。一時活動を board cards、revision、保存 JSON、既読履歴に書き込まない。

経路遵守の system prompt は `voice-context-service.mjs` の既存 `responseInstructions` 合成箇所へ固定の運用指示を付ける。ユーザー保存済み `systemInstruction` を書き換えず、Bitty 操作に当該スキルを使うこと、履歴は既存 `bitty-history` を使うこと、native 子と通常環境を使うことを明示する。新しい prompt 設定項目や別の prompt store は作らない。この指示が技術的なバイパス防止であるとは扱わない。

## 4. 一つの活動管理にまとめる

新規候補は `private_runner/src/orchestrator-activity.mjs` 一つ。責務は表示の帰属判定、実行中活動、通知用 snapshot の管理。HTTP、WS、native 通知という複数の実際の入力で同じ判定と lifecycle を共有するための配置であり、既存 API を転送するラッパーではない。

各 route は認証済みの実行元・既知の操作・対象 sessionRef を渡すだけにする。親探索、状態の合成、cleanup 方針を route/UI に複製しない。Agent Service の既存 `subscribe` を利用し、別の実行エンジンや別の run store を作らない。

メモリ内に必要な状態は以下に限定する。

- native root → 登録 orchestrator ID、voice operation ID、利用可能な既存 RPC client。
- native 子 → 解決済み root の成功キャッシュ、および同一 ID の進行中解決。
- 活動 ID → actor、対象 sessionRef または global、操作種別、開始時刻、現在状態。
- 会話活動は run ID を活動 ID とし、同じレコードに actor と既存購読の解除関数を持つ。別の run 状態表は作らない。WS が切れても run 終了までは保持する。
- 配送用の instance ID と単調増加 revision。短い完了表示は同じ活動レコードの `expiresAt` と一つの期限処理で保持する。アプリ独自の完了タイマーは作らない。

root・run・活動の寿命に合わせて削除し、容量・解決時間・親探索の上限は内部定数にする。新しいユーザー設定やファイル永続化は追加しない。稼働中の状態を容量都合で黙って消して成功扱いにはせず、観測不能を区別する。

### 帰属判定

`CODEX_SESSION_ID` は子でも親の値を引き継いだため使わない。caller の backend は初期実装では Codex として扱い、native ID は backend と組み合わせて保持する。

登録 root なら直接解決。子なら既存 client の `thread/read(includeTurns:false)` で `thread.id` の一致と `parentThreadId` を確認する。到達した登録 root への対応を、辿った子すべてにキャッシュする。成功キャッシュの root がまだ有効か毎回確認する。同一 caller の同時解決は同じ進行中処理を使い、重複 RPC を抑える。

循環、欠損、応答 ID 不一致、深さ上限 10、時間切れ、RPC 切断は unknown。失敗結果を恒久キャッシュにしない。無関係な App Server thread の通知は捨て、現在選択中のオーケストレータや直近の実行者を代用しない。表示の解決待ちが本来の HTTP/WS 操作を止めないよう、観測側だけで非同期に処理する。

### root 登録と初回イベントの順序

現在の `onStarted` は `turn/start` の応答後なので、ここだけに登録を追加すると子の先行 HTTP／tool 通知を取りこぼす。`native_started` の永続イベントを前倒しすると turn ID の意味が変わるため、既存保存処理は維持する。

`modelTurn` の `thread/start` 成功直後、モデル実行可能になる前に表示観測を登録する。`runTurn` から渡す観測境界は登録 ID に既に束縛され、`voice-orchestrator-service` の現在選択値に依存しない。raw 活動 listener と root binding の準備を完了してから `turn/start` を送る。通知が turn 応答より先に来ても thread/item の ID で処理する。

既存 root 応答の `observe` や承認用 `ownsRequest` を活動表示のために緩めない。子の assistant message を root の応答へ混入させない。承認と表示は目的が違うため、共通化を理由に承認判定を変更しない。

### HTTP と WS の寿命

HTTP は認証・対象解釈後に一度だけ開始し、レスポンス `finish` で終了する。完了前 `close` は観測上の中断。close しただけで backend の処理が中断されたとは表現しない。イベント listener は終了時に解除する。短い HTTP が親解決より先に終わっても終了状態を保持し、遅れた解決で活動を再び running に戻さない。

WS の `turn.start` は受付中の短い活動を持ち、`runId` を得たら同じ活動を run に束縛する。返却後に `service.subscribe(runId, { onEvent, actionConsumerId:null }, { subjectId })` で表示だけを購読する。既存購読が受付以前の event replay と今後の `session.resolved`、tool、terminal を扱うため、グローバル run observer、独自 sequence buffer、独自 inspect/replay 機構は追加しない。再送された同じ run は既存活動を使う。購読時に既に完了した run も返却 result と既存 replay で処理し、terminal 後に必ず unsubscribe する。

表示用 `onEvent` は callback 内で例外を捕捉する。既存 publish と subscribe の同期呼出しへ表示の例外を投げず、承認 consumer や本来の run 状態を変えない。活動 binding/listener の準備失敗も観測不能として記録し、モデル実行の新しい失敗条件にはしない。

`send/new` の終了は CLI socket の切断ではなく実 run の terminal。承認待ちでも会話活動は継続するが、初期表示は「会話中」に統一する。非 action 購読には所有済み `action.requested` が届かないため、専用の承認待ち表示や action observer は追加しない。`wait/respond` による再接続、`events.resume`、同一 operation の再送は活動を二重開始しない。別の caller が既存 run を待つだけで、元 run の actor を上書きしない。respond の操作そのものを表示する場合は短い独立活動にする。表示購読は承認を claim せず、既存 consumer の権限を変えない。

### native ツールと終了処理

tool identity は `backend + threadId + turnId + item.id`。`item/started` / `item/completed` の command、file change、MCP、dynamic tool、collab、web search、image view を対象にする。reasoning、user/assistant message、補助的な subAgentActivity を tool と誤認しない。

開始と終了の重複を吸収し、終了だけを受けても終わった活動として処理する。失敗・非ゼロ exit は失敗表示。root／子の turn terminal は、その turn の未完了 tool だけを閉じる。他の並行 turn まで消さない。

現 `modelTurn` は finally で client を閉じる。**表示機能を理由にこの所有権・接続寿命・承認処理は変更しない**。活動 listener も同じ寿命で解除する。通常の native 委任は既存指示どおり子の結果を待って root が終了する経路を対象にする。

root が先に終了して native 子だけ残る経路は、通常経路との違いを先に実測する lifecycle gate とする。root 接続を閉じた場合は未完了 tool を観測不能として扱い、成功完了と表示しない。この場合に終了後の子のライブ追跡まで必要なら、接続の延命を自動採用せず、既存 runtime で観測できるか・必要な寿命変更の負担を別途評価して実装前に報告する。結果待ちをしない経路まで完全追跡できるとの主張はしない。

HTTP で開始した target run は root voice turn が終わっても継続し得るため、capture 済み actor と run 活動は実 run terminal まで保持する。root の探索 client が閉じても、既に帰属が決まった run の通知は Agent Service で継続する。

## 5. 操作と表示位置

| 操作 | 対象／位置 | 状態例 |
| --- | --- | --- |
| sessions、workspaces、models、board、全体検索 | global、画面固定 | 取得中… |
| 個別 history/conversation、handoff | API から得る backend + session ID のカード | 取得中…／切替中… |
| send、既存 sessionRef への turn.start | 対象カード | 会話中… |
| new | session 未確定時は global、session.resolved 後は同じ活動をカードへ移す | 開始中…／会話中… |
| board-remove | 初回 board GET は global、removeCard は対象が一意に分かる場合に対象カード | 取得中…／更新中… |
| native tool | 対象セッションを構造化情報で確定できるときはカード、それ以外は global | ツール名＋実行中… |

native 子の CLI command と target API の活動は別の ID を保つ。API 側は対象カード、コマンド側は対象不明なら global。ツール名・実行者を表示できても、CLI の command text から target session を解析しない。

同じカードで複数の親が活動するときは親ごとにアイコンを並べ、同じ親の複数活動は件数・状態としてまとめる。一つが終わっても残りがある限りアイコンは消えない。API と tool が同じ動作であることは証明されていないため、時間ベースの重複除去はしない。

対象カードがまだ取り込まれていない・削除済みの場合は global に対象付きの状態を表示し、活動表示のためにカードを勝手に作らない。古い backend 未指定カードは既存 session 情報で一意に照合できた場合だけ使う。同名・同 ID の異なる backend を混同しない。

登録画像が空なら既存の名前先頭文字 fallback。画像デコード失敗も fallback を出す。unknown caller に誰かの登録画像を付けない。

短い完了も認識できるよう、Runner の同じ活動レコードを終了後もしばらく保持し、完了／失敗として通知する。寿命処理を Runner の一つの期限管理へ統一し、アプリは snapshot を描くだけとする。終了済みを実行中として引き延ばさない。保持時間は既存 UI の表示と実機での視認性を比べて決め、根拠のない固定閾値を先に合格条件にしない。

## 6. 既存 WebSocket での配送とアプリの保持

新 REST endpoint、別サーバー、ポーリング、個別 credential は作らない。既存 `/runner-ws` envelope に additive な `control` の活動通知を追加する。候補 op は `orchestrator_activity_updated` と `orchestrator_activity_snapshot`。これは表示の通知契約の追加であり、専用の認証 API ではない。

snapshot はアプリの購読開始／再接続／foreground 復帰で取得できるようにする。汎用 `request` に snapshot を返し、同じ既存 envelope を利用する。通知には instance/revision、活動 ID、登録 orchestrator ID、対象 sessionRef、種別、状態を含める。native caller/parent ID、token、プロンプト、コマンド全文、会話本文はアプリへ配送しない。

小さい全活動 snapshot を更新時に送る方式を採用し、差分適用・長い再送ログを追加しない。**活動 snapshot に画像や登録 metadata 辞書は載せない**。icon は最大 1 MB のため、ツールごとの再送を避ける。アプリは既存 `voice.orchestrators.list` で取得し、既存 `voice.unread.changed` の登録リストで更新する。現在 create/update はこの broadcast を呼ばないため、同じ既存通知をそこで呼ぶ小さい変更を含める。別の metadata 同期プロトコルは作らない。snapshot 更新方式は同時活動数と送信量を製品経路で測り、通常操作への負担が大きい場合は同じ状態正本の配送方式を再検討する。

アプリ側の新規候補 `expo/src/features/app/hooks/useOrchestratorActivities.ts` は、この機能の購読・現在 snapshot・既存登録 metadata の保持だけを担当する。既に screen にある unread metadata 購読との重複を避け、一箇所からアイコンと unread を使う。Skia screen が一度利用する具体的な hook であり、汎用 event store や独立した完了タイマーは作らない。Runner URL/token が変わったら状態を破棄する。切断時は stale な running を断定表示せず、再接続の snapshot で正本へ置き換える。古い instance/revision の応答が新しい通知を上書きしない。

カードアイコンは既存 `BoardCard` の memo 描画に活動情報を渡す。右上領域を確保し既存 unread／タイトルと重ならないようにする。Skia 画像は icon ごとに再利用し、picture の依存値に活動の内容キーを含める。パン・ズームで毎フレーム picture 再生成や React setState を起こさない。global は transform 外の既存 RN overlay で `VoiceOrchestratorIcon` と短い状態を描き、操作を遮らない。

## 7. 外部スキルの扱い

現在 repo にこのスキルの canonical source や同期入口はなく、インストール済み原本だけがある。候補テストは原本の一時コピーを変更して検証した。

実装では既存スキルの `http` と `runSocket` を直接更新し、同じコードの repo コピーや新しい転送 CLI を追加しない。`CODEX_THREAD_ID` が空の通常 CLI 利用は従来どおり操作可能で、表示の actor は unknown とする。header を引数から指定する仕組みは作らない。

スキルの変更は repo PR だけでは配送できないため、実装成果物で外部変更の正確な diff と適用先を別途記録する。原本を勝手に上書きせず実装時に最新版と照合し、権限が必要なら通常のファイル変更承認を使う。スキルの repo 管理化や配布基盤の新設はこの可視化タスクへ混ぜない。

個別履歴を読む `bitty-history` はスキルから利用する別の補助 CLI。実ファイルは repo 内 `private_runner/bin/bitty-history` にあり、`runnerRequest` 一箇所が既存通信入口である。ここも同じ header を自動付加する必須修正対象に含める。search は `/agent/session-history/search`、read は `/agent/session-conversation` を通るので、agent HTTP の活動管理を再利用できる。名前取得用の補助 `/client-state` は独立した利用者操作として表示しない。履歴を orchestrator CLI に重複実装せず、新しいスキルも作らない。この補助 CLI の実 native caller 自動付加は既存実機テストでは未検証のため、新しい回帰テストを必要とする。

## 8. 実装の順序と合格条件

### A. 起点と活動管理

root binding を `turn/start` より前に用意し、同じ client から native 活動を購読する。登録メタデータと親探索の正の cache を活動管理に置く。テスト候補内のロジックをそのまま大量移植せず、製品境界を実装しテストを製品 import へ切り替える。

合格: root の初回 tool、応答前に来る子通知、登録 A→B→A、複数同時 root、depth 1/3/10、未知・循環・不一致、削除・画像変更、RPC 切断・同時解決で正しい actor または unknown。summary の内部 turn を利用者の活動として出さない。

### B. HTTP/WS と native lifecycle

外部 CLI と既存履歴 CLI の自動 header、agent HTTP、board HTTP、認証済み WS 接続、受付 run と既存 subscribe をつなぐ。元の戻り値・認証・認可・実行順を保つ。

合格: 実コードで HTTP success/error/実 socket abort、短い応答が解決より先に終了、WS detach/resume、operation replay、queued→running→terminal、承認待ちでも活動継続かつ action 権限不変、session.resolved による global→card 移動、失敗・中断、root 終了後の target run 継続。子を待つ通常 native 経路と接続喪失時の unknown を検証し、接続寿命は維持する。活動処理を失敗させても本来の操作は成功し、不正 Bearer は従来どおり拒否される。

### C. 配送と Skia

既存 WS の snapshot 契約、hook、カードと固定表示をつなぐ。最初に correctness を満たし、短い snapshot の実サイズと描画負荷を確認する。

合格: カード右上／固定位置、親画像 fallback、二親同カード・同親二活動、短い GET、Runner の期限処理が別活動を消さないこと、completion-only、対象なしカード、再接続・foreground・設定切替・旧 snapshot 到着で正しい表示。登録画像更新の反映と、活動通知に画像が入らないことを検証する。パン・ズーム中に固定表示が動かず、カードは位置に追従し、メニュー・ジェスチャを遮らない。

### D. 製品境界での最終確認

現在の候補テストが分けて検証した「実 CLI HTTP → Runner 帰属判定 → WS 配送 → UI」を、製品コードで通し確認する。通常は listen 不要の HTTP/WS doubles と fake native client、UI renderer で自動化する。実 socket abort は isolated local fixture が必要で、常用 Runner を停止・再起動せずに検証する。現時点ではこの fixture も未作成。

provider turn を使う probe は opt-in で、temp 登録／own ephemeral root・子だけ、既存ユーザー会話は読まない。LLM に caller/parent ID を与えずに root と子を実行する。最終的な実機 Skia 確認は実装後にユーザー検証コマンドを提示して行う。今回の計画書作成では build・server 起動・再起動をしない。

### 実装を増やさない受入制約

活動の追跡には root と子の帰属、進行中操作、終了状態という最低限の一時状態が必要であり、厳密な「複雑化ゼロ」は保証しない。ただし正本と回収責任は `orchestrator-activity.mjs` 一箇所に置き、route、voice service、アプリに別の活動表や期限管理を作らない。実装差分では各 Map と timer の用途・削除時点・実 call site を説明し、未使用の状態や薄い wrapper は削る。

新しい設定、外部依存、永続 store、認証・認可方式、接続 pool、新 REST endpoint は追加しない。既存 `subscribe` と Runner WS の汎用 `subscribe` / `request` で扱えないことが製品テストで示された場合は、必要な契約だけを再設計し、代替機構を積み上げない。表示障害は本来の HTTP/WS 操作・承認・voice 応答を失敗させず、unknown として観測できることを合格条件にする。

製品境界のテストで listener、購読、Map、期限処理が各状態の寿命に従って回収されることを確認する。root close では root の観測資源を回収し、帰属済み target run は terminal と短い完了表示の期限まで保持する。WS 再接続では旧接続の購読だけを解除し、継続中の活動は消さない。root が子より先に終わる経路も gate に残し、実際の観測終了点と残る子の表示を記録する。接続寿命の変更が必要と判明した場合は、その影響を測って計画を再設計してから実装する。制限を黙って除外したり、接続延命や poller を足して押し切ったりしない。

通常経路の性能は、同じ環境・同じ規模で変更前後の HTTP/WS 応答、native 親照合 RPC 回数、活動 snapshot のサイズと配送頻度、Skia の picture 再生成・パン／ズーム負荷を繰り返し測り、ばらつき、表示の効果、追加負担を報告する。微小な必要負担と測定誤差を区別し、持続的な応答遅延・継続資源増加・操作体感の問題があれば、原因を特定して設計を簡素化し直す。達成基準は実測に基づいて報告し、候補テストの暫定目標や実機未測定の値を製品の合格閾値として流用しない。

## 9. 実装時に実行する確認

Runner は新規 `orchestrator-activity.test.mjs` と、変更した境界の既存テストを実行する。少なくとも以下が回帰対象。

```sh
node --test private_runner/tests/orchestrator-activity.test.mjs private_runner/tests/agent-transport.test.mjs private_runner/tests/agent-runtime.test.mjs private_runner/tests/agent-workspace-admission.test.mjs private_runner/tests/voice-context-service.test.mjs private_runner/tests/voice-orchestrator-service.test.mjs private_runner/tests/skia-board-endpoint.test.mjs private_runner/tests/conversation-history-cli.test.mjs
```

アプリは活動 hook と screen の関連 Jest、および `expo/package.json` の `typecheck` / `typecheck:macos` を使う。既存 Skia/WS テストも変更箇所に応じて実行する。追加テスト名は実装時に確定し、未作成のテストを実行済みとして扱わない。外部 CLI は `node --check` と HTTP/WS 両方の header 自動付加・欠損・既存出力の回帰検証を行う。

速度は製品経路の合計を改めて測る。候補の実 RPC を含む fresh p95 約 78 ms、warm 約 0.002 ms は in-process の測定であり、HTTP 配送・実時間通知・UI を含まない。実 native の深い親経路と UI 描画性能は追加計測対象である。変更前後のベースラインと各区間の測定値を併記し、根拠のない新しい数値 gate は設定しない。

## 10. 証拠、残る確認、今回の成果物

実現可能性の証拠は [試験結果](orchestrator-activity-test-results.md) と [試験計画](orchestrator-activity-test-plan.md) を参照。実 native 子 2つ、CLI GET 成功、親同定、tool 開始終了は確認済み。既存 Bearer owner/ACL を維持する候補境界も検証済み。製品での初回順序、ライブ配送、Skia 描画、API/tool 相関、子が root より長く生存する観測寿命は未確認。

`voice-subagents.mjs` の managed delegation は既存 `orchestratorId/runId/sessionRef` 記録を持つ別経路。native parent の方式へ置き換えない。今回の CLI/native 経路に加えて managed delegation 自体の表示を広げる際は、その既存記録を同じ活動管理へ入力し、別の帰属 store は作らない。

初期実装の完了は「上記対象経路で実製品の活動表示と回帰テストが成立すること」。経路逸脱、環境削除、独立エージェント、Claude caller まで全操作を強制追跡したという主張はしない。履歴補助 CLI は初期の修正対象に含め、既存試験の証拠で未検証部分を隠さない。さらに必要な範囲追加は既存通信境界への小さい適用として扱い、本人認証の強化とは分ける。

今回の成果物はこの計画書のみ。製品実装、外部スキル変更、新しいテスト実行、build、server 再起動は行っていない。今回の修正は状態責任、回収、障害分離、性能比較の受入制約を追加した。この修正版は別エージェントの独立レビューで APPROVE（設計計画として）。文書参照・余白確認済み。レビューは製品テストや実動作の証明ではない。実製品の初回順序、UI 描画、root 先行終了後の子の観測範囲は引き続き未検証である。
