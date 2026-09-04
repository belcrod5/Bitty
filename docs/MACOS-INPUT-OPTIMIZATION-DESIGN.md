# Mac 入力最適化 修正設計書

作成: 2026-09-02。対象 worktree: `/Volumes/SSD-500GB-SanDisk/work/bitty-worktree/fix/macos-input-optimization`(HEAD 2111f06、未コミット差分 1,137 insertions / 180 deletions)。

本書は引き継ぎ資料(`MACOS-INPUT-OPTIMIZATION-HANDOFF.md`)を「未検証の主張集」として扱い、未コミット差分・アプリ実装・react-native-macos ネイティブソースを実読した上で作成した。**確認済み事実**(file:line 付き)と**推測**を明示的に区別する。

---

## 1. 結論(要旨)

1. **最優先はコード修正ではなく「ビルド同一性の証明」**。引き継ぎ資料自身が「ユーザーが 15:57 版を完全終了後に起動して確認したことは確定できていない」と認めており、「修正が効かない」のではなく「修正が届いていない」可能性が排除されていない。起動時にビルド ID を UI に表示する仕組み(§5.1)を最初に入れる。
2. **引き継ぎ資料の本命仮説「Fabric の子ビュー hit test が共通原因」はコード構造と矛盾する**。ネイティブソースを読んだ限り、macOS Fabric には子ビューが hit した場合でも親 Pressable に届く responder 経路が最初から存在する(§3.2)。もし子ビュー hit test が全体的に壊れているなら、アプリ中のほぼ全ボタンが死ぬはずだが、報告されているのは 3 箇所だけである。
3. **3 ボタンの真の共通点は「TouchableOpacity 配下に子ビュー」ではなく「全てミニボードのポップアップチャット環境にある」可能性が高い**(§3.3)。スラッシュメニューはポップアップモード専用 (`ChatScreen.tsx:2708` `visible={isMiniBoardPopupMode && ...}`)、ヘッダーは PanResponder 付き、ポップアップ全体は reanimated の transform 付き Animated.View 内にある。引き継ぎ資料はこの観点を一度も検討していない。
4. **現行の targetIsDescendant パッチは、責務層が違う上に二重発火リスクを抱える**(§4.6)。responder 経路が生きている通常のボタンでは、子ビュークリック時に「responder 経路の onPress」と「onClick フォールバックの onPress」が両方発火し得る。実機計測で responder 経路の生死を確定するまで、このパッチは「撤回候補」として扱う。
5. 差分の大半(Cmd+Enter 送信、IME 対策、ホイール調整、幅 720 制限など)は 3 クリック問題と独立しており、個別に実機確認して先に取り込める(§2)。

---

## 2. 現状差分の仕分け

### 2.1 3 クリック問題と無関係で、独立に取り込み候補(それぞれ実機確認は必要)

| 変更 | 場所 | 備考 |
|---|---|---|
| `submitKeyEvents` props conversion 復元 | rn-macos patch: `propsConversions.h` | Fabric で欠けていた変換の追加。低リスク |
| Cmd+Enter 送信・Enter 改行 | `ChatComposerInput.tsx`(新規)、`ChatScreen.tsx` | 上と対 |
| IME marked text の commit 後 submit | rn-macos patch: `RCTUITextView.mm:670` 付近 | 「続けて」が `t` になる問題への対策 |
| 送信境界で native event の確定文字列を使用+accepted 時のみ draft 消去 | `useCodexReplyRequest.ts` +445/+569、`useSendReplyRequestController.ts`、`ComposerFullscreenEditor.tsx` | onAccepted 配管。設計は妥当 |
| discrete wheel の縦 2 倍+補間 | rn-macos patch: `RCTEnhancedScrollView.mm` | trackpad・横は既存維持 |
| Skia ボードの修飾キーなし wheel zoom | rngh patch: `RNPinchHandler.m` | |
| 右クリック即時 onLongPress+Tap から右クリック除去 | rngh patch: `RNLongPressHandler.m` / `RNTapHandler.m`、rn-macos patch: Pressability 右クリック処理 | ユーザーが「OK 問題なし」と報告済みの領域 |
| popup 最大幅 720 集約 | `layoutConstants.ts`(新規)、`appCommonStyles.ts`、`PopupChatOverlay.tsx`、各メニュー | 見た目のみ |
| 全画面ボタンを macOS では常時 mount | `useChatDerivedState.ts:168`、`ChatScreen.tsx:578` | blur→unmount 対策として方向は正しいが、これ単独で直る証拠はない |

