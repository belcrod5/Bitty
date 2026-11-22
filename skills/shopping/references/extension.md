# ChatGPTのブラウザツールで固定プログラムを実行

確認ボタンを繰り返さずPlaywrightのベジェ移動も使う場合は、先に [playwright-extension.md](playwright-extension.md) の公式拡張方式を使う。以下はChatGPTのブラウザツール経由の既存方式で、公式Playwright拡張とは別。

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


## Chromeへの直接接続

ユーザーが拡張経由ではなくPlaywrightから普段のChromeへ直接接続することを希望した場合に使う。Chrome 144以降のリモートデバッグ接続を利用し、URLやポート番号の入力は不要。新規起動のPlaywright接続とは異なるCDP接続なので、同等の互換性やAmazonの認証が出ないことは保証しない。

初回はユーザーがChromeで `chrome://inspect/#remote-debugging` のリモートデバッグを有効にし、プログラム接続時のChromeの許可ダイアログで許可する。接続先はログイン状態を利用できる。設定変更がブラウザ操作ツールで禁止されている場合は、別の操作方法で迂回せず、この有効化をユーザーに引き継ぐ。既存のAI拡張機能は削除・無効化しない。

有効化後は、`--direct` 付きの保持コマンドを使う。公式Playwright拡張とは別に接続を保持する。

```sh
npm run chrome -- --direct start
npm run chrome -- --direct status
```

`start` は接続要求を別プロセスで保持する。Chromeの許可はユーザーが押す。`status` が `connected` になったら、表示されるAmazonタブのタイトル・URLから対象を特定する。`waiting_for_permission` の間は新しい接続を開始せず、許可を待つ。接続が有効な間、次のコマンドは同じPlaywright接続を使い、許可を再要求しない。

```sh
npm run chrome -- --direct search "ボールペン" --tab-url <実際のタブURL>
npm run chrome -- --direct detail --asin B084QBPLKZ --tab-url <実際のタブURL>
npm run chrome -- --direct orders --tab-url <実際のタブURL>
npm run chrome -- --direct cart --tab-url <実際のタブURL>
```

新規単品追加も `npm run chrome -- --direct cart-add --asin <ASIN> --operation <同じ操作ID> --tab-url <実際のタブURL>` で実行できるが、先にcart.mdと保存済み状態を確認する。削除は同じ保持接続のcart-removeを使い、cart.mdに従う。購入は対象外。結果はJSONと `artifacts/` に保存され、認証・成否不明・通常エラーの終了コードは従来CLIと共通。操作途中で呼び出し側が切断しても処理は自動再実行しない。とくにカート追加は同じ操作IDの記録を確認する。

終了は `npm run chrome -- --direct stop`。既存のタブは閉じない。操作の間隔では自動切断しない。Chrome終了・接続停止後に再接続する場合は、Chromeの許可が再び必要。失敗・切断を自動再接続せず、`status` とログを確認する。複数コマンドの同時実行はエラーで停止する。

タブの作成・取得と、Chromeでの選択は別。`getTab` や `claimTab` を呼んだだけで前面表示済みと判断しない。必要ならmanagementのタブ情報の `active` を読む。切り替えAPIが非対応の場合は、識別しやすいグループ名とタブ名でユーザーに選択を引き継ぐ。既に表示されているホームは再読み込みせず検索する。クリックは対象全体が表示範囲内ならスクロールの安定待ちを省き、直前のヒットテストを維持する。

接続時は `noDefaults:true` でPlaywrightによるブラウザ既定設定の上書きを抑制する。端末の前景プロセスはエージェントの返答時に終了することがあるため、許可待ちに短いタイムアウトのCLIを繰り返し起動しない。旧 `npm run browser-status -- --cdp chrome` はその実行中だけ接続し、確認後すぐ切断するため、この用途では保持コマンドを使う。`browser-status` だけなら読み取り診断で、Chromeへの接続や許可要求は行わない。

既存Chromeでは対象タブのCDP Networkを有効化し、操作中だけService Workerを経由せず、ページの通信をCLIの制限で検査する。登録やキャッシュは削除せず、終了時にこの設定を解除する。他のタブには適用しない。設定できない場合は入力前に停止する。

Chrome 157の既存ログイン済みブラウザで、検索欄のフォーカス確認・1文字ずつの入力・ベジェ移動・検索クリック・結果表示と、操作後の接続保持を実機確認済み。今回の検索では人間確認は出なかった。認証状態は操作ごとに判定し、今後も認証なしで成功するとは扱わない。検索画面の右側ミニカートには読込エラーが表示されたため、検索成功とカート表示成功は分けて判断する。
