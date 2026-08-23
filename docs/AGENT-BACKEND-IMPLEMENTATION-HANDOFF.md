# Agent Backend対応 実装引き継ぎ資料

## 1. この資料の目的

この資料は、`private_runner`をCodex App Server専用から複数Agent Backend対応へ移行している途中の実装を、別のエージェントへ安全に引き継ぐためのものである。

2026-08-22の実機確認で、次の4件が未解決として報告された。

1. Claudeでエフォートを選択できない
2. Claudeの新規チャットでは1回目を送信できるが、同じチャットの2回目で「このチャットではAgent Providerを変更できません。新規チャットを作成してください。」と表示される
3. Claudeで送信したセッションが左ナビドロワーのディレクトリー配下の履歴へ追加されない
4. アプリ再起動後、セッション履歴の一部が読み込まれない

この4件はまだ修正していない。本資料作成時にコードを調査した結果、1と2は原因をコード上で特定できた。3と4は同じ「履歴一覧が単一Backendにスコープされている」構造が主原因と考えられるが、実ログを使った最終確認はまだ行っていない。

## 2. 最初に守ること

### 2.1 作業場所

- main repository: `/Volumes/SSD-500GB-SanDisk/work/bitty-public`
- 作業worktree: `/Volumes/SSD-500GB-SanDisk/work/bitty-worktree/docs/agent-backend-architecture`
- branch: `docs/agent-backend-architecture`
- upstream: `origin/docs/agent-backend-architecture`
- HEAD: `c582af1f9b3ed13fc8156e51fa7644802bbb321f`
- HEAD commit: `feat: add provider-neutral agent backends`

必ず作業worktree内で続行する。main repositoryへ同じ変更を作り直さない。

### 2.2 未コミット差分を失わない

HEADとupstreamは`0 ahead / 0 behind`だが、HEAD以降の機能追加と不具合修正は未コミットである。本資料作成前の状態は、追跡済み変更91ファイル、未追跡11ファイル、追跡済み差分が概ね`+1900/-437`であった。本資料自身が新しい未追跡ファイルとして追加される。

次を実行してはいけない。

- `git reset --hard`
- `git checkout -- .`
- `git clean`
- 別ブランチへの強制切替
- 未追跡ファイルを削除してから作り直すこと

未追跡11ファイルも実装の一部である。

```text
expo/src/features/app/components/LlmCompletionNotifications.test.tsx
expo/src/features/app/hooks/useAgentModelCatalog.test.tsx
expo/src/features/app/hooks/useAgentModelCatalog.ts
expo/src/features/app/hooks/useChatModelSelection.test.tsx
expo/src/features/app/hooks/useChatModelSelection.ts
expo/src/features/app/hooks/useLlmCompletionNotifications.test.tsx
expo/src/features/app/hooks/useLlmCompletionNotifications.ts
expo/src/features/app/hooks/useSessionSwitchQueuedSendController.test.tsx
expo/src/features/app/modelOptions.test.ts
expo/src/features/app/modelOptions.ts
expo/src/features/app/utils/settingsParsers.test.ts
```

作業開始時は、まず次だけを確認する。

```sh
cd /Volumes/SSD-500GB-SanDisk/work/bitty-worktree/docs/agent-backend-architecture
git status --short --branch
git diff --check
```

### 2.3 元の設計原則

最重要要件は、下流の画面やhookへ`if (provider === "claude")`を増殖させないことである。

- Provider固有処理はBackend/Adapter内部へ閉じる
- 呼び出し側はCodex/Claudeを意識しない
- 新しいProviderを追加しても履歴ツリー、送信画面、セッション復元を変更しない形を優先する
- Codex App Serverの既存通信、thread/session、履歴、stream、approval、各種commandは作り直さない
- 会話本文はProviderのnative session/historyを正本とし、runnerへ完全コピーしない
- runnerには`backendId + nativeSessionId + canonicalCwd`等の最小メタデータだけを持つ
- Provider切替は新規チャットだけで許可し、materialize済みセッションではProviderを固定する。modelは同一Provider内でturn単位に変更できる
- `AGENT_NEUTRAL_ENABLED`、`AGENT_CLAUDE_ENABLED`のような実行時フラグは使わず常時登録する
- Claude CLI未導入、対応version未満、未ログインはRunner起動失敗ではなく、Claude選択後の送信単位エラーにする

