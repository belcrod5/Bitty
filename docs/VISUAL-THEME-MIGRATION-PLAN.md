# 視認性・可読性を重視したテーマ切替 修正計画

作成日: 2026-09-18

対象: `expo/` の React Native / React Native macOS UI

状態: 実装と自動検証完了。G5のiOS/macOS目視確認のみ未実施

実装結果（2026-09-18）:

- 「標準」「高視認性」の切替UI、即時反映、保存・読込・インポート・エクスポートを実装
- 通常UI、モーダル、Markdown、Mermaid、Skia、WebView、補助画面をsemantic theme tokenへ移行
- 色、文字サイズ、境界線の太さを `visualThemes.ts` に集約
- Jest: 151 suites / 1,177 tests 成功（全体1,176件成功後、追加したインポート検証1件も成功）
- iOS / macOS TypeScript型検査: 成功
- `git diff --check`: 成功
- 残る固定色は、ユーザーが選択・保存するマーカー/セクション色と、Skia文字幅計測用の非表示色だけ
- 起動中のiOSシミュレータがないためiOS smokeとmacOS目視確認は未実施

実装開始時の基準（2026-09-18）:

- Jest: 147 suites / 1,162 tests 成功
- `npm run typecheck`: 成功
- `npm run typecheck:macos`: 成功
- `StyleSheet.create`: 31ファイル
- 色リテラル: 981箇所 / 63ファイル（テストを含む）
- iOSシミュレータは未起動だったため、基準画像は最初の目視確認時に取得する

## 1. 結論

このプロジェクトには SCSS や新しいスタイリングライブラリを追加しない。

最も保守しやすい方法は、次の構成である。

1. 色、文字、境界線など、テーマで変わる値だけを `visualThemes.ts` に集約する。
2. 値には `blue500` のような色名ではなく、`textPrimary`、`surfaceRaised`、`borderStrong`、`danger` のような用途名を付ける。
3. 現在の `styles/` 分割は維持し、各スタイル定義へテーマを引数として渡す。
4. 選択中のテーマは専用の `VisualThemeContext` で配る。
5. テーマ設定は既存の `bitty-settings.json` に保存し、設定画面から即時切替できるようにする。
6. 初期テーマは「標準」と「高視認性」の2種類に限定する。両方を基盤作成時から定義して移行中も切替検証するが、全対象の移行完了までは設定画面に公開しない。ダークテーマは今回実装しない。

スタイル一式をテーマごとにコピーすると修正漏れが増えるため採用しない。1つの巨大なスタイルファイルへ統合することもしない。**値は一元管理し、スタイルの責務は画面・機能ごとに分けたままにする**。

実装作業は、問題の発見と切り戻しを容易にするため機能単位に分ける。ただし、**部分対応を完成扱いにはしない**。主要画面、モーダル、Markdown、Mermaid、Skia、設定保存まで受け入れ条件を満たした時点で、初めてテーマ選択を利用者へ公開する。途中のコミットは内部検証用であり、部分的なテーマ切替をリリースするためのものではない。

## 2. 現状調査

### 2.1 良い土台

- `expo/src/features/app/styles.ts` が共通スタイルの集約点になっている。
- `expo/src/features/app/styles/` はチャット、設定、メニュー、メディアなどの責務で既に分割されている。
- `expo/src/features/app/AppProviders.tsx` にProviderの集約点がある。
- `expo/src/features/app/hooks/useAppSettingsPersistenceController.ts` が設定の読み込み、保存、インポート、エクスポートを一元管理している。
- `expo/src/features/app/components/SettingsSelect.tsx` はテーマ選択UIにも再利用できる。
- iOSスモークフロー `maestro/flows/ios-smoke.yaml` と主要画面のJestテストがある。

### 2.2 現在の問題

2026-09-18時点の本番コードを検索した結果:

| 項目 | 現状 |
|---|---:|
| `StyleSheet.create` を持つファイル | 31 |
| 色リテラル | 956箇所 |
| 色リテラルを持つファイル | 56 |
| `fontSize` 指定 | 296箇所 |
| border関連指定 | 421箇所 |
| 共通 `styles/` の合計 | 3,177行 |

