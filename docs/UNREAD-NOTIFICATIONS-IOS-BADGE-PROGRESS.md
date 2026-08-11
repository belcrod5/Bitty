# 未読・通知・iOSバッジ修正 進捗

- 状態: DEVICE_VALIDATED / READY_TO_PUBLISH
- ブランチ: `fix/unread-notifications-ios-badge`
- ベース: `origin/main` (`58447e5`)
- worktree: `/Volumes/SSD-500GB-SanDisk/work/bitty-worktree/fix/unread-notifications-ios-badge`

## 対象

- 左ナビドローワーのディレクトリー単位「すべて既読」のタイムアウト
- 未読チャット数とiOSアプリアイコンのバッジ数の同期
- プッシュ通知タップ時の対象チャット遷移
- 対象チャット閲覧時の関連プッシュ通知削除
- アプリ復帰時、開いているチャットの既読反映

## 方針

- 未読状態・既読確定・通知識別子の上流データ契約とライフサイクルを先に確認する
- 各画面への個別パッチではなく、共通の状態遷移で解決する
- 実装担当とレビュー担当を分ける

## 進捗

- [x] `docs/GIT-WORKTREE.md` 確認
- [x] 専用ブランチ・worktree作成
- [x] 初回の原因調査（実機失敗後に誤判定と確定）
- [x] 最新 `origin/main` の確認・取り込み
- [x] 初回の実装・テスト（実機要件を満たさず、承認を撤回）
- [x] 実機が修正済みapp / Runnerを使用していることを確認
- [x] 実機ログとnative通知shapeから根本原因を再特定
- [x] 修正設計方針を確定
- [x] 修正設計を`sol/high` 2名で相互レビュー
- [x] Skia previewと実popupの既読境界を分離
- [x] subagentをtop-level unread / badge / pushから除外
- [x] 子turnのRPCを親turn consumerへ配信しないownership修正
- [x] `sol/high`による最終固定差分レビュー
- [x] 再実装・テスト
- [x] 再実装後の独立`sol/high`レビュー
- [x] 実機で残ったbadge 66件の正本分布とdrawer表示範囲を再調査
- [x] canonical directory別未読件数のsnapshot契約・drawer表示を実装して自動検証
- [x] Skia preview/reconnectと実際の可視chatの既読境界を分離
- [x] CLI subagent rolloutをtop-level unread / badge / pushから除外
- [x] 子subagentのturn eventを親turn完了として扱わないownership検証
- [x] ユーザー実機確認（再実装後）
- [ ] コミット / push / Pull Request
- [x] 初回差分の別エージェントレビュー（実機失敗後に承認撤回）
- [ ] CI確認

## 初回調査・初回実装メモ（承認撤回済み）

