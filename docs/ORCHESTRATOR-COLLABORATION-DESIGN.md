# 複数オーケストレーターの相談チャット設計

作成日: 2026-10-28。更新日: 2026-10-30。状態: 独立テキスト相談を実装、ローカル回帰検証済み。実native／実機は未検証。ユーザー合意、設計提案、未検証の制約を分けて記録する。

## 現在の合意

**通常defaultの挙動を維持し、既存本人への変更を極力小さくして、同じ本人を相談へ呼び出す。** 相談参加中も、本人の指示・実行・承認・タスク・セッション切替・メモリ・学習は既存どおりとする。本人を複製せず、将来の本人への修正が相談でもそのまま適用される同一実装を使う。
相談側だけが順番・参加者・共有ログ・入力差分・有限上限・別UIを持ち、共通のメッセージ送信／実行処理から本人へ依頼する。必要なら汎用の入口引数を最小限追加するが、本人処理のコピーや相談専用の学習採用schema変更は行わない。
相談テンプレートは追加の会話上の依頼であり、本人の通常設定を上書きせず、別人格・別の機能判断基準を作らない。通常textだけでも依頼は渡せる。設定を汚さず追加指示を明示注入する場合や別sessionを使う場合は、小さな任意入口を追加した。

回覧板は通常チャットと別UIの相談roomとし、通常画面の選択中オーケストレーターを変更しない。
`A → B → C → A …` と一人ずつ回し、BはA、CはA+B、次のAはB+Cを読んで考え直す。話すことがなければ見送れる。Aだけの報告・総括には戻さない。
新しいhosted agentと既存本人が同一とは仮定せず、新本人・別runtimeの複製で代用しない。
**別UIと通常選択維持に加え、任意conversationKeyで通常とは別の会話state／native threadを保持する実装を追加した。同じ本人workspace・memory・learning・実行処理を使う。実nativeでの最終確認は残る。**

大きなowner基盤再設計・source-aware memory／analyzer変更は行わない。招待だけは相談scope限定のnative toolを既存呼出し境界へ接続する。変更ゼロを必須とした前方針は、通常default維持と必要最小の入口変更を許す最新方針へ置き換える。以下では実装済みの独立相談と、実モデル未検証の自然文招待・その他の未検証境界を区別する。実装と試験の一覧は[実装記録](ORCHESTRATOR-COLLABORATION-IMPLEMENTATION.md)を参照。

## 1. 相談と本人の境界

`orchestratorId` は既存本人、`roomId` は相談側の共有会話、`runId` は相談側の一手番を識別する。
新しいconsultation controllerから共通の送信経路を呼び、本人の実行・workspace・タスク・メモリ・学習を通常どおり使う。[既存の分離契約](ORCHESTRATOR-ISOLATION.md)を維持する。
本人の私的履歴を他の参加者へ丸ごと配布せず、他者のworkspaceやメモリを直接読まない。共有対象は議題、許可された抜粋、roomに公開された発言に限る。

現状の[本人サービス](../private_runner/src/voice-orchestrator-service.mjs)は明示的な `orchestratorId` で宛先を選べるため、registryの選択中IDを変える必要はない。
[context.start](../private_runner/src/voice-context-service.mjs) 自体は引き続きそのcontextのactive.logicalConversationIdとの一致を要求する。本人サービスが任意conversationKeyでscope contextを選び、同じfactory／runTurnへ接続する。
未指定なら通常context、roomキーなら別active・events・native threadを使う。本人workspace・memory store instance・設定参照・learningは共通とし、相談pairも既存のメモリ・学習処理へ従来の基準で入る。
通常の履歴UIには相談pairを混ぜず、私的セッションのclear・切替、新本人、native直呼びで分離を代用しない。

### 実装した任意入口

任意の `conversationKey`（UUID）を追加し、未指定は現在の通常会話、roomキー指定時は会話状態・native sessionを分ける。`additionalInstructions` はrun単位のsnapshotとして通常指示へ合成し、通常systemInstructionには保存せず、開始・再開へ渡す。追加指示の対象は当該run／scopeの会話応答に限り、既存preflight・summary・topic判定・learning analyzerへ一律追加しない。公開送信は既存WebSocketメッセージへ同じ引数を載せる。
現factoryは関数なので派生クラス化は不要であり、全処理へ `mode === consultation` を撒かない。controllerはroom進行・入力組立を持ち、本人実行をコピーしない。
引数追加だけで成立すると断定しない。現rootにstate・workspace・memoryが結合し、inFlightもcontext単位である。root丸ごとの差替えではなく会話stateだけを分ける必要がある。本人workspace・memory等の共通資源を保ち、本人の共通実行枠、共有memoryの単一writer・採番を実装前に確認する。通常contextが共有資源・summaryを一組だけ所有し、全scope証拠をmemory／learning高水位の回復前に集める。設定／clearの永続世代でscope親失効の取りこぼしを補完する。
[モデルを呼ばない境界検証](ORCHESTRATOR-COLLABORATION-BOUNDARY-PROBE.md)では、既存factoryの一時copyへの小patchで別state／native threadと同一workspace／store・run別指示の接続を確認した。共通busy・長期summary・全process再起動・自動設定追随まで成立した結果ではない。

