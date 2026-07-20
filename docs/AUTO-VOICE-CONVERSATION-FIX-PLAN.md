# 自動音声会話 復旧計画

## 1. 文書管理

| 項目 | 値 |
| --- | --- |
| 作成日 | 2026-07-18 |
| 状態 | 復旧完了（全自動検査・実機ビルド・AirPods実機受入に成功） |
| 原因確度 | 高 |
| ブランチ | `fix/auto-voice-conversation` |
| worktree | `/Volumes/SSD-500GB-SanDisk/work/bitty-worktree/fix/auto-voice-conversation` |
| ベース | `origin/main` (`a4d1ec5`) |
| 実装担当 | VAD・panel ID伝播は別サブエージェント、表示競合の監査・根本修正は計画作成者が直接実施 |

この文書は、実装中に修正方針を拡大・変更しないための固定仕様である。実装者は、後述の「診断が無効になる停止条件」に該当しない限り、この範囲だけを実装する。

## 2. 復旧する利用者動線

マイクボタンを1回押すと、手動で停止するまで次の循環が継続すること。

1. 録音を開始して `listening` になる。
2. 通常の会話音量を発話として検出し、`speaking` になる。
3. 発話後の無音を検出し、録音を確定する。
4. 音声を `POST /stt` に送り、文字起こしする。
5. 文字起こし結果を利用者メッセージとして自動送信する。
6. アシスタントの応答を生成し、TTSで再生する。
7. 再び録音待機へ戻る。
8. マイクボタンを再度押した場合は循環を停止する。

## 3. 調査結果

### 3.1 実機で確認した事実

- 接続済みの iPhone 14 Pro から、2026-07-18 04:31:11 UTC に `autoEnabled: true`、`autoState: "listening"` が記録された。
- 同じ操作は 2026-07-18 04:31:15 UTC に `autoEnabled: false`、`autoState: "idle"` へ戻った。
- この操作中も、現在の runner ログ全体にも、該当セッションからの `POST /stt` は1件もない。
- 通常の応答生成と `/tts-media/...` の取得は成功している。したがって、runner接続、応答生成、TTSは停止箇所ではない。
- マイク操作で `listening` まで到達するため、ボタン配線、録音開始要求、マイク権限が主原因である可能性は低い。

結論として、停止箇所は録音開始後、STT送信前にある。

### 3.2 コード上の矛盾

- 本番の `useAutoRecordingStatusHandler.ts` は `AppRoot.tsx` から渡された `AUTO_START_THRESHOLD_DB = -30` を使い、200ms連続でこの値以上にならない限り発話開始としない。
- リポジトリには既に純粋な発話検出ポリシー `expo/autoBargeDetector.ts` が存在し、通常時の開始閾値を `-35 dB`、停止閾値を `-45 dB` と定義している。
- 同ポリシー用の既存自己テストは、通常発話 `[-55, -45, -36, -34, -33, -32]` を「開始する」と期待している。本番の `-30 dB` 判定では、この列は一度も開始条件を満たさない。
- 本番ハンドラーは既存ポリシーをimportせず、開始閾値、保持時間、短い落ち込みの許容を別実装している。
- `scripts/auto-barge-detector-selftest.ts` はimport先が誤っており、実行するとモジュール解決エラーになる。また通常のJestスイートにも登録されていない。

### 3.3 ベースライン検査

変更前に次を確認した。

- `cd expo && npx tsc --noEmit`: 成功
- `cd expo && npm test -- --runInBand`: 成功（46 suites / 260 tests）
- `cd expo && node ../scripts/auto-barge-detector-selftest.ts`: 失敗（誤ったimport先）
- `cd expo && node ../scripts/auto-audio-selftest.ts`: 失敗（誤ったimport先）

この時点では `auto-audio-selftest.ts` を発話開始不具合の範囲外とした。その後、同ファイルが表す重複方針のAirPods例外がTTS停止の直接原因と実機ログで判明したため、24章で削除対象へ変更する。

## 4. 根本原因

根本原因は、発話検出ポリシーが二重化され、本番だけが厳しすぎる `-30 dB` の開始条件を使用していることである。通常の発話が閾値に届かない場合、本番は録音中の `listening` に留まり、無音確定もSTT送信も始まらない。

既に期待動作を表す純粋ポリシーがあるにもかかわらず本番から未使用で、さらにその自己テストが壊れて通常テストから外れていたため、実装差異が検出されなかった。

## 5. 固定する修正方針

### 5.1 単一の判定元

`evaluateAutoBargeDetection` を、本番における以下の唯一の判定元にする。

- 通常時および再生中の開始閾値
- 発話開始までの保持時間
- 閾値を一時的に下回った場合の猶予時間
- 発話開始後の停止閾値
- AirPods利用時の適応型ノイズフロア

`useAutoRecordingStatusHandler.ts` にある同内容のインライン計算・保持判定は削除する。`AUTO_START_THRESHOLD_DB` だけを `-35` に変更して二重実装を残す修正は禁止する。

### 5.2 ファイル配置

ポリシーはアプリ実装とテストの既存境界に置く。

- `expo/autoBargeDetector.ts` を `expo/src/features/app/utils/autoBargeDetector.ts` へ移動する。
- 本番ハンドラーは移動後のファイルから直接importする。
- 呼び出しを名前変更するだけのラッパーは作らない。

### 5.3 状態管理

新しいグローバル設定、永続化項目、`AppRoot.tsx` のrefを追加しない。

