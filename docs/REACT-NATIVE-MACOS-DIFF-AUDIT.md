# React Native macOS 差分監査レポート

- 監査日: 2026-08-12
- 対象ブランチ: `feat/react-native-macos`
- 対象コミット: `6372697e824c60e7b25bb8de94e91d7d157166f7`
- 共通祖先: `58447e573e227d370a3b991e3f2259f3eaff308c`
- 監査時の `origin/main`: `23d1f4dd094ab49f90b1627627fca6da06784f23`
- 再統合した `origin/main`: `f270315b88c2dc6ef020fcfcde0be41c4b6ef573`

## 修正結果（2026-08-13）

**技術判定: AUTOMATED CODE / iOS / macOS BUILD BLOCKERS RESOLVED; PR REVIEW READY**

監査で挙げた code、dependency、contract、native build の blocker は次の形で解消した。
iOS / macOS の bundle と native build は最終統合ツリーで成功し、iPhone の主要な視覚・操作は
ユーザー確認済みである。

- `origin/main` を commit せず統合し、通知・バッジと Skia board section の最新 contract を
  macOS 実装と同じ working tree で検証した。再統合では `SkiaBoardContext.tsx` と
  `SkiaMiniBoardScreen.tsx` に実競合が発生し、section 機能と persistence recovery、
  AppModal、Paragraph text、wheel zoom の双方を残して解消した。
- `typecheck:macos` を repository command として追加し、`.macos` 優先 production graph の
  diagnostics を 160 件から 0 件へ解消した。camera、location schedule、pending push、
  push registrar、workspace picker は base/macOS が同じ source contract を参照する。
- audio recording は型だけを偽装せず、macOS の capability flag を action owner で確認して
  recorder 生成前に停止する。playback と unsupported recording の境界も明示した。
- Metro は Expo / React Native の既定 pre-main modules を保持し、macOS bundle だけで
  graph に存在する `InitializeCore` を Expo Winter runtime より前へ追加する。これにより
  Winter runtime が参照する `FormData` を先に初期化する。
- Math の利用箇所がないことを確認し、`react-native-enriched-markdown` を Expo 推奨の
  `0.5.0` へ戻して `enableMath: false` を明示した。
- 依存は実 native compile で必要性を確認した範囲へ限定した。Expo は
  `expo-modules-core@3.0.30` の macOS image type 修正を含む最小 constraint
  `~54.0.34`、Skia は `2.4.21`、SVG は `15.15.5`、Worklets は `0.7.4` を維持する。
  推奨版へ戻すとそれぞれ `UIImage` または macOS display-link API の compile error が
  再現した。`expo-file-system` と `expo-font` は解決された Expo 54.0.36 の推奨版を維持し、
  enriched-markdown は Math 不要のため `0.5.0` へ戻した。
  Release build phase が project root から直接 resolve する `@expo/cli` だけを
  devDependency として明示した。lockfile は `npm install` と `pod update` で再生成した。
- Modal / Drawer は call-site で使用中の最小 contract に狭め、macOS で該当しない props は
  platform boundary で明示的に受理した。既知の upstream 障害と削除条件を実装箇所に残し、
  consumer 側の OS 分岐は追加していない。macOS Modal の Escape は、focus されない個別
  overlay ではなく app と overlay の共通祖先で capture し、最上位 modal のみを閉じる。
- HTTP 未読 snapshot の取得・型を native 通知処理から分離し、共通 lifecycle owner が
  runner 接続後の初期表示、AppState active 復帰、再接続時に同期する。iOS だけが badge /
  delivered notification を native boundary で処理し、macOS bundle に `expo-notifications` が
  含まれないことを確認した。
- Legend patch の未使用 `index.mjs` hunk を削除し、handoff 文書の stale な branch 状態を
  更新した。
- Skia の共通 text renderer と persistence recovery は共通の不具合修正として維持し、
  platform ごとの症状 patch は追加しなかった。main の section label も同じ Paragraph
  renderer へ統一し、section editor は既存 AppModal boundary を使う。section tool の作成・
  移動・resize・編集を含む全 Jest が通っている。iOS の section editor は label 外の touch で
  keyboard を閉じ、label 自体の touch では編集 focus を維持する。描画用 Paragraph は React cleanup から
  同期 `dispose()` せずSkiaの描画寿命に任せ、計測専用 Paragraph だけを即時破棄する。

自動検証結果:

- `npm run typecheck`: PASS
- `npm run typecheck:macos`: PASS（0 diagnostics）
- `npm test -- --runInBand --silent`: PASS（106 suites / 766 tests）
- iOS / macOS development bundle: PASS（InitializeCore → Expo Winter → main の順序を確認）
- `node --test private_runner/tests/*.test.mjs`: PASS（353 tests、352 pass / 1 skip）
- iOS Debug arm64 native build: PASS（unsigned generic device）
- macOS Debug arm64 native build: PASS
- macOS Release arm64 native build: PASS（bundle + Hermes compile）
- clean `npm install` / CocoaPods update / patch reverse applicability: PASS

既知の設計差として、macOS Modal は native Modal と同等の focus / accessibility isolation を
提供せず、共通祖先で Escape を捕捉する軽量 overlay である。現行動作は手動確認済みだが、
React Native macOS または関連 library 更新時には stock Modal / Drawer への置換可否を再評価する。

## 監査時点の結論

以下は修正前スナップショットの判定である。現在の判定は上記「修正結果」を正とする。

**運用状態: PUSH PAUSED**

**技術判定: MERGE / RELEASE HOLD**

`PUSH PAUSED` は、先に本レポートを作成して確認するというユーザー指示に基づく運用
状態である。未解消事項を共有するための feature branch push 自体が技術的に不可能と
いう意味ではない。main への merge または release 可否は、別の技術判定として HOLD
とする。この監査では commit と push を実行していない。

macOS 専用実装が iPhone の JavaScript バンドルや native autolink に混入する
問題は確認されなかった。一方で、このコミットは macOS 専用差分だけではなく、iOS
でも使う依存基盤、Skia 描画、永続化、Modal 経路などを変更している。したがって、
現時点では「iPhone に影響が出ない」とは保証できない。

main への merge または release 前に、最低限次を完了する必要がある。

1. 最新 `origin/main` の iOS 通知・バッジ修正を統合し、重複変更を再確認する。
2. Expo SDK 54 の推奨範囲から外れた依存更新を最小化または明示的に承認する。
3. `react-native-enriched-markdown` の Math 要件と iOS native 設定を決め、build で確認する。
4. `.macos` を優先する TypeScript contract audit の 160 diagnostics を解消する。
5. iOS native build と Simulator または実機で共通 UI の回帰確認を行う。
6. macOS Modal/Drawer の既知障害を再現可能な形で記録し、実装契約を必要最小限へ狭める。

大規模な「macOS 版と iPhone 版のコピペ」はない。多くの `.macos.ts(x)` は、
macOS で未対応の native module を依存グラフから切り離すための妥当な platform
boundary である。Modal と Drawer の 249 行も、macOS純正経路の具体的障害を避けるため
同じplatform boundaryへ集約されており、現時点では維持する。ただし実装していない
propsを型上受理しないようcontractを狭め、library修正後は削除する。

## 監査範囲

`origin/main...HEAD` は最新 main との差ではなく、共通祖先から macOS コミットまでの
差分を示す。この範囲は 107 ファイル、11,184 行追加、1,179 行削除である。

| 分類 | ファイル数 | 追加 / 削除 |
| --- | ---: | ---: |
| `expo/macos/**` native project | 17 | +5,127 / -0 |
| `.macos.ts(x)` | 15 | +580 / -0 |
| dependency patch | 4 | +482 / -0 |
| macOS 文書 | 2 | +616 / -0 |
| 共通 `expo/src/**` | 64 | +865 / -380 |
| package/config/lock/その他 | 5 | +3,514 / -799 |

最新 `origin/main` はこのブランチより 1 コミット先にあり、ブランチは
`ahead 1, behind 1` である。`AppRoot.tsx`、`AppDrawer.tsx`、
`AppDrawer.test.tsx` は両側で変更されている。read-only の `git merge-tree` では
conflict marker は生成されなかったが、最新 main は iOS の未読・通知・バッジの
意味的変更を含むため、自動マージ可能であることを安全性の証明にはできない。

## iPhone 影響の監査

### macOS へ閉じていることを確認できた差分

| 差分 | iPhone への評価 | 根拠 |
| --- | --- | --- |
| `react-native-macos+0.81.9.patch` | 直接影響なし | iOS bundle/autolink の対象外。追加実装も `TARGET_OS_OSX` 内 |
| `react-native-gesture-handler+2.28.0.patch` | runtime 影響なし | Command+wheel 実装は `TARGET_OS_OSX` 内。iOS 側は既存 pinch 経路を使用 |
| `@legendapp+list+2.0.19.patch` | 現在の iOS 挙動は不変 | `Platform.OS === "macos"` の場合だけ position 実装を変更 |
| `expo-secure-store+15.0.8.patch` | iOS 挙動は不変 | podspec に `:osx => '14.0'` を追加しただけ |
| 15 個の `.macos.ts(x)` | iOS bundle へ混入なし | iOS source map で `.macos.*` は 0 件、base 実装が選択された |
| `react-native-macos` package | iOS bundle へ混入なし | iOS source map で `react-native-macos` は 0 件。temp prebuild でも iOS autolink 対象外 |
| Skia wheel zoom | iOS pinch 更新は従来どおり | `SkiaMiniBoardScreen.tsx:861` の `Platform.OS === "macos"` かつ 1 pointer の場合だけ `withTiming` |