### UI導線の提案

[ボード下部](../expo/src/features/app/screens/SkiaMiniBoardScreen.tsx)のmic隣に「相談」アイコンを置き、独立相談一覧→新規→登録済み本人のアイコンを複数選択→空room作成→通常の最初のメッセージを送信とする導線を実装した。
[通常音声画面](../expo/src/features/app/screens/VoiceConversationScreen.tsx)の本人切替と独立し、相談ヘッダーには参加者と設定、相談設定にはテンプレート・返答上限の編集を置く。履歴吹き出しは通常音声画面と同じcomponent、入力は通常オーケストレーターチャットの実StreamingSttFooterを使い、黒いpanel・Skia glow・Enter送信・応答／読み上げ状態表示をそのまま共用する。別styleのmanual表示やChatComposer／全画面入力は置かない。相談だけは応答表示のタップから補足入力へ移れ、読み上げ中のタップは従来どおり読み上げ停止を優先する。途中追加UIは設けていない。
[相談画面](../expo/src/features/app/screens/VoiceConsultationScreen.tsx)は独立したテキストUIで、閉じても相談の本人実行を停止しないが、この画面の読み上げ待ち行列と所有音声は終了する。通常と同じ音声job lifecycle・句点segmenter・本人の声設定を使い、生成中のfinal本文が「。」に達した部分から合成を始め、音声受信後に順に再生する。完了後の全文再合成はしない。履歴は手動再生できる。表示中roomの一時購読だけが合成を許可し、購読完了を待って送信・再開する。途中で開いた場合や再接続は次のaccepted runからで、進行中の過去prefixや履歴を再合成しない。STT音声surfaceを持たないため、端末のマイク停止／音声移動に使うapp-control originは無い。既存のorigin無しと同じ制限であり、本人tool全般の無効化ではない。

### 公開紹介と自然言語の招待

[既存の個人設定](../expo/src/features/app/components/VoiceOrchestratorManager.tsx)に「得意分野・担当」を追加した。本人registryの公開紹介一項目を正本とし、相談側の別編集storeを撤去した。通常systemInstructionには保存しない。roomは手番の準備時に最新の紹介を読み、進行中runの名簿snapshotは固定する。
自動生成はmodelとeffortを選んで下書きを作る。直近12メッセージ（各1500文字まで）と採用済み学習10件（内容600・条件300文字まで）を既存tool-free ephemeral実行へ渡し、全文メモリは走査しない。結果は編集欄へ置くだけで、明示的な通常の保存まで採用しない。紹介はtool保有・実作業許可の証明ではない。

招待はAIが通常文で「Dも呼んでいい？この相談内の履歴を共有します」と尋ね、ユーザーの普通の返答を読んで本人モデルが判断する。別の分類AI・厳密な承認state machine・専用カード／ボタン・返信全体JSON指定は作らない。
実際の参加効果はscope限定native tool `consultation.invite({orchestratorId})` が持つ。controllerは登録済み本人、active room／run／世代、重複、最大8人を検査し、本人の正常終了後に末尾追加する。確認はpromptに委ねる設計であり、誤解釈しないことをcodeで保証したとは扱わない。「メールはDだよ」や他者の賛成を承認と取り違えず、不明なら普通文で聞き直すよう依頼する。
追加本人にはこのroomの公開履歴を一度渡し、以後は差分を送る。私的会話は配布しない。既存参加者にも参加通知と更新名簿を次入力で知らせる。加入はpassをresetするが手番・時間の上限は増やさない。通常scopeには招待toolを登録しない。旧相談native親にtoolがない場合は既存親切替で安全に登録し直す。実nativeでの招待判断・実行は未検証。

## 2. 相談側が持つ状態

