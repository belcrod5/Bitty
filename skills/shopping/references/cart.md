# カート取得・追加・削除

ユーザーが指定した商品への追加・削除・変更の依頼に使う。検索だけの依頼や実装検証だけで実カートを変更しない。注文確定・購入・ログイン・既存の数量値の変更は対象外。

## 操作

公式Playwright拡張の同じ保持接続を使う。接続先をユーザーに探させず、操作ごとの接続や直接CDPへの切替を行わない。

```sh
npm run chrome -- cart
```

`cart` の `items` は `asin`、`itemId`（サーバーのカート行ID）、`productUrl`、`title`、`quantity`、`priceText`、`variantText`、`selected` を返す。商品詳細は `detail --asin <asin>` で開く。削除した後もASIN・詳細URLを利用できる。在庫切れや商品ページ消滅は別途判断する。

追加と削除には別々の `--operation` を使う。同じ追加・同じ削除を再呼び出しするときは元のIDを渡す。例えば商品の交換なら `change-001-remove` と `change-001-add` に分ける。

操作IDによるロック・送信状態の保存・二重送信の防止はプログラム内部の処理。AIによる記録ファイルの事前確認や進行状況の別途保存は不要。通常はコマンドが返すJSONを使う。`cart-status` は不具合調査用の読み取りコマンドで、通常操作の前提ではない。

## 現在の選択から追加

商品詳細の項目はAIがブラウザツールで選ぶ。サイズ・色・タイプを選び終わったら、そのタブを維持する。

```sh
npm run chrome -- detail-current
# 現在の表示・ASIN・価格を確認する。ページを開き直さない。
npm run chrome -- cart-add --asin <選択後ASIN> --operation <追加ID> --max-price <確認した円価格>
```

`cart-add` は既存接続専用で、詳細ページへの移動・再読み込み・選択操作を行わない。現在のURLと通常追加フォームのASIN、数量1、POST先、送信ボタンを検査する。取得できた全選択項目と価格をクリック直前にも比較し、途中で変われば未送信で停止する。選択の適否はAIが画面から確認する。`--color`・`--size` は廃止し、特定の選択項目の指定を必須にしない。

`--max-price` は表示単価の上限（整数の円）。指定時に価格が不明・超過なら送信しない。追加は数量1のみ。数量は、選択した追加ボタンの `button.form` と送信ボタンを指定した `FormData` から取得する。標準の `quantity` / `quantity.N` と、同じASINを明示した `items[0.base][quantity]` に対応する。数量欄が隠し項目や `form` 属性でフォーム外に配置されていても、実送信対象なら検証する。通常は数量項目1件・値は厳密に `1` を要求する。例外として `quantity=1` と `items[0.base][quantity]=1` が各1件併存し、単一の `ASIN` と `items[0.base][asin]` がともに対象商品を示し、他商品の項目がなく、専用 `/cart/add-to-cart` POST先と通常追加の `submit.add-to-cart` が選ばれたフォームに対応する。この2形式は同じ商品の数量1として扱い、合算しない。数量の不一致・2以上・同名重複・その他の複数形式・別商品・未知の数量名は停止する。クリック直前と取得できた実POSTにも同じ検査を適用する。ページ全体の `#quantity`、サイドカートや別フォームの数量、「今すぐ買う」専用設定は追加数量の根拠にしない。省略時の既定値は推測しない。

数量が完全に省略された既知の単品フォームでは、プログラムが同じフォームに `items[0.base][quantity]=1` を明示してから再検査する。条件は `addToCart` フォーム、通常追加の `submit.add-to-cart`、専用 `/cart/add-to-cart` POST先、単一の `ASIN` と `items[0.base][asin]` の一致、他商品の項目なし、数量関連の送信値・要素（無効な欄も含む）・ページ内の `#quantity` がすべてないこと。既存の数量を上書きしない。条件外の省略は従来通り停止する。追加した数量欄がクリック直前に消失・変更した場合も停止し、自動補充しない。未送信で失敗した場合だけ補った欄を除去する。送信後は非同期処理に必要な欄を残し、同じ操作記録で再追加を防ぐ。

