# 音声送信 `capability_unsupported` 調査（2026-09-25）

## 確認できた事実

- 実機の音声イベントは `accepted` → `dispatching` → `failed`（`capability_unsupported`）。`native_started` はない。記録先は `private_runner/logs/voice_context/v1/<会話ID>/events.jsonl`。失敗時刻は 2026-09-25 09:34:40 JST。
- `private_runner/src/voice-context-service.mjs` の `modelTurn` は、`native_started` の記録前に (1) ephemeral thread の確認、(2) `mcpServerStatus/list(threadId)` が空であることの確認、(3) `turn/start` の turn ID 確認を行い、いずれも同じ `capability_unsupported` を返し得る。`native_started` 後の tool 検出も同じコードを使うが、今回のイベント順序とは合わない。
- 保存される失敗情報は `code` のみ。内部エラーの `message`、失敗した判定、App Server の要求・応答は保存されていない。このため実機で上記 (1)〜(3) のどれだったかは確定できない。
- `codex-cli 0.156.0` を実モデル・認証情報なしの隔離環境で起動し、ダミー MCP サーバーを設定して再現した。旧音声設定（`web_search` 無効、apps 無効、`mcp_servers` 指定なし）で開始した ephemeral thread には `mcpServerStatus/list(threadId)` がそのサーバーを返す。このとき (2) の Bitty 側判定は `capability_unsupported` になる。同じ環境で `mcp_servers: {}` を指定すると一覧は空になる。どちらも ephemeral thread の作成自体は成功した。
- よって「MCP 設定の継承により、ツール実行前に Bitty 側のゼロ件要求で止まる」は再現済みの原因経路。ただし**実機で同じ経路だったとはまだ断定できない**。実機で MCP ツールが実行された証拠もない。
- 通常チャットの一般経路は `private_runner/src/codex-turn-execution.mjs` の `thread/start`／`thread/resume` を使い、音声固有のゼロ MCP 要求を適用しない（calendar 専用経路は例外）。一時的に音声へ追加されていた `mcp_servers: {}` は診断版から削除し、元の設定継承に戻した。通常チャットの設定は変更していない。

## 追加の隔離試験（実モデル・実機なし）

`codex-cli 0.156.0`、隔離した設定・作業ディレクトリ、localhost の模擬 Responses 応答を使った。`完了` は模擬応答 `MOCK_ANSWER` を音声サービスが保存した意味で、実モデルが応答した意味ではない。音声コードは一時ハーネスで旧設定と現行設定を読み込み分け、リポジトリの実装は変更していない。

| 条件 | 音声 thread の MCP | 結果 |
|---|---:|---|
| MCP 設定あり、旧音声設定、Bitty のゼロ件判定あり | 1件 | `turn/start` 前に `capability_unsupported` |
| MCP 設定あり、`mcp_servers: {}`、ゼロ件判定あり | 0件 | 模擬応答まで完了 |
| MCP 設定あり、旧音声設定、ゼロ件判定だけ隔離ハーネスで迂回 | 1件 | 模擬応答まで完了 |
| MCP 設定なし、旧音声設定、ゼロ件判定あり | 0件 | 模擬応答まで完了 |
| 使用可能な模擬 MCP あり、旧音声設定 | 1件 | MCP の `echo` は直接呼び出せたが、音声はゼロ件判定で停止 |

隔離試験での直接原因は **MCP があること自体ではなく、Bitty が MCP 一覧を非空というだけで拒否すること**。ただし実機の同一原因は未確定。また音声コードにはツール禁止の指示文、ツールイベント時の中断、`approvalPolicy: "never"` と read-only sandbox が別にある。ゼロ件判定だけを外しても、音声からのツール利用や通常チャットとの同等動作は証明されない。

## 当時の提案と判断待ち（2026-09-25、実機再送前）

`mcp_servers: {}` でツールを空にする案は採用しないことを提案する。MCP 設定を継承したまま、音声固有のゼロ件判定を見直すのが再現した停止経路への最小の対処。ただし「音声でも通常チャットと同じようにツールを使う」が要件なら、判定だけでなく、音声専用の禁止指示・中断・承認・セッション継続も合わせて設計し直す必要がある。単純な会話の模擬完了をツール同等性の証拠にしない。診断段階ではゼロ件判定自体は残す。

実機原因の確定には、音声 `modelTurn` の各段階（`thread/start`、ephemeral 判定、MCP 一覧、`turn/start`）と失敗分岐を、会話本文・設定値・資格情報を含めず短い識別子で記録する。ユーザーの了承を受け、`events.jsonl` の失敗 event に固定値 `stage`／`reason` を追加した。前回の暫定的な MCP 空設定だけは元に戻し、ツール禁止判定など他の動作は変えていない。古い失敗 event にはこれらの項目がないため、過去の分岐は復元できない。

## 実機再送の結果（2026-09-25 10:49 JST）

- 新しいイベントは `accepted` → `dispatching` → `failed`。失敗の識別子は `code=capability_unsupported`、`stage=mcp_list`、`reason=mcp_servers_present`。`native_started` はない。会話本文は調査出力に含めていない。
- 実機でも、音声側の「MCP 一覧が1件でもあれば拒否する」判定が `turn/start` より前に止めたと確定した。MCP ツールが実行されて失敗したわけではない。
- 次の判断は音声のツール方針。設定を空にせず、この一律拒否を外すのが送信エラーへの直接対処。ただし現行の音声経路には別途ツール禁止指示・ツールイベント時の中断・承認なし設定が残るため、通常チャットと同等のツール利用には別の設計判断と実モデル検証が要る。ユーザーの判断前に挙動コードは変更しない。

## 方針確定後の実装状況（2026-09-25）

ユーザーは、Skia ボードのマイクを1回押すと `StreamingSttFooter` をすぐ表示して接続後に録音を開始することと、MCP 設定のある音声応答で通常チャットと同じツール・承認 UI を使うことを指定した。上の「判断待ち」「挙動コードは変更しない」は当時の経緯であり、現在の方針ではない。

作業ツリーの応答用コードは、MCP 設定を継承し、MCP 一覧の非空を理由とする `capability_unsupported` 判定を取り除いた。応答 thread は `on-request`／`workspace-write`、`turn/start` は `on-request` とし、コマンド・ファイル変更の承認要求を Runner WS から既存の承認 UI に渡す。ツールイベントによる音声応答の中断も取り除いた。要約 thread は従来のツール無効・承認なし・read-only を維持する。応答ごとに新しい ephemeral thread を作るため、tool／reasoning item や承認状態のターン間継続はまだ提供しない。

実機ログが証明したのは旧コードの拒否分岐まで。変更後の実モデルへの送信、MCP ツール呼出し、承認 UI の実機動作、`capability_unsupported` の解消はまだ検証結果として確定していない。作業ツリーでのテスト・レビュー結果は [進捗記録](VOICE-CONTEXT-CONTROL-PROGRESS.md) に追記する。