room共有ログを正本に、参加順・次手番・本文version・各本人へ渡したcursor・現在run・pass・停止状態・テンプレートを保持する。
共有発言は `seq / speakerId / source / text` と発言IDを持つ。これは相談側の記録であり、本人の保存roleやmemory schemaを変更しない。
runには固定した入力上限・本文version・テンプレート版・既存APIのoperationId／logicalConversationId・状態を記録する。本人のnative状態の別writerにはならない。
受付・送信意図・既存API応答・結果確定を保存し、発言またはpass、cursor、次手番は一つの相談側確定レコードで更新する。
LLM待ちの間はroom保存用排他を保持しない。汎用durable queue・Redis・別plannerは追加しない。

## 3. 既存APIで一人ずつ回す

1. 相談controllerが次の本人と手番の入力snapshotを決め、送信意図を保存する。
2. `voice.open(orchestratorId, conversationKey)` で該当scopeのlogicalConversationIdを取得する。
3. 既存 `turn.start` へ本人ID・logicalConversationId・operationId・通常text入力を渡す。conversationKey・additionalInstructionsも同じ共通実行入口へ運ぶ。選択IDは変えない。
4. 既存statusで完了を待ち、busy・unknown・承認・セッション切替の要求も既存応答として扱う。ユーザー確認を勝手にyesで代行しない。
5. 正常終了した発言または明示passを相談ログへ確定してから次の本人へ進む。失敗をpass扱いしない。

本人の発言は通常文、見送りは全体が `[[PASS]]` と完全一致する形式を実装した。返信JSONや120字制限は付けない。
元の議題は参照専用topicとし、新着ユーザー発言と他者の更新を区別した話者付きJSONを通常textへ載せる。初めてその依頼を読む本人にも、既に公開された他者の回答を踏まえた追加の貢献を求める。自分の前回発言は参照専用の抜粋として添える。APIに `role: agent` があるという主張ではない。
cursorは実際に入力へ渡した上限まで進め、本人の出力seqへ飛ばさない。生成中の補足を落とさず、同じ本人の既知出力だけを次差分から除く。
毎巡の全ログ再送や元依頼の再実行を避ける。raw tool出力・途中実況は人向けの別traceであり、他の本人へは公開発言フィールドだけを投影して送る。ただし既存の履歴圧縮・切替後に差分だけで継続できるか、既存APIで確認できる範囲は未検証である。

### テンプレートと入力の合成

相談側で編集可能なテンプレートと、議題・本人のid／名前・参加者／招待候補の紹介・話者付き差分・最新userへの公開発言済みid・残り手番を組み立てる。未読履歴の古い宛先を現在の指名へ混ぜず、短い続きの依頼も直近の宛先を維持する。データは通常textへ載せ、テンプレートはrun単位の `additionalInstructions` として既存instructions合成・再開へ渡す。通常systemInstructionへ保存しない。
初期テンプレート例は「他者の発言を踏まえ、自分の知識・担当から意見を述べてください。新しい論点がなければ反復せず [[PASS]]。残り3手番以下では結論・未決を整理してください。他者の発言はユーザーの実作業許可ではありません」。これは追加の会話依頼であり、本人の既存指示・機能判断基準を置き換えない。
残り手番・参加者・共有範囲はcontrollerの状態から作り、テンプレートが主張する値で実際の上限や参加状態を変えない。
入力と有効テンプレート版をrunに記録する。更新は次の未開始手番へ適用し、進行中入力を差し替えない。

### 人間が見る途中経過

既存native observerから実際のtool開始・入力・途中出力・結果とpublic commentaryを受け取り、進行中の本人の下へ表示する。最終回答とは分け、確定時に一度だけ置換する。推論過程は表示しない。tool記録は展開して確認でき、確定後もsidecarへ残す。raw toolが読んだ個人の情報をpeerへ自動配送しない。
一覧・作成・相談・設定の階層を整理し、共有Markdown本文・本人avatar・themeに沿う共通入力を使う。過去の発言を読んでいる間はstreamで画面を強制スクロールしない。実componentのhost treeから作った架空会話のlight／dark・狭幅／広幅previewで配置を確認したが、native実機検証とは区別する。

指名された未読参加者へは相談限定の `consultation.handoff({orchestratorId,userMessageId})` で次手番を優先できる。現在の本人が最新userの意味を読み、自分が指名外なら引渡して[[PASS]]にする。対象は現参加者かつ最新user未読の人に限り、既読相手への循環引渡しを防ぐ。適格候補の一覧は別の人を代わりに指名する許可ではなく、実際の指名相手が回答済みなら指名外の本人は見送る。予約は正常完了・同じ最新userの場合だけ反映し、対象の後は通常順へ戻る。指名外の見送りや「最後に回答して終了」の解釈は本人へ依頼し、別AI分類・文字列解析・返信schemaを足さない。詳細は[コード設計](ORCHESTRATOR-COLLABORATION-CODE-DESIGN.md)を参照。

