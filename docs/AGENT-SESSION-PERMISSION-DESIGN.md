# Agent Backend セッション許可 設計

## 文書情報

- 状態: 設計確定、実装未着手
- 対象ブランチ: `feat/claude-session-permission`
- 基準: `origin/main` c6367b0、2026-08-23
- 対象: neutral経路のClaude / Codex承認
- 親契約: `docs/AGENT-BACKEND-ARCHITECTURE-DESIGN.md` §3.3、§7.1、§7.4

## 結論

`allow_for_session`は共通action契約に既に存在するため、共通serviceやUIへ新しい概念を追加しない。

- Expoは、要求側が`allow_for_session`を提示した場合だけ、そのdecisionを丸めず送る
- ClaudeBackendは、許可したtool名をnative session ID単位でRunnerメモリへ保持し、同じsessionの後続要求をBackend境界で即時許可する
- CodexBackendは、共通`allow_for_session`をApp Serverの公式`acceptForSession`へ変換する
- AgentService、transport、承認ダイアログ、Claude bridge/shimは変更しない

Claudeの公式`updatedPermissions(destination: "session")`だけでは、BittyのturnごとにCLI processを起動する構成で次turnまで保持できないことを実測した。そのため、ClaudeだけはBackendがsession許可を保持する。

## 1. 根本原因

現象は「このセッションでは常に許可」を選んでも、次の要求で再び承認を求められること。

原因は下流UIではなく、provider境界でsession decisionを失っていることにある。

1. `expo/src/features/agent/client.ts`が`approve_for_session`を常に`allow`へ丸める
2. `private_runner/src/claude-backend.mjs`が`allow | deny`しか提示・処理しない
3. `private_runner/src/codex-turn-execution.mjs`もneutral経路では`allow`を`accept`へしか変換しない

共通層の`AgentService.respondToAction()`は、各`action.requested.payload.decisions`に含まれるdecisionを検証してBackendへそのまま渡せる。ここは既に正しい。

## 2. 実測結果

### 2.1 Claude Code CLI 2.1.238

公式schemaを使い、次を返すMCP permission prompt toolで確認した。

```json
{
  "behavior": "allow",
  "updatedInput": {},
  "updatedPermissions": [{
    "type": "addRules",
    "rules": [{ "toolName": "Bash" }],
    "behavior": "allow",
    "destination": "session"
  }]
}
```

結果:

- 同一CLI process内でBashを2回呼ぶとpermission tool呼び出しは最初の1回だけ。schemaと`destination:"session"`は有効
- turn 1終了後、別processで同じsessionを`--resume`してBashを呼ぶとpermission toolが再度呼ばれた
- 従って、Claudeのin-memory session permissionはconversation transcriptへ保存されず、turn単位processを跨がない
- settings fileへ保存する`localSettings`等は会話sessionを越えるため、本機能には使わない