**推奨**: これらは 3 クリック問題の解決を待たずに、意味単位でコミットを分けてユーザー確認→取り込みへ進める。1,137 行を一塊で塩漬けにするのが現状最大の管理リスク。

### 2.2 問題に関係するが実機未検証・懐疑対象

- **targetIsDescendant ネイティブパッチ+Pressability onClick フォールバック**(rn-macos patch: `MouseEvent.h` / `HostPlatformViewEventEmitter.cpp` / `RCTViewComponentView.mm:2209-2221` / `Pressability.js:573-604`)。§4.6 の二重発火リスクがあり、計測完了までコミットしない。効いた証拠が出なければ撤回する。

### 2.3 テスト群の位置づけ

`nativeInputPatches.test.ts` / `reactNativeMacOSPressability.test.ts` などは JS の配線確認であり、AppKit の実 hit test・responder 順序は再現しない(引き継ぎ資料の自己申告どおり)。実機修正の証拠として扱わない。

---

## 3. 確認済み事実と、引き継ぎ資料への反証

### 3.1 macOS Fabric のクリック配送は「二重経路」である(コードで確認済み)

1. **responder 経路**: `RCTSurfaceTouchHandler.mm`(surface root の NSGestureRecognizer)が `mouseDown:`(:444)/`mouseUp:`(:500 付近)を受け、`CreateTouchWithUITouch` が hitTest で最深ビューを取り、`touchEventEmitterAtPoint:` を持つ最寄りビューまで遡って touchStart/touchEnd を JS responder システムに流す(:109-130 付近)。iOS と同じ仕組みで、Pressable が responder を取り `onPress` が発火する。
2. **click emitter 経路**: 各 `RCTViewComponentView` の `mouseUp:`(:2209)が、自分に onClick ハンドラーがあれば `Click` イベントを emit する。子ビューが hit された場合は AppKit の responder chain を伝って親の `mouseUp:` に到達する。

TouchableOpacity は Pressability の全ハンドラー(onClick 含む)をネイティブビューに spread しており(`Libraries/Components/Touchable/TouchableOpacity.js:269-369`)、`topClick`→`onClick` の登録は macOS 設定が iOS 設定を継承して有効(`BaseViewConfig.macos.js:20,36` → `BaseViewConfig.ios.js:98`)。

### 3.2 反証: 「子ビュー hit test が共通原因」なら 3 箇所では済まない

経路 1(responder)は最初から子ビュー hit を前提に設計されている(最深ビューから emitter を遡る)。これが全体的に壊れているなら、`Text` を子に持つ TouchableOpacity は**アプリ中ほぼ全部**押せないはずである(ドロワーのセッション行、モーダルの選択肢、送信ボタン等)。ユーザー報告は 3 箇所に限定されており、**「TouchableOpacity+子ビュー」という括りは共通原因の説明として弱い**。

### 3.3 新仮説: 3 箇所の真の共通点は「ポップアップチャット環境」(推測、ただし構造的裏付けあり)

確認済みの構造:

- スラッシュメニューは `presentation="inline"` の絶対配置 overlay で、**ミニボードポップアップモードでしか表示されない**(`ChatScreen.tsx:2707-2713`、`SlashCommandSelectMenu.tsx` の inlineOverlay zIndex:1000)。
- Git 差分ボタンのあるヘッダーには `popupHeaderPanResponder.panHandlers` が付く(`ChatScreen.tsx:1788` と `:1841` の 2 箇所)。ただし奪取条件は `dy > 12 && dy > |dx|*1.2` の move 判定(:300-306)なので、静止クリックを奪う設計にはなっていない(=PanResponder 犯人説は計測で棄却される可能性が高い)。
- ポップアップ全体は reanimated の `Animated.View`(transform: translateY、サイズ補間)の内側にある(`PopupChatOverlay.tsx:200-232`)。transform とネイティブ hitTest(`RCTViewComponentView.mm:784` の「classic textbook implementation」)の整合が崩れると「描画位置と当たり判定がずれる」症状になり得る。
- macOS の `AppModal` は本物のモーダルではなく**同一ツリー内 overlay**である(`AppModal.macos.tsx` 冒頭コメント: RN macOS 0.81.9 の標準 Modal がクラッシュするための代替)。
- 追加の環境要因: メインウィンドウは Skia ボード+gesture-handler(pinch/tap パッチ入り)の上にポップアップが載る構成。

この仮説は §5.2 のユーザー実験(コード変更ゼロ)で 5 分で白黒がつく。