iOS production export は 2,025 modules で成功した。source map は 2,032 sources で、
`react-native-macos` と `.macos.*` はどちらも 0 件だった。次の base 実装が iOS 用に
解決されていることも確認した。

- `audio.ts`
- `camera.ts`
- `clipboard.ts`
- `keyboardController.ts`
- `networkState.ts`
- `AppModal.tsx`
- `AppDrawerLayout.tsx`
- `AppScreenContent.tsx`
- `workspaceUploadPicker.ts`

### iOS bundle に到達する共有差分 — 確認済み仕様変更と未検証リスク

#### 1. 依存基盤の同時更新 — merge/release blocker

`expo/package.json` は macOS package の追加だけでなく、iOS でも使う主要 package を
同時に更新している。

| package | 変更前 | 変更後 |
| --- | ---: | ---: |
| `@shopify/react-native-skia` | 2.2.12 | 2.4.21 |
| `expo` | 54.0.33 | 54.0.36 |
| `expo-file-system` | 19.0.21 | 19.0.23 |
| `expo-font` | 14.0.11 | 14.0.12 |
| `react` | 19.1.0 | 19.1.4 |
| `react-native` | 0.81.5 | 0.81.6 |
| `react-native-enriched-markdown` | 0.5.0 | 0.7.4 |
| `react-native-svg` | 15.12.1 | 15.15.5 |
| `react-native-worklets` | 0.5.1 | 0.7.4 |
| `react-test-renderer` (dev) | 19.1.0 系 | 19.1.4 |
| `@react-native-community/cli` (dev) | なし | 20.0.0 |

`react-native-macos@0.81.9` が `react@^19.1.4` と
`react-native@0.81.6` を peer dependency に持つため、React/RN 更新の理由自体は
理解できる。しかし、Expo SDK 54 の bundled native modules は React 19.1.0、
RN 0.81.5、Skia 2.2.12、SVG 15.12.1、Worklets 0.5.1 を推奨している。

offline の `expo install --check` でも、今回新たに変更した Skia、React、RN、SVG、
Worklets の 5 系統を推奨外と警告した。`expo-clipboard` と
`react-native-keyboard-controller` への警告も出たが、
この 2 件は変更前から存在するため、今回の差分によるものではない。

lockfile は 204 package entry 追加、7 削除、既存 134 entry の version/resolution
変更を含む。macOS package 追加だけでは説明できない広さであり、iOS native build
を通さずに安全とは判定できない。

推奨対応:

- Expo 推奨の RN 0.81.5 と整合する `react-native-macos` 版が利用可能か確認する。
- 現在の組み合わせが必須なら、依存 alignment を独立コミットにして iOS native
  build と実機確認の責任範囲を明確にする。
- 最新 main を取り込んだ clean install から lockfile を再生成し、意図しない
  semver 更新が残っていないか再比較する。lockfile の手編集はしない。

#### 2. `react-native-enriched-markdown` の iOS 設定不足 — merge blocker 候補

`app.json:38` は plugin を文字列で指定しているため、0.7.4 で追加された LaTeX
Math/RaTeX が既定で有効になる。同 package の podspec と同梱資料は、Math 有効時の
iOS build に `use_frameworks! :linkage => :dynamic` が必要だと明記している。

一方、macOS の Podfile だけは `ENRICHED_MARKDOWN_ENABLE_MATH=0` を設定しているが、
この設定は iOS prebuild へは伝わらない。source 内に Math の明示利用は見つからないが、
chat 本文は動的入力なので `$...$` / `$$...$$` が含まれる可能性はある。LaTeX 表示を
製品要件にしておらず、旧 0.5 系に近い挙動を維持するなら、最小の対応候補は plugin を
次の形にして iOS/Android の Math native dependency を無効化することである。

```json
[
  "react-native-enriched-markdown",
  {
    "enableMath": false
  }
]
```

これは package contract 上で確認できる設定リスクだが、CocoaPods と Xcode iOS build
が完走しておらず、実際の iOS build failure は未確認である。`enableMath: false` は
LaTeX 表示を無効化する product tradeoff を伴うため、要件確認後に適用する。解決までは
native build blocker 候補として扱う。

