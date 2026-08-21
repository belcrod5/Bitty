# private_runner Agent Backend 再設計書

## 文書情報

- 状態: 設計案。今回は実装しない
- 対象: `private_runner`のAgent Backend境界
- 基準: `origin/main`、調査日2026-08-21
- 第一優先: 現行Codex App Serverの挙動を変えず、Codex専用コードを分離する

## 結論

第一段階では、正常稼働中のCodex App Server固有責務を挙動不変で分離する。neutral operationは`CodexBackend`、既存raw JSON-RPC relayは共通contract外の期限付き`CodexRawRelayCompat`が所有し、通信方式、thread/session、履歴、stream、approval、compact、queueは作り直さない。
legacyの`/reply`、`/reply-files`、`/stream-tts`内のResponses API＋runner独自file-tools経路は対象外とし、そのまま維持する。
次にprovider非依存のsession/turn/event protocolを上流へ追加し、Expoを単一Agent clientへ移す。その後に`ClaudeBackend`を追加する。
provider選択はregistryの`Map`で一度だけ行い、route、use case、Expo componentへ`if (provider === "claude")`を増やさない。
実装様式は既存に合わせた`.mjs` factory/function styleとする。class継承、generic CLI backend、引数を転送するだけの薄いwrapperは禁止する。
会話本文は各Providerのnative session/historyを正本とし、private_runnerへ完全コピーしない。永続bindingは`backendId`、`nativeSessionId`、`canonicalCwd`だけにする。

## 対象範囲と設計原則

対象はApp Server通信、native session、native history、turn、streaming、interrupt、approval/permission、model、capability、実在するcompact等のoptional operation、Claude CLI processである。
Codex方式の刷新、独自会話DB、OpenClaw全体への移行、legacy Responses系の再設計、TTS job統合は対象外である。
Provider固有protocol、process、transcript、permissionはBackend内へ閉じる。最低共通分母へ落とさず、差はcapabilityで表現する。
Codexの未知イベントを失わないescape hatchを残す。新しい共通概念は少なくとも二つの実Backendで同じ意味を持つ場合だけ追加する。

# 1. 現状Codex依存箇所の整理

## 1.1 起動・設定・二つのCodex経路

`private_runner/server.mjs`は`src/server-runtime.mjs`を読み込むだけである。`server-runtime.mjs`は約12,350行あり、HTTP、WebSocket、Codex、TTS、file tools、calendar、push、scheduleを保持する。
App Server upstream設定は`server-runtime.mjs:67-74`、直接Responses API設定は`:75-124`、Codex home/auth/session directoryは`:125-148`にある。
現行には次の二系統がある。

1. Expo → `/runner-ws` → raw Codex JSON-RPC relay → Codex App Server
2. `/reply*`等 → ChatGPT Codex Responses API → runner独自file-tools/job/approval

この二系統を一つのBackend contractへ同時に押し込まない。

## 1.2 Codex App Server本線

`/runner-ws`のconnectionとLLM受付は`server-runtime.mjs:9413-9896`、relay本体は`:10274-11979`、legacy `/codex-ws`は`:11981-12124`にある。
`channel=llm, op=rpc`のpayloadは共通Agent commandではなくCodex App Serverのraw JSON-RPCである。runnerも単純転送ではなく、RPCの意味と状態を解釈する。
App Server用RPC clientは`server-runtime.mjs:6862-7017`、runner起点turnは`:7170-7196`、開始・完了判定は`private_runner/src/codex-turn-execution.mjs:119-278`にある。
runner起点で使うmethodは次の通りである。

- `initialize` / `initialized`
- `thread/start` / `thread/resume`
- `turn/start`
- `modelProvider/capabilities/read`
- `config/read`
- `plugin/list` / `plugin/read`
- `mcpServerStatus/list`

calendar preflightは`codex-turn-execution.mjs:20-56`、thread/turn開始は`:139-220`にある。`thread/resume`失敗後も元IDを維持する現行挙動を抽出時に変えない。

## 1.3 relayの責務と密結合

metadata parserは`server-runtime.mjs:10610-10768`にあり、主に次を認識する。

- `thread/start|resume|read|compact|compact/start|compacted|status/changed`
- `turn/start|started|completed|interrupted|interrupt`
- `item/started|completed|agentMessage/delta|tool/call`
- `*/requestApproval`

relay contextは`server-runtime.mjs:11127-11169`で、upstream socket、pending送信、clients、thread/turn、approval、RPC相関、initialize cache、event log、calendar requestを一体で持つ。
operation/session identity indexは`private_runner/src/runner-ws-llm-relay-identity.mjs:1-145`にある。
threadless共有relayとhandshake replayは`server-runtime.mjs:9464-9638`、sequence/gap/replayは`:11038-11102`、current turn以外のsubagent除外は`:11519-11570`にある。
`thread/resume`のimage generation縮約は`:10343-10589`にある。これらはCodexの再接続品質を構成するため、relay runtimeとして原子的に移す。

## 1.4 cancel、approval、calendar

UI turnはraw `turn/interrupt`を送る。calendar relayも`private_runner/src/calendar-relay-service.mjs:159-175`でinterruptを監視する。
queued turn cancelは`server-runtime.mjs:7377-7395`からAbortControllerを発火し、RPC clientは`:7003-7005`でWebSocketを閉じる。抽出時に明示的`turn/interrupt`へ変更しない。
App Server approvalは`:11499-11517`でRPC IDを保留し、`:11018-11044`で未回答requestだけをreplayし、`:11919-11921`でclient responseを解消する。
push approval response bridgeは`:8695-8752`にある。
calendarの業務処理は共有可能だが、`item/tool/call`とApp Server response schemaはCodex固有である。Codexのdynamic-tool capability内へ残す。

## 1.5 queue、compact、schedule

queue/compact stateは`server-runtime.mjs:6754-7395`、HTTP routeは`:8367-8488`にある。
normal relayからrunner起点turnを始める処理は`private_runner/src/codex-relay-initiator.mjs:5-130`にある。
`private_runner/src/codex-schedule-service.mjs`はmodelRef、reasoningEffort、threadId、turnIdをCodex前提で扱う。
location scheduleにも`parseCodexOptions`依存がある（`location-schedule-service.mjs:116-147, 440-485`）。recurrence、location、通知等のschedule domainはBackendへ移さない。Provider固有optionの解釈とturn起動境界だけをCodex実行領域へ寄せ、neutral化後は`AgentService.startTurn`へ委譲する。

## 1.6 session・history

