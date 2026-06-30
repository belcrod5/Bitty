# Cloudflare TunnelでPrivate Runnerを公開する

## 1. 作業範囲と権限

名前付きTunnelからMacの `http://127.0.0.1:8788` だけへ転送します。Tunnelは `cloudflared`、DNSとAccessはAPIで扱い、Terraformや別CLIは追加しません。エージェントはRunner確認、既存Tunnel/DNS/AccessのGET、競合がない場合の作成、設定検証、疎通確認を担当します。

Global API Keyは禁止です。対象account/zoneに限定したAPI tokenへ、調査時は Cloudflare Tunnel Read、DNS Read、Access Apps and Policies Read、Access Service Tokens Read、作成時だけTunnel/DNS/Access Apps and PoliciesのEditを付けます。token、Tunnel credentials、OAuth secret、実メール/ドメインはrepo、引数、ログ、Expoの `EXPO_PUBLIC_*` へ保存しません。

作成物はTunnel、proxied CNAME、self-hosted Access app、端末用service tokenだけを許可するService Auth policyです。repo外には絶対pathで指定したcloudflared設定とTunnel credentials、macOS serviceが作られます。戻す場合はservice停止後、本人承認を得てAccess policy/app、DNS、Tunnelの順で削除します。

## 2. 本人操作

1. 理由: ログイン、同意、秘密発行、課金・破壊的判断は所有者本人の操作だからです。
2. 場所: `cloudflared tunnel login` のブラウザ、Cloudflare DashboardのZero Trust/API Tokens、Google Cloud Consoleを使います。
3. 選択: 対象account/zone、Zero Trust組織、最小権限token、GoogleをIdentity Providerにする場合のOAuth同意画面とWeb clientを選びます。
4. 禁止: パスワード、API/Tunnel token、OAuth Client Secret、Cookie、実メールをチャットやrepoへ入力しません。
5. 完了確認: 「ブラウザ認証完了」、非秘密のリソース名/ID、秘密を伏せた状態をエージェントが再読します。
6. 再開情報: 認証完了、account/zone ID、予定hostname、Tunnel名、Access app名だけを共有します。許可メールはMacの環境変数にだけ設定します。

Zero Trust組織の初回作成・規約同意、Google OAuth client作成とCloudflareへのID/secret登録、MFA、token発行、課金は本人が行います。

## 3. 調査、作成、自動起動

`cloudflared` を公式手順で導入し、本人がブラウザ承認を完了します。秘密値は安全な方法でshell環境へ設定します。作成後、`TUNNEL_ID` placeholderは表示された非秘密のTunnel IDへ置き換えます。

```sh
export CLOUDFLARE_API_TOKEN; read -r -s CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID=CLOUDFLARE_ACCOUNT_ID
export CLOUDFLARE_ZONE_ID=CLOUDFLARE_ZONE_ID
export CLOUDFLARE_HOSTNAME=app.example.com
export CLOUDFLARE_TUNNEL_NAME=runner-tunnel
export CLOUDFLARE_ACCESS_APP_NAME=runner-access
export CLOUDFLARE_ACCESS_SERVICE_TOKEN_ID=ACCESS_SERVICE_TOKEN_ID
export CLOUDFLARED_CONFIG_PATH="$HOME/.cloudflared/config.yml"
scripts/cloudflare-runner.sh check
scripts/cloudflare-runner.sh apply
```

`apply` はTunnel作成前に設定先とcredentials先を検査し、ファイル作成に必要な親ディレクトリの書込・検索権限も確認します。作成後は返されたIDから標準の `$HOME/.cloudflared/<TUNNEL_ID>.json` を導出して実在確認します。別のrepo外絶対pathを使う場合だけ、事前に `CLOUDFLARED_CREDENTIALS_FILE` で上書きします。

`check` はRunner health、API token、対象Access service token ID、既存Tunnel/DNS/Access policyを読み、同名/name/domain競合で変更前に停止します。`apply` はTunnel、DNS、Access app、policyの非秘密IDを作成直後に出力します。途中失敗時は再実行せず、その出力を使って作成済みリソースをGETしてください。

```sh
cloudflared tunnel --config "$CLOUDFLARED_CONFIG_PATH" run
cloudflared tunnel info "$CLOUDFLARE_TUNNEL_NAME"
cloudflared service install
launchctl list | grep cloudflared
```

小規模な個人構成では、ログイン時に起動するユーザーLaunchAgentを使います。`cloudflared service install` は `$HOME/.cloudflared/config.yml` を読むため、`CLOUDFLARED_CONFIG_PATH` もこのpathにします。エージェントはinstallと、その後のlaunchd状態・Tunnel接続を確認できます。rootのLaunchDaemonが必要な場合だけ、本人判断と管理者認証のもとで別途設定します。

