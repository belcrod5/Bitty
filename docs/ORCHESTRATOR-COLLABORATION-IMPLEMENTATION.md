# 独立テキスト相談の実装と検証

2026-10-29。独立テキスト相談を実装し、同日改訂で通常チャット表示・入力の共用、空room作成、個人設定の公開紹介、scope限定native招待を追加し、その後に入力更新契約・native phase・途中表示・人向けtool記録とUIを修正した。実native／実機確認済みとは扱わない。

## 実装したこと

ボードのmic隣に「相談」を追加した。本人画像のアイコンgridで2〜8人を選んで空roomを作り、その後チャットで通常の最初のメッセージを送る。長押しで紹介を確認できる。本人は選択順で一人ずつ考え、他者の発言を受けて話す。吹き出しはVoiceConversationMessages、入力は通常オーケストレーターチャットの実StreamingSttFooterを共用する。補足・訂正、停止、上限・相談の進め方の編集を持つ。通常の本人選択は変更しない。

[本人サービス](../private_runner/src/voice-orchestrator-service.mjs)へ任意conversationKey、[既存context](../private_runner/src/voice-context-service.mjs)へrun単位additionalInstructionsを接続した。未指定の通常defaultは既存処理を使う。相談も同じfactory／runTurn／本人runtimeを通り、将来の本人修正が同じ処理へ反映される。
scopeは別active・events・native threadを持ち、本人workspace・設定・memory store instance・learning・task本体を共用する。通常contextがmemory／summaryと共有task overviewのcache／進行taskを一組だけ所有する。既存のメモリ保存・学習採用・承認・忘却・タスク判断は変更していない。

[controller](../private_runner/src/voice-consultation-service.mjs)はroom共有ログ・参加順・差分cursor・本文version・pass・有限上限・run snapshotだけを管理する。モデル応答は通常文、全体が [[PASS]] の場合だけ見送り。返信JSON指定・字数制限は設けていない。
既定9・最大30手番と15分を、真正userの新しいメッセージごとに数え直す。同ID再送・参加者発言ではresetせず、生成中補足を受ける前の旧run完了も新budgetへ加算しない。内部preflight／summary／learning等の回数やtokenのhard capではない。

本人単位busy、全scope証拠からのmemory／learning回復、設定・clearの永続世代によるscope親失効の補完、安定workspace IDによるtask archive共有を追加した。通常completion／履歴／未読／pushへscope発言を混ぜず、共有task変更だけは同じownerの通常表示にも通知する。
controllerは送信前後の停止競合、既知未受理の同run再開、unknownの照合、reset確認時の入力snapshot、close後の後着出力を扱う。永続保存障害は自動再試行せず休止し、正本を再起動回復するまでそのroomのresumeを拒否する。

大きなowner基盤、本人実装のコピー、派生クラス、Redis／汎用workflowは作っていない。既存の大きいcontext内へは同じ実行・承認・復旧を使うための資源参照と追加指示の境界だけを置き、room進行は別ファイルへ分けた。

公開紹介は既存の個人設定へ移し、本人registryを一つの正本にした。model／effortを選んで、直近12msg（各1500字）と採用学習10件（内容600・条件300字）から編集可能な下書きを生成する。全文memoryは走査せず、通常の保存を押すまで採用しない。生成には既存tool-free ephemeral実行を共用し、本人の通常モデル・systemInstruction・会話履歴を更新しない。

## 途中表示・反復に関わる修正