- 一括既読は、全履歴を列挙した後、未読1件ごとにHTTP要求とACP/CLIストア全体の永続化を繰り返す。クライアント4並列に対してサーバー書き込みは直列化されるため、待機中に12秒タイムアウトへ到達する。
- 通知タップ先は現在のチャット表示経路を使っておらず、対象IDをモジュール変数へ保存するだけ。通知レスポンスとAppStateの順序競合、復元処理との競合時にpendingを先に消す問題、payloadにdirectoryがない問題がある。
- 既読の正本は `updatedAt > lastReadAt`。iOSバッジ同期と配信済み通知のセッション単位削除は未実装。
- 通常のチャット復元成功時は既読化されるが、復帰時の表示中ポップアップ/live observer経路は再hydrateまたはskipだけで既読更新がない。
- 修正案は、既読API/ストアのバッチ更新、通知遷移intentの購読可能化と現行popup表示経路への統一、既読確定境界での通知削除、可視セッションの復帰時既読化、未読正本からのバッジ同期。
- 2026-08-10に最新 `origin/main` (`8af163c`) を取得し、専用ブランチへfast-forward済み。通知・セッション木周辺の変更を含む状態から実装する。
- 2026-08-10に更新された `origin/main` (`58447e5`) へ未commit差分を保持したままfast-forwardした。追加変更はSkiaボードの最新メッセージ表示と`unicode-segmenter`依存で、今回の変更ファイルとの競合はなかった。
- 既読ストア/API/clientを最大100件の後方互換batchへ変更した。ACP/CLIとも1 batchにつき1回だけ永続化し、ディレクトリー一括既読はrunner snapshotを取得せず全threadを列挙してdirectory別にchunk送信する。found結果だけUIへ反映し、missingや失敗を未読へ読み替えない。
- push device登録へ最大100件の登録directoryを追加し、canonical directoryごとのACP/CLI正本をsessionId単位でmergeする未読件数APIを追加した。foreground/resume/read commitのabsolute badgeとTURN_COMPLETEDの`aps.badge`は同じ集計を使う。CLIは集計時に一度だけ強制refreshし、完了済みrolloutのmtimeを`updatedAt`へ含めるため、通常refresh間隔内でも推測値を送らない。
- TURN_COMPLETED payloadへdirectoryを追加し、通知tap intentを購読可能なpending targetへ変更した。cold/warm・AppState順序競合・新旧intent競合でも保持し、現在のpopup hydrate成功後かつ同じintentの場合だけ消費する。
- 既読commit後に、同じsessionIdかつTURN_COMPLETED categoryの配信済み通知だけ削除する。削除・badge同期の失敗は既読commitから隔離する。
- ready-driven resumeはAppStateがactiveのときだけ走り、hydrate成功した可視panelとlive observer対象を既読化する。selected sessionは既存restore経路へ任せて二重既読を避ける。background中の可視UIだけを理由に完了通知を抑制しない。
- 独立レビュー対応として、activeかつselected/popupで可視な完了を共通hookから即既読化し、非可視完了は正本badgeを同期する。foreground APNsはabsolute badgeを許可し、notification received時にも正本badge・対象session未読状態を照合してread済みの後着通知を削除する。AppRootはHEAD比34行追加/34行削除でnet増分なし。
- push送信はsummaryと端末別badge集計を待った後、APNs送信直前に対象sessionId+directoryのACP/CLI merge正本を再確認し、read済みまたは確認失敗なら送らない。
- CLI indexはrefresh snapshotの適用、mark、upsert、persistを同じwrite queue境界へ統一した。refresh適用時はsnapshot後のcurrent mutationを優先し、mark-unreadのepochも保持する。同時forced refreshは同じpromiseへcoalesceする。
- directory batchもsession単位の既存mutation orderingへ参加する。後発singular intentはbatch完了を待ってserverへ送られ、古いbatch結果はUI反映・通知削除対象から除外される。
- 再レビュー対応として、CLI refresh中の後発force要求を共有pendingへ束ね、現refresh後のtrailing scan 1回を全force callerが待つようにした。rolloutのmtime精度をindexと同じ整数ミリ秒へ揃え、不要な再parseと並行upsertの`updatedAt`巻き戻りも防いだ。
- ACP/CLIに複数directoryを同一index snapshotから列挙するprimitiveを追加した。通知送信前は対象directoryと端末directory集合のcanonical unionを1回だけforced refreshし、その同じ取得結果から対象sessionの未読gateと端末別absolute badgeを導出する。重複directory集合は再集計せず、対象directoryが端末集合外でもgateへ含める。通常の未読件数・対象未読照合も同じsnapshot境界を共用する。
- 最終レビュー対応として、CLI refreshをmonotonic generationのactive wave + queued force waveへ変更した。scan中のforceは必ず次generationを共有し、そのgeneration中のforceはさらに次へ束ねる。各waveのcallerは自身のscan完了時に解放され、失敗時はactive/queuedをreject・resetして次forceで再開できる。空directoryの未読件数はACP/CLI storeを起動せず即0を返す。
- 実Runnerのlive検証では、5件batchで未読数が42→47→42へ5msで反映され、queued turnでも42→43→42へ収束した。
- 追加の稼働ログで、cwdを持たないcompletionが空directoryのまま未読snapshot検証に入りpushを抑止される経路を確認した。空directory時は、既存の端末登録directory unionを1回だけsnapshot化し、sessionIdがちょうど1 directoryで見つかった場合だけcanonical directoryを解決する。未発見・複数一致は安全に抑止し、APNs payload/titleには解決済みdirectoryを使う。APNs成功時はtokenを含めず成功端末数をログへ残す。
- cold-startの通常TURN_COMPLETED tap、directory batchのfound-only既読commit callback、実HTTP `/sessions/read` の認証・複数ACP target・結果shape・singular互換・件数/body上限を追加テストで固定した。