private runner の通常起動では tunnel は起動しません。Cloudflare 経由で公開する時だけ `CLOUDFLARE_TUNNEL_ENABLE=1` または `./private_runner/run-local.sh start --mode full --cloudflare-tunnel` で明示 opt-in し、`cloudflared tunnel --config "$CLOUDFLARED_CONFIG_PATH" run` を同時起動します。`CLOUDFLARE_TUNNEL_ID` は非秘密のTunnel UUIDですが、repoには実値を書かず、local `.env` だけに置きます。

接続監視の主情報は `cloudflared tail` ではなく runner側のWebSocket認証ログにします。理由は、tailには監視API自身や通常HTTP同期も混ざり、新規接続判定の主役にすると情報過多で見落としが増えるためです。Expoの左メニュー `Cloudflare Tunnel` は private runner の `GET /runner/connection-events` を読みます。APIは拒否・エラーの `events` と認証成功の `allowedEvents` を別々に保持し、最新成功を `latestAllowedEvent`、現在接続中を `activeConnections` として返します。token本文、Cloudflare Access secret、Cookie、payload本文は保存しません。

`cloudflared tail` は常時起動しません。必要な調査時だけ手元で一時実行する補助ログ扱いです。Tunnel opt-in 時の起動前に `cloudflared ingress validate` と静的なservice確認を行い、転送先が `http://127.0.0.1:8788` と `http_status:404` だけでない場合は停止します。停止時はpid fileのPIDが対象プロセス名に一致する場合だけ終了します。古い版で起動したtail supervisorが残っている場合、`run-local.sh stop` がPIDファイル経由で停止します。

## 4. HTTP、WebSocket、Access確認

Access service token設定後に `https://app.example.com/health`、同じ端末設定から `wss://app.example.com/runner-ws` を確認します。Runnerには別途 `RUNNER_TOKEN` が必要で、URLやログへ残しません。APIでService Auth policyが対象service tokenだけをIncludeし、Bypass/Everyoneがないことを再確認します。

ExpoはブラウザCookieやManaged OAuthではなく、Service Tokenの `CF-Access-Client-Id` / `CF-Access-Client-Secret` をRunner originへのHTTP/WebSocketに付与します。HTTP成功だけでは完了扱いにせず、WebSocketの接続とRunner側Bearer認証も確認します。

WebSocketはfail-closedにします。Runner WSへ `RUNNER_TOKEN` が無い場合は接続を作らず、認証ヘッダー付きWebSocket作成に失敗した場合も、認証なしWebSocketへフォールバックしません。`RUNNER_TOKEN` はURL queryへ載せず、WebSocket handshakeの `Authorization: Bearer` で送ります。`token_missing` はrunner側に送って拒否させるのではなく、アプリ側で接続前に止めます。

Expo側で常時接続の補助WebSocketは作りません。会話、診断、TTSなどの実操作が必要な時だけ、共通の認証ヘッダー付きWebSocket生成経路を使います。接続監視画面は runner の `/runner/connection-events` をHTTPで読み、監視のためだけに `/runner-ws` へ別接続しません。

### ローカル接続とTunnel接続の切り替え

Cloudflare Tunnel は、同一LAN内の端末を自動的にローカル経路へ切り替えません。Expoアプリは、Pairing QRに含まれるCloudflare接続先とローカル接続先を保存し、アプリ側で接続先を選びます。

- ローカル接続: `http://<MacのLocalHostName>.local:<port>` / `ws://<MacのLocalHostName>.local:<port>/runner-ws`
- 外部接続: `https://<Cloudflare Tunnelのドメイン>` / `wss://<Cloudflare Tunnelのドメイン>/runner-ws`

ローカル接続を使う場合、runner は `127.0.0.1` ではなく `0.0.0.0` で待ち受けます。`.local` が解決できないネットワークもあるため、Expoアプリはローカルrunnerの `/health` へ1回だけ疎通確認し、成功した場合だけローカル接続へ切り替えます。失敗した場合はCloudflare Tunnel接続を使います。

再判定のタイミングは、アプリ初回起動時、iOSのネットワーク変更イベント発生時、アプリがbackground/inactiveからactiveへ戻った時だけです。ネットワーク変更イベントと復帰イベントが重なった場合は約500msのデバウンスで1回にまとめます。定期ポーリングは行いません。同じ接続先がすでに選択されている場合、ExpoアプリはURLを更新せず、WebSocketの再接続も発生させません。

### 現行WebSocketライフサイクルの事実

