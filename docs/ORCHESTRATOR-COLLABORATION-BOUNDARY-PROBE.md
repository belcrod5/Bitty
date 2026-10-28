# 相談scopeと本人資源の境界検証

実施日: 2026-10-29。これは本実装前の記録である。その後の一時stringpatch testは製品回帰testへ置換し、現在の結果は[実装記録](ORCHESTRATOR-COLLABORATION-IMPLEMENTATION.md)へ分けた。対象HEAD: `29719cd`。製品srcは変更せず、[検証test](../private_runner/tests/orchestrator-consultation-boundaries.test.mjs)だけで実行した。設計は[全体](ORCHESTRATOR-COLLABORATION-DESIGN.md)・[コード設計](ORCHESTRATOR-COLLABORATION-CODE-DESIGN.md)を参照。

既存factoryの小さな入口変更で、会話状態を分けながら同じworkspace・一つのmemory store・既存応答処理を使う接続は、限定した逐次実行で成立した。**通常・相談の全ライフサイクルが成立した、という結果ではない。**

## 1. 条件と実行結果

```sh
node --check private_runner/tests/orchestrator-consultation-boundaries.test.mjs
node --test private_runner/tests/orchestrator-consultation-boundaries.test.mjs
```

構文検査通過。最終実行は5 tests / 5 pass / 0 fail（約3.6秒）、親の独立再実行も5/5 pass（約2.7秒）。モデル・native App Server・ネットワーク・共有logs・認証・実データには接続しない。作成した一時directoryは終了時に削除する。

本物の `createVoiceOrchestratorService`・`createVoiceContextService`・`openVoiceMemoryStore`・`openOrchestratorLearning` と実filesystemを使い、App ServerのRPC／通知だけをfakeにした。fakeが返す文章の知能・指示遵守・実native隔離を検証したわけではない。学習の観測／保存は実処理だが、analyzer／候補生成はモデルを使わず、未設定状態で実行しない。

| 試験 | 実際に確認したもの |
| --- | --- |
| 既存owner API | 明示本人IDで送信してselectedId不変。scope／追加指示の未知キーは拒否。既存checklist preflightを経て実events・実memory・実learning.pendingへ通常pairが保存される |
| 別rootの2context | logical ID・native threadだけでなくworkspace・設定・memoryConversationId・実raw pairも分かれる。root差替えだけでは同じ本人資源の共用にならない |
| 同rootの2context | 一つのinstance内ではbusy拒否するが、事前に開いた別instanceは同じrootでも同時受理する。設定closureも別で、古いinstanceのconfigureが実activeを上書きし得る |
| 同一実memoryの二重open | instanceごとの採番cacheは独立。片方がpair 1を書いても他方はlast=0で、別内容のpair 1に実ファイルを上書きできる。欠番appendは実storeが拒否する |
| temp-copyのpositive probe | 別active／native thread、同一実workspace・同一store object、既存採番1..5、同じ実learning.observeへの5件保存、run別指示のstart／resume反映、通常設定非保存、room context再open継続 |

同root二重生成・二重storeは、安易な新実装案の反証として意図的に作った。現本番が通常このように生成している、という不具合報告ではない。

## 2. 一時patchで通った範囲

test内で既存 `voice-context-service.mjs` のsourceを一時directoryへコピーし、8箇所の厳密一致置換（純増5行）だけを当てる。相対importを本物のsrc依存先へ向け直し、memory／learning／runtime実装は複製しない。patch内容はtestの `scratchFactory` に保存され、sourceが変わり置換箇所が一致しなければ失敗する。
この文字列patchは技術確認用artifactであり、本実装後は通常のregression testへ置き換える。将来の本人コード変更をこの置換形式へ合わせる契約にはしない。

| 一時変更 | 検証上の目的 |
| --- | --- |
| factoryへ `ownerWorkspace / sharedMemoryStore / sharedSettings` を追加 | state rootと本人資源を別に指定する入口を試す |
| workspaceの既定値へ任意上書き | rootは別のまま本人workspaceを共用する |
| settingsの任意provider | 本人設定の明示snapshotを使う。自動同期の実装ではない |
| roomのmemoryConversationId初期値 | 注入したstoreの既存IDへ揃える |
| memory loadの任意store注入 | 同じファイルを二重openせず同一instanceを使う |
| startのstrict keysへadditionalInstructions追加 | 既存受信・runTurnを通す |
| 追加指示の型／byte検査とrun hook snapshot | active.systemInstructionへ保存しない |
| baseと応答instructionsの合成を分ける | 追加指示を応答へ合成し、preflight用baseは維持する |

