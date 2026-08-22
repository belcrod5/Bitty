# ClaudeBackend 権限承認ポップアップ(interactive permission)設計書

## 文書情報

- 状態: 設計確定。実装対象
- 対象: `private_runner/src/claude-backend.mjs` とその内部bridge
- 基準: `origin/main` 694f244、調査日2026-08-23
- 親設計: `docs/AGENT-BACKEND-ARCHITECTURE-DESIGN.md` §5.6(将来案として予告済み)
- スパイク実測: Claude Code CLI 2.1.238(本文書内「スパイク実測結果」参照)

## 結論

現状の下流症状は「Claudeで承認が必要なツールが黙って自動拒否される」ことである。
上流の根本原因は、ClaudeBackendのpermission境界がpolicy-only(`--permission-mode dontAsk`固定)で、Claude CLIの承認委譲(`--permission-prompt-tool`)を共通action契約へ接続していないことである。

修正はClaudeBackend内部だけで完結させる。Backend内部のMCP bridgeがCLIのnative permission requestを受け、既存の共通イベント`action.requested(kind="permission")`として発行し、既存の`respondToAction`(`action.respond`)で回答をCLIへ返す。

AgentService、agent-transport、Expoのaction経路は既にprovider非依存で完成しており、**一切変更しない**。Expoは`policyProfiles`のinteractiveフラグで自動的に新profileを選択し、Codexと同じ承認ポップアップを表示する(実装済み: `expo/src/features/agent/client.ts:347-350`)。

## ゴール / 非ゴール

ゴール:

- Claude Backendのturnで承認が必要なツールが、Codexと同じ承認ポップアップ(action.requested → action.respond)で許可/拒否できる
- 許可すればツールが実行され、拒否すればツールが実行されずturnが継続する
- 既存の`claude-dont-ask`profile・schedule/queue・raw Codex経路・compactの挙動は不変

非ゴール:

- `allow_for_session` / `updatedPermissions`(常に許可ルールの永続化)。v1はallow/denyのみ
- Push通知からの承認応答(neutral経路にはCodexにも現状存在しない)
- Expoの承認UI変更(既存ポップアップをそのまま使う)
- `--permission-mode`のprofile追加(plan/acceptEdits等)
- Windows対応(既存ClaudeBackendと同様、POSIX前提)

# 1. 根本原因の整理

## 1.1 現状コード

- `claude-backend.mjs:214-219 permissionArgs()`: profileに関わらず`--permission-mode dontAsk`固定。dontAskでは承認が必要なツールがCLI内で即deny(popup要求自体が発生しない)
- `claude-backend.mjs:171-193 getStatus()`: `permission.interactive: false`、`action.kinds: []`、profileは`claude-dont-ask`のみ
- `claude-backend.mjs:955-957 respondToAction()`: 常に`capability_unsupported`

## 1.2 既に完成している上流(変更禁止)

- `agent-service.mjs:339-351`: `action.requested`のactiveActions管理、`finish()`での未回答actionの`cancelled|expired`解決、`subscribe()`のactiveActions snapshot
- `agent-service.mjs:612-640 respondToAction()`: decision検証とBackendへの委譲
- `agent-transport.mjs:264-280`: `action.respond` op
- `expo/src/features/agent/client.ts:214-259, 306-309, 341-343`: `action.requested`(kind≠dynamic_tool)→ `onApprovalRequest`ポップアップ → allow/deny応答。resume時のactiveActions再表示も汎用実装済み
- `expo/src/features/agent/client.ts:347-350`: `wantsInteractive`(approvalPolicy !== "never")に一致するprofileを自動選択

従って、修正点はClaudeBackendがこの契約を実装していないことだけである。下流へのClaude分岐追加は一切行わない。

# 2. スパイク実測結果(CLI 2.1.238、2026-08-23)

設計判断の根拠となる実測。実装時にこの結果を前提としてよい。