## 実機失敗後に確定した根本原因（2026-08-10）

初回の `REVIEW_APPROVED / AWAITING_USER_VALIDATION` 判定は撤回する。単体・APIテストの成功を実機経路の成功として扱った誤判定であり、過去の実装・検証ログは経緯として上に残す。

- build / restartの不一致ではない。Runnerは20:13:50に修正worktreeから、backend変更時刻より後に起動していた。iPhoneには20:15に同worktreeのRelease appがinstallされ、embedded bundleにも最終変更が含まれていた。
- 一括既読はdirectory単位APIになっていない。clientがbatch APIを呼ぶ前に `thread/list limit=100` を全ページ列挙してIDを組み立てる。実ログではreal8 / hykeのfetch開始後に完了・失敗がなく、`sessions_mark_read` も完了・失敗とも0件だった。`thread/list` 応答（614,031 / 266,688文字）がserverの20万文字parse上限を超え、RPC identityを失ったunparsed応答となり、Promiseがtimeoutまたは切断まで未解決になる。
- direct APNsは `sessionId` / `directory` / `turnId` をroot custom fieldsへ置く。一方、expo-notificationsのiOS serializerはremote contentの `data` を `userInfo['body']` から作り、root payloadは `request.trigger.payload` に保持する。実装が `content.data` だけを参照したため `sessionId` が空になり、tap時のpending targetも通知削除時の照合対象も生成できなかった。
- 通知テストは `content.data` に値を直接入れたmockだけを使い、実native serializer shapeとの差を隠していた。

## 再設計方針

### 1. Directory一括既読

- `/sessions/read` に明示的なdirectory scope契約（例: `scope: "directory"`）を追加する。directory scopeと単件・ID batchは排他とし、既存の単件・ID batch契約は後方互換で残す。認証、body上限、ID batchの100件上限も維持する。
- canonical directoryによる選択と既読mutationをACP / CLI各storeの同一queue内で行う。directory対象を既存の100件ID batchへ展開して渡さず、各storeで最大1回だけpersistする（ACP + CLI合計最大2回）。後発のmark-unreadも同じqueue orderingへ参加させ、先行directory既読で上書きしない。
- UIから `thread/list` 全ページ列挙とsession ID組み立てを削除し、directoryごとに1 requestだけ送る。対象0件は成功とする。
- 応答はIDを列挙せず、全体とstore別のboundedな `status` / 対象件数 / 更新件数 / `lastReadAt` を返す。ACP / CLIの片方だけが失敗した場合はpartial、両方成功時だけfull successと判定できる契約にする。
- 20万文字超のRPC identity消失は独立した既存transport欠陥として追跡する。parse上限引き上げを一括既読の修正には使わない。

### 2. 通知metadataの正規化

- Expoのnotification request自体を入力とするmetadata normalizerを通知入力の既存boundaryへ1か所だけ置く。既知の4 field（`sessionId` / `directory` / `turnId` / `approvalId`）だけを取り出し、fieldごとに `content.data` を優先し、欠けたfieldだけ `request.trigger.payload` からfallbackする。category判定は既存箇所に残す。
- Registrarのwarm / cold tap、既読確定後のdelivered notification削除、foreground reconcile、approval通知は、この正規化結果を共用する。これにより既配信通知も `trigger.payload` から識別でき、local通知の `content.data` も維持できる。
- serverのdirect APNs payloadとnative approval通知の既存契約は変更しない。

### 3. 既読成功後のUI・通知同期

- full successの場合だけ、canonical directory配下のlocal treeを既読化し、同directoryのTURN_COMPLETED通知を削除してbadgeを同期する。
- partialではoptimisticなtree全既読化とdirectory単位の通知一括削除をしない。正本を再取得してreconcileし、read済みと確認できたsessionの通知だけを削除する。
- 通知削除・badge同期の失敗はserverのread commitから隔離する。ただし失敗件数と理由をtoken等の秘密を含めずログへ残す。

### 4. 回帰テスト

