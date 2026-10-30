# 通信処理改善の進捗（PR #260 の残課題）

更新日: 2026-10-30
状態: 第1段階のHTTP分類修正・関連自動検証・独立レビュー済み。GitHub公開の承認待ち。
ブランチ: `fix/network-sync-upstream`
作業先: `/Volumes/SSD-500GB-SanDisk/work/bitty-worktree/fix/network-sync-upstream`
基準: `origin/main` / `3ebbd96`（[PR #260](https://github.com/belcrod5/Bitty/pull/260) マージ後）

## 目的と範囲

不要な取得・再同期・全量配信を、発生源の契約とライフサイクルで解消する。
画面ごとの抑制、追加キャッシュ、新しい設定・依存・抽象化で症状を覆わない。
今回の対象は PR #260 の次の4残件に限定する。全通信を際限なく最適化する作業にはしない。

| 残課題 | 確認済み | 未確定・次の確認 | 状態 |
| --- | --- | --- | --- |
| 大量HTTPの取得先と取得・再同期契機 | 認証対象CF originを計測の選択中Runner originとしても使用し、local接続時に同RunnerのHTTPがother-originへ入る。draft保存POSTも全client-stateを返す | 修正した分類でother-origin内の取得先を再測定。client-stateが主因とは断定しない | 分類修正・自動検証済み、実機待ち |
| 一覧・子一覧の遅延 | 全item/completedが子一覧refreshを起こし、全cursorを再取得する。約16分の子一覧成功応答記録は計114.6MB（展開後） | 子構造・状態の変更通知契約で再列挙を減らせるか確認。単なるitem完了との区別と既存更新の鮮度を保証する | 発火元・量を特定、最小修正設計は次段階 |
| 相談機能の全量配信 | 保存ごとに全room、progress更新ごとに累積live状態を全Runner WS接続へ配信する | 配信回数・大きさ・購読画面以外の受信量を測る。古いHTTP増加とは別の原因候補として扱う | 構造確認済み・量は未計測 |
| 同条件の効果比較 | HTTP圧縮とWS圧縮交渉は既対応。WSアプリ計測は展開後bytes | 同じ経路・操作・時間で前後比較。Cloudflare経由と実機総通信量は実機確認が必要 | 未実施 |

## 現在の経路と既存対策

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

### 第1段階: HTTP分類のorigin混同（今回の最小変更）

`AppRoot.tsx` は実際のHTTPに選択中の`runnerUrl`を使う一方、
`configureCloudflareAccessFetch`へは`effectiveCloudflareRunnerUrl`を渡している。
fetchパッチがこの値をCF認証ヘッダーと計測の両方に使い、local接続時の取得先を誤分類する。
認証対象と計測対象をこの既存設定境界で明示的に分ける。
認証ヘッダーの送信範囲や通信処理は維持し、新しい利用者向け設定や計測基盤は作らない。
この変更単体は通信量削減ではなく、主因を特定できる状態へ直すもの。

### 第2段階候補: 子一覧更新の発火契約

`useCodexReplyRequest.ts` と `useCodexRelayObserverStartController.ts` の
`item/completed` → `onSessionStreamBoundary` → `AppRoot.handleSessionStreamBoundary` →
`refreshSessionChildTreesAtBoundary(parent_progress)` → `fetchSessionChildrenHistory` が発火経路。
取得中にも完了イベントが来るとdirtyを記録して再取得し、各取得は全cursorを走査する。
同時要求の集約はあるが、子構造が変わったかどうかとitem完了を区別していない。

単なる時間制限を画面へ足すのではなく、子の追加・状態変化を示す上流の通知契約と照合し、
必要な更新の鮮度を保って再列挙を減らす最小案を次に検討する。
既存の`control.sessions_active_changed`はpayloadなしの全体無効化で、親子関係の構造変更を表さない。
その通知を全一覧再取得に結び直すだけではfan-outの移動になるため、流用は即決しない。
親条件はすでにサーバーのページング前に適用されているため、フィルター追加は再実装しない。
一覧titleにfirstUserMessageがそのまま入る構造もあるが、観測した大きさの内訳は未計測。
根拠なく文字数を切り詰める修正は行わない。

### 他の候補の優先度

client-state全量応答と相談全接続配信は構造確認済みだが、今回観測した通信の主因として未確定。
まず分類修正後のHTTPと既存の子一覧bytes診断を使う。
相談等のWS帰属がなお必要な場合に限り、既存受信境界への固定カテゴリ集計を検討する。

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
5. [ ] 根拠のある通信削減の原因単位で最小修正。互換性・同期の鮮度・再接続回復を維持。
6. [x] 第1段階の関連テスト・型チェック・独立レビュー。local/CF選択を同じ合成条件で検証。
7. [x] 実機確認用のworktree初期化（env、両node_modules、iOS workspace/Pods、共有Runner token）。
8. [ ] 下記手順で実機比較を実施し、結果を記録する。

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

## 実機で次に確認すること

worktree内で実行する。Runner tokenを維持する。
Runnerの実装差分はないため、分類修正の反映に必要なのはアプリの再ビルド。
サーバーも作業先へ揃える場合は次の再起動コマンドを使う。

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

## 次の判断

第1段階のorigin修正を検証した後に実機を再ビルドし、local/CFそれぞれ同じ操作でHTTP分類を確認する。
公開承認後は`fix/network-sync-upstream`を通常pushし、第1段階のPRを作成してCIを確認する。
マージは別途ユーザー承認が必要。
次の実装修正単位は子一覧の発火契約とする。必要な通知・互換性を先に整理する。
client-stateや相談の契約変更を同時に広げず、実測に応じて優先度を決める。
