# 普段のChromeをBittyから操作する

使用するChromeプロファイルに一度だけBitty拡張を登録します。AIが使っていた同じタブを、ログイン状態や入力状態を維持したままiPhoneへ引き継ぎます。接続ごとのMac側の許可ダイアログは使用しません。

## 初回だけの設定

1. Runnerのリポジトリで次を実行します。既定では変更予定だけを表示します。

   ```sh
   node scripts/browser-control/install-extension.mjs
   node scripts/browser-control/install-extension.mjs --apply
   ```

2. **使用するChromeプロファイル**で `chrome://extensions` を開き、「デベロッパーモード」を有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」で、コマンドが返した `extensionPath` を選択します。初回の拡張権限の確認はユーザーが行います。
4. 同じChromeを起動したまま、エージェントに同じタブの操作パネルを依頼します。

拡張・Native Messagingホストと接続に必要な既存ws実装は、ユーザーの `Library/Application Support/Bitty/BrowserControl` にコピーされます。ホストは既存の共有Runner socketを利用し、専用の接続キーを同じ保存先に所有者専用権限で保持します。Runnerの管理トークンをChromeへ渡しません。開発worktreeを削除しても動作します。ソースを更新して拡張を更新するときは再度 `--apply` し、Chromeの拡張ページからBitty拡張を再読み込みします。Chromeの他の拡張やログインデータは変更しません。

## 接続と引き継ぎ

```sh
node skills/bitty-browser-control/scripts/bitty-browser-control.mjs discover --origin https://example.com
node skills/bitty-browser-control/scripts/bitty-browser-control.mjs request \
  --context ctx_CURRENT_TURN --browser-id BROWSER_UUID --target-id CDP_PAGE_ID \
  --origin https://example.com --label 'ブラウザを操作してください'
```

`discover` は指定サイトの `targetId`、Chromeの実際の `tabId`、originだけを返します。ChatGPT等のブラウザツールの独自IDを流用しません。複数のタブが一致するときはAIが使っていたタブを特定してから指定します。タブを新しく作成したり、別プロファイルへ切り替えたりしません。

最初はカード情報だけを作成し、iPhoneで「ブラウザを開く」を押すと、そのタブへの接続・画面転送を始めます。画面や入力はAIの応答、履歴、ログへ返しません。Wi-Fi切り替えやアプリの背景化では私的な表示・入力を破棄し、同じカードを開き直せます。ChromeやNative Messagingホストが再接続した場合は、古いブラウザIDで別プロファイルへ接続せず、同じタブを検出してカードを作り直します。

`browser_extension_not_connected` は初回設定・Chrome起動・Runner起動を確認します。`browser_extension_ambiguous` は複数のプロファイルでBitty拡張が動いている状態です。対象以外のプロファイルではBitty拡張を無効にし、対象プロファイルだけで接続してください。
