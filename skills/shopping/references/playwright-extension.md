# 確認ボタンを繰り返さないChrome接続

既存のログイン済みChromeで、検索・商品詳細・注文履歴・カート表示・追加・削除をプログラム実行するときに使う。MicrosoftのPlaywright公式拡張を利用し、初回に登録するプロファイル固有のキーで接続する。ChatGPTのブラウザツール経由とは別方式で、Playwrightのマウス移動・1文字ずつの入力をそのまま使う。

## 初回だけ

1. `<skill>/scripts/amazon/` で `npm run chrome -- setup-extension` を実行する。返されたローカルURLが登録画面。30分で閉じるため、期限切れなら同じコマンドで開き直す。
2. ユーザーに、AmazonへログインしているChromeへ[Playwright公式拡張](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)を追加してもらう。拡張のインストール確認はユーザーが行う。既存のChatGPT拡張を削除・無効化しない。
3. ユーザーが拡張アイコンを開き、`PLAYWRIGHT_MCP_EXTENSION_TOKEN` の値をローカル登録画面へ貼り付けて保存する。チャットにキーを貼らせない。通常はプロファイル欄を空欄にする。必要な場合だけ実際のプロファイルディレクトリ名（`Default`、`Profile 1`等）を指定する。
4. 設定は `.chrome-extension.json` に所有者専用権限で保存され、Git対象外。トークンの本文をログや返答へ出さない。保存完了だけを接続成功扱いにせず、以下の接続・実行を確認する。

公式に提供されたトークン認証を使う。Chromeの「許可」を自動で押したり、確認機能を無効にしたりしない。Chromeのリモートデバッグ設定はこの方式には不要。

## 通常の操作

`status` は接続確認、`browser-status` はタブの表示内容の確認。接続中でもAmazonタブがなければ `browser-status` の `tabState: missing` となる。各タブの `loginState` は `signed_in`（画面上のログイン表示）、`signed_out`、`login_required`、`verification_required`、`unknown`。`signed_in` でも次の操作で追加認証が出ることはある。`unknown` やタブ不在をログアウトと断定しない。氏名やCookieは返さない。

```sh
npm run chrome -- status
npm run chrome -- start
npm run chrome -- status
npm run chrome -- search "ボールペン"
```

設定済みなら `start` は公式拡張へ接続する。`status` の `transport: "extension"` と `state: "connected"` を確認する。未設定ではエラーで停止し、直接接続に自動で切り替えない。先に初回設定を完了する。既存ワーカーが直接接続なら、実行中でないことを確認して `stop` 後に起動し直す。

トークン接続は同じChromeプロファイルに新しい空タブを作り、そのタブを制御する。既存のAmazonログイン状態を利用するが、普段の他のタブを無断で取得しない。最初の操作でその空タブをAmazonへ移動し、以後は同じ接続・タブを使う。複数の対象があるときだけ実在するURLを `--tab-url` で指定する。明示URLが見つからなければ空タブへ切り替えず停止する。

検索のほか、`search-results`、`search-next`、`detail`、`detail-current`、`orders`、`orders-search`、`orders-results`、`orders-next`、`orders-resume`、`cart`、`cart-add`、`cart-remove`、`browser-status` が同じ接続で利用できる。コマンドの引数・結果・認証判定はSKILL.mdと共通。検索・追加・削除は固定コマンドを使い、詳細ページの選択項目はAIのブラウザツールで操作する。商品データの受け取りとページングは [catalog.md](catalog.md) に従う。

購入履歴の検索・認証後の再開は [orders.md](orders.md)。Amazonの認証時は接続を停止せず、同じタブを維持する。`start` 時に同名の公式Playwright接続が残っていれば、公開CLIの一覧から再利用する。

停止は `npm run chrome -- stop`。自動の30分切断は行わない。Chrome終了などで切断されたら、実行中の操作の結果を確認し、`stop` → `start` で接続だけを作り直す。保存済みキーが有効なら接続ごとの確認は不要。失敗した検索・追加を自動再実行するものではない。拡張のキーを再発行した場合は初回設定をやり直す。

## AIへの同じタブの引き継ぎ

