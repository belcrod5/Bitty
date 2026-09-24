# Codex App Server の自前文脈選択 技術検証

調査日: 2026-09-24。対象は [音声長期会話の設計案](VOICE-CONTEXT-CONTROL-DESIGN.md) にある「別エージェントが古い会話を `MEMORY.md` に要約し、次のモデル入力には要約と直近ターンを選ぶ」方式。現段階は公式仕様・現行コード・ローカルプロトコルスキーマの照合であり、モデルを使う実動検証は未実施。

## 結論

| 判定 | 内容 |
| --- | --- |
| 確認済み | **既存 thread の古い先頭だけを除き、直近ターンを残して任意に置換する公開操作は確認できない。** `thread/resume` は同じ会話を継続し、`thread/inject_items` はモデル可視履歴に追記する。[App Server: Threads](https://learn.chatgpt.com/docs/app-server) |
| 仕様からの推定 | **新しい thread を開始し、選んだ `MEMORY.md` と直近ターンを投入する構成は候補になる。** `thread/start` は新規会話、`thread/inject_items` はその thread への raw Responses item 追記、`turn/start` は新しい発話の開始として説明される。ただし実際のモデル要求に古い履歴が入らないこと、任意の item 列を受理することは実測していない。[App Server: start / inject / turn](https://learn.chatgpt.com/docs/app-server) |
| 確認済み | `thread/fork` は元履歴を複製し、`lastTurnId` で末尾を切る操作。古い先頭だけを除いて直近だけ残す用途ではない。`thread/compact/start` は App Server 内の圧縮を起動し、`MEMORY.md` の要約を指定して置換する操作ではない。[App Server: fork / compact](https://learn.chatgpt.com/docs/app-server) |
| 制約あり | 公式文書の `thread/rollback` は末尾 N turn を in-memory context から落として marker を保存する deprecated 操作。全 turn を落として再注入する案の動作・再開後の整合性は未検証で、現行 CLI 生成スキーマにはこの method がない。現行スキーマの `thread/revert` は paginated thread の履歴を指定 turn より前の prefix に置換する操作で、古い先頭だけを除けない。公式文書は paginated thread の新規作成を未対応としており、現行音声設計の基盤にはできない。[App Server: rollback / paginated history](https://learn.chatgpt.com/docs/app-server) |
| 別方式 | Responses API は、`conversation`／`previous_response_id` を使わず選んだ input と前回の出力 item を毎回渡す手動管理を公式に説明する。これは App Server の managed thread とは別の実行方式で、現在の Codex tool・承認・認証がそのまま移ることは意味しない。[Conversation state](https://developers.openai.com/api/docs/guides/conversation-state) |

したがって、同一 thread で古い先頭だけを選択的に外す方法は確認できない。末尾を削る `rollback`／`revert` を全履歴の作り直しに使えるかも実動未検証で、前者は廃止予定、後者は現行の paginated thread 制約がある。別エージェントの `MEMORY.md` を使う構想は維持し、新規 thread への再構成が実用上の条件を満たすかを次の実動スパイクで確かめる。

## 根拠の内訳

- **公式仕様で確認:** `thread/start` は新規会話、`thread/resume` は既存 thread を再開して後続 `turn/start` を追加する。`thread/inject_items` は loaded thread のモデル可視履歴に raw Responses item を追記し、rollout にも永続化する。`thread/compact/start` は直ちに `{}` を返し、同一 thread の `contextCompaction` item 等で進捗を通知する。`thread/fork` の `lastTurnId` は先頭から指定 turn までを複製する。[App Server](https://learn.chatgpt.com/docs/app-server)
- **ローカルスキーマで確認:** `codex-cli 0.156.0` の `codex app-server generate-json-schema --experimental --out <一時ディレクトリ>` で `ThreadInjectItemsParams` は `threadId` と追加 `items`、`ThreadCompactStartParams` は `threadId` のみ。`ThreadResumeParams.excludeTurns` は返却する `thread.turns` を省く指定で、モデル文脈の削除ではない。`thread/rollback` は生成スキーマに見当たらず、`ThreadRevertParams` は paginated thread の durable history を `beforeTurnId` より前の prefix に置換すると記す。同スキーマにある `ThreadResumeParams.history` は `[UNSTABLE] FOR CODEX CLOUD - DO NOT USE` と記載されるため、設計の根拠にしない。これは型と説明文の確認であり、実行動作の証明ではない。
- **現行コードで確認:** [`codex-turn-execution.mjs`](../private_runner/src/codex-turn-execution.mjs) は `thread/start` または `thread/resume` の後に `turn/start` を呼ぶ。resume の `excludeTurns: true` は現行でも使用するが、`thread/inject_items` や新 thread への履歴再構成は実装されていない。既存 compact は同ファイルで `thread/compact/start` を呼ぶ。Agent Service の [`agent-protocol.mjs`](../private_runner/src/agent/agent-protocol.mjs) は新規セッションに `cwd` と `clientOperationId` を要求し、[`agent-service.mjs`](../private_runner/src/agent/agent-service.mjs) は cwd を正規化し、結果不明の operation を `operation_status_unknown` で止める。
- **現行コードで確認:** [`agent-runtime.mjs`](../private_runner/src/agent/agent-runtime.mjs) の履歴変換は主に本文テキストと command の要約であり、raw Responses reasoning／tool item の再投入用記録ではない。Codex Backend の workspace admission capability は `false` だが、Runner の canonical cwd と App Server 側の sandbox・権限・`instructionSources` は別に確認が必要。[App Server: cwd / instructionSources](https://learn.chatgpt.com/docs/app-server)

## 新規 thread 案で残る確認事項

1. **モデル入力:** 空の新 thread に `MEMORY.md` と直近履歴だけを投入し、古い元 thread の item が実際のモデル要求に含まれないことを観測する。モデルの返答だけでは非投入の証拠にならない。App Server が `cwd` から読み込む指示ファイルなどは別の入力源として扱う。
2. **item と継続品質:** `thread/inject_items` が必要な user／assistant／tool／reasoning item の形と順序を受理するかを試す。公式の注入例は assistant message のみ。tool 実行・承認状態を新 thread に引き継げるとは限らない。意味的な継続に本文と要約だけで足りるか、raw item の保存が必要かを判定してからログ形式を決める。Responses API で stateless replay を選ぶ場合、公式文書は `output` 全 item（暗号化 reasoning と `phase` を含む）の保持を求める。[Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)、[App Server: tools / approvals / events](https://learn.chatgpt.com/docs/app-server)
3. **動線:** 新 thread ごとの認証、tool 接続と承認、`item/agentMessage/delta` と完了通知による stream／TTS、interrupt、再起動後の native thread 対応付けを確認する。新規セッションの内部 `cwd` は利用者に選ばせず Runner が与える候補だが、実在・正規化・App Server 権限と workspace 条件を確認する。現行の Agent Service `turn.start` には音声の論理会話 ID がない。
4. **再送:** 発話受付後・応答完了前に Runner を停止し、同じ送信 ID の再送が既存 native turn を照合できるかを確認する。結果を確定できない場合は再生成を自動開始しない。既存 `operation_status_unknown` と同様に不明状態を表現する。

## 実動検証の状態と次の手順

実動の `thread/start` → `thread/inject_items` → `turn/start` は今回実行していない。現在の Codex ホーム／認証を使うと既存セッションの保存領域や課金対象のモデル要求に触れる。独立した認証・保存領域・空のテスト `cwd` を用意していない状態では、既存会話を変更しない隔離条件を満たせない。実施したローカル操作はバイナリの版と生成スキーマの確認のみで、既存 Runner と会話ログは操作していない。

隔離した環境とテスト用認証が整ったら、(1) 元 thread に識別用の古い item を作る、(2) 別の新 thread に `MEMORY.md` 相当と選んだ直近 item だけを注入する、(3) `turn/start` の実際の上流入力から古い item の不在と item 順序を確認する、(4) tool／承認／stream／中断と再開を確認する。上流入力を安全に観測できない場合は「古い履歴が入らない」を確認済みに昇格しない。
