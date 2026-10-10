# 通知アイコン・音の候補

`index.html` をブラウザで開くと5用途×3パターンを確認・試聴できる。
左は拡大、右は48pxの円形表示。実際のiOS通知画面を再現したものではない。
`contact-sheet.png` は上からSimple／Soft／Retro、左から作業完了／音声完了／
承認要求／スケジュール失敗／Codex利用上限。

初期採用Simpleは `expo/notifications/assets` の本番素材を相対参照する。
Soft／Retroはこのディレクトリだけに保存し、アプリへ同梱しない。
候補切替の設定を追加せず、採用時に同名のPNG/WAVを差し替える。

512pxのPNGは既存Bittyアイコンに用途マークを事前合成したもの。
音はオリジナルの短い44.1kHz／16-bit PCM／mono WAV。
素材の円形トリミング・小さい表示・音源形式は確認済み。
iOSが付ける小さなアプリアイコンの位置や、実際の通知音は実機で確認する。

再生成にはNode.jsとImageMagickの既存 `magick` コマンドを使う（npm依存追加なし）。

```sh
node scripts/generate-push-notification-assets.mjs expo/assets/icon.png /private/tmp/bitty-notification-assets
```

指定先にSimple／Soft／Retroと確認用HTMLを生成する。
同名のPNG/WAVだけを採用先へコピーする。SVGは生成途中のファイルで配布不要。
Simpleを本番へ取り込んだ後は、候補HTMLのSimpleの参照先を本番素材へ向ける。