元依頼を毎回同じquestionとして渡す入力を改め、参照専用topic／新着user／peer更新／自分の既発言参照を分けた。初参加でも既に他者が答えた内容を読み、意味のある追加貢献・確認・異論・分担だけを求める。特定の話題のルールや文字列重複の削除で隠していない。
既存native observerの公開commentaryとfinal_answerを分離し、完了・unknown回復の成果へcommentaryを混ぜない。開始で判明したphaseと、確定時に初めて判明したphaseの両方を扱い、回復用の小さなphase証拠も保存する。
実tool名・入力・途中出力・状態・利用可能な結果を人向けtraceとして表示し、最終成果は一度だけ置換する。traceは公開messagesとは別のstepsへ保存する。peer入力は公開messageの明示projectionなので、toolが読んだ本人の私的情報は自動共有しない。省略するのは途中・tool previewだけで、確定本文は切らない。
UIを実avatar中心の静かな一覧、画像grid、広い相談本文、簡潔な設定へ整えた。本文は既存MarkdownText、入力は通常オーケストレータと同じFooterを使う。light／dark・390／760幅・作業記録展開・空roomを実component host treeの架空previewで確認する。ブラウザ配置previewと実機描画は別である。

## 終了・入力・読み上げの追加修正

相談入力の共用先をVoiceConversationScreenの実StreamingSttFooterへ訂正した。ChatComposer／全画面editor・独自送信rowを削除し、標準の黒panel／Skia glow／Enter送信／状態表示を使う。旧manual別styleへ戻したものではない。文字animationはFooterへ移して二重実装せず、通常表示・reduceMotion未確定の先頭文字待機を維持する。相談だけ応答表示のタップで補足を編集でき、読み上げ中は従来の停止操作が優先する。送信失敗の下書き保持・受理後の編集中本文保護・相談停止と読み上げ停止の区別も共用契約で扱う。
終了は本人が通常会話を解釈してconsultation.finishへ真正user発言IDを渡す。終了予約をrunへ保存し、正常完了と同時に確定する。新user途中到着を優先し、失敗／中断・古いrunでは終了せず、終了後の遅いstopでも終了を保持する。同じuserのresumeは拒否し、新userで再開する。別AI分類・文字列判定・返信JSON指定は追加していない。
TTSは通常turnと相談runで同じcreateVoiceTurnSpeechのjob lifecycle、既存の「。」segment queue、本人の声設定、既存audio job attach／playerを使う。相談はnative final deltaを直接送り、turn未完了でも句点から合成する。未知phaseは保留し、既知commentaryと[[PASS]]は読まない。確定全文はprefix照合とtail補完だけに使い、二重再生しない。表示用streamの32000字省略は音声に適用しない。
表示中roomの一時speech購読だけがjob作成を許可する。購読ready後に送信・再開し、途中参加／再接続では次accepted runから開始して過去prefixを再合成しない。離室／WS close（subscribe応答待ち中も含む）／新user／明示停止／保存障害／stream不整合はqueue済み合成もcancelする。同IDのuser再送はcancelしない。自然終了は最後の音声を残す。背景再生には新しいAppState制約を設けない。
UIはjob通知を既存の発言queueへ積み、生成Promiseでなく実再生終了を待つ。別画面の音声待機、未attach job取消、UUIDによる古いrequest保護、履歴の手動text再生を維持する。通常voice履歴の再生ボタンと直前の標準Footer統一も維持した。
新しいphase試験で、native identity代入→fsync待ち中にcompletedがdeltaを追い越す既存observerの順序問題を再現した。保存完了まで全通知をbufferする小修正を共通owner境界へ入れ、実filesystem rename gateで受信順を検証した。TTS側の重複削除や本人の学習・タスク判断変更で対処していない。

## 最新userの参照と指名への引渡し

相談入力に毎回latestUserMessageのid／seq／textと参照専用の印を渡し、新着差分がない手番も現在のユーザー意図を確認できるようにした。finishの説明と固定指示を最新userだけに揃え、古い終了の再試行・内部エラーの公開反復・終了の決まり文句の要求を避けるよう依頼する。最後に指名回答を求められた場合は、回答を済ませる前に終了しない。

相談だけに `consultation.handoff({orchestratorId,userMessageId})` を追加した。現在の本人が指名を解釈し、次の未読参加者を予約して[[PASS]]にする。controllerはactive run／世代・最新userの読了境界・現参加者・自己除外・対象cursorを検査する。既読相手への再引渡しを拒否し、同target再送は冪等、別targetへの上書きとfinish併用は拒否する。予約はrunに保存し、正常完了かつ同じ最新userの場合だけ、加入反映後のtarget IDから次手番を決める。新user・失敗・中断は旧予約を適用せず、上限も増やさない。対象回答後は通常の順番へ戻る。

