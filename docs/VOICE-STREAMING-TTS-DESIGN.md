# Skia 音声会話の逐次 TTS 設計

状態: 実装は PR #147 に含まれる（2026-09-27）。この文書は、[音声長期会話 v1 設計](VOICE-CONTEXT-CONTROL-DESIGN.md)の「生成途中の delta を TTS に使わない」という部分を変更する設計である。ユーザーは長文応答の読み上げ中に停止して再度開く操作を実機で確認し、問題ないと報告した。その他の実機動作や低遅延化の実測は未確認。

## 目的と変更前の経路

Skia ボードの `StreamingSttFooter` から送った音声会話では、返答の最初の句読点が生成された時点から読み上げを始める。会話の正本は引き続き、成功した turn の完成本文だけを保存する。TTS の成否は会話の成否に影響させない。

変更前の経路は次の通り。

1. [`voice-context-service.mjs`](../private_runner/src/voice-context-service.mjs) の `modelTurn` は App Server の `item/completed` から完成本文を集める。`item/agentMessage/delta` は読み上げに使っていない。
2. Runner は `voice.turn.completed` で完成本文を送り、[`useVoiceConversation.ts`](../expo/src/features/app/hooks/useVoiceConversation.ts) が完了時コールバックを呼ぶ。
3. [`VoiceConversationScreen.tsx`](../expo/src/features/app/screens/VoiceConversationScreen.tsx) が全文を `synthesizeSpeechStream(text, { messageId: operationId })` に渡す。既存 TTS ジョブは `mode: "text"` として全文を句読点で分割するため、分割自体はできるが開始が遅い。

通常チャットの自動読み上げも [`useCodexReplyRequest.ts`](../expo/src/features/app/hooks/useCodexReplyRequest.ts) では返答確定後に `synthesizeSpeechStream` を呼ぶ。変更前のアプリの通常チャットは App Server の本物の差分を表示し、TTS 要求は `mode: "text"` に固定されている。旧互換の `/stream-tts` の `reply` モードは変更前のアプリから呼ばれず、file-tools 経路では完成文を疑似 delta にしている。「通常チャットはモデル生成中から発声している」とは扱わない。

## 句読点処理の棚卸し

| 処理 | 変更前の用途 | この変更での扱い |
| --- | --- | --- |
| `takeNextStreamTtsSegment`、`findStreamTtsSplitIndex`、`isTtsBoundaryChar` (`server-runtime.mjs`) | TTS に渡す文を `。 、 ！ ？ ! ? . , 改行` と長さ上限で分ける。長文の強制分割では空白等を優先し、サロゲートペアを避ける | **唯一の TTS 分割規則として再利用**する。音声会話用の正規表現・閾値を増やさない |
| `sanitizeStreamTtsText` (`server-runtime.mjs`) | 分割後、音声プロバイダーへ渡す文字を整形する | 既存処理を再利用し、句読点の読み上げ方を今回変えない |
| `splitPseudoTextDeltas` (`server-runtime.mjs`) | 旧 `reply` file-tools の完成文と、旧 Responses stream の差分なし時を18文字程度の疑似 delta にする | **PR #147 で削除**。新しい TTS 分割器へ統合・転用しない |
| `splitMockStreamChunks` (`server-runtime.mjs`) | `RUNNER_MOCK` 時だけ完成文を16文字ずつ疑似配信する | mock 専用として区別する。旧 `reply` 経路を廃止するなら利用箇所ごと削除し、TTS 規則には混ぜない |
| `sanitizeTextForTts` (Expo) | 全文 TTS 要求前の表示テキスト整形 | 再生入口の前処理であり、句読点分割器にしない |

既存 TTS 分割テストは [`stream-tts-segmentation.test.mjs`](../private_runner/tests/stream-tts-segmentation.test.mjs) にある。分割関数を別モジュールへ移す場合、このテストの参照先を移し、既存の句読点・上限・絵文字ケースを維持する。

疑似 delta は完成文の到着を早めず、アプリにも届かない。PR #147 では `splitPseudoTextDeltas` と両呼び出し箇所を削除し、旧 `reply` と Responses の差分なし時の完成文を一度だけ通知して既存の TTS 分割へ渡す。旧 `stream_mode` の値は維持したが、イベント時刻は変わり得るため、外部利用と互換性の確認は残る。`mode: "text"` とアプリの再生経路は維持する。削除のためだけに共通の疑似分割ユーティリティを作らない。

