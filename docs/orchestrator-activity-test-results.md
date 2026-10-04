# オーケストレーター活動表示の実現性試験結果

2026-10-04。**候補経路は構築可能と確認した。製品への配線と UI 描画は未実装・未検証。** Codex native 子の自動 caller、実親、登録アイコン、子 tool の開始・終了を隔離した一つの試験で照合した。共有 bearer による本人認証と表示用 caller は別の値として扱う。

## 判定と範囲

| 要件 | 候補経路の根拠 | 製品配線 |
| --- | --- | --- |
| autoCaller | 二つの native 子が各自の `CODEX_THREAD_ID` を CLI の表示用 header に自動添付。sidecar fingerprint と起点接続の native `threadId` が一致 | CLI 原本と Runner の header 解釈は未変更 |
| childIsolation | 異なる二つの子 ID を実 `thread/read` で同じ親へ照合。二子は逐次実行 | 多数・並列子の実運用は未検証 |
| registeredParent | temp 公開 voice service の実 `onStarted`/`native_started` root と登録 ID/icon を照合し、両子が同じ登録に到達 | `server-runtime` の `onStarted` 配線は未実装 |
| childToolEvents | 起点 App Server 接続で両子の `commandExecution` start/end を同一 thread/turn/item で対合、双方 completed/exit 0 | 製品の活動 notification 配線は未実装。その他 tool type は合成正規化のみ |
| authorization | 実 Runner へ GET 200。既存 HTTP/WS service 境界で bearer、owner、workspace ACL、operation 再送を維持 | 表示 header の製品受信は未実装。共有 token 保持者による表示偽装の可能性があり、認可には使わない |
| lifecycle | 実 Agent Service と HTTP/WS transport の候補試験で開始、重なり、成功・失敗・中断、WS detach/resume、対象 card/global を確認 | 実 UI 上の表示と配送は未検証 |
| latency | 候補 in-process bearer→実 native parent RPC→登録 icon→開始/終了通知を 20 fresh と 1,000 warm で直接計測し暫定 p95 閾値内 | 実 HTTP 受信から UI 描画までの総時間は未測定 |

これは **Codex voice orchestrator を親とする Codex native 子**の候補証明である。対象セッションは caller と別キーで持てるため Codex/Claude card を表現できるが、Claude 自身を親とする native 子関係は試していない。二子は同一 root 内で A 完了後に B を実行した。並列の同時性は in-process 活動試験で検証した。

製品コード、外部 skill CLI 原本、共有 Runner の設定・logs/store、認証情報、既存ユーザー session は変更していない。実 GUI にアイコンが表示されるという主張はしない。

## 実 native 経路

`BITTY_ACTIVITY_EPHEMERAL_PROBE=1 node --test --test-name-pattern='opt-in ephemeral registered root and two native child CLI tools' private_runner/tests/orchestrator-activity-feasibility.test.mjs` は最終実行で **1 pass、0 fail**（37.7 秒）。temp の公開 `createVoiceOrchestratorService` にアイコン付き登録を作り、既存 App Server へ一つの ephemeral root turn を開始した。`onStarted` の実 thread/turn は同じ temp event file の `native_started` と一致し、root は ephemeral/pathless だった。`fork_turns:"none"` で順に起動した二つの default-role native 子も、実 `thread/read(includeTurns:false)` で別 ID・同じ root 親・ephemeral/pathless を確認した。LLM 引数や入力文に caller ID と親 ID を渡していない。

外部 `bitty-session.mjs` 原本は read-only で読み、一意の source anchor をメモリ内で変更した temp copy を実行した。各子の temp CLI は自分の `CODEX_THREAD_ID` を `x-bitty-display-caller` に付け、既存 localhost の **GET `/agent/workspaces` だけ**を実行した。二つの sidecar は異なる native 子 ID の fingerprint に一致し、各 GET は HTTP 200。CLI の実 token、workspace 本文、実 session ID は出力・保存していない。App Server の command item は確認済みの `/bin/zsh -lc 'node … workspaces'` という一段の shell wrapper を持つため、literal とこの exact wrapper の二形のみ受理した。両子の `item/started` と `item/completed` はそれぞれ同じ thread/turn/item ID、status completed、exitCode 0。起点接続の tool 正規化では `collabAgentToolCall` 二対と `commandExecution` 二対の計 8 event を得た。`thread/started` が子に配信されなくても、子の item/turn 通知にある ID を `thread/read` で照合できた。