- `noiseFloorDb` は、録音capture cycleごとに生成されるstatus handlerのクロージャ内で保持し、初期値を `-80` とする。
- 既存の `autoAboveSinceRef` と `autoAboveGapSinceRef` は、detectorの `aboveSinceMs` と `gapSinceMs` の保存先としてそのまま使う。これにより既存の停止、再開、face tracking抑止、recoveryのリセット経路を壊さない。
- 各status tickでrefとローカルnoise floorからdetector stateを組み立て、戻り値の `nextState` を同じ保存先へ戻す。
- 新しいcapture cycleでは新しいhandlerが作られるため、noise floorも初期化される。
- `short_speech_discarded` で同じ録音を継続する直前には `aboveSinceMs` と `gapSinceMs` を0へ戻し、直後の誤再検出を防ぐ。

### 5.4 本番ハンドラーへの適用

1 status tickにつきdetectorを1回評価し、その同じ出力を後続処理で共有する。

- UIの発話サンプル表示は `metering >= detector.startThresholdDb` を使う。
- 波形診断へ `detector.startThresholdDb` と `detector.startHoldMs` を渡す。
- 発話未開始時は `detector.shouldStart` だけで `speaking` へ遷移する。
- 発話開始ログとbarge-in probeログはdetectorが返す閾値、保持時間、`aboveForMs` を記録する。
- 発話開始後の無音判定は `detector.stopThresholdDb` を使う。同じtickで得た値を使用し、別の停止閾値を再計算しない。
- `ongoing_speech_overlap` とpost-TTS human判定も、意味が同じ箇所ではdetectorの開始・停止閾値を使う。
- AirPods向けfast-stop probeは、通常の発話開始より前にTTS停止を早める別責務なので残す。ただし基準に使う開始閾値はdetector出力とする。
- face tracking、録音watchdog、STT送信、pending message、TTS、UIボタンの制御は変更しない。

### 5.5 不要になる設定の削除

detectorの既定値と重複する次の値は、利用箇所がなくなった時点で `UseAutoRecordingStatusHandlerOptions`、`AppRoot.tsx` の定数・引数、hook依存配列から削除する。

- `autoStartThresholdDb`
- `autoStartHoldMs`
- `autoStopThresholdDb`
- `autoBargeInThresholdOffsetDb`
- `autoBargeInAirpodsThresholdOffsetDb`
- `autoBargeInHoldMs`
- `autoBargeInAirpodsHoldMs`
- `autoBargeInHoldGapToleranceMs`

既存の明示的な製品要件をdetectorのoptionへ移し替えるのではなく、重複を削除してdetectorの既定ポリシーを採用する。fast-stop、silence duration、min/max speech durationなど別責務の値は残す。

## 6. テスト方針

### 6.1 純粋ポリシーテスト

`expo/src/features/app/utils/autoBargeDetector.test.ts` を追加し、壊れている `scripts/auto-barge-detector-selftest.ts` のケースをJestへ移す。移行後、古い自己テストは削除する。

最低限、次を固定する。

1. 非再生時の通常発話 `[-55, -45, -36, -34, -33, -32]` は開始する。
2. 非再生時の単発スパイクは開始しない。
3. AirPodsでTTS再生中のノイズ列は開始しない。
4. AirPodsでTTS再生中の発話と短い落ち込みを含む列は開始する。
5. スピーカーでTTS再生中の単発スパイクは開始しない。
6. detectorが入力stateを破壊せず、次stateを返す。

### 6.2 本番接続の回帰テスト

純粋ポリシーのテストだけでは、本番が再び独自判定へ戻っても検出できない。`useAutoRecordingStatusHandler` に対し、最小限のJestテストを追加する。

- Reactの `useCallback` と `expo-av` をテスト内でmockし、外部I/Oは実行しない。
- `Date.now()` と録音status列を固定する。
- `-30 dB` には届かないがdetectorでは通常発話になる列を流し、状態が `speaking` になることを確認する。
- 続けて十分な発話時間と無音を流し、`finalizeAutoCapture(true, "silence")` が1回だけ呼ばれることを確認する。
- 発話とならない列では `finalizeAutoCapture(true, ...)` が呼ばれず、`listening` のままであることを確認する。

テスト用のoption生成ヘルパーはテストファイル内に閉じ、本番用ラッパーや汎用factoryを増やさない。

### 6.3 全体検査

実装者はworktreeで次をすべて実行する。

```sh
cd /Volumes/SSD-500GB-SanDisk/work/bitty-worktree/fix/auto-voice-conversation/expo
npx tsc --noEmit
npm test -- --runInBand

cd /Volumes/SSD-500GB-SanDisk/work/bitty-worktree/fix/auto-voice-conversation
git diff --check
```

変更後に、変更ファイルの行数とdiffを確認する。既に7,000行を超える `AppRoot.tsx` は増やさず、重複引数・定数の削除によって小さくする。

## 7. 受入条件

自動テストと実機確認の両方が必要である。

### 7.1 自動テスト

- TypeScript検査が成功する。
- Jest全件が成功する。
- 3.3の壊れたbarge detector自己テストがJestへ移され、古いスクリプトが削除されている。
- 通常発話列が本番status handlerを `speaking` に遷移させる。
- 無音後に文字起こしありの確定がちょうど1回発生する。
- ノイズ、単発スパイク、TTS自己音による既存の誤開始防止ケースが成功する。

### 7.2 実機確認

利用者が対象worktreeからiPhoneへビルドし、次を確認する。

1. マイクボタンを押し、通常の会話音量で話して黙る。
2. `listening` から発話中表示へ変わる。
3. runnerログに `POST /stt` が1件発生する。
4. 文字起こしが利用者メッセージとして自動送信される。
5. アシスタント応答がTTS再生される。
6. TTS後、自動で次の発話待機へ戻る。
7. もう一度マイクボタンを押すと停止し、追加のSTT送信が発生しない。
8. TTS再生音だけでは新しい利用者発話が誤生成されない。

実機確認が終わるまで「復旧完了」としない。

## 8. 変更範囲

