# Agent Backend 未解決4件 修正作業履歴(2026-08-22)

## 1. この資料の目的

`docs/AGENT-BACKEND-IMPLEMENTATION-HANDOFF.md`(以下「引き継ぎ資料」)に記載された未解決4件を修正した作業の記録である。別のエージェント・レビュー担当がこの資料だけで、何をなぜ変えたか・何が残っているかを把握できることを目的とする。

修正した4件:

1. Claudeでエフォートを選択できない
2. Claudeの同一チャット2回目送信で「Agent Providerを変更できません」toastが出る
3. Claude sessionが左ドロワーのディレクトリー履歴へ追加されない
4. アプリ再起動後にセッション履歴の一部が読み込まれない

## 2. 作業場所と状態

- 作業worktree: `/Volumes/SSD-500GB-SanDisk/work/bitty-worktree/docs/agent-backend-architecture`
- branch: `docs/agent-backend-architecture`(HEAD: `c582af1`、upstreamと0/0)
- 本作業の変更はすべて**未コミット**。HEAD以前からの未コミット差分(引き継ぎ資料§3.2)の上に積んである
- `git reset --hard` / `git checkout -- .` / `git clean` は引き続き禁止。未追跡ファイルも実装の一部

## 3. 修正方針(引き継ぎ資料§16の3発生源に対応)

画面ごとのpatchではなく、次の3つの上流原因を直した。

1. panelがnative session IDを採用した瞬間にProviderをグローバル値へ戻す誤ったstate遷移(→不具合2)
2. effortをbooleanでしか表現できないcapability(→不具合1)
3. directory session listを現在のグローバルProvider一つに限定している一覧contract(→不具合3・4)

`if (backendId === "claude")`分岐は追加していない。Provider固有処理はBackend内、判断はcapability経由。

## 4. 変更内容詳細

### Step 1: snapshot破損の修正(不具合2)

**原因**: `expo/src/features/app/AppRoot.tsx` の `createPanelRuntimeSnapshot` wrapperに「`patch.selectedSessionId`がbaseと異なり`patch.backendId`が無ければグローバル`llmBackend`を採用」という上書きがあった。Claude 1回目送信でlocal draft ID→native UUIDへ差し替わる際に発火し、panelの`backendId`が`codex`へ戻り、2回目送信で正常な`model_backend_mismatch` guardが検出していた。

**修正**:

- `AppRoot.tsx`: wrapperの上書きを削除し、`buildPanelRuntimeSnapshot`のpatch優先・base維持(`patch.backendId ?? base.backendId ?? "codex"`)に一本化。依存配列から`llmBackend`を除去
- Backend切替が必要な入口は`patch.backendId`を明示する規則。確認済みの入口:
  - 新規チャット: `createEmptyPanelRuntimeSnapshot`が`llmBackend`で初期化(変更なし)
  - 履歴hydrate: `AppRoot.tsx`のhydrate本体(`backendId: String(restored.backendId || backendId)`)が明示済み
  - model/Provider選択: `updatePanelSettings`が明示済み
  - ドロワー選択: `handleSelectSessionHistoryEntry`→`openSessionHistoryPopup`がentryのbackendIdを明示済み
- `useApplySessionHistoryPage` / `useLateSessionLiveStateController`は`selectedSessionId`をpatchしないため影響なし
- `model_backend_mismatch` guard自体は削除していない(壊れたsnapshot対策として維持)

**隣接漏れ(引き継ぎ資料§8.5)**: materialized session送信前のCodex compact queue preflight(`enqueueRunnerCodexTurn(... onlyIfCompacting=true)`)がClaude 2回目送信でも到達していた。

- `ModelOption`へ`supportsCompactQueue`を追加し、Backend statusの`operations.compact === true`から導出(`modelOptions.ts`)
- `useCodexReplyRequest.ts`: preflightを`requestModelOption?.supportsCompactQueue !== false`でゲート。catalog未取得時は従来どおり実行(fallbackは`capability?.compact !== false`で許可寄り。compact実行中Codexへの直撃を避けるため)
- `rememberKnownCodexThreadId`は名前に反して「materialized済みsession ID登録」であり、Claude resumeの`threadId`解決にも必要なため変更していない(rename は今回のスコープ外)

### Step 2: effort contractのcatalog化(不具合1)

