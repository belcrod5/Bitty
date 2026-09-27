# Skia 音声会話の逐次 TTS 設計

状態: 実装前の設計案（2026-09-27）。この文書は、[音声長期会話 v1 設計](VOICE-CONTEXT-CONTROL-DESIGN.md)の「生成途中の delta を TTS に使わない」という部分を変更する提案である。実装・実機検証はまだ行っていない。

## 目的と現状

Skia ボードの `StreamingSttFooter` から送った音声会話では、返答の最初の句読点が生成された時点から読み上げを始める。会話の正本は引き続き、成功した turn の完成本文だけを保存する。TTS の成否は会話の成否に影響させない。

現在の経路は次の通り。

1. [`voice-context-service.mjs`](../private_runner/src/voice-context-service.mjs) の `modelTurn` は App Server の `item/completed` から完成本文を集める。`item/agentMessage/delta` は読み上げに使っていない。
2. Runner は `voice.turn.completed` で完成本文を送り、[`useVoiceConversation.ts`](../expo/src/features/app/hooks/useVoiceConversation.ts) が完了時コールバックを呼ぶ。
3. [`VoiceConversationScreen.tsx`](../expo/src/features/app/screens/VoiceConversationScreen.tsx) が全文を `synthesizeSpeechStream(text, { messageId: operationId })` に渡す。既存 TTS ジョブは `mode: "text"` として全文を句読点で分割するため、分割自体はできるが開始が遅い。

通常チャットの自動読み上げも [`useCodexReplyRequest.ts`](../expo/src/features/app/hooks/useCodexReplyRequest.ts) では返答確定後に `synthesizeSpeechStream` を呼ぶ。Runner の `/stream-tts` には生成と TTS を並走させる `reply` モードもあるが、file-tools 経路では確定後の疑似 delta を使う場合がある。「通常チャットは常にモデル生成中から発声している」とは扱わない。

## 句読点処理の棚卸し

| 処理 | 現在の用途 | この変更での扱い |
| --- | --- | --- |
| `takeNextStreamTtsSegment`、`findStreamTtsSplitIndex`、`isTtsBoundaryChar` (`server-runtime.mjs`) | TTS に渡す文を `。 、 ！ ？ ! ? . , 改行` と長さ上限で分ける。長文の強制分割では空白等を優先し、サロゲートペアを避ける | **唯一の TTS 分割規則として再利用**する。音声会話用の正規表現・閾値を増やさない |
| `sanitizeStreamTtsText` (`server-runtime.mjs`) | 分割後、音声プロバイダーへ渡す文字を整形する | 既存処理を再利用し、句読点の読み上げ方を今回変えない |
| `splitPseudoTextDeltas`、`splitMockStreamChunks` (`server-runtime.mjs`) | 完成文を疑似ストリームまたは mock の文字差分にする。前者は `isTtsBoundaryChar` を参照するが、18文字での区切りは TTS セグメント規則ではない | 音声会話の本物の delta には使わない。TTS 分割器として複製・転用しない |
| `sanitizeTextForTts` (Expo) | 全文 TTS 要求前の表示テキスト整形 | 再生入口の前処理であり、句読点分割器にしない |

既存 TTS 分割テストは [`stream-tts-segmentation.test.mjs`](../private_runner/tests/stream-tts-segmentation.test.mjs) にある。分割関数を別モジュールへ移す場合、このテストの参照先を移し、既存の句読点・上限・絵文字ケースを維持する。

## 所有権と API

新しいクラス階層は作らない。Runner の既存 `handleStreamTtsSession` に閉じている「未分割文字列、連番、逐次合成 Promise」を、二つの実利用元を持つ一つのストリーム処理へ切り出す。名前と配置の候補は `private_runner/src/stream-tts-segments.mjs` の `createStreamTtsSegments({ emit, synthesize, registerMedia, signal, ...ttsOptions })`。公開操作は次だけとする。