### 変更するファイル

- `expo/src/features/app/hooks/useAutoRecordingStatusHandler.ts`
- `expo/src/features/app/AppRoot.tsx`（不要な定数・引数・ref配線の削除のみ）
- `expo/src/features/app/utils/autoBargeDetector.ts`（既存ファイルの移動）
- `expo/src/features/app/utils/autoBargeDetector.test.ts`
- status handlerの回帰テスト1ファイル
- `scripts/auto-barge-detector-selftest.ts`（Jest移行後に削除）

### 変更しない領域

- `ChatScreen.tsx` のマイクボタンUI
- `/stt` のAPI仕様、runner、認証
- TTS処理
- マイク権限やnative設定
- face trackingの製品仕様
- 設定永続化・schema
- `scripts/auto-audio-selftest.ts`（この初期制約は24章の新証拠により削除対象へ変更）
- 新規依存関係

上記「変更しない領域」を直さなければならない新証拠が出た場合は、実装範囲を勝手に拡大しない。

## 9. 禁止事項

- `-30` を別のマジックナンバーへ置き換えるだけの対症療法
- detectorと本番の二重判定を残すこと
- detectorを呼ぶだけの薄いwrapper
- 新しい設定項目、feature flag、環境変数
- 新しい依存パッケージ
- native iOS/Androidコードの変更
- ログ追加だけで不具合修正とすること
- unrelatedなformat変更、rename、リファクタリング
- main checkoutへの編集、mainへのmerge

## 10. リスクと抑制策

| リスク | 抑制策 |
| --- | --- |
| 開始閾値を実効的に緩めることで誤検出が増える | detector既存のhold、gap、再生中strict filter、AirPods適応判定を本番にも同時適用し、単発スパイクとTTSノイズをテストする |
| 停止閾値変更により騒音環境で無音確定しにくい | detectorが返す動的停止閾値を単一利用し、実機で発話後の確定を確認する |
| handlerと純粋ポリシーの接続が将来外れる | handler回帰テストで `-30 dB` 未満の通常発話列から確定までを通す |
| Jestでは実マイクのmeteringを保証できない | iPhoneでの実機確認を完了条件にする |

## 11. 診断が無効になる停止条件

実装中または実機確認で次が判明したら、追加修正をせず `USER_INPUT_REQUIRED` として計画作成者へ返す。

- 録音status callbackに `metering` が存在しない、常に同じ値、または常に `-160` である。
- detectorが開始判定を返しているのに `speaking` へ遷移しない。
- `finalizeAutoCapture(true, ...)` まで到達しているのに `/stt` が送信されない。
- native設定の更新、dependency追加、API変更が必要になる。
- 変更しない領域に主原因があるという再現可能な証拠が出る。

報告には「観測事実」「この計画と矛盾する点」「次に必要な判断」を含める。推測で別層へ修正を広げない。

## 12. 完了定義

次のすべてを満たした時だけ完了とする。

- 5章の単一ポリシー化が完了し、重複した本番判定と不要な引数・定数が削除されている。
- 6章の自動検査がすべて成功している。
- 主担当がdiffを自己レビューし、薄いwrapper、不要な抽象化、別層へのロジック漏出がない。
- 計画作成者が実装diffとテスト結果をレビューしている。
- 利用者が7.2の実機確認を完了している。
- その後、worktree運用手順に従ってcommit、push、PR、独立レビュー、CI確認を行う。
- 利用者の明示承認なしにmainへmergeしない。

## 13. 実機再検証で判明した追加ブロッカー（2026-07-18）

### 13.1 前段修正の実機結果

前段のVAD修正は有効だった。修正版アプリの実機ログで次を確認した。

- iPhoneから `POST /stt` が複数回送信された。
- `autoState` は `listening` だけでなく `speaking`、`cooldown` まで遷移した。
- したがって、マイク押下、録音、発話開始、無音確定、STT送信は復旧している。

前段のdetector統合とテストは戻さない。

### 13.2 新しい観測事実

STT成功後の自動送信時に、画面へ「不明なパネルIDのため送信を中止しました。」というToastが表示された。client logには次が記録されている。

- `event: "panel_write_rejected_unknown_panel"`
- `panelId: ""`
- `reason: "unknown_panel_id"`
- `screen: "mini_board"`
- 一部の発生時点では `autoEnabled: true`、`autoState: "cooldown"`

これは録音停止ではなく、文字起こし後の送信先解決失敗である。

### 13.3 追加根本原因

MiniBoardの`ChatScreen`は、テキスト送信時には `sendReplyTranscriptForPanel(panelId, text)` を使って送信先を明示する。一方、マイク開始時は全画面共通の `startAutoRecordingMode()` を引数なしで呼ぶ。

その後、`useRecordingTranscriptionController`も `sendReplyTranscript(nextTranscript, { sttMeta })` または `sendReplyRequest(nextTranscript, { sttMeta })` として送信し、録音を開始したパネルIDを渡さない。`resolveWritePanelId(undefined)` は空文字へ正規化され、`panelRuntimeEntriesById[""]` が存在しないため、既知パネル検証で拒否される。

つまり、追加根本原因は「録音開始元のパネル情報が、録音ライフサイクルとSTTキューを通じて保持されていないこと」である。

## 14. 追加修正の固定方針

### 14.1 責務とデータフロー

自動録音の開始元を、1つの `panelId` として明示的に次の経路で引き継ぐ。

```text
ChatScreen
  -> startAutoRecordingMode(panelId)
  -> useAutoRecordingEngine（現在の自動録音ターゲットを保持）
  -> enqueueAutoTranscribe / transcribeRecording（キュー投入時に値を固定）
  -> useRecordingTranscriptionController
  -> sendReplyTranscript({ panelId })
  -> resolveWritePanelId
```