1. **`--safe-mode`は明示的な`--mcp-config`のMCPサーバーも無効化する**。`--permission-prompt-tool mcp__perm__approve`は「MCP tool not found. Available MCP tools: none」でツール呼び出しが全て失敗する。`--safe-mode`と承認委譲は両立不可
2. `--setting-sources "" --strict-mcp-config --mcp-config <inline JSON>`の組合せで、`--permission-prompt-tool`が動作する(`--permission-mode`指定なし=default mode)
3. `--setting-sources ""`はプロジェクトのCLAUDE.mdを読み込まない(マーカー実験で確認)。settings/hooks/プロジェクトMCPも読み込まれない。`--safe-mode`相当の隔離をinteractive profileでも維持できる
4. 承認ツールへのtools/call引数は`{tool_name, input, tool_use_id}`(`_meta`にtoolUseId重複あり)
5. allow応答`{"behavior":"allow","updatedInput":<input>}`(text contentとしてJSON文字列)→ツール実行、turn正常完了
6. deny応答`{"behavior":"deny","message":"..."}`→ツール未実行、turnは継続してresultまで到達。`result.permission_denials`に記録される
7. MCP shimはCLIが子processとして自らspawnし、mcp-config JSONの`env`フィールドで環境変数を渡せる
8. **deny時も対応する`tool_result`(is_error=true、本文はdenyのmessage)がuser messageとしてstreamへ流れる**。従って`runningToolIds`の解放と`tool.completed(failed)`の発行は既存のtool_result処理経路でそのまま成立し、deny用の合成処理は不要

# 3. 全体構造

```text
Expo (既存の承認ポップアップ / 変更なし)
  ↕ action.requested / action.respond (既存neutral protocol / 変更なし)
AgentService (既存 / 変更なし)
  ↕ emit("action.requested") / respondToAction()
ClaudeBackend (変更)
  ├─ permission bridge: run毎のUnix socketサーバー (新規、Backend所有)
  │     ↑ newline-JSON (token認証)
  └─ Claude CLI process
        └─ MCP shim process (CLIがspawnするstdio MCPサーバー、新規スクリプト)
              ← --permission-prompt-tool mcp__bitty_permission__approval_prompt
```

CLIは`--permission-prompt-tool`で指名されたMCP toolを、承認が必要になるたびに呼ぶ。shimはその呼び出しをUnix socket経由でrunner(ClaudeBackend内のbridge)へ転送し、ユーザーの決定を待って`behavior` JSONをCLIへ返す。

MCP bridgeをrunner本体のHTTPサーバーに載せない理由: 親設計の境界規則「Provider固有protocol、process、permissionはBackend内へ閉じる」「ServerはClaude eventを知らない」に従う。Unix socket + stdio shimはBackend内部で完結し、server-runtimeへの追加routeを必要としない。

## 3.1 新規/変更ファイル

```text
private_runner/src/claude-permission-bridge.mjs   # 新規: run毎socket bridge (runner側)
private_runner/tools/claude-permission-prompt-mcp.mjs  # 新規: stdio MCP shim (CLI子process側)
private_runner/src/claude-backend.mjs             # 変更: profile追加・bridge接続・respondToAction実装
private_runner/tests/claude-permission-bridge.test.mjs  # 新規
private_runner/tests/claude-backend.test.mjs      # 変更: interactive経路のテスト追加
```

他のファイル(agent-service、agent-transport、server-runtime、Expo)は変更しない。レビューで差分に含まれていたら設計逸脱である。

# 4. 詳細設計

## 4.1 policy profile

`getStatus()`のprofileを次の2件にする。既定(policyProfileId空)は現行どおり`claude-dont-ask`とし、既存呼び出し(profileを送らないclient)の挙動を変えない。

```js
policyProfiles: [
  { id: "claude-on-request", label: "Ask before tool use", interactive: true,  decisions: ["allow", "deny"] },
  { id: "claude-dont-ask",   label: "Deny unapproved tools", interactive: false, decisions: [] },
]
```

capabilitiesの変更:

- `action.kinds: ["permission"]`
- `action.decisions: ["allow", "deny"]`
- `permission.interactive: true`

Expoは`approvalPolicy !== "never"`のとき`interactive === true`のprofileを自動選択するため、Expo側の変更は不要。