具体的な問題は次の通り。

- `expo/app.json` の `userInterfaceStyle` は `light` 固定である。
- 共通化されている数値は、実質 `styles/layoutConstants.ts` のチャット最大幅だけである。
- `#ffffff`、`#0f172a`、`#334155` など同じ値が多数のファイルに直接書かれている。
- 文字サイズは 10〜32 まで細かく散らばり、同じ用途に同じ尺度を使う保証がない。
- `utils/statusText.ts` がステータス判定だけでなく具体的な色まで返しており、表示ロジックがテーマ層へ分離されていない。
- アイコン色は JSX のpropsへ直接指定されている箇所が多く、`StyleSheet` だけ移行してもテーマは完成しない。
- SkiaボードはReact Nativeスタイルとは別にCanvas描画色を直接持つ。
- Markdown、Mermaid、WebViewにも独自の配色があり、通常のView/Textとは別にテーマを渡す必要がある。
- `AppSettingsContext` にはテーマ設定がなく、現状の `styles` は起動時に1回だけ作られる静的オブジェクトである。

### 2.3 macOS固有の注意

`AppModal.macos.tsx` は標準Modalではなく、`App.tsx` の `AppModalHost` 直下へ内容を再配置する独自実装である。現在の位置のまま `AppRoot` 内だけにテーマProviderを置くと、macOSのモーダル内容がテーマContextの外へ出る可能性がある。

設定stateを持つ `AppRoot` の中へ `AppModalHost` を移し、Providerの配置を次に固定する。`App.tsx` は `AppRoot` を呼ぶだけにする。

```text
VisualThemeProvider
└── AppModalHost
    └── AppProviders
        └── アプリ本体とmacOSモーダル
```

## 3. 目標

### 3.1 利用者向け

- 設定画面で「標準」「高視認性」を選べる。
- 選択直後に、再起動なしで全画面へ反映される。
- 選択内容が再起動後も維持され、設定のインポート・エクスポート対象にもなる。
- 高視認性テーマでは、文字、背景、境界線、選択状態、エラー状態を色だけに頼らず判別できる。
- OSの文字拡大を妨げず、長い日本語でも主要操作が隠れない。

### 3.2 開発者向け

- 配色や基準文字サイズを変更するとき、原則 `visualThemes.ts` だけを編集すればよい。
- コンポーネントは色コードではなく用途名を参照する。
- テーマを1つ追加しても、画面ごとのスタイルをコピーしない。
- テーマ切替のために毎レンダーで `StyleSheet.create` を実行しない。
- UI以外のドメイン処理や永続化処理へ色コードを持ち込まない。

## 4. 今回やらないこと

- SCSS/Sass、NativeWind、styled-componentsなどの追加
- 全ての余白、座標、アニメーション値のトークン化
- 既存画面の全面的なデザイン変更
- AppRootのテーマと無関係な分割
- ユーザーが選んだSkiaセクション色やセッションマーカー色のテーマ置換
- 初回実装でのダークテーマ追加

全数値を共通化すると、意味の違う値まで結合されて変更しづらくなる。共通化対象は「テーマ切替で実際に変える値」または「複数箇所で同じ意味を持つ値」に限定する。

## 5. 目標構成

### 5.1 テーマ値の唯一の定義元

新規ファイル:

`expo/src/features/app/theme/visualThemes.ts`

このファイルだけにテーマごとの値を置く。

```ts
export type VisualThemeId = "standard" | "highLegibility";

export type VisualTheme = {
  id: VisualThemeId;
  label: string;
  description: string;
  colors: {
    canvas: string;
    surface: string;
    surfaceRaised: string;
    surfaceSelected: string;
    textPrimary: string;
    textSecondary: string;
    textMuted: string;
    textOnAccent: string;
    border: string;
    borderStrong: string;
    accent: string;
    focus: string;
    success: string;
    warning: string;
    danger: string;
    info: string;
    overlay: string;
  };
  typography: {
    caption: { fontSize: number; lineHeight: number };
    small: { fontSize: number; lineHeight: number };
    body: { fontSize: number; lineHeight: number };
    label: { fontSize: number; lineHeight: number };
    title: { fontSize: number; lineHeight: number };
    display: { fontSize: number; lineHeight: number };
  };
  borders: {
    thin: number;
    strong: number;
    focus: number;
  };
};
```

