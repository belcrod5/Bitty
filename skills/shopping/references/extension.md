# 既存Chromeの拡張接続を使う

AIのブラウザツールがすでに接続しているChromeは、Node CLIのCDPとは別の接続で利用できる。CDP診断が `unavailable` でも拡張接続まで利用不可とは限らない。接続先URL・Chromeの設定変更・再起動を求める前に、この経路を確認する。

## カートの読み取り

1. 利用できるブラウザ操作ツールの説明を読み、接続済みChromeとタブを列挙する。AmazonのURL・商品・タブグループから対象を特定する。ブラウザIDやタブIDを固定値にしない。ユーザーの既存タブを選び、読み取りのためにページを再読み込みしない。
2. 過去の追加操作がある場合、`npm run cart-status -- --operation <同じID>` で記録を確認する。`confirmed`・`submitted`・`unknown` は再追加しない。
3. 同梱 `scripts/amazon/extension.mjs` の `inspectExistingCart` をブラウザツールのJavaScript実行環境で定義して、選択したタブを渡す。毎回AIが処理を書き換えず、保存済み関数をそのまま使う。次のコマンドで関数定義を取り出せる。出力をシェルやページ内evaluateで実行するのではなく、ブラウザツールのREPLで定義する。

```sh
node --input-type=module -e "import { inspectExistingCart } from './extension.mjs'; console.log(inspectExistingCart.toString())"
```

ブラウザツールの説明どおりに取得した `tab` に対し、関数定義の後で実行する。ASINは実際の依頼に合わせる。指定しなければカート全体を返す。

```js
nodeRepl.write(await inspectExistingCart(tab, 'B084QBPLKZ'));
```

接続とタブ選択はAI、商品抽出・数量取得・認証判定は固定プログラムが担当する。関数はURLとDOMの読み取りだけを行い、クリック・移動・追加・削除・数量変更を行わない。認証URLのパラメーターやページ本文は返さない。`targetPresent: false` でも追加記録を取り消したり再追加したりしない。現在のカート内容の確認と、過去の追加成功の記録は別の事実として報告する。

## 対応範囲

この経路で実装・検証済みなのは、表示中のカート内容と認証状態の読み取り。未表示なら対象の既存カートタブを探し、見つからなければ未表示と報告する。

拡張APIでの固定スクリプトによる入力・クリックは可能だが、公開APIにはマウス移動がなく、元のベジェ曲線を再現できない。また、Node CLIの通信遮断・追加POSTの1回許可もこの関数にはない。検索・詳細・履歴・新規追加をこの経路に自動で置き換えたことにしない。ベジェ曲線など元の動作要件が必要な操作は引き続きPlaywright CLIを使う。要件を変更して拡張方式の入力・クリックを実装する場合は、差をユーザーに伝えてから対象範囲を変更する。