詳細な元設計は`docs/AGENT-BACKEND-ARCHITECTURE-DESIGN.md`にある。ただし同ファイルの文書情報はまだ「今回は実装しない」のままで、現状と一致しない。内容を参照する際は、設計時点の文書であることに注意する。

## 3. push済み範囲と未コミット範囲

### 3.1 push済み

`c582af1`には主に次が含まれる。

- provider-neutral Agent protocol/service/transport
- Backend registry
- Codex Backend境界
- Claude Backendの初期実装
- workspace admission
- session binding、mode、lease、recovery
- Expo側Agent clientの初期実装
- 設計書

### 3.2 未コミット・未push

HEAD以降の大きな差分には主に次が含まれる。

- Backend statusからCodex/Claudeのmodel一覧を作るmodel selector
- `backendId + modelId`を一つの選択単位にするExpo state
- 既存セッションでProviderを変更させないguard
- Claude completion通知へ`backendId`を伝える変更
- Claude native historyをExpoのsession restoreへ接続する変更
- Provider別session cache key
- feature flag削除とBackend常時有効化
- Claude CLIの遅延version probeと明確な送信エラー
- Claude CLIのmodel alias（`haiku`、`sonnet`、`opus`）
- 新規ローカルdraftとnative sessionを区別する`sessionMaterialized`
- 直前に報告されたCodexの`session cwd does not match`を直すbinding/relay reconciliation

したがって、`c582af1`だけをcheckoutしても現在ユーザーが検証している動作にはならない。現在のdirty worktreeが正しい引き継ぎ元である。

## 4. 現在のアーキテクチャ

```text
Expo
  Agent client / model catalog / session UI
       |
       v
/runner-ws  channel=agent
       |
       v
AgentTransport
       |
       v
AgentService
  - Backend registry
  - session binding/mode/lease
  - workspace admission
  - capability validation
       |
       +-- CodexBackend
       |     Codex App Serverの既存方式を維持
       |
       +-- ClaudeBackend
             claude -p + stream-json + native session/transcript
```

主要ファイルは次の通り。

| 責務 | ファイル |
|---|---|
| neutral protocol | `private_runner/src/agent/agent-protocol.mjs` |
| Backend生成・registry | `private_runner/src/agent/agent-runtime.mjs` |
| routing、binding、lease、capability | `private_runner/src/agent/agent-service.mjs` |
| WebSocket operation | `private_runner/src/agent/agent-transport.mjs` |
| workspace許可 | `private_runner/src/agent/agent-workspace-admission.mjs` |
| Codex Backend | `private_runner/src/codex-turn-execution.mjs` |
| Claude Backend | `private_runner/src/claude-backend.mjs` |
| binding/mode永続化 | `private_runner/src/llm-acp-session-store.mjs` |
| raw Codex ownership | `private_runner/src/agent/codex-raw-session-ownership.mjs` |
| Expo neutral client | `expo/src/features/agent/client.ts` |
| Backend model catalog | `expo/src/features/app/hooks/useAgentModelCatalog.ts`、`expo/src/features/app/modelOptions.ts` |
| model/Provider選択guard | `expo/src/features/app/hooks/useChatModelSelection.ts` |
| turn送信・native ID採用 | `expo/src/features/app/hooks/useCodexReplyRequest.ts` |
| panel snapshot | `expo/src/features/app/utils/panelRuntimeSnapshot.ts`、`expo/src/features/app/AppRoot.tsx` |
| session list/history adapter | `expo/src/features/app/hooks/useLlmSessionExplorer.ts`、`expo/src/features/codex/client/threads.ts` |
| directory tree | `expo/src/features/app/hooks/useDirectorySessionTreeController.ts` |

`useCodexReplyRequest`や`listCodexAppServerThreads`という名前は残っているが、現在はClaude neutral pathも通っている。名前だけを一括renameすることは今回の不具合修正より優先しない。