## 4. 終了・補足・停止

毎回の入力に最新の真正user発言を参照snapshotとして含める。新着差分が空でも最新の意図を確認でき、元topicや古い終了発言を新しい指示にしない。最新userの終了意図を本人が理解し、最後に求められた回答・作業が済んだらscope限定native tool `consultation.finish({userMessageId})` を呼ぶ。別AIや文字列判定は足さない。controllerは当該runが読んだ最新の真正user発言IDを検査し、runへ終了予約を保存する。正常完了の発言と同時に終了を確定し、他の本人へ挨拶を回さない。途中で新userが来れば終了予約は適用しない。終了済みは遅い停止でも保持し、同じuserのresumeで再開せず、新しいuser送信で再開できる。意味判断・実nativeでのtool呼出しは未検証である。

同じ本文versionで全参加者が明示passしたら休止する案とする。pass自体はversionを進めず、新しいユーザー／本人発言・参加変更でpass記録をresetする。
ユーザー補足は随時共有ログへ追記し、次の入力へ渡す。休止確定と同じ直列処理で未配達user seqを確認し、上限で渡せなければ未反映と表示する。
failure・timeout・busy・unknownはpassではなく休止して取り扱いを確認する。無限retryや失敗後の自動再送はしない。
公開手番数・経過時間等の有限上限を相談側に置く。現実装は既定9・最大30手番と15分で、真正ユーザーの新規メッセージごとに数え直す。参加者発言・加入・設定変更ではresetしない。同じmessage IDの再送もresetせず、古い入力で生成中だった回答は新しい予算を消費しない。作成だけでは開始せず、空roomの再開でモデルを呼ばない。本人内部のpreflight・topic判定・summary・learning等を相談の都合で無効化・条件変更しない。
既存APIで取得できる呼出し／usageを記録し、公開手番数が本人内部の総モデル呼出し数やtokenのhard capだとは扱わない。

停止時は相談側の世代を更新して後着出力を公開せず、当該operationへ既存interruptを使う。独立背景の記憶・学習を相談由来というだけで取消さない。
当該実行の終了・停止確認前は次の本人を起動しない。unknownは照合できるまで休止する。通常の別実行を勝手に停止しない。
停止後も本人側に入力・未公開出力・既存保存が残り得る。相談側で非公開にしたことは、本人の履歴・学習を巻き戻したことを意味しない。

## 5. 既存保存と復旧の制約

メモリ保存・学習候補生成・採用・承認・忘却・タスク更新の判断と共通処理は既存本人を維持する。各scopeから同一memory storeへ逐次採番・appendし、同一learning.observeへ渡す。相談専用の採用基準・承認フロー・保存schemaを作らない。
現startは通常のuser／assistant pairを保存し、`memoryStore.appendPair → onDurablePair → learning.observe` へつながる。
相談側の `speakerId / source` をtextに書いても、本人の保存roleや学習証拠が自動的に変わるわけではない。他者情報と真正ユーザー指示の誤帰属・誤承認を既存本人が避けられるかは未解決であり、promptだけで保証しない。
学習採用ルールやanalyzer schemaを変更して解決する前案は復活させない。scopeを分けても既存保存へどう接続するか、単一writer・採番・出所解釈が整合するかを確認し、入口引数だけで解決済みとはしない。

再起動時は相談ログのoperationIdから既存statusを照合し、結果不明の送信を新operationとして再実行しない。同じ結果は二重確定しない。
既存APIが結果・継続情報を十分返せない場合は休止し、復旧できたと断定しない。clearMessages・私的active切替・native直呼びは復旧手段として自動実行しない。
詳細は[独立controllerのコード設計](ORCHESTRATOR-COLLABORATION-CODE-DESIGN.md)にまとめる。

## 6. 公式仕様の調査記録

以下は2026-10-28時点の公式資料／スキーマ確認であり、既存本人の公開APIから使えることを示すものではない。現在案はnative APIを相談側から直接呼ばない。