```js
stream.append(delta); // 既存 takeNextStreamTtsSegment で完成した区間を合成キューへ送る
await stream.finish(); // 成功した生成の末尾を一度だけ flush し、合成完了を待つ
stream.cancel();       // 失敗・画面離脱時に未再生の作業を止める
```

`append` は受け取った順に文字を連結し、各区間に一意の `seq` を割り当てる。現在の `segment_queued` → `segment_tts_started` → `audio_chunk` → `segment_tts_done` を同じ順序で発行する。TTS プロバイダー呼び出し、媒体登録、イベント配信は Runner の TTS 境界が所有する。`voice-context-service.mjs` は `onText(delta)` と最終結果だけを渡し、プロバイダー、句読点、音声 URL、再生状態を知らない。

既存 `/stream-tts` の `text` モードは全文を一回 `append` して `finish`、`reply` モードは生成差分ごとに `append` して `finish` する。音声会話も同じ操作を使う。これにより分割規則、強制 flush、合成直列化、音声イベント形式は一箇所になる。独立した責務なので、12,000行を超える `server-runtime.mjs` から抽出する価値がある。一行を転送するだけのラッパーや新しい設定項目は作らない。

## 音声会話ターンと TTS ジョブ

1. `voice-context-service.mjs` の `modelTurn` は当該 `threadId`・`turnId` に一致する `item/agentMessage/delta` の文字を `onText` に渡す。`item/completed` は従来どおり正本用の完成本文を確定するために使い、同じ文字を TTS へ再投入しない。要約用 turn は `onText` を渡さない。
2. Runner の `turn.start` 音声分岐は、受理した `clientOperationId` に対して一つだけ TTS ジョブを関連付ける。初回受理の永続確定後、モデル生成が始まる前にジョブを用意する順序を保証する。同IDの再送でジョブを増やさない。既存 `llmJobEmit` と `tts:attach` のイベント履歴・再接続経路を使う。`turn.accepted` と `voice.status.result` は、存在するジョブの `jobId` を返せるようにする。ジョブ ID は会話の正本ログには保存しない。
3. モデルが成功したら完成本文を正本に保存し、`voice.turn.completed` を従来どおり送る。TTS 側は残りの文字を flush して合成を続ける。会話完了通知は TTS 合成の終了を待たない。TTS が失敗しても保存済み完成本文を失敗へ戻さず、TTS ジョブだけを `error` にする。
4. `item/agentMessage/delta` が一件もない正常完了では、完成本文を同じジョブへ一度だけ `append` してから `finish` する。差分があった場合に完成本文を全文再投入しない。差分と完成本文が一致しない場合は、発声済み部分を訂正できないため、重複再生を避けて TTS ジョブをエラーで閉じ、正本の完成本文はそのまま保持する。この照合には複数の `agentMessage` item 間の改行も含める。
5. 生成が失敗・中断した場合は未合成の末尾を flush しない。既に端末へ渡した区間は停止対象とし、会話の `voice.turn.failed` を既存どおり送る。端末が画面を閉じる操作は再生と TTS ジョブへの接続を止めるが、Runner の生成・正本保存は止めない。

音声・速度の選択を失わないため、`AppRoot` が現在使う `ttsProvider`、`selectedVoiceId`、`ttsSpeed` を音声 `turn.start` の任意の TTS 指定として渡す。Runner の入口で既存 TTS と同じ検証を行い、その指定を除いた会話 payload を `voiceContextService.start` へ渡す。会話サービスの厳格な入力検証と正本には TTS 指定を混ぜない。TTS の設定不備や合成失敗は TTS ジョブのエラーとし、正常に受理された会話 turn を失敗にしない。同IDの再送では初回ジョブの指定を維持し、異なる指定で二つ目を生成しない。端末の新設定項目や Runner の既定値への暗黙の置換は設けない。