## 5. Claude Backendの現在の仕様

ローカル環境で確認した状態は次の通り。

- binary: `/Users/daigo-nakamura/.local/bin/claude`
- version: `2.1.238 (Claude Code)`
- Backendが要求するminimum version: `2.1.214`
- 実行方式: Claude Code CLI + Claude subscription
- API keyの注入は行わない
- fresh: `claude -p ... --session-id <uuid> --model <alias>`
- resume: `claude -p ... --resume <uuid> --model <alias>`
- output: `stream-json`、`--verbose`、`--include-partial-messages`
- permission: `--permission-mode dontAsk`
- project customization: `--safe-mode`
- history: `~/.claude/projects/**/<session-id>.jsonl`
- 対応model alias: `haiku`、`sonnet`、`opus`、`fable`
- text inputのみ
- cancel: SIGINT、SIGTERM、SIGKILLの段階停止
- session list/history: transcriptを走査
- schedule、compact、interactive permissionは未対応

現在の`getStatus()`はClaude model capabilityを次のように返す。

```text
select=true
effort=true
effortOptions=[low, medium, high, xhigh, max]
catalog=[haiku, sonnet, opus, fable]
```

Claude CLI 2.1.238自身は`--effort <level>`を持ち、help上の値は`low, medium, high, xhigh, max`である。`ultra`はClaude CLIのhelpにはない。

## 6. 直前までに修正済みの不具合

次の二つは今回の4件より前に修正済みで、回帰させないこと。

### 6.1 local draftでClaudeを選択できない問題

新規チャットのローカル仮IDが既存native sessionとして扱われ、選択直後に「新規チャットが必要です」と出ていた。

現在は次の形で直してある。

- `PanelRuntimeSnapshot`に`sessionMaterialized`を保持
- 新規draftは`sessionMaterialized=false`
- native session hydrateは開始時から`true`
- native IDが確定した時に`true`へ遷移
- ready-driven resume syncは明示的な`false`をhydrateしない
- 旧snapshotの`undefined`は互換性のためnative扱い

### 6.2 既存Codexセッションの`session cwd does not match`

共有raw relayの古いcwdと永続binding reconciliationのraceが原因だった。

現在は次の形で直してある。

- `thread/start|resume`にcwdがなければrelayの古い`threadCwd`を消す
- native resultのcwdをauthoritativeにする
- pending binding reconciliationをraw admission前に待つ
- idle raw、leaseなしのbindingだけ安全にrepairする
- neutral/active/recovering/leaseありはfail closedのまま
- mismatch時にBackend executionへ抜けず、開始前に拒否する

このfail-closed条件を緩めて今回の問題を回避しないこと。

## 7. 未解決不具合1: Claudeでエフォートを選択できない

### 7.1 確定している原因

これはUIだけの不具合ではなく、現在のBackend contractが明示的に無効化している。

- `private_runner/src/claude-backend.mjs`
  - `capabilities.model.effort=false`
  - `startTurn`は`effort`が来ると`capability_unsupported`をthrowする
- `expo/src/features/app/modelOptions.ts`
  - statusの`effort`を`supportsReasoningEffort`へ写す
- `expo/src/features/app/hooks/useChatModelSelection.ts`
  - `supportsReasoningEffort=true`のmodelだけeffort pickerを表示する
- `expo/src/features/app/screens/ChatScreen.tsx`と`AppOverlays.tsx`
  - picker自体が非表示になる

### 7.2 期待する修正方向

ClaudeだけをUIで特別扱いしない。Backendが選択可能なeffort catalogを公開し、UIはcatalogを描画する。

現在はUIが共通定数`THINK_OPTIONS=[low, medium, high, xhigh, max, ultra]`を使うため、単純に`effort=true`へ変えるだけではClaudeへ未対応の`ultra`を表示してしまう。最小限の根本修正は、model capabilityまたは各model catalog entryへ選択可能effortを持たせることである。

例:

```text
Codex model:  low, medium, high, xhigh, max, ultra
Claude model: low, medium, high, xhigh, max
```