`llm-acp-session-store.mjs:19-24, 148-246`はsession、directory、read timestampのrunner metadataを持ち、会話本文は保存しない。
`llm-cli-session-index.mjs:137-349, 421-745`は`~/.codex/sessions/rollout-*.jsonl`を走査し、session meta、cwd、model、reasoning、subagent関係を索引化する。
`llm-session-rollout-readers.mjs:34-132, 227-328, 370-529`はCodex固有の`response_item`、`event_msg`、header、turn contextを読む。
`llm-session-history-page-reader.mjs:233-550`はfile identity付きcursor、逆方向paging、append deltaを実装する。`:343-345`にはApp Serverのlegacy pagingを避けrolloutを読む理由がある。
`llm-session-service.mjs:86-112, 314-377, 410-531`はACP/CLI一覧、summary、unreadを同一session IDで統合する。HTTP公開は`server-runtime.mjs:8790-8976`にある。
`source="acp"`でも本文はCLI rolloutを探すため、ACP/CLIはProvider名ではなく保存元の区別である。Codex history adapter内部へ閉じる。

## 1.7 model、status、review

Codex model prefix/effort検証は`server-runtime.mjs:743-824, 1010-1041`、turn反映は`codex-turn-execution.mjs:201-217`にある。
usage statusは`server-runtime.mjs:3142-3235, 8118-8159`、auth profile切替は`:3603-3945, 8298-8365`にある。これらはCodex固有capabilityとする。
現行runnerに明示的なreview開始APIはない。`llm-session-metadata.mjs:5-15`と`expo/.../helpers.ts:480-528`がCodex native subagent sourceのreviewを受動表示するだけである。
存在しないreview APIを共通contractへ発明しない。将来、二つ以上のBackendで同じ意味の実operationが成立した時点で追加を設計する。

## 1.8 legacy Responses系と重複

OAuth/Responses SSEは`server-runtime.mjs:826-1008, 1638-1897`、file-tools loopは`:6224-6529`、reply use caseは`:6554-6675`にある。
job/event/cancel/approvalは`:2452-2804, 7397-7947`にあり、`llm-cli-rollout-writer.mjs:171-302`が会話をCodex rollout形式で再生成する。
App Server系とlegacy系には、execution、approval、event replay、cancelが二組ある。さらに`executeCodexTurn`とrelay notifierは双方でassistant textを蓄積する。
ACP storeとCLI indexもread stateを重ねて統合する。この既存重複を新共通interfaceへ固定化しないため、legacy系は第一段階の境界外に置く。

## 1.9 下流依存

Expoもraw Codex RPC clientの一部を担う。`threads.ts:42-107`がlist/read/resume、`turn.ts:494-702, 992-1126`がinterrupt、approval、tool、start、stream、`compact.ts:269-492`がcompactを解釈する。
従ってrunner内へ`CodexBackend`を置くだけではprovider非依存にならない。raw互換抽出後、neutral protocolへExpoを移す第二段階が必須である。

# 2. 責務分離案

## 2.1 構造

```text
Server / Transport
  -> AgentService
       -> BackendRegistry(Map)
       -> SessionBindingStore
       -> AgentBackend factory result
            -> CodexBackend
            -> ClaudeBackend
```

ServerはHTTP/WS認証、size制限、neutral request decode/response encode、connection lifecycleだけを担当し、Codex method、Claude event、transcript pathを知らない。
AgentServiceはdefault設定またはsessionRefからBackendを一度だけ解決し、同一sessionの同時turnを防ぎ、capabilityを検査し、common eventをtransportへ流す。
Backendはnative session、history、turn、event変換、interrupt、approval/permission、model検証、provider errorを所有する。
移行中のCodexだけはraw、neutral、schedule/queueの全入口が同じagent metadata storeのsession mode/leaseを通る。`CodexRelayRuntime`がraw側の取得・解放を直接行い、排他のためだけの転送wrapperは作らない。

## 2.2 候補境界と初期構成

次は完成時の固定ファイル一覧ではなく、責務を判断する候補境界である。初期は新規ファイルを次の程度に抑える。

```text
private_runner/src/agent/
  agent-service.mjs       # registry Map、routing、run/session invariant
  agent-protocol.mjs      # neutral request/event/errorの定義とvalidation
```

Codexは既存`codex-turn-execution.mjs`、`codex-relay-initiator.mjs`、history modulesをそのまま移動または再利用し、名前だけの`codex-backend.mjs`を先に作らない。
Claudeも最初はBackend factoryとprocess/stream/historyの実責務から始める。独立したstate/lifecycleを所有する、または2,000行問題を避ける必要が生じた場合だけ分割する。
Backend registryの`Map`は`agent-service.mjs`内に置き、単独registry wrapper、error wrapper、event wrapperを作らない。
依存方向はServer → AgentService → Backendとし、Codex/Claudeは互いに依存しない。BackendはExpo型を知らず、calendar domain serviceはCodex RPCを知らない。

# 3. 共通interface案

以下は設計用擬似コードであり、今回の実装ではない。

## 3.1 factory、status、registry

```js
createCodexBackend(deps) => ({
  backendId,
  getStatus,
  startTurn,
  listSessions,
  readHistory,
  interrupt,
  respondToAction,
  listModels,
  compactSession?,
  close,
})
```

`createClaudeBackend`も同じshapeを返す。class、共通基底class、generic CLI backendは使わない。

```js
const backends = new Map([
  [codexBackend.backendId, codexBackend],
  [claudeBackend.backendId, claudeBackend],
]);
```

このMapはAgentService内部に置く。新規turnはdefault backendまたはopaque agent profile、再開turnはsessionRefからlookupする。UIがBackend選択を提供してもrouting keyを渡すだけで分岐しない。

`getStatus()`はavailability、read-only auth状態、binary/version、readiness、version解決済capabilitiesを返す。共通層へ巨大なoption schemaやversion条件を渡さない。

```text
BackendStatus = {
  backendId,
  available,
  auth: { state },
  runtime: { binaryPath?, version? },
  readiness: { ready, reason? },
  capabilities: {
    session: { resume, list, history: { read, delta } },
    turn: { interrupt },
    action: { kinds: ActionKind[], decisions: [...], policyProfiles: [...] },
    permission: { interactive },
    model: { select, effort },
    workspace: { projectCustomizations, admission },
    operations: { compact },
    event: { nativePayload },
    tool: { dynamic }
  }
}
```

Backendがstartup probeとversion判定を終えた具体値だけを返す。Codex quota表示とauth-profile mutationは汎用status/auth APIへ押し込まずCodex固有route/capabilityのまま維持する。

## 3.2 SessionRefとstartTurn

```text
AgentSessionRef = { backendId, nativeSessionId }
SessionBinding = { ...AgentSessionRef, canonicalCwd }
```

`nativeSessionId`はCodexではthread ID、ClaudeではClaude session IDである。本文やmessage配列を含めない。
`createSession`と`resumeSession`は設けない。sessionだけを先に作るfake operationはClaude CLIの実態に合わない。

```text
startTurn({
  sessionRef?,
  cwd?,
  input,
  model?,
  effort?,
  policyProfileId?,
  clientOperationId
}) -> TurnRun

Input = {
  blocks: (
    | { type: "text", text }
    | { type: "image", localRef, mimeType? }
  )[]
}
```