- 実native serializer shape（`content.data` が空でroot custom fieldsが `request.trigger.payload` にあるfixture）を使い、warm / cold tap → popup hydrate成功 → intent消費、同一sessionの配信済み通知削除、foreground reconcileを固定する。`content.data` 優先・field単位fallbackとapproval通知も検証する。
- directory一括既読はendpoint / API / controllerを通して、`thread/list` 呼び出し0回、large directory、101件以上、empty success、scopeとIDsの排他、認証・body境界を検証する。
- ACP / CLI各storeのpersistが1回以下、full / partial結果、後発mark-unreadとの競合順序、partial時にoptimistic全既読化・一括削除をしないこと、正本reconcile後にread済み通知だけ削除することを検証する。
- transportの20万文字超応答は別テスト・別課題で再現を固定し、一括既読の受け入れ条件から切り離す。

### 5. 実機validation gate

新しいbuild / restart後、実機で次を確認するまでcomplete、commit、push、Pull Requestへ進めない。

1. directory一括既読が1 requestで完了し、所要時間と更新件数をログで確認できる。
2. 修正版install後に届いた新規通知をtapすると、対象チャットのpopupが開く。
3. そのチャットの既読確定後、同じ通知だけが通知センターから消える。
4. server正本の未読数とiOS badgeが収束する。

## 再設計の実装結果（2026-08-10）

- `/sessions/read` にdirectory scopeを実装した。ID batchへ展開せず、canonical directoryの選択・mutationをACP / CLI各write queue内で完結し、各store最大1 persistと後発mark-unread優先を保証する。応答はIDを含まないboundedな全体・store別status/countだけを返し、full / partial / failedを区別する。
- directoryの「すべて既読」は`thread/list`列挙と100件chunkを削除し、1 HTTP requestだけにした。full時だけcanonical directoryのlocal treeを既読化し、partial / failed時は正本treeを再取得する。古いdirectory処理のtree・通知同期まで後発singular / unreadが待つため、古い結果で上書きしない。
- notification requestを入力にするmetadata normalizerを既存通知boundaryへ1か所置いた。`sessionId` / `directory` / `turnId` / `approvalId`をfield単位で`content.data`優先、欠損時だけ`trigger.payload`へfallbackし、warm / cold tap、approval、delivered dismiss、foreground reconcileで共用する。direct APNs / native approval契約は変更していない。
- full directory成功時だけcanonical directoryのTURN_COMPLETEDを一括削除する。partial / failed時は各sessionの未読正本を照合してread済み通知だけを削除する。badge同期は各commit境界で1回にし、削除・badge失敗はread commitから隔離して秘密を含まない件数・理由だけを記録する。
- cold-start responseはmetadataが有効なtap / approvalとして受理できた場合だけnative last responseをclearする。popup intentはhydrate成功かつ同じsequenceの場合だけclearする。
- 初回実装のdirectory全ページ列挙・chunk・ID結果依存テストを削除し、controllerテストをdirectory契約中心へ縮小した。`AppRoot.tsx`はHEAD比39行追加 / 39行削除でnet増分なし。新規hook / utilityは通知ライフサイクルと配信済み通知操作という実責務へ限定した。
- 独立レビュー指摘後、ACP / CLI directory readをcopy-on-writeへ変更した。候補snapshotをpersistして成功後だけlive mapへswapするため、write / rename失敗後も未読stateを維持し、同じ操作を再試行できる。
- CLIのstale / 初回scanはdirectory選択・mutationと同一write opへ畳み、scan反映と既読化を合わせて1 persistにした。通常refresh generationと後発mark-unread orderingは維持する。
- singular既読はRunner返却canonical directoryをlocal treeと通知削除へ渡し、`directory + sessionId + TURN_COMPLETED`でscopeする。同一sessionIdが別directoryに存在しても変更・削除しない。
- partial / failedのtree reconcileは既存root・pagination・loaded childrenを破棄して正本first pageへ置換し、続きはcanonical cursorからlazy取得する。refresh failed / supersededをcontrollerへ伝播し、成功toastを出さない一方、通知reconcileとbadge同期はread commitから独立して続行する。
- `server-runtime.mjs`のread target判定をsession serviceへ移し、session-state routeとJSON request error処理の重複を統合した。HEAD比のserver-runtime増分はnet +91行からnet +22行へ縮小し、production未使用のACP / CLI singular thin wrapperを削除した。
- CLI rolloutのlegacy `last_read_at`はuncached初回importだけに限定した。index entryが存在する場合は空値・epochを含むcached `lastReadAt`を正本としてscan / upsertで無条件に保持するため、mark-unread後のfile growth・forced refresh・upsertでもlegacy値へ巻き戻らない。
- foreground completionの可視判定へboard / popup双方のdirectoryを渡した。incoming directoryがある通知はcanonical directoryとsessionIdの両方が一致した場合だけauto-readして通知を抑止し、同じsessionIdが別directoryにある場合は未読を維持してbadgeを同期する。directoryを持たない旧イベントだけは従来のsessionId fallbackを維持する。

