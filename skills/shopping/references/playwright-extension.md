# 確認ボタンを繰り返さないChrome接続

既存のログイン済みChromeで、検索・商品詳細・注文履歴・カート表示・単品追加をプログラム実行するときに使う。MicrosoftのPlaywright公式拡張を利用し、初回に登録するプロファイル固有のキーで接続する。ChatGPTのブラウザツール経由とは別方式で、Playwrightのマウス移動・1文字ずつの入力をそのまま使う。

## 初回だけ

1. `<skill>/scripts/amazon/` で `npm run chrome -- setup-extension` を実行する。返されたローカルURLが登録画面。30分で閉じるため、期限切れなら同じコマンドで開き直す。
2. ユーザーに、AmazonへログインしているChromeへ[Playwright公式拡張](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)を追加してもらう。拡張のインストール確認はユーザーが行う。既存のChatGPT拡張を削除・無効化しない。
3. ユーザーが拡張アイコンを開き、`PLAYWRIGHT_MCP_EXTENSION_TOKEN` の値をローカル登録画面へ貼り付けて保存する。チャットにキーを貼らせない。通常はプロファイル欄を空欄にする。必要な場合だけ実際のプロファイルディレクトリ名（`Default`、`Profile 1`等）を指定する。
4. 設定は `.chrome-extension.json` に所有者専用権限で保存され、Git対象外。トークンの本文をログや返答へ出さない。保存完了だけを接続成功扱いにせず、以下の接続・実行を確認する。

公式に提供されたトークン認証を使う。Chromeの「許可」を自動で押したり、確認機能を無効にしたりしない。Chromeのリモートデバッグ設定はこの方式には不要。

## 通常の操作

```sh
npm run chrome -- status
npm run chrome -- start
npm run chrome -- status
npm run chrome -- search "ボールペン"
```

設定済みなら `start` は公式拡張へ接続する。`status` の `transport: "extension"` と `state: "connected"` を確認する。未設定ではエラーで停止し、直接接続に自動で切り替えない。先に初回設定を完了する。既存ワーカーが直接接続なら、実行中でないことを確認して `stop` 後に起動し直す。

トークン接続は同じChromeプロファイルに新しい空タブを作り、そのタブを制御する。既存のAmazonログイン状態を利用するが、普段の他のタブを無断で取得しない。最初の操作でその空タブをAmazonへ移動し、以後は同じ接続・タブを使う。複数の対象があるときだけ実在するURLを `--tab-url` で指定する。明示URLが見つからなければ空タブへ切り替えず停止する。

検索のほか、`detail`、`orders`、`cart`、`cart-add`、`browser-status` が同じ接続で利用できる。コマンドの引数・結果・認証判定はSKILL.mdと共通。検索語・ASIN・数量・操作内容をAIの都度生成コードに置き換えない。

停止は `npm run chrome -- stop`。自動の30分切断は行わない。Chrome終了などで切断されたら、実行中の操作の結果を確認し、`stop` → `start` で接続だけを作り直す。保存済みキーが有効なら接続ごとの確認は不要。失敗した検索・追加を自動再実行するものではない。拡張のキーを再発行した場合は初回設定をやり直す。

## カート追加

カート追加も公式拡張の保持接続を使う。ユーザーが新規追加を明示した場合だけ [cart.md](cart.md) を読み、同じ操作IDの状態を確認して実行する。

```sh
npm run cart-status -- --operation <同じ操作ID>
npm run chrome -- cart-add --asin <ASIN> --operation <同じ操作ID> --tab-url <実際の商品URL>
```

表示中の通常追加ボタンを選び、定期便・今すぐ買うのボタンは選ばない。クリック直前にもフォームのASIN・数量1・POST先・送信項目を検査し、送信前の記録をディスクに保存する。Amazonの通常追加フォームにも `isBuyNow=1` が含まれる場合がある。これは `/cart/add-to-cart` 宛てかつ `submit.add-to-cart` が選ばれた場合だけ許可し、購入ボタンの送信項目やチェックアウト項目は拒否する。

公式拡張では追加のCDPセッションが利用できず、Service Worker経由の通信全体は遮断できない。ページ通信の制限は補助とし、結果の `serviceWorkerBypass: false` にこの違いを記録する。成功は対象ASINを含む「カートに入れました」の実表示で確認する。成功・成否不明の記録があれば再追加せず、後続のカート表示で認証が出た場合も記録を保持する。

接続更新時も `stop` → `start` で公式拡張に接続する。`--direct` は明示的な診断用の旧方式であり、通常の買い物操作には使わず、許可を求めるための代替手順として案内しない。

## 検証範囲

2026-11-22、ユーザーのログイン済みChromeで公式拡張0.6.0を使い、検索・商品詳細・MONO消しゴム（B0016GHXSE）の数量1追加・成功表示・カート内容の確認まで実行した。接続許可の追加操作は不要だった。商品数は10→11、カート内の対象数量は1。追加記録は `mono-eraser-test-20261122-0946` で、再追加は禁止のまま保持する。

実画面の `/cart/smart-wagon` と `/gp/product/<ASIN>` 形式の商品リンクに対応した。隔離ブラウザでは同じキーによる再接続・ブラウザ再起動後の接続と検索を確認済み。Amazonの人間確認を防ぐ仕組みではなく、認証表示時は停止する。

根拠：[Playwright公式拡張の導入・トークン認証](https://github.com/microsoft/playwright/blob/v1.65.1/packages/extension/README.md)。接続は同梱CLIの公開コマンドと公開Browser APIで実装し、拡張の内部接続情報やChatGPT拡張の保存データを読み出さない。