#### 3. Skia の共通描画変更 — iPhone 実挙動変更

`SkiaMiniBoardScreen.tsx:76-130` と `:299-420` は、iOS でも次を変更する。

- `matchFont` / Skia `Text` / `Hiragino Sans` から `Paragraph` と
  `.AppleSystemUIFont` fallback へ変更
- 文字幅計測を `Paragraph.getLongestLine()` へ変更
- メッセージ中の改行を含む連続空白を 1 個の空白へ正規化
- card title、body、footer の baseline と clipping を変更

日本語・emoji fallback を iOS/macOS 共通で直す目的は妥当だが、renderer、layout、
空白 semantics は iPhone でも確実に変わり、見た目と描画性能も変化し得る。Jest は
native font rendering、glyph fallback、実フレーム時間を検証しない。

iPhone を厳密に従来どおりにする必要がある場合は、画面全体を複製せず、text renderer
だけを platform boundary に分ける。共通改善として採用する場合は、iPhone で日本語、
emoji、長文、省略、文字倍率、pinch 中のフレーム pacing を手動確認して承認する。

#### 4. Skia 永続化の共通仕様変更

`SkiaBoardContext.tsx:48-146` は、保存データの read に失敗した場合、従来の
「未ロードのまま」から次の挙動へ変更する。

- in-memory では board を利用可能にする
- update function を queue する
- 後続操作で read を再試行する
- read 回復後に保存済み state へ queue を replay する

テストがあり、macOS の SecureStore/read 障害への対策として設計は筋が通っている。
ただし iOS の一時的 read error 時の仕様も変えるため、macOS 限定差分ではない。
共通 bug fix として明示するか、iPhone の read failure/recovery test と実機確認を
受け入れ条件に含める。

#### 5. その他の共通 UI 差分

- `AppDrawer.tsx` は Skia board 未ロード時、action を非表示から disabled 表示へ変更。
- `AppScreenContent.tsx` は旧 `styles.safeArea` から `{ flex: 1 }` へ変わり、この component
  自身の白背景指定を失っている。現在は親 `View` も白背景だが、単体利用時を含む視覚的
  回帰は未確認である。
- `App.tsx` は全 app を `AppModalHost` で包む。iOS base 実装は children をそのまま
  返すため現在の実害は見つからないが、root component tree は変更される。
- 変更対象の 22 個の `Modal` call site（16 consumer files）は `AppModal` 経由になった。
  iOS base は native `Modal` への pass-through だが、native presentation の実機テストは
  未実施。location schedule 配下の 3 call site は生の RN `Modal` のままだが、現在の
  macOS production graph では上位 component が stub 化され到達不能である。
- workspace picker の抽出は、iOS の既存ロジックを同じ内容で移動しただけであり、
  macOS 非対応境界を作る変更として妥当。

## macOS / iPhone コード重複の監査

### 残すべき platform boundary

以下は iPhone 実装のコピペではなく、OS 差または native module 非対応を 1 か所で
吸収するための差分である。call site に `Platform.OS` を散らすより現在の形が単純で、
削除や無理な共通化は推奨しない。

- `audio.macos.ts` と `BittyAudioModule.mm`: expo-av 非対応を native audio owner で吸収
- `clipboard.macos.ts`: macOS clipboard API の差
- `camera.macos.ts`: unsupported feature を graph boundary で無効化
- `keyboardController.macos.ts`: unsupported native provider を React Native 標準へ縮退
- `networkState.macos.ts`: unsupported listener の no-op boundary
- `workspaceUploadPicker.macos.ts`: unsupported picker を明示
- `calendarService.macos.ts`: calendar feature の unavailable 契約
- push、background notification、location の短い macOS stub

`AppScreenContent.tsx` と `AppScreenContent.macos.tsx` には screen switch の小さな重複が
あるが、macOS 版は Skia Canvas を screen 遷移中も mount したまま保つという実際の
lifecycle 差を持つ。共通 helper を追加しても読むファイルが増えるだけなので、現在の
局所的重複を許容する方が単純である。

### 純正機能を回避する macOS platform boundary

#### `AppModal.macos.tsx` — 147 行

React Native macOS 0.81.9 には JavaScript `Modal` と Fabric の
`RCTModalHostViewComponentView` が存在する。ただし実装者報告では、ディレクトリ追加
などから純正 Modal を開くと Fabric の `createNode` 周辺で
`Exception in HostFunction` が発生し、特定画面ではなくmacOS native presentation
経路で再現した。この監査では再現を独立確認していないが、`AppModal.macos.tsx` へ
集約した回避理由として具体性があり、現時点では削除対象としない。iOS は base
`AppModal.tsx` から従来の純正 Modal を使う。