Backend側は受け取ったmodelとeffortを再検証し、Claude CLI argvへ`--model <alias>`と`--effort <level>`を追加する。fresh/resumeの両方で同じturn単位の選択を適用する。materialize済みsessionで固定するのはProviderだけである。

### 7.3 必要なテスト

- Claude statusが実際に許可するeffortだけを返す
- Expo pickerがClaudeで5値を表示し、`ultra`を表示しない
- fresh turnのargvに選択した`--effort`が1回だけ入る
- resume turnのargvとnative session動作をfixture/実CLIで確認する
- 不正effortはspawn前に拒否される
- Codexの既存6値を変えない
- 保存、再起動、session restore後に選択effortが維持される

## 8. 未解決不具合2: Claudeの2回目送信でProvider変更guardが発火する

### 8.1 再現時の流れ

1. ローカルdraftでClaude Sonnetを選ぶ
2. 1回目は`backendId=claude, modelRef=sonnet, threadIdなし`で送信できる
3. Claude Backendがnative session UUIDを返す
4. panelの`selectedSessionId`をローカルdraft IDからnative UUIDへ差し替える
5. その際にpanelの`backendId`がグローバル設定の`codex`へ戻る
6. panelには`modelRef=sonnet`が残る
7. 2回目の送信で`backendId=codex + modelRef=sonnet`となる
8. 正常な`model_backend_mismatch` guardが不整合を検出し、ユーザー報告のtoastを出す

### 8.2 確定している原因

`expo/src/features/app/AppRoot.tsx`の`createPanelRuntimeSnapshot` wrapperに次のロジックがある。

```text
selectedSessionIdが変わった
  -> patch.backendIdがなければグローバルllmBackendを採用
```

panel固有でClaudeを選択しても、グローバル`llmBackend`はCodexのままである。1回目のturnでlocal draft IDからnative session IDへ変わることを「別セッション選択」と誤認し、ProviderをCodexへ戻している。

`buildPanelRuntimeSnapshot`本体は`patch.backendId ?? base.backendId`で正しく保持する。問題はAppRoot側wrapperの上書きである。

### 8.3 最小の修正方向

`selectedSessionId`変更時にグローバルProviderへ戻す特殊処理を削除し、`backendId`は次の規則だけにする。

- 明示的な`patch.backendId`があれば採用
- なければbase snapshotの`backendId`を保持
- 新規チャット作成、履歴hydrate、ユーザーmodel選択の入口では必要なBackendを明示する

`model_backend_mismatch` guardを削除してはいけない。guardは壊れたsnapshotから誤Providerへ送ることを防いでおり、今回の根本原因ではない。

### 8.4 必要なテスト

- `Claude local draft + sonnet`からnative UUIDを採用しても`backendId=claude`を保持する
- 同じpanelの2回目送信が`backendId=claude`でneutral startへ進む
- materialize後にユーザーがCodex modelを選ぼうとすると従来どおりblockされる
- 履歴からCodex/Claudeをhydrateする時は各entryのBackendになる
- 複数panelが同一sessionを表示する場合もProviderが同期される

### 8.5 隣接するProvider漏れ

`useCodexReplyRequest`には、materialize済みsessionの送信前に`enqueueRunnerCodexTurn(... onlyIfCompacting=true)`を呼ぶCodex compact queue preflightが残る。Claudeの2回目送信でもここへ到達し得る。また、`rememberKnownCodexThreadId`、raw relay observer、Codex context usage fallbackもProvider-neutral pathから参照される。

今回のtoastの直接原因はsnapshot上書きだが、修正後の2回目送信でこれらが表面化する可能性がある。`if (backendId === "claude")`で飛ばすのではなく、Agent capabilityまたはAgentService側の共通operationへ寄せる。少なくともClaudeにCodex raw queue/relayを接続しないcontract testを追加する。

## 9. 未解決不具合3: Claude sessionが左ドロワー履歴へ追加されない

### 9.1 コード上で確認できた構造

