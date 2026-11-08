# Private Runner 本人ログインの導入と運用

## 採用した動作

Cloudflare Accessと初回接続QRを維持する。接続設定後、所有者メールの8桁コードと認証アプリの6桁TOTPで本人ログインする。新しい端末セッションが成立したときだけ確認メールを送る。メールによる事前承認は要求しない。

端末セッションは最長30日、最後の認証付き利用から7日で失効する。背景通信も利用として数えるが30日の期限は延長しない。端末一覧から個別に失効でき、他端末の失効には5分以内の再認証が必要である。失効後はHTTP、WebSocket、音声stream、APNsの新規配送を止める。既に配信された通知や取得済みデータは回収できない。

初回実装は単一所有者である。メール変更、通常のTOTP再登録、全端末一括失効はMacのローカルreset→setupで行う。公開の復旧はメールコードと一度限りの復旧コードを両方確認し、新TOTPへ切り替えたうえで全セッションを失効する。メールだけの復旧はない。

## 切替前の準備

1. 対応版のRunner、iPhone / macOSアプリ、ローカルCLIを用意する。旧アプリとの認証互換猶予は設けない。
2. MailjetのAPIキー、API secret、検証済み送信元をローカルの `private_runner/.env` 等へ設定する。変数名は `MJ_APIKEY_PUBLIC`、`MJ_APIKEY_PRIVATE`、`RUNNER_LOGIN_MAIL_FROM`。前2つは `MAILJET_API_KEY`、`MAILJET_API_SECRET` も読める。値をチャット、repo、コマンド引数、ログへ出さない。
3. Cloudflare AccessのService Auth policyとTunnel転送先 `http://127.0.0.1:8788` を維持する。認証画面を公開するためのBypass等は追加しない。
4. インストール済みの `bitty-session` skill、`bitty-history`、schedule CLIと子processも対応版にする。配布元は [install-bitty-session.mjs](../scripts/skills/install-bitty-session.mjs)。既存インストールの扱いは同コマンドのdry-run結果を確認する。旧HTTP URLへ戻るfallbackはない。
5. 常用Runnerを停止してから対象worktreeへ切り替える。同じmainのlogsを共有するRunnerを同時起動しない。本番設定変更と起動は所有者が行う。

認証storeの既定は `private_runner/logs/runner-login`、ローカル制御socketの既定はlogsの実体directory内の `runner-control.sock`。socket pathは `RUNNER_CONTROL_SOCKET` に同じ絶対pathを渡す。logsと認証storeのdirectoryは0700、state / token / socketは0600で所有者を一致させる。長すぎるsocket pathは起動前に拒否する。

master keyはmacOS Keychainのservice `bitty-runner-login-master-key` に保存し、認証storeの実体pathからaccountを分ける。認証store・鍵はrepoへ入れない。鍵をなくすとTOTPを復号できず、旧共有tokenでのremote fallbackもない。Keychain master keyの喪失は通常のTOTP端末紛失とは別で、鍵のバックアップ復元が必要である。バックアップがない場合、本版の通常ローカルresetでは復旧できない。固定ownerと既存ACLを維持する別途の復旧判断が必要であり、認証stateを削除しない。

## 初回所有者登録と端末接続

先に対応アプリをビルドする。iPhone実機は `./scripts/ios/build-expo-ios-device.sh`、macOS版は `./scripts/macos/build-expo-macos.sh` を使う。次に、対象checkoutのrootで所有者本人がMacのターミナルから実行する。

```sh
./private_runner/setup-login.sh
```

このスクリプトは設定と依存関係を準備し、日本語で初期登録を案内する。登録済みなら「初期設定は完了しています」と表示し、再登録・reset・再起動はしない。未登録で対応Runnerが動いていれば、そのまま登録する。起動が必要な場合だけ「再起動」と入力して確認し、新しいRunnerの応答を待つ。この場合、現在の会話は一度切断される。スクリプトは任意のdirectoryから絶対pathで実行してもよい。

画面の案内に従って、①メールの8桁→②**認証アプリで新しいQRを読み取り、6桁を確認**→③復旧コード保存、の順で進む。数字の入力ミスは同じ画面でやり直せる。復旧コードを保存してEnterを押すと、必要な場合だけ**Bittyアプリ用の接続QR**を表示できる。2つのQRは用途が異なる。既に接続済みなら接続QRの読み直しは不要。秘密QR、復旧コード、接続QRは共有しない。

アプリからのログインでは、件名「Bitty ログインコード」の最新メールと、今回登録した認証アプリの6桁を使う。初期登録に使った6桁と同じ数字は再利用できないため、数字が変わってから入力する。

setupはローカルsocketと既存local credentialを使い、TOTP master keyのKeychain作成もこの操作で行う。未登録状態でも公開HTTPからownerを取得することはできない。登録失敗時は接続QRへ進まず停止し、既存登録を自動resetしない。