最終試験に至る先行実行では、CLI の `workspaces` 引数欠落、root 専用指示の子への継承、子 thread context load 失敗（既定の full-history 読込みが一因だった可能性）、App Server command の shell wrapper を切り分けた。失敗実行を成功件数に算入していない。最終手順は temp 限定・120 秒上限、own root/確認済み子だけの中断、terminal 待ち後の temp cleanup とした。診断の短い応答抜粋は**この試験が新規生成した temp root の応答**だけであり、既存会話履歴ではない。

| 候補経路の同一試験内測定 | runs | p50 / p95 / max ms | 実 `thread/read` RPC | 活動通知 |
| --- | ---: | ---: | ---: | ---: |
| fresh local Map、bearer handler→親照合→icon→開始/終了 | 20 | 77.682 / 78.204 / 78.972 | 20 | 40 |
| warmup | 100 | 計時対象外 | 2 | 200 |
| warm cache、同じ in-process 経路 | 1,000 | 0.002 / 0.002 / 0.198 | 0 | 2,000 |

fresh は毎回**ローカル Map のみ**を新しくした。同じ App Server 接続と OS cache は warm のまま。20 fresh と 1,000 warm の失敗は 0、合計活動 start/end は 2,240 件。この測定は実 App Server RPC を含むが、実 HTTP 配送、実 Runner による表示 header 解釈、UI notification/render、provider/model 応答時間、公開 `ownsRequest` 閉包の初回全時間は含まない。候補総合の p95 は暫定目標 fresh ≤1,000 ms、in-process warm ≤100 ms を満たした。各成分の p95 を足した値ではない。後続の深さ1/3/10 cache 圧縮修正は、実測した深さ1の RPC 経路を変えない。深い実 native 親経路の遅延は別途測定が必要。

この試験では実 turn 後に `onStarted` root と登録 ID/icon の表示用 binding を組み立てて照合した。実 GET を受けた既存 Runner は header を解釈していない。認可→実 RPC→候補通知の合計も turn 後の in-process handler で測り、製品の実時間配送や初回イベント順序は実証していない。

## 公開境界と通常試験

`node --test private_runner/tests/orchestrator-activity-feasibility.test.mjs private_runner/tests/orchestrator-activity-candidate.test.mjs private_runner/tests/orchestrator-activity-bench.test.mjs` は最終実行で **19 pass、0 fail、3 opt-in skip**（top-level と subtest 合計 22）。通常実行は既存 App Server・Runner への新通信をしない。

公開 `createVoiceContextService` を fake native client で駆動すると、`ownsRequest` は深さ 1/3/10 に対し初回 `thread/read` を 1/3/10 回、同じ子の再要求を 0 回にした。深さ1では別の C1/C2 も照合した。親欠落、循環、応答 ID 不一致は拒否。test-local 候補 cache も深さ 1/3/10 の成功経路だけ圧縮して warm RPC 0、11段・親欠落・循環・ID 不一致を unknown とし、登録削除後に古い icon を使わない。これは実 native 深さ10の遅延計測ではない。

実 `createAgentHttpHandler` は無効 bearer を 401 にし、有効 bearer の body/query に偽 caller を入れても既存 context は `subjectId` のみ。試験内表示 header が変わっても Agent Service の owner と workspace admission は変わらず、別 scope を拒否し、同一 operation ID 再送は二重 run にしなかった。実 `createAgentWsConnection` と Agent Service の候補経路は、二活動・tool 逆順・失敗/中断・WS detach/resume を正しい run/tool ID に保持し、実 `turn.start` の `sessionRef` は card、対象なしは global にした。target の backend/native ID は操作から取る。shell command 文から対象を推定していない。API と tool が同じ実動作であるとの相関は観測されず、重複抑制は未検証。

tool 正規化の合成試験は既存の `commandExecution`、`fileChange`、`mcpToolCall`、`dynamicToolCall`、`collabAgentToolCall`、`webSearch`、`imageView` の七種類を thread/turn/item キーで区別し、reasoning/message 等四種類を除外した。実 native 実行したのは command と collab tool のみで、他 tool を実行したとは言わない。

