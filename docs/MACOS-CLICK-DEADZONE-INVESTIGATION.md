# macOS クリック死亡ゾーン調査メモ(2026-09-05)

レビュー/セカンドオピニオン用。最新の修正状況を先頭に記載し、その後に16:20時点の調査記録を残す。

## 追記: 背面への転送を止める修正(2026-09-05 17時台)

- 追加ログ `/tmp/bitty_ct_new.log` の16:20:44では、`RCTParagraphComponentView.mouseDown` → AppKit `forwardMethod` 複数段 → `RCTUITextView.mouseDown` → `surfaceTouchCancel` を確認。
- 16:21:38 / 16:21:39でも、同じ経路で `ENRMContextMenuTextView.mouseDown` に到達している。macOSの `ENRMPlatformTextView` は `RCTUITextView` の別名なので、本文とコンポーザーには共通の基底クラスがある。
- [Apple TN3212](https://developer.apple.com/documentation/technotes/tn3212-adopting-gesture-recognizers-for-sidecar-touch-support) は、従来のAppKitでは `super.mouseDown` が初回のhitTestを迂回し、背面の兄弟ビューにもイベントを渡すと説明している。前面に正しくヒットしていても、この転送は起こる。
- 候補Bを採用: Fabric `RCTViewComponentView` のmacOS用 `mouseDown` を受け止め、superへ渡さない。RNのpress処理は既存の `RCTSurfaceTouchHandler` が担当する。ネイティブテキストやselectableパラグラフの独自 `mouseDown` は維持する。
- この変更は `expo/patches/react-native-macos+0.81.9.patch` に反映済み。ボタンごとのJS対策、テキストビューごとのガード、選択ループの追加改修は行っていない。
- 効果のなかった同時ジェスチャ認識の全面許可と、`RCTSurfaceTouchHandler` / `RCTUITextView` / `ENRMContextMenuTextView` の一時計測ログを除去した。先行するselectableパラグラフのパッチは維持。

検証:

- 独立したAppKit実験で、前面へのhitTest成功後にも背面テキストへmouseDownが届く旧挙動を再現。修正したメソッドをそのまま組み込むと転送が止まり、祖先のジェスチャ認識にはdown/upが各1回届いた。
- 同実験でラベル経由のクリック、前面にあるネイティブテキスト自身のmouseDown、オーバーレイに覆われていない本文へのクリックも確認。テキストターゲットは配送を数えるNSTextViewサブクラスなので、IME・編集・実際の選択ループを検証したものではない。
- `AppModal.macos` / `GitDiffPanel` / `AppDrawerLayout` の既存Jestテスト: 3スイート・9件成功。
- `patch-package --error-on-fail --error-on-warn` 成功。パッチ検証をスキップせずReleaseビルド成功。`codesign --verify --deep --strict` も成功し、生成バイナリに `RCTViewComponentView.mouseDown` が含まれることを確認。
- ビルドスタンプ: `2026-09-05 17:08:17 (cd404c4+dirty)`。アプリ: `expo/build/macos-release/Build/Products/Release/bitty.app`。
- 独立AppKit実験のソースとビルドログは一時ディレクトリ `/tmp/bitty-click-routing.PJ4Hae/` に保存。実験は実装ファイルから抽出した `mouseDown` を使用し、9項目成功。初期のハーネスは非表示ウィンドウへの配送とrecognizerの `acceptsFirstMouse` 設定が不足していたため、画面外のウィンドウ・初回クリック許可を設定してから旧挙動と修正後を比較した。
- **bittyの実画面での修正効果は未確認**。完全終了→新ビルド起動→設定のスタンプ確認後、エフォート選択・Git差分パネルの死亡箇所、本文の選択、入力欄のフォーカス・日本語入力、ウィンドウのドラッグを確認する。

以下は修正前の履歴。一時計測ログと同時認識変更は既に除去したため、下記のログ捕捉手順・作業状態は現在のビルドには適用しない。

## 症状(ユーザー確定)

Mac版 bitty(rn-macos 0.81.9 / Fabric / RN 0.81)で、**「背面にチャットのテキスト(本文 or 入力欄)がある位置に重なって描画されたオーバーレイUI」のクリックが死ぬ**。個別ボタンの問題ではなく共通の不具合。

- エフォート選択ドロップダウン(`chatFooterSelectCard`、AppModal経由)の項目のうち、コンポーザー入力欄に被る部分だけ押せない。ウィンドウサイズを変えてメニュー位置をずらすと押せる/押せないが位置に追従する(ユーザーがA/B確認済み)
- Git差分パネルのタブ(Git差分/File Explorer/実行中)・✕・リロード・ファイルツリー行も、背面にチャット本文テキストがあると押せない
- **決定的観察**: 死亡ゾーンではオーバーレイ要素上にマウスを置くと、カーソルが**テキスト選択(Iビーム)**になる。描画は手前にオーバーレイ、だがカーソル/ヒット挙動は背面テキストが勝っている
- 入力欄のフォーカス有無は無関係(フォーカスを外しても死ぬ。実験済み)

## 計測で確定した事実

計測基盤: rn-macos の `RCTSurfaceTouchHandler.mm`(mouseDown/mouseUp/cancel+stack)、`RCTViewComponentView.mm`、NSEvent ローカルモニタ、`log stream --predicate 'process=="bitty" AND eventMessage CONTAINS "[CT]"'` → `/tmp/bitty_ct_new.log`。

1. 死亡クリックでも **AppKit の `hitTest` は(多くの場合)正しく前面のオーバーレイ要素を返す**。mouseDown はビューに配送され、レスポンダチェーンを数階層バブルして止まる
2. しかし **mouseUp / mouseDragged がアプリのイベントディスパッチに一切現れない**(sendEvent 前段の NSEvent ローカルモニタにすら来ない)。= 誰かが `nextEventMatchingMask:` 系の**ネスト型トラッキングループでイベントキューから直接消費**している
3. mouseUp 消失の結果、RN の `RCTSurfaceTouchHandler`(NSGestureRecognizer)が宙吊りになり、メインループの `_NSApp_WillWaitForGestureCompatibleNextEvent` → `_NSGestureRecognizerUpdate` で **state=4(Cancelled)で強制リセット** → JS へ touchCancel → onPress 不発。スタックトレース取得済み(トップレベルのランループから。ネストループ内からではない=ループは既に脱出済み)
4. 一部サンプルでは hitTest 自体が背面の `RCTUITextView`(コンポーザー入力欄)を返している(前面にメニューがあるはずの座標で)。ヒット順の不整合も併発している可能性
5. gesture-handler(RNGH)の関与は否定済み: 死亡クリックで RNGH のハンドラ活性化・setJSResponder・blockOtherRecognizers・明示キャンセル(setEnabled:NO)はいずれも発火していない(全パスにログを入れて確認)。Skiaボード上のクリックが RNGH にキャンセルされるのは正常動作
6. ドロワー起因説も部分的に正しい: `AppDrawerLayout.macos.tsx` はドロワー開時に全画面の閉じる用オーバーレイを張るため、開きっぱなしだと最初のクリックが1回吸われる(これは仕様レベルの別問題)

## 試して失敗した修正(2件)

いずれも `expo/node_modules` に適用済み(ビルド 16:09 で実機検証→未解決)。

1. **selectableパラグラフのブロッキング覗き見除去**: rn-macos Fabric `RCTParagraphComponentView.mm` の `mouseDown` にあった `nextEventMatchingMask:... untilDate:distantFuture inMode:NSEventTrackingRunLoopMode dequeue:NO`(クリックかドラッグ選択かの判定)を廃止し、判定を `mouseDragged:`/`mouseUp:` へ遅延。→ **潜在バグとしては本物だが今回の症状は直らず**。патチ(`react-native-macos+0.81.9.patch`)へ反映済み
2. **macOSのみジェスチャ同時認識を許可**: `RCTSurfaceTouchHandler.mm` の `shouldRecognizeSimultaneouslyWithGestureRecognizer:` を macOS では YES に(RNGH ルートレコグナイザとの相互排他が AppKit の調停待ちを誘発する仮説)。→ **直らず**。※「押下100ms未満は生存/超は死亡」に見える時間相関が一時観測されたが、ユーザー再検証で時間は無関係と判明。この変更は現在も node_modules に残っている(要判断: 撤回 or 維持)

## 現在の第一容疑(未検証)

チャット本文は react-native-enriched-markdown の **`ENRMContextMenuTextView`(NSTextView亜種)** で描画されている。その `mouseDown` は
`ios/views/ENRMContextMenuTextView+macOS.m` で `[super mouseDown:event]` を呼ぶ = **NSTextView の選択ドラッグ用ブロッキングトラッキングループ**が走る。これが「イベントがモニタに現れず消える」の実体と合致する。入力欄(rn-macos `RCTUITextView`、これもNSTextView亜種)も同系。

未解明の残り1点: **前面のオーバーレイがヒットしたのに、なぜ背面のNSTextViewに mouseDown が到達するのか**(レスポンダチェーンのバブルが横滑りする経路、または hitTest 不整合)。これを特定するため、`ENRMContextMenuTextView.mouseDown` と `RCTUITextView.mouseDown` に**コールスタック付きログ**を仕込んだ検証ビルドが完成済み(16:19、未検証)。ユーザーが再現→ログのスタックで「どの経路でテキストビューが mouseDown を受けたか」が確定する。

補足: Iビームカーソルは NSTrackingArea/カーソルレクト由来で、これは z順(遮蔽)を無視して矩形だけで発火する AppKit 仕様。カーソル観察は「テキストビューが自分の領域だと思っている」ことの傍証。

## 検証ループの回し方

1. ビルド: `BITTY_SKIP_PATCH_CHECK=1 scripts/macos/build-expo-macos.sh`(計測ログが node_modules 直編集のため patch 検証をスキップ。ログ除去後は通常ビルドに戻すこと)
2. ログ捕捉: `log stream --predicate 'process == "bitty" AND eventMessage CONTAINS "[CT]"' --style compact >> /tmp/bitty_ct_new.log`(現在PID 61702で稼働中)
3. ユーザーに「⌘Qで完全終了→起動→設定画面のビルドスタンプ確認→死亡箇所を1つずつ数秒空けてクリック」を依頼
4. 判定: `surfaceMouseDown` の後に `surfaceMouseUp` が来れば生存、`surfaceTouchCancel` なら死亡

## 現在の作業状態(2026-09-05 16:20時点)

- 作業場所: `/Volumes/SSD-500GB-SanDisk/work/bitty-public`(main、コミット cd404c4 + ローカル変更)
- git 変更: `expo/patches/react-native-macos+0.81.9.patch`(修正1反映済) / `expo/patches/README.md`(修正1の説明追記)
- node_modules 直編集(patch未反映=一時実装): `RCTSurfaceTouchHandler.mm`(修正2+計測ログ)、`RCTUITextView.mm`(計測ログ)、`react-native-enriched-markdown/.../ENRMContextMenuTextView+macOS.m`(計測ログ)
- 最新ビルド: 16:19:51(スタック付きログ入り、実機未検証)
- アプリのJSソース(expo/src)への計測ログは全て除去済み・無変更

## 修正候補(スタック確定後に選択)

- A) `ENRMContextMenuTextView.mouseDown` / `RCTUITextView` 側で、ブロッキングループに入る条件を「自分が本当にヒット対象の時だけ」に制限する(hitTest 再確認ガード)
- B) rn-macos のヒット/レスポンダ経路の不整合を直す(前面オーバーレイがある時に背面テキストへ mouseDown が渡らないようにする)
- C) NSTextView のトラッキングループ自体を非ブロッキング化(パラグラフで実施済みの方式を横展開)

## 制約(過去の経緯より)

- 推測でパッチを重ねない。実測→原因確定→原因層で修正
- JSテスト成功・ビルド成功を実機修正の証拠にしない。検証は完全終了→スタンプ確認→実機クリック
- node_modules を編集したら patch-package へ反映するか、計測終了後に除去して整合を戻す
- コミット/push はユーザー承認後
