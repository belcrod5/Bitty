# ClaudeBackend 権限承認ポップアップ 進捗

- 設計書: `docs/CLAUDE-PERMISSION-PROMPT-DESIGN.md`
- ブランチ: `feat/claude-permission-prompt`
- worktree: `${BITTY_WORKTREE_ROOT}/feat/claude-permission-prompt`
- 状態: IMPLEMENTATION_COMPLETED(ローカルコミット済み・ユーザー確認待ち)

## チェックリスト

- [x] 現状調査(claude-backend / agent-service / agent-transport / Expo client)
- [x] スパイク検証(CLI 2.1.238: --safe-modeとMCP非両立、--setting-sources ""代替、allow/deny往復、deny時tool_result)
- [x] 設計書作成
- [x] 設計レビュー(Fableサブエージェント。CHANGES_REQUESTED: High1/Medium4/Low2)
- [x] レビュー反映(全指摘を設計書へ追記: pending登録時resetNoOutput、closedガード、uid検証+脅威モデル、shim側2KB切り詰め、deny時tool_result実測、shim EOF終了・並行処理、argv集合一致、toolCallId、テスト6件追加)
- [x] worktree作成
- [x] 実装1: claude-permission-bridge.mjs + テスト
- [x] 実装2: claude-permission-prompt-mcp.mjs(shim)+ テスト
- [x] 実装3: claude-backend.mjs変更 + テスト
- [x] 全テスト通過(private_runner/tests、523 pass / 0 fail / 1 skip。node_modules未導入だったためnpm ciを実施)
- [ ] コードレビュー(実装と別のサブエージェント)
- [x] ローカルコミット(ここで停止しユーザー確認)
- [ ] ユーザー実機検証(設計書§6の6項目)
- [ ] push / PR作成(ユーザー承認後)
- [ ] マージ(ユーザー承認後)
- [ ] worktree削除

## 実機検証手順(ユーザー向け)

worktree側サーバーへ切替:

```sh
cd ${BITTY_WORKTREE_ROOT}/feat/claude-permission-prompt
./private_runner/restart-keep-token.sh --mode full
```

検証項目は設計書§6を参照。

## メモ・決定事項

- 2026-08-23: スパイクで`--safe-mode`が明示的`--mcp-config`も無効化することを確認。interactive profileは`--setting-sources "" --strict-mcp-config`で隔離(CLAUDE.md不読込も確認済み)
- 既定profile(空)は`claude-dont-ask`のまま。既存呼び出しの挙動不変
- 下流(AgentService/transport/Expo)は変更禁止。差分に含まれたら設計逸脱
- 2026-08-23 実装時のハマりどころ: `net.createServer()`は既定`allowHalfOpen:false`。shimはリクエスト送信直後に`socket.end()`で書き込み側を終える一発リクエスト方式のため、既定のままだとNodeがそのFIN受信で**bridge側の書き込みも自動終了**してしまい、承認待ちが少しでも長引くconnectionで応答が書けなくなる(即答するdenyだけ偶然間に合って通ってしまうため発覚しづらい)。`net.createServer({ allowHalfOpen: true }, ...)`で解消。テスト(shimの並行tools/call)で再現・検出できた
