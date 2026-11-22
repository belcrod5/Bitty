---
name: shopping
description: Amazon.co.jpの商品検索、検索結果のJSON取得・次ページ移動・商品詳細表示・購入履歴を、Playwrightのプログラムで実行する。「買い物」オーケストレーターでAmazonの商品を探す・詳細や注文履歴を開く依頼に使う。指定商品の数量1でのカート追加とカート内容・認証状態の確認にも対応する。注文確定・購入・ログイン操作は対象外。
---

# 買い物

同梱の `scripts/amazon/` のコマンドを使い、Amazonの商品検索・詳細表示・購入履歴・カート操作を実行する。入力・クリック・判定は固定プログラムで行う。既存Chromeを使う場合は、AIが接続とタブ選択を行い、同梱JavaScriptで検索・詳細・履歴・カート表示を実行できる。

## 実行

普段使い・ログイン済み・既存Chromeを使う依頼では、先に [references/playwright-extension.md](references/playwright-extension.md) を読む。公式Playwright拡張の初回設定後は `npm run chrome -- start` で接続し、検索・詳細・履歴・カート表示・単品追加を接続確認ボタンなしでプログラム実行できる。`npm run chrome -- status` で接続状態と方式を確認する。未設定のまま直接接続を繰り返して許可を求めない。カート追加も同じ公式拡張接続を使い、直接接続へ切り替えない。ChatGPTの接続済みブラウザツールを使う既存方式は [references/extension.md](references/extension.md) にある。以下が通常使うコマンド。

このSKILL.mdと同じディレクトリを `<skill>` とする。リンク経由で利用でき、原本は `/Volumes/SSD-500GB-SanDisk/work/bitty-public/skills/shopping/` にある。

実行ディレクトリを `<skill>/scripts/amazon/` に設定する。Node.js 22以降とGoogle Chromeが必要。依存パッケージがなければ同ディレクトリで `npm ci --cache .npm-cache --no-audit --no-fund` を実行する。

| 依頼 | コマンド |
| --- | --- |
| 商品検索（商品JSONを取得） | `npm run chrome -- search "検索語" --limit 10` |
| 今のページの続きのJSON | `npm run chrome -- search-results --offset 10 --limit 10` |
| 検索結果の次ページ | `npm run chrome -- search-next --limit 10` |
| 検索結果の指定番号の商品詳細 | `npm run chrome -- detail "検索語" --index 1` |
| ASINを指定した商品詳細 | `npm run chrome -- detail --asin B012345678` |
| 購入履歴（注文履歴）を開く | `npm run chrome -- orders` |
| 既存Chromeの接続可否・対象タブを診断 | `npm run chrome -- browser-status` |
| カート内容・認証状態を確認 | `npm run chrome -- cart` |
| 指定商品を数量1で単品追加 | `npm run chrome -- cart-add --asin B012345678 --operation request-001` |
| 追加操作の保存状態を確認 | `npm run cart-status -- --operation request-001` |

公式Playwright拡張でのブラウザ操作は `npm run chrome -- <コマンド>` で実行する。保存記録の `cart-status` は表のコマンドを使う。接続の再作成が必要な場合も登録済みキーで同じ方式に接続し、Chromeのリモートデバッグ許可を要求しない。

**検索・ページング・商品選択では [references/catalog.md](references/catalog.md) を読む。** 通常はJSONから判断し、返されたASINで商品詳細を開く。ページ画像の保存・読み取りは必要な場合だけ行う。

**カート追加・カート確認では、実行前に [references/cart.md](references/cart.md) を読む。** 追加成功後の認証や成否不明を追加失敗と扱って再追加しない。同じ依頼の `--operation` を変更しない。

検索語は依頼に合わせて渡す。指定がなければプログラムの既定値は「ボールペン」。`--index` は1始まりで広告も表示順に含む。ASINは実際の商品URLの `/dp/` に続く10桁の英数字を使う（上表のASINは書式例）。

専用ブラウザで画面を残してほしい依頼には `--keep-open` を追加する。この場合はブラウザを手動で閉じるまでプロセスが継続するため、結果ファイルに成功が記録された時点で完了を報告できる。通常は結果保存後にブラウザを閉じる。必要なら `--headless` で実行する。

## CLIの各コマンドの動作