room別の新しいrouting state、追加分類LLM、日本語keyword判定、汎用queue、通常ownerの分岐は追加していない。UI・共有TTS・通常のタスク／メモリ／学習はそのまま。本人の意味解釈やPASS遵守は実モデル未検証であり、fakeで正しい応答を与えてもモデル精度の実証にはならない。

## 公開Webと最新の指名範囲

通常チャットと相談は元から同じ本人runtimeを使うが、その共通profileで組込Webも無効だった。相談側へ別Web実装を足さず、共通の対話profileだけ `web_search: live` に修正した。既存readOnly区分で内部helperは無効を保ち、shell networkや共有のログイン済みブラウザ・MCP・apps・記憶へは権限を広げない。組込Webによる公開ページ取得と、ログイン済みのブラウザ操作は別の能力である。[公式Web検索説明](https://learn.chatgpt.com/docs/web-search)・[設定リファレンス](https://developers.openai.com/codex/config-reference/)を参照。親が手元のcodex-cli 0.164.0で実行したオフラインschema生成でも、WebSearchActionのsearch／openPage／findInPageを確認した。モデルやサーバーは起動しておらず、実サイト取得成功の検証ではない。

相談入力へ本人のid／名前と、最新userを読んで公開発言した人のid一覧を加えた。既存stepsから導くため新しい保存stateはない。未読のuser履歴を全て現在の依頼と解釈せず、最新の宛先が古い広い宛先を置き換えること、短い再依頼も直近の宛先を保つことを指示する。handoff候補は適格性の一覧であり、実際の指名相手が既読のとき別候補へ代わりに渡さない。最後に全員へ依頼された場合は、一人の発言だけで終了しないよう依頼する。これらの意味解釈をコードで分類したわけではなく、実モデルでの遵守精度は未検証である。

## 検証したこと

不具合調査では、ユーザーが指定した既存相談と対応scopeの保存記録だけを読取専用で確認した。本文・個人IDは資料へ転載していない。以下の試験はfake App Server・一時filesystemで行い、実モデル／有料API／nativeサーバーの呼出しや本番データへの実行・書込はしていない。

| 確認 | 結果 |
| --- | --- |
| 前段階の既存backend 5 suites | 当時361/361 pass、173.032秒 |
| 前回の既存backend 6 suites（runtime profileを含む） | 初回366/367 pass。追加した能力説明のadmission byte計上不整合1件を修正後、orchestrator42/42・context関連11/11を再実行してpass。他325件は初回pass。現在版の全367件単一runとは主張しない |
| 前回の[製品scope／controller統合試験](../private_runner/tests/orchestrator-consultation-boundaries.test.mjs) | 途中表示修正版29/29 pass。空room再読込、user単位予算reset、旧native親の招待tool登録、重複加入、紹介生成のbounded入力・通常非汚染、上限引下げ再読込、stop後unknownの新入力も検証。採用済み／未採用学習の実state入力選別assert強化後、該当1件も1/1 pass。native phase／回復2/2、traceの公開projection・途中出力・停止→新run・指示byte境界も検証 |
| 既存voice hook・ボード・activity hook・Markdown・承認・質問・calendarの7 UI suites | 前回185/185 pass。新Markdown依存のnative moduleをboard testで適切にmockして確認 |
| 前回の途中表示修正版の相談画面・通常voice画面・共通入力の3 UI suites | 94/94 pass。既存Markdownを含む4 suitesは101/101 pass（Markdown7件は上の既存7 suitesと重複、加算しない） |
| 前回の製品scope／controller統合試験 | 33/33 pass。終了予約・新user優先・peer／未読user拒否・終了後late stop／再開・status回復とfailed／interruptedを追加 |
| 前回の相談／通常voice／STT footer／読み上げqueue 4 UI suites | 当時101/101 pass（ChatComposerへの切替時。今回その入力は撤去）。IME／全画面／編集中保持、live確定のみ再生、初回／再接続履歴除外、owner声、再生完了待ち、失敗／他画面／遅い旧request／cleanupを確認 |
| 前回の既存stream TTS／playback session／fullscreen 3 suites | 52/52 pass。上の4 suitesとは別、fullscreen8件の先行baselineとは重複するため加算しない |
| 前回の既存Board／macOS AppScreenContent 2 suites | 83/83 pass。再生prop接続と画面非表示時cleanupの読込回帰を確認 |
| 前回の実Footer共用・通常voice・相談・読み上げqueue 4 suites | 100/100 pass。両画面の同一panel／glow、Enter送信、生成中のタップ編集、受理前／編集中の下書き、停止scope、通常状態導出を確認。文字animationの試験はscreen mockから実Footerへ移した |
| 前回のscope／controller統合 | 37/37 pass。実native fake→phase gate→既存segmenterで句点時点の早期合成、fsync中の通知順、未知phase／PASS／commentary／tail、preview上限非依存、需要購読／新user／同ID retry／取消／EIOを検証 |
| 前回の共通segment／job lifecycle | 18/18 pass。既存providerをfake fetchに置換し、句点でturn完了前に音声chunkが得られること、tailとdoneの一度だけ確定、取消後の後続／遅い音声抑止を確認 |
| 前回のWS transport | 46/46 pass。subscribe応答待ち中closeで同じ購読を解除することも検証 |
| 前回の相談／queue／通常voice／標準Footer 4 suites | 102/102 pass。job attachの順序、duplicate／queued cancel、自然終了音声維持、購読ready前送信抑止、新run開始後の誤取消防止、履歴手動再生を確認 |
| 前回の通常voice-context全件 | 244/244 pass（223 top-level、153.257秒）。通知順序変更に関連する通常実行・識別保存・中断・phase／復旧を含む全件回帰 |
| 通常／macOS TypeScript | 両方pass |
| 最新user／handoff修正後のscope／controller全件 | 45/45 pass、85.131秒。上記37件を含めて再実行。最新user snapshot／古い終了の再開、未読指名相手の優先、通常tool非汚染、既読循環拒否、制御予約の排他・冪等、途中新user、正常／失敗／中断回復、上限、最終指名回答→終了、破損予約のfail-closedを追加 |
| 最新user／handoff修正後の通常voice-context全件 | 親が244/244 passを再確認、167.56秒。今回再実行した独立ファイルは合計289件で、前回の18／46／102件や型検査を今回再実行した数には含めない |
| 公開Web／指名範囲修正後のscope／controller全件 | 46/46 pass、149.879秒。v3→v4の既存native scope更新、通常／相談のstart・resumeで同じlive設定、helperのdisabled維持、本人id／名前と公開発言済みid、旧入力への後着回答の除外を確認 |
| 公開Web／指名範囲修正後の本人サービス全件 | 42/42 pass、67.471秒。共有workspace・scope・通常履歴・隔離移行の既存回帰を再実行 |
| 公開Web／指名範囲修正後のruntime profile全件 | 4/4 pass。公開Web以外のfilesystem／shell network／private tool隔離と内部readOnlyのWeb無効を確認 |
| 公開Web／指名範囲修正後の通常voice-context全件 | 親が244/244 passを再確認、253.486秒。今回の独立4ファイル合計336件。前回の289件やUI／WS等の過去試験を加算しない |
| 変更JavaScriptの構文・diff空白・文書リンク | 最新修正で5 JS構文・diff空白・3文書31ローカルリンク／fenceを確認、pass |

統合試験は実factory・実memory・実learning.observeを使い、以下を確認した。

- scope別state／thread・通常履歴分離、同じworkspace／単一store／設定参照、通常通知の非混同。
- 追加指示のstart／resume反映、通常設定非保存、同operationの異なる指示の拒否、reset確認で同runを保持。
- 通常↔scope／別scopeのowner排他、unknown後の早期起動防止、他ownerの独立実行。
- completed後memory append前、memory後observe前の回復、採番／学習高水位、owner更新後のscope失効取りこぼし補完。
- 単一summaryとtask overview cache／進行task、同hash cacheがある新scopeで追加overview呼出しゼロ、scopeをopenしてもownerのlive tempを消さないこと、task archive相互参照、共有task承認の横断競合防止。
- A→B→C→Aの差分、自己出力除外、生成中補足、同版pass、上限、停止とopen／start／resumeの競合。
- controllerの再作成・close後後着、既知busyの同run再開、保存EIOのfail-closed、永続JSONの有限上限検査。

初回baselineは360中358 pass・2 failだった。contextのcleanup ENOTEMPTYは、別に作ったtest contextをfinallyでcloseして解消した。orchestratorの通知件数固定は既存の合法なoverview完了通知と競合したため、各turnで通知増加・同じowner identity・実task内容を確認する試験へ改めた。製品のsummary通知挙動を削って通したものではない。
本実装前の[境界probe](ORCHESTRATOR-COLLABORATION-BOUNDARY-PROBE.md)は当時の記録として残し、脆い一時stringpatch testは現在の製品回帰試験へ置換した。

## 残る制限

共通本人runtimeの対話用profileは組込の公開Web検索・ページ取得をliveに設定する。通常と相談のthread/start／resumeで同じ設定を使い、readOnlyのpreflight／summary／learningはdisabledを維持する。shellの任意network・共有MCP／apps／plugins・ログイン済みブラウザ／computer操作は無効のまま。configの有効化やtoolが動いたことと、最新外部情報を実際に取得できたことを同一視しない。実能力の説明は送信前のbyte予算にも含める。実LLMで反復や事実誤認が解消したという結果ではなく、追加の有料モデル呼出しはゼロである。
完全にphase情報のない旧native形式は互換動作を維持するため、過去のcommentaryを正しく識別できる保証はない。相談の未知phaseは確定本文まで音声を保留する。既に発声した文は後の失敗で戻せず、cancelは後続生成と遅いemitを止める。既に開始したproviderリクエスト自体の取消は保証しない。同processの再接続はlive snapshotを再取得できるが、process再起動前の未確定trace全体の復元は保証しない。

終了toolを本人が適切な意味で呼ぶこと、実nativeと端末の音声再生は有料モデル／実機で確認していない。fake試験は制御・配送・再生状態の境界を検証したもので、実会話で挨拶の反復が解消したという結果ではない。

招待の同意意味は通常文の確認と本人モデルの判断へ委ね、追加分類LLMや承認state machineを使わない。scope限定native toolが登録済みID・run・世代・重複・人数を検査し、正常終了後に追加する。promptの確認が確実に守られることは実モデル未検証である。

相談UIは独立したテキスト画面であり、音声surfaceがない。端末マイク停止／音声会話の移動に使うapp-control originは持たず、通常voiceでもoriginが無い場合と同じ利用不可の挙動になる。本人tool全般をdisableした変更ではなく、音声／STT追加は今回行っていない。

承認・質問は既存global request bridgeへ取り次ぐ。画面閉鎖後も本人実行は継続するが、WS切断後のpending再通知や、対象画面が非表示の質問の完全復旧は保証していない。既存の期限・表示対象の条件があり、本人確認を自動でyesに置換しない。

話者付きJSONを通常入力で運ぶため、本人には既存user／assistant pairとして保存される。相談側の出所ラベルが本人の保存roleを変更するわけではない。実本人によるpeerと真正ユーザー許可の解釈、知識に基づく判断、長期学習採用は実モデル未検証である。
実native・実機UI・ネットワーク切断・長期稼働は未検証。追加の実モデル呼出し・サーバー再起動・実機ビルドは行っていない。ユーザー検証用の準備・コマンド提示は親が別途実施した。