本物の通常contextと一時patch版room contextを順番に呼び、実storeが共有されたため既存の `max(memory.lastPairSeq, pairs.last, pruned) + 1` が1..5を採番した。独自のtoy queue／採番を作って成功させていない。
room初回・次回・再open後で同じ既存modelTurn／start／resume経路を使い、追加指示を変えた時は実送信payloadも変わり、省略した時は前回の指示をpayloadへ再合成しないことを確認した。native側が前回指示をどう保持するかはfakeでは分からない。
通常active.systemInstructionは `OWNER_POLICY` のままで、どちらのactiveにも相談指示は保存されなかった。本人設定変更後はtest側がsnapshotを明示更新して次のroom応答へ反映した。本人configureからの自動追随を証明したものではない。
room再openは同一process・既存store instanceを生かしたままの再作成である。全process再起動からのowner/store/room復旧とは区別する。

製品contextのSHA256は `59fd3d500b0cbd215fbbdfa1324b1baf85fe1dc588c90cc8045be6a6da4f9c0d`。test終了時にも元sourceのbyte不変をassertした。一時patchを製品実装へ採用したわけではなく、公開 `conversationKey`／`sessionScope` のdispatch入口も未実装である。

## 3. 最小変更の候補と残る境界

最小候補は、共通factoryの会話stateの保存先と本人workspace／storeの参照を入口で分け、run単位additionalInstructionsを既存応答instructionsへ渡す形である。通常defaultは従来の入口・既定値を維持し、controllerにはroom進行と入力組立だけを置く。派生クラス、本人処理コピー、全処理への相談mode分岐は必要性を示していない。

**8箇所・純増5行はこのprobeの規模であり、製品機能全体の実装見積りではない。** 次は以下の既存境界を決める必要がある。

- 本人設定の単一writerとscope contextへの最新値供給。snapshotコピーだけでは将来のconfigureに自動追随しない。
- 普通／相談が使う本人単位のbusyとconfigure・clear・removeの調停。contextローカルのinFlightを増やすだけでは成立しない。
- memoryを単一instanceにするだけでなく、contextごとのsummaryTask／retry timerが同じstoreへ重複実行しない統括。今回の少数pairではsummary開始閾値に達していない。
- 全scopeをまたぐrestart復旧、operation dedup、番号と学習highwater、通常eventsだけを走査する既存復旧との整合。今回の逐次採番成功だけでは保証しない。
- additionalInstructionsのdurable snapshot・再送同一性・reset確認経由の保持。今回のpatchは実行中hook snapshotのみで、同じoperationIdの別指示やクラッシュ復旧を扱っていない。
- 追加指示を応答だけに適用し、既存preflight／topic／summary／learningの判断を変えないこと。probeのpositive側にはtask checklistを付けておらず、その除外はコード上の分離であって実行済み受入試験ではない。
- 同じ本人workspaceでtask本体を使い、scope別offer／承認・peer情報と真正ユーザー入力の区別を既存挙動のまま維持できるか。話者ラベルtextが既存user pairに保存される点も残る。

学習採用ルール／analyzer schemaを変える理由はこのprobeから得ていない。共用を理由に個人の記憶・学習を一律停止する案にも戻さない。残る責務を小さい既存境界へ接続できるかは、実装前の確認事項とする。

## 4. 既存suiteのbaseline

親による製品src無変更のcontext／orchestrator／memory／learningの4suite初回は、360 tests中358 pass・2 failだった。
失敗はcontextのlearning exclusions試験のcleanup `ENOTEMPTY`（hookFailed）、orchestratorのmain checklist通知試験の3件対期待2件。2件とも各単独再実行でも同じ失敗を再現した。今回の新testの5/5とは別の結果であり、恒久production変更は0、関係ない製品修正は行っていない。

この検証の成果は、既存処理を使った小patchで接続できた範囲と、安易なroot／context／store複製では壊れる境界を実物で特定したことである。実本人のモデル応答・実tool／承認・長期稼働・本番UIは未検証である。