- 検索：ホームを開く（既にホームならそのまま使う）。`#twotabsearchtextbox` をクリックしてフォーカスを確認。1文字ずつ入力し、`#nav-search-submit-button` をクリックする。
- 続きの取得：`search-results` は同じ検索ページを読み取るだけ。`search-next` は実在する「次へ」を1回クリックし、同じ検索語・次のページ番号への移動を確認する。再検索や全ページ巡回は行わない。
- 検索から商品詳細：検索後、指定番号の検索結果の `data-asin` に対応する商品リンクをクリックする。ASIN指定時だけは詳細URLに直接遷移する。`#productTitle:visible` とASINの一致を確認する。
- 購入履歴：ホームの `#nav-orders` をクリックし、見出し「注文履歴」の表示を確認する。履歴URLの直開きではない。

文字入力ごととクリック直前に0.5〜1秒のランダム待機を入れる。CLIのマウス移動はランダムな中継点2〜4個、3次ベジェ曲線、変動する速度と途中停止を使う。クリック直前に対象が座標上にあることを確認する。この動作はプログラム内に実装済み。

保持接続を使わず `npm run orders` / `npm run cart` / `npm run cart-add` を直接実行した場合だけ、このスクリプトの `.browser-profile/` を使用する。検索・詳細は通常一時ブラウザを使い、`--profile` を付けたときだけ同じ専用プロファイルを使う。既存の普段使いChromeのプロファイルをコピーして読み込まない。

既存Chromeは [references/playwright-extension.md](references/playwright-extension.md) の保持接続を優先する。公式Playwright拡張はベジェ移動に対応し、ChatGPTのブラウザツール方式は文字ごと・クリック前の待機に対応するがベジェ移動には対応しない。方式を混同して報告しない。直接接続の診断で利用不可でも、拡張方式まで使えないとは判断しない。ログインコマンドはなく、Amazonが認証画面を出したら停止する。

## 結果とエラー

以下はCLI実行時（公式Playwright拡張を含む）の保存先・終了コード。ChatGPTブラウザツール方式は関数の戻り値を確認し、既存の操作記録を書き換えない。

`artifacts/<日時>/result.json` の `success`、URL、商品タイトルなどで完了を確認する。操作記録は同じ場所の `events.json`。既定ではページ画像を保存せず、必要な場合だけ `--screenshots` でPNGも保存する。商品画像はJSON内の `imageUrl` で示し、自動でAIに読ませない。終了コード0が成功、1が通常のエラー、2が認証要求、3が追加成否不明。カート操作は `addition` と `cart` を別に保存し、追加成功・成否不明では `retryAdd: false` を保持する。

要素は固定セレクタで取得し、通常20秒、検索結果・商品タイトル・履歴見出しは30秒でタイムアウトする。要素が見つからない、クリック位置が隠れている、商品番号が範囲外、ASINが不一致の場合も停止する。失敗は例外とURLパスを結果JSON・イベントに保存する。応答しないページでもエラーを返せるよう、失敗時の画像・HTML取得は行わない。URLのクエリ・フラグメント・認証情報はログ・例外・結果から除去する。

失敗したら保存されたエラーを確認して報告する。取得に失敗した要素をAIのブラウザ操作で調査できる。読み取り値はDOMのテキストと照合し、見た目の確認が必要な場合だけ画像を使う。未実行の操作を成功扱いにしない。CAPTCHAを自動突破しない。

## 操作範囲と保守

ユーザーが単品追加を依頼したときだけ、対象ASIN・数量1の通常追加ボタンを1回だけクリックする。注文確定・購入・カート内の削除は行わない。通常追加ボタンの表示・フォームのASIN・数量・送信先・購入用送信ボタンが含まれないことをクリック直前にも検査する。ページ通信の遮断は補助であり、公式拡張ではService Workerの通信まで遮断できない。追加成功は通信の捕捉ではなく対象ASINを含む成功表示で確認する。認証画面には操作しない。

このスキルは指定された「買い物」オーケストレーターの `.agents/skills/shopping` から原本へのリンクで配置する。共通の `~/.codex/skills/` にコピーしない。保守は原本側で行い、コードを変更した場合は `scripts/amazon/` で `npm run check` と `npm test` を実行する。実行結果・操作記録 `.operations/`・ブラウザプロファイル・node_modulesはGit管理しない。