TTS ジョブの `operationId` は音声 turn の `clientOperationId` と対応付ける。`audio_chunk` には既存の `jobId` と `seq` を使い、アプリは `{jobId, seq}` を同一再生の識別子とする。WebSocket 再接続では既存 `tts:attach` の `sinceSeq` から続きを受け取り、同じ音声チャンクをキューへ二度入れない。イベント保持上限で必要な `audio_chunk` が既に失われた場合は欠落を検出してそのジョブの自動再生を止め、後続だけを黙って再生しない。Runner 再起動でジョブが失われた場合、保存済み会話の状態確認は続けるが途中再生を自動復元しない。

## アプリ側の変更境界

- [`useSynthesizeSpeechStreamController.ts`](../expo/src/features/app/hooks/useSynthesizeSpeechStreamController.ts): 既存の `mode: "text"` の開始に加え、音声 turn に紐づくジョブへ `tts:attach` する入口を持つ。両入口は現在の `handleStreamMessage`、`enqueueStreamAudio`、再生キューを共有する。`audio_chunk` の重複除外はジョブと連番で行う。二本目のプレーヤーを作らない。
- [`useVoiceConversation.ts`](../expo/src/features/app/hooks/useVoiceConversation.ts): 受付・状態再照会で得たジョブ ID を現在の turn にだけ通知する。完了時にジョブへ再接続したり全文を再合成したりしない。ジョブが一度も得られなかった正常完了に限り、現行の全文 TTS をフォールバックとして使う。古い turn の通知は操作 ID で破棄する。
- [`VoiceConversationScreen.tsx`](../expo/src/features/app/screens/VoiceConversationScreen.tsx) と [`AppRoot.tsx`](../expo/src/features/app/AppRoot.tsx): 現在の TTS 選択を音声ターンへ渡し、既存再生制御へのジョブ接続と画面終了時の `expectedMessageId` 付き停止を配線する。ジョブへ接続した時点から `ttsLoading` を立て、最初のチャンクが遅くても `useStreamingStt` が録音へ戻らないようにする。音声再生中は生成が続いていても表示を `SPEAKING` とする。
- [`StreamingSttFooter.tsx`](../expo/src/features/app/components/StreamingSttFooter.tsx) と通常チャットの UI・送信経路は変更しない。

`voice.status` は正本の返答状態を返す。TTS ジョブは揮発性の付随情報として扱い、ジョブの消失を `unknown` な会話 turn と混同しない。音声の自動再開範囲は「同じ Runner プロセスにジョブが残っている時」までとする。

## 検証と受入条件

- Runner の分割テスト: 句読点が差分の境界をまたぐ場合、句読点なしで上限に達する場合、末尾 flush、絵文字、各区間の一回限りの合成。疑似 delta の 18文字区切りが TTS 規則に混入しないこと。
- 音声サービスのテスト: 当該 turn の delta だけ配信、要約 turn は配信しない、複数 `agentMessage`、`item/completed` での重複なし、差分なしの完成文、失敗・中断時の末尾破棄。正本には完成文だけが入ること。
- Runner WS のテスト: 受理後・最初の delta 前のジョブ生成、TTS 指定の検証と会話 payload からの分離、同じ操作 ID の再送でジョブが増えないこと、受理応答と `voice.status` のジョブ ID、`tts:attach` の再送・履歴欠落、TTS エラーが会話完了を覆さないこと。
- Expo のテスト: 最初の `audio_chunk` で完了通知前に再生開始、再接続チャンクを二重再生しない、完了時に全文再合成しない、画面終了時に他のチャットの TTS を止めない、TTS 待ち・再生中に STT が再開しないこと。
- 手動確認: Skia で短い句点付き返答を発話し、モデルの返答が終わる前に最初の区間が再生されること。句読点のない返答、長文、承認待ち、途中の通信断でも録音と読み上げの状態が破綻しないこと。

この文書は設計の保存が目的で、実装の成功や低遅延化の実測を主張しない。