実装時は状態色について、文字色だけでなく背景色・境界色の組を持たせる。上記は構造の例であり、最終的なキーは実際の利用箇所を移行しながら、重複を消せる最小数に絞る。

角丸や余白は、値が同じという理由だけでは共通化しない。複数箇所で同じ意味を持ち、テーマ間で実際に変える必要が確認された場合だけ追加する。

`visualThemes.ts` は次もexportする。

- `VISUAL_THEMES`: 全プリセット
- `VISUAL_THEME_OPTIONS`: 設定画面表示用のラベルと説明
- `DEFAULT_VISUAL_THEME_ID`
- `parseVisualThemeId(raw)`: 不明な保存値を標準へ戻す関数

色、文字サイズ、border値を別々のファイルへ散らさない。一方、Contextやスタイル生成処理は値定義とは責務が違うため別ファイルにする。

### 5.2 Context

新規ファイル:

`expo/src/features/app/theme/VisualThemeContext.tsx`

提供する値は次に限定する。

- `themeId`
- `theme`
- `selectTheme(themeId)`

テーマオブジェクトを既存の巨大な `AppSettingsContext` へ追加しない。見た目だけを読むコンポーネントが、音声・接続・モデル設定の変更で再レンダーされる結合を避けるためである。

### 5.3 スタイル生成

各機能の既存スタイルファイルで、テーマを受け取る `create...Styles(theme)` を定義する。テーマごとの `StyleSheet` はモジュール読み込み時に生成し、レンダー時は `themeId` で選ぶだけにする。

最初から汎用の `createThemedStyleSheets.ts` は作らない。実装後に3箇所以上で同じ生成・型付け・キャッシュ処理が重複し、その共通化で読むコードが実際に減ると確認できた場合だけ抽出する。

共通スタイルは次の形へ変更する。

```text
visualThemes.ts
    ↓ theme
createAppCommonStyles(theme)
createAppLayoutStyles(theme)
createChatMessageStyles(theme)
createChatComposerStyles(theme)
createMenuScreenStyles(theme)
createSettingsScreenStyles(theme)
createMediaModalStyles(theme)
    ↓
appStylesByTheme[themeId]
```

`styles.ts` は `useAppStyles()` を提供する。現在 `styles` をimportしているコンポーネントは、段階的にこのhookへ移行する。Provider自身を組み立てる `AppRoot` だけは `appStylesByTheme[visualThemeId]` を直接選ぶ。

### 5.4 永続化

`AppRoot.tsx` に `visualThemeId` stateを1つだけ追加する。

`useAppSettingsPersistenceController.ts` の既存payloadへ `visualThemeId` を追加し、次を同じ経路で扱う。

- 起動時読み込み
- 250ms debounce保存
- 設定JSONのインポート
- 設定JSONのエクスポート
- 未知・旧バージョン値の標準テーマへのフォールバック

テーマ専用の別ファイル保存や別AsyncStorageは作らない。設定の正本を増やさないためである。

### 5.5 設定画面

既存の `SettingsSelect` を使い、`SettingsScreen.tsx` に「表示」セクションを追加する。

初期選択肢:

| ID | 表示名 | 目的 |
|---|---|---|
| `standard` | 標準 | 現在の見た目をできるだけ維持する |
| `highLegibility` | 高視認性 | 文字を一段階大きくし、境界と状態のコントラストを強める |

選択は即時反映する。保存ボタンは増やさない。既存設定と同じ自動保存へ統一する。

設定UIは、受け入れ条件にある全対象が両テーマへ対応するまで表示しない。部分的にしか変わらないテーマを利用者へ公開しないためである。

## 6. 実装手順

### Phase 0: 現在表示の基準を固定