## 所有権と API

新しいクラス階層は作らない。Runner の既存 `handleStreamTtsSession` に閉じている「未分割バッファ → 既存規則での区間確定 → 区間 `seq` 採番 → 直列合成 → `segment_queued` / `segment_tts_started` / `audio_chunk` / `segment_tts_done` 発行」を、一つの状態機械として `text` と音声会話の二つの実利用元で共有する。句読点判定関数だけの共有では不十分。名前と配置の候補は `private_runner/src/stream-tts-segments.mjs` の `createStreamTtsSegments({ emit, synthesizeSegment, signal, speedScale })`。`synthesizeSegment(text)` の Runner 側実体は一箇所だけに置き、既存の `runTtsByProvider` と `registerTtsMedia` を音声会話入口へ複写しない。新モジュールはプロバイダー選択・検証、ジョブ登録、会話の保存を所有しない。公開操作は次だけとする。

```js
stream.append(delta); // 既存 takeNextStreamTtsSegment で完成した区間を合成キューへ送る
await stream.finish(); // 成功した生成の末尾を一度だけ flush し、合成完了を待つ
stream.cancel();       // 生成失敗・中断時に未着手の区間を破棄する
```

`append` は受け取った順に文字を連結し、各区間に一意の `seq` を割り当てる。現行どおり区間確定時に `segment_queued` を同期発行し、`segment_tts_started` → `audio_chunk` → `segment_tts_done` は直列キュー内で一回ずつ発行する。プロバイダー呼び出し・媒体登録の実体とジョブ履歴への配信は既存 Runner 境界が所有する。`voice-context-service.mjs` は `onText(delta)` と最終結果だけを渡し、プロバイダー、句読点、音声 URL、再生状態を知らない。Expo と Runner の正規化処理に加えて第三の TTS テキスト整形を作らない。

既存 `/stream-tts` の `text` モードは全文を一回 `append` して `finish`、残す場合の旧 `reply` モードは本物の生成差分があれば都度 `append` する。変更前の旧 `reply` は差分ゼロだと完成文を `reply` に代入するだけで分割バッファに入れないため、この経路を残すなら完成文を一回 `append` して `finish` する。音声会話も同じ操作を使う。これにより分割規則、末尾 flush、合成直列化、音声イベント形式は一箇所になる。独立した責務なので、12,000行を超える `server-runtime.mjs` から抽出する価値がある。単発 `/tts` API は区間イベント・キューを必要としないため対象外とし、既存の下位合成関数を再利用する。一行を転送するだけのラッパーや新しい設定項目は作らない。

## 音声会話ターンと TTS ジョブ