Claude Backendの`listSessions({cwd})`自体は実装済みで、`~/.claude/projects`のtranscriptを走査し、`backendId=claude`付きsessionを返す。

しかしExpoのdirectory treeは次の経路で一覧を取得する。

```text
useDirectorySessionTreeController
  -> fetchSessionHistory(directory, options)
  -> historyOptions.backendIdが無いためグローバルllmBackendを使う
  -> listCodexAppServerThreads
  -> sessions.listを一つのBackendにだけ送る
```

`useDirectorySessionTreeController`の`FetchSessionHistoryOptions`には`backendId`がなく、directoryごとの通常refreshでも指定していない。このため左ドロワーは全Providerの履歴ではなく、その時点のグローバルProvider一つだけを表示する。

さらにcompletion経路は`LlmMessageCompletion.backendId`を持っているが、`handleLlmMessageCompleted`から`refreshDirectorySessionsAfterCompletion(completion.directory)`へ渡す際にBackend情報を使っていない。refresh自体が単一のグローバルProviderを読むため、panel固有Claude turn完了後にClaude sessionが追加されない。

### 9.2 根本修正の方向

ドロワーのdirectory session listは「現在選択中Providerの一覧」ではなく「そのdirectoryに属する全Backend sessionの統合一覧」であるべきである。

将来Providerを追加してもExpoのdirectory controllerを変更しなくてよいよう、AgentServiceのsession listing境界で全Backendを集約する案を優先する。

- `sessions.list`にprovider-neutralなall-backends scopeを持たせる
- AgentServiceがregistry内の`session.list`対応Backendを列挙する
- entryは必ず`sessionRef={backendId,nativeSessionId}`を保持する
- updatedAtで統合sortする
- 一つのBackend失敗で他Backendの成功分を消さない。ただし部分失敗を診断可能に返す
- cursorはBackend固有cursorを共通層で解釈せず、opaqueな複合cursorとして扱う
- panelを開く時とhistoryを読む時だけentryの`sessionRef.backendId`へrouteする

Expo側で`Promise.all([codex, claude])`を直接書く方法は、次のProvider追加でUI修正が必要になり、paginationも重複するため第一候補にしない。

### 9.3 必要なテスト

- 同じdirectoryのCodexとClaude sessionが同時に一覧へ出る
- completion時のrefreshでClaude sessionが追加される
- 選択中model/ProviderがCodexでもClaude履歴が消えない
- 一方のBackend listが失敗しても他方の履歴は保持され、partial errorが分かる
- 同じnative UUIDを異なるBackendが返しても両方残る
- sortとpaginationで重複・欠落しない

## 10. 未解決不具合4: 再起動後に一部session historyが読み込まれない

### 10.1 最有力原因

不具合3と同じく、再起動後のdirectory prefetchも`llmBackend`一つだけで`fetchSessionHistory`を呼ぶ。そのため再起動時に保存されているグローバルProviderと異なるProviderのsessionが一覧から消える。

これはデータ消失ではなく、一覧取得scopeによる非表示である可能性が高い。Claude transcriptやCodex native sessionを削除する処理は今回追加していない。

### 10.2 統合一覧にする前に直すidentity

一部のutilityは既に`backendId + sessionId`をkeyに変更済みである。

- `dedupeSessionHistoryEntries`
- `collectRegisteredDirectorySessions`
- completion notification ID
- Provider別message cache key

一方、directory tree内にはまだsession ID単独の管理が残る。

- `latestSessionId: string`
- load-more時の`existingIds`
- read override map
- `childrenByParentId`
- title/marker mapsの一部
- foreground visible session判定の一部

全Backend統合一覧を返すと、理論上同じnative UUIDを異なるProviderが使った場合に衝突する。画面ごとの個別patchではなく、`AgentSessionRef={backendId,nativeSessionId}`をidentityとして扱う最小範囲を決めて揃える。

### 10.3 追加で確認する点

主原因修正後も欠落する場合だけ次を調べる。