## 4.2 argv構成

`permissionArgs(policyProfileId)`を「profile → argv断片 + bridge要否」の解決に拡張する。**`--safe-mode`は共通引数から外し、profile側の責務へ移す**(スパイク実測1により、interactiveでは--safe-modeを使えないため)。

- `claude-dont-ask`(および空): `["--safe-mode", "--permission-mode", "dontAsk"]` — 現行と同一の実効argv。**同値性は順序不問のフラグ集合一致でよい**(`--safe-mode`が現行の基本argv内位置から末尾へ移ってよい)。テストも集合一致で検証する
- `claude-on-request`:

```text
--setting-sources "" --strict-mcp-config
--mcp-config {"mcpServers":{"bitty_permission":{"command":"<process.execPath>","args":["<toolsディレクトリのshim絶対パス>"],"env":{"BITTY_PERMISSION_SOCKET":"<socketPath>","BITTY_PERMISSION_TOKEN":"<token>"}}}}
--permission-prompt-tool mcp__bitty_permission__approval_prompt
```

注意点:

- mcp-config JSONは`JSON.stringify`で生成し、shell経由でない`spawn` argv配列へそのまま渡す(既存方式)
- shimのnode実行は`process.execPath`(runnerと同じnode)を絶対パスで指定する。CLI子processのPATH解決へ依存しない
- shim絶対パスは`new URL("../tools/claude-permission-prompt-mcp.mjs", import.meta.url)`から解決する
- `compactSession`は現行どおり`--safe-mode`のまま(ツール実行を伴わないため変更しない)
- `--permission-mode`はinteractiveでは渡さない(default mode。承認が必要なツールだけがprompt toolへ委譲される)

## 4.3 permission bridge(runner側、新規module)

`createClaudePermissionBridge`はrun開始ごとにClaudeBackendが生成し、runのfinallyで必ずcloseする。

```js
createClaudePermissionBridge({
  socketDirectory,       // 既定: path.join(os.tmpdir(), "bitty-claude-perm")
  onRequest,             // async ({ toolName, input, toolUseId }) => { decision, message? }
}) => Promise<{ socketPath, token, close() }>
```

仕様:

- socketDirectoryをmode 0o700で作成し、既存時は`lstat`で**ディレクトリであること・`uid === process.getuid()`**を検証してからchmod是正する。検証に失敗したらbridge生成をエラーにする(interactive turnはspawn前に`turn_failed`で落ちる)。socket名は`<8byte hex>.sock`(macOSのsun_path 104byte制限を考慮し短く)
- tokenは`randomBytes(32).toString("hex")`。mcp-config env経由でshimへ渡す。runnerのログへ出さない
- 脅威モデル: 主防御はsocketディレクトリの0700+所有者検証。tokenはmcp-config JSONがCLI argvに載るため同一ホストの`ps`で可視になり得る前提で、**同一ユーザー境界内の深層防御**(誤接続・別runの取り違え防止)と位置づける。ユーザー境界を越える防御はtokenに依存しない
- shim↔bridge protocolはnewline区切りJSON、1接続1リクエスト:
  - shim→bridge: `{ token, toolName, input, toolUseId }`(inputはshim側で切り詰め済み。§4.4)
  - bridge→shim: `{ decision: "allow" | "deny", message? }`(allow時のupdatedInputはshim側が手元の完全なinputをそのまま使うため往復させない)
- 受信行の上限256KB。超過・JSON不正・token不一致は即deny応答して接続を閉じる(fail closed)。token比較は`timingSafeEqual`
- `onRequest`のthrow/rejectはdenyへ丸める
- `close()`はlistenを止め、socketファイルをunlinkし、**未応答の接続すべてへdenyを書いて閉じる**(CLI/shimをハングさせない)
- 同時複数リクエストを許容する(subagentの並列ツール実行があり得るため、1接続1リクエストで多重化する)

## 4.4 MCP shim(CLI子process側、新規スクリプト)

`private_runner/tools/claude-permission-prompt-mcp.mjs`。依存パッケージなし(node標準libのみ)。stdin/stdoutでnewline区切りJSON-RPC 2.0を話す最小のMCPサーバー。