**原因**: `claude-backend.mjs`が`capabilities.model.effort=false`を返し、`startTurn`はeffort受信で`capability_unsupported`をthrow。UIは共通定数`THINK_OPTIONS`(6値、`ultra`含む)しか描画できず、Claude CLIの5値(`low, medium, high, xhigh, max`)を表現できなかった。

**runner側**:

- `private_runner/src/claude-backend.mjs`:
  - `CLAUDE_EFFORT_OPTIONS = ["low","medium","high","xhigh","max"]`を追加(`ultra`はCLI helpに存在しないため含めない)
  - `capabilities.model`を`effort: true, effortOptions: CLAUDE_EFFORT_OPTIONS`へ
  - `startTurn`: effortをspawn前に検証(catalog外は`turn_rejected`)し、fresh/resume両方のargvへ`--effort <level>`を1回だけ追加。modelは従来どおりfreshのみ(`--resume`時は送らない)
- `private_runner/src/codex-turn-execution.mjs`: `CODEX_EFFORT_OPTIONS`(6値)を定義し`effortOptions`としてadvertise。既存`VALID_EFFORTS`はこれを参照
- `private_runner/src/agent/agent-service.mjs`: `startTurn`検証を拡張。`effortOptions`がadvertiseされている場合、catalog外effortは`capability_unsupported`でBackend実行前に拒否

**Expo側**:

- `expo/src/features/agent/client.ts`: `BackendStatus`型の`model`へ`effortOptions?: string[]`追加
- `expo/src/features/app/contexts/AppSettingsContext.tsx`: `ModelOption`へ`effortOptions?: readonly ReasoningEffort[]`と`supportsCompactQueue?: boolean`追加
- `expo/src/features/app/modelOptions.ts`:
  - `parseEffortOptions()`: 不正値をfilterして取り込み
  - `effortOptionsForModel()`: effort非対応→`[]`、advertiseあり→その値、advertiseなし(旧Backend互換)→`THINK_OPTIONS`。**pickerと検証の唯一のソース**
- `expo/src/features/app/hooks/useChatModelSelection.ts`: `effortOptionsForView`を返す
- `expo/src/features/app/screens/ChatScreen.tsx`: footer pickerとその高さ計算を`effortOptionsForView`ベースへ
- `expo/src/features/app/components/AppOverlays.tsx`: Think modalを`effortOptionsForModel(selectedModelOption)`ベースへ(`thinkOptions`直参照を除去)
- `expo/src/features/app/hooks/useCodexReplyRequest.ts`:
  - effort送信をmodel固定(`changeWithinSession`)から分離。**resumeでもeffortはturn単位で送る**(旧: `effort: requestTurnModel ? ... : undefined` → 新: `effort: requestReasoningEffort || undefined`)
  - `effortOptions`がある場合、catalog外の保存値(例: Codexで保存した`ultra`をClaude modelで送る)は送らずBackend既定にfallback(空文字→undefined)
  - `supportsReasoningEffort === false`時に空へ落とす旧挙動は維持

注意: スケジュール設定(`CodexScheduleSettings`等)の`thinkOptions`はCodex専用のため変更していない。

### Step 3: session listの全Backend統合(不具合3・4)

**原因**: directory treeの一覧取得(`useDirectorySessionTreeController` → `fetchSessionHistory`)が`backendId`未指定時にグローバル`llmBackend`一つへフォールバックし、`sessions.list`を単一Backendにだけ送っていた。completion後refreshと再起動後prefetchも同経路のため、非選択Providerのsessionが一覧から消えていた(データ消失ではなく取得scopeの問題)。

**runner側**:

- `private_runner/src/agent/agent-protocol.mjs`: `ALL_BACKENDS_SCOPE = "all"`をexport
- `private_runner/src/agent/agent-service.mjs` `listSessions`:
  - `backendId`が空または`"all"`のとき、registry内の`session.list`対応Backendを列挙して集約
  - entryは各Backendが返す`sessionRef={backendId,nativeSessionId}`をそのまま保持
  - `updatedAt`降順で統合sort
  - 部分失敗: 失敗Backendは`errors: [serializeAgentError...]`として返し、成功分は保持。**全対象Backendが失敗した場合のみthrow**
  - cursor: `{v:1, backends:{<backendId>: <opaque cursor>}}`のbase64url複合cursor。Backend固有cursorは解釈せず往復のみ(現状どちらのBackendもneutral listでcursorを返さないため実質空だが、契約として実装)
  - 不正cursorは`turn_rejected`
  - 単一backendId指定時は従来の検証・挙動を完全維持