1. 標準テーマ移行前に、次の画面をiOSとmacOSで記録する。
   - Skiaボード
   - ドロワーと検索
   - 通常チャット、ユーザー/アシスタントメッセージ、Markdown、コード
   - 設定画面
   - Git差分、ファイルビューアー、メディアモーダル
   - 承認、エラー、接続中、完了などの状態表示
2. 現在の `ios-smoke.yaml` を壊さない基準として実行する。
3. 色リテラルの件数と対象ファイル一覧を保存し、移行漏れ確認に使う。

完了条件: 標準テーマ移行後と比較できるスクリーンショットとテスト結果がある。

### Phase 1: テーマ基盤を追加するが、表示は変えない

1. `visualThemes.ts` に `standard` と `highLegibility` の最小契約を定義する。
2. `VisualThemeContext.tsx` を追加する。
3. Context選択、未知IDのフォールバック、StyleSheetの再利用を単体テストする。
4. `AppRoot` 内を `VisualThemeProvider > AppModalHost > AppProviders` の順へ調整し、macOSモーダルでもContextが読めるテストを追加する。
5. この時点では設定画面に選択肢を出さない。

完了条件: `standard` の見た目に変更がなく、テストから両テーマを切り替えたときProvider配下とmacOSモーダル配下で同じテーマが取得できる。この完了条件は基盤の検証完了を表すだけで、機能全体の完成や公開可能を意味しない。

### Phase 2: 共通スタイルを移行

移行順:

1. `appCommonStyles.ts`、`settingsControlStyles.ts`、`settingsScreenStyles.ts`
2. `menuScreenStyles.ts`
3. `chatMessageStyles.ts`、`chatComposerStyles.ts`
4. `appLayoutStyles.ts`
5. `mediaModalStyles.ts`、`audioControlStyles.ts`
6. `styles.ts` の集約

ルール:

- 位置、flex、アニメーション、固有サイズは現在のファイルに残す。
- 色、共通文字尺度、テーマで強調したいborderだけをtheme参照へ置換する。
- 単に値が同じという理由だけで、意味の違う用途を同じトークンにしない。
- `standard` は現在の表示値を再現し、この段階ではデザインを改善しない。
- 各移行単位で、非公開の `highLegibility` へ動的に切り替わることもテストする。
- 885行の `appLayoutStyles.ts` は、テーマ移行で明確に独立した責務が見つかった部分だけを既存のchat系ファイルへ移す。行数を減らす目的だけの分割はしない。

完了条件: 共通 `styles` の利用画面が `standard` で移行前と同じ表示になる。

### Phase 3: コンポーネント固有スタイルと表示色を移行

検証可能な機能単位で次の順に進める。途中状態は利用者へ公開しない。

1. 設定、ドロワー、アプリシェル
2. チャット、Markdown、Mermaid、接続/進捗表示
3. Git差分、ファイル、チェックリスト、メディア、各モーダル
4. Codexスケジュール、位置スケジュール、Tunnel画面
5. SkiaボードのアプリUI部分

各コンポーネントでは、静的な位置・レイアウトとテーマ値を同じローカルスタイル定義内に保つ。テーマのためだけに薄いラッパーコンポーネントを作らない。

追加の整理:

- `llmStatusVisual` は具体色ではなく `neutral | info | progress | warning | success | danger` のような意味を返し、色への変換はテーマ側で行う。
- Ioniconsなどの `color` propsもthemeから取得する。
- Markdownのリンク、inline code、code blockをsemantic tokenへ移す。
- Mermaid/WebViewには選択テーマから生成した配色を明示的に渡す。
- Skiaの背景、グリッド、カード、選択枠、ツールバーはthemeを受け取る。
- ユーザーが保存したセクション色、画像、マーカー色はコンテンツデータなので変更しない。
- `CalendarWriteApprovalModal.tsx` などのインライン固定色も移行対象にする。
- 文字サイズを大きくした際に、固定 `height`、固定 `maxHeight`、`numberOfLines={1}`、狭い横幅で文字や操作が欠けないか監査する。必要な一行表示だけは理由を明示して残す。