`policyProfileId`は`getStatus().capabilities.action.policyProfiles`から選ぶopaque IDである。各profileは`{ id, label, interactive, decisions }`だけを公開し、native tool名、CLI flag、rules本文はBackend設定へ閉じる。CodexBackendは現行`on-request|never`を挙動不変のprofileへ写像し、ClaudeBackendは実測済み`dontAsk`＋allowed/disallowed rulesの組だけをprofileとして返す。AgentServiceはIDの意味を解釈せず、未対応IDを開始前に`capability_unsupported`で拒否する。

sessionRef省略はnative新規sessionを伴う最初のturnで、この場合だけtop-level `cwd`を必須にしてrealpathをbindingの`canonicalCwd`にする。
sessionRef指定時はbindingの`canonicalCwd`を唯一の正本とする。compat requestにcwdが来た場合だけrealpathの完全一致を検査し、不一致はspawn/RPC前に拒否する。
session確定時に`session.resolved` eventを出す。
Codexは`thread/start|resume`結果、Claudeはstream-jsonのauthoritative session IDから確定する。開始前に失敗した場合はbindingを確定しない。

```text
TurnRun = {
  runId,
  events: AsyncIterable<AgentEvent>,
  completion: Promise<TurnResult>
}

TurnResult = {
  runId,
  sessionRef?,
  outcome: "completed" | "failed" | "interrupted",
  error?
}
```

runIdは`AgentService`がserver-sideで生成する。interruptはrunIdを使い、socket、PID、RPC IDを公開しない。同一sessionのactive turnは一つとし、競合は`session_busy`にする。
completionはterminal eventと同じTurnResultをresolveする。Backendが報告したturn failure/interruptionも原則resolveし、transport破損やprogrammer errorでTurnResultを確定できない場合だけrejectする。

## 3.3 history、approval、model

```text
listSessions({ backendId, cwd, cursor?, limit? }) -> SessionListPage
readHistory({ sessionRef, cursor?, sinceCursor?, limit? }) -> HistoryPage
respondToAction({ runId, requestId, decision })

SessionListPage = {
  sessions: AgentSessionSummary[],
  cursor?
}

AgentSessionSummary = {
  sessionRef,
  canonicalCwd,
  updatedAt,
  title?,
  modelId?,
  isSubagent?,
  parentSessionRef?
}

HistoryPage = {
  items: AgentHistoryItem[],
  olderCursor,
  newerCursor?
}

AgentHistoryItem = {
  id,
  role,
  content: ContentBlock[],
  createdAt?,
  itemType?,
  status?
}

ContentBlock =
  | { type: "text", text }
  | { type: "reasoning", text, redacted? }
  | { type: "image", localRef, mimeType? }
  | { type: "tool", toolCallId, name, inputSummary?, resultSummary?, status }
```

`backendId`はgeneric routing keyであり、呼び出し側のprovider分岐を意味しない。初期は全Backend fan-out一覧やglobal cursorを作らず、一つのBackend/cwdへ問い合わせる。
item IDは同じnative recordに対してpaging/delta間でstableにする。content blockはtext、local image reference、tool summary等の表示可能な構造とし、巨大tool outputは含めない。
CodexのACP/CLI統合はCodex内、Claude catalog/transcript統合はClaude内で行う。
history cursorとaction requestIdはopaqueである。Codex inode cursor、RPC ID、Claude transcript offset/permission tokenを共通層で解釈しない。
decisionは`allow`、`deny`、対応可能なら`allow_for_session`とし、Backendがnative decisionへ変換する。
model IDとeffort IDは共通層ではopaqueで、Backendが組を検証する。`listModels() -> [{ id, label?, efforts: [{ id, label? }] }]`は検証済みの組だけを返す。Codex既存reasoning effortとClaudeの`--effort`はともに`startTurn.effort`だけを入力元とし、別名parameterやProvider間のenum変換を共通層へ作らない。Claude v1はaccount別model catalogを推測せず、初期は`listModels=[]`、`model.select=false`、model/effort省略でnative defaultを使う。明示候補を実turnで検証できた場合だけ選択を開く。

## 3.4 capabilityとoptional operation

capability例を次に示す。各名称は上記`BackendStatus.capabilities`の具体値に対応する。

- `session.resume`
- `session.list`
- `session.history.read` / `session.history.delta`
- `turn.interrupt`
- `action.kinds` / `action.decisions` / `action.policyProfiles`
- `permission.interactive`
- `model.select` / `model.effort`
- `workspace.projectCustomizations`
- `workspace.admission`
- `operations.compact`
- `event.nativePayload`
- `tool.dynamic`

capabilityは`getStatus()`のversion解決済nested descriptorで表し、全Providerを最低共通分母へ落とさない。
Codexが実際に持つcompactだけをoptional `compactSession?`とする。reviewは受動的なhistory metadataとして表示できるが、開始operationやcapabilityにはしない。

## 3.5 error

共通error codeは次の最小集合とする。

- `backend_unavailable` / `backend_version_unsupported`
- `authentication_required`
- `session_not_found` / `session_cwd_mismatch` / `session_busy`
- `turn_rejected` / `turn_failed`
- `action_expired` / `action_denied`
- `rate_limited` / `timeout`
- `capability_unsupported`
- `history_unavailable` / `history_cursor_invalid`
- `protocol_error` / `output_limit_exceeded`
- `operation_conflict` / `operation_status_unknown`

errorは`backendId`、`retryable`、安全なmessageを含む。native code/detailは診断metadataへ残し、下流はnative message文字列で分岐しない。
interrupt/cancelはerror codeではなくTurnResult outcomeとterminal `turn.interrupted` eventで表す。

## 3.6 neutral wireとlifecycle invariant