- `initialize` → `{ protocolVersion: <clientの値をecho>, capabilities: { tools: {} }, serverInfo }`
- `notifications/initialized` → 応答なし
- `tools/list` → tool 1件: `approval_prompt`、inputSchemaは`{type:"object",additionalProperties:true}`
- `tools/call` → env `BITTY_PERMISSION_SOCKET`のUnix socketへ接続し、`{ token, toolName: arguments.tool_name, input: <切り詰め済みinput>, toolUseId: arguments.tool_use_id }`を送信。応答を待ち:
  - `decision === "allow"` → `content: [{type:"text", text: JSON.stringify({ behavior: "allow", updatedInput: arguments.input ?? {} })}]`(updatedInputには**切り詰め前の完全なinput**を使う)
  - それ以外 → `{ behavior: "deny", message }`(messageの既定: "Denied by user")
- **socketへ送るinputはJSON文字列化して2KBへ切り詰める**(bridge側の用途はtitleの300字要約のみで全文を必要としない。大きなWrite等が256KB上限で無告知denyされる事態を避け、内容の越境も最小化する)。切り詰め後は`{ _truncated: true, preview: <先頭2KBの文字列> }`のような単純な形でよい(bridgeはJSON.stringifyして要約するだけなので構造は問わない)
- socket接続失敗・応答不正・切断は全てdeny(fail closed)。shim自身はタイムアウトを持たない(承認待ちは無期限。打ち切りはrunner側のturn管理が担う)
- **stdinのclose/endでprocessをexitする**(CLI死亡時の残骸防止。process group killへの依存を減らす)
- **tools/callは応答待ちで読み取りループを塞がない**(各callを並行処理する。subagentの並列承認がshim側で直列化しないため)
- 未知methodでidがあるrequestへは空resultを返す(CLIのping等で落ちない)

## 4.5 ClaudeBackend本体の変更

### 起動(startTurn)

1. `policyProfileId === "claude-on-request"`のとき、spawn前にbridgeを生成。`onRequest`はrun stateへpending登録して`action.requested`をemitし、決定Promiseを返す
2. argvへ4.2のinteractive断片を組み込む
3. `state`へ追加: `pendingActions: Map<requestId, { resolve, toolName }>`、`bridge`、`closed`(run終了処理開始フラグ)

### action.requestedの発行

bridgeの`onRequest`callback内(stdout処理チェーンとは独立):

```js
requestId = `claude_action_${randomUUID()}`
emit("action.requested", {
  requestId,
  kind: "permission",
  title: `${toolName}: ${oneLine(JSON.stringify(input)).slice(0, 300)}`,
  toolCallId: toolUseId,
  decisions: ["allow", "deny"],
})
```

- Expoのポップアップは`payload.title`のみ表示するため(client.ts:80-94)、titleへツール名と入力要約を必ず含める。ツール別の整形分岐は作らない(汎用の1行JSON要約)
- `toolCallId`は親設計§7.1のActionRequestedに沿って含める(将来UIがツール実行表示と承認を関連付けるため。現Expoは未消費で互換リスクなし)
- **pending登録直後に`resetNoOutput()`を呼ぶ**(既存のstdout由来タイマーをclearし、抑止条件により再armさせない。tool.startedが未着のままpermission requestが先行してもno-output timeoutで殺されないため)
- ガード: `!state.initialized || state.closed`のbridge requestは登録・emitせず即deny。前者はemitFromBackendの順序検査(`turn.started`前のイベント禁止)をprotocol_errorで踏まないための防御、後者はrun終了処理後に滑り込んだin-flight requestがstaleなpending/activeActionsを作らないための防御
- run終了経路(finally)では最初に`state.closed = true`を立て、`state.pendingActions`を全てdenyでresolveし、bridgeをcloseする。AgentService.finishが未回答分の`action.resolved(cancelled|expired)`を発行するので、Backend側からの`action.resolved`は**回答時のみ**emitする

### respondToAction