- transport(`agent-transport.mjs`)は変更なし(payload素通し)

**Expo側**:

- `expo/src/features/agent/client.ts`:
  - `ALL_BACKENDS_SCOPE = "all"`をexport
  - `listAgentSessions`: 単一Backend指定時は従来のper-backend readiness gate。all-scope時は`getAgentBackendStatuses`が空(agent channel不可)のときだけ`null`(raw fallback)へ。Backendごとのreadinessはservice側に委譲
- `expo/src/features/codex/client/threads.ts` `listCodexAppServerThreads`:
  - all-scope時もraw fallback(Codexのみの一覧への退行)を許可(`rawFallbackAllowed = backendId === rawFallbackBackendId || backendId === ALL_BACKENDS_SCOPE`)
  - entryの`backendId`/`modelProvider`をリクエストscopeでなく**entryの`sessionRef.backendId`**から採る
  - serviceの`errors`を`partialErrors`として返却(型は`client/types.ts`の`CodexThreadListResult`へ追加)
- `expo/src/features/app/hooks/useLlmSessionExplorer.ts`:
  - `fetchSessionHistory`の既定backendIdを`llmBackend`→`ALL_BACKENDS_SCOPE`へ。呼び出し元がbackendIdを明示した時だけ単一Backendに絞る(既存のpanel用途は維持)
  - `fetchSessionChildrenHistory`(subagent)と`fetchLatestSessionIdForDirectory`も`ALL_BACKENDS_SCOPE`へ
  - 診断: `session_history_fetch_start/done`へ`backendId`、doneへ`partialErrorBackendIds`/`partialErrorCodes`を追加
  - グローバル`llmBackend`への依存を削除(optionsからも除去。`AppRoot.tsx`の呼び出しも更新)
- directory tree(`useDirectorySessionTreeController`)・completion refresh・起動時prefetchは`fetchSessionHistory`を無指定で呼ぶため、**変更なしで**全Backend統合になる。panel openとhistory読みはentryの`sessionRef.backendId`でroute(`resolveSessionHistoryContext`が既にbackendId込みで解決)

### Step 4: session identity

- `dedupeSessionHistoryEntries` / `collectRegisteredDirectorySessions` / completion notification ID / message cache keyは既に`backendId+sessionId` keyであることを確認。「同じnative UUIDを異なるBackendが返しても両方残る」は一覧entryレベルで充足
- tree内部のsessionId単独map(`latestSessionId`、read override、title/marker等)は、UUID衝突が理論上のみのため**今回スコープ外**。実害が出た場合は既存の`sessionRef`概念(`AgentSessionRef={backendId,nativeSessionId}`)で最小範囲を揃える方針(引き継ぎ資料§10.2)

## 5. 変更ファイル一覧(本作業分)

### runner

| ファイル | 変更 |
|---|---|
| `private_runner/src/agent/agent-protocol.mjs` | `ALL_BACKENDS_SCOPE`追加 |
| `private_runner/src/agent/agent-service.mjs` | effortOptions検証、all-backends集約+複合cursor+partial errors |
| `private_runner/src/claude-backend.mjs` | effort catalog advertise、effort検証、`--effort` argv |
| `private_runner/src/codex-turn-execution.mjs` | `CODEX_EFFORT_OPTIONS`定義とadvertise |

### Expo

| ファイル | 変更 |
|---|---|
| `expo/src/features/agent/client.ts` | `ALL_BACKENDS_SCOPE`、`effortOptions`型、`listAgentSessions` all-scope対応 |
| `expo/src/features/codex/client/threads.ts` | all-scope mapping(per-entry backendId)、raw fallback許可、partialErrors |
| `expo/src/features/codex/client/types.ts` | `CodexThreadListResult.partialErrors` |
| `expo/src/features/app/AppRoot.tsx` | snapshot wrapper上書き削除、explorerへのllmBackend渡し削除 |
| `expo/src/features/app/contexts/AppSettingsContext.tsx` | `ModelOption.effortOptions` / `supportsCompactQueue` |
| `expo/src/features/app/modelOptions.ts` | `parseEffortOptions` / `effortOptionsForModel` / capability mapping |
| `expo/src/features/app/hooks/useAgentModelCatalog.ts` | fallback capabilityへcompact伝搬 |
| `expo/src/features/app/hooks/useChatModelSelection.ts` | `effortOptionsForView` |
| `expo/src/features/app/hooks/useCodexReplyRequest.ts` | compact preflightゲート、effortのclamp+model固定からの分離 |
| `expo/src/features/app/hooks/useLlmSessionExplorer.ts` | 既定scope=all、llmBackend依存削除、診断強化 |
| `expo/src/features/app/screens/ChatScreen.tsx` | effort pickerをcatalogベースへ |
| `expo/src/features/app/components/AppOverlays.tsx` | Think modalをcatalogベースへ |