1. `status` / `browser-status` の操作対象URLを取得する。コマンド実行中はAI側で操作しない。
2. AIブラウザツール（この環境では `cua_repl`）でChromeのプロファイルとタブ一覧を読む。公式Playwright拡張の対象URL・商品・`Playwright` タブグループを照合して既存タブを取得する。タブIDを固定値として保存しない。同じURLが複数あって特定できないときは、勝手に別タブで選択しない。
3. ブラウザツールの最新の説明に従って、表示項目をAIが確認・選択する。Cuaでは `getTab` → `getAXState` → 要素の操作 → 状態取得、または提供されるDOM／locator APIを使う。取得したタブを保持し、各クリック後に状態を取り直す。
4. 選択後のURLと `npm run chrome -- detail-current` が返すASIN・選択値・価格を照合する。一致する同じタブのまま `cart-add` に進む。`detail --asin` による開き直しは不要。

接続を切断したり、新しいタブを作ったりする引き継ぎではない。AI側で参照できなければ選択処理を止め、状態を伝える。ブラウザツールの制限を別経路で迂回しない。

2026-11-22に実機確認：Playwrightが開いた「ワイン・LL」の同じChromeタブをCuaで取得し、AIが「ブラック・L」に変更。保持中のPlaywrightで移動・再読み込みせず変更後ASIN・選択値・価格を読み取れた。追加の接続許可は不要。カート操作は行っていない。

## カート追加

カート追加も公式拡張の保持接続を使う。ユーザーが新規追加を明示した場合だけ [cart.md](cart.md) を読み、同じ操作IDの状態を確認して実行する。

```sh
npm run cart-status -- --operation <同じ操作ID>
npm run chrome -- detail-current
npm run chrome -- cart-add --asin <選択後ASIN> --operation <同じ操作ID> --max-price <円> --tab-url <選択後の実際の商品URL>
```

追加・削除は既存接続専用。削除は [cart.md](cart.md) の `cart-remove` を使う。追加ではページを開き直さず、表示中の通常追加ボタンを選び、定期便・今すぐ買うのボタンは選ばない。クリック直前にもフォームのASIN・数量1・POST先・送信項目を検査し、送信前の記録をディスクに保存する。Amazonの通常追加フォームにも `isBuyNow=1` が含まれる場合がある。これは `/cart/add-to-cart` 宛てかつ `submit.add-to-cart` が選ばれた場合だけ許可し、購入ボタンの送信項目やチェックアウト項目は拒否する。

公式拡張では追加のCDPセッションが利用できず、Service Worker経由の通信全体は遮断できない。ページ通信の制限は補助とし、結果の `serviceWorkerBypass: false` にこの違いを記録する。成功は対象ASINを含む「カートに入れました」の実表示で確認する。成功・成否不明の記録があれば再追加せず、後続のカート表示で認証が出た場合も記録を保持する。

接続更新時も `stop` → `start` で公式拡張に接続する。`--direct` は明示的な診断用の旧方式であり、通常の買い物操作には使わず、許可を求めるための代替手順として案内しない。

## 検証範囲

2026-11-22、ユーザーのログイン済みChromeで公式拡張0.6.0を使い、検索・商品詳細・MONO消しゴム（B0016GHXSE）の数量1追加・成功表示・カート内容の確認まで実行した。接続許可の追加操作は不要だった。商品数は10→11、カート内の対象数量は1。追加記録は `mono-eraser-test-20261122-0946` で、再追加は禁止のまま保持する。

実画面の `/cart/smart-wagon` と `/gp/product/<ASIN>` 形式の商品リンクに対応した。隔離ブラウザでは同じキーによる再接続・ブラウザ再起動後の接続と検索を確認済み。Amazonの人間確認を防ぐ仕組みではなく、認証表示時は停止する。

根拠：[Playwright公式拡張の導入・トークン認証](https://github.com/microsoft/playwright/blob/v1.65.1/packages/extension/README.md)。接続は同梱CLIの公開コマンドと公開Browser APIで実装し、拡張の内部接続情報やChatGPT拡張の保存データを読み出さない。