## 再実装後の自動検証

- `private_runner`: directory endpoint / service / ACP / CLI focusedテスト成功
- `private_runner`: 全Nodeテスト 346件成功 / 1件skip / 失敗0
- `expo`: notification serializer / warm・cold tap / approval / dismiss・reconcile / directory controller focusedテスト成功
- `expo`: 全Jest 100 suites / 730 tests成功
- `expo`: `npx tsc --noEmit` 成功
- 変更したRunner `.mjs` 6ファイルの `node --check` 成功
- `git diff --check` 成功
- サーバーのstart / stop / restart、app build / installは実行していない

## 実機再確認後のbadge 66件対応（2026-08-11）

- iOS badge 66件はstaleな端末値ではなく、登録24 directoryのRunner正本に残る未読合計だった。内訳はDownloads/codex 10、gogcli 2、pta 1、test_folder 42、collabo_link 4、relief-box2 7。
- drawerは各directoryの初期5 sessionだけを読み込み、折りたたみ時の未読表示もその5件だけを参照していた。66件中55件が初期5件の外にあり、directoryを全件既読にしたつもりでも残りを画面から判別できなかった。server-side directory全件既読API自体は変更せず維持する。
- 既存 `/sessions/unread-count` を後方互換で拡張し、canonical directory別のboundedな未読件数と総数を、ACP / CLIをsessionIdでmergeした同一snapshotから返す。総数はdirectory別件数の合計としてだけ導出する。
- clientは同じsnapshotでiOS badgeとdirectory別表示を更新し、応答の合計不一致・重複directory・上限超過を拒否する。drawerはpagination済み5件のlocal推測値ではなく、全履歴の正本件数をdirectory名の横に表示する。
- 並行するbadge同期では最新requestだけがbadgeとdrawerの両方へsnapshotを適用し、遅れて返った旧snapshotはUIへ返さない。これによりbadgeとdirectory別表示が別世代へ分離しない。
- directory全件既読がfull成功した場合だけcanonical directoryの表示件数を0へ確定し、直後に正本snapshotへ再同期する。partial / failedは0へ楽観更新せず、正本snapshotを再取得する。
- 初期5件外に55件ある回帰、ACP / CLI同一session dedupe、canonical alias統合、full / partial時の表示、badgeとdirectory別合計の一致をテストで固定した。
- この時点では通知の既読・削除条件を変更していなかったが、後続の既読境界修正でSkia preview / preloadと実popupの閲覧を分離して解決した。

## badge 66件対応後の自動検証

- `private_runner`: focused 22 tests成功
- `private_runner`: 全Nodeテスト 346件成功 / 内部349 tests・1件skip / 失敗0
- `expo`: focused 4 suites / 47 tests成功
- `expo`: 全Jest 100 suites / 734 tests成功
- `expo`: `npx tsc --noEmit` 成功
- 変更したRunner `.mjs` 6ファイルの `node --check` 成功
- `git diff --check` 成功
- サーバーのstart / stop / restart、app build / install、API data mutationは実行していない

## 実機再確認後の既読境界・badge二重計上の修正設計（2026-08-11）