### テスト(追加・更新)

| ファイル | 内容 |
|---|---|
| `private_runner/tests/claude-backend.test.mjs` | capability assert更新、effort argv(fresh 1回だけ/resume)、不正effortのspawn前拒否 |
| `private_runner/tests/agent-service.test.mjs` | effortOptions外の拒否、all-backends統合sort/単一scope維持/partial errors/全失敗throw/不正cursor |
| `expo/.../panelRuntimeSnapshot.test.ts` | native ID採用でbackendId/modelRef保持 |
| `expo/.../usePanelConversationWriteController.test.tsx` | 同上(controller経由) |
| `expo/.../useCodexReplyRequest.test.tsx` | compact queue contract test(claude=接続しない/codex=従来どおり)、resume時effort送信、ultra clamp |
| `expo/.../modelOptions.test.ts` | effortOptions mapping、fallback、compact mapping |
| `expo/.../useChatModelSelection.test.tsx` | pickerがClaudeで5値・`ultra`非表示 |
| `expo/.../useLlmSessionExplorer.test.ts` | 既定scope=all、混在entry保持+partialErrors。mockへ`ALL_BACKENDS_SCOPE`追加、llmBackendオプション除去 |
| `expo/.../threads.test.ts` | all-scope per-entry mapping+partialErrors、raw fallback退行 |

### ドキュメント

- `docs/AGENT-BACKEND-IMPLEMENTATION-HANDOFF.md`: §16として実施記録を追記(旧§16は§17へ)
- 本資料(新規)

## 6. 検証結果(2026-08-22時点)

- Expo full test: **119 suites / 859 tests passed**(`npm test -- --runInBand`)
- private_runner full test: **469 passed / 1 skipped(live)/ 0 fail**(`node --test private_runner/tests/*.test.mjs`)
- Expo `typecheck` / `typecheck:macos`: passed
- `git diff --check`: passed
- Claude CLI 2.1.238の`--effort <level>`(low, medium, high, xhigh, max)をローカル`--help`で確認済み

**注意**: private_runnerテストはsandbox環境だとソケットbindで55件落ちる。sandbox外で実行すること。

## 7. 未実施(残タスク)

1. **ユーザー実機確認**(エージェントは勝手に実行しない):
   - Runner再起動: `private_runner/restart-keep-token.sh`(worktree側。`restart.sh`はトークン再生成につき使わない)
   - iOS実機ビルド: `scripts/ios/build-expo-ios-device.sh`
   - 確認観点: ①Claudeでeffort 5値表示・選択→送信、②Claude同一chatへ2連続送信(backendId=claude維持、toastなし)、③送信完了後に左ドロワーへClaude sessionが出る、④再起動後にCodex/Claude両履歴が同時に出る、⑤Provider切替で他方の履歴が消えない、⑥既存Codexのresume/approval/compact回帰なし
   - 実CLI turnはsubscription課金。まずHaiku+低effort+短promptで
2. **実CLIでのeffort実挙動確認**: fresh/resume双方で`--effort`が受理されるか(unitはfixtureのみ)
3. **独立レビュー**: 特にCodex既存挙動、raw/neutral ownership、all-backends集約の失敗系
4. **commit/push**: ユーザー承認後。未コミット差分を分割する場合も動作中の成果を落とさない

## 8. 回帰させないこと・診断

- §6の既修正2件(local draftのClaude選択、`session cwd does not match`)のfail-closed条件は今回触れていない。緩めないこと
- 2回目送信の診断は`panel_runtime_settings_updated`→`panel_write_session_snapshot_resolved`→`reply_send_guard_enter`の`backendId`を時系列で見る。修正後はnative UUID採用直後も`backendId=claude`のはず
- 履歴の診断は`session_history_fetch_start/done`の`backendId`(=`all`のはず)と`partialErrorBackendIds`を見る

---

## 9. 実機確認1回目のフィードバック修正(2026-08-22 午後)

実機確認で新規3件の報告があり、クライアント診断ログ(`private_runner/logs/client_auto_logs/`)とrunnerストア実データから根本原因を特定して修正した。