公開 `createVoiceOrchestratorService` の合成 A→B→A root rotation では各 `native_started` と登録 ID/icon が一致。公開 `status` は native ID を返さないため、製品 runtime に hook 配線が必要。voice root observer は子の agentMessage と item を root 応答から除外する。子 tool を表示する候補は、開始元 App Server 接続の別 raw notification tap を使った。

既存 regression は `agent-transport.test.mjs`、`agent-workspace-admission.test.mjs` の合計 **16 pass/0 fail**。先行確認の voice-context 選択 4 件、codex-turn 選択 3 件も 0 fail。これらは製品表示の実装完了を意味しない。

## 合成 Codex index と read-only 比較

既存 v4 index を合成ファイルから読む `createLlmCliSessionIndex` と `selectCliSessionIndexEntryBySessionId` は、N=100/1,000/5,000、深さ1/3/10で各100 warmup・1,000 warm・新 instance 20 cold を測った。最終通常実行の値を示す。OS cache cold ではない。全 warm の `readdir/stat/readFile/threadReadRpc` は 0、各 cold 20 は `readFile=20`、失敗0。これは index メモリ内 select のみで、rollout scan、Claude transcript、実 native 親照合、HTTP、活動通知を含まない。

| N | 深さ | warm p50/p95/max ms | app cold p50/p95/max ms |
| ---: | ---: | ---: | ---: |
| 100 | 1 | .002 / .003 / .377 | .236 / .338 / .786 |
| 100 | 3 | .002 / .002 / .008 | .180 / .306 / .335 |
| 100 | 10 | .006 / .006 / .149 | .162 / .298 / .357 |
| 1,000 | 1 | .006 / .007 / .008 | 1.085 / 1.559 / 1.807 |
| 1,000 | 3 | .018 / .018 / .024 | .969 / 1.126 / 1.138 |
| 1,000 | 10 | .059 / .063 / .094 | 1.026 / 1.157 / 1.230 |
| 5,000 | 1 | .033 / .039 / .048 | 5.012 / 5.795 / 6.971 |
| 5,000 | 3 | .093 / .098 / .122 | 4.963 / 5.145 / 5.272 |
| 5,000 | 10 | .304 / .319 / .376 | 5.532 / 6.792 / 6.918 |

`select` は祖先の各段で全 entry を線形走査する。この index を製品の親判定 hot path に採用する場合だけ、検索形状を改善して再計測する。今回の native 候補は App Server `thread/read` を使い、この index を親探索に採用していない。

既存 shell 観測の SHA-256 先頭12桁では親 THREAD `5727b7841f98`、子1 `a4abd1e36379`、子2 `21539f4d3a6b` と異なり、SESSION は三者とも親値だった。read-only App Server probe は親/二子の実 thread ID と親 metadata の対応を確認。子2の同一接続 read20回は p50/p95/max .417/.633/.838 ms、別の fresh local Map20回（子→親→root、計40RPC）は .878/.922/.928 ms。これは上の候補総合測定と別の試験・別の時点であり、数値を足していない。

CLI 単独 opt-in probe はインストール済み原本をメモリ内だけで変更し、隔離子 Node から実 GET 200、表示 header と環境 THREAD の一致、既存 handler で owner 固定と無効 bearer 401 を確認した。製品 Runner は現状その header を解釈せず、共有 bearer の別 client による header spoof は表示上のリスクとして残る。表示帰属を本人認証・ACL に流用しない設計条件である。

```json
{
  "candidateBuildable": {
    "autoCaller": "pass", "childIsolation": "pass", "registeredParent": "pass",
    "childToolEvents": "pass", "authorization": "pass", "lifecycle": "pass", "latency": "pass"
  },
  "productWired": {
    "autoCaller": "unverified", "childIsolation": "unverified", "registeredParent": "unverified",
    "childToolEvents": "unverified", "authorization": "unverified", "lifecycle": "unverified",
    "latency": "unverified", "uiPlacementAndRendering": "unverified"
  }
}
```

次の製品実装に必要なのは、CLI の表示用 header 自動添付、認証済み Runner request での**表示専用**受信、voice `onStarted` と登録 ID/icon の対応、native 子通知の購読と lifecycle、対象 card/global への UI 配送である。個別 credential、新しい認証 owner、新 API、汎用 parent index はこの試験からは必要と示されていない。
