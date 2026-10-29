# 独立テキスト相談の実装と検証

2026-10-29。独立テキスト相談を実装し、同日改訂で通常チャット表示・入力の共用、空room作成、個人設定の公開紹介、scope限定native招待を追加した。実native／実機確認済みとは扱わない。

## 実装したこと

ボードのmic隣に「相談」を追加した。本人画像のアイコンgridで2〜8人を選んで空roomを作り、その後チャットで通常の最初のメッセージを送る。長押しで紹介を確認できる。本人は選択順で一人ずつ考え、他者の発言を受けて話す。吹き出しはVoiceConversationMessages、入力はStreamingSttFooter manual表示を通常画面と共用する。補足・訂正、停止、上限・相談の進め方の編集を持つ。通常の本人選択は変更しない。

[本人サービス](../private_runner/src/voice-orchestrator-service.mjs)へ任意conversationKey、[既存context](../private_runner/src/voice-context-service.mjs)へrun単位additionalInstructionsを接続した。未指定の通常defaultは既存処理を使う。相談も同じfactory／runTurn／本人runtimeを通り、将来の本人修正が同じ処理へ反映される。
scopeは別active・events・native threadを持ち、本人workspace・設定・memory store instance・learning・task本体を共用する。通常contextがmemory／summaryと共有task overviewのcache／進行taskを一組だけ所有する。既存のメモリ保存・学習採用・承認・忘却・タスク判断は変更していない。

[controller](../private_runner/src/voice-consultation-service.mjs)はroom共有ログ・参加順・差分cursor・本文version・pass・有限上限・run snapshotだけを管理する。モデル応答は通常文、全体が [[PASS]] の場合だけ見送り。返信JSON指定・字数制限は設けていない。
既定9・最大30手番と15分を、真正userの新しいメッセージごとに数え直す。同ID再送・参加者発言ではresetせず、生成中補足を受ける前の旧run完了も新budgetへ加算しない。内部preflight／summary／learning等の回数やtokenのhard capではない。

本人単位busy、全scope証拠からのmemory／learning回復、設定・clearの永続世代によるscope親失効の補完、安定workspace IDによるtask archive共有を追加した。通常completion／履歴／未読／pushへscope発言を混ぜず、共有task変更だけは同じownerの通常表示にも通知する。
controllerは送信前後の停止競合、既知未受理の同run再開、unknownの照合、reset確認時の入力snapshot、close後の後着出力を扱う。永続保存障害は自動再試行せず休止し、正本を再起動回復するまでそのroomのresumeを拒否する。

大きなowner基盤、本人実装のコピー、派生クラス、Redis／汎用workflowは作っていない。既存の大きいcontext内へは同じ実行・承認・復旧を使うための資源参照と追加指示の境界だけを置き、room進行は別ファイルへ分けた。

公開紹介は既存の個人設定へ移し、本人registryを一つの正本にした。model／effortを選んで、直近12msg（各1500字）と採用学習10件（内容600・条件300字）から編集可能な下書きを生成する。全文memoryは走査せず、通常の保存を押すまで採用しない。生成には既存tool-free ephemeral実行を共用し、本人の通常モデル・systemInstruction・会話履歴を更新しない。

## 検証したこと

すべてfake App Server・一時filesystemによる試験で、実モデル／有料API／nativeサーバー／本番データは呼んでいない。

| 確認 | 結果 |
| --- | --- |
| 既存context・orchestrator・memory・learning・request bridgeの5 suites | 親の改訂版実行361/361 pass、173.032秒 |
| [製品scope／controller統合試験](../private_runner/tests/orchestrator-consultation-boundaries.test.mjs) | 改訂版26/26 pass。空room再読込、user単位予算reset、旧native親の招待tool登録、重複加入、紹介生成のbounded入力・通常非汚染、上限引下げ再読込、stop後unknownの新入力も検証。採用済み／未採用学習の実state入力選別assert強化後、該当1件も1/1 pass |
| 通常voice画面・通常voice hook・ボード・承認・質問・calendarの6 UI suites | 親の改訂版実行236/236 pass |
| 改訂した相談画面・個人設定・共通入力の3 UI suites | 編集担当45/45 pass。通常voice画面・入力の既存試験も親84/84 pass（一部重複） |
| 通常／macOS TypeScript | 両方pass |
| 変更JavaScriptの構文・diff空白・文書リンク | pass |

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

招待の同意意味は通常文の確認と本人モデルの判断へ委ね、追加分類LLMや承認state machineを使わない。scope限定native toolが登録済みID・run・世代・重複・人数を検査し、正常終了後に追加する。promptの確認が確実に守られることは実モデル未検証である。

相談UIは独立したテキスト画面であり、音声surfaceがない。端末マイク停止／音声会話の移動に使うapp-control originは持たず、通常voiceでもoriginが無い場合と同じ利用不可の挙動になる。本人tool全般をdisableした変更ではなく、音声／STT追加は今回行っていない。

承認・質問は既存global request bridgeへ取り次ぐ。画面閉鎖後も本人実行は継続するが、WS切断後のpending再通知や、対象画面が非表示の質問の完全復旧は保証していない。既存の期限・表示対象の条件があり、本人確認を自動でyesに置換しない。

話者付きJSONを通常入力で運ぶため、本人には既存user／assistant pairとして保存される。相談側の出所ラベルが本人の保存roleを変更するわけではない。実本人によるpeerと真正ユーザー許可の解釈、知識に基づく判断、長期学習採用は実モデル未検証である。
実native・実機UI・ネットワーク切断・長期稼働は未検証。追加の実モデル呼出し・サーバー再起動・実機ビルドは行っていない。ユーザー検証用の準備・コマンド提示は親が別途実施した。