### 報告された症状
1. Codex(GPT)で既存チャットに送信すると「session cwd does not match」。Claudeは問題なし
2. アプリ再起動後、一部セッションの履歴・データが読み込まれない
3. 左ドロワーが読み込み完了後も点滅し続ける

### 根本原因A(runner): Codexセッションの実行cwdをworkspace相対スコープで解決していた(症状1と2の一部)

- `server-runtime.mjs`がagent runtimeへ注入していた`resolveSessionDirectory`は`resolveCliSessionEntryDirectory`=**一覧スコープ用のworkspace相対パス**で、workspace(リポジトリルート)外のセッション(例: `/Volumes/.../work/test_folder`)では**空文字**になる
- 空文字は`resolveCanonicalDirectoryIdentity`の**llm_rootフォールバック**に化け、`resolveNativeSessionCwd`でbinding(正: test_folder)と照合されて`session_cwd_mismatch`。resume(session.handoff)・history(session.history)・probeが全滅
- 実データ根拠: `acp_sessions.json`のbindingとcli indexのcwdは双方`/Volumes/.../test_folder`で一致しており、アプリ送信cwdも一致。ズレていたのはnative解決の側
- 修正: `resolveCliSessionEntryExecutionCwd`(entry.cwd絶対パス優先、旧entryはdirectoryをWORKSPACE_ROOT基準で復元、どちらも無ければ空)を注入。agent-runtime側は空cwdをfail-closed(`session_not_found`)にし、llm_rootへの誤解決を遮断
- 併せて`resolveNativeSessionCwd`のreconcileを「idle(lease無し)なら**mode据え置き**でnativeへ収束」に拡張(旧: raw限定)。バグ期間中にllm_rootで汚染されたneutral binding(例: `01a021b7…`)がhandoff/history時に自己修復される。収束先は常に`backend.resolveSessionCwd`(native)でありクライアント入力ではないため、requested cwd照合のfail-closed性は不変(§6.2は緩めていない)

### 根本原因B(Expo): セッションidentity {backendId, sessionId} が自動選択・復元経路で落ちていた(症状2・3)

- ドロワー一覧はall-backends化したが、以下の経路が**backendId無しでsessionIdだけ**を扱っていた:
  - 起動時復元(`useSessionStartupRecoveryController`)
  - ready遷移再同期(`useReadyDrivenResumeSyncController`)の最新セッションfallback
  - `selectSpecificLlmSession`のbackendId既定(グローバルllmBackend)
  - スレッド状態probe(AppRoot、backendId未指定=codex固定)
- その結果、bitty-publicの「最新セッション」が**Claude CLIセッション**(このエージェント自身のセッション`8173cb9b…`)になった時、codexとして照会→「Codex session was not found」→復元rollback→効果再発火→**約1秒周期の無限リトライ**(点滅の正体。診断ログでsession_restore_error 227回/probe失敗211回)
- 修正:
  - `fetchLatestSessionIdForDirectory`→`fetchLatestSessionForDirectory`にし、`{sessionId, backendId}`のidentityを返す。起動復元・resume syncはbackendIdを明示して復元
  - `selectSpecificLlmSession`はopts.backendId→**ドロワーキャッシュのentry identity**(`resolveSessionHistoryContext`)→llmBackendの順で解決
  - probeはentry identity(ref経由)→llmBackendで解決し、`rawFallbackBackendId: "codex"`を明示

### 変更ファイル(今回分)

| ファイル | 変更 |
|---|---|
| `private_runner/src/server-runtime.mjs` | `resolveCliSessionEntryExecutionCwd`新設・注入、`__TESTING__`へ公開 |
| `private_runner/src/agent/agent-runtime.mjs` | `resolveCodexSessionCwd`の空cwdをfail-closed |
| `private_runner/src/agent/agent-service.mjs` | `reconcileIdleRaw`→`reconcileIdle`(mode据え置きでneutralも収束) |
| `private_runner/src/llm-acp-session-store.mjs` | reconcile条件を`existingMode.mode === mode`(mode据え置き)に一般化 |
| `expo/src/features/app/hooks/useLlmSessionExplorer.ts` | `fetchLatestSessionForDirectory`(identity返却) |
| `expo/src/features/app/hooks/useSessionStartupRecoveryController.ts` | 最新fallbackへbackendId明示 |
| `expo/src/features/app/hooks/useReadyDrivenResumeSyncController.ts` | 同上 |
| `expo/src/features/app/AppRoot.tsx` | `selectSpecificLlmSession`のidentity解決、probeのbackendId対応(`resolveSessionHistoryContextRef`) |
| テスト | `cli-session-execution-cwd.test.mjs`新規、`agent-service.test.mjs`(neutral reconcile+leased fail-closed)、`llm-acp-session-store.test.mjs`更新、Expo3件のcontroller/explorerテスト更新+identityテスト追加 |