- Claude transcriptのcwdと登録directoryのcanonical pathが一致しているか
- symlinkを含むdirectoryで`path.resolve`と`realpath`がずれていないか
- Claude transcript basenameがUUID形式か
- `MAX_TRANSCRIPT_FILES=5000`またはproject directory scan上限へ達していないか
- provider別cache entryが古いcursorで破棄されていないか
- 起動直後のsettings load前にdirectory syncが走っていないか

最初からscan上限やcacheを緩めず、まずall-backends list request/responseのログでどの段階で消えているか確認する。

### 10.4 必要なテスト

- Codex/Claude混在履歴を持つ状態を再起動相当でbootstrapし、両方復元する
- 保存されたグローバルProviderをCodex/Claudeそれぞれにしても一覧が同一になる
- drawer open、screen mount、auth recovery、manual refreshで同じ結果になる
- pagination 2ページ以上で全Providerの欠落・重複がない
- panel hydrateはentryのBackendでhistoryを読む

## 11. 推奨する修正順序

### Step 1: 2回目送信のsnapshot破損を直す

AppRootの`selectedSessionId変更 -> グローバルllmBackend`上書きを削除する。これは局所的だが、症状ではなく誤ったstate遷移の発生源を消す修正である。

この時点でClaude同一sessionへ2回送信し、Codex raw queue/relayへ誤接続しないかを確認する。

### Step 2: effort contractをcatalog化する

Backend statusを、booleanだけでなく選択可能effort値を返せる形へ狭く拡張する。Codex/Claudeの双方が実際に使うため、早すぎる抽象化ではない。

### Step 3: session listを全Backend統合にする

AgentService/transportへall-backends listを実装し、directory treeの一覧取得をグローバル`llmBackend`から切り離す。completion refreshとstartup prefetchを同じ入口へ統一する。

### Step 4: session identityをProvider込みに揃える

統合一覧に必要な範囲だけ`backendId + nativeSessionId`へ変更する。名前だけのwrapperや画面別key生成を増やさず、既存の`sessionRef`概念を使う。

### Step 5: full test、独立レビュー、ユーザー実機確認

実装担当とレビュー担当を分ける。レビューでは特にCodex既存挙動、raw/neutral ownership、履歴paginationを確認する。

## 12. 診断で見るログ

2回目送信では次の既存diagnostic eventを時系列で見る。

```text
panel_runtime_settings_updated
panel_write_session_snapshot_resolved
reply_send_guard_enter
reply_http_thread_resolved
panel_runtime_messages_updated
reply_send_guard_rejected
reply_http_send_skipped reason=model_backend_mismatch
```

各eventの`panelId`、`sessionId`、`backendId`、`modelRef`を比較する。local draft IDからnative UUIDへ変わった直後に`backendId=codex`となるはずである。

履歴では次を見る。

```text
session_completion_refresh_directory
session_history_fetch_start
session_history_fetch_done
directory explorer/tree sync result
```

診断にはrequestごとのBackend、各Backendの返却件数、統合後件数、partial errorを追加するとよい。prompt本文、transcript本文、token、`.env`値はログへ出さない。

## 13. 現在までの検証結果

直前の修正完了時点では次が通っている。

- Expo full test: 119 suites、849 tests passed
- private_runner full test: 465 passed、live test 1 skipped
- Expo `typecheck`: passed
- Expo `typecheck:macos`: passed
- `git diff --check`: passed
- 独立レビュー: Critical/High/Mediumなし

ただし、これらは今回報告された4件を再現するテストを含んでいない。ユーザー実機確認ではClaudeの1回目送信成功まで確認できたが、2回目送信と履歴で上記不具合が出た。

修正後の基本確認コマンドは次の通り。

```sh
cd /Volumes/SSD-500GB-SanDisk/work/bitty-worktree/docs/agent-backend-architecture/expo
npm test -- --runInBand
npm run typecheck
npm run typecheck:macos

cd /Volumes/SSD-500GB-SanDisk/work/bitty-worktree/docs/agent-backend-architecture
node --test private_runner/tests/*.test.mjs
git diff --check
```

実Claude CLI確認はsubscription実行になる。まずHaikuか、利用可能な安価なmodel/低effortで、短いpromptを使う。fixture/unit testを先に通し、必要な実turnだけを実行する。