既知パネル検証を無効化したり、空のIDを適当なパネルへ推測で割り当てたりしない。

### 14.2 実装仕様

1. `ChatComposerContext.startAutoRecordingMode` と関連する既存型を、`(panelId?: string) => void` に変更する。
2. `ChatScreen` はパネルruntime viewの場合だけ、正規化済みの現在の `panelId` を `startAutoRecordingMode` へ渡す。通常の非パネル画面では引数なしを維持する。
3. 自動録音ライフサイクルの所有者に `autoRecordingPanelIdRef` を1つだけ置く。録音開始時に値を設定し、その自動録音モード中は別画面へ移動しても変更しない。
4. `finalizeAutoCapture` と手動停止時の文字起こしは、現在のref値を `enqueueAutoTranscribe` / `transcribeRecording` へ明示的に渡す。
5. 非同期STTキューは、Promise実行時ではなくキュー投入時に `panelId` の文字列を固定する。停止や別の録音開始によるref変更で送信先が変わってはならない。
6. `useRecordingTranscriptionController` の既存option型を拡張し、STT成功後にテキスト入力と同じ `sendReplyTranscript` へ `panelId` を渡す。
7. 自動録音停止後にtarget refを空へ戻す。ただし、既にキュー投入済みの項目は固定済みの値を使い続ける。
8. `mode_start_requested`、`auto_transcribe_enqueued`、`auto_reply_dispatch` の既存ログpayloadへ `panelId` を含め、次回の実機確認で経路を追跡できるようにする。

### 14.3 変更対象

- `expo/src/features/app/screens/ChatScreen.tsx`
- `expo/src/features/app/contexts/ChatComposerContext.tsx`
- `expo/src/features/app/hooks/useAppContextActions.ts`
- `expo/src/features/app/hooks/useAutoRecordingEngine.ts`
- `expo/src/features/app/hooks/useRecordingTranscriptionController.ts`
- 上記配線に必要な `AppRoot.tsx` のref・引数追加
- 追加回帰テスト

既存型の伝播に必要なファイルだけを変更する。新しいcontext、store、汎用target managerは作らない。

### 14.4 変更しないもの

- `resolveWritePanelId` の既知パネル検証
- パネルruntime snapshot・hydrationの仕様
- STT API、runner、TTS、native設定
- VAD detectorと前段のテスト
- 手入力テキストのパネル送信経路
- 複数パネルへ同時送信する機能
- 非パネル画面の送信先仕様（今回の実機不具合は `screen: "mini_board"` で再現）

### 14.5 禁止事項

- 空のpanel IDを最初のパネル、現在表示中らしいパネル、最後に更新されたパネルへ推測で置き換えること
- `resolveWritePanelId` を常に成功させること
- STT完了時に画面状態から送信先を再取得すること
- 送信先をモジュールグローバルへ置くこと
- 新規context、設定、dependencyを追加すること
- VAD修正を削除・緩和すること

## 15. 追加回帰テストと受入条件

### 15.1 自動テスト

最低限、次を固定する。

1. パネルID付きで自動録音を開始すると、STT後の `sendReplyTranscript` に同じpanel IDが渡る。
2. `autoSpeakAfterReply` の値にかかわらず、音声送信はテキスト入力と同じ `sendReplyTranscript` だけを通る。
3. STTキュー投入後にtarget refを変更またはクリアしても、投入済み音声は元のpanel IDへ送られる。
4. `ChatScreen` のパネルruntime viewからマイクを開始した場合、現在のpanel IDを開始関数へ渡す。
5. 非パネルviewは引数なしの既存動作を維持する。
6. 前段を含む全Jest、TypeScript、`git diff --check` が成功する。

本番コードをテストしない文字列検索だけのテストは禁止する。既存hookを直接通すか、既存component testの境界を使う。

### 15.2 実機受入条件

MiniBoardの対象チャットパネルで確認する。

1. 対象パネルのマイクボタンを押して発話し、黙る。
2. `POST /stt` が成功する。
3. `panel_write_rejected_unknown_panel` と該当Toastが発生しない。
4. ログ上の `auto_reply_dispatch.panelId` が押下したパネルIDと一致する。
5. 文字起こしされた利用者メッセージが押下した同じパネルへ追加される。
6. 同じパネルでアシスタント応答とTTSが動作する。
7. TTS後も同じパネルを送信先として次の発話待機へ戻る。
8. 別パネルへ誤送信されない。

## 16. 追加停止条件

次が判明した場合は範囲を拡大せず、再度 `USER_INPUT_REQUIRED` とする。

- `ChatScreen`から正しいpanel IDが渡っているのに、録音開始時点で対象のruntime entryが存在しない。
- 正しいpanel IDとsession snapshotが送信関数まで届いているのに、既知パネル検証で拒否される。
- パネル送信成功後、別パネルのメッセージまたはTTSへ投影される。
- 修正にパネルruntime/hydrationの仕様変更が必要になる。

## 17. 実機再検証で判明した表示競合（2026-07-18）

### 17.1 実機結果

前段のpanel ID伝播後、次は成功した。

- 録音
- STT
- 同じpanelへのユーザーメッセージ送信
- LLMレスポンス

一方、送信時の再描画でユーザーメッセージとLLMレスポンスが一瞬表示されて消え、再表示される事象が残った。

### 17.2 ログで確定した競合

同一セッションで、実機ログは次の順序を記録した。

1. `07:14:05` から15件目の末尾が `.` / `..` / `...` と約180ms間隔で変化し、音声専用placeholderが継続更新されていた。
2. `07:14:06.066` に正規送信がpanel runtimeを16件（実ユーザー入力）へ更新した直後、`07:14:06.362` にplaceholder側の15件へ戻った。
3. `07:14:12.444` にLLMの最初の応答で17件へ更新した直後、`07:14:12.951` に再びplaceholder側の15件へ戻った。
4. LLM完了時の最終panel書き込みで17件へ戻った。同じ順序は次の音声送信でも再現した。