自前版は in-tree overlay、host map、animation lifecycle を再実装しているうえ、型は
`ModalProps` 全体を受け取るのに、`onRequestClose`、`presentationStyle`、
`statusBarTranslucent` などを無視する。Escape、accessibility focus、native window、
複数 modal、unmount 中 animation の契約も純正とは異なる。

#### `AppDrawerLayout.macos.tsx` — 102 行

`react-native-drawer-layout@4.2.2` 自体が `Platform.OS === "macos"` を認識し、
macOS では swipe を既定で無効にする実装を持つ。ただし実装者報告では、クリック判定の
ずれ、幅の 10〜20% しか開かない、開閉のカクつき、背面のzoom操作等へ入力が抜ける
問題が発生した。これを幅・hit area・animationを一つのmacOS boundaryで管理する
`AppDrawerLayout.macos.tsx` へ置き換えた理由は妥当であり、現時点では削除対象としない。
iOS は base `AppDrawerLayout.tsx` から従来の library 実装を使う。現在の自前版は `onOpen`、
swipe/gesture 系 props、`drawerPosition`、`drawerType` などを受け取る型なのに無視する。
`AppRoot` が `swipeEnabled` を渡しても macOS custom layout では edge swipe にならない。

推奨対応:

1. 上記再現条件、OS/library version、stack traceを文書化し、可能ならupstream issueへ
   切り出す。
2. 自前実装の props 型を実際に実装・利用する subset へ狭める。利用中の
   close/accessibility/input blocking 契約は明示テストする。
3. library更新時だけstock版を再A/Bし、問題が解消した時点でmacOS実装と関連hostを
   削除する。画面側へOS分岐を散らしたり、iOS実装を複製したりしない。

実装時に、理由がコードから消えないよう次の通常コメントを追加する。無効化したコードを
コメントアウトして残すのではない。

- `AppModal.macos.tsx`: import群の直後、`type ModalHost` の直前

```ts
// React Native macOS 0.81.9の標準Modalは、表示時にFabricのcreateNode周辺で
// Exception in HostFunctionが発生するため、同じReactツリー内のoverlayで代替する。
// ライブラリ更新時に標準Modalを再検証し、解消後はこの実装を削除する。
```

- `AppDrawerLayout.macos.tsx`: import群の直後、`type AppDrawerLayoutProps` の直前

```ts
// react-native-drawer-layout 4.2.2はmacOSでクリック領域と表示幅がずれ、
// 開閉がカクつき、閉じた領域から背面へ入力が抜けるため、このlayoutで代替する。
// ライブラリ更新時に標準Drawerを再検証し、解消後はこの実装を削除する。
```

baseの `AppModal.tsx` と `AppDrawerLayout.tsx` はiOSで純正実装をそのまま使う薄いplatform
entryなので、障害の詳細を重複記載しない。必要なら「macOSの理由は同名 `.macos.tsx` を
参照」と1行だけ記載する。

### macOS platform graph の型契約検査失敗 — merge blocker

通常の `npx tsc --noEmit` は extensionless import に対して base `.ts(x)` を解決し、
`.macos.ts(x)` の実装契約を検査しない。production entry の macOS variant を優先して
検査したところ、production dependency graph 内の 28 source files に 160 diagnostics が
発生した。これは native build failure ではなく、macOS variant と共有 call site の
TypeScript contract audit failure である。

監査では repository を変更しないよう config を
`/private/tmp/bitty-macos-tsconfig.json` に置き、`extends` と `files` にはこの worktree の
absolute path を指定し、`expo/` から次を実行した。

```sh
./node_modules/.bin/tsc --noEmit --pretty false -p /private/tmp/bitty-macos-tsconfig.json
```