1. `voice-context-service.mjs` の `modelTurn` は当該 `threadId`・`turnId` に一致する `item/agentMessage/delta` の文字を `onText` に渡す。`item/completed` は従来どおり正本用の完成本文を確定し、未配信の末尾だけを補う（手順4）。完成本文を無条件に TTS へ再投入しない。要約用 turn は `onText` を渡さない。
2. Runner の `turn.start` 音声分岐は、受理した `clientOperationId` に対して一つだけ TTS ジョブを関連付ける。現行 `voiceContextService.start` は `accepted` 永続化後すぐ `queueMicrotask(runTurn)` するため、Runner の `.then` でジョブを作るだけでは順序保証にならない。初回受理時に `accepted` の append 後、`runTurn` を予約する前の TTS 非依存の受理コールバックでジョブを用意する。この一箇所だけのフックは再送時には呼ばない。Runner 側で受理前にジョブを仮作成すると、拒否・重複再送時の破棄と競合調整が増えるため採らない。TTS 設定エラーは作れたジョブだけを失敗にし、容量不足などジョブを作れない場合は `jobId` なしで会話を進め、正常完了時だけ現行の全文 TTS へフォールバックする。準備失敗を受理済み会話へ伝播させない。同IDの再送でジョブを増やさない。既存 `llmJobEmit` と `tts:attach` のイベント履歴・再接続経路を使う。`turn.accepted` と `voice.status.result` は、存在するジョブの `jobId` を返せるようにする。ジョブ ID は会話の正本ログには保存しない。
3. モデルが成功したら完成本文を正本に保存し、`voice.turn.completed` を従来どおり送る。TTS 側は残りの文字を flush して合成を続ける。会話完了通知は TTS 合成の終了を待たない。TTS が失敗しても保存済み完成本文を失敗へ戻さず、TTS ジョブだけを `error` にする。
4. 差分と完成本文は `itemId` 単位で照合する。各 `agentMessage` の生 delta を当該 item の観測文字列に積み、完成本文と比較する時だけ先頭空白を除く。完成本文がその接頭辞なら未配信の末尾だけを `append` し、観測文字列の末尾空白を除くと完成本文と等しい場合は補完しない。先頭・末尾以外で食い違えば、発声済み部分を訂正できないので TTS ジョブだけを失敗にする。delta がない item は完成本文を一度だけ渡す。`itemId` のない delta は帰属を推測せず、その turn の以後の逐次 TTS を止める。まだ何も `append` していなければ正常完了時に完成全文を一回だけ渡し、既に渡していれば重複を避けて TTS ジョブだけを失敗にする。item 間の `\n` は次の本文を流す時に一度だけ挿入する。正本との最終照合は完成 item 本文を `join("\n").trim()` して行い、生 delta の空白差で誤失敗させない。Expo の二つの App Server 表示観測器にも item 単位の補完があるが、UI の状態管理を Runner へ持ち込む共通層は作らない。必要なのは音声会話内の最小限の item 観測だけで、句読点分割は既存処理を使う。
5. 生成が失敗・中断した場合は未合成の末尾を flush しない。既に端末へ渡した区間は再生停止対象とし、会話の `voice.turn.failed` を既存どおり送る。音声通知 listener が TTS コールバックの例外を握り潰す実装なので、TTS 側で例外を捕捉してジョブを失敗状態へ閉じ、会話の成否へ伝播させない。フッターの停止を明示的に押した場合は `voice.turn.interrupt` で Runner の生成と TTS ジョブを中断し、未完了の返答を正本へ保存せず、遅れて届く完了通知も端末側で無視する。WS 切断だけでは Runner の生成・合成・正本保存を止めない。画面の単純なアンマウントでは購読解除と再生停止を行うが、Runner の生成・合成・正本保存は継続する。生成失敗・中断時の `cancel()` は未着手区間を破棄し、進行中のプロバイダー呼び出しが戻っても後続の音声イベントを出さない。プロバイダー呼び出しそのものの中断は保証しない。

音声・速度の選択を失わないため、`AppRoot` が現在使う `ttsProvider`、`selectedVoiceId`、`ttsSpeed` を音声 `turn.start` の任意の TTS 指定として渡す。Runner の入口で既存 TTS と同じ検証を行い、その指定を除いた会話 payload を `voiceContextService.start` へ渡す。会話サービスの厳格な入力検証と正本には TTS 指定を混ぜない。TTS の設定不備や合成失敗は TTS ジョブのエラーとし、正常に受理された会話 turn を失敗にしない。同IDの再送では初回ジョブの指定を維持し、異なる指定で二つ目を生成しない。端末の新設定項目や Runner の既定値への暗黙の置換は設けない。

TTS ジョブの `operationId` は音声 turn の `clientOperationId` と対応付ける。番号は二種類あり、`audio_chunk.seq` は音声区間番号、`llmJobEmit` の `eventSeq` は履歴イベント番号である。アプリは `{jobId, audio_chunk.seq}` をジョブ寿命中記憶し、再送チャンクを表示・統計・再生キュー投入などの副作用より前に除外する。変更前の `countedAudioChunkSeqs` は通信量計測の二重計上だけを防ぎ、再生の重複は防がない。`tts:attach.sinceSeq` には最後に受け取った `eventSeq` を渡す。Runner の job snapshot に最後に `audio_chunk` を発行した区間番号を持たせる。再接続時は再送された音声区間番号の連続性と snapshot の最終番号を照合する。非音声イベントは履歴から間引かれるため、`eventSeq` の飛びだけでは音声欠落と判定しない。必要な `audio_chunk` が保持上限で失われていればそのジョブの自動再生を止め、後続だけを黙って再生しない。Runner 再起動でジョブが失われた場合、保存済み会話の状態確認は続けるが途中再生を自動復元しない。

## アプリ側の変更境界