音声経路だけが `useAutoPendingUserController` を使い、STT中の表示として `.` / `..` / `...` の仮ユーザーメッセージをグローバル `conversationMessages` へ書き込んでいた。このグローバル書き込みが、同じセッションを表示するpanel runtimeの正規メッセージ列を古い内容で上書きしていた。

テキスト送信はこの仮メッセージ機構を通らない。さらに音声側には、読み上げ設定に応じて `sendReplyTranscript` と `sendReplyRequest` を選ぶ不要な分岐が残っていた。読み上げ可否はLLM応答完了側で既に判定されるため、音声側で送信関数を分ける理由はない。音声だけが別の会話storeへ書き込み、別の送信入口も選べる構造だったため、テキスト入力と挙動が一致していなかった。

## 18. 上流の根本修正方針

音声専用の仮ユーザーメッセージ機構を削除し、STTが文字列を返した後は、テキスト入力と同じ送信関数だけに会話メッセージの追加を任せる。

```text
テキスト: 入力文字列 ─┐
                      ├─> sendReplyTranscript
音声: 録音 -> STT文字列 ┘       └─> canonical panel/runtime write
```

音声とテキストの差は「文字列を得るまで」と「録音開始元panel IDを保持すること」だけに限定する。会話へのユーザーメッセージ追加、LLMレスポンス、hydration、TTSは同じ下流処理を使う。

### 18.1 削除するもの

- `useAutoPendingUserController.ts` 全体
- `AUTO_PENDING_USER_ANIMATION_FRAMES`
- `AUTO_PENDING_USER_ANIMATION_INTERVAL_MS`
- `AUTO_PENDING_USER_PROBE_TIMEOUT_MS`
- pending user用のmessage ID、animation、timeout、visible timestampのref
- 録音engine、VAD status handler、capture recovery、capture core、STT controller、unmount cleanupへ渡しているpending user用引数
- 音声専用の `startAutoPendingUserMessage` / `resolveAutoPendingUserMessage` 呼び出し
- 未使用の `buildConversationWithLatestUserMessage`
- pending userだけが利用している `removeConversationMessageById`
- `ConversationMessage.pendingUser`

### 18.2 維持するもの

- STT結果の `sttMeta`
- 録音開始時に固定したpanel ID
- `sendReplyTranscript` から始まる正規送信経路（auto TTS設定はLLM応答完了側で判定する）
- barge-in時の直接 `stopTtsPlayback({ interruptStream: true })`
- VAD、無音確定、STTキュー、既知panel検証
- text送信の既存実装

barge-inは既に発話検出時にTTS停止を直接要求している。仮メッセージの表示を経由した二重のTTS停止は削除する。

## 19. 根本修正の受入条件

### 19.1 コード構造

- STT成功後、音声経路はテキスト入力と同じ `sendReplyTranscript` 以外の方法でconversation messagesを書き換えない。
- `useAutoPendingUserController.ts` が削除され、pending user用のref・timer・prop配線が残っていない。
- 音声とテキストが同じpanel送信関数へ合流する。
- `AppRoot.tsx` と関連hookの引数・行数が増えず、pending機構削除によって減る。

### 19.2 自動テスト

1. STT成功時、panel IDと`sttMeta`を含めて `sendReplyTranscript` が1回だけ呼ばれる。
2. 録音ファイルSTTとiOS直接STTのどちらにも `sendReplyRequest` という別入口を注入しない。
3. STT開始、成功、無視対象、エラーのいずれでも、STT controllerが会話message store用callbackを呼ばない（そのcallback自体をoptionから削除する）。
4. barge-in検出は仮メッセージなしでTTS停止を直接要求する。
5. 全Jest、TypeScript、`git diff --check` が成功する。

### 19.3 実機確認

1. 音声送信後、ユーザーメッセージとLLMレスポンスが消えない。
2. panel runtimeのmessage countが新しい値から古い値へ戻らない。
3. `pending_user_message_start` / `pending_user_message_resolved` が発生しない。
4. 音声・テキスト送信の両方が同じpanelで安定表示される。
5. TTSと次の録音待機が継続する。

## 20. 実装体制

この17〜19章の監査・実装・テスト・diffレビューは、利用者の指示により計画作成者が直接行う。サブエージェントへ委任しない。

## 21. 根本修正の実施結果（2026-07-18）

### 21.1 実装結果

- `useAutoPendingUserController.ts` を削除した。
- pending user専用のmessage属性、ref、timer、store更新関数、および各hookへの引数伝播を削除した。
- 録音ファイルSTTとiOS直接STTの送信入口を `sendReplyTranscript` へ統一した。
- `autoSpeakAfterReply` による音声側の送信入口分岐を削除した。読み上げ設定の判定は既存のLLM応答完了処理だけに残した。
- panel IDと`sttMeta`は正規送信関数へ渡すメタデータとして維持した。
- hydration、panel runtime、message reconciliationへ同期パッチや例外処理を追加していない。

### 21.2 自動検査結果

- `./node_modules/.bin/tsc --noEmit`: 成功
- `./node_modules/.bin/jest --runInBand`: 成功（52 suites / 276 tests）
- `git diff --check`: 成功
- pending user関連識別子の `expo/src` 内検索: 0件

### 21.3 未完了の確認

利用者の実機再確認により、録音、送信、LLM応答、および前節のメッセージ表示競合は基本的に解消した。一方、録音モードに限り、LLM応答後のTTS再生中に画面が再生成されるとTTSが停止する事象が判明したため、復旧完了とはしない。