完了条件: 本番UIの固定色検索結果が、テーマ定義、ユーザーデータ用パレット、画像/HTML固有値など説明可能な例外だけになる。

### Phase 4: 高視認性テーマと永続化を完成

1. 移行中から更新してきた `highLegibility` の全tokenを最終調整する。
2. 次の基準を全対象で検証する。
   - 通常文字と背景のコントラスト比は4.5:1以上
   - 大きな文字は3:1以上
   - 操作部品の境界、フォーカス、重要アイコンは3:1以上
   - body、label、captionを標準より一段階大きくする
   - 薄い境界線を強くし、選択状態は色だけでなくborder幅やチェック表示でも示す
   - タップ領域は見た目の大きさに依存せず原則44ptを確保する
3. `visualThemeId` を既存設定永続化へ接続する。
4. テストから切り替えた際に、画面、モーダル、Skia描画が同時更新されることを確認する。

完了条件: 内部テストで設定変更が即時反映され、再起動、インポート、エクスポート後も選択が維持される。この時点でも設定画面には公開しない。

### Phase 5: 清掃、全体回帰確認、公開判定

1. 使われなくなった固定色、重複スタイル、旧exportを削除する。
2. テーマ移行のために作った一時的な互換コードを削除する。
3. `rg` で残る色・fontSize・border値を確認し、各例外の理由をレビューする。
4. 全テスト、型検査、iOSスモーク、macOS実機確認を行う。
5. 移行中に増えたファイルやhookを自己レビューし、1〜2行を隠すだけの抽象化を削除する。
6. 設定UI以外の受け入れ条件を確認してから、`SettingsScreen` に「表示」セクションを追加してテーマ選択を有効にする。1項目でも未完了なら追加しない。
7. 設定画面からの切替、即時反映、再起動後の復元を含む全テストを再実行する。
8. 最終受け入れ条件をすべて満たした場合だけ公開する。

## 7. サブエージェントの割り当てと進捗管理

### 7.1 実行原則

- 主担当（ルートエージェント）が設計、共通ファイル、進捗、統合、最終テストを管理する。
- 同時実行は最大3サブエージェントとし、同じファイルを同時に編集させない。
- Phase 1の共通基盤がテストを通るまでは並列移行を開始しない。
- サブエージェントは担当範囲のUIと隣接テストだけを変更する。ビジネスロジックは変更しない。
- `visualThemes.ts` にtokenが足りない場合、サブエージェントは直接追加せず、用途名、標準値、高視認性値、利用箇所を主担当へ報告する。
- token不足の申請を受けたら、主担当は同じ波の実行中に重複名や意味の衝突を確認して追加する。申請した担当は追加後に作業を再開して対象テストを通す。
- 未記載ファイルに変更が必要になった場合は勝手に編集せず、主担当が所有者を決め直す。

### 7.2 主担当専有ファイル

次は複数領域へ影響するため、主担当だけが編集する。

- `expo/App.tsx`
- `expo/app.json`
- `expo/src/features/app/AppRoot.tsx`
- `expo/src/features/app/AppProviders.tsx`
- `expo/src/features/app/styles.ts`
- `expo/src/features/app/styles/appLayoutStyles.ts`
- `expo/src/features/app/theme/**`
- `expo/src/features/app/hooks/useAppSettingsPersistenceController.ts`
- `expo/src/features/app/hooks/useAppSettingsPersistenceController.test.tsx`
- `expo/src/features/app/utils/persistedSettingsFile.ts`
- `expo/src/features/app/utils/persistedSettingsFile.test.ts`
- `expo/src/features/app/screens/SettingsScreen.tsx` への最終的なテーマ選択UI追加

### 7.3 並列作業の割り当て

同じ波の担当は並列実行できる。省略パスの基準は `expo/src/features/app/` とし、`*` は同名のplatform別ファイルと隣接するテストを含む。