`/runner-ws`の`channel=agent`に置くneutral operationは、初期に`agent.hello`、`turn.start`、`turn.interrupt`、`action.respond`、`events.resume`だけとする。
HTTPは`GET /agent/backends/status`、`GET /agent/sessions?backendId=...&cwd=...`、`GET /agent/sessions/:opaqueRef/history`相当の境界とし、実pathは実装時に既存routing規則と衝突しない形で確定する。
workspace admissionはProvider非依存の認証済みHTTP境界に一つだけ置く。`GET .../workspaces`で一覧、`POST .../workspaces/prepare`で入力pathをrealpathし、暗号学的randomな短命requestId、canonical root、filesystem identity、警告を返す。requestIdは認証主体へbindしたone-time tokenであり、clientが絶対pathを再表示してユーザー確認を得た後だけ`POST .../workspaces/confirm`がprepare recordを原子的にconsumeして保存する。confirmはpathを再受領せず、prepare時とconfirm時のcanonical rootとfilesystem identity（対応platformではdevice/inode）を比較する。`POST .../workspaces/revoke`はrootを失効させ、新規turnを即時拒否し、配下のactive runを`cancelling`へ遷移させる。filesystem root、volume root、user homeそのものは承認対象として拒否し、symlink差替えとroot containmentをprepare/confirm/startの各時点で再検査する。
`agent.hello`は`protocolVersion`、serverが対応するversion範囲、operation/event一覧、Backend statusを交換する。Expoは対応versionがない場合だけ移行期間中のraw clientへfallbackし、接続後にProvider名でfallbackを決めない。
同じ認証主体における`clientOperationId`の`turn.start`再送は既存runId/状態を返し、二重実行しない。異なるpayloadで同じIDを使った場合は`operation_conflict`とする。AgentServiceは認証主体ID、request hash、run stateだけのbounded operation ledgerをBackend起動前に原子的に既存metadata storeへ記録し、会話本文は保存しない。TTLと最大件数はprotocol定数にし、再起動時にpendingだったrecordは自動再実行せず`operation_status_unknown`を返してnative historyとの照合を促す。
validation/backend admissionに失敗したrequestはrunをacceptせずrequest errorを返す。一度acceptしてrunIdを返したrunは`turn.accepted`を最初に出し、session確定時だけ`session.resolved`、native turn開始時だけ`turn.started`を出し、最後はexactly one terminal eventとする。spawn失敗、auth失効、Codex `thread/start`失敗、`system/init`未到達でもterminalだけは保証し、未到達eventを捏造しない。
terminalは`turn.completed|failed|interrupted`の一つで、terminal後にeventを発行しない。
sequenceはrun内で1から単調増加し、bounded replayから`events.resume`できる。gapはresume missとしhistory再取得へ誘導する。
rawとneutral clientを同じexecutionへfan-outして二重ownerにしない。Codex session ownership recordは`backendId/nativeSessionId`ごとにdurableな`mode: raw|neutral`とlease `{ owner, runId, processEpoch, acquiredAt, expiresAt, generation, nativeProcessIdentity? }?`を原子的に保持する。modeはclient transportと実行経路を選び、schedule/queueはmodeを変更せず同じleaseを取得する。raw modeでは現行relay initiator、neutral modeではAgentService/Backendへdispatchする。sessionなしのscheduleは移行flagで選ばれたdefault modeをturn開始時に固定する。
active leaseがあれば全入口の同時turnを`session_busy`で拒否する。mode handoffはactive turnと未回答actionがない時だけ行う。client disconnectはtransport detachだけでleaseを解放せず、現行Codexと同様にupstream turn、event replay、action stateを保持する。lease解放はnative terminal確認、native開始前の失敗、またはcancel/recovery後にnative activity停止を確認した場合だけgeneration一致で行い、modeは戻さない。upstream socket喪失等でterminalが不明ならleaseを`recovering`へ遷移する。
runner再起動後の異なるprocessEpochも`recovering`として新規turnを拒否する。Codexはnative thread status、ClaudeはPIDだけでなくOSのprocess start identityを照合して残存processをcancel ladderで停止し、terminal/historyを照合してからleaseをclearする。expiryだけでは解放せず、native activityなしを確認できない間はfail closedにする。

# 4. CodexBackendへの既存コード移動方針

## 4.1 第一段階

第一段階はCodexを新方式へ作り直すことではなく、既存依存を責務境界へ移すことである。raw relay wire protocolも維持する。
`run-local.sh`によるCodex App Serverの起動、mode、env、process監視方式はPhase 1では一切変更しない。
移動順は次とする。

1. rollout index、reader、history pagingをCodex history領域へ移す
2. Codex RPC clientとturn executionを移す
3. queueのCodex turn起動部とcompactを移す。schedule domainは移さない
4. relay、identity、approval、calendar bridgeを一括移動する

## 4.2 relayの原子的移動

`server-runtime.mjs:9413-9896`と`:10274-11979`は、RPC相関、notification owner、approval replay、sequenceが密結合している。
`CodexRelayRuntime`を実state ownerとして抽出し、Serverは`handleRpc`、`attach`、`resume`、`detach`、`status`だけを呼ぶ。各関数が別stateを持つthin wrapperにならないようにする。

## 4.3 raw互換入口

既存`channel=llm, op=rpc`と`/codex-ws`は、期限付きtransport adapter `CodexRawRelayCompat`として維持する。
これはAgentBackend共通contract外に置き、raw payload、unknown RPC透過、seq、resume miss、ack、initialize cacheを変更しない。
既存Codex relay stateは移行中もこのadapterが所有する。neutral turnと同じexecutionを共有/fan-outせず、どちらか一方だけをownerにする。ただしsession mode/leaseだけは同じagent metadata storeをraw/neutral/schedule/queue入口から更新し、adapter外に二つ目のlockを作らない。
最終Serverはneutral protocolだけを扱い、Phase 6の削除条件を満たした時点で`CodexRawRelayCompat`を削除する。

## 4.4 保存する挙動

- App Server WebSocketとinitialize handshake
- thread start/resume/read/list、turn start/interrupt
- raw notification、turn ownership、subagent filter
- approval保留/replay、relay TTL、reconnect sequence
- queue/compact、rollout history/cursor
- model/effort、auth/status、calendar dynamic tools、completion push

Responses API、`runCodexWithFileTools`、legacy job/TTS/file-tool approval、legacy rollout writerは移さない。将来整理するなら別設計とする。

# 5. ClaudeBackendの設計方針

## 5.1 versionとprocess model

ClaudeはClaude Code CLI＋Claudeサブスクリプションを使い、独自HTTP/API key clientは作らない。調査時のlocal CLIは`2.1.199`だが、これは非production spike専用とする。公式資料上、`2.1.214`未満は大きなstreamのstdout drain待ちが約2秒で打ち切られ末尾が欠落し得るため、production streamingの最低版は`2.1.214`とする。
v1はturn-per-processに固定し、shellを介さずbinary pathとargv配列を`spawn`する。persistent live processは将来のversion/protocol capability gateとする。
完全なargvは次である。角括弧はBackendが検証後に追加するoptional引数を表す。

```text
fresh:
claude -p --output-format stream-json --verbose --include-partial-messages
  --safe-mode --session-id <uuid> [--model <id>] [--effort <level>] [permission flags]

resume（bindingの同一cwd）:
claude -p --output-format stream-json --verbose --include-partial-messages
  --safe-mode --resume <id> [--model <id>] [--effort <level>] [permission flags]
```

resumeでは`--session-id`を併用しない。plain promptをstdinへwriteしてEOFし、argvへ本文を残さない。
`--input-format stream-json`は将来SDK envelope型inputを採用する場合だけ使い、plain prompt v1では使わない。
Runnerのinput上限を公式10MB制限より小さい固定値にし、spawn前に拒否する。

## 5.2 新規session、resume、project lookup