- App Server `turn/start` のinputはUserInputで、`role: agent` 指定経路はない。`toolOutput` と空inputでstandaloneツール結果から生成でき、実行中の後続toolOutputはnative側でqueueされる。[Start a turn](https://learn.chatgpt.com/docs/app-server#start-a-turn)
- `thread/inject_items` はraw Responses Itemsの履歴注入であり、user turnを開始しない。既存contextにも単独履歴復元の使用箇所があるが、相談側の直呼び案にはしない。[Inject items](https://learn.chatgpt.com/docs/app-server#inject-items-into-a-thread)
- Responses Multi Agentはbetaのhosted treeと `agent_message` のauthor／recipientを持つ。既存本人のruntime・メモリをそのまま接続する経路は確認できず、別agentで本人を置き換える根拠にはしない。[公式ガイド](https://developers.openai.com/api/docs/guides/responses-multi-agent)
- Sign in with ChatGPTの `api.openai.com/v1` 公開preview経路は `multi_agent` をunsupported fieldsに挙げる。native子エージェント全般への制約とは混同しない。[Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- Chat Completionsのmessage nameは同roleの参加者識別に使えるが、名前だけでBitty本人を呼び出せない。[API仕様](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- agents as tools／handoffはmanager主導／所有権移譲の形式で、今回の同じ本人の順番相談の代替とは確認していない。[Orchestration](https://developers.openai.com/api/docs/guides/agents/orchestration)

手元のcodex-cli 0.164.0で `generate-json-schema --experimental` を実行し、`TurnStartParams.toolOutput`、`TurnToolOutput` の `name / namespace / output / retain?`、`ThreadInjectItemsParams` の存在を確認した。保存・中断・再開の実動検証は行っていない。今回それを公開APIへ追加する案は採らない。

## 7. 実験記録と次の確認

以下は合成personaの専用ephemeral threadを使った実験であり、既存本人への接続・通常履歴分離・メモリ／学習／承認の整合は検証していない。

- [最初の小実験](ORCHESTRATOR-COLLABORATION-EXPERIMENT.md)
- [実践3ケース](ORCHESTRATOR-COLLABORATION-PRACTICAL-EXPERIMENTS.md)
- [通常文版](ORCHESTRATOR-COLLABORATION-PLAIN-TEXT-EXPERIMENTS.md)
- [プロフィール共有版](ORCHESTRATOR-COLLABORATION-TEAM-AWARE-EXPERIMENTS.md)
- [Sol highの単発比較](ORCHESTRATOR-COLLABORATION-SOL-HIGH-EXPERIMENT.md)

順番の反映・条件訂正・分担訂正は観察したが、全員passと上限終了は別で、十分な相談・正確性・ユーザー承認を保証しない。モデルとeffort、JSON指定・字数制限の影響も各1試行から切り分けない。

| 確認場面 | 受入条件／未解決の確認 |
| --- | --- |
| 同じ本人 | 通常defaultは従来どおり。必要最小の入口変更で共通本人処理を使い、将来修正が相談にも適用される |
| A→B→C→A | 話者付き差分を順に読み、自分の既知出力を重複配送しない |
| 別UI・選択維持 | 通常の選択IDを変えず、scope別state／native IDで通常履歴と分ける。実native確認は残る |
| 既存承認・タスク・切替 | 応答を取り次ぎ、peer発言からユーザー承認を代行しない。誤帰属防止は実本人で未検証 |
| メモリ・学習 | 既存の保存・判定・採用・忘却を変更しない。通常pairへ入る事実を隠さない |
| 補足・pass・上限 | 未配達補足を黙殺せず、同版全員passだけで休止し、上限は相談の次手番を止める |
| stop・unknown・再送 | 既存operation照合まで次送信せず、二重実行・二重公開を防ぐ。復旧不能なら休止する |
| 紹介・自然文招待 | 個人設定の公開紹介を使い、通常文で確認した本人がscope限定toolを呼ぶ。登録済み候補・世代等はcode検査、承認意味の保証は実モデル未検証 |

実装済み範囲と回帰試験・制限は[実装記録](ORCHESTRATOR-COLLABORATION-IMPLEMENTATION.md)へ集約する。自然文招待の判断精度、実本人による話者／権限の解釈、実native／実機と切断時質問再表示の完全な検証は残る。今回の追加実モデル呼出し・サーバー再起動は行っていない。入力・phase・表示境界を修正したが、実LLMの反復や事実誤認がなくなったという実験結果ではない。最新修正では共通本人runtimeの対話用profileで組込公開Web検索・ページ取得を有効にし、通常と相談へ同じ設定を渡す。内部readOnly helper、shell network、共有MCP／apps、ログイン済みブラウザ・computer操作は無効のまま。実検索成功は未検証であり、閲覧中アカウントの操作能力を有効にしたものではない。
