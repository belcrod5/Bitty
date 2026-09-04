# Mac 入力最適化 引き継ぎ

> **注意: これは 2026-09-02 時点の歴史資料。** ここに書かれた「最終差分に残っている実装」
> (targetIsDescendant フォールバック等)はその後の実機計測で二重発火の原因と判明し
> **撤回済み**。最新の経緯と結論は `MACOS-INPUT-OPTIMIZATION-PROGRESS.md` を参照。

## 結論

このブランチには Mac 入力の共通層を直す実装とテストがあるが、主要なクリック不具合はユーザー環境で改善確認できていない。自動テスト、パッチ適用、Release ビルドの成功を、実機 UI の修正完了とは扱わないこと。

## 現在も未解決として扱う不具合

ユーザーが Mac 版で、次の 3 箇所を「まだ押せない」「全然改善されていない」と報告している。

1. チャット右上の Git 差分ボタン
2. ユーザー入力欄の全画面ボタン
3. スラッシュコマンドのポップアップ内にあるコマンド選択ボタン

共通点は `TouchableOpacity` / Pressability 配下に `Text`、`View`、アイコンなどの子ビューがあること。ただし、共通原因が Fabric の子ビュー hit test であるという仮説は、まだ実機計測で証明されていない。

期待動作は、描画されているボタン領域を通常の左クリックすると、それぞれの `onPress` が 1 回だけ実行されること。

## ユーザーが確認した事実

- 3 箇所のクリックは、修正を複数回試した後も改善しなかった。
- ユーザーは別のアプリを開いている認識ではなかった。
- 右クリックで Skia の通常クリックとコンテキスト操作が同時発火する問題は、その後「OK 問題なし」と報告された。
- その他の要件は、最新 Release に対する最終的な実機確認結果が揃っていない。テスト成功だけで完了扱いしない。

## ビルドと起動プロセスで判明したこと

- 一度確認した起動中プロセスは、正しい worktree 内の `bitty.app` だったが、15:22 起動の古いプロセスだった。
- ネイティブ hit test 修正を含む最新 Release の binary と `main.jsbundle` は、ともに `2026-09-02 15:57:17` に生成された。
- macOS ではウィンドウを閉じて開くだけでは同じプロセスを再利用する。完全終了前の動作確認は新しい binary の確認にならない。
- `2026-09-02 21:27` 時点では、対象 worktree の `bitty` プロセスは起動していない。
- Release binary に `targetIsDescendant` 関連 selector、bundle に JS 側処理文字列が含まれることは確認済み。ただし、ユーザーが 15:57 版を完全終了後に起動して 3 箇所を確認したことは、プロセス観測では確定できていない。

最新成果物:

```text
expo/build/macos-release/Build/Products/Release/bitty.app
```

## 次担当者が最初に行うこと

追加パッチを書く前に、最新 Release を完全終了から起動し、同一クリックをネイティブから各ハンドラーまで追跡する。

1. 起動前後に `ps` と `lsof` で PID、開始時刻、実行ファイルの絶対パスを記録する。
2. `RCTViewComponentView` の `mouseDown:` / `mouseUp:` で button、self、AppKit の実 hit view、`targetIsDescendant`、click handler の有無を一時ログに出す。
3. `HostPlatformViewEventEmitter` が JS に渡す click payload と、Pressability の responder / `onClick` のどちらが動いたかを同一イベント識別子で記録する。
4. 各箇所で最終 callback 到達を記録する。
   - Git 差分: `openGitDiffPanel`
   - 全画面: `ChatComposerInput` の `onOpenFullscreen`
   - スラッシュメニュー: `SlashCommandSelectMenu` の各 option の `onPress`
5. 全画面ボタンでは、`mouseDown` による TextInput blur 後もボタンが mounted のままか確認する。
6. overlay、`pointerEvents`、header の PanResponder、親子 Pressable の propagation のどこで止まるかを、ログ結果から一つに絞る。

計測ログを得るまでは「子 Text が hit した」「ヒット領域が狭い」「別アプリを起動した」などを原因として確定しない。

## これまで試した修正

### 失敗が確認された、または撤回したもの

- JS の `event.currentTarget !== event.target` だけで子ビュークリックを判定する案。実際の macOS Fabric click では、ネイティブ側が Pressable 自身の event emitter から dispatch するため JS の target/currentTarget が同じになり得る。実機症状を解消せず、最終案ではこの判定単独に依存していない。
- 全画面ボタンの `hitSlop` 拡大。症状への局所対応で、blur により `mouseUp` 前にボタンが unmount される可能性を直さないため撤回した。
- `fireEvent.press` 中心のコンポーネントテスト。callback 配線は確認できるが、AppKit/Fabric の実 hit test や responder 順序を再現しないため、3 箇所の実機修正の証拠にはならなかった。

### 最終差分に残っている実装（実機未検証を含む）

