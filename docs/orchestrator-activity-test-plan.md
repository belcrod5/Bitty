# オーケストレーター活動表示の実現性・遅延検証計画

## この段階の成果物

この文書は、最小の独立した試験とその判定基準を記す。実施した範囲と未検証 gate は[試験結果](orchestrator-activity-test-results.md)に記録する。製品コードと UI は変更していない。
最初に証明するのは、skill の HTTP 呼び出し元である**ネイティブセッション**を、LLM が ID を引数へ書かずに取得できるかどうかである。
取得した呼び出し元から親をたどり、登録済みオーケストレーターを特定して、そのアイコンを活動表示へ渡す。
対象セッションは操作ごとに別途決まる。呼び出し元と対象を混同しない。

候補経路の実現性と、稼働製品への配線状態を別々に判定する。前者には実ランタイム由来の子別 ID、登録親、子 tool 通知、認可を維持した活動経路の証拠が必要である。モックだけの成功は実ランタイムの代わりにしない。
画面上の実際の描画品質はこの試験の判定外とし、未検証と明記する。

| 目的 | 候補経路で証明すること | 製品配線で別途確認すること |
| --- | --- | --- |
| 子別 caller | native 子自身の `CODEX_THREAD_ID` を CLI 引数に渡さず表示用 header に自動添付し、実 native event の ID と照合 | インストール済み CLI と認証済み Runner HTTP がその header を表示専用に扱うこと |
| 登録親と icon | temp の公開 voice service が記録した実 `native_started` root へ、子の実 `thread/read` 親経路が到達し、登録 ID/icon を選ぶこと | Runner runtime が同じ hook と通知を常時接続すること |
| tool と活動 | 開始元 App Server 接続で子の同一 thread/turn/item の開始・終了を受け、対象別活動へ渡せること | 製品の通知・状態管理と実 UI 描画、終了処理 |
| 認可と遅延 | 既存 bearer・owner・ACL/idempotency を変えず、候補経路の I/O/RPC と時間を測ること | 実 HTTP 受信から表示までの総合遅延と運用負荷 |

## 確認済みの現状と変えない境界

