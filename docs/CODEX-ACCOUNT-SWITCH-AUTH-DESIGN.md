# Codex アカウント切替認証 設計

## 文書情報

- 状態: 採用・実装済み（本番統合検証待ち）
- 対象: Bitty Private Runnerから利用するCodex App Serverの複数アカウント切替
- 公式仕様: [Codex App Server authentication](https://learn.chatgpt.com/docs/app-server#authentication)

## 結論

`chatgptAuthTokens`方式を採用する。canonical store、device-code登録、external注入、refresh handler、gate/owner lock、再起動なし切替、利用制限、Settings/status UIまで実装済みである。

通常CLI / VSCodeのglobal authとBittyのcanonical profileを分離し、共有`CODEX_HOME`の会話データを維持する。

```text
CLI / VSCode → ~/.codex/auth.json（Codexが所有）
Bitty         → Runner profile store（RunnerだけがRefresh Tokenを所有）
              → accessToken + accountIdをApp Serverへ注入
```

- 会話、設定、skills等は従来どおり同じ`CODEX_HOME`を共有する
- managed profileが1件以上の時は`~/.codex/auth.json`を読まず、書かず、切り替えない。profile 0件時は従来のnative処理に任せる
- 各アカウントは初回登録時だけブラウザ認証する
- iPhone Expoからの初回登録はdevice-code flowを使い、`verificationUrl`と`userCode`を表示する
- 通常の切替では保存済みprofileを使い、ブラウザ再認証もRunner/App Server再起動も行わない
- Refresh Tokenを含む同じtoken familyを複数storeへ複製しない
- 設定画面でdevice-code追加・再認証・削除と各アカウントの利用制限を管理する
- チャット右下status dropdownにも各アカウントの利用制限を表示する

## 1. 現状と根本原因

### 修正前フロー

```text
/statusのプルダウン
→ Expo useCodexStatusAuthController
→ POST /codex-auth/switch
→ Runnerが~/.codex/profiles/<authId>_auth.jsonを~/.codex/auth.jsonへrename
→ HTTP 200を返した後、run-local.sh restart --mode fullを予約
→ RunnerとCodex App Serverを再起動
```

`restart-keep-token.sh`はRunner bearer tokenを環境変数で引き継ぎ、`run-local.sh restart`を呼ぶだけである。Codex認証の選択、検証、更新は行わない。

### 確認済みの根本原因

`~/.codex/auth.json`に対するwriterが一つではない。

- Codex CLI / VSCodeは利用中にtokenを自動更新する
- Codex App Serverも同じ`CODEX_HOME`の認証を利用・更新する
- Runnerの`refreshOAuthTokens()`も同じ`auth.json`を直接読み書きする
- profile切替処理も同じ`auth.json`を置換する

Refresh Tokenは更新時に回転し得るため、保存済みJSONのコピーは後から失効する。また、現行切替は新しい`auth.json`を配置してから旧App Serverを遅延停止する。この間に旧processが更新を書き戻せるため、切替と再起動自体にも競合がある。

したがって、下流の再試行や再起動待ちでは解決しない。Refresh Tokenの所有者と書込先を一つにする必要がある。

## 2. 目標と対象外

### 目標

- Bittyの選択中アカウントを再起動なしで確実に切り替える
- CLI / VSCodeのログイン状態と会話継続を壊さない
- Refresh Token回転を単一writer、原子的更新、同時実行排除で管理する
- 認証エラーを`Codex turn ended without completing`だけにせず、再認証が必要か判別できる状態にする

### 対象外

- CLI / VSCode側のアカウント切替
- `CODEX_HOME`の分割、会話データの移行
- 汎用OAuth clientを新規実装すること
- 複数アカウントを同時に一つのApp Server processで実行すること
- Refresh Tokenやaccess tokenをExpoへ渡すこと

## 3. 採用方針

> **external token方式を本採用する。** 隔離スパイクでは注入・A→B→A・refresh交換・実送信まで成功した。direct OAuth refreshは公開external-token契約外で将来互換性・運用保証がなく、401再試行と同時実行の確認は残っている。

App Serverの認証方式には次の差がある。

| 方式 | 認証所有者 | 用途 |
|---|---|---|
| `type: chatgpt` | Codex | URL発行 → ブラウザログイン → Codexが保存・自動更新 |
| `type: chatgptAuthTokens` | ホストアプリ | ホストが`accessToken`、`chatgptAccountId`を注入し、更新にも応答 |

`chatgptAuthTokens`をBittyの本番採用方式とする。スパイクで確認した非公開依存は残存リスクとして管理する。

Bittyの初回登録は、隔離された一時App Server processでの`type: chatgptDeviceCode`だけを使う。本番の共有`CODEX_HOME`ではmanaged loginを実行しない。

### 公式契約の境界

OpenAI公式仕様が定めるのは、`chatgptAuthTokens`でホストがtokenを供給し、App Serverからのrefresh要求へ応答する契約までである。次は公式App Server契約に含まれず、Codexの保存形式とOAuth実装への非公開依存になる。

- managed loginが保存したcredentialの抽出とRunner storeへの所有権移管
- Refresh Tokenを使うtoken endpoint、request項目、rotation処理
- Codex credential schemaからaccount ID、client ID、有効期限を取り出す処理

これは残存リスクである。現行installed versionでは動作確認済みだが、experimental API、credential schema、OAuth endpoint変更には追随が必要である。

### 利用制限

`account/rateLimits/read` と `account/rateLimits/updated` の値を使い、`windowDurationMins`で表示する。5時間・週などの名前はhardcodeしない。bucket欠落は未取得／対象なしとする。inactive profileはlive chat App Serverの認証を切り替えず、短命・隔離probe App Serverへ順次external injectionして取得し、Runnerがlast-known値をcacheする。

## 4. 認証所有権

| データ / 処理 | 唯一の所有者 | 保存先・扱い |
|---|---|---|
| CLI / VSCodeの認証 | Codex | `~/.codex/auth.json`。managed profile時はBittyが変更しない |
| Bitty各profileのRefresh Token | Runner | `private_runner/logs/codex-auth/profiles/<authId>.json` |
| Bittyの選択中profile | Runner | 同storeのmarkerとprocess内state |
| App Server認証 | App Server process | Runnerから渡されたaccess token / account IDのみ |
| Expo | なし | `authId`、表示用状態、エラーコードだけ |

Runner内の認証処理は、一つの既存責務境界へ集約する。profile読込、選択、refresh、原子的保存、App Server注入、admissionを同じserviceが担当し、次の全経路から共用する。

- `/codex-auth/profiles`、`/codex-auth/switch`
- App Serverの`account/chatgptAuthTokens/refresh`
- `/codex-cli/status`が使うusage取得
- App Serverを通さない既存Responses API経路

`server-runtime.mjs`内に同じrefresh処理を残さない。UI、relay、HTTP routeは認証判断を持たず、このserviceへ委譲する。

### 共通admission gate

check-then-actを避けるため、全account依存経路を同じgateへ通す。

```text
open
→ switch mutex取得
→ closing（新規RPC / direct requestを拒否）
→ 受付済み処理をdrain
→ profile mutation mutex取得
→ target注入・検証・marker更新
→ open
```

- 対象はraw/shared relay、内部App Server client、direct Responses、usage取得の全て
- 受付時にleaseを取得し、応答または失敗まで保持する。switchはlease数が0になるまで進まない
- closing中に既存RPCから発生した401 refreshは、そのleaseの一部として完了させる
- switch mutexはswitch同士だけを排他する。refreshと共有するprofile mutation mutexはdrain後に取得し、既存RPCのrefreshを待たせてdeadlockさせない
- 新規要求は`503 codex_auth_switching`で即時拒否し、queueや別accountへ回さない
- rollback失敗、store不整合、startup注入失敗では`unready`へ遷移し、全Codex送信を停止する

### process間排他

process内mutexだけでは、同じ`private_runner/logs`を共有する別worktreeのRunnerと競合できる。`docs/GIT-WORKTREE.md`どおり同じmainを共有するRunnerは同時に一つだけ、を運用前提とする。そのうえで認証storeにはprocess間owner lockも置く。

- Runner起動時にexclusive createし、process lifetime中保持する
- lockにはPID、取得時刻、random nonceを記録する
- 正常終了時は、自分のnonceと一致する場合だけ削除する
- stale lockはPIDが存在しないことを`ESRCH`で確定でき、かつ猶予時間を超えた場合だけ除去する
- PID生存、権限不足、PID再利用の疑いがある場合は除去せず、認証gateを`unready`にする

lockは単一Runner運用を置き換えるものではなく、誤起動時にtoken rotationの二重writerを成立させない安全装置である。

## 5. 初回アカウント登録

```text
ExpoがauthIdで登録開始
→ Runnerが0700のstaging CODEX_HOMEを作成
→ staging configでcli_auth_credentials_store="file"を強制
→ 登録専用App Serverをloopbackで起動
→ account/login/start { type: "chatgptDeviceCode" }
→ verificationUrl + userCodeを認証済みExpo clientへ返す
→ ユーザーがiPhone browserで認証
→ account/login/completed成功とaccount/readをRunnerが確認
→ 登録専用processを停止し、exitを待つ
→ staging credentialのaccount IDとtoken構造を検証
→ Runner canonical profileへ原子的に移動・正規化
→ stagingのcredentialを削除
```

- ブラウザ認証はprofileの初回登録、または失効後の明示的な再認証時だけ必要
- stagingではkeychain / auto storeを禁止し、credentialの取得元を一つのfileへ固定する
- グローバル`~/.codex/auth.json`からのコピー登録は禁止
- 既存profileと同じaccount IDの別名登録は拒否する
- 同じRefresh Tokenが別profileに存在する場合も拒否する
- 登録完了前のtokenを選択中profileにしない
- verification URL、user code、auth URL、token、callback内容をログへ書かない

App Server生存中のcredentialを読まない。`account/login/completed`成功後も、process停止とexit確認を先に行い、writerが消えた後でstaging credentialを検証・移管する。取得形式、移管後の有効性、staging削除は実装前スパイクの必須確認対象とする。

### 登録API

全routeは既存Runner bearer認証を必須にし、tokenを応答しない。

| API | 契約 |
|---|---|
| `POST /codex-auth/registrations` | `{ authId }`でdevice-code登録開始。`202 { registrationId, verificationUrl, userCode, expiresAt }` |
| `GET /codex-auth/registrations/:registrationId` | `pending / completed / failed / cancelled`と安全なerror codeを返す |
| `DELETE /codex-auth/registrations/:registrationId` | `account/login/cancel`後にprocess停止・exit待ち・staging破棄 |
| `POST /codex-auth/profiles/:authId/reauth` | 同じdevice-code flowを開始。完了時に同一account IDを確認してprofileを置換 |

同じauth IDへの登録は一つに直列化する。取消・期限切れ・失敗ではcanonical profileとactive markerを変更しない。

## 6. 起動と通常切替

### 起動

```text
Codex App Server起動
→ Runnerが接続しexperimental APIでinitialize
→ 選択中canonical profileを必要ならrefresh
→ account/login/start { type: "chatgptAuthTokens", ... }
→ login/start成功とaccount/readを確認
→ BittyのCodex trafficをreadyにする
```

外部token注入が完了するまで、turn、usage取得、thread操作をApp Serverへ流さない。これにより、起動直後に共有`auth.json`の認証で誤送信する窓を作らない。

Bitty profileが0件なら、direct native pathは従来どおりglobal credentialをread/refresh/writeし、App Serverはglobal `CODEX_HOME` credential（`auth.json`／native credential store）を自身で解決する。profileが1件以上ならexternal modeのみとし、global authへ暗黙fallbackしない。0→1ではgateをclosingしてdrain後にexternal注入と`account/read`を確認する。初回注入に失敗した場合はcanonical profileを残したままgateを`unready`にし、Codex送信を停止する。

最後のactive profileは削除できない（409）。別profileへ切り替えた後に削除する。

### 通常切替

```text
POST /codex-auth/switch { authId }
→ Runnerのswitch mutexを取得
→ 共通admission gateをclosingにして新規受付停止
→ 受付済みaccount依存RPCをdrain
→ profile mutation mutexを取得
→ target profileを検証し、必要ならrefresh・保存
→ App ServerへchatgptAuthTokensを注入
→ login/start成功とaccount/readを確認
→ active markerを原子的更新
→ admission gateをopen
→ 200を返す
```

- App ServerとRunnerを再起動しない
- 切替成功は「ファイルを選んだ時点」ではなく「App Serverが対象accountを受理した時点」
- account IDは注入前にcanonical tokenとprofile metadataの一致を確認する
- 注入の確定条件は`account/login/start`が`chatgptAuthTokens`成功を返し、続く`account/read`でChatGPT accountが有効なこと。`account/updated.authMode`は補助確認にだけ使い、account ID確認には使わない
- drainはcheck後の新規受付を許さないため、check-then-actにならない。規定時間内にdrainしなければ409でgateをopenへ戻す
- 注入失敗時はmarkerを変更せず直前profileを再注入する。rollbackにも失敗した場合はgateを`unready`に固定し、全Codex送信を停止する

status dropdownの利用制限はlive processを切り替えず、Runner cacheのlast-known値を表示する。

## 7. 401時の更新

公式契約では、外部token利用中のApp Serverは401後、同じRPC接続へ次のserver requestを送る。

```text
account/chatgptAuthTokens/refresh
→ Runnerが選択中profileを照合
→ Refresh Tokenで更新
→ rotated token一式を原子的保存
→ 同じupstream WebSocketへaccessToken / accountIdを応答
→ App Serverが元のrequestを再試行
```

- App Serverのtimeoutは約10秒なので、Runnerは内部処理を8秒で打ち切り、必ず10秒以内にresultまたはJSON-RPC errorを返す
- `previousAccountId`が選択中profileと一致しない要求は更新せず拒否する
- 同一profileへの同時refreshは一つのin-flight promiseへ集約する
- refreshとswitchのprofile更新は同じprofile mutation mutexで直列化し、回転前Refresh Tokenの二重使用を防ぐ。switchはdrain完了後にこのmutexを取得する
- 失敗時は再認証が必要な状態として扱い、別profileへ暗黙切替しない
- refresh requestはExpoへ転送せず、tokenをrelay event log、request log、エラー本文へ残さない

### relay境界

401はRunner内部clientだけでなく、Expo ↔ Runner ↔ App Serverのraw/shared relay上のRPCからも発生する。

現行`handleCodexRelayUpstreamMessage()`はcalendar tool request以外を原則Expoへ転送する。このままではrefresh責務がUIへ漏れ、約10秒の応答も保証できない。

実装では、calendar処理より前に`account/chatgptAuthTokens/refresh`をmethodで横取りし、受信したその`relay.upstreamWs`へRunnerが直接応答する。処理済みrequestはsubscriber配信とreplay logへ入れない。

内部の`codex-app-server-client.mjs`も同じ認証serviceへ接続する。複数handlerが同じRPC idへ重複応答しないよう、server request dispatcherは「methodを処理した最初のhandlerだけが応答、未処理は明示的error」という契約にする。

## 8. CLI / VSCodeとの共存

```text
通常CLI / VSCode
→ 同じCODEX_HOME
→ 同じsessions / config / skills
→ ~/.codex/auth.jsonで従来どおりログイン・更新

Bitty App Server
→ 同じCODEX_HOME
→ 同じsessions / config / skills
→ Runner注入の外部tokenで認証
```

managed profile利用時、Bittyは共有`auth.json`へprofileを書き戻さない。CLI / VSCodeで`codex login`してもBitty profileは上書きされず、Bittyで切り替えてもCLI / VSCodeの選択中アカウントは変わらない。profile 0件時は従来のnative処理に任せる。

## 9. 保存と原子的更新

Runner profile storeは既存のworktree共有永続領域`private_runner/logs/codex-auth/profiles/<authId>.json`に置く。raw `auth.json` copyではなく、必要tokenとaccount metadataを持つversioned canonical profileとする。

- directory mode: `0700`
- profile / marker mode: `0600`
- process間owner lockも同じstoreに置き、取得できないRunnerは認証readyにならない
- 同一directoryの一時fileへ完全なJSONを書き、flush後にrenameする
- profile保存成功後だけin-memory stateとactive markerを進める
- JSON schema version、auth ID、account ID、plan type、token一式、更新日時を持つ
- token値はAPI応答、ログ、例外、debug dumpへ含めない
- 破損JSON、空token、不一致account IDは起動時に無効profileとして隔離し、自動修復しない

access tokenだけを先にmemory更新すると、process crash後に古いRefresh Tokenへ戻る。したがってrefresh成功はrotated Refresh Tokenを含むprofileの原子的保存完了後にのみ確定する。

## 10. 失敗時の扱い

| 状況 | 動作 |
|---|---|
| 指定profileなし / 破損 | 4xx（指定profileなし等）、現在accountを維持 |
| refresh失効 | refresh失敗として扱い、再認証が必要であることを案内 |
| switch中の別switch | mutexで直列化。待機不能なら409 |
| account依存処理中のswitch | 全経路の新規受付を止めてdrain。期限超過なら409 |
| App Server注入失敗 | markerを進めず直前accountへrollback |
| rollback失敗 | gateを`unready`に固定し、全Codex送信を停止 |
| process間lock取得失敗 | gateを`unready`にし、別Runnerの停止を案内 |
| startup注入失敗 | gateを`unready`にし、Codex送信を停止 |
| 401 refresh timeout | 10秒以内にRPC error。後から成功扱いにしない |

Expoには安定したerror codeと再認証要否だけを返す。内部OAuth応答本文やtokenは返さない。

## 11. 旧形式からの移行

profileごとの隔離`CODEX_HOME`方式は採用しない。native fallbackはprofile 0件時だけ許可し、CLI/VSCodeへ干渉しない。

既存`~/.codex/profiles/*_auth.json`はlegacy inputとしても自動import・切替・refresh・削除しない。残置し、ユーザーがdevice-codeで再登録する。

1. 新storeを空で開始し、既存auth IDは「再登録が必要」と表示する
2. 各アカウントを隔離device-code flowで一度ずつ登録する
3. 登録済みprofileから順に`chatgptAuthTokens`切替を有効にする
4. 全profile移行後、旧profile読込と`auth.json`切替コードを削除する
5. 旧profile file自体は自動削除せず、利用停止を明示する

移行中も`~/.codex/auth.json`は変更しない。同じtoken familyを旧storeから新storeへコピーする移行モードは作らない。

## 12. 実装対象の既存境界

| 境界 | 変更方針 |
|---|---|
| `private_runner/src/server-runtime.mjs` | route、startup gate、raw/shared relay refresh横取り。認証本体は外へ出す |
| `private_runner/src/codex-app-server-client.mjs` | method別server request dispatchと正しいJSON-RPC error応答 |
| `private_runner/src/codex-turn-execution.mjs` | model list、turn、compact、recoveryを全て`experimentalApi: true`にし、共通auth handler登録 |
| `private_runner/run-local.sh` | 再起動切替を廃止し、App Server起動後の認証ready順序を保証 |
| `private_runner/restart-keep-token.sh` | account切替責務は追加しない |
| `useCodexStatusAuthController.ts` | 既存profile/switch API利用、再認証状態の表示だけ |
| `CodexStatusSummaryMenu.tsx` | auth ID選択と初回登録導線だけ。token処理なし |
| `expo/src/features/app/AppRoot.tsx` | 再起動Alertと`onAuthSwitchStarted`を削除し、確定済み切替結果だけ表示 |
| `expo/src/features/codex/client/probe.ts` | 現行`experimentalApi: false`を廃止し、他のApp Server接続と揃える |

独立した認証serviceは、profile store・refresh・App Server injectionという一つの実責務を持ち、HTTP、relay、direct APIの複数call siteから利用する。単なるforward wrapperは作らない。

現状はmain turnだけが明示的にexperimental APIを有効化し、内部model list / compact / recoveryは`initializeCodexClient()`の既定値`false`、Expo probeも`false`である。外部認証後は401がどの接続に返るかを限定できないため、全接続でcapabilityを統一し、内部clientはauth handler、Expo接続はRunner relay横取りによってrefresh応答を保証する。

## 13. 削除する旧処理

- `~/.codex/auth.json`をBitty profileで置換する処理
- active `auth.json`を旧profileへ書き戻す処理
- `.active_auth_id`、`.switch.lock`を`~/.codex/profiles`へ置く処理
- account切替後のfull restart予約とsudo/restart用設定
- `AppRoot.tsx`の「Codex App Serverを昇格再起動する」Alertとcallback
- `refreshOAuthTokens()`による共有`auth.json`の直接更新
- `auth.json`の差分一致で現在profileを推測する処理

`restart-keep-token.sh`は通常の手動再起動用途として残すが、認証切替の一部にはしない。

## 14. 実測記録

`chatgptAuthTokens`はexperimental APIのため、現行インストール版で次を実測した。

1. installed `codex --version`と生成schemaをfixture化し、`chatgptDeviceCode`、`chatgptAuthTokens`、refresh requestが存在する
2. stagingでfile credential storeが強制され、device-code完了後に想定fileだけからcredentialを取得でき、取消・完了後に削除できる
3. managed login完了 → process停止・exit待ち → host ownership移管後もtokenが有効で、staging writerが残らない
4. 現行token endpointのURL、request schema、client ID解決、Refresh Token rotationをfixtureと連続refreshで確認し、毎回新tokenを保存してから利用できる
5. `capabilities.experimentalApi: true`でexternal loginとrefresh contractが利用可能
6. 外部token認証がApp Server process全体に適用され、別RPC接続のturnにも反映される
7. account A → B → Aを再起動なしで切り替えられる
8. 401を起こした接続へrefresh server requestが届き、応答後に元requestが再試行される
9. managed/external操作（startup、token注入、切替、401 refresh、shutdown）の前後で`~/.codex/auth.json`のhashとmtimeが変化しない
10. 同じ`CODEX_HOME`の既存threadを切替後も`thread/resume`できる
11. server requestの実timeoutが約10秒であり、Runnerの8秒上限が安全

1〜4の非公開依存、6のprocess scope、9の共有`auth.json`不変性は確認済み。ただし将来の仕様変更リスクは残る。

## 15. テストと受け入れ条件

### 自動テスト

- profile登録: device-code情報だけをExpoへ返し、process exit後だけcanonicalへ移動、重複account/tokenを拒否
- 登録取消 / 再認証: stagingを残さず、失敗時に既存profileとmarkerを維持
- atomic store: 書込失敗時に旧profileが残り、markerが進まない
- process lock: 二重Runnerを拒否し、確定できないstale lockを削除しない
- refresh: 同時401を一回のrefreshへ集約し、rotated tokenを保存して各RPCへ応答
- relay: refresh requestを同じupstreamへ返し、Expoとevent logへ流さない
- internal client: calendar/auth handlerが一つのRPCへ重複応答しない
- admission: closing後は全4経路の新規要求を拒否し、既存leaseだけをdrain
- switch: drain後に注入し、成功時はrestartなし、失敗時はrollback
- fail-closed: rollback失敗後はraw/shared relay、internal client、direct Responses / usageを全て拒否
- startup: token注入前のCodex requestを拒否
- direct Responses / usage: 共有auth.jsonではなく選択中canonical profileを使う
- initialize: model / turn / compact / recovery / probeの全接続が`experimentalApi: true`で、対応するrefresh handlerを持つ
- UI: auth IDだけを送受信し、再認証要否を表示する
- 回帰: thread start/resume、approval、calendar tool、shared relay initialize cache

### 受け入れ条件

```text
各accountをiPhoneのverificationUrl + userCodeで初回だけ登録
→ A / B / Aを/statusから切替
→ 各回restartなしで送信成功
→ access token失効後も401 refreshで継続（本番統合で検証）
→ CLI / VSCodeの既存会話resume（本番統合で検証）
→ managed/external操作前後で`~/.codex/auth.json`は不変（profile 0件のnative処理は対象外）
```

ログ、HTTP応答、relay replay、Git差分に秘密情報が含まれないことも受け入れ条件とする。

## 16. 残存リスク

- experimental APIのmethod名、scope、永続化挙動は将来変わり得る。対応versionをversion gateへ固定し、契約テストで検知する
- スパイクでprocess-globalを確認して採用するため、Bitty内での同時複数account実行はできない
- credential抽出、managed→host移管、OAuth refresh endpoint / schema / rotationは公式external token契約の外にある非公開依存で、最大の残存リスクである
- installed version fixtureと合わない場合は推測で追随せず、認証gateを`unready`にして方針を再評価する
- 共有`CODEX_HOME`をCLI / VSCodeと同時利用する既存のsession / SQLite競合は、この認証設計の対象外として残る
- 初回登録processからcanonical storeへの変換はCodexの保存schemaに依存する。version fixtureによる固定は将来対応とする
