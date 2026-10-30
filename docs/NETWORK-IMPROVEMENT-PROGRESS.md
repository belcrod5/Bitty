# 通信処理改善の進捗（PR #260 の残課題）

更新日: 2026-10-30
状態: 全残件のコード修正・関連自動検証・最終独立統合レビューAPPROVE。ユーザーの実機確認も完了。
進行方針（最新のユーザー指示）: 実機確認後、エージェントによるpush・PR作成・レビュー・マージを承認。
公開前の独立レビューとCIを確認してマージする。Runner切替の確認まではworktreeを保持する。
ブランチ: `fix/network-sync-upstream`
作業先: `/Volumes/SSD-500GB-SanDisk/work/bitty-worktree/fix/network-sync-upstream`
基準: `origin/main` / `3ebbd96`（[PR #260](https://github.com/belcrod5/Bitty/pull/260) マージ後）

## 目的と範囲

不要な取得・再同期・全量配信を、発生源の契約とライフサイクルで解消する。
画面ごとの抑制、追加キャッシュ、新しい設定・依存・抽象化で症状を覆わない。
今回の対象は PR #260 の次の4残件に限定する。全通信を際限なく最適化する作業にはしない。

| 残課題 | 確認済み | 未確定・次の確認 | 状態 |
| --- | --- | --- | --- |
| 大量HTTPの取得先と取得・再同期契機 | 認証対象CF originを計測の選択中Runner originとしても使用し、local接続時に同RunnerのHTTPがother-originへ入る。draft保存POSTも全client-stateを返す | 分類とclient-stateの変更応答を修正。実機のother-origin内訳はユーザー確認時に再測定 | 実装・自動検証・独立再レビューAPPROVE |
| 一覧・子一覧の遅延 | 全item/completedが子一覧refreshを起こし、全cursorを再取得する。約16分の子一覧成功応答記録は計114.6MB（展開後） | 子関係・状態の変更をadapter境界で正規化し、必要親だけ更新。通常item完了時の再列挙を削除し、ready世代で回復 | 実装・自動検証・独立再レビューAPPROVE |
| 相談機能の全量配信 | 保存ごとに全room、progress更新ごとに累積live状態を全Runner WS接続へ配信する | 購読接続・選択roomへ限定し、一覧summaryと追記progressを配信。旧consumer互換・同期順序を検証 | 実装・自動検証・独立再レビューAPPROVE |
| 同条件の効果比較 | HTTP圧縮とWS圧縮交渉は既対応。WSアプリ計測は展開後bytes | 同じ合成操作で比較済み。Cloudflare経由と実機総通信量はユーザー確認時に測定 | 合成比較済み、実機待ち |

## 調査開始時の経路と既存対策

- HTTP: `cloudflareAccessFetch.ts` → 各Runner HTTP入口 → 共通JSON応答（gzip）。
  `networkUsageMetrics.ts` の分類は選択中Runnerと異なるoriginを一括している。
- client-state: `useRunnerClientState.ts` → `requestRunnerClientState` → `/client-state` → store。
  draftは300ms後に保存、状態再取得は定期poll・foreground・接続経路切替でも起きる。
  GETはETag再検証、POSTは全snapshot応答。
- 一覧: `useDirectorySessionTreeController.ts` / `useLlmSessionExplorer.ts` → Agent WS →
  `agent-service.mjs` → 各backend。summary欠損時のみHTTP補完。
- 再同期: `resumeSync.ts` とready/relay-loss controllerに合算rate制御と世代単位の制御がある。
  履歴cacheとsinceCursor差分取得も存在する。古い8月計画の「未着手」を現在の残件として扱わない。
- 相談: `voice-consultation-service.mjs` の保存・progress通知 → `server-runtime.mjs` のbroadcast →
  `VoiceConsultationScreen.tsx`。画面で購読を解除してもサーバーの全接続配信は続く。

## 根拠と修正単位

進行順: 子一覧の発火契約 → client-stateの変更応答 → 相談配信の購読・progress →
同条件の合成比較と統合レビュー。全てを同じworktreeで確認できるようにする。

### 第1段階: HTTP分類のorigin混同（修正済み）

`AppRoot.tsx` は実際のHTTPに選択中の`runnerUrl`を使う一方、
`configureCloudflareAccessFetch`へは`effectiveCloudflareRunnerUrl`を渡している。
fetchパッチがこの値をCF認証ヘッダーと計測の両方に使い、local接続時の取得先を誤分類する。
認証対象と計測対象をこの既存設定境界で明示的に分ける。
認証ヘッダーの送信範囲や通信処理は維持し、新しい利用者向け設定や計測基盤は作らない。
この変更単体は通信量削減ではなく、主因を特定できる状態へ直すもの。

### 第2段階: 子一覧更新の発火契約（実装・個別レビュー済み）

`useCodexReplyRequest.ts` と `useCodexRelayObserverStartController.ts` の
`item/completed` → `onSessionStreamBoundary` → `AppRoot.handleSessionStreamBoundary` →
`refreshSessionChildTreesAtBoundary(parent_progress)` → `fetchSessionChildrenHistory` が発火経路。
取得中にも完了イベントが来るとdirtyを記録して再取得し、各取得は全cursorを走査する。
同時要求の集約はあるが、子構造が変わったかどうかとitem完了を区別していない。

時間制限を画面へ追加せず、子の追加・状態変化をadapterで正規化して必要な親だけ通知する。
通常item完了からの再取得を削除し、通知を失う再接続時はloaded一覧を1回再照合する。
子条件の先頭pageでindexを最新化し、続きpageはそのscanを再利用する。
既存の`control.sessions_active_changed`はpayloadなしの全体無効化で、親子関係の構造変更を表さない。
その通知を全一覧再取得に結び直すだけではfan-outの移動になるため、流用は即決しない。
親条件はすでにサーバーのページング前に適用されているため、フィルター追加は再実装しない。
一覧titleにfirstUserMessageがそのまま入る構造もあるが、観測した大きさの内訳は未計測。
追加の全consumer調査でAgent.titleは表示専用、履歴・prompt・検索本文には使われないと確認。
既存Claude/storeのtitle上限とExpo表示は200字で、Codexだけ一覧titleへ全文が流れている。
既存`withClientTitles`でoverride選択後に同じ空白正規化・Unicode200字表示契約を適用する。
これは任意のpayload制限ではなく表示用title契約の上流修正。native先頭発言・履歴本文は保持する。

### 他の候補の優先度

client-state全量応答と相談全接続配信は構造確認済みだが、今回観測した通信の主因として未確定。
ユーザー指示により、この2つも既存境界で根本原因を修正してからまとめて確認へ進む。
更新の鮮度・複数端末・初回/再接続同期・旧クライアント互換を保つ。
合成データで同じ操作の要求回数・転送本文量を比較し、実機由来の主因判定とは区別する。

### 第3段階: client-stateの変更に比例する応答（実装・個別レビュー済み）

調査時点のstoreは約470KBで、sessions約451KB/4,928件、drafts約8KB/9件。
小さいdraft変更でも無関係なsession全件を返す契約が過剰転送の発生源。
storeの同じ直列化mutation内で変更前・変更後・変更fieldを確定し、
要求の既知content ETagが変更前と一致する場合だけ変更fieldを応答する。
revisionだけの比較は同revisionのstore復元を見逃すため採用しない。
他端末の先行変更や旧clientには全snapshotを返す。clientの不正差分回復はGETで行い、
受理済みPOSTを再送してcomposerHistory等を重複させない。
汎用再帰diffではなく既存operationのdomain変更結果を使う。

### 第4段階: 相談の受信者とprogress（実装・個別レビュー済み）

旧clientも画面の初回list要求で購読開始できるため、画面を開いていない接続への配信を除ける。
新clientは購読leaseを持ち、画面を閉じたら解除し、詳細は選択roomへ限定する。
旧clientには既存fullイベントを維持し、新clientだけ小さいprogress追記差分へ移る。
textの累積全文を毎回送り直す方式にはしない。初回・再接続snapshotと通知の逆順、
run/generation/seq不一致・欠落時の再同期、speech受信者を確認する。
保存roomの汎用patch基盤は増やさず、必要な詳細snapshotの配信先を絞る。

## 観測メモ（原因確定・効果比較ではない）

保持中のclient_auto_logs 10ファイルを読み取り専用で集計した。
新しいHTTP分類のsnapshotは43件、記録範囲は2026-10-30 06:33:18〜07:52:38 UTC。
同じ`sinceMs`の起動区間内で最初と最後の累計差分を取る。累計値は足し合わせない。

例: 07:33:13〜07:49:38 UTC の21 snapshotの区間:

| 受信分類 | 差分bytes |
| --- | ---: |
| HTTP other-origin | 29,485,032 |
| HTTP client-state | 107,781 |
| HTTP session-summaries | 7,281 |
| HTTP other | 230,017 |
| Runner WS（展開後payload） | 120,189,945 |

同時間帯の診断イベントは子一覧取得start 158件、一覧送信762件。
子一覧doneも158件、成功応答344ページ、記録された応答JSON合計114,575,916 bytes。
全158件のbyte coverageはcomplete。同一親グループは5種類、取得回数は76 / 35 / 23 / 17 / 7。
最大の子一覧1取得は2,350,466 bytes、子一覧elapsed中央値429.5ms。
一覧送信イベント762件の内訳はagent.hello 403件とsessions.list 359件で、762回の一覧要求ではない。
上記120.2MBのWS累計差分と114.6MBの子一覧応答集計は計測時点・境界が異なるため厳密な構成比ではない。
イベントには欠落・間引きがあり、実要求総数や転送実測値とは扱わない。
選択中RunnerとHTTPの実際の宛先が違うと、client-state等もother-originに含まれる。
上記のclient-stateカウンタだけで寄与が小さいとは判断できない。
操作・端末・経路をそろえた比較ではなく、WS圧縮後の転送量もこのログからは分からない。
会話本文・URL・token等の個人情報はこの資料やfixtureへ転載しない。

## 進め方と完了条件

1. [x] 専用worktree作成、最新mainと既存対策を確認。
2. [x] PR #260 の4残件に範囲を固定し、確認済みと仮説を分ける。
3. [x] 主要な取得・再取得・配信契機を対応づけ、計測で区別できない箇所を特定。
4. [x] HTTP分類のorigin混同を既存の共通境界で修正し、local/CFの合成操作で再現・回帰検証。
5. [x] 根拠のある通信削減の原因単位で修正。互換性・同期の鮮度・再接続回復を維持。
6. [x] 全実装の関連テスト・型チェック・合成比較・各領域の独立再レビュー。
7. [x] 実機確認用のworktree初期化（env、両node_modules、iOS workspace/Pods、共有Runner token）。
8. [ ] 下記手順で実機比較を実施し、結果を記録する。
9. [x] 最終統合レビューAPPROVE。実機確認コマンドを提示し、全修正をローカルコミットへまとめる。

各残課題は「原因特定・修正済み」「測定で問題を確認できず」「実機検証待ち」のいずれかと、
根拠・次の操作を残す。根拠がなければ推測のruntime変更をしない。
実機比較が残る段階で通信改善全体を完了扱いしない。
新たな無関係の最適化は今回へ追加せず、必要なら別件として記録する。

## 変更・確認履歴

- 2026-10-30: 専用worktreeと進捗資料を作成。既存の通信設計・直近診断メタを調査。
- 2026-10-30: `AppRoot.tsx` と `cloudflareAccessFetch.ts` の設定で認証対象と計測対象を分離。
  既存の認証consumerテスト3ファイルを新しい明示設定へ更新し、fetch境界の回帰検証を追加。
  新しいカテゴリ・ラッパー・利用者向け設定・依存は追加していない。
- 修正担当の確認: Expoで次を実行し、5 suite / 102件成功、失敗・skipなし。
  `npm test -- --runInBand src/features/app/utils/cloudflareAccessFetch.test.ts src/features/ws/networkUsageMetrics.test.ts src/features/app/ttsAudio.test.ts src/features/app/utils/runnerFileResources.test.ts src/features/app/screens/ChatScreen.autoRecordingPanel.test.tsx`
- `npm run typecheck`、`npm run typecheck:macos`、`git diff --check`: 成功。
  既存のSafeAreaView非推奨warningあり。Runnerはコード変更なしのためテスト未実施。
- 独立レビュー: APPROVE、必須指摘なし。関連Jest 3 suite / 35件とdiff checkを独立再実行して成功。
- 実機準備: 初回bootstrapでExpo依存の初期化がローカルnpm cacheのEPERMにより停止。
  mainと同一package/lockの既存依存をworktreeへコピーして復旧。`npm ls --depth=0`成功。
  bootstrap再実行でenv・Runner依存・Expo依存・iOS native/Podsを準備し、共有token存在確認も成功。
  mainの追跡ファイル変更なし。Runner再起動・実機ビルドは代行していない。
- 第1段階の実装コミット: `6b0fd22`。通常pushは自動承認レビューで拒否されたため未push。
  理由は公開リポジトリへ今回のコード・調査メタ情報を公開する明示承認の不足とremote信頼未確認。
  その後の読み取りでoriginがユーザー指定と同じ`belcrod5/Bitty`（PUBLIC）であることを確認した。
  明示公開承認の条件は残るため再pushしていない。PR未作成、CI未開始、mainマージ未実施。
- 実機・CF経由・総通信量の比較は未実施。
- 2026-10-30 ユーザー方針更新: 第1段階だけの公開をやめ、全残件を修正・自動検証してから
  ユーザー確認へ進む。pushはユーザー本人が行う。公開承認待ちは現在の作業を止める理由ではない。
- 子一覧・titleの実装担当確認: Node関連4ファイル168件、Jest関連3 suite 98件成功。
  通常100 item完了で親変更通知0、spawn/子完了・重複・逆順・別親receiver・再接続中の旧要求後fresh取得を検証。
  titleはsingle/all/batch・Unicode200/201字・override優先・履歴本文不変を検証。
  raw経路統合・合成WS比較・独立レビューは続行中。client-state/相談は設計済み・未実装。
- 子一覧の合成比較: 同じ10子・長い初期title・100無関係itemとspawn/完了で、
  102要求→2要求、展開後JSON 11,852,292→8,736 bytes、
  圧縮WS応答frame込みsocket bytes 67,695→608（handshake/TLS除外）。
  表示title一致・履歴本文不変を確認。これは合成fixtureの結果で、実アプリ全体の削減率ではない。
- 先行独立レビュー: CHANGES_REQUESTED（High）。新しい子通知直後でもCLI indexの5秒TTLで
  古い一覧を返し、その後通知がdedupeされて子が欠落し続ける窓を実index-backed fixtureで再現。
  子scope読取の正本鮮度を既存force-refresh境界で保証する修正・結合テストを追加中。
  client-stateは初版実装・未検証で一旦停止、先にこの指摘を解消する。
- 子一覧の先行指摘は3件を解消して再レビューAPPROVE。TTLは子条件先頭pageのみfresh scan、
  続きpageは再利用。turn完了hintとnative idleを区別し、一覧activity正本を更新してから通知。
  control.readyの対応イベント広告と旧Runner限定structural fallbackで混在versionの鮮度を維持。
  通常itemからの再取得0は維持。独立Node6ファイル99件、Jest3 suite138件、diff check成功。
  この承認は子一覧・title範囲だけ。HTTP変更応答の仕上げ・相談実装・全体検証を続ける。
- HTTP変更応答の実装担当確認: Node endpoint/session-notes/automatic-title 3ファイル20件、
  Expo runnerClientState/useRunnerClientState 2 suite53件、diff check成功。独立レビュー中。
  全operation、draft削除/eviction、同base同時writer、同revision復元、note競合、旧server fullを確認。
  不正patchの回復はGET1回に限定しPOSTは再送しない。GETがpatchを返す不正応答はreject。
  rollback用beforeの二重コピーを除去し、draft-only更新時の無関係session map再生成も共通適用境界で省く。
- HTTP合成比較（4,928セッション）: 全量606,063→差分873 decoded bytes、
  HTTP応答本文67,419→873 transfer bytes（全量gzip、差分1KiB未満のためidentity）。
  ヘッダー/TLSを含まない。同じ合成操作の結果で、実アプリ総量の比較ではない。
- 相談の購読scope・progress差分実装へ進む。HTTP・子sourceは独立レビュー中の必要修正以外を凍結。
- HTTP独立レビューで、不正なdraft/session mapキーを採用するとsnapshot適用時に失敗するMedium指摘。
  正規のbackend/sessionキーを境界で検証し、`patch:null`もGET1回の回復対象へ修正。
  回帰テスト追加・独立再レビュー中。
- HTTP指摘解消後の独立再レビューAPPROVE。追加の不正key/nullpatch/GETpatch停止を含む
  独立Jest2 suite56件・diff check成功。HTTPサーバー側は先の独立Node20件成功以降変更なし。
  子・HTTPの個別承認済み。相談実装・全体回帰・統合レビューは未完了。
- 相談のproducer・Runtime購読scope・専用同期hook・screen移設の初版実装済み。
  既存screen12件成功。通常の未購読接続へは配信せず、旧clientはlist要求後のfull配信を維持する。
  新clientは一覧summary/選択detailを分け、実際に保存したtext/output suffixとseqで進捗を反映。
  新leaseで比較baseをクリアし、低revision復元を許可。selection epochでA→B→Aの古い取得へjoinしない。
  初回同期buffer・gap回復・購読解除・cap/no-op・転送比較の追加テストと独立レビューを続行中。
  Runtimeテストは合成service mockを使い、共有された実相談storeを列挙・更新しない。
- 相談の実装担当確認: 新規Node4件＋既存service46件、Jest hook/screen/speech26件成功。
  統合Jest11 suite285件、両型チェック、diff check成功。統合Node11ファイルは実行中。
  相談progress合成比較は同じ配信更新で492,830→57,936 decoded JSON payload bytes（圧縮前）。
- 相談の独立レビューでHighを再現。再接続renderで旧modern=trueと新negotiated=nullが混在し、
  leaseなしGETが先走る。そのpendingへ交渉後もjoinすると新leaseのdetail購読が確定せずライブ停止。
  交渉結果をlease identityと一緒に確定し、未交渉の取得を開始しない修正・回帰テストを追加中。
  上記の通過済みテストだけでは全体完了とはしない。
- 相談Highを解消: 交渉結果を`{id: lease, modern}`の単一stateへまとめ、旧boolean/refの二重管理を削除。
  lease未確定のGETを開始せず、新lease交渉後は必ず正しいscopeのGETを発行する。
  独立再現ケース、本体Node2ファイル50件、Jest3 suite27件、diff check成功で相談再レビューAPPROVE。
- 最終実装の統合検証: Node11ファイル268件、Jest11 suite286件、iOS/macOS両型チェック、diff check成功。
  以下のコマンドはworktreeルートから実行済み。全リポジトリの全テストではなく関連範囲の統合検証。

```sh
node --test \
  private_runner/tests/agent-service.test.mjs \
  private_runner/tests/claude-backend.test.mjs \
  private_runner/tests/client-state-endpoint.test.mjs \
  private_runner/tests/codex-turn-execution.test.mjs \
  private_runner/tests/llm-session-service.test.mjs \
  private_runner/tests/codex-session-children.test.mjs \
  private_runner/tests/network-child-transfer.test.mjs \
  private_runner/tests/runner-ws-session-children.test.mjs \
  private_runner/tests/consultation-transfer.test.mjs \
  private_runner/tests/orchestrator-consultation-boundaries.test.mjs \
  private_runner/tests/session-notes.test.mjs
npm --prefix expo test -- --runInBand \
  cloudflareAccessFetch runnerClientState useRunnerClientState \
  useDirectorySessionTreeController useCodexReplyRequest \
  useCodexRelayObserverStartController RunnerWebSocketManager \
  features/agent/client.test useConsultationRooms \
  VoiceConsultationScreen useConsultationSpeech
npm --prefix expo run typecheck
npm --prefix expo run typecheck:macos
git diff --check
```

最新の合成比較（実アプリ総量の削減率とは区別する）:

| 比較 | 従来経路 → 修正後 |
| --- | ---: |
| 子一覧要求（100無関係item＋spawn/完了） | 102 → 2回 |
| 子一覧JSON（展開後） | 11,852,292 → 8,736 bytes |
| 子一覧WS socket応答（frame込み、handshake/TLS除外） | 67,695 → 608 bytes |
| client-state JSON | 606,063 → 873 bytes |
| client-state転送本文（全量gzip、差分identity） | 67,420 → 873 bytes |
| 相談progress JSON payload（圧縮前、同じ配信更新） | 492,830 → 57,936 bytes |

新しい汎用差分基盤・依存・利用者向け設定・画面ごとのキャッシュは追加していない。
相談の同期処理は専用hookへまとめ、screenから購読/順序管理を移している。

- 最終独立統合レビュー: APPROVE。全差分・新規7ファイル（実装2、合成テスト5）の配線と互換性を確認。
  必須残指摘・不要な重複・実会話本文/秘密情報の混入なし。diff check成功。
- 最終のRunner再起動/iOSビルドコマンドをユーザーへ提示済み。エージェントは代行していない。
  全修正を同ブランチへローカルコミットし、ユーザー確認後そのままpushできる状態で渡す。
  push・PR作成・mainマージは未実施。GitHub CIはpushしていないため未実行。

## 実機で次に確認すること

全修正の自動検証後にworktree内で実行する。Runner tokenを維持する。
Runnerとアプリの両方に変更があるため、次の順でサーバーを再起動し、アプリを再ビルドする。

```sh
cd /Volumes/SSD-500GB-SanDisk/work/bitty-worktree/fix/network-sync-upstream
./private_runner/restart-keep-token.sh --mode full
./scripts/ios/build-expo-ios-device.sh
```

1. local接続で通信量をリセットし、同じ会話・同じ親の子一覧を使って「起動、一覧、子一覧、
   会話再表示、入力・draft保存」を実施。操作時間、子一覧件数、起動区間の開始・終了を記録する。
2. CF接続でも同じ操作・同程度の時間で測る。異なる経路同士の値を改善前後とは扱わない。
3. `network_usage_snapshot`の同じ`sinceMs`内の差分をHTTPカテゴリ別に読む。
   local接続の`/client-state`等がother-originへまとめられず、それぞれのカテゴリへ入ることを確認する。
   旧版other-originの内訳を過去ログから復元できるとは主張しない。
4. 子一覧は既存の`session_child_history_fetch_done`のbytes/pageCount/elapsedを確認。
   相談画面を閉じた状態と開いた状態も分け、相談の量がなお不明な場合だけ追加計測を検討する。
5. 通信削減の実装修正後は同じ経路・操作で再測定し、鮮度・子追加・子完了・再接続回復も確認する。
   WSは展開後bytesで、携帯回線総通信量はOS計測との照合が必要。

## 再起動後の接続検証（2026-10-30 20:10 JST）

ユーザーによる再起動後、localhost:8788の稼働プロセスのcwdが本worktreeであることを確認。
コードは`570fc40`から変更せず、実サーバーへ次の検証を行い、すべて成功した。

- 認証付き`/health`の200/ok、認証なし`/client-state`の401。
- 認証付き`/client-state`のgzip応答、JSONとしての妥当性、ETag。
  この時点の応答本文は圧縮107,976 bytes、展開469,786 bytes。改善前後比較ではない。
- 同じETagによる条件付きGETの304、本文0 bytes。
- `/runner-ws`への認証付き接続、permessage-deflate交渉、`session_children_changed`対応通知。
- 相談一覧のdelta/lease交渉、古いleaseによる解除拒否、正しいleaseによる解除。
  接続内の購読のみを作成・解除し、会話生成や永続データの更新操作は行っていない。
  取得した実データ本文・tokenは出力/保存していない。

加えて、下記の隔離された合成テストを再実行し、19件成功、失敗/skip 0。

```sh
node --test \
  private_runner/tests/client-state-endpoint.test.mjs \
  private_runner/tests/codex-session-children.test.mjs \
  private_runner/tests/network-child-transfer.test.mjs \
  private_runner/tests/runner-ws-session-children.test.mjs \
  private_runner/tests/consultation-transfer.test.mjs
```

保存差分・子イベント・相談配信の変更動作は合成テストで確認した範囲。
稼働中の実データに対する保存/子生成/相談実行、実機UI、Cloudflare経由の通信量と応答性は未検証。
push・PR作成・mainマージは行っていない。

## 実機確認中の診断ログ検査（2026-10-30 21時台 JST）

- 実機ログの20:59:30〜21:02:35 JSTを確認。最新の同一sinceMs内では、
  HTTP受信のclient-stateが325,439 bytes、other-originが130 bytes。
  保存通信が独立カテゴリへ計上されている。ログはsampleであり、総回線量ではない。
- 同区間の子一覧取得完了19件、応答JSON合計856,078 bytes、最大171,492 bytes、
  最大所要3,837ms。異なる親・起動復元・通常操作を含むため、これだけで取得頻度や
  改善率の合否は決めない。無関係itemだけの操作区間と子の実追加/完了は実機確認待ち。
- 実サーバーの認証/health、gzip/ETag/304、WS圧縮/子変更capability、
  相談delta交渉/旧lease保護/解除を再検査し、すべて成功。
  会話生成や永続データを更新する操作は行っていない。
- 過去セッションのsession/rollout未発見、存在しないディレクトリ/非Gitルートの
  Git検査エラーを検出。同種エラーは修正前の保持ログにも存在した。
  個々の対象の原因や今回の修正との無関係まで確定したものではなく、自動修正は行わない。
- 実機の表示・保存後の復元・子追加/完了・相談切替/再接続・Cloudflare経由と
  OS計測の通信総量は引き続き未検証。実ログ本文、会話、tokenは記録していない。

## ユーザーによる実機確認と公開承認

ユーザーがRunner再起動とアプリビルド後、保存・相談・再接続・接続経路などの確認について
「他は確認したけど、大丈夫そう」、続いてサブエージェント一覧についても「それも大丈夫」と報告。
この報告を実機の機能確認完了として記録する。OS計測の総通信量や体感速度の定量比較は未実施。
その後、ユーザーが「プッシュPRレビューマージを進めましょう」と明示承認。
以前の「ユーザー本人がpushする」方針を更新し、本ブランチを公開・レビュー・CI確認後にマージする。

## 次の判断

PR公開後の独立レビューとCIを確認し、承認済みのマージへ進む。
マージ後はmainを更新し、ユーザーへmain側Runnerの再起動コマンドを提示する。
再起動成功の確認が届くまでは、稼働中のworktreeとローカルブランチを削除しない。