- [`agent-transport.mjs` の HTTP 認証](../private_runner/src/agent/agent-transport.mjs#L19) は共有 `RUNNER_TOKEN` との比較である。
- [`agent-runtime.mjs` の owner subject](../private_runner/src/agent/agent-runtime.mjs#L69) は `sha256(runnerToken)` から一つ作られる。セッション別の認証 ID はない。
- skill CLI `bitty-session.mjs` は同じ bearer を HTTP と Runner WebSocket に送る。現行の CLI 引数には呼び出し元の識別情報がない。
- Codex 認証プロファイルの既存 `authId` は OAuth 認証プロファイル識別子であり、表示用 caller ID とは別物である。
- owner subject、workspace ACL、session binding/lease、operation ID は既存の認可・再実行制御である。活動の帰属をこれらへ代入せず、既存の許可・拒否結果を維持する。
- `voice-orchestrator-service.mjs` の登録 ID・アイコンと、`voice-context-service.mjs` の logical conversation ID、Codex の native `threadId` は別物である。会話や thread の切替にも対応付けを検証する。
- [`llm-session-metadata.mjs`](../private_runner/src/llm-session-metadata.mjs#L1) は `parent_thread_id` または `forked_from_id` を読む。後者だけで「信頼できる子エージェント」と確定しない。
- Runner 管理 turn の tool 通知だけでは native 子 turn の全 tool イベントは見えない。
- [`voice-context-service.mjs` の `ownsRequest`](../private_runner/src/voice-context-service.mjs#L607) は fresh ephemeral root の `threadId` を起点とし、未知の子を `thread/read` の `parentThreadId` で順に照合する。成功した経路は `ownedThreads` に保持する。これは実際の親照合経路として試験する。
- 同ファイルの `observe` と managed dynamic tool は root の turn identity で絞る。承認経路で子の所有を確認できても、子の全 tool notification が表示用に得られるとは限らない。

## 想定する最小境界

候補の表示用 caller は、native Codex 子プロセスが持つ `CODEX_THREAD_ID` を CLI が HTTP header に自動添付した `{ backendId, nativeSessionId }` とする。既存 bearer は本人認証と owner 判定に使い続ける。
LLM の tool 引数、入力文、HTTP body/query の自己申告 ID、親セッションの継承環境変数は証拠にしない。
HTTP/WS の既存共有 token を個別 owner subject に置き換えたり、認可を緩めたりしない。
表示用 caller がない場合は帰属を「不明」とし、既存の許可された操作を帰属失敗だけで拒まない。共有 bearer を持つ別 client は header を偽装し得るため、表示用 caller を ACL や本人確認に使わない。

照合キーは常に `{ backendId, nativeSessionId }` とする。
登録済みオーケストレーターの ID と、その時点の native session の対応は実際の `native_started`/runtime identity から確認する。
子セッションの親がその native session へ届いた時だけ登録アイコンを選ぶ。
循環、欠落、未登録、曖昧な対応は推測でアイコンを選ばない。

活動の表示先は操作の**対象**で決める。
対象セッションの個別操作なら、そのセッションの右上へ付ける。
セッション一覧、board、その他グローバル操作なら、viewport 固定 overlay に出す。
各活動には caller、target または global、orchestrator/icon、run/tool ID、状態、開始・終了時刻を持たせ、複数の同時操作を潰さない。

## 試験 0: native caller と登録親の実証

既存親 P と二つの独立 native 子 C1/C2 の shell 環境値を、値を出さず fingerprint で比べる。`CODEX_THREAD_ID` は子ごとに変わり、`CODEX_SESSION_ID` は継承されるため、候補には前者だけを使う。既存 App Server の `thread/read({includeTurns:false})` で実 ID・親を検証し、LLM の入力や tool 引数で ID を渡さない。

候補 CLI はインストール済み原本を read-only で読み、一意な anchor をメモリ内で変更した temp copy を実行し、native 子の `CODEX_THREAD_ID` を `x-bitty-display-caller` header へ添付する。既存 localhost Runner への `GET /agent/workspaces` だけを許し、token・本文・path・実 ID は出力しない。この header は表示用 annotation であり、既存 Runner はまだ解釈しない。偽 header を本人認証や ACL に使わないことも試験する。

限定した temp voice orchestrator の公開 `start` を既存 App Server 上で実行する。実 `onStarted` と temp `native_started` の root thread/turn を照合し、二つの default-role native 子が実行した CLI の環境 ID fingerprint を開始元接続の native thread metadata と比較する。子は `fork_turns:"none"` で A 完了後に B を起動し、ephemeral 親の full-history 読込みを避ける。各子の実 `thread/read` 親経路が同じ temp 登録 root に届き、同じ ID/icon を選ぶことを確認する。root と子は ephemeral、path は null でなければ中止する。通知と CLI sidecar は metadata・fingerprint のみ保持し、temp 領域を片付ける。

子 tool の `item/started` と `item/completed` は、同じ child `threadId`、`turnId`、`item.id`、tool type、成功結果の対で照合する。開始元接続で観測したイベントだけを証拠にし、別接続の受動観測で通知が来なかったことから native event の不存在を推測しない。起動通知と hook の順序で早着するイベントは後処理で照合し、製品の実時間 queue 配線とは区別する。

実証に失敗した箇所は `unverified` または `fail` として件数と理由を記録する。試験内の temp 登録を製品 Runner の登録配線の証拠にはしない。製品 session への turn、server 起動・再起動、build、共有 logs/store への書込み、認証設定変更は行わない。

## 試験 1: 親照合・認可・表示先（既存境界と候補）

公開 `createVoiceContextService` の `ownsRequest` を fake native client で駆動し、root の子 C1/C2、深さ1/3/10、親欠落、循環、応答 ID 不一致を確認する。初回は深さ D の RPC、成功後は0 RPCを期待する。別の test-local 候補照合は実 App Server の親 metadata と temp 登録 root を使い、未登録・backend 衝突・登録解除後の古い icon を unknown とする。temp 登録の成功を製品 Runner の配線済み証拠にはしない。

既存 `createAgentHttpHandler`、`createAgentWsConnection`、`createAgentService`、workspace admission を in-process で使う。認証済み subject、owner、ACL、operation 再送の結果が表示用 caller header で変わらないことを確認する。body/query の偽 caller や無効 bearer から活動を作らない。表示用 caller が欠けるか不明なら icon は unknown とし、既存の許可結果を変えない。

対象が sessionRef を持つ操作はその card、対象のない操作は global とする。HTTP と WS の target は実 request の情報から決め、shell command の文字列を解析しない。異なる caller の同時活動、開始・終了の逆順、失敗・中断、WS 切断後の継続、terminal cleanup を候補状態で確認する。実 UI の右上配置と overlay 描画は後続の製品確認に分ける。

子 tool は開始元 App Server 接続で `threadId`/`turnId`/`item.id` の開始・終了を実観測する。既存の tool type を test-local 正規化で扱い、message/reasoning を tool に数えない。実 tool 実行と派生 API 活動の重複相関は観測していないため、時間の近さだけで抑制しない。

## 試験 2: 比較用 index 測定

合成した Codex v4 index を既存 loader/module で読む。N=100/1,000/5,000、深さ1/3/10の warm/cold lookup 時間と `readdir/stat/readFile` 回数を記録する。この index は採用した native 親探索ではない。この index を製品の親判定 hot path に採用する場合だけ、祖先各段の全件走査を改善して再計測する。

Claude transcript loader、Claude native 子、`voice-subagents` の管理委任は今回の Codex voice 親候補とは別経路であり、この候補の合否要件にしない。将来その経路の活動帰属を実装する際に別途照合する。

## 試験 3: 遅延と I/O

合成・in-process 測定は Node の標準組込みだけを使い、外部 package・network・install を使わない。
実 runtime probe に限り既存 Runner のローカル HTTP と既存 native RPC を使う。新しい listen port、server 起動・再起動は行わない。
時間は `performance.now()` で次の四区間に分ける。

1. 自動 caller 取得＋認証照合。実 runtime probe の初回 binding 取得も別測定する。
2. metadata load。新しい loader instance を使う初回を「アプリ cold」と呼び、OS cache の cold とは主張しない。
3. 親探索。1/3/10 段、N=100/1,000/5,000 セッションの合成 corpus を用いる。
4. 認証＋親探索＋活動 notification の in-process 合計。provider/model の応答待ちは含めない。

`ownsRequest` の native 経路は別系列にし、初回の深さ D の `thread/read` 直列 RPC と、成功後の Set hit を分ける。
fake client の制御遅延はアルゴリズムの費用確認に限り、実 RPC の速度として報告しない。
既存稼働ランタイム上の限定 probe で実 RPC 時間を測る。
`ownsRequest` の `ownedThreads` は公開 reset 口のない `open` 内の閉包である。実測の fresh 20回は test-local 候補 cache の初期化であり、公開閉包の20回初回ではない。
20 回の provider turn/session を新設する要件ではない。`thread/read` だけの直列 RPC 計測は参考成分であり `ownsRequest` 全体の実測ではない。候補 helper の20回の fresh 局所 cache 探索と実 RPC を含む認証・親照合・通知の総合時間を候補 latency gate とする。公開 `ownsRequest` 閉包の初回全時間は別の未検証成分として報告する。
製品側へ reset API を追加せず、観測数と個々の時間を報告する。
この「初回」は lookup cache の初回であり、OS cache が冷えているとは主張しない。

warm は各組合せで 100 回 warmup 後 1,000 回。cold は新 instance 20 回。
N=5,000 は stress 値として別に表示し、実運用のセッション数と混同しない。
各区間の `runs, p50, p95, max, failed, readdir, stat, readFile, threadReadRpc` を出す。
失敗を統計から黙って除かず、失敗数と原因を残す。測定値を作り話で埋めない。

暫定の工学目標は通常規模 N≤1,000 の warm 親探索 p95≤10 ms、in-process 合計 p95≤100 ms、実 RPC を含む最初の関係取得 p95≤1,000 ms。
これは観測結果ではなく、UI 応答を議論するための仮定である。
初回取得は各 HTTP 呼び出しへ繰り返し課さない想定が成立するか、I/O と RPC 回数で確認する。
warm lookup の filesystem 呼出し 0 を目標にする。Codex index を親判定 hot path に採用する場合は、親一段ごとの全件 scan も解消する。
超過したら latency gate は fail とし、数値と原因を報告する。必要な既存境界の簡素化後に同条件で再測定する。

## 最小の実装範囲と報告形式

試験ファイルは `private_runner/tests/` の独立した `node:test` に収める。
必要な試験専用の薄い fixture はファイル内に置き、汎用 utility、新 API、credential 管理、DB、background worker は作らない。
既存 module と実ランタイムの照合口を用い、mock 合格だけを実現性合格に昇格させない。

実装・実行したコマンド:

```sh
node --test private_runner/tests/orchestrator-activity-feasibility.test.mjs private_runner/tests/orchestrator-activity-candidate.test.mjs private_runner/tests/orchestrator-activity-bench.test.mjs
```

通常試験に加え、既存 App Server の read-only metadata probe、既存 Runner への CLI GET probe、隔離した ephemeral native turn はそれぞれ明示 opt-in で実行する。

```sh
BITTY_ACTIVITY_LIVE_PROBE=1 node --test --test-name-pattern='opt-in read-only App Server native ancestry probe' private_runner/tests/orchestrator-activity-feasibility.test.mjs
BITTY_ACTIVITY_CLI_PROBE=1 node --test --test-name-pattern='opt-in installed CLI display-caller annotation candidate keeps Runner ownership fixed' private_runner/tests/orchestrator-activity-feasibility.test.mjs
BITTY_ACTIVITY_EPHEMERAL_PROBE=1 node --test --test-name-pattern='opt-in ephemeral registered root and two native child CLI tools' private_runner/tests/orchestrator-activity-feasibility.test.mjs
```

試験の JSONL 行は各成分の件数、p50/p95/max、I/O/RPC 回数、fixture 規模を出す。七 gate の `candidateBuildable` と `productWired` は[試験結果](orchestrator-activity-test-results.md)の JSON summary で分ける。測定できなかった runtime event の照合方法と理由も同文書に記す。
認証秘密、会話本文、実ユーザーの session ID は記録しない。

候補経路の実現性は上表の実 runtime・公開 service・実 transport 成分で判定する。製品への着工・配線済み判定は別に残し、実 runtime の auto caller・子別識別・登録親対応・子 tool event、認可・lifecycle・latency の gate を個別に記録する。
latency は実測値が上の暫定目標を満たすか、測定後に明示的に合意した改訂目標を満たすことを要する。
一つでも fail なら原因を修正して再試験し、unverified は製品配線または描画の残課題として明記する。
UI の実描画と実機での位置・重なりは後続の UI 検証項目として残す。

合成境界試験、Codex index lookup、実 App Server の `thread/read`、原本を変えず temp copy で実行した CLI の実 GET、temp 公開 voice service の実登録と二つの native 子 tool stream を試した。候補の成立と製品配線の区別は[試験結果](orchestrator-activity-test-results.md)を参照。製品化時は root の `turn/start` 前に raw listener を装着し、`onStarted` 登録前に届くイベントを保留して後から分類するか順序を保証する。子の `thread/started` 通知に依存せず、早着した child item/turn の ID を `thread/read` で親照合する。