公式仕様: [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks#permission-update-entries)

### 2.2 Codex App Server 0.149.0

公式App Server契約はcommand/file change approvalの両方で`acceptForSession`を受理する。現行neutral Backendだけがそれを共通decisionへ公開していない。

インストール済み0.149.0の`codex app-server generate-json-schema`でも、次を確認した。

- `CommandExecutionRequestApprovalResponse.decision`に`acceptForSession`がある
- `FileChangeRequestApprovalResponse.decision`に`acceptForSession`がある
- 0.149.0のrequest paramsには`availableDecisions`が無い

従って0.149.0ではmethodを`item/commandExecution/requestApproval`または`item/fileChange/requestApproval`へ限定して提示する。未知の`*requestApproval`は現行どおり一回許可/拒否だけに留める。

公式仕様: [Codex App Server approvals](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#approvals)

## 3. 共通decisionの流れ

```text
承認ダイアログ
  approve_once        → allow
  approve_for_session → allow_for_session（要求側が提示した場合）
  decline / cancel    → deny
          ↓
AgentService（既存の検証と委譲だけ）
          ↓
ClaudeBackend: Runnerメモリへ記憶してallow
CodexBackend: acceptForSession
```

### 後方互換

Expoは`action.requested.payload.decisions`を見て送信値を決める。

| UI action | `allow_for_session`提示あり | 提示なし |
|---|---|---|
| `approve_once` | `allow` | `allow` |
| `approve_for_session` | `allow_for_session` | `allow` |
| `decline` / `cancel` | `deny` | `deny` |

古いBackendやsession許可を持たないactionへ未対応decisionを送らない。`ApprovalRequest`型へdecision一覧を複製せず、受信payloadを処理している`handleAction`内だけで判定する。

## 4. ClaudeBackend

### 4.1 許可状態

Backend instanceに次のprocess-local stateを1つ持つ。

```text
Map<nativeSessionId, Set<toolName>>
```

- keyは共通run IDやcwdではなく、Claude conversationのnative session ID
- 記録単位はpermission prompt toolから受け取るprovider-native `toolName`
- diskへ永続化しない。Runner再起動で消える
- binding、transcript、operation storeへ混ぜない

Claude permission prompt toolのMCP `tools/call.params.arguments`を加工前に記録し、`tool_name`、`input`、`tool_use_id`だけが渡り、公式Hookにある`permission_suggestions`は含まれないことを実測した。既存shimがfieldを落とした結果ではない。そのため、入力文字列の推測や独自command matcherは作らない。

### 4.2 要求時

`handlePermissionRequest`は、現在のnative session IDでtool名が許可済みなら次を行う。

- `action.requested`をemitしない
- bridgeへ即座に`allow`を返す
- activeActions/pendingActionsを作らない

未許可なら従来どおりpendingを作り、`decisions: ["allow", "allow_for_session", "deny"]`をemitする。pending entryには回答時に記録できるようtoolNameを保持する。

### 4.3 回答時

- `allow`: 今回だけbridgeへallow
- `allow_for_session`: toolNameをsessionのSetへ追加してからbridgeへallow
- `deny`: bridgeへdeny

`action.resolved.decision`には受け取った共通decisionをそのまま残す。bridge/shimのwire形式は`allow | deny`のままでよく、変更しない。

回答前から並列にpendingだった同toolの別requestは自動解決しない。共通actionはrequest単位の明示的回答を正本としているためで、許可Setは回答後に到着した新しいrequestから適用する。

### 4.4 capability

次の3箇所を同じ語彙へ揃える。

- `capabilities.action.decisions`
- `claude-on-request.policyProfiles[].decisions`
- 各`action.requested.payload.decisions`

いずれも`["allow", "allow_for_session", "deny"]`。非interactiveな`claude-dont-ask`は空のまま。

## 5. CodexBackend

Codex App Serverがsession decisionを持つため、Runner側へ記憶を重ねない。

- methodが`item/commandExecution/requestApproval`または`item/fileChange/requestApproval`の場合だけ`allow_for_session`を提示する
- `respondToAction(allow_for_session)`を`{ decision: "acceptForSession" }`へ変換する
- `allow`は`accept`、`deny`は`decline`のまま
- 未知の`*requestApproval`は`allow | deny`のまま
- dynamic toolの`result`経路は変更しない

`action.resolved`は現行のoutcome語彙をこのPRでは統一せず、`allow`と`allow_for_session`を`allowed`、`deny`を`denied`として扱う。少なくとも`allow_for_session`が現行の二値式で`denied`へ誤分類されないようにし、共通decisionもpayloadへ残す。

`action.requested`ごとのdecisionsを正確にするため、pending actionへそのrequestで利用可能なdecision一覧を保持する。provider固有の判断をAgentServiceやExpoへ漏らさない。

## 6. 変更対象

| ファイル | 変更 |
|---|---|
| `expo/src/features/agent/client.ts` | advertised decisionsに基づく後方互換付きmapping |
| `private_runner/src/claude-backend.mjs` | session/tool許可Set、capability、即時許可、回答処理 |
| `private_runner/src/codex-turn-execution.mjs` | `acceptForSession`の提示・変換 |
| 関連テスト | 上記の契約・lifecycle・互換性を追加 |

変更しない:

- `private_runner/src/agent/agent-service.mjs`
- `private_runner/src/agent/agent-transport.mjs`
- `private_runner/src/server-runtime.mjs`
- `private_runner/src/claude-permission-bridge.mjs`
- `private_runner/tools/claude-permission-prompt-mcp.mjs`
- 承認ダイアログとqueue controller

## 7. テスト計画

### ClaudeBackend

- status/profile/requestが`allow_for_session`を提示する
- `allow`後の同tool要求は再び`action.requested`になる
- `allow_for_session`後の同session・同tool要求は別runでも即時allowされ、eventをemitしない
- 同sessionでも別toolは承認を要求する
- native session IDが異なれば同toolでも承認を要求する
- `deny`、interrupt、turn失敗で許可Setへ追加されない
- Runner instanceを作り直すと許可が消える

### CodexBackend

- command/file changeで`allow_for_session`を提示し、`acceptForSession`を返す
- 未知の`*requestApproval`では`allow_for_session`を提示しない
- allow/deny/dynamic toolの既存mappingに回帰がない
- `allow_for_session`の`action.resolved`が`allowed`かつdecision保持になり、`denied`へ誤分類されない

### Expo

- advertised時だけ`approve_for_session → allow_for_session`
- 非advertised Backendでは`approve_for_session → allow`
- approve once / denyの既存mappingに回帰がない
- `events.resume`のactiveActionsから再表示したrequestでも同じmappingになる

### AgentService回帰

- advertisedされていないactionへ`allow_for_session`を送ると従来どおり拒否される
- 同toolの並列pendingは、片方のsession許可だけで勝手に回答済みにならない

### 実機

1. Claudeで「このセッションでは常に許可」後、同toolを同turnと次turnで再承認なしに実行
2. 別toolは承認を要求
3. Codex neutralでも次turnの同種approvalがApp Server側でsession許可される
4. Runner再起動後のClaudeは再承認を要求

Expo変更があるため実機確認にはアプリビルドが必要。

## 8. リスクと判断

- ClaudeのscopeはtoolName単位。特にBashはsession中のBash全体を許可する。独自のcommand matcherはprovider仕様を不完全に複製するため導入しない
- 現行ダイアログは許可scopeを詳しく表示しない。Bash全体を許可する点の文言改善は別UI課題とし、本PRでprovider判断をUIへ漏らさない
- Claudeの許可はRunnerメモリのみ。再起動で消えることを安全側の仕様とする
- Backend内Mapは会話本文や永続storeを汚さない。session削除APIが無い現状ではRunner lifetimeまで保持する
- Codexの利用可能decisionはrequest単位で異なり得るため、statusの全体capabilityだけで一律変換しない
- 許可済みtoolを次turnの`--allowedTools`へも渡す案は採用しない。同じ許可をargvとbridgeの2経路で判定することになり、current turnには結局bridge判定が必要だからである。Backendの`handlePermissionRequest`を唯一の判定点にする
- `allow_for_session`を提示しないBackendでも既存ダイアログのボタンは残り、選択時は一回許可へ安全に劣化する。現行2 Backendは本設計で対応するため通常利用では発生せず、将来Backend向けの動的ボタン制御は別課題とする

## 9. 実装順

1. ClaudeBackendとテスト
2. CodexBackendとテスト
3. Expo mappingとテスト
4. 関連Node/Jest test、typecheck、diff review
5. ローカルコミットで停止し、ユーザー実機検証後にpush/PR

## 10. 完了条件

- neutral経路で`approve_for_session`が`allow`へ失われない
- Claudeは同じconversation/toolでturnを跨いで再承認しない
- Codexは公式`acceptForSession`を使う
- 未対応Backend/actionへの後方互換を維持する
- 共通service、transport、UIへprovider分岐を追加しない
