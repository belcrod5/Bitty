# 商品JSONとページング

検索から商品を選ぶときに読む。入力・クリック・JSON抽出は同梱プログラムが行い、AIは取得値から依頼条件に合うASINを選ぶ。既存Chromeは公式拡張の同じ保持接続を使う。

```sh
npm run chrome -- search "消しゴム" --limit 10
npm run chrome -- search-results --offset 10 --limit 10
npm run chrome -- search-next --limit 10
npm run chrome -- detail --asin <返されたASIN>
```

## 検索結果

`result.json` とコマンドの応答に `products` を返す。各商品は `index`（現ページの1始まりの表示順）、`asin`、`title`、`priceText`、`ratingText`、`ratingCountText`、`sponsored`、商品URLの `url`、商品画像URLの `imageUrl` を持つ。広告も表示順に含む。取得できない値は `null`。価格や評価件数を推測で補わない。表示価格は送料・クーポンなどを含む支払総額ではない。

既定は10件、`--limit` は1〜20、`--offset` は0始まり。`productCount` は現在のページに読み込まれた商品数で、全検索結果の総数ではない。

- `nextOffset`：同じページに未取得の商品があれば次の開始位置、取得済みなら `null`。`search-results` で続きを取得する。再検索・クリックは行わず、画面下にある読み込み済み商品もDOMから取得できる。
- `hasNextPage`：次の検索ページへのリンクがあるか。`search-next` はそのリンクを1回クリックし、検索語とページ番号を検証する。終端ではクリックせず `pageChanged: false` を返す。
- `page`：実際の検索ページ番号。ページを移動した後の `offset` は既定で0から始まる。

依頼に必要な分だけ取得する。`nextOffset: null` と `hasNextPage: false` は別の意味。全ページを自動巡回したり、全商品のJSONをまとめてAIに渡したりしない。

## 商品詳細

JSONの `asin` を `detail --asin` に渡す。商品詳細のASINを検証し、`productTitle`、`priceText`、`availabilityText`、`ratingText`、`ratingCountText`、`features`、`specifications`、`imageUrl` を返す。特徴は最大8項目、仕様は最大16項目。長い値や件数を省略した場合は `contentTruncated: true`。レビュー本文や商品説明全文は取得対象ではない。

旧来の `detail "検索語" --index N` は再検索してその表示番号をクリックする。表示順が変わる場合があるので、取得済みの商品を選ぶときはASINを使う。

## 画像と認証

通常はJSONを読む。`imageUrl` は商品の写真のURLで、写真やページ画像を自動でAIへ送信するものではない。外観・色・デザインを判断したいときだけ対象商品の画像を確認する。ページの見た目を調べたい場合は `--screenshots` を付ける。画像は読み取りが必要なものだけAIに渡す。

画像入力のトークン数はモデル・サイズ・詳細度によって異なる。JSONも情報量が増えればトークンを使うため、常に画像より安いとは断定しない。[OpenAI公式資料](https://developers.openai.com/api/docs/guides/images-vision#calculating-costs)

認証画面が出たらJSON取得やページングを止める。カート操作・購入は、この読み取り手順からは実行しない。

2026-11-22、ログイン済みの実Chromeで検索→同じページの続き取得→1ページ目から2ページ目へのクリック→返されたASINの商品詳細JSON取得まで確認した。ページ画像の保存は0件で、接続許可の追加操作は不要だった。
