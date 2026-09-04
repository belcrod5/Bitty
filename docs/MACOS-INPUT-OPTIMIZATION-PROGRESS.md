# Mac 入力最適化 進捗メモ(2026-09-03)

前セッション(消失)が設計書 `MACOS-INPUT-OPTIMIZATION-DESIGN.md` のチェックリストをどこまで進めたかの記録。

## 完了済み(チェックリスト項目1+計測準備)

- §5.1 ビルドスタンプ実装済み: `expo/src/features/app/buildStamp.ts`(新規)+ `expo/macos/.xcode.env`(EXPO_PUBLIC_BUILD_STAMP 注入)+ `SettingsScreen.tsx` に「アプリ情報 > ビルド」表示とコピー機能+テスト。
- ビルド時に必要だった `expo/patches/react-native-enriched-markdown+0.5.0.patch`(新規、`static_cast<bool>` 等のコンパイル修正)。
- §5.3 一時計測ログを実装済み(**node_modules 直接編集。patch 未反映=意図的な一時実装**):
  - N1/N2: `react-native-macos/React/Fabric/RCTSurfaceTouchHandler.mm`(surfaceMouseUp / touchResolve)
  - N3: `.../RCTViewComponentView.mm`(viewMouseUp / emitClick、tag・hasClick・desc・hitView)
  - J1: `react-native-macos/Libraries/Pressability/Pressability.js`(signal 遷移 / releaseBlock / releaseCallsOnPress / onClick 入口)
  - J2: `ChatScreen.tsx:1294` の `[CT] openGitDiffPanel CALLED` のみ(全画面・スラッシュ option は未実装)
- 計測入り Release ビルド完了: `expo/build/macos-release/Build/Products/Release/bitty.app`
  - **ビルドスタンプ: `2026-09-03 13:45:51 (2111f06+dirty)`**(バンドル内に確認済み。binary/bundle とも 13:46 生成)
- ログ捕捉: `log stream --predicate 'process == "bitty" AND eventMessage CONTAINS "[CT]"'` が PID 94078 で稼働中 → `/tmp/bitty_ct5.log` に追記。広域版 PID 83886 → `/tmp/bitty_ct2.log`。
- 13:53〜13:58 に約20クリック分の実測データを取得済み(`/tmp/bitty_ct5.log`)。

## 実測・実読からの発見(設計書の仮説判定に直結)

1. **responder 経路は生きている**。捕捉した全クリック(子ビュー hit=desc=true 含む)が GRANT→RELEASE→onPress 発火まで到達。テキスト入力欄クリックの TERMINATED 2件は正常挙動。→ **H3(responder 全域欠陥)はほぼ棄却** → 設計書 §6.3 により targetIsDescendant パッチは撤回方向。
2. **二重発火が静的に確定的**(§4.6 の懸念が現実)。ネイティブ Click payload(`RCTViewComponentView.mm` `emitMouseEvent`)には `pointerType` フィールドが**存在しない**。そのため Pressability.onClick では
   - `isPointerEvent=false` → 早期 return しない
   - `shouldHandleMacOSChildPointerClick` は `pointerType==='mouse'` を要求するため**常に false = フォールバックは死にコード**
   - `sameTarget=true`(全実測クリックで確認)→ 末尾の `onPress(event)` に到達
   → responder 経路と合わせ **onPress が毎クリック2回呼ばれる**構造。実測ログでも全クリックで releaseCallsOnPress と onClick 入口が対で出ている(onClick 内の onPress 実呼び出しログは未実装のため回数の直接証明は未取得)。
   注意: この onClick 末尾の onPress 呼び出しは upstream 由来のコードであり、パッチ以前から存在。3ボタン問題の原因層である可能性も、パッチが悪化させた可能性もまだ確定していない。
3. 13:53〜13:58 の捕捉中に `openGitDiffPanel CALLED` は一度も出ていない(Git 差分ボタンが未クリックか、handler 未到達かは不明)。

## 次にやること(チェックリスト項目2〜3)

1. ユーザーに依頼: `bitty` を Cmd+Q で完全終了 → `pgrep -x bitty` 0件確認 → 上記 Release を起動 → 設定画面の「ビルド」が `2026-09-03 13:45:51 (2111f06+dirty)` であることを確認。
2. §5.2 マトリクス実験: 3ボタン+対照ボタンを**1つずつ、間を数秒空けて**クリック(ログと突合するため)。順番と時刻をメモ。
3. `/tmp/bitty_ct5.log` の追記分を解析し、各クリックの到達層(touchResolve→GRANT→RELEASE→onPress / CALLED)を表にして原因層を1つに絞る。
4. 必要なら追加 J2 ログ(全画面: `ChatComposerInput.tsx:112` の onPress、スラッシュ: `SlashCommandSelectMenu` option+backdrop)+ onClick 内 onPress 実呼び出しログを入れて再ビルド。
5. 原因層確定後、設計書 §6 の該当修正へ。二重発火が確定した場合は onClick 経路の整理(responder 経路一本化)を原因層修正として検討。