- [`useSynthesizeSpeechStreamController.ts`](../expo/src/features/app/hooks/useSynthesizeSpeechStreamController.ts): 既存の `mode: "text"` の開始に加え、音声 turn に紐づくジョブへ `tts:attach` する入口を持つ。両入口は現在の `handleStreamMessage`、`enqueueStreamAudio`、再生キューを共有する。`normalizeRunnerWsIncomingTtsEvent` は `streamId` を `event` の外に返すので、両入口から共通 handler へジョブ ID を明示的に渡し、`{jobId, seq}` の重複除外を `audio_chunk` 副作用より前に置く。現行 Runner WS の各イベント envelope には `streamId` があり、旧 WebSocket も `audio_chunk` 前に `job_snapshot` で ID を送る。識別子のないチャンクは推測して再生せずエラーにする。再接続には別の `eventSeq` を使い、二本目のプレーヤーは作らない。
- [`useVoiceConversation.ts`](../expo/src/features/app/hooks/useVoiceConversation.ts): 受付・状態再照会で得たジョブ ID を現在の turn にだけ通知する。完了時にジョブへ再接続したり全文を再合成したりしない。ジョブが一度も得られなかった正常完了に限り、現行の全文 TTS をフォールバックとして使う。古い turn の通知は操作 ID で破棄する。
- [`VoiceConversationScreen.tsx`](../expo/src/features/app/screens/VoiceConversationScreen.tsx) と [`AppRoot.tsx`](../expo/src/features/app/AppRoot.tsx): 現在の TTS 選択を音声ターンへ渡し、既存再生制御へのジョブ接続と画面終了時の `expectedMessageId` 付き停止を配線する。ジョブへ接続した時点から `ttsLoading` を立て、最初のチャンクが遅くても `useStreamingStt` が録音へ戻らないようにする。音声再生中は生成が続いていても表示を `SPEAKING` とする。
- [`StreamingSttFooter.tsx`](../expo/src/features/app/components/StreamingSttFooter.tsx): 逐次 TTS のための送信ロジックは加えない。PR #147 には別途、入力欄の伸長に関する UI 修正が含まれる。

`voice.status` は正本の返答状態を返す。TTS ジョブは揮発性の付随情報として扱い、ジョブの消失を `unknown` な会話 turn と混同しない。音声の自動再開範囲は「同じ Runner プロセスにジョブが残っている時」までとする。

## 検証と受入条件

- Runner の分割テスト: 句読点が差分の境界をまたぐ場合、句読点なしで上限に達する場合、末尾 flush、絵文字、各区間の一回限りの合成と4イベントの順序。`text` と音声会話が同じ状態機械・合成実体を使うこと、旧 `reply` の差分ゼロ時に完成文を一度だけ合成すること。疑似 delta の 18文字区切りが TTS 規則に混入しないこと。
- 音声サービスのテスト: 当該 turn の delta だけ配信、要約 turn は配信しない、複数 `agentMessage`、`item/completed` での重複なし、item ごとの前後空白差、`itemId` 欠落、差分なしの完成文、失敗・中断時の末尾破棄。正本には完成文だけが入ること。
- Runner WS のテスト: 受理後・最初の delta 前のジョブ生成、準備コールバック失敗・容量不足でも会話を続けること、TTS 指定の検証と会話 payload からの分離、同じ操作 ID の再送でジョブが増えないこと、受理応答と `voice.status` のジョブ ID、`tts:attach` の再送・履歴欠落、TTS エラーが会話完了を覆さないこと。
- Expo のテスト: 最初の `audio_chunk` で完了通知前に再生開始、同一 `{jobId, seq}` の再送で表示・統計・再生を二重更新しない、ID 欠落時は再生しない、完了時に全文再合成しない、画面終了時に他のチャットの TTS を止めない、TTS 待ち・再生中に STT が再開しないこと。既存 `text` は Expo で `sanitizeTextForTts` を通す一方、音声 turn は生 delta なので、URL・Markdown 内の句読点による早期区切りは未検証の品質リスクである。境界を跨ぐ差分で検証し、既存の整形で安全に扱えなければ発声時点や正規化の設計を見直す。未検証の段階で第三の整形器を増やさない。
- 手動確認: Skia で短い句点付き返答を発話し、モデルの返答が終わる前に最初の区間が再生されること。句読点のない返答、長文、承認待ち、途中の通信断でも録音と読み上げの状態が破綻しないこと。

この文書は設計の保存が目的で、PR #147 のマージや低遅延化の実測を主張しない。