- React Native macOS の AppKit hit test 結果を `MouseEvent.targetIsDescendant` として JS へ渡し、Mac の primary mouse click が子ビューに当たった場合だけ Pressability の `onClick` fallback で最寄りの `onPress` を呼ぶ。
- direct target は既存 responder 経路に残し、二重発火を避ける。右・中クリック、touch、pen、他 OS は fallback 対象外。
- Mac では入力欄にフォーカスがなくても、テキスト入力表示中は全画面ボタンを mounted に保つ。
- Mac の右クリックを即時 `onLongPress` に対応させ、Tap gesture には右クリックを渡さない。
- 非 precise の縦マウスホイールだけ、共通 ScrollView で縦移動量を 2 倍にして短い補間を行う。trackpad と横スクロールは既存動作を維持する。
- Skia ボードでは discrete mouse wheel を修飾キーなしで既存 pinch lifecycle に流す。precise trackpad は Command 必須のまま。
- Fabric TextInput の欠けていた `submitKeyEvents` props conversion を追加し、Mac の multiline 入力を Command+Enter 送信、通常 Enter 改行にする。IME marked text は commit 後に submit 判定する。
- 通常入力と全画面入力は native event の確定文字列を送信境界で使用し、accepted callback の時だけ同じ draft を消す。「続けて」がまれに `t` になる問題と、全画面入力中のカーソル末尾移動への対策。
- チャット系 popup の最大幅を `CHAT_CONTENT_MAX_WIDTH = 720` に集約。Popup chat、左 drawer のディレクトリ/セッション context menu、チャットタイトル menu、context usage menu に適用。

## 他の要件の確認状態

次はコードと自動テスト上は対応されているが、最新 Release での最終ユーザー確認がないため未検証として引き継ぐ。

- 全縦 ScrollView の discrete mouse wheel 移動量
- Skia ボードの修飾キーなし mouse wheel zoom
- popup 最大幅 720px
- Command+Enter 送信と通常 Enter 改行
- IME 入力「続けて」が `t` と送信される問題
- 全画面入力中のカーソル末尾移動

## 主な変更ファイル

依存ライブラリの上流境界:

- `expo/patches/react-native-macos+0.81.9.patch`
- `expo/patches/react-native-gesture-handler+2.28.0.patch`
- `expo/patches/README.md`
- `.gitattributes` — CRLF を含む React Native macOS patch の whitespace 設定

入力・送信:

- `expo/src/features/app/components/ChatComposerInput.tsx`（新規）
- `expo/src/features/app/components/ComposerFullscreenEditor.tsx`
- `expo/src/features/app/screens/ChatScreen.tsx`
- `expo/src/features/app/hooks/useChatDerivedState.ts`
- `expo/src/features/app/contexts/ConversationContext.tsx`
- `expo/src/features/app/hooks/useCodexReplyRequest.ts`
- `expo/src/features/app/hooks/useSendReplyRequestController.ts`
- `expo/src/features/app/AppRoot.tsx`

幅制限:

- `expo/src/features/app/styles/layoutConstants.ts`（新規）
- `expo/src/features/app/styles/appCommonStyles.ts`
- `expo/src/features/app/components/PopupChatOverlay.tsx`
- `expo/src/features/app/components/AppDrawer.tsx`
- `expo/src/features/app/components/ChatContextUsageMenu.tsx`
- `expo/src/features/app/screens/ChatScreen.tsx`

テスト:

- `expo/src/features/app/components/nativeInputPatches.test.ts`（新規）
- `expo/src/features/app/components/reactNativeMacOSPressability.test.ts`（新規）
- `expo/src/features/app/components/ComposerFullscreenEditor.test.tsx`
- `expo/src/features/app/components/AppDrawer.test.tsx`
- `expo/src/features/app/components/ChatContextUsageMenu.test.tsx`
- `expo/src/features/app/screens/ChatScreen.autoRecordingPanel.test.tsx`
- `expo/src/features/app/hooks/useCodexReplyRequest.test.tsx`
- `expo/src/features/app/hooks/useSendReplyRequestController.test.tsx`

## 検証結果

2026-09-02 の最終再実行結果:

- Jest 全体: 139 suites / 1074 tests PASS
- 対象 4 suites: 53 tests PASS
- `npm run typecheck`: PASS
- `npm run typecheck:macos`: PASS
- `git diff --check`: PASS
- React Native macOS patch の reverse/apply と node_modules との一致: PASS
- Mac Release native build: PASS
- 別担当レビュー: blocking issue なし

これらは静的整合性、単体テスト、ビルド可能性の確認であり、未解決の 3 クリックが実機で届くことは証明していない。

## Git 状態

- worktree: `/Volumes/SSD-500GB-SanDisk/work/bitty-worktree/fix/macos-input-optimization`
- branch: `fix/macos-input-optimization`
- HEAD: `2111f06` (`Fix macOS settings persistence and runner credentials (#112)`)
- `origin/main` より 1 commit behind
- 今回の変更はすべて未コミット
- push、Pull Request 作成ともに未実施
- tracked 変更 20 ファイル、未追跡 5 ファイル（この資料を除く）
- tracked 差分は 1,137 insertions / 180 deletions。大半は dependency patch とテストだが、差分規模は小さくない。
- `ChatScreen.tsx` は 2,716 行で、HEAD と行数は同じ。`AppRoot.tsx` は 7,100 行で HEAD より 1 行減っている。

現状を保全し、ユーザー判断なしに commit、push、rebase、worktree 削除をしないこと。

## やってはいけないこと

- 実機ログなしに推測で Pressability、`hitSlop`、`pointerEvents` の追加パッチを重ねない。
- Git 差分、全画面、スラッシュ option の各ボタンへ個別 workaround を入れない。3 箇所の共通経路を計測し、原因層で直す。
- JS テストが通ったことを実機 Fabric click の証明にしない。
- ウィンドウを閉じただけの再起動を最新 native build の確認にしない。
- `node_modules` だけを編集して patch-package の patch と不一致にしない。
- ユーザーの明示承認前に commit、push、PR、merge、worktree 削除をしない。
