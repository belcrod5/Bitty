# 確認ボタンを繰り返さないChrome接続

既存のログイン済みChromeで、検索・商品詳細・注文履歴・カート表示をプログラム実行するときに使う。MicrosoftのPlaywright公式拡張を利用し、初回に登録するプロファイル固有のキーで接続する。ChatGPTのブラウザツール経由とは別方式で、Playwrightのマウス移動・1文字ずつの入力をそのまま使う。

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

設定済みなら `start` は公式拡張へ接続する。`status` の `transport: "extension"` と `state: "connected"` を確認する。未設定では従来の直接接続になるため、確認ボタン不要の依頼で未設定のまま `start` を繰り返さない。先に初回設定を完了する。既存ワーカーが直接接続なら、実行中でないことを確認して `stop` 後に起動し直す。

トークン接続は同じChromeプロファイルに新しい空タブを作り、そのタブを制御する。既存のAmazonログイン状態を利用するが、普段の他のタブを無断で取得しない。最初の操作でその空タブをAmazonへ移動し、以後は同じ接続・タブを使う。複数の対象があるときだけ実在するURLを `--tab-url` で指定する。明示URLが見つからなければ空タブへ切り替えず停止する。

検索のほか、`detail`、`orders`、`cart`、`browser-status` が利用できる。コマンドの引数・結果・認証判定はSKILL.mdと共通。検索語・ASIN・数量・操作内容をAIの都度生成コードに置き換えない。

停止は `npm run chrome -- stop`。自動の30分切断は行わない。Chrome終了などで切断されたら、実行中の操作の結果を確認し、`stop` → `start` で接続だけを作り直す。保存済みキーが有効なら接続ごとの確認は不要。失敗した検索・追加を自動再実行するものではない。拡張のキーを再発行した場合は初回設定をやり直す。

## カート追加と通信制限

公式拡張ではPlaywrightの追加CDPセッションが利用できず、Service Workerを経由する通信まで遮断する従来の仕組みを適用できない。通常のページ通信の制限と固定操作は維持するが、直接接続と同じ通信制限があるとは報告しない。結果には `serviceWorkerBypass: false` を記録する。

このため、この経路で `cart-add` は操作記録作成・クリック前に `EXTENSION_CART_ADD_UNSUPPORTED` で停止する。追加済み商品の確認は `cart-status` と `cart` を使い、再追加しない。新規追加を依頼されたときは、cart.mdを読み、従来の直接接続を使う。直接接続は公式拡張接続と別に保持できる。

```sh
npm run chrome -- --direct status
npm run chrome -- --direct start
npm run chrome -- --direct cart-add --asin <ASIN> --operation <同じ操作ID> --tab-url <実際のURL>
```

直接接続では最初の接続許可は必要。以後はChrome・接続を終了するまで保持するため、操作ごとに押し直す必要はない。直接接続の停止は `npm run chrome -- --direct stop`。公式拡張の失敗を契機に、勝手に直接接続へ切り替えて許可を要求しない。

## 検証範囲

公式拡張0.6.0とPlaywright 1.65.1の隔離ブラウザで、トークンだけの接続・切断・再接続、同じプロファイルでブラウザを再起動した後の再接続と検索まで確認済み。検索は模擬Amazonページで、フォーカス・1文字ずつの入力・0.5〜1秒待機・ベジェ移動・検索結果を検証した。ユーザーの実Chromeに拡張を導入した後は、そのプロファイルで検索まで確認する。Amazonの人間確認を防ぐ仕組みではなく、認証表示時は従来どおり停止する。

根拠：[Playwright公式拡張の導入・トークン認証](https://github.com/microsoft/playwright/blob/v1.65.1/packages/extension/README.md)。接続は同梱CLIの公開コマンドと公開Browser APIで実装し、拡張の内部接続情報やChatGPT拡張の保存データを読み出さない。