## 14. ユーザー確認用スクリプト

worktree初期化は既に実施済みだが、依存やnative生成物を変更した場合は`docs/GIT-WORKTREE.md`に従って再確認する。

- Runner再起動: `/Volumes/SSD-500GB-SanDisk/work/bitty-worktree/docs/agent-backend-architecture/private_runner/restart-keep-token.sh`
- iOS実機ビルド: `/Volumes/SSD-500GB-SanDisk/work/bitty-worktree/docs/agent-backend-architecture/scripts/ios/build-expo-ios-device.sh`

ユーザーへは対象worktreeのこの二つをMarkdown linkで案内し、ユーザー検証前にエージェントが勝手に実行しない。

## 15. 完了条件

次をすべて満たすまで完了扱いにしない。

- ClaudeでBackendがadvertiseしたeffortだけを選択できる
- Claude fresh turnと同じnative sessionの連続2 turnが成功する
- 2回目送信でもpanelの`backendId=claude`とmodelが維持される
- Claude turnでCodex raw compact queue/relayを誤使用しない
- Claude sessionが送信完了後に左ドロワーへ出る
- Codex/Claude双方の履歴がアプリ再起動後にも同時に出る
- Provider選択状態により他Providerの履歴が消えない
- existing Codex sessionのresume、history、streaming、approval、compact、cwd bindingが回帰しない
- full Expo/private_runner tests、両typecheck、diff checkが通る
- 別エージェントのレビューでCritical/High/Mediumが解消される
- ユーザーの実機確認が終わる
- その後にcommit/pushする。現時点の未コミット差分を分割・整理する場合も、動作中の成果を落とさない

## 16. 2026-08-22 修正実施記録(本資料の4件への対応)

Step 1〜4を実施済み。ユーザー実機確認とcommit/pushは未実施。

### Step 1: snapshot破損(不具合2)

- `AppRoot.tsx`の`createPanelRuntimeSnapshot` wrapperから「selectedSessionId変更時にグローバル`llmBackend`へ戻す」上書きを削除。backendIdは`buildPanelRuntimeSnapshot`のpatch優先・base維持に一本化
- 回帰テスト: `panelRuntimeSnapshot.test.ts`(native ID採用でbackendId/modelRef保持)、`usePanelConversationWriteController.test.tsx`(同上のcontroller経由)
- 8.5の隣接漏れ: compact queue preflightを`operations.compact` capability由来の`ModelOption.supportsCompactQueue`でゲート。`useCodexReplyRequest.test.tsx`にcontract test(claude=接続しない / codex=従来どおり)を追加

### Step 2: effort catalog化(不具合1)

- Backend statusの`capabilities.model`へ`effortOptions`を追加(Codex: 6値、Claude: 5値=`ultra`なし)。`claude-backend.mjs`はeffortを検証して`--effort`をfresh/resume両方のargvへ1回だけ追加
- AgentServiceは`effortOptions` advertise時にcatalog外effortを`capability_unsupported`で拒否
- Expoは`effortOptionsForModel()`(`modelOptions.ts`)でpickerを描画。送信側はcatalog外の保存値(例: ultra→Claude)を送らずBackend既定へfallback。modelとeffortはresumeでもturn単位で送る

### Step 3: session list全Backend統合(不具合3・4)

- AgentService `sessions.list`にall-backendsスコープ(backendId未指定または`"all"`)を実装。`session.list`対応Backendを列挙し、updatedAtで統合sort、部分失敗は`errors`として返し成功分を保持、複合cursorはopaqueに往復
- Expo `fetchSessionHistory`の既定スコープをグローバル`llmBackend`から`ALL_BACKENDS_SCOPE`へ変更(directory tree・completion refresh・起動時prefetchは同一入口)。entryは`sessionRef.backendId`を保持し、panel open/history読み込みはentryのBackendへroute
- `useLlmSessionExplorer`はグローバル`llmBackend`への依存を削除

### Step 4: identity