セットアップはソフトウェア更新用のコマンドではない。コード更新後にRunnerを読み直す場合は、従来の `./private_runner/restart-keep-token.sh --mode full` を使う。準備・起動の詳しいログはエラー時だけ案内する。ログは所有者だけが読める0600で保存し、QRや確認コードは保存しない。

初回登録前の永続owner IDが現在のローカル制御token由来IDと一致しなければ、メール送信前に `owner_migration_required` で止まる。別の過去ownerのworkspace承認等が保存されていても、それだけで登録は止めない。他ownerのデータや権限は変更・統合せず、現在のownerには許可しない。登録済みownerはローカル制御tokenの更新やreset後も固定する。

ローカルCLIはRunnerが保存したtokenファイルを優先する。`.env` の古い `RUNNER_TOKEN` は既存ファイルを上書きしない。ファイルが存在しない直接起動構成だけ環境変数を使い、不正な権限・空ファイル等では停止する。

接続QRにはAccess資格情報、接続先、LANの信頼情報だけを含め、Runner共有tokenも既存sessionも含めない。既存端末も対応アプリでQRを読み直す。資格情報保存をoriginに結び付けた新schemaへ切り替えるため、旧field保存への自動fallbackはしない。その後メールコード＋TOTPでログインする。

reset / unlockなどを個別実行する場合は、対象checkoutのrootで `set -a; source private_runner/.env; set +a` としてRunnerと同じ設定を読み込む。秘密値をコマンド引数に含めない。接続QRだけを再表示する場合は `./private_runner/run-local.sh pairing-qr` を使う。

短命WebSocketの再接続、ネットワーク変更、背景通信では新端末通知を送らない。セッション期限切れ・失効後は再ログインが必要で、background Push応答は成功扱いにせず既存の失敗通知を出す。

## 推定地域

推定OS・地域は表示補助であり、端末認証の根拠にしない。地域を表示するにはCloudflare側のvisitor location headersが必要である。

Runner側では `CLOUDFLARE_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com` と `CLOUDFLARE_ACCESS_AUDIENCE=<Access application audience>` を設定する。公開TCPはloopback専用で、Tunnel用HTTP listenerの内部contextであることと、Access assertionのRS256署名、issuer、audience、有効期限等の検証を満たした場合にだけ位置ヘッダーを表示する。LAN HTTPSでは自己申告CFヘッダーを信用しない。

未設定、JWT欠損、service-token経路でassertionが到達しない、署名検証失敗、証明書取得失敗なら「不明」とする。ログイン認証は変わらない。IP位置情報の誤差は残る。実Cloudflare設定の変更・assertion到達確認・Mailjet実配送は、ローカル自動テストの合格とは別に確認する。

## 復旧と障害

- TOTP紛失: アプリの復旧画面でメールコード＋復旧コード→新TOTPの登録確認→新復旧コード保存→再ログイン。
- メール変更・TOTP変更・全端末失効: Macで `node private_runner/tools/runner-login.mjs reset` を実行し、明示確認後 `setup` をやり直す。固定owner IDと会話ACLは維持し、全sessionと旧認証要素を失効する。旧メール宛の変更通知をoutboxへ残す。
- Mailjet確認コード未着: ログインは成立しない。60秒間隔で再送でき、同じ認証フローの旧コードは失効する。未知のメールにも同じ応答を返す。ローカルsetupでは送信障害を明示する。
- 新端末通知の送信障害: sessionは維持し、永続outboxから最大5回・24時間以内に再試行する。端末一覧に送信状態を表示する。配送のexactly-onceは保証しない。
- 認証store破損、鍵欠損、保存失敗: fail closed。空storeへ自動初期化しない。調査前にstoreを削除しない。
- 強制終了後のstale lock / socket: Runnerが停止していることを確認して `node private_runner/tools/runner-login.mjs unlock`。PIDが生存する場合、またはsocketへ接続できる場合は拒否する。lockなしでsocketだけ残る場合も、所有権・modeと接続拒否を確認して扱う。認証stateを維持し、stale制御fileだけを明示確認後に除去する。PID再利用等で判断できない場合は手動調査する。

通常の終了・起動失敗ではstoreを閉じてwriter lockを解放する。既存のライブsocketや判別不能なfileを起動時に上書きしない。

切替に失敗したらTunnelを止めてMacローカルで復旧する。旧コードへ戻して外部公開すると旧token認証へ戻るため、自動rollbackしない。

## 検証の分離

自動テストはtmp store、mock Keychain、mock Mailjet / APNsを使い、常用storeや本番メールへ触れない。新認証のテストは [runner-login.test.mjs](../private_runner/tests/runner-login.test.mjs)、位置情報は [runner-login-location.test.mjs](../private_runner/tests/runner-login-location.test.mjs)、実HTTPS入口は [runner-local-https.test.mjs](../private_runner/tests/runner-local-https.test.mjs)。

既存の業務runtimeテストではidentity providerを明示mockし、業務処理の回帰と本人認証の検証を分ける。実機でのKeychain共有、Widget、cold background Push、音声stream、LAN / Tunnel切替、実Cloudflare / Mailjet配送は所有者の確認対象である。