## 22. TTS再生を録音watchdogが停止する責務競合（2026-07-18）

### 22.1 コード監査結果

STT成功後の送信入口は、テキスト入力と同じ `sendReplyTranscript` に統一済みである。今回の差は送信処理ではなく、録音モードを維持するための応答後の音声制御にあった。

録音モードだけに次の2つの逆向き依存が残っていた。

1. `usePrepareTtsPlaybackSessionController` が端末スピーカーでのTTS開始前に `stopAutoRecordingMode()` を呼び、録音サイクルではなく自動会話モード全体を停止していた。
2. `useAutoRecordingWatchdog` が録音status callbackの遅延を検出すると、録音を復旧する代わりに `stopTtsPlayback({ interruptStream: true })` を呼んでいた。

MiniBoardのsession一覧更新とpanel再生成はLLM完了後に発生し得る。この処理と録音status callbackの遅延が重なると、録音watchdogがTTSを停止できる構造だった。通常のテキスト送信では録音watchdogが動かないため再現しない。

録音の健全性監視がTTSの生存期間を決定するのは責務違反であり、閾値変更では再発を防げない。

### 22.2 根本修正

- 録音watchdogからTTS停止処理を削除した。
- TTS割り込み専用のwatchdog ref、6個の閾値定数、stream TTS状態の引数伝播を削除した。
- 録音watchdogは録音statusの読取り、発話確定、録音サイクル再起動だけを担当する。
- 端末スピーカー優先時のTTS準備では、自動会話モード全体を止めず、現在の録音サイクルだけを `finalizeAutoCapture(false, "tts_playback")` で終了する。
- 端末スピーカー優先時はLLM応答中およびTTS中の録音再開を待機させる。TTS完了後、既存の録音再開処理へ戻る。
- 当時はAirPodsのbarge-inを維持したが、この例外が実機停止の直接原因だったため24章で撤回する。
- 明示的なbarge-in検出によるTTS停止は維持する。画面再生成や録音watchdogからは停止しない。

新しいstore、同期guard、設定、TTS wrapperは追加しない。既存の誤った依存を削除し、録音とTTSの所有境界を戻す。

### 22.3 受入条件

1. テキスト入力と音声入力は、STTより下流で同じ `sendReplyTranscript` を通る。
2. `useAutoRecordingWatchdog` は `stopTtsPlayback` を参照しない。
3. 端末スピーカーでTTSを開始しても `autoRecordingEnabledRef` は `true` のままで、現在の録音サイクルだけが停止する。
4. 端末スピーカー優先時はLLM応答中・TTS中に録音watchdogを起動しない。
5. TTS完了後に同じpanel IDを保持したまま録音待機へ戻る。
6. この段階ではAirPods barge-inを受入条件としたが、24章の統一方針で置き換える。
7. TTS再生中にMiniBoardが再生成されても、TTSが途中停止しない。

### 22.4 自動検査

- TTS準備時に自動会話モードを維持し、現在の録音サイクルだけを停止するhook testを追加する。
- 当時のAirPods例外を固定するhook testを追加したが、24章で再生優先を入力経路非依存へ変更する。
- barge-in有効でも、端末スピーカー優先かつTTS準備中は録音サイクルを開始しないengine testを追加する。
- 全Jest、TypeScript、`git diff --check`を実行する。

### 22.5 実機確認

1. 端末スピーカーで録音モードを開始し、発話、STT、LLM応答、TTSまで進める。
2. LLM完了後にMiniBoardの再生成が発生しても、TTSが最後まで再生される。
3. TTS中にマイク波形または録音watchdogが再起動しない。
4. TTS完了後に録音待機へ自動復帰する。
5. 続けて発話すると、同じpanelへ送信される。

### 22.6 実装・自動検査結果

- `useAutoRecordingWatchdog.ts` からTTS停止処理とTTS/stream状態への依存を削除した（436行から306行）。
- `usePrepareTtsPlaybackSessionController.ts` は `stopAutoRecordingMode` を呼ばず、現在のcaptureだけを確定終了する。
- 端末スピーカー優先時のLLM応答中・TTS中はcapture開始を待機する。
- `usePrepareTtsPlaybackSessionController.test.ts` を追加した。AirPods例外の期待値は24章の新証拠に基づいて更新する。
- `useAutoRecordingEngine.test.ts` に、barge-in有効でも端末スピーカー優先時のTTS captureを開始しない回帰テストを追加した。
- `./node_modules/.bin/tsc --noEmit`: 成功
- `./node_modules/.bin/jest --runInBand`: 成功（53 suites / 279 tests）
- `git diff --check`: 成功
- 録音watchdog内の `stopTtsPlayback` および削除対象識別子の検索: 0件

残る確認は22.5の実機動作のみとする。

## 23. 前回修正後も継続したTTS停止の追加分析（2026-07-18）

### 23.1 実機ログで確定した停止順序

前回修正後も挙動が変わらないという実機結果を受け、画面再生成とTTS停止を時刻で再監査した。該当する自動会話では次の順序だった。

1. `07:14:51.323` にTTS合成開始と同時にMiniBoard内の複数`ChatScreen`がunmountされたが、この時点では `ttsPlaying: false`、`ttsLoading: true` だった。
2. `07:14:52.226` に `ttsPlaying: true` となり、TTS再生が開始した。
3. `07:14:52.780` に対象外panelの`ChatScreen`がunmountされたが、直後も `ttsPlaying: true` を維持していた。したがって、unmount自体は停止原因ではない。
4. `07:14:53.068` に自動録音状態が `listening` から `speaking` へ変化したのと同時に、`ttsPlaying` が `true` から `false` へ変化した。

