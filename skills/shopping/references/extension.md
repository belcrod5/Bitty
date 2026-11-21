# 接続済みChromeで固定プログラムを実行

AIのブラウザツールが接続している普段使いChromeを、そのまま使う。追加のCDP設定・再起動・再ログインは不要。CDP診断が利用不可でも、この拡張接続は別経路なので停止しない。

## 起動

1. ブラウザ操作ツールの説明を読み、接続済みChromeとタブを列挙する。AmazonのURL・商品・タブグループから対象を選ぶ。IDを固定しない。Amazonタブがなければ、同じChromeにAmazonホームのタブを作れる。プロファイルを変えたりコピーしたりしない。
2. 同梱 `scripts/amazon/extension.mjs` の保存済み関数を、ブラウザツールのREPLに定義する。次のコマンドで両関数の定義をまとめて取り出せる。出力をそのまま使い、毎回AIが処理を書き直さない。ページ内evaluateやシェルでブラウザ操作を実行するものではない。

```sh
node --input-type=module -e "import { inspectExistingCart, runExistingChrome } from './extension.mjs'; console.log([inspectExistingCart, runExistingChrome].map(f => f.toString()).join('\n\n'))"
```

3. ツールの説明に従って得た `tab` を渡して実行する。接続・タブ選択・結果確認はAI、入力・クリック・判定は固定プログラムが担当する。Node CLIから拡張接続へ直接つなぐ方式ではなく、オーケストレーターがブラウザツール内でプログラムを呼ぶ方式。

| 操作 | REPLでの呼び出し |
| --- | --- |
| 商品検索 | `await runExistingChrome(tab, {command:'search', query:'ボールペン'})` |
| 検索結果の指定番号をクリックして詳細表示 | `await runExistingChrome(tab, {command:'detail', query:'ボールペン', index:1})` |
| ASINで詳細表示 | `await runExistingChrome(tab, {command:'detail', asin:'B084QBPLKZ'})` |
| 注文履歴リンクをクリック | `await runExistingChrome(tab, {command:'orders'})` |
| カートリンクをクリックして内容・認証判定 | `await runExistingChrome(tab, {command:'cart', asin:'B084QBPLKZ'})` |
| 移動せず表示中のカートだけ読む | `await inspectExistingCart(tab, 'B084QBPLKZ')` |

ASIN・検索語・番号は実際の依頼に合わせる。結果を `nodeRepl.write` 等で出し、操作後の表示もツールの状態取得で確認する。例：

```js
const result = await runExistingChrome(tab, {command:'search', query:'ボールペン'});
nodeRepl.write(result);
await tab.getAXState(); // このAPIが提供されるツールの場合
```

## 動作と制約

- 検索欄は `#twotabsearchtextbox`、検索ボタンは `#nav-search-submit-button`。フォーカスを確認してクリアし、1文字ずつ0.5〜1秒のランダム待機を入れて入力する。入力値の一致と同じGET検索フォームを確認してクリックする。
- クリック前にも0.5〜1秒待つ。要素がない・複数・無効、フォーカス喪失、入力値不一致、未対応フォームはエラーで停止する。通常の画面確認は最大30秒。
- 詳細は検索結果の該当ASINへのリンクをクリックし、遷移先ASINと見える商品タイトルを照合する。番号は1始まり。ASIN指定時だけ直接移動する。すでに同じ詳細ページなら再読み込みしない。
- 注文履歴は `#nav-orders` のリンクをクリックし、履歴URLと「注文履歴」の見出しを確認する。履歴URLの直開きではない。注文の内容自体は結果に抽出しない。
- カートはすでに表示中なら読み取るだけ。そうでなければ追加成功画面の「カートに移動」、または `#nav-cart` をクリックする。購入・追加・削除用リンクには移動しない。
- 戻り値の `success`・`status`・`code`・商品情報で判断する。`events` に入力・クリック前の待機時間を返す。拡張関数はCLIの `artifacts/` や操作記録を自動更新しない。URLのクエリ・フラグメント・認証情報は結果と例外から除去する。
- 人間確認・ログイン画面は `success:false, code:'AUTH_REQUIRED'` として停止する。認証を操作・回避せず、そのタブで他の操作を続けない。別タブへの切り替えで認証を避けない。認証画面の画像・HTMLを保存しない。

**拡張APIにはマウス移動がないため、ベジェ曲線・寄り道・途中停止は実装できない。** この方式の戻り値は `motion:'locator', bezier:false`。ベジェ曲線を使う操作が必要なら従来のPlaywright CLIを選ぶ。公開APIにない入力方式や内部接続情報を使って実装したことにしない。

拡張経路は検索・詳細・履歴・カート表示まで。`cart-add`・購入・削除・数量変更は受け付けない。Node CLIの通信遮断・追加POSTの1回許可は拡張経路にはない。新規単品追加は引き続きCLIの実装を使う。スキル改善の検証だけで実カートに商品を追加しない。

## 追加済み商品の確認

過去の追加操作がある場合は `npm run cart-status -- --operation <同じID>` を先に確認する。`confirmed`・`submitted`・`unknown` の商品は再追加しない。拡張経路では `cart` または読み取り関数だけを使う。対象がカートに見つからなくても、過去の追加記録を取り消さず再追加しない。過去の追加成功と、現在のカート表示は別の事実として報告する。