sessionRefなしの`startTurn`だけがUUIDを生成し、fresh argvへ渡す。空session作成ではなく実turnのnative ID指定である。
stream-jsonのsystem/initからauthoritative IDを得て`session.resolved`を出す。要求IDと異なる場合は`protocol_error`、turn開始前の失敗ではbindingを保存しない。
再開はbindingの`canonicalCwd`だけを使い、失敗時に新規sessionへfallbackしない。
local `2.1.199`はproject/worktree lookup修正の`2.1.223`より前であるため、元のcanonical cwdでのresumeを必須にし、別worktreeから同じsession IDを探さない。

## 5.3 subscription auth、workspace trust、startup status

API keyを要求・注入せず、`--bare`も使わない。`--bare`はOAuth/keychain contextを無効にし得るためである。
auth file/tokenをcopy、log、mutationしない。local loginを保つHOME/keychain context、必要なPATH、設定済み`CLAUDE_CONFIG_DIR`等だけを最小継承し、runnerの無関係なsecret envは除外する。
`claude -p`はworkspace trust dialogをskipし、非bare実行はproject/localのsettings、hooks、MCPを読み得る。現行runnerには承認済みworkspace allowlistが存在しないため、Claude有効化前にworkspace admissionを追加する。認証済みユーザーの明示操作で選択したrootの`realpath`、承認時刻、失効状態だけを既存metadata storeの別namespaceへ保存し、fresh/resumeともcanonical cwdが有効root自身または配下である場合だけbindingとspawnを許可する。symlink解決後にcontainmentを再検査し、root失効後は既存bindingも起動不可にする。この制限はCodex raw互換へ遡及適用しない。
初期v1はOAuth/keychainを維持したままproject/local customizationを切る`--safe-mode`を必須にし、`BackendStatus.capabilities.workspace.projectCustomizations=false`を返す。managed policyは残り得るため、実効設定とpolicy適用結果をspikeで確認する。
将来settings/hooks/MCPを有効にする場合は、session bindingとは別のexplicit workspace trust記録と`--setting-sources`等の選択を先にspike・設計する。trust状態を`SessionBinding`へ混ぜず、`--bare`も代替策として採用しない。
startupで実行binaryのreal pathとversionを固定し、read-only auth status/readinessをprobeして`getStatus()`へ反映する。turnごとに別binaryへ解決し直さない。

## 5.4 bounded stream-jsonと正規化

stdoutは改行単位のbounded NDJSON parserで読み、一行、未完fragment、event queue、stderr tailにbyte上限を設ける。child stdoutは常時drainし、consumer都合でpauseしない。bounded queueを超えた時点でprocess groupを停止して`output_limit_exceeded`にする。`2.1.214`以上でも大容量streamのterminal `result`到達をrelease testに含める。
次のnative eventをBackend内で正規化する。

- `system/init`: native session ID、model、初期metadata
- `stream_event`の`content_block_start|delta|stop`
- `text_delta`: assistant本文delta
- `input_json_delta`: tool inputの構造化途中状態。本文へ混ぜない
- complete `assistant`: full messageとpartial deltaのdedupe
- complete `user`の`tool_result`: tool完了
- `system/api_retry`: bounded retry diagnostic/status
- `result`: authoritative turn result、usage、session ID

partial/full messageをstable native keyとblock indexでdedupeする。reasoning/thinking blockを通常assistant本文へ混ぜない。
subagent/parent event混同を防ぐfixtureを置く。未知eventはbounded/redacted diagnosticへ回し、JSON parse失敗ではraw全体をlogしない。
exit code 0でも`result`がなければ`protocol_error`でfailedにする。stderrは診断だけで、assistant本文やhistoryへ入れない。

## 5.5 terminal、interrupt、cleanup

final resultとprocess exitの競合を一つのlifecycle stateで収束させ、exactly one terminal eventを出す。
cancel受付はAgentServiceが`running -> cancelling`を原子的に遷移させる。terminal確定が先ならcancelへ`already_terminal`を返して結果を変えず、cancel遷移が先なら後からnative success/resultが到着しても共通outcomeは`interrupted`に固定する。
interruptは最初にClaude親processへSIGINTを送り、clean interrupt/result/exitを短いgraceだけ待つ。生存時はprocess groupへSIGTERM、さらにgrace後も生存する場合だけSIGKILLへ昇格する。SIGTERMは進行中turnのresultを記録しないため第一手に使わない。
runner要求cancelのstateに対応する終了だけを`turn.interrupted`にする。自然なsignal終了やnon-zero exitは`turn.failed`である。cancel後に得たnative resultはresume診断へ利用できるが、共通terminalを二度出さない。
exit/error/abort全経路でlistener、timer、stdio、session lockを解放する。cancel後も確定済みbindingは削除せず、次turnでresume可能にする。

## 5.6 permission

v1は明示的policy-onlyとする。候補は`dontAsk`とallowed/disallowed toolsのBackend設定上の組で、実際に利用できるpolicy/flagをspikeで固定した後、一つのopaque policy profileとして公開する。rules本文をwireへ出さない。
bypassをdefaultにせず、interactive requestをhidden stdioの推測で実装しない。
Claude v1は`permission.interactive=false`で`action.requested(kind="permission")`を出さず、`action.respond`は`capability_unsupported`にする。将来は公式`--permission-prompt-tool <MCP tool>`をBackend内部MCP bridgeへ接続し、native requestを共通`action.requested(kind="permission")`のopaque requestIdへ写像できた場合だけ`permission.interactive=true`にする。
OpenClawのhidden/private stdio controlは採用しない。`msg_lifecycle_v1`のknown minimum `2.1.206`はOpenClawの観測値であってAnthropic公式保証ではない。`2.1.205`以降は`system/init.capabilities`のadvertised valueを正本にし、field自体がないlocal `2.1.199`では機能を閉じる。

## 5.7 transcript/history security

default transcript候補は`~/.claude/projects/<project>/<session-id>.jsonl`で、entryはClaude内部形式である。
ClaudeBackend内部readerは設定済みprojects rootをrealpathし、その配下だけを読む。symlink/path traversalとsession IDのbasename逸脱を拒否し、regular fileだけを許可する。
file size、line size、record countに上限を設ける。未知recordはbounded skipまたはfail closedし、replace/truncateはcursor invalidにする。
CLI version＋fixture＋probeでhistory capabilityをgateする。将来Agent SDKの`listSessions`/`getSessionMessages`へ交換できるが、初期実装で依存を追加しない。

## 5.8 初期capabilityとspike gate

- native resume、turn interrupt、policy permission: spike通過後に有効
- history read: version/fixtureで確認済みの範囲だけ有効
- model/effort: 初期はnative defaultのみで選択無効。候補を実turnで検証後だけ有効
- project/local customization: 初期は`--safe-mode`で無効
- interactive permission、compact、persistent live: 初期は無効