通常モードのTTSは、同じMiniBoardのunmountとhydrateが繰り返されても再生を継続していた。録音モードだけでTTS再生音を発話と判定し、明示的なbarge-in停止を呼んだことが差分である。

### 23.2 前回修正で残っていた根本原因

前回の「TTS中はcapture開始を待機する」条件は、React render時の `ttsLoading` と `ttsPlaying` を参照していた。しかし `finalizeAutoCapture` は録音終了時に500ms後の再開タイマーを予約する。このタイマーが保持する `startAutoCaptureCycle` はTTS開始前のクロージャであり、TTS開始後も古い `ttsLoading: false` を参照してcaptureを再開できた。

さらに `setAudioModeForPlayback` は、録音実体の有無ではなく `autoRecordingEnabledRef.current` だけで再生用Audio Sessionへの切替を拒否していた。現在のcaptureを終了しても自動会話モード自体は有効なままなので、前回の方針では常にこの切替がskipされる矛盾があった。

つまり、停止原因は画面refreshでも送信関数の差でもなく、次の2点である。

- 再開タイマーが古いrender snapshotからTTS状態を読むこと。
- capture終了後も、自動会話モードが有効という理由だけで再生専用Audio Sessionへ移行できないこと。

### 23.3 固定する追加修正

1. capture開始可否は、既存のリアルタイムref `ttsPlaybackWantedRef.current` をTTSパイプラインの一次判定にする。これは合成開始から全chunk再生終了まで同期的に更新され、古いReactクロージャの影響を受けない。
2. TTS再生優先時は入力経路を問わず、`ttsPlaybackWantedRef`、`ttsPlayingRef`、`ttsLoading` のいずれかがactiveならcaptureを開始しない。
3. `setAudioModeForPlayback` は、自動会話モードの有効フラグではなく、実際の `autoRecordingRef.current` が存在する間だけ切替をskipする。capture解放後はモードを維持したまま `allowsRecordingIOS: false` へ移行できるようにする。
4. AirPodsを含むbarge-inは、TTS再生優先OFFかつ割り込み発話ONの場合だけ維持する。
5. `input_changed`、`tts_playback_pause_auto_capture`、`finalize_schedule_restart`、`capture_wait`、`barge_in_detected`、`tts_stop_requested` だけをcritical診断へ追加する。全自動音声診断は有効化せず、次回実機確認で入力経路と停止理由だけを記録する。

新しいref、store、設定、送信関数、TTS wrapperは作らない。既にTTS所有者が管理している `ttsPlaybackWantedRef` を録音開始条件から直接読む。

### 23.4 回帰テスト

- TTS開始前にengineを生成し、capture終了による再開タイマーを予約した後で `ttsPlaybackWantedRef.current = true` に変え、タイマー発火後もcaptureが再開しないことを固定する。
- 自動会話モードが有効でもcapture実体が解放済みなら、Audio Sessionを再生用へ切り替えることを固定する。
- capture実体が存在する間はAudio Sessionを変更しないことを固定する。
- 端末スピーカー準備、AirPodsでの再生優先ON/OFF、panel ID保持テストを維持する。

### 23.5 追加修正の検査状況

- `useAutoRecordingEngine.test.ts`、`useAudioInputRouteController.test.ts`、`usePrepareTtsPlaybackSessionController.test.ts`: 成功（3 suites / 8 tests）
- `npx tsc --noEmit`: 成功
- 全Jest: 成功（54 suites / 282 tests）
- `git diff --check`: 成功
- `./scripts/ios/build-expo-ios-device.sh`: 成功（Release、`app.bitty.mobile`、接続中iPhoneへインストール済み）

### 23.6 実機受入条件

1. iPhoneスピーカー優先をONにして自動会話を開始する。
2. STTとLLM応答後、TTS合成開始から全chunk再生完了まで `capture_wait.reason = "playback_blocked"` になり、`ttsPlaybackWanted: true` が記録される。
3. TTS中に `barge_in_detected` と `tts_stop_requested` が発生しない。
4. MiniBoardのunmount/hydrateが発生してもTTSが最後まで再生される。
5. TTS完了後にcaptureが1回だけ再開し、同じpanelへ次の音声入力を送信できる。
6. AirPods接続時もTTS再生優先ONならcaptureを停止し、再生優先OFFかつ割り込み発話ONの場合だけbarge-inを許可する。

## 24. 修正版実機ログで確定したAirPods誤barge-in（2026-07-18）

### 24.1 今回確認したログ

指定worktree側の最新ログ `private_runner/logs/client_auto_logs/20260718_195318_178.jsonl` に、前回追加したcritical診断が記録されていた。再現セッションの順序は次のとおりである。

1. `11:36:55.687Z` の `input_changed` で、入力は `AirPods Pro`、`isAirPods: true` と確定した。
2. `11:36:59.694Z` の `finalize_schedule_restart` 後、自動録音モードは次のcaptureを開始した。
3. `11:37:03.440Z` にMiniBoard内の複数`ChatScreen`がunmountされた。この時点では `ttsLoading: true`、`ttsPlaying: false` であり、unmountは停止要求を出していない。
4. `11:37:04.415Z` 以降に `ttsPlaying: true` となったが、AirPods例外によりcaptureは `listening` のまま継続していた。
5. `11:37:04.616Z` に `barge_in_detected` が発生した。payloadは `metering: -49.92949676513672`、`phase: "speech_start"` である。
6. 同一時刻の次イベントで `tts_stop_requested` が発生し、`interruptStream: true`、`ttsPlaying: true`、`autoEnabled: true`、`autoState: "listening"` が記録された。
7. 直後に `ttsPlaying` は `false` となった。

画面再生成の約1.18秒後にTTSが再生され、その約0.20秒後に録音側がAirPodsマイクの `-49.93 dB` を発話と判定してTTSを明示停止した。したがって、停止命令の発行元は画面refresh、hydration、送信関数、録音watchdogではなく、AirPods向けbarge-in判定である。