`QUANTITY_UNVERIFIED` では未送信のまま停止し、`events.json` の `cart-add-form-check` を読む。`cart-add-quantity-explicit` は省略数量を明示した記録。`stage` は初回／数量明示後／クリック直前、`quantity.reason` は `missing`・`ambiguous`・`not_one`・`unsupported_field`・`item_asin_mismatch`・`unsupported_form`。実送信数量、対象フォームの数量要素、ページ内の `#quantity` とフォーム所属、関連項目名を記録する。CSRF・セッション等の無関係なフォーム値は記録しない。

カートへ移動した後、最終ASIN・数量・`variantText`・価格を確認する。

| addition | 結果の意味・プログラムの動作 |
| --- | --- |
| `not_started` | 未送信。検査して1回だけクリック可能 |
| `submitted` | 送信直前に保存済み。プログラムが二重送信を防止 |
| `unknown` | 追加成功を確認できていない。同じIDの再呼び出しではプログラムが成功表示の読み取りだけを行う |
| `confirmed` | 追加成功表示を確認済み。同じIDの再呼び出しはカート表示だけ |

`retryAdd: false` はプログラムが追加クリックを行わない状態。`targetPresent` は現在のカートに追加対象ASINがあるかどうかで、当該操作の成功とは別の値。

## 指定したカート行の削除

カート取得結果から対象のASIN・行ID・現在数量を指定する。数量は確認条件であり、削除する個数ではない。**行全体を削除する**。別商品への交換、色・サイズ・タイプ変更、単純な取り消しに同じ機能を使う。

```sh
npm run chrome -- cart-remove --asin <ASIN> --item-id <itemId> --quantity <現在数量> --operation <削除ID>
```

クリック前に `removedItem` として商品情報・選択表示・数量・価格・詳細URLを保存する。指定した行IDのASINと数量が一致する場合だけ、その行の通常の「削除」を1回クリックする。まとめ商品に伴う関連行の削除は未対応。対象が見つからない初回実行はエラーにし、削除済みと推測しない。

結果は `removal: not_started / submitted / unknown / confirmed`。削除後に固定した行IDが消えたことを確認して成功とする。削除結果の `targetPresent` は**行IDの存在**で、同じASINの別行は削除しない。`removedItem.productUrl` と `removedItem.asin` は削除後・再開後も保持する。

成否不明では同じIDで再開する。GETでカートを取り直し、対象行がなければ再クリックせず確認済みにする。同じ行ID・ASIN・数量が残っている場合だけ削除段階を再開できる。数量変更や同じ行IDの別ASINでは停止する。認証では停止し、状態を保持する。別の行IDに置き換えて削除しない。

## 商品変更の組み立て

AIが「今追加した商品」を会話の文脈と現在のカートから特定する。元の商品情報を確認して削除し、元のASINから詳細を開くか、必要に応じて検索し直す。その後はAIがブラウザで選択し、`detail-current` → 新しい追加IDで `cart-add` を使う。

希望する代替品がなければ「元の商品は削除済み、新しい商品は未追加」と報告し、勝手な復元はしない。

## 合計金額

`subtotalText`・`subtotalYen`・`subtotalLabel` はAmazon表示の選択中商品の小計。`allItemsSubtotalYen` は全有効商品の単価×数量で、未選択も含む。`allItemsQuantity` は数量合計。削除済みプレースホルダーは除外する。

価格・数量不足では全合計を `null`・`totalsComplete: false` とし、推測しない。`subtotalMatchesSelectedItems` が不一致なら更新中や割引を調べ、計算値と表示小計を区別する。送料・ポイント利用などを確定する購入画面は開かないため、最終支払額とは呼ばない。

## 認証と結果

`cart` 状態は `visible`、`verification_required`、`login_required`、`unknown`、`not_opened`。**追加confirmed・カートverification_requiredは追加済み**。追加の結果とカート表示の結果を分けて報告する。

通常追加のフォーム・ボタン・数量・商品IDをクリック直前に検査する。ページ通信の制限は補助であり、公式拡張ではService Worker通信の完全な遮断は保証しない。Amazon通常フォームの `isBuyNow=1` は専用追加URLと通常追加送信ボタンの組み合わせに限り許可し、購入ボタンは送信しない。

`/checkpoint/continue`、`/ap/`、CAPTCHAで停止する。認証の原因や今後の発生有無を断定しない。認証画面の画像・HTMLは保存せず、URLのクエリ・フラグメント・認証情報は結果と例外から除去する。

終了コード0は必要な確認まで成功、1は通常エラー、2は認証、3は追加・削除成否不明。コマンドの結果JSONで、どの操作まで完了したかを報告する。