| ID | 担当領域 | 主な担当ファイル | 開始条件 |
|---|---|---|---|
| T0 | 共通基盤（主担当） | 主担当専有ファイル、`theme/visualThemes.ts`、`theme/VisualThemeContext.tsx` | Phase 0完了後 |
| T1-A | チャット・Markdown | `styles/chatMessageStyles.ts`、`styles/chatComposerStyles.ts`、`screens/ChatScreen*`、`components/Chat*`、`components/ComposerFullscreenEditor*`、`components/CommandExecutionRow.tsx`、`components/InternalContextMessage*`、`components/MarkdownText.tsx`、`components/Mermaid*`、`components/SlashCommandSelectMenu.tsx`、`hooks/useChatDerivedState.ts`、`utils/statusText.ts` | T0完了後 |
| T1-B | 設定・ドロワー・シェル | `styles/appCommonStyles.ts`、`styles/menuScreenStyles.ts`、`styles/settingsControlStyles.ts`、`styles/settingsScreenStyles.ts`、`components/AppDrawer*`、`components/AppScreenContent*`、`screens/SettingsScreen*`、`components/SettingsSelect.tsx`、`components/OptionSelectField.tsx`、`components/CodexAccountSettings*`、`components/CodexStatusSummaryMenu*`、`components/ConnectionSettings.tsx`、`components/SpeechSettings.tsx` | T0完了後 |
| T1-C | Git・ファイル・メディア | `styles/mediaModalStyles.ts`、`components/Git*`、`components/RunnerFile*`、`components/RunnerMediaViewer.tsx`、`components/ChecklistFileViewer*`、`components/WorkspaceTextFileEditor*`、`components/WorkspaceFileRenameDialog.tsx`、`components/ModalTextInputDraft*` | T0完了後 |
| T2-A | Skiaボード | `screens/SkiaMiniBoardScreen*`、`components/SkiaBoard*`、`contexts/SkiaBoardContext.tsx`、`hooks/useSkiaBoard*`、`hooks/useSkiaMiniChatSessions*`、`utils/skiaBoard*`の色用途を読取監査 | T1統合後 |
| T2-B | 補助画面・スケジュール・音声 | `styles/audioControlStyles.ts`、`screens/CloudflareTunnelMonitorScreen.tsx`、`screens/RouteDebugPanel.tsx`、`expo/src/features/codexSchedules/**/*.tsx`、`expo/src/features/locationSchedules/**/*.tsx`、`components/YouTubeVideoList.tsx`、`components/TtsWaveformPlayer.tsx`、`components/CalendarWriteApprovalModal*`、`utils/youtube.ts` | T1統合後 |
| T2-C | オーバーレイ・残存UI監査 | `components/AppOverlays.tsx`、`components/AppModal*`、`components/PopupChatOverlay.tsx`、`components/DrawerSessionPopupHost*`、`components/LlmCompletionNotifications*`、`components/BouncingDotsIndicator.tsx`、`components/CircularProgressRing.tsx`、`components/PixelRobotIndicator.tsx`、および未割当UIの固定色を読取監査 | T1統合後 |
| T3 | 永続化・全体統合（主担当） | 主担当専有ファイル、各担当から申請されたtoken、設定UI、全体回帰 | T2統合後 |

`screens/SettingsScreen.tsx` はT1-Bが既存表示のテーマ移行だけを担当する。テーマ選択UIは、T1-B完了後かつ公開前条件を満たした後に主担当が追加する。

T2-Cの監査で未割当ファイルに修正が必要と判明した場合、主担当がそのファイルをT2-Cへ明示的に追加してから変更させる。これにより、監査を理由に担当範囲が無制限に広がることを防ぐ。

各波の統合手順は次に固定する。

1. サブエージェントが担当ファイルの変更とtoken申請を行う。
2. 主担当が申請されたtokenを追加し、`styles.ts` と `appLayoutStyles.ts` の必要な接続を行う。
3. サブエージェントが担当テストを再実行する。
4. 主担当がdiff、型検査、波全体の対象テストを確認してからG2またはG3を完了にする。

Skiaの `utils/skiaBoard*` にあるユーザー選択色はコンテンツデータなので置換しない。T2-Aはテーマ対象との混同がないことを確認し、例外として報告する。