今回、実Claude turnは実行していない。local `2.1.199`ではbinary/auth、argv、same-cwd lookup等の非production互換性だけを調べる。production候補`2.1.214`以上で新規session、resume、partial/fullと大容量stream末尾、subagent、正常/異常終了、SIGINT clean interrupt、SIGTERM/SIGKILL escalation、transcript、policy permissionを実測する。
advertised capability、fixture、minimum version gateを確定し、通らない機能はcapability falseのままにする。`2.1.199`をproduction streamingへfallbackさせない。このspikeをClaude有効化のrelease gateとする。

# 6. セッション・履歴管理方式

## 6.1 正本とbinding

Codexの正本はApp Server threadと`~/.codex/sessions` rollout、Claudeの正本はClaude native session/transcriptである。private_runnerを第三の会話DBにしない。
永続bindingは次だけとする。

```text
SessionBinding = { backendId, nativeSessionId, canonicalCwd }
```

本文、要約、message count、model responseを入れない。read/unread等のUI metadataが必要なら会話bindingとは別責務にする。
新しい独立storeを増やさず、既存`llm-acp-session-store`のserialization/atomic writeをunconditionalなagent metadata storeへ発展させる。legacy ACP namespaceだけが既存`SESSION_ROOT_BINDING_ENABLED`に従い、次のagent namespaceはそのflagがoffでも常に有効にする。

- `agentBindings`: 上記SessionBindingだけ
- `agentSessionModes`: durable modeとactive/recovering lease
- `agentOperations`: 認証主体ID、request hash、run state、terminal確定後TTL
- `approvedWorkspaces`: canonical root、承認時刻、失効状態

いずれも会話本文やnative credentialを保存しない。active/pending operationとactive/recovering leaseはcapacity/TTL evictionからpinし、容量不足ならBackend起動前に新規turnをfail closedする。operation TTLはterminal確定後から開始し、期限切れIDの再利用は新規operationとして扱うことをhandshake metadataで明示する。
各neutral sessionのbindingは一箇所だけに保存し、ACPと新namespaceへ二重記録しない。既存native sessionは一覧/再開時に確認できたものだけlazy bindingし、一括移行しない。
`agentSessionModes`にrecordがない既存Codex sessionはrawと解釈し、最初の取得時にraw recordを保存する。neutral modeへの変更はPhase 3の明示handoffだけで行い、一覧表示やhistory readでは変更しない。
Provider間のnative ID衝突は`backendId`との組で防ぐ。新規session専用endpointは作らず、最初の`startTurn`と`session.resolved`で確定する。

## 6.2 Codex history

既存index、reader、cursor algorithmを変更せずCodexBackend配下へ移す。CodexBackend内部でACP metadataとCLI rollout catalog/historyを統合し、互換responseと既存cursorを移行中維持する。
neutral protocolではsource名ではなくsessionRefとcapabilityを使う。

## 6.3 Claude history

ClaudeBackend内部でcatalogとtranscriptを統合し、cwd単位でnative sessionを列挙して必要な表示itemだけを逐次変換する。大きなtranscriptを全読込しない。
cursorはfile identity/offsetを含むopaque値にする方向でspike検証し、replace/truncateはcursor invalidとする。

## 6.4 二重管理禁止

live event replay bufferは一時的transport stateであり履歴正本ではない。turn完了後にsession transcriptとして永続化しない。
push previewも会話正本にしない。legacy rollout writerはlegacy経路だけに限定する。

# 7. ストリーミング/イベントの共通化方式

## 7.1 envelopeとevent type

```text
AgentEvent<T> = {
  protocolVersion,
  type,
  runId,
  sessionRef?,
  sequence,
  at,
  payload: T
}

TurnAccepted = AgentEvent<{ clientOperationId }>
SessionResolved = AgentEvent<{ sessionRef }>
TurnStarted = AgentEvent<{ nativeTurnId? }>

ItemStarted = AgentEvent<{
  itemId,
  role: "assistant" | "user" | "tool" | "system",
  parentItemId?
}>
ContentDelta = AgentEvent<{
  itemId,
  contentIndex,
  delta:
    | { type: "text", text }
    | { type: "reasoning", text }
    | { type: "tool_input_json", toolCallId, jsonFragment }
}>
ItemCompleted = AgentEvent<{
  itemId,
  content: ContentBlock[],
  snapshotRevision
}>

ToolStarted = AgentEvent<{
  itemId,
  toolCallId,
  name,
  inputSummary?
}>
ToolCompleted = AgentEvent<{
  itemId,
  toolCallId,
  status: "completed" | "failed",
  resultSummary?
}>

ActionRequested = AgentEvent<{
  requestId,
  kind: "approval" | "permission",
  itemId?,
  toolCallId?,
  summary,
  decisions: ("allow" | "deny" | "allow_for_session")[],
  expiresAt?
}>
ActionResolved = AgentEvent<{
  requestId,
  outcome: "answered" | "expired" | "cancelled",
  decision?: "allow" | "deny" | "allow_for_session"
}>

UsageUpdated = AgentEvent<{ inputTokens?, outputTokens?, cachedTokens? }>
TurnTerminal = AgentEvent<TurnResult>
ProviderDiagnostic = AgentEvent<{ backendId, nativeType, data }>
```

実際の`type`は次に限定したdiscriminated unionとする。

- `turn.accepted` / `session.resolved` / `turn.started`
- `item.started` / `content.delta` / `item.completed`
- `tool.started` / `tool.completed`
- `action.requested` / `action.resolved`
- `usage.updated`
- `turn.completed` / `turn.interrupted` / `turn.failed`
- `provider.event`

sequenceはrun内で単調増加しnative sequenceとは分ける。`itemId`、`contentIndex`、`toolCallId`は同じnative対象についてdelta、snapshot、history間でstableにする。`item.completed`は同じ`itemId/contentIndex`のdeltaを置換するauthoritative snapshotであり、UIは追記しない。replayは`runId/sequence`で重複排除し、snapshotは`itemId/snapshotRevision`で古い版を無視する。unknown common typeはprotocol version不一致として接続を閉じ、unknown native typeだけを`provider.event`へ送れる。全Providerが全eventを出す必要はなく、capabilityに従う。

`item.started`は同じ`itemId`につき一度、`content.delta`は対応するitem開始後、`tool.completed`は同じ`toolCallId`の開始後だけ許可する。Backendがcomplete snapshotしか得られない場合はdeltaを捏造せず`item.started`から`item.completed`へ進む。`system/init`前のClaude startup eventは`turn.accepted`後にbounded/redacted `provider.event`として流せるが、session ID確定前に`session.resolved`や`turn.started`を出さない。

## 7.2 Codex変換

CodexBackendはraw App Server eventをcommon eventへ写像する。raw compatibility clientには従来payload、neutral clientにはcommon eventを送る。
raw unknown eventの完全なfidelityは`CodexRawRelayCompat`だけが保証する。neutral側の`provider.event`はbounded/redacted diagnosticに限定する。

## 7.3 Claude変換