### 検証(2回目修正後)

- Expo full test: **119 suites / 861 tests passed**、`tsc --noEmit`: passed
- runner: 対象4ファイル(agent-service / llm-acp-session-store / cli-session-execution-cwd / codex-raw-session-ownership)passed。full suiteも実行済み(§6と同様にsandbox外で実行)

### 設計判断(レビュー時に見ること)

1. **binding自己修復の拡張**(raw限定→idle全般): 「history does not expose native cwd when a neutral binding disagrees」テストは意図的に反転した。native cwdがBackendの真実であり、収束先をクライアントが選べない以上fail-closed性は保たれる、という判断。lease中は従来どおり拒否
2. **selectedセッションのbackendIdは永続化しない**: 復元成功時に`setLlmBackend(nextBackendId)`で同期される+キャッシュentryからのidentity解決で起動時も収束するため、設定項目は増やさなかった。起動直後のキャッシュ未ロード数秒間は失敗→ready遷移リトライで収束する設計
3. **既知の残課題(今回スコープ外)**: neutral経由のprobe(`readCodexAppServerThread`)はsynthetic idle statusを返すため、実行中turnの状態検出が粗い(migration設計由来、今回の回帰ではない)。実在しないセッションIDが選択に残った場合の復元リトライはlatest fallback成功で置換されるまで続く(従来挙動)

## §10 実機確認2回目のフィードバック修正(2026-08-22 午後2)

### 症状(ユーザー報告)

1. bitty-publicの一部セッション履歴(直近3日程度の範囲)がドロワーに出ない
2. test_folderは起動直後に欠落があり、メッセージを送信すると復活する

### 事実確認(APIと実データの突き合わせ)

- runner APIを直接照会(`GET /agent/sessions?backendId=all&cwd=…&limit=200`): bitty-public **215件**、test_folder **204件**で、rollout/トランスクリプト実データと一致。**サーバー側の欠落は無い**
- クライアント診断ログ(`client_auto_logs/20260822_114039_287.jsonl`)の`session_history_fetch_done`で判明:
  - 起動prefetchは`limit=5`で各ディレクトリを取得。**agent経路はcursorを返さない**ため`nextCursor`空 → ドロワーは6件目以降を永久に取得できない(症状1。bitty-publicは直近3日だけで5件超あるため「直近の一部が欠落」に見える)
  - 起動直後のtest_folder取得はWS未接続で`listAgentSessions`が失敗し**raw thread/list(Codexのみ)へ退行**。結果がraw=5(codexのみ・claude欠落)で「完全な成功」としてTTLキャッシュされる(症状2)。送信完了時の`session_completion_refresh_directory`でagent経路の再取得が走ると復活

### 根本原因と修正

**A(runner): Agent Backendのsessions.listにページングが無かった**

- 旧経路(codex raw thread/list)はnextCursorを返しドロワーがページングできたが、agent経路は初回ページのみだった(移行時の機能後退)
- 修正: keysetカーソル(並び順キー={updatedAt, source, sessionId})を実装
  - `llm-session-service.mjs` `listLlmSessions`: `opts.cursor`受理+続きがあれば`cursor`返却。不正cursorは400 `invalid_session_list_cursor`
  - `claude-backend.mjs` `listSessions`: 同様のkeysetカーソル+並び順のtie-break(sessionId desc)を決定的に
  - `agent-runtime.mjs` codexBackend: cursorの受け渡し
  - `agent-service.mjs` all-scope合成: **続きページではcursorを返したBackendだけ再照会**(出し切ったBackendを先頭から再列挙して終端しなくなるのを防止)
- offsetでなくkeysetなのは、ページ間で新規セッションが増えても重複・取りこぼしが出ないため

**B(Expo): WS未接続時のall-backends raw退行が「Codexのみの完全成功」としてキャッシュされる**