### 7.4 進捗ゲート

| ゲート | 完了条件 | 初期状態 |
|---|---|---|
| G0 現状固定 | 基準画像、既存テスト結果、固定色一覧を保存 | 自動基準完了・画像待ち |
| G1 共通基盤 | T0の型検査、Context、macOS Modalテストが成功 | 完了 |
| G2 第1波 | T1-A〜Cの対象テスト成功、主担当レビュー、token統合完了 | 完了 |
| G3 第2波 | T2-A〜Cの対象テスト成功、残存UIの所有者確定、token統合完了 | 完了 |
| G4 公開前確認 | 全対象が両テーマ対応、固定色例外を説明可能、永続化確認 | 完了 |
| G5 最終公開 | 設定UI追加後に全テスト、iOS smoke、macOS目視確認が成功 | 目視確認待ち |

現在の担当状態:

| ID | 状態 | 備考 |
|---|---|---|
| T0 | 完了 | テーマ定義、専用Context、Provider/Modal包含順、単体テスト、両型検査が成功 |
| T1-A | 完了 | チャット・Markdown・Mermaidを統合し対象テスト成功 |
| T1-B | 完了 | 設定・ドロワー・シェルを統合し対象テスト成功 |
| T1-C | 完了 | Git・ファイル・メディアを統合し対象テスト成功 |
| T2-A〜C | 完了 | Skia、補助画面、オーバーレイを統合し対象テスト成功 |
| T3 | 完了 | 永続化、設定UI、全体回帰を統合。目視確認のみ別途必要 |

主担当は各サブエージェントの状態を `待機 / 作業中 / レビュー中 / 完了 / 要修正` で管理し、ゲートを越えるときにこの表を更新する。ファイル編集完了だけでは `完了` にせず、対象テストと主担当レビューまでを必須とする。

### 7.5 サブエージェントの完了報告

各担当は次を短く報告する。

1. 変更したファイル
2. 標準テーマの見た目を維持した根拠
3. 高視認性テーマで確認した内容
4. 実行したテストと結果
5. 主担当へ依頼する追加token
6. 残る固定色と、そのまま残す理由

主担当は各報告とdiffを確認し、担当外変更、重複token、薄いラッパー、レンダー中のStyleSheet生成があれば統合前に修正させる。全体テストは並列作業中には重複実行せず、各波の統合後に主担当が実行する。

## 8. テスト計画

### 8.1 単体・コンポーネントテスト

- `parseVisualThemeId` が未知値、空値、旧設定を `standard` に戻す。
- 全テーマが同じ必須tokenを持つことをTypeScriptとテストで保証する。
- 主要な文字/背景、状態/背景、border/背景の組をコントラストテストする。
- Theme Contextの切替で子コンポーネントが新しいthemeを受け取る。
- 各機能のテーマ別StyleSheetがレンダーごとに再生成されない。
- macOS `AppModalHost` 内でも選択テーマが利用できる。
- 設定画面の選択操作が `selectTheme` を1回だけ呼ぶ。
- 保存、再読込、インポート、エクスポート、未知IDフォールバックを `useAppSettingsPersistenceController.test.tsx` へ追加する。
- 既存の色を直接期待するテストは、視覚的意味を検証するテストへ変更する。ただしユーザー選択色のテストは維持する。

### 8.2 必須コマンド

`expo/` で実行する。

```sh
npm test -- --runInBand
npm run typecheck
npm run typecheck:macos
```

加えてリポジトリrootから既存のiOS Maestro smokeを実行する。

### 8.3 目視マトリクス

| 対象 | standard | highLegibility | iOS | macOS |
|---|---:|---:|---:|---:|
| Skiaボード/ツールバー/カード | 必須 | 必須 | 必須 | 必須 |
| ドロワー/検索/選択状態 | 必須 | 必須 | 必須 | 必須 |
| チャット/Markdown/コード/状態表示 | 必須 | 必須 | 必須 | 必須 |
| 設定/入力/スイッチ/選択モーダル | 必須 | 必須 | 必須 | 必須 |
| Git/ファイル/メディア/チェックリスト | 必須 | 必須 | 必須 | 必須 |
| エラー/警告/成功/無効/フォーカス | 必須 | 必須 | 必須 | 必須 |
| 文字拡大と長い日本語 | 必須 | 必須 | 必須 | 必須 |