### 3.4 その他の確認済み事実

- `RCTViewComponentView` は初期化時 `mouseDownCanMoveWindow = YES`(:92)、`acceptsFirstMouse = NO`(:767)。非アクティブウィンドウへの 1 クリック目はボタンに届かない(これは全ボタン共通の macOS 仕様であり、「毎回押せない」の説明にはならないが、体感の「たまに効かない」を混入させる)。
- multiline TextInput の実体は NSTextView で、mouseDown で選択のためのトラッキングループを回す。全画面ボタンは TextInput の直上に絶対配置(`ChatComposerInput.tsx:109-118`、`styles.chatComposerExpandButton`)。フォーカス中のクリックで blur → 再レンダーが mouseDown〜mouseUp の間に挟まる競合は残っている(常時 mount 化で unmount は防いだが、レイアウト変化までは防いでいない)。

---

## 4. 仮説一覧と判定基準(分岐木)

各仮説に「確定/棄却できる観測」を定義する。**観測が取れるまでどの仮説も確定しない**(引き継ぎ資料の禁止事項と同方針)。

```
H0 新ビルドが実行されていない(検証プロセス欠陥)
 └ 判定: §5.1 のビルドスタンプが UI に出るか。出ない → プロセス管理を直して再検証(全仮説やり直し)
H1 環境仮説: ポップアップチャット環境が原因(§3.3)
 └ 判定: §5.2 実験で「通常チャットでは 3 ボタンが押せる ∧ ポップアップでは押せない」→ 確定
    ├ H1a reanimated transform と hitTest の不整合
    │   └ 判定: N2 ログで「クリック座標のネイティブ hit view が期待ビューとずれている」
    ├ H1b overlay の重なり順・pointerEvents で別ビューが食っている
    │   └ 判定: N2 ログで hit view が backdrop / 別 overlay になっている
    └ H1c ヘッダー PanResponder の responder 奪取
        └ 判定: J1 ログで RESPONDER_GRANT 後に RESPONDER_TERMINATED が出る
H2 ボタン個別仮説(通常チャットでも押せない場合)
    ├ H2a 全画面ボタン: blur → 再レンダーが press を殺す
    │   └ 判定: J1 で GRANT は出るが RELEASE 前に途切れる+N2 で mouseUp 時の hit view が変わる
    ├ H2b スラッシュメニュー: backdrop Pressable が先に onPress(閉じるだけ)
    │   └ 判定: J2 で option の onPress は出ず、backdrop の onClose だけ出る
    └ H2c Git 差分ボタン: ヘッダー領域の window drag / 別レイヤー
        └ 判定: N2 で mouseDown 自体が RCTSurfaceTouchHandler に届かない
H3 responder 経路がそもそも macOS で onPress まで到達していない(全域欠陥)
 └ 判定: 「正常に押せているボタン」(例: マイク)で J1 を取り、RESPONDER_RELEASE→onPress が
    出ているか。出ていれば H3 棄却。出ていなければ targetIsDescendant 系の方向が正当化される
    (ただしその場合も §4.6 の二重発火チェックが必須)
```

### 4.6 targetIsDescendant パッチの二重発火リスク(設計上の欠陥候補)

H3 が棄却された(= responder 経路は生きている)場合、子ビューを hit したクリックは、
1. responder 経路: touchEnd → Pressability `RESPONDER_RELEASE` → `onPress`
2. click 経路: 親ビューの `mouseUp:` が `targetIsDescendant=true` の Click を emit → パッチ後の `onClick` フォールバック → `onPress`

の**両方**を発火させ得る。パッチが二重発火を防いでいるのは「direct target のとき」だけである(`Pressability.js:573-604` を実読して確認)。つまりこのパッチは「responder 経路が死んでいる世界」でのみ安全で、その世界観はまだ証明されていない。**計測プロトコルに「正常なボタンで onPress が 2 回出ないこと」を必ず含める。**

---

## 5. 検証プロトコル

### 5.1 ステップ 0: ビルド同一性の証明(必須・最初)

1. ビルド時に一意 ID を埋め込む: 例として `expo/src/features/app/buildStamp.ts` を生成(`BUILD_STAMP = "<git short SHA>+<build 時刻>"`)し、ビルドスクリプトで書き換える。
2. **UI に表示する**: チャットヘッダーまたは設定画面の隅に `BUILD_STAMP` を小さく表示(ログだけでは「見ていない」事故が再発する)。
3. 起動手順を固定化: Cmd+Q で完全終了 → `pgrep -fl bitty` で 0 件確認 → 新 Release を起動 → `ps -o pid,lstart,command -p $(pgrep bitty)` と UI のスタンプ一致を記録。
4. ユーザーが 3 ボタンを再確認。**ここで直っていれば以降は不要**(過去の修正のどれかが実は有効だった、が結論になる)。