## 2026-09-03 実験結果と対応(セッション2)

§5.2 実験をユーザーが実施(14:25〜14:26、`/tmp/bitty_ct5.log` に捕捉)。ユーザー報告と突合した判定:

| ボタン | ユーザー報告 | ログ観測 | 判定 |
|---|---|---|---|
| Git 差分 | 押せない | `openGitDiffPanel CALLED` が**1クリックで2回**発火(二重発火の実証)。しかしパネルは表示されず、直後の同位置クリックもボタンに当たっている=バックドロップ未描画 | 入力層は正常。**描画/状態層の問題**(approvalDialogPending 強制クローズ or アニメ不発を診断中) |
| 全画面 | 複数行でスクロールバーが出ている時だけ押せる | 同一要素への3クリック中2回が GRANT 後 `RESPONDER_TERMINATED`、mouseUp が RN に届かない | **確定**: ボタン(28px)が TextInput(NSTextView)フレームの真上にあり、クリックが選択トラッキングループに飲まれる。スクロールバー帯に重なる時だけ助かる |
| スラッシュ option | 押せる | onPress 到達を確認 | 解決済み |

実施した修正(未コミット):

1. `chatComposerStyles.ts`: `chatComposerInputWithExpandButton` を paddingRight→**marginRight:34** に変更。TextInput のネイティブフレームがボタン下に伸びないようにする(全画面ボタンの根本対応)。
2. `Pressability.js`(node_modules、一時実装): responder 経路が onPress を呼んだ時刻を記録し、**150ms 以内の onClick 由来 onPress をスキップ**(二重発火対策)。a11y クリックは責任 release が先行しないため素通し。検証OKなら patch-package に反映する。
3. 診断ログ追加: `openGitDiffPanel` に approvalDialogPending 値、`GitDiffPanel.tsx` に visible 遷移とアニメ完了ログ。

検証: Jest 30件(nativeInputPatches / reactNativeMacOSPressability / ComposerFullscreenEditor)PASS、typecheck / typecheck:macos PASS。Release 再ビルド実行中。

次: 新スタンプのビルドでユーザー再確認 → Git差分は診断ログで原因層確定 → 修正。その後 targetIsDescendant 系パッチの撤回(死にコード確定)と [CT] ログ除去・patch 再生成。

## 2026-09-03 夜: 17:59ビルドの検証結果と重大発見(セッション3)

ユーザー検証(19:53、スタンプ `2026-09-03 17:59:26`):

- **全画面ボタン: 修正確認(1行でも押せる)** ✓
- スラッシュ option: 引き続き押せる ✓、二重発火抑止も動作(`onClick SKIPPED duplicate` 多数)✓
- **Git差分: 原因確定**。handler 実行→`visible=true`→`Animated.timing(useNativeDriver:true)` が**永遠に完了しない**(`anim to=1 finished=false` が40秒後の unmount 時)→ パネルが opacity 0+画面外のまま=「押せない」ように見えていた。対応: macOS はアニメなしで `panelAnim.setValue()` 即時反映(GitDiffPanel.tsx)。**RN Animated の useNativeDriver:true は macOS で完了しない前提**で他の overlay(RunnerMediaViewer、chatBottomToast 等)も今後要点検。
- **回帰: チャットメッセージの文字が不可視**。原因は **14:07 の node_modules 巻き戻しイベント**(前セッション消滅時に発生。何かが5パッケージを vanilla に戻した): `@legendapp/list`(macOSではリスト行を transform でなく left/top 配置する重要修正)、`react-native-gesture-handler`、`react-native`(ReactFabric renderer)、`expo-calendar`、`expo-modules-core` の各パッチが未適用に。13:46ビルドは巻き戻し前のJSを含んでいたため無事、17:59ビルドが vanilla を取り込んで文字消えが発生。
- 対応: 全パッチ再適用済み(expo-calendar の1ハンクは手動適用)。`patches/*.patch` 8件すべて applied を確認するaudit手順: `for p in patches/*.patch; do patch -p1 --dry-run --forward < $p; done`。

**教訓: ビルド前に必ず全パッチの適用状態を audit すること**(部分的に巻き戻った node_modules が2回ビルドを壊した)。

## 2026-09-03 夜2: 全症状解消の確認と後始末

21時のユーザー確認: **文字消え解消・Git差分パネル表示・全画面ボタン・スラッシュいずれもOK**(スタンプ 2026-09-03 17:59 ビルド+パッチ再適用後の再ビルド)。

