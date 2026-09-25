# Codex App Server の自前文脈選択 技術検証

調査日: 2026-09-24。対象は [音声長期会話の設計](VOICE-CONTEXT-CONTROL-DESIGN.md) にある「別エージェントが古い会話を `MEMORY.md` に要約し、新規 thread に確定済み要約と未要約の完了メッセージを投入する」方式。公式仕様・当時のコード・ローカルスキーマに加え、隔離した App Server と localhost の模擬モデル提供先でプロトコルと上流リクエストを確認した。実モデルへの送信は未実施。

## 結論

| 判定 | 内容 |
| --- | --- |
| 確認済み | **既存 thread の古い先頭だけを除き、直近ターンを残して任意に置換する公開操作は確認できない。** `thread/resume` は同じ会話を継続し、`thread/inject_items` はモデル可視履歴に追記する。[App Server: Threads](https://learn.chatgpt.com/docs/app-server) |
| ローカル実測と未検証 | **新しい thread に選んだ文脈を投入する構成は候補になる。** 隔離した App Server の localhost 模擬提供先への `/v1/responses` 要求では、`input` 配列にメモリー相当と直近の user／assistant 2往復、今回の発話が順に入り、別 thread の古い識別文字列は入らなかった。ephemeral thread でも開始・注入・模擬上流への投入を確認した。ただし実モデルへの要求、tool／reasoning item の継続は未検証。[App Server: start / inject / turn](https://learn.chatgpt.com/docs/app-server) |
| 確認済み | `thread/fork` は元履歴を複製し、`lastTurnId` で末尾を切る操作。古い先頭だけを除いて直近だけ残す用途ではない。`thread/compact/start` は App Server 内の圧縮を起動し、`MEMORY.md` の要約を指定して置換する操作ではない。[App Server: fork / compact](https://learn.chatgpt.com/docs/app-server) |
| 制約あり | 公式文書の `thread/rollback` は末尾 N turn を in-memory context から落として marker を保存する deprecated 操作。全 turn を落として再注入する案の動作・再開後の整合性は未検証で、現行 CLI 生成スキーマにはこの method がない。現行スキーマの `thread/revert` は paginated thread の履歴を指定 turn より前の prefix に置換する操作で、古い先頭だけを除けない。公式文書は paginated thread の新規作成を未対応としており、現行音声設計の基盤にはできない。[App Server: rollback / paginated history](https://learn.chatgpt.com/docs/app-server) |
| 別方式 | Responses API は、`conversation`／`previous_response_id` を使わず選んだ input と前回の出力 item を毎回渡す手動管理を公式に説明する。これは App Server の managed thread とは別の実行方式で、現在の Codex tool・承認・認証がそのまま移ることは意味しない。[Conversation state](https://developers.openai.com/api/docs/guides/conversation-state) |

したがって、同一 thread で古い先頭だけを選択的に外す方法は確認できない。末尾を削る `rollback`／`revert` を全履歴の作り直しに使えるかも実動未検証で、前者は廃止予定、後者は現行の paginated thread 制約がある。別エージェントの `MEMORY.md` を使う構想は維持し、新規 thread への再構成が実用上の条件を満たすかを実モデルで確かめる。

2026-09-25 の v1 実装契約では、以下の模擬実験の「直近2往復」は上限ではない。音声応答と非同期要約は `gpt-6-luna`／`low` に固定し、20履歴メッセージを超えた古い分の要約を応答と独立して試みる。新発話では旧要約を中止し、遅延結果は task identity・cursor・正本照合で破棄する。要約の成功・永続確定までは全未要約完了メッセージを順に投入し、50件超でも黙って落とさない。固定指示・確定済みメモリー・全未要約ペア・今回発話の可視テキストが800,000 UTF-8 bytesを超えれば明示失敗し、件数や32 KiBで剪定しない。モデルの実際の文脈窓使用率は計測していない。応答 thread は MCP／apps 設定を継承し、承認要求を既存 UI に渡す。要約 thread だけは MCP／apps を無効化し、承認なし・read-only とする。

## 根拠の内訳

- **公式仕様で確認:** `thread/start` は新規会話、`thread/resume` は既存 thread を再開して後続 `turn/start` を追加する。`thread/inject_items` は loaded thread のモデル可視履歴に raw Responses item を追記し、rollout にも永続化する。`thread/compact/start` は直ちに `{}` を返し、同一 thread の `contextCompaction` item 等で進捗を通知する。`thread/fork` の `lastTurnId` は先頭から指定 turn までを複製する。[App Server](https://learn.chatgpt.com/docs/app-server)
- **ローカルスキーマで確認:** `codex-cli 0.156.0` の `codex app-server generate-json-schema --experimental --out <一時ディレクトリ>` で `ThreadInjectItemsParams` は `threadId` と追加 `items`、`ThreadCompactStartParams` は `threadId` のみ。`ThreadResumeParams.excludeTurns` は返却する `thread.turns` を省く指定で、モデル文脈の削除ではない。`thread/rollback` は生成スキーマに見当たらず、`ThreadRevertParams` は paginated thread の durable history を `beforeTurnId` より前の prefix に置換すると記す。同スキーマにある `ThreadResumeParams.history` は `[UNSTABLE] FOR CODEX CLOUD - DO NOT USE` と記載されるため、設計の根拠にしない。これは型と説明文の確認であり、実行動作の証明ではない。
- **通常チャットのコードで確認:** [`codex-turn-execution.mjs`](../private_runner/src/codex-turn-execution.mjs) は `thread/start` または `thread/resume` の後に `turn/start` を呼び、resume の `excludeTurns: true` を使用する。通常チャットには `thread/inject_items` による履歴再構成を加えず、音声専用サービスに分離する。既存 compact は同ファイルで `thread/compact/start` を呼ぶ。Agent Service の [`agent-protocol.mjs`](../private_runner/src/agent/agent-protocol.mjs) は新規セッションに `cwd` と `clientOperationId` を要求し、[`agent-service.mjs`](../private_runner/src/agent/agent-service.mjs) は cwd を正規化し、結果不明の operation を `operation_status_unknown` で止める。
- **現行コードで確認:** [`agent-runtime.mjs`](../private_runner/src/agent/agent-runtime.mjs) の履歴変換は主に本文テキストと command の要約であり、raw Responses reasoning／tool item の再投入用記録ではない。Codex Backend の workspace admission capability は `false` だが、Runner の canonical cwd と App Server 側の sandbox・権限・`instructionSources` は別に確認が必要。[App Server: cwd / instructionSources](https://learn.chatgpt.com/docs/app-server)

## 新規 thread 案で残る確認事項

1. **モデル入力:** ローカル模擬提供先では、別 thread の古い識別文字列が新 thread の上流 `input` に含まれず、単純なメッセージ群が順に入ることを確認した。実モデルへの要求でも同じか、複雑な item を加えて確認する。要約遅延・失敗・中止・逆順完了、20件から50件超への連続発話、再起動、800,000-byte 境界で、要約確定前の欠落と確定後の重複がないことを上流 `input` で検査する。モデルの返答だけでは非投入の証拠にならない。App Server が `cwd` から読み込む指示ファイルなどは別の入力源として扱う。
2. **item と継続品質:** 単純な user／assistant message の受理と順序は模擬上流で確認した。現在の実装は応答 thread に MCP／apps 設定を継承し、tool item を理由に中断しない。App Server のコマンド実行／ファイル変更承認要求は Runner WS 経由で通常チャットの承認 UI に渡す。承認が必要なケース、ツール実行、UI 決定後の動作を実モデルでは未検証。新しい ephemeral thread へ tool／reasoning item や承認状態を再投入する記録はなく、ターン間の意味的継続は本文と要約による。ツール状態の継続が必要なら保存形式と方式を再検討する。Responses API で stateless replay を選ぶ場合、公式文書は `output` 全 item（暗号化 reasoning と `phase` を含む）の保持を求める。[Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)、[App Server: tools / approvals / events](https://learn.chatgpt.com/docs/app-server)
3. **動線:** 新 thread ごとの認証、完了通知による Runner／TTS、中断、内部 `cwd` と sandbox の統合動作を確認する。内部 `cwd` は利用者に選ばせず、Runner の永続 `v1/` 保存先の隣の専用 `ephemeral-tmp/` に作る。応答は `on-request`／`workspace-write`、要約は `never`／`read-only` の権限をそれぞれ確認し、承認 UI の許可・拒否・切断を実機で確認する。終了時と起動時に正規名・所有者一致の残存ディレクトリだけを回収すること、App Server 権限と workspace 条件を確認する。既存チャットの入口や STT `chirp_3` を変えない。
4. **再送と表示:** ephemeral thread は App Server 再起動後に `thread/read`／`thread/resume` で復元できないことをローカルで観測した。v1 は発話受付後・応答完了前に Runner が停止し、native 要求済みか不明な送信 ID を `unknown` に固定して自動再生成しない。受理前後・dispatch 後・完了後の再起動、同 ID 再送、WS 再接続を検査する。Runner が返す推定文脈使用率（可視テキストの UTF-8 byte 数を token 数の代用値として 1,050,000-token 文脈窓で割った切り上げ％。実測ではない）、未要約完了メッセージ件数、ヘッダーを除く `MEMORY.md` 本文 Unicode コードポイント数が open/status/accepted/terminal と音声画面の任意 prop を使う共通フッターで更新され、通常チャット表示は変わらないことも確認する。

## 隔離した実動検証と次の手順

`codex-cli 0.156.0` を空の一時 `CODEX_HOME`、空のテスト `cwd`、認証情報を継承しない環境で起動した。OpenAI Docs の [App Server 手順](https://learn.chatgpt.com/docs/app-server)どおり `initialize` → `thread/start` → `thread/inject_items` → `thread/read` を実行し、すべて成功した。注入した assistant message は隔離ホームの rollout に保存された。一方 `thread/read` は 0 turn を返し、注入文自体は返さなかった。したがって `thread/read` の結果だけを注入履歴の確認方法にはしない。

さらに、[公式設定リファレンス](https://learn.chatgpt.com/docs/config-file/config-reference)の値を CLI `-c` で指定した。`model_provider="bitty_mock"`、`model_providers.bitty_mock.name="Bitty Mock"`、`model_providers.bitty_mock.base_url="http://127.0.0.1:<一時ポート>/v1"`、同 provider の `wire_api="responses"`、`requires_openai_auth=false`、`request_max_retries=0`、`stream_max_retries=0` とし、モデル名は `gpt-6-sol` とした。認証情報は渡さず、HTTP(S) proxy も localhost に向けた。テストは一時領域内だけで、既存 Runner／会話／認証やリポジトリの実装コードを変更していない。

空のテスト `cwd` で thread A/B を別々に `thread/start` した後、次の item を注入した。`MEMORY_SUMMARY` は `MEMORY.md` の内容に見立てたテスト文字列であり、実ファイルは読ませていない。各行は送信した JSON-RPC の要点で、`threadId` は実際には直前の `thread/start` の返値を使う。

```json
{"id":2,"method":"thread/start","params":{"cwd":"<空のテストcwd>"}}
{"id":3,"method":"thread/inject_items","params":{"threadId":"<A>","items":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"OLD_A_ONLY"}]}]}}
{"id":4,"method":"thread/start","params":{"cwd":"<空のテストcwd>"}}
{"id":5,"method":"thread/inject_items","params":{"threadId":"<B>","items":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"MEMORY_SUMMARY"}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"RECENT_USER_1"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"RECENT_ASSISTANT_1"}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"RECENT_USER_2"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"RECENT_ASSISTANT_2"}]}]}}
{"id":6,"method":"turn/start","params":{"threadId":"<B>","input":[{"type":"text","text":"CURRENT_USER"}]}}
```

localhost 模擬 endpoint が受けた 1 件の `POST /v1/responses` の JSON body を解析すると、`input` は8項目の配列だった。該当部分の役割とテスト文字列は `input[2..7] = [assistant/MEMORY_SUMMARY, user/RECENT_USER_1, assistant/RECENT_ASSISTANT_1, user/RECENT_USER_2, assistant/RECENT_ASSISTANT_2, user/CURRENT_USER]` の順で、`OLD_A_ONLY` は `input` 全体になかった。初回の簡単な A/B テストは HTTP body 全体で文字列の有無を確認したが、この追加テストでは `input` フィールドを直接検査した。模擬 endpoint は受信後に 503 応答を用意してプロセスを止めたため、実モデルへの送信・課金や生成完了は試していない。

対照試験では、非 ephemeral thread に注入した user／assistant item と現在発話から、localhost 模擬提供先の正常 SSE で `item/agentMessage/delta` と成功した `turn/completed` を受けた。App Server 再起動後の `thread/read`／`thread/resume` で完了 turn を確認でき、同 thread の次ターンの上流入力には注入 item と初回 user／assistant が残っていた。一方、`thread/read` の `turns` は注入 item 自体を列挙しなかった。これは既存 thread を継続すると履歴が残ることのローカル対照であり、注入 item の確認を `thread/read` だけに頼れないことも示す。

追加で、同じバージョンの生成スキーマに `ThreadStartParams.ephemeral` があることを確認した。隔離ホームで `thread/start {cwd:<空のテストcwd>, ephemeral:true}` は `thread.ephemeral:true` と `path:null` を返し、assistant item の `thread/inject_items` も成功した。localhost 模擬提供先を指定した別試験では、この ephemeral thread の `turn/start` から `/v1/responses` の `input` に注入した識別文字列が入った。模擬提供先から正常な SSE を返す追加試験では、`item/agentMessage/delta` の `EPHEMERAL_MOCK_REPLY` と成功した `turn/completed` を観測した。App Server 再起動後、同じ隔離ホームで `thread/read` は `-32600: thread not loaded`、`thread/resume` は `-32600: no rollout found for thread id` を返した。`thread/list` も0件だった。これは **単一 item と模擬応答のローカル実測**であり、実モデルの完了や複数 item の ephemeral での順序は未検証。v1 設計は再起動後に ephemeral thread を復元しない。

[公式 App Server 文書の restricted read access](https://learn.chatgpt.com/docs/app-server#sandbox-read-access-readonlyaccess) は `sandboxPolicy.readOnly.access` を記すが、手元の `codex-cli 0.156.0` 生成スキーマには `readOnly.access` がない。上と同じ隔離構成の別試験で `turn/start.sandboxPolicy = { "type": "readOnly", "access": { "type": "restricted", "includePlatformDefaults": true, "readableRoots": ["<空のテストcwd>"] }, "networkAccess": false }` を送ると、App Server は `-32600: Invalid request: readOnly.access is no longer supported; use permissionProfile for restricted reads` と拒否し、localhost 模擬提供先への要求は0件だった。したがって現在の CLI で「空の cwd だけ読める」とは設計できない。`permissionProfile` の代替動作も未検証であり、v1 の通常 read-only sandbox は read tool の非実行・他ファイルの非読取を保証しない。

この2026-09-24の実測は、単純な user／assistant message とメモリー相当文字列の受理・順序・別 thread からの分離、および模擬提供先での ephemeral turn 完了に限る。2026-09-25には、実機ログで旧音声経路の `capability_unsupported` が MCP 設定の非空を拒否する判定（`stage=mcp_list`／`reason=mcp_servers_present`）と確定した。現在の音声応答コードではその判定を使わず、隔離した App Server／localhost 模擬提供先で MCP 設定を継承した入力到達をテストしている。これは実モデルによるツール実行、承認、Runner と TTS の統合動作、変更後の実機でのエラー解消を証明しない。