system/initでsession IDを確認し、partial assistantをstable item/block delta、complete assistantをauthoritative snapshot、tool/usage/resultを対応eventへ変換する。`parent_tool_use_id`は`parentItemId`へ対応付け、subagent本文をmain itemへ混ぜない。signal種類では分類せず、AgentServiceでcancelがlinearizeされたrunだけを`turn.interrupted`にする。

## 7.4 replayとapproval

neutral transportはrun単位のbounded replay bufferを持てるが、session historyにはしない。resume requestは最後に受領したsequenceを渡し、responseは再送eventsに加えてauthoritativeな`activeActions` snapshotを含む。clientはまずsequenceでeventsを適用し、最後にsnapshotに存在しないpending actionを閉じる。gap時はresume missとしnative history再取得へ誘導する。
Codex raw relayのsequence semanticsは互換経路で維持する。
`action.requested`はapproval/permissionの違いを`kind`で表し、応答口は一つの`action.respond`にする。Codex App Server approvalは`kind="approval"`、将来のClaude interactive permissionは`kind="permission"`へ変換する。v1 Claudeはinteractive capability falseなのでこのeventを出さない。回答、expiry、turn cancel時はexactly one `action.resolved`を全接続clientへ送り、回答済みrequestをreplay対象と`activeActions`から除く。pushや別clientの応答も同じstate transitionを通り、現行Codexと同じく未回答だけを再表示する。Codex RPC IDや将来のClaude tokenはBackend内部tableに置き、secretをpush/logへ複製しない。

native terminalを観測したらrunを`finalizing`へ原子的に遷移し、全active actionをsnapshotから除去して各`action.resolved(outcome="cancelled"|"expired")`をsequence順に発行した後、terminalを最後に発行する。finalizing以後のaction応答は`action_expired`で拒否する。
terminal eventのpayloadは`completion`がresolveするものと同一の`TurnResult`であり、event envelopeとpayloadの`runId/sessionRef`は完全一致させ、typeとpayloadの`outcome`も一致させる。error payloadは共通error schemaだけを持ち、native errorはredacted diagnosticへ分離する。terminal後のnative stdout/stderr/eventはUIへ流さずcleanup診断だけにする。

`provider.event` payloadは`{ backendId, nativeType, data }`だけとし、dataをbyte/depth/key allowlistで制限してredactする。
これはdiagnosticでありhistoryへ永続化せず、UI/use caseがnativeTypeやdataで分岐することを禁止する。

# 8. OpenClawから参考にする部分と、参考にしない部分

## 8.1 固定参照

OpenClawはcommit `3d77a28da8041fdefb4d128d219689d795d04998`へ固定する。可変mainを設計根拠にしない。

## 8.2 参考にする

- Claude CLI引数、stream-json/partial parser
- child processのexit/error/abort競合処理
- graceful terminationからkillへの昇格
- live processのsession ID追跡
- session catalog scanとtranscript history境界
- bounded outputとdiagnostic保持

## 8.3 参考にしない

- OpenClaw全体のAgent/plugin/channel architecture
- 汎用CLI Backend基底、CLI fallback chain、巨大な設定表
- OpenClaw固有config、message bus、session store
- transcript本文の別store同期

OpenClawはcopy元ではなくfailure modeの参考とし、Claude固有処理だけを`ClaudeBackend`へ局所実装する。

# 9. 既存Codex動作を壊さず段階的に移行する手順

## Phase 0: baseline固定

既存Codex testを通し、raw relayの新規thread、resume、stream、interrupt、approval、compact、reconnectとHTTP history responseをfixture化する。production codeは変えない。

## Phase 1: Codexの物理分離

history、RPC/turn、queueのCodex起動部/compact、relayの順に既存moduleを移動/再利用する。schedule recurrence/location/notificationのdomain moduleは動かさず、Codex option parsingと既存turn起動境界だけを分離先へ委譲する。Server route、wire/永続形式、`run-local.sh`のApp Server起動/mode/env/process方式は変えず、既存testを全て通す。
rollbackは移動commitのrevertだけで完結させ、data rollbackを不要にする。

## Phase 2: neutral protocol追加

AgentServiceとservice内registryを追加し、CodexBackendへneutral `startTurn`/historyを接続する。schedule use caseとqueueはこのPhaseでAgentServiceへ接続し、compactだけはCodex optional operationのままにする。schedule/queueはsession modeを変更せずleaseだけを取り、既存raw sessionは現行relay execution、neutral sessionはBackend executionを使う。暗黙handoffはしない。raw pathはcontract外の`CodexRawRelayCompat`として並存させる。比較期間は一つのraw executionからcommon eventをshadow生成し、event type、ID相関、順序、文字数、terminal outcome、salted hashだけを比較する。本文、tool input/output、native payloadを永続化せず、neutral turnを別に開始したりclientへ二重配信したりしない。
neutral admissionを止めるfeature flagを用意する。rawへrollbackする時は、(1)neutral新規受付停止、(2)bounded drain deadlineまでactive lease/action解消を待機、(3)残るrunへ通常cancel ladder、(4)native activity停止を確認できたsessionだけneutralからrawへbulk handoff、(5)raw client flag切替、の順に行う。停止を確認できないsessionは`recovering`のまま残してrollback対象から外し、modeを強制書換えしない。flagだけでmodeを無視しない。

## Phase 3: Expo単一client

ExpoのsessionRef、startTurn、event、history、action応答を一つのAgent clientへ集約し、screen/hook/componentからCodex RPC名を除く。
sessionをneutral clientで初めて再開する時はactive lease/未回答actionがないことをServerが確認してmodeを明示handoffする。接続時のprotocol handshakeでneutral非対応と判定した旧Serverにだけraw clientへ戻せるflagを維持し、Claude専用分岐は作らない。

## Phase 4: Claude spike

local `2.1.199`は非production調査に限定する。`2.1.214`以上で新規、resume、大容量stream末尾、cancel、failure、transcript、permission、`--safe-mode`とmanaged policyの実効設定を実測し、advertised capability/fixture/version gateを確定する。workspace admissionもこのPhaseで実装・検証し、未通過ではClaudeを有効化しない。

## Phase 5: ClaudeBackend追加

process、parser、history adapterを追加し、registryへ一件登録する。defaultはCodexのまま、限定opt-inにする。
rollbackはregistry/configからClaudeを無効化するだけとし、Claude transcriptを削除しない。

## Phase 6: compatibility整理

最終Serverをneutral onlyにする。次の条件を全て満たした後、`CodexRawRelayCompat`、raw `llm:rpc`、`/codex-ws`、旧Expo clientを同じ削除変更で除去する。

- production telemetryでraw利用が定めた観測期間ゼロ
- Expo全経路がneutral contract test/E2Eを通過
- reconnect、approval、compact、historyの同等性確認済み
- raw rollback flagを不要とするreleaseを一度安定運用済み
- protocol version別telemetryで旧wireの利用がゼロ

