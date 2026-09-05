# macOS オーバーレイのクリック死亡ゾーン（2026-09-05）

## 症状

macOSで、チャット本文またはコンポーザーに重なったReact Nativeの
オーバーレイだけがクリックできなくなる。同じコントロールでも、
ネイティブテキストと重ならない位置では動作する。エフォート選択メニューと
Git差分パネルのコントロールで再現した。

## 原因

AppKitの最初のhit testは前面のFabric viewを正しく選んでいたが、継承した
`mouseDown` 処理がイベントを背面の `NSTextView` まで転送していた。
この従来型のイベント転送は
[Apple TN3212](https://developer.apple.com/documentation/technotes/tn3212-adopting-gesture-recognizers-for-sidecar-touch-support)
に記載されている。

背面のtext viewが選択用トラッキングループに入り、対応する `mouseUp` を
消費する。その結果、React Nativeの `RCTSurfaceTouchHandler` が前面のtouchを
キャンセルし、`onPress` が発火しなかった。

## 修正

Fabric `RCTViewComponentView` のmacOS実装で `mouseDown` を受け止め、
`super` を呼ばないようにした。React Nativeのpress lifecycleは既存の
`RCTSurfaceTouchHandler` が引き続き担当する。ネイティブテキストの子viewと
selectable paragraphは、それぞれの `mouseDown` 処理を維持する。

修正は `expo/patches/react-native-macos+0.81.9.patch` で管理する。
コントロールごとのJavaScript対策、ジェスチャ調停の変更、text view固有の
ガードは追加していない。

一時計測用の `[CT]` ログと、効果がなかった同時ジェスチャ認識の変更は除去した。
今回の不具合を直さなかったselectable paragraphのイベントループ変更も、
挙動範囲を不必要に広げるため除去した。

## 検証

- 独立したAppKit実験で、背面text viewへの転送を再現した。修正後は転送が止まり、
  祖先のgesture recognizerにはdown/upが1回ずつ届いた。計9項目が成功した。
- `AppModal.macos`、`GitDiffPanel`、`AppDrawerLayout` の既存Jestテストは
  3スイート、9件すべて成功した。
- `patch-package --error-on-fail --error-on-warn`、macOS Releaseビルド、
  `codesign --verify --deep --strict` が成功した。生成バイナリには
  `RCTViewComponentView.mouseDown` が含まれ、一時計測用の `[CT]` ログは
  含まれていない。
- 再ビルド後のBitty実画面で、対象オーバーレイがクリックできることを確認した。

## 残る回帰確認

修正はmacOSの全Fabric viewに効く中央変更である。通常のmacOSスモークテストでは、
テキスト選択、コンポーザーのフォーカスと日本語IME入力、ウィンドウのドラッグも
継続して確認する。