Expoはアプリ全体で1本の `/runner-ws` を共有していません。ディレクトリのセッション一覧取得では、各 `thread/list` 呼び出しが `runCodexRpcSession` を通じて新しいWebSocketを作り、RPC完了後に閉じます。そのため、登録ディレクトリの一括更新ではディレクトリ数と同数の短命WebSocketが作られ、更新が複数回走ればその回数分増えます。セッション詳細の `thread/read` なども別の短命WebSocketです。

2026-06-27の実ログでは、22ディレクトリの `thread/list` が3巡して66接続、セッション詳細取得が6接続あり、約53秒間に合計72回の認証成功として記録されました。これは72回のユーザー操作や72人のアクセスを意味せず、同一アプリが作った72本のWebSocket handshakeです。接続監視の `repeatCount` は現在このWebSocket本数を数えるため、人間のログイン回数として解釈しません。

## 4.1 Expo向けAccess通過設計メモ

最終経路は `Expo -> Cloudflare Access -> Cloudflare Tunnel -> private runner` です。`~/.cloudflared/cert.pem` と `~/.cloudflared/<TUNNEL_ID>.json` はMac上の `cloudflared` がTunnelを張るためだけに使い、Expoへ渡しません。

Cloudflare Accessをブラウザログインではなくアプリ専用で通す場合は、Access service tokenを使います。Cloudflare公式のservice token方式では、クライアントが `CF-Access-Client-Id` と `CF-Access-Client-Secret` を送ります。Access policyはService Authで対象service tokenだけをIncludeし、BypassやEveryoneは使いません。

Expoの初期設定は、runner起動時にMacのターミナルへ一時QRを表示し、iPhoneアプリの左メニュー `Cloudflare Tunnel` から読み取ります。QRには `Runner URL`、起動ごとに生成する `RUNNER_TOKEN`、`CF-Access-Client-Id`、`CF-Access-Client-Secret` を入れます。QR自体を秘密として扱い、スクリーンショットや共有はしません。読み取り後はiOS SecureStoreへ保存し、ソースコード、repo、Expo bundle、ログへ保存しません。

`RUNNER_TOKEN` は起動ごとにランダム生成する方針です。これにより、前回のQRや端末側設定が漏れた場合でも、runner再起動でprivate runner側のBearer tokenを失効できます。一方でCloudflare Access service tokenはCloudflare側の長期credentialなので、毎起動生成ではなく、紛失・端末入れ替え・期限切れ時にCloudflare上で削除/再発行します。Service Tokenは無期限ではなく1年など期限付きにし、期限切れ時はCloudflare Dashboardで対象端末用のService Tokenを再作成して、Mac Keychainへ保存し直してからPairing QRを読み直します。

`CF-Access-Client-Id` だけをExpoの `.env` やbuild-time設定へ固定しません。Client ID単体はSecretほど危険ではありませんが、Service Tokenを削除/再発行するとClient IDも変わるため、アプリ再ビルドなしで差し替えられるQR/SecureStore管理の方が小さく安全です。QRには `CF-Access-Client-Id` と `CF-Access-Client-Secret` をセットで入れ、端末側では両方をSecureStoreへ保存します。

runner側のQR生成には `RUNNER_PUBLIC_URL=https://app.example.com` が必要です。Access service tokenは `.env` へ実値を書かず、macOS Keychainの `bitty-cloudflare-access-client-id` と `bitty-cloudflare-access-client-secret` に保存する運用を推奨します。起動時に `RUNNER_TOKEN_MODE=random` の場合、既存runner再利用は無効化され、tokenはmode 600の `RUNNER_TOKEN_FILE` にだけ置かれます。

detached起動ではQRをログへ残さないため自動表示しません。起動後に手元のターミナルで `./private_runner/run-local.sh pairing-qr` を実行して表示します。foreground起動でstdoutがTTYの場合だけ、起動直後にQRを表示します。

## 5. 停止、削除、rotation

`cloudflared service uninstall` でユーザーLaunchAgentを停止します。削除前はIDをGETし、所有者の破壊的変更承認を得ます。対象credentialsだけを消し、`cert.pem` や他Tunnelは残します。一時API tokenは失効し、長期tokenは同じ最小権限で新規発行、verify/check成功後に旧tokenを失効してrotationします。

`./private_runner/run-local.sh stop` は runner と、run-local で起動した cloudflared tunnel を停止します。古い版で起動したtail supervisorのPIDファイルが残っている場合も停止対象にします。手動停止が必要な場合は、pid file `private_runner/logs/cloudflared-tunnel.pid` のPIDだけを確認し、対象プロセスを終了してください。
