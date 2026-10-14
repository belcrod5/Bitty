# 通知アイコン・音の候補

`index.html` をブラウザで開くと5用途×3パターンを確認・試聴できる。
左は拡大、右は48pxの円形表示。実際のiOS通知画面を再現したものではない。
`contact-sheet.png` は上からSimple／Soft／Retro、左から作業完了／音声完了／
承認要求／スケジュール失敗／Codex利用上限。

初期採用Simpleは `expo/notifications/assets` の本番素材を相対参照する。
Soft／Retroはこのディレクトリだけに保存し、アプリへ同梱しない。
候補切替の設定を追加せず、採用時に同名のPNG/WAVを差し替える。

512pxのPNGは用途シンボル単体を中央に大きく描いたもの。
大きな円は用途画像、右下の小さなBittyアプリアイコンはiOSが自動表示する。
用途画像にBittyの顔や小さな用途バッジは含めない。
Simpleの音は実機で確認済みのKenney素材（[出典・CC0](../../../expo/notifications/assets/sounds/README.md)）。
Soft／Retroの音は採用対象外の比較素材として保持する。どのWAVもアイコン生成の対象には含めない。

素材の円形トリミング・小さい表示・音源形式を確認済み。
採用素材はiOSが付ける小さなアプリアイコンを含めて実機で表示・通知音を確認済み。

再生成にはNode.jsとImageMagickの既存 `magick` コマンドを使う（npm依存追加なし）。

```sh
node scripts/generate-push-notification-assets.mjs /private/tmp/bitty-notification-icons
```

生成器はアイコン専用。指定先にSimple／Soft／RetroのPNGと確認用HTMLを生成する。
同名のPNGだけを採用先へコピーする。SVGは生成途中のファイルで配布不要。
既存WAVは生成・変更しない。確認用HTMLの音声は採用先の既存ファイルを参照する。
Simpleを本番へ取り込んだ後は、候補HTMLのSimpleの参照先を本番素材へ向ける。