### 5.2 ステップ 1: コード変更ゼロのユーザー実験(5 分)

新ビルド確認済みの状態で、次のマトリクスを記録する:

| 操作 | ポップアップチャット | 通常チャット(ドロワーから開く) |
|---|---|---|
| Git 差分ボタン | ? | ? |
| 全画面ボタン | ? | ? |
| スラッシュ option | ? | (通常モードでは modal 表示。そちらの option) |
| 対照: チャットタイトルメニューを開くボタン(同じヘッダー内) | ? | ? |
| 対照: タイトルメニュー内の選択肢(スラッシュと同一構造) | ? | ? |
| 対照: マイク/送信ボタン | ? | ? |

- 「ポップアップだけ全滅」→ H1 確定、§6.1 へ。
- 「両方で 3 ボタンだけ死ぬ」→ H2 系、§6.2 へ。
- 「対照ボタンも死んでいる」→ H3 系、§6.3 へ。

### 5.3 ステップ 2: 一時ログ(1 クリックをネイティブ→JS→handler まで追跡)

すべて一時実装。`#define BITTY_CLICK_TRACE 1` / `const CLICK_TRACE = true` で括り、計測後に除去する。相関キーはネイティブ `event.timestamp` と JS `nativeEvent.timestamp`。

**N1: 入口**(`RCTSurfaceTouchHandler.mm` `mouseDown:`(:444)/`mouseUp:`(:500 付近)):
`NSLog(@"[CT] %s ts=%f loc=%@", down/up, event.timestamp, NSStringFromPoint(event.locationInWindow))`

**N2: hit 解決**(`CreateTouchWithUITouch`(:109-130 付近)):
hit した `componentView`(class 名+tag)と、emitter 解決後の target tag を出す。→ H1a/H1b はここで判定(クリック座標に対して hit view が期待どおりか)。

**N3: click emitter**(`RCTViewComponentView.mm` `mouseUp:`(:2209)):
`self.tag`、`hasClickEventHandler`、`targetIsDescendant`、hitView class を出す。

**J1: Pressability**(`Pressability.js` `_receiveSignal` と `onClick` 入口):
signal 名、prevState→nextState、`event.nativeEvent.timestamp`、onClick では `targetIsDescendant` / `currentTarget===target`。→ H1c/H2a/H3 判定。GRANT→RELEASE が揃って onPress まで行くか、TERMINATED で死ぬかを見る。

**J2: 最終 handler**(3 箇所+対照 1 箇所):
- `openGitDiffPanel`(`ChatScreen.tsx:1293`)
- `onOpenFullscreen` 経由 `openComposerFullscreenForView`(`ChatScreen.tsx` composer 部)
- `SlashCommandSelectMenu` option の `onPress` と backdrop の `onClose`(両方に入れて H2b を判定)
- 対照: マイクボタンの handler。**onPress の発火回数も記録**(§4.6 の二重発火チェック)。

### 5.4 判定の締め

1 クリックごとに N1→N2→(N3)→J1→J2 の到達点を表にし、**最初に途切れた層**を原因層として 1 つに絞る。層が確定するまで §6 の修正は書かない。

---

## 6. 原因別の修正設計

### 6.1 H1(ポップアップ環境)だった場合

- **H1a(transform と hitTest の不整合)**: アニメーション終了時に transform を identity に戻し、静止状態は width/height/left/top のレイアウト指定だけにする(`PopupChatOverlay.tsx` の `animatedCardStyle` / `animatedContentStyle` を「アニメ中のみ transform、静止時は layout」に再構成)。rn-macos の `hitTest:` に手を入れるのは影響範囲が広いため第二候補。
- **H1b(overlay 重なり)**: 計測で特定された食い犯ビューに `pointerEvents` を正しく設定する。個別ボタンへの workaround ではなく、overlay コンテナ側で直す。
- **H1c(PanResponder)**: ヘッダー全体ではなく専用ドラッグハンドル(グラバー)に `panHandlers` を移すか、macOS では `onMoveShouldSetPanResponder` を無効化する(macOS のポップアップ移動はタイトルバー相当の操作に限定)。

### 6.2 H2(ボタン個別)だった場合