## 9. 受け入れ条件

- 設定画面から2テーマを切り替えられる。
- アプリ再起動後も選択が維持される。
- 標準テーマは移行前の見た目と操作性を意図せず変えない。
- 高視認性テーマは定義したコントラスト基準を満たす。
- 開いているモーダル、Markdown、Mermaid、Skiaを含む主要画面に切替が反映される。
- 色だけで状態を表す主要操作が残っていない。
- 通常のUIコンポーネントに説明できない色リテラルが残っていない。
- `StyleSheet.create` がレンダー中に繰り返し呼ばれない。
- テーマ値は `visualThemes.ts` に集約されている。
- `AppSettingsContext` にテーマオブジェクトを追加していない。
- 文字拡大時に固定高さや一行制限が原因で、主要な文字・操作が欠けない。
- 主要画面・モーダル・Markdown・Mermaid・Skiaの移行と公開前テストを満たすまで、設定画面のテーマ選択が追加されていない。
- Jest、iOS/macOS typecheck、iOS smoke、macOS目視確認が完了している。

## 10. リスクと対策

| リスク | 対策 |
|---|---|
| 一括変更で表示回帰が見つけにくい | 両テーマを機能群ごとに移行・テストするが、全体完了まで設定UIは公開しない |
| テーマ追加でスタイルが倍増する | スタイルは共有し、値だけをテーマ化する |
| Context追加で不要な再レンダーが増える | theme値とsetterをmemo化し、既存AppSettingsContextから分離する |
| 毎レンダーのStyleSheet生成で遅くなる | 全テーマのStyleSheetをモジュール初期化時に事前生成する |
| macOSモーダルだけ切替されない | ProviderとAppModalHostの包含順をPhase 1で固定・テストする |
| SkiaやWebViewだけ古い色が残る | 通常StyleSheetとは別の移行項目として明示的に検証する |
| fontSize共通化でレイアウトが崩れる | semantic roleへ段階移行し、固有サイズを無理に共通化しない |
| 文字拡大でラベルや操作が欠ける | 固定高さ、`numberOfLines`、長い日本語を各画面の確認項目に含める |
| 将来ダークテーマを足した際にnative UIと不一致になる | 今回はlight系2テーマに限定。追加時に`userInterfaceStyle`、StatusBar、native controlsを一緒に対応する |

## 11. 推奨コミット単位

1. `two-theme contract + provider + tests`（設定UI非公開、標準の見た目変更なし）
2. `shared app styles use standard theme`（見た目変更なし）
3. `chat and shell adopt semantic theme tokens`
4. `remaining components and feature screens adopt theme tokens`
5. `Skia, Markdown, Mermaid and modal theme propagation`
6. `persist theme selection and verify whole-app switching internally`
7. `finalize high-legibility values and visual verification`
8. `remove compatibility code and expose settings UI after acceptance`

各コミットは単独で型検査と対象テストを通せる状態にする。これは不具合の混入箇所を特定しやすくするための分割であり、各コミットを機能完成とみなすものではない。テーマが部分適用された状態をリリース対象にはしない。

## 12. 実装開始時の最初の作業

最初の内部検証ではテーマ切替UIを作らず、次を行う。

1. `visualThemes.ts` に `standard` と `highLegibility` の最小契約を作る。
2. Contextと機能別の事前生成StyleSheetを作る。
3. 設定画面を両テーマへ移行する。
4. `standard` の移行前後が一致し、テスト操作で `highLegibility` へ動的に切り替わることを確認する。

この内部検証で、型、Provider、macOS Modal、StyleSheet生成、テスト方法が成立することを確認してから、同じ規則で全対象へ広げる。これは設計ミスを早期に見つけるための作業単位であり、ここで実装を止めたり公開したりしない。Phase 5の公開判定までを今回の一連の実装範囲とする。