```js
async respondToAction({ runId, requestId, decision }) {
  const state = activeRuns.get(runId);
  const pending = state?.pendingActions.get(requestId);
  if (!pending) throw agentError("action_expired", "Claude permission request is no longer active", { backendId: "claude" });
  state.pendingActions.delete(requestId);
  pending.resolve({ decision: decision === "allow" ? "allow" : "deny" });
  state.emit("action.resolved", { requestId, outcome: "answered", decision });
}
```

- decisionの妥当性(decisions配列との照合)はAgentServiceが検査済み。Backendでは再解釈しない
- `state.emit`を使うため、startTurnで`state.emit = emit`を保持する(Codex実装と同じ形)

### no-output timeout

承認待ちの間、CLIは正常に無出力になる。`resetNoOutput()`の抑止条件を`state.runningToolIds.size > 0 || state.pendingActions.size > 0`へ拡張する。pending登録直後(前節)と回答(resolve)時の両方で`resetNoOutput()`を呼ぶ。回答後は抑止条件が解けるため監視が再開される。turnTimeout(24h)は現行どおり上限として残る。

deny回答後のtool状態はスパイク実測8により既存経路で解決する(CLIがis_error=trueのtool_resultを流すため、`runningToolIds`解放と`tool.completed(failed)`は現行のtool_result処理がそのまま行う。合成処理を追加しない)。

### CLI側MCPタイムアウトの無効化

CLIのMCP tool呼び出しにはclient側タイムアウト(`MCP_TOOL_TIMEOUT`)があり、承認待ちが長いと拒否と無関係にツール呼び出しが失敗し得る。interactive profileのspawn envへ`MCP_TOOL_TIMEOUT`と`MCP_TIMEOUT`を明示的に大きな値(86400000 = 24h、turnTimeoutと同桁)で設定する。`safeEnvironment()`は変更せず、spawn時にspreadで追加する(この2変数は運用者環境から継承しない。値はBackendが所有する)。

## 4.6 イベント順序と終了系

- `action.requested`は必ず`turn.started`後(4.5ガード)。`item/tool系イベントとの相対順序は保証しない`(bridgeはstdoutと独立チャネルのため)。AgentServiceのイベント検査はaction系にitem/tool順序制約を課していないので問題ない
- interrupt(SIGINT→SIGTERM→SIGKILL)中にpendingが残る場合: CLI processの終了でstartTurnのfinallyに到達し、pending全denyとbridge closeが走る。shimはCLIと同時に死ぬため応答先が消えていてもよい(socket書き込みエラーは握りつぶす)
- 拒否してもturnは継続する(スパイク実測6)。turn失敗にしない
- 承認済み(answered)のactionはAgentService側でactiveActionsから除去され、resume時の再表示対象から外れる(既存動作)

# 5. テスト計画

`node --test private_runner/tests/`。実CLIは使わない(既存テストと同じfake child / 実Unix socket)。

claude-permission-bridge.test.mjs(新規):

- allow/denyの往復、複数同時リクエスト
- token不一致・JSON不正・行サイズ超過 → deny
- close()で未応答接続へdenyが届き、socketファイルが消える
- onRequest throw → deny

claude-backend.test.mjs(追加):

- `claude-dont-ask`と空profileのargvが現行と同一のフラグ集合(`--safe-mode`と`--permission-mode dontAsk`を含み、interactive系フラグを含まない。順序不問)=回帰なし
- `claude-on-request`のargv構成(`--setting-sources ""`、`--strict-mcp-config`、mcp-config JSONの形、`--permission-prompt-tool`名、`--safe-mode`が**含まれない**こと)
- interactive spawnのenvに`MCP_TOOL_TIMEOUT`/`MCP_TIMEOUT`が設定されること
- interactive run: fake childでturn.started後、テストがshimのふりをしてsocketへ接続 → `action.requested(kind="permission")`がemitされる → `respondToAction(allow)` → socket応答がallow、`action.resolved(answered)`がemitされる
- deny経路、`action_expired`(未知requestId)
- 同一runで複数pendingを同時に立て、逆順で回答しても正しいsocket接続へ対応付くこと
- 承認待ち中にnoOutputTimeoutが発火しないこと(短いtimeout設定で検証)。**stdout無しでpermission requestだけが先行するケースを含む**
- 回答後にno-output監視が再開されること(回答後、無出力でtimeoutが発火する)
- system/init前のbridge request → 即deny・emitなし
- run終了処理後に到着したbridge request → 即deny・pending/activeActionsが増えないこと
- run終了(interrupt / 異常exit)でpendingがdeny解決され、socketが閉じること