- raw fallbackは「Backend固有障害でも一覧全体を失わない」ための退行だが、コールド起動のWS未接続でも発動し、非Codexセッション欠落の一覧がTTL固定されていた
- 修正(`threads.ts`): all-scopeで`listAgentSessions`が失敗し、かつ`runnerWebSocketManager.getSnapshot().connectionState !== "ready"`なら**失敗のまま返す**。loadFirstPageの失敗経路は既存entriesを温存し、`useDirectorySessionSyncRecoveryController`がWS ready遷移で自動再同期する(既存機構)。単一Codexスコープのraw退行は同一データ源で欠落を生まないため従来どおり

### 検証

- runner full test(worktreeルート・sandbox外): **476 passed / 1 skipped / 0 fail**(新規: service/claude/composite paging 3テスト)
- Expo: **119 suites / 863 tests passed**(threads.tsのWS未接続退行3テスト追加)、`tsc --noEmit` / `typecheck:macos` / `git diff --check` passed

### 残った観測事項(今回スコープ外)

- 新ビルドでもキャッシュ未ロード時のprobeはllmBackendフォールバックで誤backendIdになり得る(例: llmBackend=claude時にcodexセッションをclaude照会)。probeは表示用で、復元はlatest fallbackで収束するため据え置き
- 実在しないセッションID(例: `01a02735-743a…`)が選択に残った場合の復元リトライは従来挙動のまま(§9設計判断3)

## §11 実機確認3回目のフィードバック修正(2026-08-22 午後3)

### 症状(ユーザー報告)

1. test_folderは解消。bitty-publicは依然一部欠落: ページング以前に、`01a021b7-a34e…`(直近で使ったセッション)が上位に出ない。このセッションに限らない
2. ClaudeのLLMモデル選択にFableが無い

### 根本原因と修正

**A(runner): resumeしたCodexセッションのupdatedAtがセッション開始時刻のまま沈む**

- live APIのlimit=5ページング追跡で`01a021b7-a34e`は5ページ目に出現(ページング自体は正常)。indexエントリはmtime=当日なのに`updatedAt=2026-08-21T00:27:58`(rollout先頭`session_meta`のtimestamp=**開始時刻**)で、resumeしても進まない → 一覧が開始時刻順になり「最近使ったセッションが出ない=欠落」に見えていた
- 未読判定には既に`useRolloutMtime`(entry.updatedAtとrollout mtimeの新しい方を採用)があるのに一覧では未使用だった。修正: `listLlmSessions`のCLI一覧取得に`useRolloutMtime: true`を適用。旧経路(codex thread/list state DBのupdated_at=実活動時刻)との並び順パリティが戻る。keysetカーソルもオーバーレイ後のupdatedAtで一貫
- index実データでのシミュレーション: `01a021b7-a34e`が2位へ浮上。ほか複数の再開セッション(8/17開始で8/21活動等)も正しく上位化

**B(runner): ClaudeモデルカタログにFableが無い**

- `claude --help`で`fable` / `claude-fable-5`エイリアス対応を確認済み。`CLAUDE_MODELS`へ`{ modelId: "fable", label: "Claude Fable" }`を追加(モデル検証エラーメッセージもカタログ導出に)。Expo側はcapabilities.model.catalog駆動でハードコード無し → **アプリ再ビルド不要、runner再起動のみで反映**

### 検証

- runner full test: **477 passed / 1 skipped / 0 fail**(新規: listLlmSessionsのuseRolloutMtimeテスト、claudeカタログテスト更新)
- Expoはコード変更なし

## §12 実機確認4回目のフィードバック修正(2026-08-22 午後4)

### 症状

`01a02294-cc13`(8/21更新)がドロワーで8/7セッションの下に表示される。live APIの並びは正しく(7位)、クライアントの「さらに表示」連結が原因。

### 根本原因と修正(Expo)

all-backends合成ページはBackendごとに時間範囲が揃わない(1ページ目のclaude末尾が8/7でも2ページ目のcodex先頭は8/21)。`loadMoreDirectorySessionTree`が単純連結していたため、後続ページの新しいセッションが古い項目の下に出た。修正: 連結後に常にupdatedAt descで並べ直す(`useDirectorySessionTreeController.ts`)。

### Skiaボードの表示仕様(現状確認)

ボードのセッションカードは`directorySessionsById`(ドロワーに読み込み済みのエントリ)から収集する(`collectRegisteredDirectorySessions`)。つまり**ドロワー未読込(初期5件+ページ済み分の外)のセッションはボードに出ない**のが現仕様。読み込み範囲を広げるかはプロダクト判断(未着手)。

### 検証