- **H2a(全画面ボタン)**: blur 起因の再レンダーで button の frame/style が変わらないよう、`showFullscreenButton` 定数化(済)に加えフォーカス状態でスタイルを変えない。それでも駄目なら button を TextInput と兄弟の独立レイヤーに出す。
- **H2b(スラッシュメニュー)**: backdrop が勝っているなら、option 側の responder 主張(`onStartShouldSetResponder`)より前に backdrop の onClick が走っている証拠のはず。修正は「backdrop の onPress を macOS では `onClick` ではなく responder 経路に限定する」or backdrop を `Pressable` から「card 領域を除外した hit 領域」に変える。
- **H2c(Git 差分ボタン)**: mouseDown が surface に届いていないなら、`mouseDownCanMoveWindow`(`RCTViewComponentView.mm:92` で既定 YES)によるウィンドウドラッグ食いを疑い、ヘッダー配下のビューで NO を指定するプロパティ経路を通す。

### 6.3 H3(responder 経路の全域欠陥)だった場合のみ

targetIsDescendant 方式を本採用する。ただし §4.6 の二重発火を塞ぐため、フォールバック発火時に同一 timestamp の responder 経由 press を抑止する(または responder 経路が死んでいることが確定しているので onClick 一本に寄せる)。**このケースでのみ現行パッチを活かし、それ以外では撤回する。**

### 6.4 共通の後始末

- 一時ログ(N1〜N3, J1, J2)を全て除去する。
- ビルドスタンプは恒久化してよい(再発時の切り分けが桁違いに速くなる)。目立たない場所に残す。
- `node_modules` を直接編集した場合は必ず patch-package で patch に反映し、`git diff --check` と patch の reverse/apply 確認を通す。
- `docs/.uncommitted-diff-snapshot.patch`(調査用スナップショット)は削除してよい。

---

## 7. リスクと撤退基準

| 施策 | 主なリスク | 撤退基準 |
|---|---|---|
| targetIsDescendant パッチ維持 | 正常ボタンの二重発火(§4.6)、上流更新のたびに patch 保守 | 対照ボタンで onPress 2 回が観測されたら即撤回。H3 が棄却されたら撤回 |
| PopupChatOverlay の transform 再構成 | アニメの質感劣化、iOS への波及 | iOS 側スナップショット/実機で見た目回帰があれば differential(Platform 分岐)に切り替え |
| PanResponder のハンドル化 | ポップアップを掴んで動かす操作性の変化 | ユーザーが操作性 NG と言えば macOS のみ挙動分岐 |
| backdrop の hit 領域変更 | メニュー外クリックで閉じない回帰 | 全プラットフォームのメニュー閉じ動作を確認、NG なら macOS 限定分岐 |
| 差分の分割取り込み(§2.1) | 分割時のコンフリクト・取り違え | 意味単位で 1 コミットずつ、各コミットごとに typecheck+対象テスト |

**全体の撤退基準**: ステップ 2 の計測を 2 セッション(目安 2〜3 時間)行っても「最初に途切れる層」が特定できない場合は、それ以上パッチを重ねず、rn-macos の upstream issue 起票+最小再現リポジトリ作成に切り替える(iOS キーボード問題で upstream #4006 に辿り着いた前例と同じ進め方)。

---

## 8. 実施チェックリスト(次担当者向け)

1. [ ] §5.1 ビルドスタンプ実装 → Release ビルド → 完全終了 → 起動 → スタンプ一致を記録
2. [ ] ユーザーに 3 ボタン再確認を依頼(直っていればここで終了・§2.1 の分割取り込みへ)
3. [ ] §5.2 実験マトリクスをユーザーに依頼し記録
4. [ ] 分岐(H1/H2/H3)に応じて §5.3 の一時ログを入れて 1 クリック追跡
5. [ ] 原因層 1 つに確定 → §6 の該当設計で修正 → 実機確認(スタンプ確認込み)
6. [ ] 対照ボタンの二重発火チェック(§4.6)
7. [ ] 一時ログ除去、patch 整合確認、§2.1 の独立差分を意味単位でコミット分割
8. [ ] commit / push / PR はすべてユーザー承認後(従来ルール)

## 変更禁止事項(引き継ぎ資料から引き継ぐもの)

- ユーザー承認なしの commit / push / rebase / worktree 削除
- 計測ログなしの推測パッチ追加、個別ボタンへの workaround
- JS テスト成功・ビルド成功を実機修正の証拠とみなすこと
- ウィンドウを閉じただけの「再起動」での動作確認