shim(claude-permission-bridge.test.mjsまたは専用テスト):

- 実際にchild processとしてspawnし、initialize/tools/list/tools/callのJSON-RPC往復と、socket断→deny応答を検証
- 大きなinputが2KBへ切り詰められてsocketへ送られ、allow応答のupdatedInputには完全なinputが使われること
- 複数tools/callの並行処理(1件目の応答待ち中に2件目が処理される)
- stdin EOFでprocessが終了すること

既存回帰ゲート: `agent-service.test.mjs`、`agent-transport.test.mjs`、`claude-backend.test.mjs`全通過。

# 6. 実機検証項目(マージ前)

1. Expoから通常送信(Claude backend選択)→ 承認が必要なツール(Write等)で承認ポップアップが表示される
2. 許可 → ツールが実行されturn完了。拒否 → ツール未実行でturn継続
3. 承認ポップアップを2分以上放置してから許可 → ツールが実行される(no-output timeout・MCPタイムアウトに殺されない)
4. 承認待ち中にアプリ再接続(WS切断→resume)→ activeActions snapshotでポップアップが再表示される
5. 承認待ち中に停止ボタン → turn.interruptedで終了し、以後の残骸processがない(`ps`でclaude/shimの残存確認)
6. Codex側の承認フロー・Claude `dontAsk`(承認なし送信)の回帰がない

# 7. リスクと対応

- **`--setting-sources`/`--strict-mcp-config`の下限バージョン**: 2.1.238で実測済み。MINIMUM_VERSION(2.1.214)〜2.1.237でのフラグ存在は未確認。未知フラグはCLIが即エラー終了し`turn_failed`として表面化する(無言の劣化はしない)。実機検証は導入済みCLIで行う
- **CLAUDE.md隔離の意味変化**: interactive profileは`--safe-mode`ではなく`--setting-sources ""`で隔離する。スパイクでCLAUDE.md・プロジェクト設定が読み込まれないことを確認済み。将来CLIの`--setting-sources`意味論が変わった場合はrelease testで検出する
- **MCPタイムアウト**: env明示(4.5)+実機検証3で担保
- **socket残骸**: close()でunlink。異常終了時に残ってもrun毎の新規パスなので再利用衝突はない。起動時掃除は追加しない(複雑さに見合わない)
- **並列承認**: bridgeは多重リクエスト対応。Expoポップアップが直列表示でも、未回答分はactiveActionsに残り順次表示される(既存挙動)
- **deny後のCLIリトライ挙動**: denyされた同一ツールをCLIが再度permission要求してくるかは未実測(スパイクではプロンプトで再試行を禁止した)。連続ポップアップになり得るが、都度deny可能でfail-closed性は保たれる。実機検証で観察する
- **`action.resolved`のoutcome語彙**: 本設計は親設計§7.4どおり`outcome:"answered", decision`を出す。Codex実装(codex-turn-execution.mjs:624-629)は`"allowed"|"denied"|"completed"`で親設計から逸脱済み(既知)。現在下流は`action.resolved`を消費していないため実害はないが、下流が消費し始める前に別途統一する

# 8. 実装順(1ブランチ・1PR)

1. `claude-permission-bridge.mjs` + テスト
2. `claude-permission-prompt-mcp.mjs`(shim)+ テスト
3. `claude-backend.mjs`: profile/argv/bridge接続/respondToAction/no-output抑止 + テスト
4. 全テスト・回帰確認 → 実機検証(§6)

ブランチ: `feat/claude-permission-prompt`
進捗管理: `docs/CLAUDE-PERMISSION-PROMPT-PROGRESS.md`