後始末実施:
- [CT] 計測ログを全て除去(node_modules 3ファイル+ChatScreen+GitDiffPanel)。二重発火抑止(_lastResponderOnPressTime、150ms窓)は保持し `npx patch-package react-native-macos` でパッチへ正式反映。reverse check OK。
- アニメーションを原因層で修正: `utils/animationDriver.ts` の `USE_NATIVE_ANIMATION_DRIVER`(macOS=false)を新設し、GitDiffPanel(setValue応急を撤去しアニメ復活)/useChatBottomToast/LlmCompletionNotifications/BouncingDotsIndicator に適用。AppModal.macos/AppDrawerLayout.macos が既に false を使っていた=リポジトリ既存の流儀に整合。rn-macos の NativeAnimated+Fabric 不動作は upstream issue 起票候補。
- `.gitattributes` を `expo/patches/*.patch whitespace=cr-at-eol,-trailing-space` に拡張(patch-package 再生成物の空白警告対策)。
- 検証: typecheck / typecheck:macos PASS、Jest 1075件 PASS、`git diff --check` PASS、最終ビルド `2026-09-03 21:04:26 (2111f06+dirty)` SUCCEEDED、binary/bundle に [CT] 残骸ゼロ。
- keychain毎回ポップアップの原因判明: Release が adhoc 署名のため designated requirement がバイナリハッシュ=リビルドごとに別アプリ扱い。対応は「常に許可」(同一バイナリ内)か DEVELOPMENT_TEAM 署名(恒久)。

残タスク: ユーザーの最終実機確認(21:04ビルド)→ レビュー指摘の反映 → コミット分割 → ユーザー承認後に push/PR。

## 2026-09-04: targetIsDescendant 系の全撤去(根本解決)

レビューエージェントの指摘を実コードで検証し、前提の誤りが判明:
- Click payload には直列化層(`HostPlatformViewEventEmitter.cpp` `mouseEventPayload`)で **`pointerType:"mouse"` が付与されている**。「payload に pointerType が無い」という以前の分析は struct だけ見た誤り。
- upstream の Pressability.onClick は pointerType ガードで二重発火をもともと防いでいる。**二重発火の真犯人は本ブランチのパッチが追加した子ビュークリック用フォールバック(shouldHandleMacOSChildPointerClick)自身**だった。responder 経路は子ビュークリックも正常処理する(実測)ので、フォールバックは不要かつ有害。

対応(設計書 §2.2 の撤回方針どおり):
- MouseEvent.h / HostPlatformViewEventEmitter.cpp / RCTViewComponentView.mm を upstream 原本へ復元(targetIsDescendant 配管を全削除)。
- Pressability.onClick を upstream へ復元し、150ms дедup(_lastResponderOnPressTime)も撤去(不要になったため)。右クリック→即時 onLongPress 等の意図した変更は保持。
- rn-macos パッチは6ファイルのみに縮小(Pressability 右クリック・RCTUITextView IME・ScrollView ホイール・propsConversions submitKeyEvents)。
- テストを upstream 挙動に合わせ更新(pointer クリックは onClick で常に無視+パッチに targetIsDescendant が再導入されないことをガード)。
- 検証: Jest 1074件 PASS、typecheck 両方 PASS、git diff --check PASS、8パッチ整合 OK。撤去後ビルドで3ボタン+二重発火なし(トグル系が1回で反応)の実機確認が必要。

レビューエージェント自体はセッション再起動で消滅し最終報告は未着。中核指摘(上記)は取り込み済み。残りの観点(IME 部分、useNativeDriver 副作用など)は必要なら再レビュー。

## 2026-09-04: keychain毎回ポップアップの恒久対応

adhoc署名が原因(designated requirement = バイナリハッシュ → リビルドごとに別アプリ扱い)。`scripts/macos/build-expo-macos.sh` は元々ビルド時署名の仕組みを持っており、adhoc になったのはこのスクリプトを使わず xcodebuild を直接叩いていたため。**Releaseビルドは必ず `scripts/macos/build-expo-macos.sh` 経由で行うこと。** 同スクリプトの証明書選択を優先順位固定(Developer ID → Apple Development → Mac Developer、`BITTY_MACOS_SIGN_IDENTITY` で明示指定可)に改善済み。署名種別が変わった直後の初回起動のみ keychain 許可を1回求められるので「常に許可」を選ぶ。以後はリビルドしても許可が持続する。

## 注意(引き継ぎ)

- node_modules の [CT] ログのため `npx patch-package --reverse --dry-run` は現在**失敗する**(想定内)。計測終了後にログを除去してから patch 整合を確認すること。
- Release バンドルは minify されるため J1 の `onPressName` は当てにならない(空になる)。ボタン特定は J2 の文字列ログか時刻突合で行う。
- ログの loc は mouseDown 系と mouseUp 系で Y 座標の原点(上/下)が異なって見える。突合時は注意。
- commit / push / PR / worktree 削除はユーザー承認後(従来ルール)。