### 24.2 前回方針が効かなかった理由

初期設定は次の2項目が同時にONである。

- `TTS再生中の割り込み発話`
- 旧表示の `iPhoneスピーカー優先（TTS中は録音停止）`

前回実装は再生優先を非AirPodsだけに適用し、AirPodsでは常にcaptureを継続した。さらにAirPods向けdetectorは適応閾値と120ms holdを使う緩い判定である。そのため、再生優先がONでもAirPodsだけは小さい入力をbarge-inとして受理し、TTSを停止できた。

これは閾値の値だけの問題ではない。`usePrepareTtsPlaybackSessionController`、`useAutoRecordingEngine`、`useAutoRecordingStatusHandler`、barge-in停止直前のguardで、再生優先と割り込み許可の関係が統一されていなかったことが根本原因である。

### 24.3 最終修正方針

TTS中にcaptureを許可する条件を、純粋関数 `shouldAllowAutoCaptureDuringTts` の1か所に固定する。

```text
TTS中のcapture許可 = 割り込み発話ON かつ TTS再生優先OFF
```

入力経路はこの方針を変更しない。AirPodsかiPhone本体マイクかは、割り込みを明示的に許可した後のdetector調整にだけ使用する。

- TTS再生優先ON: AirPodsを含め、TTS開始前に現在のcaptureを終了し、再生完了まで再開しない。
- TTS再生優先OFFかつ割り込み発話ON: TTS中のcaptureとbarge-inを許可する。
- 割り込み発話OFF: TTS再生優先の値にかかわらずTTS中のcaptureを許可しない。

この方針を次の4境界から同じ関数で参照する。

1. capture開始前: TTS intent、再生中、合成中のいずれかなら再開を待機する。
2. TTS準備時: 現在のcaptureを終了し、iOS Audio Sessionを録音不可の再生用へ切り替える。
3. 録音status処理: releaseとの競合中にstatus callbackが届いても、meteringを発話として処理しない。
4. TTS停止直前: 設定が停止を許可しない場合は `barge_in_stop_blocked` として拒否する。

UI表示も `TTS再生優先（TTS中は録音停止）` へ変更し、AirPodsを含む設定であることを明示する。新しい設定や永続化schemaは追加しない。

### 24.4 重複削除と診断

本番から参照されず、現在の本番方針とも一致せず、import先も壊れていた次の重複実装を削除する。

- `expo/audioAutoPolicy.ts`
- `scripts/auto-audio-selftest.ts`

本番が参照する方針とJestテストを `expo/src/features/app/utils/autoAudioPolicy.ts` に置き、別の自己テスト用ポリシーを残さない。

`tts_stop_requested` には停止理由を追加する。自動割り込みから停止する場合は `reason: "auto_barge_in"` を記録する。`barge_in_detected` には入力名、AirPods判定、割り込み設定、再生優先設定を含める。全音声診断は有効化せず、停止経路に必要なcriticalイベントだけを維持する。

### 24.5 回帰テスト

- 方針関数の4組合せを固定する。
- AirPods接続中でも、TTS再生優先ONならcaptureを開始しない。
- TTS開始前に予約済みの再開タイマーも、AirPods接続中かつ再生優先ONならcaptureを再開しない。
- TTS準備時、AirPods接続中でも現在のcaptureを終了し、`allowsRecordingIOS: false` へ切り替える。
- TTS再生優先ONでは、録音status callbackに大きいmeteringが届いてもbarge-in停止を要求しない。
- TTS停止直前のguardも、TTS再生優先ONなら停止要求を拒否する。
- TTS再生優先OFFかつ割り込み発話ONの場合だけ、従来の明示的barge-inを維持する。

### 24.6 自動検査結果

- 対象テスト: 成功（5 suites / 18 tests）
- `npx tsc --noEmit`: 成功
- 全Jest: 成功（55 suites / 290 tests）
- `git diff --check`: 成功
- `./scripts/ios/build-expo-ios-device.sh`: 最初の2回は端末のロック・切断によりコード工程前でexit 70。再接続後の2026-07-18 21:20 JSTにReleaseビルドと署名が成功（`** BUILD SUCCEEDED **`）。接続中のiPhone 14 Pro（UDID `00008120-000678181E07C01E`）へ `app.bitty.mobile` をインストール済み（`Completed successfully`）。

### 24.7 実機受入条件

1. AirPods Proを接続し、`TTS再生優先` をONのまま自動会話を開始する。
2. STT、同一panelへの送信、LLM応答、TTS開始まで進める。
3. TTS準備時に `tts_playback_pause_auto_capture` が記録される。
4. TTS中は `capture_wait.reason = "playback_blocked"` となり、`ttsPlaybackWanted: true` が記録される。
5. MiniBoardのunmount/hydrateが発生しても、TTSが最後まで再生される。
6. TTS中に `barge_in_detected`、`reason: "auto_barge_in"` の `tts_stop_requested` が発生しない。
7. TTS完了後にcaptureが再開し、次の発話が同じpanelへ送信される。
8. `TTS再生優先` をOFF、`TTS再生中の割り込み発話` をONにした場合だけ、明示的な割り込み発話でTTSを停止できる。

実機で24.7を満たすまで、復旧完了とはしない。

### 24.8 実機受入結果

2026-07-18、修正版Releaseアプリを接続中のiPhone 14 Proへインストールし、AirPods Proを使用した自動会話を確認した。録音、STT、同一panelへの送信、LLM応答、TTS再生完了、次の録音再開まで問題なく動作したとの利用者確認を得た。24.7の受入条件を満たしたため、本障害を復旧完了とする。
