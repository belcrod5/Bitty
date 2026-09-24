# 音声長期会話の文脈管理 設計案

状態: 設計のみ。API方式と保存先の最終決定は技術検証後に行う。

## 目的と初期範囲

Skia ボード下部の既存ツール群の右側に音声会話アイコンを追加する。そこから開く画面は既存の音声入力コンポーネントを表示し、必要な状態・エラーだけを最小限に示す。チャット画面、会話本文リスト、テキスト入力欄、作業ディレクトリ選択は表示せず、音声で会話を続ける。古い発話は別エージェントで要約して `MEMORY.md` に保存し、次の応答に使う文脈をアプリ／Private Runner 側で選ぶ。初版の圧縮はターン間に直列実行し、会話と並列に走る圧縮は後続段階とする。

左ドロワーから開く既存チャットと、Skia の既存セッションカードから開くチャットは、Codex を選んだ場合の App Server managed thread 継続を含め、現在の動線を維持する。`backendId: "codex"` はモデル提供元の識別であり、文脈管理方式の識別には使わない。音声長期会話だけに明示的な入口を設ける。

## 現状と境界

- Skia ボードのツールは [`SkiaMiniBoardScreen.tsx`](../expo/src/features/app/screens/SkiaMiniBoardScreen.tsx) の下部に並ぶ。既存カードのセッション起動は `useSkiaMiniChatSessions` と AppRoot のチャット動線につながる。
- 現行チャットの Agent client は [`client.ts`](../expo/src/features/agent/client.ts) で provider-neutral Agent Service を優先し、条件により Codex raw relay にフォールバックする。通常チャットを raw RPC だけの構成として扱わない。
- 音声認識の接続と送信サイクルは [`useStreamingStt.ts`](../expo/src/features/stt/useStreamingStt.ts)、入力中の表示は [`StreamingSttFooter.tsx`](../expo/src/features/app/components/StreamingSttFooter.tsx) に分かれており、現在は `ChatScreen` が組み立てる。新画面はこれらを再利用し、STT 通信、録音状態、波形／使用量表示を複製しない。本文を表示しない音声会話では、応答を既存 TTS で必ず再生する。TTS 制御も既存動線につなぎ、複製しない。
- Agent Service の新規セッション要求には `cwd` が必要で、Runner は canonical cwd と workspace admission を扱う（[`agent-protocol.mjs`](../private_runner/src/agent/agent-protocol.mjs)、[`agent-service.mjs`](../private_runner/src/agent/agent-service.mjs)）。画面で作業ディレクトリを選ばせないことは、内部 `cwd` を省くことを意味しない。

ターン受付の論理契約を既存チャットと音声長期会話で共通にし、入口で論理会話 ID に結び付いた `managed`（既存）か `voice_context_controlled`（新規）を一度選ぶ。実際の transport は現行でも Agent Service と Codex raw relay があり、物理的な単一 endpoint は技術検証後に決める。選択後のターン処理と保存は方式ごとのファイルに閉じ、UI、route、既存 Agent Backend に方式判定の `if` を散らさない。共通化は現在共有する責務に限り、音声専用要件を既存 Backend 全体へ広げない。

## 会話データと保存

音声会話には native Codex thread ID とは別の論理会話 ID を付ける。文脈再構成で native thread が変わっても、利用者には同じ音声会話として表示する。具体的な native session との対応付けは API 方式の検証後に定める。

Runner が論理会話ごとに、受付済みの確定発話と生成完了した応答を順序付きで記録する完全な会話ログ、`MEMORY.md`、必要最小限の会話メタデータを保存する。完全なログを正本とし、`MEMORY.md` は再生成可能な要約とする。`MEMORY.md` 自体に要約済みの末尾位置を記録し、次の文脈は「指示 + その時点の `MEMORY.md` + 要約位置以降の過去の完了ターン + 今回の発話」から組み立てる。要約の対象、過去のターン、今回の発話を重複させない。音声認識の途中結果は正本へ入れない。

保存先候補は `private_runner/logs` 配下の音声会話専用サブディレクトリとする。ここは Git の追跡対象外で、worktree の `private_runner/logs` は main 側へ向く共有 symlink である（[`GIT-WORKTREE.md`](GIT-WORKTREE.md)）。worktree ごとに別の会話正本を作らず、既存ログや token と混在しない。共有ログの同時更新を避けるため、同手順書どおり同じ main を共有する Runner は一つだけ稼働させる。複数 Runner の同時稼働対応は初版の対象外。最終パス、容量上限、バックアップ／削除方針は実装前に決める。内部 `cwd` は Runner が用意する専用ディレクトリを候補とし、当該パスの権限と workspace 登録条件を検証する。ユーザーの作業リポジトリを音声会話の保存場所や既定 `cwd` として暗黙に使わない。

