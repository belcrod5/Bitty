# 参加者プロフィールを共有した逐次会話実験

実施日: 2026-10-28。GPT-6 Luna / lowで架空の3ケースを各1回実行した。27手番すべてcompleted、全ケースが9手番上限で終了した。全員見送りによる終了ではない。

既存2ケースでは私的背景の公開や他者案の採用が見られたが、明示的な他者指名は出なかった。分担相談を追加した第3ケースでは担当訂正・名指し・自己引受が出た。未知の専門性の自律発見や、自律dispatchを示した結果ではない。

[設計書](ORCHESTRATOR-COLLABORATION-DESIGN.md) / [前回の通常文版](ORCHESTRATOR-COLLABORATION-PLAIN-TEXT-EXPERIMENTS.md) / [実験driver](../private_runner/scripts/evaluate-orchestrator-conversation.mjs)

## 条件と配送監査

- Luna low、固定順A→B→C→A、通常文・完全一致 `[[PASS]]`、最大9手番、各45秒、終息指示、差分配送を維持した。新しいロスターschemaや制御routerは作っていない。
- release/incidentは元の問い・personas・本人だけの背景を維持し、問いの末尾に全員既知の得意分野と現在担当だけを追加した。第三は専門性・稼働制約を示し、誤った担当仮案を含む分担相談にした。特定の指名・立候補発言を強制していない。
- 旧incidentのB2/C3には元質問とA1全文328字が差分入力に含まれていた。私的背景も各本人のdeveloperInstructionsとしてthread/startへ渡す経路を確認した。送信コードはpayloadをJSON.stringifyしてWebSocketへ送り、会話本文の意味を加工しない。監査では配送漏れの痕跡は見つからなかったが、モデルの認知・採用は保証しない。
- 今回は全員の初回入力にプロフィールを含む元質問が入り、3distinct thread・ABC順・本人限定の背景・差分と自己出力除外・実報告Luna lowを確認した。実際の本人メモリは読み込んでいない。
- driver SHA256は `ff2c2b21879584bb867220e1789e595be9a682187cbdccea833f681a29bb46d8` のまま。再起動・再試行・旧記録の変更は行っていない。

## 使用量と終了

| ケース | 発言／見送り | 終了理由 | 全体秒 | 入力token | 出力token | キャッシュ入力 | total |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| incident-uncertainty-team-aware | 8／1 | turn_limit | 26.542 | 93,047 | 1,309 | 61,312 | 94,356 |
| release-tradeoff-team-aware | 6／3 | turn_limit | 23.748 | 91,624 | 944 | 73,600 | 92,568 |
| expertise-routing | 6／3 | turn_limit | 24.380 | 92,745 | 921 | 48,128 | 93,666 |
| 合計 | 20／7 | 全27手番completed | 74.670 | 277,416 | 3,174 | 183,040 | 280,590 |

各thread累計の前回との差分を合計した。キャッシュ入力は入力の内数で加算しない。reasoning出力は全件0。全体秒は初期化等を含む。金額は推測していない。

## 原文抜粋と観察

incident B2:

> 直前のdeployにレスポンス整形の変更が含まれているので、その差分でDB問い合わせ数や取得量が変わっていないかを、該当APIの経路に沿って確認します。

incident C3:

> 遅いSQLの記録は数件だけで通常時の基準もないため、現状ではAPI遅延との対応を示す根拠としては不十分です。

release A4:

> DB移行の復旧手順が未検証なら、限定公開でも新機能とDB移行は見送るべきです。

expertise A1:

> 担当案は、14時からCが再現条件と比較計測の準備を進め、15時以降にBが実装と再送処理の一意性を調べる形に調整します。

expertise C3:

> 14時からは、私が既知の入力条件や比較項目を整理し、15時以降にBから実装上の再送条件や保存境界を受け取って検証に入ります。

expertise B5:

> 再送の一意性と保存境界は、私が15時以降にコードで確認します。

incidentでは前回見送られたBのレスポンス整形変更、CのSQL通常基準不足が今回は発言された。B2の「確認します」は本人の調査予定で、他者への名指し依頼ではない。反復もあり、9手番で全員見送りには至らなかった。

releaseではCのDB復旧未検証という背景がAへ反映されたが、明示的な他者指名・立候補は見られない。A4は作業者1名なのに「並行して」と述べ、4時間の作業配分も具体化していない。

expertiseではCへのコード原因調査・Bへの再現試験という仮案を、既知の専門性に合わせて訂正し、C/Bが「私が」と引き受けた。既知プロフィール・担当への役割調整であり、全く新しい任務への自発的立候補を証明したものではない。「私が得意」という表現や、ツールによる自律的な実作業開始はない。

## rawと限界

- [incident-uncertainty-team-aware の全会話・入力・指示・usage](ORCHESTRATOR-COLLABORATION-TEAM-AWARE-incident-uncertainty.json) / [fixture](../private_runner/scripts/fixtures/orchestrator-conversation/incident-uncertainty-team-aware.json)
- [release-tradeoff-team-aware の全会話・入力・指示・usage](ORCHESTRATOR-COLLABORATION-TEAM-AWARE-release-tradeoff.json) / [fixture](../private_runner/scripts/fixtures/orchestrator-conversation/release-tradeoff-team-aware.json)
- [expertise-routing の全会話・入力・指示・usage](ORCHESTRATOR-COLLABORATION-TEAM-AWARE-expertise-routing.json) / [fixture](../private_runner/scripts/fixtures/orchestrator-conversation/expertise-routing.json)

rawは原本のbyte完全コピーで、会話全文はそこから確認できる。同じモデルで各1試行しかなく、前回との差がプロフィール共有によるものか、モデル出力のばらつきかは切り分けられない。モデルの弱さが原因かどうかも判定できない。第3ケースには分担相談という促しもあるため、既存2ケースと同じ条件で自発性を比較できない。

担当案への言及は実行結果でもユーザー承認でもない。十分な相談・正しい判断・収束を保証せず、既存本人・長期メモリ・製品UI・障害復旧は未検証である。製品は未実装。今回の結果だけを理由に手番を指名方式へ変えたり、新しいロスター抽象・制御routerを追加したりしない。