- Skia mini previewの通常hydrateは既読化しないが、ready-driven resume / reconnect同期は、preview panelのhydrate成功とlive observer skipを閲覧として`markSessionReadAsync`へ流していた。実機ログでも`resume_sync_panel_done(applied)`直後に`session_mark_read_start / done`が記録され、そのread commitにより同じsessionId + directoryのTURN_COMPLETED通知が削除されている。
- hydrate / reconnect / preloadとread commitを分離する。Skia card / mini previewに内容が読み込まれただけでは既読にしない。既読境界は、ユーザーが明示的に開いたpopup / chat surfaceが実際に可視で、対象sessionのhydrateが成功した時だけとする。resume時も、その時点で実際に開いているchat surfaceだけを再hydrate後に1回既読化する。
- notification tapはpending intentを保持し、対象popupを開いてhydrate成功後に既読化・関連通知削除する。drawerからの明示openも同じ可視境界を使う。hydrate failed / superseded、Skia previewだけの表示、hidden panelでは既読・通知削除を行わない。live observer復旧もSkia previewは既読化せず、実際に開いているpopupだけを閲覧済みとして扱う。
- foreground completionも、Skia boardのglobal selected sessionやcard cacheを「可視chat」と扱わない。実際に開いているpopup / chat surfaceとcanonical directory + sessionIdが一致する時だけ即既読化し、それ以外は未読・通知を維持して正本badgeへ同期する。
- badge 2の実データは同一チャットのACP / CLI重複ではない。親chat `019fea93...`に加え、調査用subagent rollout `019fee21...`が通常CLI sessionとして未読集計されていた。後続の調査subagentも加わり、read-only `/sessions/unread-count` はbitty-public 3件を返した。subagentの`session_meta`には`thread_source: "subagent"`、`parent_thread_id`、`source.subagent`があり、UIから開けない内部threadをbadge / drawer / push targetへ混入させている。
- 同じ実ログから、Codex RPCのcompletion waiter / notification listenerがexpected threadId + turnIdを照合せず、子subagentの`turn/completed`で親queued turnまで完了扱いにしていたことも確認した。子完了時に子と親のcompletion notificationが連続broadcastされ、実際の親完了時には親通知が残らない。waiterとdelta / item / completed listenerを所有thread / turnへscopeし、別threadのイベントで親を終了・通知しない。
- CLI indexがsession_metaのthread種別を正本metadataとして保持し、subagent rolloutをtop-level chat単位の未読snapshot・push targetから除外する。子session tree / historyの明示閲覧・lookupは維持する。既存indexは`isSubagent`未分類entryだけmetadataを再取得し、mtime / sizeが不変でも旧entryを通常chatとして数え続けず、既存`lastReadAt`も失わない。ACP / CLI同一sessionIdの既存dedupeとdirectory identityは維持する。
- directory一括既読のstore mutation契約は維持する。内部subagentを未読数から除くためだけのread mutationは追加せず、immutableなsession種別でtop-level unread projectionを分離する。
- 診断ログには秘密を含めず、read trigger、badge snapshot total / directory count、通知dismissのmatched / dismissed件数を残し、hydrateと明示openのどちらがreadを発生させたか追跡できるようにする。
- 回帰テストは、subagentを含むCLI index migration・通常list / unread / push除外、親chatだけでbadge 1、親既読後badge 0、Skia previewのresume / reconnect / live observerでは既読にならない、実popup resumeはhydrate成功またはpopupを所有するlive observer復旧後、notification tapはhydrate成功後だけ既読・dismiss、failed / supersededで不変、同一sessionId別directory scopeを固定する。
- 実機ログでは、子subagentの`turn/completed`が親のqueued turn完了待機・relay通知本文にも混入し、子完了時に子と親の両方へ通知が発生していた。親turnの本当の完了時には通知されていない。completion waiterとrelayの通知集約をexpected `threadId + turnId`へ限定し、子のdelta/item/completed/turn/completedを親の完了・通知として扱わない。subagentの未読projection除外だけでこの誤完了を隠さない。

## 実装結果（2026-08-11）