- `dedupeSessionHistoryEntries`等は既に`backendId+sessionId` keyで、統合一覧に必要な範囲は充足を確認。tree内部のsessionId単独mapは実UUID衝突が理論上のみのため今回スコープ外(必要になれば`AgentSessionRef`へ揃える)

### 検証結果(2026-08-22)

- Expo full test: 119 suites / 859+ tests passed(修正後の追加テスト含む)
- private_runner full test: 469 passed / 1 skipped(live)
- `typecheck`・`typecheck:macos`・`git diff --check`: passed
- Claude CLI 2.1.238の`--effort`(low〜max)をローカルhelpで確認済み。実CLI turnでのeffort実挙動と4件の実機再現確認は未実施

### 実機確認1回目のフィードバック修正(2026-08-22 午後)

実機確認で新規3件(Codex resumeの`session cwd does not match`・再起動後の一部履歴未読込・ドロワー点滅)が報告され、追加修正を実施した。根本原因は2つ:
1. runner側でCodexセッションの実行cwdをworkspace相対スコープ(`resolveCliSessionEntryDirectory`)で解決しており、workspace外セッションが空→llm_rootへ誤解決されbinding照合で全滅していた
2. Expo側の自動選択・復元・probe経路がall-backends一覧のidentity {backendId, sessionId} を落とし、非Codexセッションをcodex固定で照会→失敗→約1秒周期の復元リトライループになっていた

詳細・変更ファイル・設計判断は `docs/AGENT-BACKEND-FIX-WORKLOG-2026-08-22.md` §9 を参照。修正後検証: Expo 119 suites/861 tests・runner 473 passed/1 skipped・両typecheck・diff check全通過。

### 実機確認2回目のフィードバック修正(2026-08-22 午後2)

「一部セッション履歴がドロワーに出ない」が2件再報告された(bitty-publicの直近分の一部・test_folderの起動直後欠落)。runner APIは実データと一致しており(bitty-public 215件/test_folder 204件)、原因はどちらもクライアント経路:
1. Agent Backendのsessions.listがページングcursorを返さず、ドロワーが各ディレクトリ先頭5件(`DIRECTORY_SESSION_PAGE_SIZE`)しか取得できない(raw thread/list時代からの機能後退)→ 全Backendにkeysetカーソルを実装、all-scope合成は「cursorを返したBackendだけ続きを照会」
2. コールド起動のWS未接続時、all-backends一覧がraw thread/list(Codexのみ)へ退行し「完全な成功」としてTTLキャッシュされ非Codexセッションが欠落固定 → WS未readyなら失敗のまま返し、既存のWS ready再同期に回復させる

詳細は `docs/AGENT-BACKEND-FIX-WORKLOG-2026-08-22.md` §10 を参照。修正後検証: runner 476 passed/1 skipped・Expo 119 suites/863 tests・両typecheck・diff check全通過。

### 実機確認3回目のフィードバック修正(2026-08-22 午後3)

1. resumeしたCodexセッションが一覧下位に沈む問題: indexのupdatedAtはrollout先頭session_metaのtimestamp(開始時刻)でresumeしても進まない → `listLlmSessions`へ`useRolloutMtime: true`(未読判定と同じmtimeオーバーレイ)を適用し、実活動時刻で並ぶ旧thread/listとのパリティを回復
2. Claudeモデルカタログへ`fable`追加(CLI `--model fable`対応確認済み。Expoはcatalog駆動のため**runner再起動のみで反映**)

詳細は同worklog §11。修正後検証: runner 477 passed/1 skipped。

## 17. 引き継ぎ時の最終判断

4件へ個別のUI例外を足すのではなく、次の三つの発生源を直す。

1. panel session ID採用時にProviderをグローバル値へ戻す誤ったstate遷移
2. effortをbooleanだけで表し、Providerごとの実際の選択肢を表現できないcapability
3. directory session listを現在のProvider一つに限定している一覧contract

この三点を上流で直せば、2回目送信、Claude履歴追加、再起動後の履歴欠落を画面ごとにpatchせず解決できる。Codex側は既存方式を維持し、Claude固有のCLI argv、session、transcript、effort validationはClaudeBackend内へ閉じる。