別環境で再現する場合は、次の同等 config を一時的に
`expo/tsconfig.macos-audit.json` として保存する。

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "moduleSuffixes": [".macos", ".native", ""]
  },
  "files": ["./App.tsx"]
}
```

`expo/` から実行する。

```sh
./node_modules/.bin/tsc --noEmit --pretty false -p ./tsconfig.macos-audit.json
```

diagnostic code の内訳は `TS2503=110`、`TS2339=26`、`TS7006=13`、`TS2554=3`、
`TS2322=3`、`TS2345=2`、`TS2698=1`、`TS2305=1`、`TS18046=1` である。多くは
`audio.macos.ts` の contract 欠落から派生する。

代表例:

```text
AppRoot.tsx(840,44): error TS2503: Cannot find namespace 'Audio'.
useManualRecordingController.ts(63,17): error TS2339: Property 'prepareToRecordAsync' does not exist on type 'UnsupportedRecording'.
CloudflareTunnelMonitorScreen.tsx(7,8): error TS2305: Module '"../camera"' has no exported member 'BarcodeScanningResult'.
workspaceFiles.ts(126,27): error TS2339: Property 'size' does not exist on type 'never'.
```

主な原因:

- `audio.macos.ts`
  - base `expo-av` が提供する `Audio.Sound`、`Audio.Recording`、
    `Audio.RecordingStatus` 等の type/namespace surface がない。
  - `Video` が props を受け取らず、`setAudioModeAsync` も引数を受け取らない型になって
    いる。
  - recording hooks は macOS graph に入る一方、`UnsupportedRecording` は constructor
    で即 throw し、共有コードが呼ぶ recording methods も持たない。
- `camera.macos.ts`
  - `BarcodeScanningResult` type export がない。
  - `CameraView` が props を受け取らない型になっている。
- `LocationScheduleSettings.macos.tsx`
  - 共有 `ChatScreen` が渡す 6 props の contract を持たない。
- `usePendingPushSessionNavigationController.macos.ts`
  - 共有 `AppRoot` が渡す設定 object の引数 contract を持たない。
- `workspaceUploadPicker.macos.ts`
  - 戻り値が `Promise<null>` へ狭まり、共有 `workspaceFiles.ts` の後続を `never` と判定
    させる。
- `URLSearchParams.keys()` 周辺に 4 件の RN macOS library type 差由来の error がある。

JavaScript は余剰引数を無視し、unsupported feature の分岐によって一部経路は実行
されないため、この結果だけで起動時 crash が証明されたわけではない。しかし、通常の
`tsc` 成功は iPhone/base graph の成功だけであり、macOS 実装の API parity や共有
call site との整合を保証していない。特に recording UI が macOS でも到達可能なら、
型だけでなく runtime feature gate も必要である。

最小の対応は、production で消費する contract の type を base/macOS 間で共有し、
各 stub の引数、props、戻り値をその contract へ合わせること。未使用 API をすべて
fake 実装する必要はない。audio は対応する playback と非対応の recording を明示的に
分け、共有画面が非対応機能を呼ばない構造にする。最終的に、この macOS suffix 優先
検査を repository の再現可能な command として追加する。

### API parity の個別漏れ

`camera.ts` は `BarcodeScanningResult` type を export するが、
`camera.macos.ts` は export しない。`CloudflareTunnelMonitorScreen.tsx` は extensionless
import からこの type を参照する。TypeScript は通常 base `.ts` を解決するため、現在の
`tsc` 成功だけでは macOS variant の型漏れを検出しない。

この 1 件は type-only re-export で揃える価値がある。一方で、
`locationScheduleRuntime.macos.ts` や `backgroundNotificationTask.macos.ts` は上位 feature
ごと到達不能にしているため、未使用 API の fake stub を機械的に増やす必要はない。
文書の「common と macOS の exports/types を同一にする」は、
「macOS production が消費する surface を一致させる」に狭める方が実態に合う。

## 不要または縮小候補の差分

### 診断ログの混入

実装途中には `RCTEnhancedScrollView.mm` の `scrollWheel:` に wheel event を出力する
診断ログが入っていた。監査時の commit、`react-native-macos+0.81.9.patch`、現在の
`node_modules` には、その `NSLog` / `printf` は残っておらず、今回の差分にも新規の
`console.log` はない。

`.ts/.tsx` の raw diff では `SkiaBoardContext.tsx` の
`console.warn("[skia_board] failed to read persisted board state", error)` が追加行として
1 件見える。ただし同じ warn は変更前の initial read catch に存在し、今回の永続化
復旧処理へ移動したもので、新規のスクロール計測ログではない。test の `warnSpy` 追加も
この既存warnを抑制するためである。現在の committed TypeScript 差分に新規の一時計測
ログは確認されなかった。ただし移動後は後続の board mutation ごとに read recovery を
再試行するため、失敗が続くと同じ warn が反復する可能性がある。運用ログとして不要なら
削除する。必要なら一度だけ記録する仕組みを増やすのではなく、既存 diagnostics 境界へ
寄せるか Debug 時だけに限定し、production console のノイズを残さない。

今後、一時ログを使う場合も patch へ含めない。混入した場合は dependency source から
ログだけを削除し、`expo/` で `npx patch-package react-native-macos` を実行して patch を
再生成する。その後、patch 内にログがないこと、clean install へ patch が適用できる
こと、macOS Debug build が通ることを確認する。入力値の計測が必要なら Debug compile
guard を付け、計測完了後に削除してから commit する。

| 対象 | 判定 | 推奨 |
| --- | --- | --- |
| `@legendapp/list` patch の `index.mjs` hunk | 削減候補 | 現 Expo Metro は `index.js` だけを bundle。別 bundler を対象にしないなら mjs hunk を削除 |
| `@react-native-picker/picker` 削除 | 妥当 | 変更前 source に import なし。未使用依存の削除として維持可能 |
| `lottie-react-native` 削除 | 妥当 | 変更前 source に import なし。現在は image asset を使用 |
| `Podfile.lock` | 必要 | macOS native dependency の再現性に必要。生成物として除外しない |
| `Main.storyboard` | 必要 | `Info.plist` と Xcode project から参照されている |
| `Pods/`、`build/`、`.xcode.env.local` | 正しく除外 | tracked file はなく、`.gitignore` で除外済み |
| macOS AppIcon catalog | 不完全 | `Contents.json` に filename がなく画像もない。generic icon を意図しないなら実 asset を追加 |
| macOS handoff 文書 | 更新必要 | まだ「uncommitted/untracked」と記述し、現在の commit 状態と不一致。push 前に履歴化または簡潔化 |
| package/lock の広い version 更新 | 要最小化 | clean install で再生成し、macOS に必要な更新と偶発的 semver 更新を分ける |

`@legendapp/list` は package metadata と iOS source map の両方で `index.js` が選択されて
いることを確認した。`index.mjs` も変更する理由が「将来別 bundler を使うかもしれない」
だけなら、現在の要件に対する余分な patch surface である。

macOS handoff 文書は、`HEAD` が共通祖先、patch と文書が untracked、作業全体が dirty
worktree であると説明しているが、現在はすべて `6372697` に commit 済みである。
別エージェントが誤って古い前提で作業しないよう、push 前に現状へ更新する必要がある。

## Metro 設定の共通影響

`metro.config.js:20-32` は Expo 既定の
`getModulesRunBeforeMainModule()` の結果を保持している。

- Expo 既定: RN `InitializeCore`、`expo/src/winter/index.ts`
- iOS bundle 実行順: RN `InitializeCore`、Expo Winter runtime、main
- macOS bundle 実行順: RN macOS `InitializeCore`、Expo Winter runtime、main

macOS `InitializeCore` を既定 modules の末尾へ追加すると、Expo Winter runtime が先に
`FormData` を評価し、起動時に `ReferenceError` となる。macOS候補を先頭へ追加すると、
Metro はplatformごとのdependency graph内にある候補だけをpre-mainで実行するため、iOSへ
RN macOS sourceを混入させず上記順序になることを両platformの実bundle末尾で確認した。

platform判定用の環境変数やbootstrap wrapperは追加せず、Metro自身のplatform graph選択を
そのまま利用する。

## 差分衛生と複雑性

良好な点:

- tracked された `Pods`、build、DerivedData、local Xcode env はない。
- repository 内の絶対 build path、実 credential、秘密鍵は見つからなかった。
  secret scan の一致は test fixture の `runner-token` 等だけだった。
- dependency patch 4 個は現在の `node_modules` に対する reverse check がすべて通る。
- committed 差分に対する `git diff --check origin/main...HEAD` は通る。
- 新規 source file に 2,000 行超はない。
- 既に 7,000 行超の `AppRoot.tsx` は screen/layout 責務を platform component へ移し、
  行数を増やしていない。

注意点:

- `AppModal.macos.tsx` と `AppDrawerLayout.macos.tsx` は既知のmacOS障害を避けるための
  再実装である。現時点では維持するが、props contractを狭め、upstream修正後は削除する。
- `SkiaMiniBoardScreen.tsx` は 1,218 行まで増え、text layout と macOS zoom 条件が
  同じ shared screen に入った。2,000 行未満だが、今後さらに platform behavior を
  足す owner にはしない。
- `numberOfPointers === 1` を macOS wheel-origin pinch の印として使っている。
  現状は限定的で動くが、RNGH event 契約上は暗黙的なので文書化が必要である。

## 実行した検証

### 成功

- `npm test -- --runInBand`
  - 101 suites / 707 tests passed
  - 既存の `SafeAreaView` deprecation warning 等のみ
- `npx tsc --noEmit --pretty false`
  - base/iPhone graph の検査として成功
- iOS production export
  - Hermes bytecode export 成功
  - no-bytecode/source-map export 成功
  - 2,025 modules
- iOS source map inspection
  - 2,032 sources
  - `react-native-macos`: 0
  - `.macos.ts(x)`: 0
- temp iOS prebuild
  - prebuild 自体は成功
  - `react-native-macos` は iOS autolink 対象外
- `git diff --check origin/main...HEAD`
- 未追跡の本レポートに対する
  `git diff --no-index --check -- /dev/null docs/REACT-NATIVE-MACOS-DIFF-AUDIT.md`
  - content 差分を表す exit 1、whitespace error の出力なしを確認
- 4 dependency patch の `git apply --reverse --check`
- 変更対象に対する generated file、absolute path、credential の静的確認

### 警告または未完了

- macOS suffix 優先 TypeScript contract audit
  - `moduleSuffixes: [".macos", ".native", ""]`、entry `App.tsx` で
    production graph 内の 28 source files / 160 diagnostics
  - 通常の `tsc` だけでは `.macos` contract を検査できないことを確認
- `EXPO_OFFLINE=1 expo install --check`
  - Skia、React、RN、SVG、Worklets の今回の更新を Expo SDK 54 推奨外と警告
- CocoaPods install
  - dependency 解析途中までは進んだが、local CocoaPods cache の権限制約で完走せず
- macOS Release arm64 / scheme の Profile action
  - `react-native-enriched-markdown` の `BOOL` から `bool` への narrowing error で失敗する
    既知 blocker
  - Profile は Release configuration を使うため、optimized frame pacing は未検証
- Xcode iOS native build: 未実施
- iPhone Simulator / 実機: 未実施
- iPhone の Skia font、pinch、Modal、Drawer、Markdown、音声: 未確認
- 実装者報告の stock macOS Modal/Drawer 障害の独立再現: 未実施
- 最新 `origin/main` 統合後の test/build: 未実施

以前の同一コード差分では macOS Debug arm64 build が成功しているが、この監査では
文書以外を変更していないため再実行していない。macOS の実 mouse feel と iPhone の
実 UI を自動テスト成功で代替してはならない。

## merge / release 前の必須手順

1. `origin/main` を取り込み、`AppRoot`、`AppDrawer`、通知 lifecycle の意味的統合を
   確認する。
2. package 組み合わせを決める。
   - Expo 推奨へ戻せる package は戻す。
   - macOS に必須の逸脱は理由を記録し、独立コミットにする。
   - enriched-markdown は Math を使わないなら `enableMath: false` にする。
3. Metro の Expo 既定 pre-main modules を保持する。
4. macOS suffix 優先 TypeScript check を正式化し、production contract error を解消する。
   audio recording の非対応経路は runtime でも呼べないようにする。
5. `camera.macos.ts` を含む production type surface を揃える。
6. macOS Modal/Drawer の既知再現条件を記録し、受理 props を実装 subset に狭める。
   library 更新時にstock版を再A/Bし、直っていれば自前実装とhostを削除する。
7. stale handoff 文書を現在の commit 状態へ更新し、未使用の Legend `index.mjs` hunk を
   残す理由がなければ削除する。
8. clean install から iOS prebuild、Pod install、Debug Simulator build を行う。
9. iPhone で次を確認する。
   - Drawer open/close と context menu
   - native Modal の表示、閉じる操作、fullscreen editor
   - Skia 日本語/emoji/長文/文字倍率
   - 二本指 pinch の焦点、範囲、フレーム pacing
   - Markdown 表示
   - TTS/録音
   - workspace photo/file picker
   - 最新 main の通知 tap、未読、badge
10. 全 Jest、base/macOS TypeScript、iOS build、macOS Debug build、patch clean application、
   `git diff --check` を最終差分で再実行する。
11. その結果を本書へ追記し、`MERGE / RELEASE HOLD` を解除する。

未解消事項を共有するため feature branch を push する場合は、本レポートも commit し、
技術判定が HOLD のままであることを commit/PR 上で明示する。push 自体はユーザー確認後に
別工程として行う。

## 最終評価

platform file resolution と native compile guard は概ね正しく、macOS 専用コードが
iPhone へ直接入り込む構造にはなっていない。短い `.macos` stub を共通 `Platform.OS`
分岐へ戻す必要もない。

現在の問題は、macOS port と同時に iOS の依存・描画・永続化・root UI を変更している
ことと、それに対する iOS native/実機 gate が未完了なことである。まず差分をさらに
platform 分割するのではなく、依存更新を狭め、自前 library 再実装のcontractを狭め、
残る共有変更を iPhone で明示的に承認するのが最も単純で安全な進め方である。