Expo 119 suites / 864 tests・`tsc --noEmit`・`typecheck:macos` passed(並べ直しの回帰テスト追加)。runner変更なし。

## §13 合成一覧のグローバルカット(2026-08-22 午後5)

### 経緯

§12の並べ直しは「さらに表示」後の順序しか直さない、初期表示(1ページ目)自体が全体の新しい順トップNであるべき、というユーザー指摘。従来の1ページ目はCodex上位5+Claude上位5の混合(最大10件)で、Claude側の古い項目が、まだ未読込のCodex新しい項目より先に見えていた。

### 修正(runner)

- Backendの`listSessions`が各セッション項目に**位置cursor**(`session.cursor`、その項目のkeyset)を付与(llm-session-service / claude-backend / agent-runtime)
- agent-serviceのall-scope合成: マージ後に**全体limitでカット**し、各Backendの次cursorを「実際に返した最後の項目の位置」までしか進めない(1件も返さなかったBackendは現位置のまま、複合cursorに空文字で保持)。切った分は次ページで返る
- 複合cursorのスキップ判定を`in`(キー存在)に変更(空文字cursor=先頭位置のBackendを飛ばさないため)
- カットは全項目が位置cursorを持つ時だけ(持たないBackendが混ざる場合は従来合成にフォールバック)
- 返却ページからは項目別cursorを除去(wire形式は従来どおり)

### 検証

runner full test: **479 passed / 1 skipped / 0 fail**(グローバルカット2テスト追加)。Expo変更なし(§12の並べ直しは防御として維持)。反映はrunner再起動のみ。

## §14 subagent除外をページング前へ(2026-08-22 午後6)

### 症状

bitty-publicで初期3件・「さらに読み込む」で+1件。live API確認では各ページ5件返っているが、大半が`isSubagent=true`で、クライアントのメイン一覧フィルタ(subAgent系sourceKinds除外)が後段で効くためページサイズが崩れていた。

### 修正

`sessions.list`に`includeSubagents`を追加し、メイン一覧はサーバー側で**ページング前に**subagentを除外(index側の既存`includeSubagents === false`スキップを配線)。経路: threads.ts(sourceKindsから導出)→ listAgentSessions → WS/HTTP → agent-service(spread)→ agent-runtime → listLlmSessions → listCliSessionsForDirectory。子ツリー取得(subAgent系kinds)はincludeSubagents=trueで従来どおり全量+クライアント側filter。Claude backendは無視(subagentセッション概念なし)。

### 検証

runner **480 passed / 1 skipped**・Expo **119 suites / 865 tests**・両typecheck passed。反映は**runner再起動+iOS再ビルド**(threads.ts変更のため)。

## §15 内部コンテキストが折りたたまれず全文表示される(実機5回目)

### 症状

`<recommended_plugins>` などのシステム注入メッセージが、以前(legacy `/session-messages` 経路)は「CODEX CONTEXT」として折りたたみ表示されていたのに、全文がそのまま表示される。

### 原因

1. neutral履歴経路(`readAgentHistory`)でrunnerは分類を`itemType`として返しているが、クライアント(`useLlmSessionExplorer.fetchRunnerSessionMessages`)がマップ時に捨てていて`kind`が付かない。
2. Claude backendの`readHistory`には分類自体がなく、`isMeta`レコードや`<command-name>`/`<task-notification>`等の注入メッセージが素のuserメッセージとして返る。

### 修正

- `useLlmSessionExplorer.ts`: neutral itemの`itemType`が`internal_context`/`unclassified_context`なら`kind`へマップ(→ChatScreenの既存折りたたみ表示`InternalContextMessage`が効く)。
- `claude-backend.mjs`: `classifyHistoryItemType`を追加。`isMeta === true`、またはuserレコードの本文が既知の注入タグ(`system-reminder`/`recommended_plugins`/`command-name`/`command-message`/`command-args`/`command-contents`/`local-command-caveat`/`local-command-stdout`/`local-command-stderr`/`task-notification`)で始まる場合に`itemType: "internal_context"`。sidechainは従来どおり。一覧タイトル(`firstUser`)も注入メッセージをスキップ。
- ユーザーが素で貼ったXML(`<foo>…`)は分類しない(Codex側のペアリング分類と同じ方針、タグは固定リスト)。

### 検証

runner **481 passed / 1 skipped**・Expo **119 suites / 866 tests**・`tsc --noEmit` passed。反映は**runner再起動+iOS再ビルド**の両方が必要。