- Skia card / mini previewのhydrate・resume・live observer復旧は既読化しない。実popupはhydrate applied後、またはpopupを所有するlive observerがactive復帰した時だけ既読化する。
- foreground completionはhydrate中・failed・supersededのpopupを既読化しない。directory欠落時はglobal selected directoryではなくpopup自身のdirectoryを使い、本文なしcompletionもread / badge lifecycleを通す。
- CLI indexをschema v3へ更新し、既存`lastReadAt`を保持したままsubagent metadataをmigrationする。subagentは通常list / child tree / history / directory一括既読には残し、top-level unread / iOS badge / push targetからだけ除外する。
- completion waiterとRunner relayをexpected `threadId + turnId`で所有判定する。子turnのdelta / item / completed RPC自体を親operation・event log・client observerへ配信せず、親通知を子完了で消費しない。
- 新しい汎用schedulerや別ledgerは追加せず、既存のpopup lifecycle・CLI index・Runner relayという責務境界内に修正を限定した。

## 最新の自動検証

- `private_runner`: 全Nodeテスト 352件成功 / 1件skip / 失敗0
- `expo`: 全Jest 100 suites / 734 tests成功
- `expo`: `npx tsc --noEmit` 成功
- 変更したRunner `.mjs` 9ファイルの `node --check` 成功
- `git diff --check` 成功
- `sol/high`固定差分レビュー: `APPROVED`、High / Medium / Lowの未解決findingなし
- サーバーのstart / stop / restart、app build / install、API data mutationは実行していない

## 初回実装の自動検証（実機要件を証明しない）

- `./scripts/worktree/bootstrap-local.sh --env --expo --ios-native`: 成功（サーバー操作なし、package/lockの追跡差分なし）
- `./scripts/worktree/bootstrap-local.sh --private-runner`: 成功（一時npm cache使用、サーバー操作なし、package/lockの追跡差分なし）
- 最新main追従後の `./scripts/worktree/bootstrap-local.sh --expo`: 成功（`unicode-segmenter@0.17.3`反映、サーバー操作なし、package/lockの追跡差分なし）
- `private_runner`: 追加focused Nodeテスト 32件成功
- `private_runner`: 全Nodeテスト 336件成功 / 1件skip / 失敗0
- `expo`: 追加focused Jest 2 suites / 25 tests成功、全Jest 100 suites / 714 tests成功
- `expo`: `npx tsc --noEmit` 成功
- 変更したRunner `.mjs` 6ファイルの `node --check` 成功
- `git diff --check` 成功
- lint / formatter: リポジトリに正規script・設定なし
- 既存warning: React Native `SafeAreaView` deprecation、失敗経路を検証するpush approval warning、Expo bootstrapの既存React peer override。dependency auditはRunner high 1件、Expo 39件を報告。

## 次工程

- commit / push / Pull Request
- CI確認

## レビュー

- `sol/high` の別エージェントによる初回差分の `APPROVED` は、実native serializer shapeとdirectory一括既読の実経路を検証できていなかったため撤回。再実装後に再レビューする。
- 修正設計は `sol/high` 2名が独立に確認後、相互レビューして `APPROVED`。これは設計だけの承認であり、承認時点では再実装未着手だった。
- 再実装後の独立レビュー1回目は `CHANGES_REQUESTED`。persist失敗時のlive state rollback、CLI初回scan + directory既読の1 persist化、singular既読のcanonical directory scope、partial時のauthoritative tree / notification reconcileを実装して閉鎖した。
- 独立レビュー2回目は `CHANGES_REQUESTED`。CLIのlegacy `last_read_at`でmark-unread epochが巻き戻る経路を遮断し、foreground可視判定をsessionIdだけでなくcanonical directoryでもscopeして閉鎖した。
- 最終独立レビューは `sol/high` が `APPROVED`。High / Medium / Lowの未解決findingなし。
- badge 66件対応後の独立レビューも `sol/high` が `APPROVED`。High / Medium / Lowのfindingなし。reviewerによるfocused検証はRunner 22/22、Expo 47/47、`git diff --check`すべて成功した。hydrate / resume / preloadだけで通知が消える件は今回の承認範囲外で、次工程の未解決課題として残す。
- 実機で確認したSkia preview誤既読・subagent badge二重計上・子turnの親完了誤認を修正後、`sol/high`が固定差分を再レビューして`APPROVED`。途中findingのpopup live observer契約、directory欠落completion、hydrate中completion、本文なしcompletion、子RPC親配信をすべて閉鎖し、High / Medium / Lowの未解決findingなし。
- 2026-08-11、ユーザーがiOS実機で一括既読、badge、通知タップ、関連通知削除を再確認し、問題なしと確認した。