## ターン処理と圧縮

1. 画面は既存 STT hook で音声を確定し、論理会話 ID、送信 ID、確定テキストを共通のターン受付契約へ渡す。入口が論理会話 ID に対応する方式へ振り分ける。Runner は同一会話のターンを直列化し、確定発話を受付時に一度だけ永続化する。同じ送信 ID の再送では既存の受付・結果を返し、発話を重複記録しない。
2. Runner は会話ログと `MEMORY.md` を読み、選んだ API 方式で今回の文脈を組み立てる。実行前に量を測り、上限を超える場合は古い完了済みターンを別エージェントへ要約させる。初版は要約が確定してから応答ターンへ進む。
3. 要約結果の対象範囲を検証して `MEMORY.md` を原子的に更新する。失敗時は既存メモリと完全ログを維持し、範囲の欠落や二重投入を避ける。要約に失敗し、残りの履歴を安全に投入できない場合は黙って履歴を切り捨てず、ターンを失敗として扱う。
4. 応答は生成完了時に発話と同じ送信 ID に結び付けて永続化し、既存 TTS で必ず音声再生する。TTS の成否は応答ログと別の状態で扱い、再生失敗でも完了応答を消さない。中断・通信断で生成途中の応答は完了扱いにせず、再送でも同じ応答を二度記録しない。`useStreamingStt` に `replyLoading` と `ttsPlaybackActive` を渡し、返信・再生の終了に合わせて既存 hook のサイクルで録音を再開する。画面は音声入力状態と必要なエラーだけを示す。

要約エージェントは会話ログの確定済み範囲と現在の `MEMORY.md` を入力とし、継続に必要な事実、未解決事項、利用者の希望を簡潔に統合する。音声会話の応答エージェントとは役割を分ける。将来の並列圧縮では、圧縮開始時のログ末尾を固定し、その後に到着した発話は直近ターンとして残す。結果の適用時に対象範囲を照合する。この並列化と競合制御は初版に含めない。

## API 方式の技術検証

| 方式 | 文脈の扱い | 判定 |
| --- | --- | --- |
| Codex App Server managed thread の継続 | `thread/resume` と `turn/start` は既存 thread の履歴を引き継ぐ。`thread/inject_items` はモデル可視履歴への **追記** であり、古い履歴を自由に置換する手段ではない。 | 既存チャットに使用。音声の完全な自前文脈制御にそのまま使えるとは判断しない。 |
| App Server で新しい thread に再構成した文脈を渡す案 | 論理会話を維持しつつ native thread を切り替える候補。入力項目、tool、承認、stream、認証、履歴表示の継続性を実測する必要がある。 | 検証待ち。成立する前提で実装を固定しない。 |
| Responses API への毎ターンの stateless replay | `conversation` と `previous_response_id` に依存せず、各要求へ選択した input／必要な出力項目を渡す方式。公式文書は手動の会話状態管理を説明している。 | 文脈を選ぶ候補。ただし現行 Codex App Server の tool／承認／認証等と同等に使えるかは別途検証する。 |

技術スパイクでは、(1) App Server の新規 thread に `MEMORY.md` と直近ターンを渡したとき古い履歴が次のモデル入力に残らないか、(2) 直近の user／assistant／tool／reasoning item を欠落なく扱えるか、(3) Runner の既存認証、承認、streaming、中断、TTS への接続、(4) internal `cwd` と workspace admission、(5) 再起動後の論理会話復元を確認する。条件を満たす方式が決まるまで本実装の API 境界を確定しない。

公式資料: [Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)。

## 実装順と受入条件

1. 上記の技術スパイクで方式と内部 `cwd`／保存先を確定する。完全な自前文脈選択が成立しない場合は、代替方式と既存機能との差を明示して設計を更新する。
2. Runner に音声専用の論理会話、完全ログ、`MEMORY.md` 更新、直列ターン処理を実装する。通常チャットの managed thread 動線は変更しない。
3. Skia 下部ツール右に入口を追加し、会話本文リストのない音声入力画面を既存 STT hook／表示部品と接続する。
4. 文脈上限付近、要約失敗、通信断・再送、TTS 失敗、アプリ／Runner 再起動を確認する。受入基準は、長期会話が同じ論理 ID で続き、過去の要点を参照しつつ不要な古い履歴が次のモデル入力に残らず、発話・完了応答の記録が欠落・重複せず、応答を音声で聞けて既存チャットと音声入力に回帰がないこと。

初版の受入後に、別エージェントの圧縮を会話と並列に進める設計と競合テストを追加する。
