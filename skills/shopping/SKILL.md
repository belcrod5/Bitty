---
name: shopping
description: Amazon.co.jpの商品検索・ページング・詳細取得・購入履歴の検索・ページ送り・認証後再開と、カートの合計取得・追加・削除に使う。「買い物」オーケストレーター専用。サイズ・色・タイプなどはAIが既存Chromeの同じタブで選び、カート操作は同梱プログラムで行う。注文確定・購入・ログイン操作は対象外。
---

# 買い物

検索とカート操作は同梱プログラム、商品選定と詳細ページの選択項目操作はAIが担当する。色変更専用の手順・コマンドは使わない。サイズ・色・タイプ・セット内容などは、その場の画面からAIが判断する。

## 実行

実行ディレクトリは、このSKILL.mdと同じディレクトリの `scripts/amazon/`。原本は `/Volumes/SSD-500GB-SanDisk/work/bitty-public/skills/shopping/`。Node.js 22以降とGoogle Chromeが必要。依存がなければ `npm ci --cache .npm-cache --no-audit --no-fund`。

先に [references/playwright-extension.md](references/playwright-extension.md) を読む。既存のログイン済みChromeへ公式Playwright拡張で接続し、`npm run chrome -- status` で `transport: extension`・`state: connected` を確認する。接続がなければ `start`。設定済みキーを使い、直接CDP接続への切替や接続許可の要求を繰り返さない。コマンドとAI操作を同時に実行しない。

| 操作 | コマンド |
| --- | --- |
| 商品検索 | `npm run chrome -- search "検索語" --limit 10` |
| 同じ検索ページの続き | `npm run chrome -- search-results --offset 10 --limit 10` |
| 次の検索ページ | `npm run chrome -- search-next --limit 10` |
| 商品詳細を開く（削除後も同じASINで開ける） | `npm run chrome -- detail --asin <ASIN>` |
| 選択済みの現在の詳細を読む（移動・再読み込みなし） | `npm run chrome -- detail-current` |
| 購入履歴を開いて商品JSONを取得 | `npm run chrome -- orders` |
| 購入履歴内を検索・検索語で再絞り込み | `npm run chrome -- orders-search "検索語"` |
| 現在の履歴ページを読む（移動なし） | `npm run chrome -- orders-results --offset 0 --limit 10` |
| 履歴の次ページ | `npm run chrome -- orders-next` |
| 認証後に履歴操作を再開 | `npm run chrome -- orders-resume` |
| カート内容・合計・商品詳細URLを取得 | `npm run chrome -- cart` |
| 現在の詳細ページから数量1を追加 | `npm run chrome -- cart-add --asin <選択後ASIN> --operation <追加ID> --max-price <円>` |
| 指定したカート行を削除 | `npm run chrome -- cart-remove --asin <ASIN> --item-id <行ID> --quantity <確認済み数量> --operation <削除ID>` |
| 保存状態を確認（ブラウザ操作なし） | `npm run cart-status -- --operation <ID>` |

購入履歴を探す場合は [references/orders.md](references/orders.md) を読む。履歴内の検索・ページ送りもプログラムで行う。認証時は同じタブと接続を残し、手動認証後に `orders-resume`。Chrome接続許可とAmazonの人間確認を混同せず、認証だけを理由に再接続しない。

検索・候補比較・JSONの項目は [references/catalog.md](references/catalog.md)。追加・削除・合計・再開は [references/cart.md](references/cart.md) を読む。

## 詳細ページでの選択

1. `detail --asin` で商品を開く。
2. AIのブラウザツールで、公式Playwright拡張が開いている**同じChromeプロファイルの同じタブ**を取得する。URL・商品とタブ一覧を照合し、IDを過去の会話から固定しない。引き継ぎ方法は [references/playwright-extension.md](references/playwright-extension.md#aiへの同じタブの引き継ぎ)。
3. 画面にある選択肢をAIが確認して操作する。選択ごとに状態を取り直す。新しく現れた項目・価格・在庫の変化にも対応する。プログラムに色やサイズの専用引数を渡さない。
4. `detail-current` で最終ASIN・価格・取得できた選択項目を読み、AIの画面確認と照合する。JSONは既知のDOMからの補助情報で、未知の選択UIをすべて取得できる保証はない。画面が更新中・不一致なら追加しない。
5. 追加の依頼がある場合だけ、同じタブを開いたまま `cart-add` を実行する。途中で `detail --asin` を呼んで選択済みページを開き直さない。

カート商品の変更は、元の行の商品情報を保存 → `cart-remove` → 記録のASINで詳細を開く、または検索し直す → AIが選択 → 別の追加IDで `cart-add`。元の商品を削除済みで希望品が見つからない場合は、その状態を報告する。勝手な代替品追加や自動復元はしない。複数個の行の削除は行全体を削除するため、1個だけ減らす操作と混同しない。

## 結果・停止・保守

通常はJSONで確認し、ページ画像は必要な場合だけ `--screenshots`。コマンド応答と `artifacts/<日時>/result.json`、`events.json` を確認する。操作記録は `.operations/<ID>.json`。同じ操作は同じIDで再開し、成功・成否不明の追加を別IDでやり直さない。過去の記録は削除・リセットしない。

終了コードは0（成功）、1（通常エラー）、2（認証要求）、3（追加・削除成否不明）。追加成功と後続のカート表示成功は別。認証画面では停止し、認証を自動突破しない。注文確定・購入・数量変更は実行しない。

プログラムは固定セレクタ・クリック直前のフォーム検査・送信前の永続記録を使う。要素不在・曖昧・ASINや数量の不一致ではエラー。通常20秒、商品タイトル等は30秒でタイムアウトする。画面調査が必要ならAIのブラウザツールを使えるが、未確認の成功を報告しない。選択項目の操作はAI、追加・削除はプログラムを使う。

プログラムの入力間隔とクリック前待機は0.5〜1秒。画面外の対象は `scrollIntoViewIfNeeded` で表示し、その後1〜2秒ランダムに待つ（スクロールの速度・滑らかさは指定しない）。`events.json` の `scroll` にスクロール要否・実際の移動有無・祖先コンテナごとの移動量と所要時間、`mouse-move-complete` に移動時間、`click-complete` に準備開始からクリック完了までの時間を記録する。移動量はCSSピクセル、時間はミリ秒。待機の追加で人間確認を防げるとは判断しない。マウスはベジェ曲線・ランダム中継点・変速・途中停止を使用する。AIブラウザツールでの選択には、このマウス動作を適用したとは報告しない。通信遮断は補助で、公式拡張ではService Workerの通信全体を遮断できない。

このスキルは指定オーケストレーターの `.agents/skills/shopping` から原本へのリンクで配置し、共通 `~/.codex/skills/` へ配置しない。原本をGit管理する。変更後は `scripts/amazon/` の `npm run check`・`npm test` とスキル検証を行う。実カートの変更はユーザーの対象商品への指示がある場合だけで、実装検証だけのために追加・削除しない。