legacy Responses `/reply*`はこの削除対象にも含めない。

## 9.1 検証観点

Codexで次を確認する。

- initialize cache/in-flight park、threadless relay
- new/resume/readとturn owner保持
- parent/child subagent分離、delta/completed text
- 未回答approvalだけのreplay、push response
- `action.resolved`の全client配信とactiveActions snapshot
- sequence gap/resume miss、compact完了/失敗/timeout
- queued cancelの現行socket close semantics
- rollout paging/delta cursor、auth/status/model/effort
- calendar dynamic tools

Claudeで次を確認する。

- version probe、新規`--session-id`、same-cwd `--resume`
- cwd mismatch、malformed/unknown event
- bounded NDJSON/stdout/stderr、partial順序
- normal/non-zero exit、SIGINT→SIGTERM→SIGKILL、cancel/result race、cleanup
- transcript list/history、policy permission、interactive未対応
- startup失敗を含む`turn.accepted -> [session.resolved] -> [turn.started] -> exactly one terminal`、terminal後eventなし
- clientOperationId再送の同一run返却、payload conflict、二重実行なし
- operation ledgerのTTL/最大件数、restart時pendingの`operation_status_unknown`、history照合
- raw/neutral/schedule間の同一session ownership handoffと競合拒否
- runner crash後lease recovery、process identity照合、fail-closed、rollback bulk handoff
- protocol version handshake、旧Serverへのraw fallback、unknown common event拒否
- workspace prepare/confirm/revoke、root/home拒否、symlink差替え、revocation cancel
- completion Promiseとterminal TurnResultの一致

主要既存testは`codex-turn-execution`、`runner-ws-multiplex`、`runner-ws-threadless-shared-relay`、`codex-relay-approval-replay`、`codex-relay-initiated-turn`である。
history側は`llm-session-service`、`llm-cli-session-index`、`llm-session-rollout-readers`、`llm-session-messages-delta`、approval/schedule側は`push-approval-respond-endpoint`、`codex-scheduled-relay-integration`を回帰gateにする。

# 10. 将来Provider追加時に変更が必要になる範囲

将来Gemini等を追加する変更は次に限定する。

- `backends/<provider>/`の実装
- registryへの一件追加
- provider固有config/version probe
- provider固有fixture/test
- capability metadata

Server route、Expo screen/component、CodexBackend、ClaudeBackendは変更しない。common eventへprovider名付きtypeを増殖させず、会話本文storeも追加しない。
新Backendはnative session/history/cancel/permissionの意味をcapabilityで宣言し、contract testを通す。UIは返されたcapabilityとmodel一覧だけを描画する。
三つ目のProviderだけを理由にgeneric CLI layerを作らない。共通interface変更は、少なくとも二つの実Backendで同じ意味を持つ場合だけ認める。
完成条件は、新Provider追加時にServer/Expo主要use caseが不変、Provider固有情報がBackend外へ漏れない、本文複製がない、既存Provider testが変更なしで通ることである。

# リスクと対応

- 最大のリスクはExpoが現在Codex App Server clientの一部であること。raw抽出とneutral移行を別Phaseにする。
- relayはtransport以上のstate machineであること。細かなthin wrapperにせず一つのstate ownerへ移す。
- Claude transcriptは非公開形式であること。version probe、fixture、fail-closedで対応し、コピーDBは作らない。
- headless permissionの不確実性。初期はpolicy-onlyとし、実測できたprotocolだけcapabilityを開く。
- legacy Responses系が第二の実行基盤であること。今回のinterfaceから明示的に除外する。

# Sources

## Repository code

- `private_runner/src/server-runtime.mjs`
- `private_runner/src/codex-turn-execution.mjs`
- `private_runner/src/codex-relay-initiator.mjs`
- `private_runner/src/runner-ws-llm-relay-identity.mjs`
- `private_runner/src/llm-cli-session-index.mjs`
- `private_runner/src/llm-session-rollout-readers.mjs`
- `private_runner/src/llm-session-history-page-reader.mjs`
- `private_runner/src/llm-session-service.mjs`
- `private_runner/src/llm-acp-session-store.mjs`
- `private_runner/src/llm-cli-rollout-writer.mjs`
- `private_runner/src/calendar-relay-service.mjs`
- `expo/src/features/codex/client/{turn,threads,compact,turnRelayObserver}.ts`

## OpenClaw fixed commit

- [Anthropic CLI version capability gate](https://github.com/openclaw/openclaw/blob/3d77a28da8041fdefb4d128d219689d795d04998/extensions/anthropic/cli-backend.ts#L145-L152)
- [Anthropic CLI argv construction](https://github.com/openclaw/openclaw/blob/3d77a28da8041fdefb4d128d219689d795d04998/extensions/anthropic/cli-backend.ts#L196-L251)
- [CLI output stream event parsing](https://github.com/openclaw/openclaw/blob/3d77a28da8041fdefb4d128d219689d795d04998/src/agents/cli-output-stream.ts#L339-L382)
- [CLI output stream partial/full normalization](https://github.com/openclaw/openclaw/blob/3d77a28da8041fdefb4d128d219689d795d04998/src/agents/cli-output-stream.ts#L504-L605)
- [Process execution and termination](https://github.com/openclaw/openclaw/blob/3d77a28da8041fdefb4d128d219689d795d04998/src/agents/cli-runner/execute-process.ts#L253-L312)
- [Claude live process handling](https://github.com/openclaw/openclaw/blob/3d77a28da8041fdefb4d128d219689d795d04998/src/agents/cli-runner/claude-live-process.ts#L213-L309)
- [Claude session catalog scan](https://github.com/openclaw/openclaw/blob/3d77a28da8041fdefb4d128d219689d795d04998/extensions/anthropic/session-catalog-scan.ts#L76-L99)
- [Claude transcript parsing boundary](https://github.com/openclaw/openclaw/blob/3d77a28da8041fdefb4d128d219689d795d04998/extensions/anthropic/session-catalog-transcript.ts#L59-L105)

## Anthropic official documentation

- [Claude Code CLI usage](https://code.claude.com/docs/en/cli-usage)
- [Claude Code headless mode（stream末尾、system/init capabilities、workspace trust、SIGTERM）](https://code.claude.com/docs/en/headless)
- [Claude Code sessions（resumeのproject lookupとtranscript）](https://code.claude.com/docs/en/sessions)
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- [Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Claude Agent SDK streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)

# 最終判断

Codex App Server固有責務を先に分離し、期限付きraw互換adapter、neutral protocol、Expo単一client、Claude追加の順で進める。raw互換adapterは`AgentBackend`共通contractへ含めず、neutral移行完了時に削除する。fake `createSession`、本文コピー、class継承、generic CLI Backend、下流provider分岐は採用しない。
Claudeはturn単位process、native session/resume、bounded stream-json、段階kill、policy-only permissionから始める。実Claude turn未実行のため、spike通過を有効化条件とする。
