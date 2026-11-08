# Private Runner 本人ログインと端末管理の設計

状態: 採用・実装中。2026年11月8日に所有者がQR維持・メールコード＋TOTP・成立後通知・30日／未使用7日を承認。本番設定変更・マージは別途確認する。

導入手順と実装上の制約は [運用手順](RUNNER-LOGIN-OPERATIONS.md)、全入口の分類は [認証入口一覧](RUNNER-LOGIN-ENDPOINTS.md) を参照する。

Cloudflare Tunnel経由で利用するBittyに、メール所有確認とAuthenticatorによる本人ログイン、端末別の認証情報、未知の端末からのログイン通知を加える。変更は認証とその接続箇所に限定し、会話・音声・スケジュール等の業務処理を作り直さない。

## 1. 結論と対象範囲

単一所有者のPrivate Runnerを前提に、Runner内に本人認証と端末セッションを集約する。新規ログインでメールの一時コードとTOTPを確認し、その端末専用の不透明なランダムセッションtokenを発行する。既存のHTTP / WebSocketのBearer送信形式を維持する。

メールアドレスの入力は識別であり認証要素ではない。メールコードとTOTPにも同一端末・アカウント侵害やフィッシングの残余リスクがあるため、高保証な二要素認証という表現は用いない。TOTPは既存実績のあるライブラリで検証し、暗号方式を独自実装しない。TOTPはフィッシング耐性を持たず、同じmacOSユーザー権限やRunner processの侵害は本認証の防御範囲外である。

Access tokenとrefresh tokenの二重管理、定期的なtoken更新、独自JWT、汎用IdP基盤、多人数RBACは導入しない。端末セッションを期限付きで直接検証する方式なら、JS・Swift・background間のrefresh rotation競合も生じない。

初回は次を対象外とする。

- URLだけを渡された任意のブラウザから、事前設定なしでログインすること。
- パスキー、生体認証のサーバー検証、ハードウェアによる端末認証。
- OSやIPから物理端末を厳密に特定すること。
- 会話、Codex / Claude認証、既存の操作承認フロー自体の再設計。

対象外の最初の項目はCloudflare Accessの既存gateを残すための制約であり、所有者が承認した。

## 2. 現状のコードと変更の根拠

| 現状 | コード根拠 | 設計への影響 |
| --- | --- | --- |
| Access service tokenだけをIncludeするService Auth policyを作成 | [scripts/cloudflare-runner.sh](../scripts/cloudflare-runner.sh) の `apply` | Runnerのログイン前にもAccess資格情報が必要 |
| QRにRunner tokenとAccess資格情報を含める | [private_runner/src/print-runner-pairing-qr.mjs](../private_runner/src/print-runner-pairing-qr.mjs)、[expo/src/features/app/utils/cloudflareAccess.ts](../expo/src/features/app/utils/cloudflareAccess.ts) | QRによる接続設定と本人認証を分離する |
| HTTP routeごとに共有tokenを直接比較 | [private_runner/src/server-runtime.mjs](../private_runner/src/server-runtime.mjs)、各 `*-http.mjs` | 全入口を共通の認証結果へ切り替える |
| WS upgradeで共有tokenを直接比較 | [private_runner/src/runner-websocket-upgrade.mjs](../private_runner/src/runner-websocket-upgrade.mjs) | HTTPと同じsession判定を使う |
| owner subjectが `runner:sha256(runnerToken)` | [private_runner/src/agent/agent-runtime.mjs](../private_runner/src/agent/agent-runtime.mjs) | token交代でownerを変えない |
| loopback HTTPとLAN HTTPSが同じrequest handlerを使う | [private_runner/src/server-runtime.mjs](../private_runner/src/server-runtime.mjs) の `http.createServer` / `https.createServer` | listenerから得る経路情報を認証に渡す |
| JS以外もBearerを送る | [expo/modules/bitty-runner-tls/ios/BittyRunnerConnection.swift](../expo/modules/bitty-runner-tls/ios/BittyRunnerConnection.swift) | native/background資格情報との整合を保証する |
| Push応答はJSなしでnative送信する | [expo/modules/bitty-push-approval/ios/PushApprovalResponder.swift](../expo/modules/bitty-push-approval/ios/PushApprovalResponder.swift) | backgroundで再ログインやrefreshを要求しない |
| widget source identityがURLとtokenに依存 | [expo/modules/bitty-widgets/ios/BittyWidgetSnapshotStore.swift](../expo/modules/bitty-widgets/ios/BittyWidgetSnapshotStore.swift)、`BittyRunnerConnection.swift` | ログアウト・token交換時に旧snapshotを切り離す |
| 接続履歴はWS接続単位で集約し、端末認証は行わない | [private_runner/src/runner-connection-events.mjs](../private_runner/src/runner-connection-events.mjs) | 接続ログの回数から新端末メールを発火しない |
| APNs登録のdeviceIdはpush配送用 | [private_runner/src/push-device-store.mjs](../private_runner/src/push-device-store.mjs) | ログイン端末の本人確認として流用しない |

Mailjetが利用可能であることはユーザー申告による。この調査では送信credentials・アカウント・送信元設定を読み取らず、repo内のMailjet実装も見つかっていない。実装前に非秘密の設定契約と疎通方法を確認する。

## 3. 信頼境界とCloudflare

推奨経路は次の通り。

```text
Bittyアプリ
  ├─ 外部: Cloudflare Access → Tunnel → HTTP listener
  └─ LAN: ペアリング済みCAで検証するHTTPS listener
                 ↓
           共通の本人認証
                 ↓
         現在のowner・ACL・業務処理

MacローカルCLI → 所有者専用Unix domain socket → 同じowner・ACL
```

Cloudflare Accessは外側の接続制限として維持し、Bittyログインの代わりにしない。新端末には所有者がMacで表示したQRから接続先・Access資格情報・LANの信頼情報を設定する。新QRには共有Runner tokenも、既存端末のsession tokenも入れない。

この案では、未設定端末はRunnerのログインAPIへ到達できない。Bittyアプリ内のログイン画面は表示できても、認証通信前に接続設定が必要である。メールのリンクを通常ブラウザで開いてもAccess用ヘッダーは送られない。

URLだけのブラウザログインが必須なら、Accessのidentity login導入、または限定した認証経路の公開設計を別途選択する。Everyone / Bypassを安易に追加して既存APIまで公開しない。この選択は認証基盤・アプリ互換・運用への影響が大きいため、本ドラフトの最小案と混在させない。

TunnelからRunnerへのsocketもloopbackになるため、`remoteAddress` が127.0.0.1であることを根拠に旧tokenを許可してはいけない。Host、Origin、`CF-*`、`X-Forwarded-*`等のクライアント指定ヘッダーによる「ローカル扱い」も禁止する。

UDSの既定pathはRunner永続directoryをrealpathで確定した上でその中の `runner-control.sock` とし、`run-local.sh` が同じ絶対pathを全caller・子processへ伝える。worktree側の長いsymlink表記をsocket pathに使わない。起動前に対象OSのUnix socket path長上限をbyte数で検査し、超過時は明示的に停止する。必要な場合は短い所有者専用directoryを選び、同じ権限・path配布契約を適用する。汎用resolverやTCP fallbackは追加しない。起動時に既存socketや別種fileがあれば所有権と稼働processを確認し、判別できなければ停止する。停止時は自身が作成したsocketだけを削除する。CLIはsocketへ到達できなければ失敗し、HTTPへ戻らない。

HTTP / LAN HTTPSでは旧共有tokenを全面拒否する。ローカルCLIの既存権限を残す場合はUnix domain socketだけで旧tokenを受ける。socket親directoryは0700、socketは0600、所有者を確認する。経路種別はlistener側の内部contextで確定し、HTTPヘッダーから復元しない。

## 4. 初回所有者登録

初回登録の権限はMacのローカル所有者に限定する。未登録だからという理由で、公開HTTPに「最初の人がownerになる」APIを設けない。

1. Macのローカル管理コマンドがowner未登録を確認し、登録用の排他処理を開始する。
2. ownerメールを指定する。Mailjetへ固定送信元から一時コードを送る。
3. 同じローカル登録手順でメールコードを検証する。
4. 暗号乱数でTOTP secretを作り、TTYへ一度だけQRを表示する。ファイルや通常ログへ出さない。
5. Authenticatorに登録し、最初のTOTP入力を確認するまでownerを有効にしない。
6. 一度限りの復旧コードを表示し、所有者が安全な場所に保存したことを確認する。
7. owner、TOTP、復旧コードhashを原子的に保存して登録を確定する。

登録処理はUnix domain socketまたは停止中の管理コマンドだけから行い、稼働中storeに別processが直接書き込まない。中断・期限切れのpending登録ではログインできず、secretを破棄する。既存ownerの置換は初回登録コマンドで行わない。

初回実装のownerメール変更・通常のTOTP再登録・全端末一括失効は、Macローカルreset→setupに限定する。resetで旧session・旧pendingを失効し旧メールへ通知、setupでメール所有確認と新TOTP確認を行う。公開のTOTP紛失復旧だけはメールコード＋復旧コードから開始できる。ownerは認証世代を持ち、メール / TOTP変更や復旧の確定で世代を進める。変更確定と旧session・旧pending状態の無効化を同じtransactionで行う。

## 5. ログインと端末登録

1. 接続設定済みアプリでownerメールを入力する。
2. `POST /auth/login/start` が短命challengeを作り、登録済みownerにメールコードを送る。
3. アプリでメールコードとAuthenticatorのTOTPを入力する。
4. `POST /auth/login/complete` が同じchallengeに対する両コードを検証する。
5. 成功を原子的に確定し、その端末のsession tokenを一度だけ返す。
6. アプリはKeychainに保存し、以後のHTTP / WS / nativeはこのtokenをBearerで送る。
7. 同じ確定処理で新端末ログイン通知をoutboxへ記録する。

login / reauth / recoveryのchallengeと復旧専用状態にはpurpose、ownerの認証世代、期限、単回利用をbindする。別purposeへの転用を拒否し、完了transactionで現在の世代を再照合する。並行した復旧・要素変更で古くなったpending状態からtoken発行や再登録を完了できないようにする。

コードは短命、一度限りとする。TOTPは30秒step、受入範囲は前後1stepを初期案とし、成功したstepを永続化して同じownerの同一step再利用を拒否する。RFC 6238の方式・test vectorに従う。

メールコードはCSPRNGで生成する8桁を初期案とし、HMACの定時間照合を行う。コードは10分、challenge当たり最大5回、再送は60秒間隔を初期提案値とする。再送すると古いメールコードを無効にする。login / reauth / recovery / 要素変更をまたぐowner共通のcode照合・送信budgetと、challenge単位・信頼できる送信元単位・全体の上限を組み合わせ、未登録メールにも同じ応答形式を返す。無期限のaccount lockによるDoSを避ける。

challenge、送信回数、失敗数、再利用防止stateを再起動で初期化しない。定数はまず固定値とし、必要性のない設定項目を増やさない。送信先は登録済みownerだけで、入力メールを任意の配送先として使用しない。pending challengeはowner当たり最大3件・全体100件、通知outboxは未送信100件を初期上限とし、期限切れを削除する。上限到達時は新規login受付を429で停止し、既存sessionの利用を維持する。

メールコード送信に失敗した場合、本人確認を省略せずログインは成立しない。Mailjetは配信基盤であり、最終配送成功まで保証するものではない。コード未着時は再送制限内で再試行し、既存sessionからの利用は維持する。

### 端末という言葉の意味

サーバーが発行したsession tokenの所持を「登録済み端末」の根拠にする。端末名、OS、User-Agent、IP、APNs deviceId、アプリから送られたUUIDだけでは登録済みと判定しない。

tokenを盗まれると同じ端末として使用され得る。物理端末への暗号学的なbindingは本案に含まれない。Keychain削除・アプリ再インストール・別の端末でのログインは新規登録として通知する。

## 6. 端末セッションと失効

session tokenは256bit以上の暗号乱数とし、サーバーにはhashだけを保存する。復元できるJWTにowner情報を入れる方式は不要である。

初期提案は最長30日・未使用7日で失効する。未使用時間はサーバーが受理した認証付き通信から測り、background通信でも更新される。期限はHTTP/WSの両方でサーバーが判定し、活動によって最長期限は延長しない。期限到来後はメールコード＋TOTPで再ログインする。これらの値は所有者承認済みである。

同じsessionをJSとSwiftが読むため、backgroundでrefreshもTOTP入力も行わない。期限切れ・失効時はnative Push応答を失敗扱いとして既存の失敗通知を出し、アプリを開いて再ログインする。失敗を成功表示せず、旧共有tokenに戻さない。

`GET /auth/devices` で端末名、登録日時、最終利用、推定OS等を表示し、`DELETE /auth/devices/:id` でそのsessionを失効できる。ログアウトは自端末失効とローカル秘密削除を行う。自端末失効以外の端末管理・全端末失効・認証要素変更には5分以内の再認証を要求する初期案とする。

失効・期限切れを検出したら、そのsessionに紐づく既存WSを閉じ、HTTPだけでなく新たなWSメッセージ受理も止める。長い音声streamも継続を許さず切断する。確定済みのサーバー側agent jobは自動取消ししないが、失効端末には結果・イベント・操作を渡さない。

Push配送登録もログインsessionへbindする。現行 [approval-push-service.mjs](../private_runner/src/approval-push-service.mjs) は配送登録済みdevice全件へ操作内容等を送るため、API拒否だけでは紛失端末への情報配送を止められない。操作承認、完了通知、widget更新通知を含む全配送で、共通の配送資格境界が送信直前にsessionの有効性を確認し、失効確定後の新たなAPNs送信を拒否する。個々の送信関数へ認証判定を重複させない。旧配送登録は再login・再bindまで停止する。APNsが既に受理した通知や端末配信済みの内容は回収できない。業務上の操作承認判断は変えず、配送資格だけを制限する。

各WSは認証済みsession IDとowner subjectを保持する。失効処理と新規処理の受入れを同じ認証stateで直列化し、失効確定後に新たな操作を開始しない。失効前に受理済みの外部副作用を巻き戻す保証はしない。

### ownerと既存ACL

owner subjectは端末tokenから計算しない。初回移行時に現在の `runner:sha256(RUNNER_TOKEN)` をowner識別子として一度固定し、その後は永続owner recordから取得する。新規導入時はランダムな固定owner IDとする。

HTTP、WS、ローカルCLI、background処理は同じowner subjectへ解決し、既存のworkspace admission、操作owner、idempotency、会話参照を維持する。session IDをowner IDへ流用したり、全ownerのデータを一括で許可したりしない。

既存保存データに複数の過去token由来subjectがある場合は自動統合しない。対象storeを棚卸しし、現在のownerとの対応が一致しない場合は切替を停止して個別に移行方針を決める。

## 7. 新端末メール

初期案は「新しいログイン成立後の通知」とし、「メールで承認するまで利用不可」は含めない。認証自体はメールコード＋TOTPで完了する。成立後通知の方式は所有者承認済みである。

通知例は「新しい端末からログインしました。推定OS: macOS、推定地域: 石川県金沢市、日時: …。心当たりがない場合はBittyの端末管理から失効してください」。不明なOS・地域は不明と表示し、断定しない。

通知はログイン成功・新しいsession確定のときだけ作る。日常のHTTP、WS再接続、LANとTunnelの切替、IP変更ごとには送らない。失敗試行は記録と制限の対象であり、攻撃者によるメール大量送信を許さない。

通知はsession確定と同じ永続state更新にoutbox recordとして含める。送信失敗はログインを取り消さず、再起動を越えて有限回再試行する。初期案は最大5回・24時間以内。失敗は端末管理へ表示する。成功通知の配送は認証成功の条件にしない。

外部配送とstore更新は原子的にできないため、送信成功直後のprocess停止では同じ通知が重複する可能性がある。event IDで重複を抑え、exactly-once配送とは表現しない。コード・session tokenは通知本文に含めない。

メールには失効・承認を行うtoken付きURLを載せない。固定の案内とアプリ操作手順を使う。GETやリンクscannerで状態を変更しない。アプリdeep linkを追加する場合も画面表示だけとし、認証済みPOST / DELETEの代わりにしない。

### OSと地域の取得

OSはUser-Agentとアプリ情報による推定表示であり、値を長さ制限・escapeする。地域はCloudflareのvisitor location headersを使い、欠損・不正値は不明とする。LANにはインターネット地域を作り出さない。

Cloudflareが上書きしたヘッダーを信頼できるTunnel経路であることを、Access assertionの署名・issuer・audience・期限等の検証を含む入口契約で確認する。LAN requestの自己申告 `CF-*`、単なるloopback address、任意のforwarded headerは信用しない。

service-token policyで発行されるAccess assertionの実際の到達を実装スパイクで検証する。検証できない場合もログイン認証には流用せず、地域を不明扱いにする。地域のためだけに独自の信頼ヘッダーや第二のproxyを追加しない。

IP位置情報はVPN・携帯回線等でずれるため表示補助に限定する。CloudflareのManaged Transform設定が別途必要な場合がある。[Cloudflare公式の位置情報仕様](https://developers.cloudflare.com/network/ip-geolocation/)

## 8. 保存と復旧

最小の認証storeにowner、暗号化TOTP secret、復旧コードhash、session hash、challenge、制限state、通知outboxを保存する。汎用アカウントDBや既存push storeへ分散しない。

稼働Runnerを単一writerにし、更新を直列化・原子的renameする。permissionはdirectory 0700 / file 0600を必須にする。破損・復号失敗時は認証を停止し、空のownerで再初期化しない。実装時にはprocess重複起動を防止する既存制御との整合を確認する。

TOTP secretはhash化では検証できないため、macOS Keychainで保持するmaster keyによる認証付き暗号化で保存する。認証storeとmaster keyを一緒にrepo、ログ、通常バックアップへ入れない。鍵紛失時にsecretを復号するfallbackは設けない。Keychain master keyの喪失では起動を停止するため、本版のUDS経由resetも使えない。鍵のバックアップ復元が必要で、バックアップなしの場合は固定owner・既存ACLを保持する別途の復旧判断を要する。通常のTOTP紛失復旧と区別し、認証stateは削除しない。

メールコードは短く総当たり可能なので、storeにはKeychain鍵から分離導出した認証用keyによるHMACを保存する。session / challenge / 復旧codeの高entropy値はhashで照合できる。秘密の比較は定時間で行い、body・token指紋・メールコード・TOTP・QRを診断ログへ出さない。

TOTP紛失時は、登録済みメールコード＋一度限りの高entropy復旧コードで制限された復旧手順へ入る。一般APIには入れず、新TOTP確認後に全session・旧TOTP・全旧復旧コードを失効し、復旧通知を送る。メールだけでMFAを解除できる経路は作らない。

メールも復旧コードも使用できない場合はMac所有者によるローカル復旧に限定する。Unix domain socketまたは停止中の専用管理コマンドで所有者確認・明示操作を要求し、全sessionを失効して初回登録をやり直す。公開HTTPには管理reset endpointを設けない。

端末の表示情報・監査eventは必要最小限とし、保存期間を設ける。初期提案は認証event 30日、失効sessionは監査に必要なIDと日時だけを同期間残す。生IPを永続保存せず、制限用の短期keyとマスク表示を分ける。

## 9. 共通認証境界とAPI契約

本人認証serviceはsessionの検証、期限、失効、ownerへの解決を所有する。HTTP / WS adapterは同じ結果を受け取り、業務serviceへ認証済みowner contextを渡す。routeごとの共有token比較とtoken hash由来のowner再計算を削除する。

HTTPの最初の入口で公開endpointの小さな許可listを扱い、それ以外を認証必須にする。WS upgradeも同じsession検証を使い、upgrade後にも失効を反映する。query token、Cookieへの暗黙fallback、認証なし再接続は認めない。

| 提案するendpoint | 認証 | 主な契約 |
| --- | --- | --- |
| `POST /auth/login/start` | Access通過またはLAN TLS、Bitty session不要 | ownerメールのchallenge発行、列挙耐性、配送制限 |
| `POST /auth/login/complete` | 同上 | challenge・メールcode・TOTP、単回session発行 |
| `POST /auth/reauth/start` / `complete` | session必須 | 同じsessionに短命の再認証状態を付与 |
| `GET /auth/devices` | session必須 | 自ownerのみ、token hash等は返さない |
| `DELETE /auth/devices/:id` | session、他端末は直近再認証 | 永続失効・対応WS切断 |
| `POST /auth/logout` | session必須 | 自session失効、再送しても安全 |
| `POST /auth/recovery/start` / `complete` | 短命challengeのみ | 復旧専用、業務権限を発行しない |
| owner登録 / reset | ローカル管理経路のみ | HTTP / LAN / Tunnelから呼べない |
| `GET /health` | 最小の稼働有無だけ公開候補 | 現行の認証状態・設定等の詳細はsession必須へ移す |
| その他の業務HTTP / WS | session、またはUDSでlocal credential | default deny、従来owner ACLを維持 |

未認証は401、再認証不足は403、試行制限は429とし、機械判定可能な認証error codeだけを共通化する。存在するメールや具体的な失敗要素は未認証responseに出さない。

ログインresponseは `Cache-Control: no-store`、固定JSON、body size制限を必須にする。CORSの任意origin許可やCookie認証を追加しない。ログインのCSRF・challenge取り違えを防ぐため、client側の高entropy challenge bindingを同じ入力フロー内で保持し、完了requestにも必要とする。

## 10. 既存経路の棚卸しと影響範囲

下表は調査時点の経路群である。実装前にmethod・path・listener・認証方式・callerの完全一覧をコードから作り、未分類endpointがゼロであることをgateにする。複数ファイルの変更は必要だが、業務処理の責務は変えない。

| 経路群 | 現在の入口・caller | 必要な変更 |
| --- | --- | --- |
| 通常HTTP | `server-runtime.mjs`: status、scripts、Codex auth、queue/jobs、client-state、directories、files/media、unread/read、logs、voices/TTS、YouTube | 冒頭gateへ集約し既存比較を削除。公開healthは内容を最小化 |
| 分割HTTP | `agent/agent-transport.mjs`、`app-control-service.mjs`、`skia-board-http.mjs`、`codex-schedule-http.mjs`、`google-cloud-http.mjs`、`stt-settings.mjs`、`stt-correction.mjs` | gate通過後のowner contextへ統一。route側の認証重複を削除 |
| push操作 | `server-runtime.mjs`、[approval-push-service.mjs](../private_runner/src/approval-push-service.mjs)、[turn-completion-notification.mjs](../private_runner/src/turn-completion-notification.mjs)、[widget-refresh-notifier.mjs](../private_runner/src/widget-refresh-notifier.mjs)等の実際のdispatch | session必須、APNs配送登録をsessionへbindして送信時に検査。旧登録は再bindまで配送停止。業務の操作承認を変えない |
| WS | `runner-websocket-upgrade.mjs`: `/runner-ws`、`/stream-stt`、`/stream-tts` | sessionとownerを接続へbind、失効・期限切れを反映 |
| JS資格情報 | [expo/src/features/app/utils/secureRunnerCredentials.ts](../expo/src/features/app/utils/secureRunnerCredentials.ts)、[expo/src/features/app/hooks/useRunnerHttpAuthBootstrap.ts](../expo/src/features/app/hooks/useRunnerHttpAuthBootstrap.ts)、[expo/src/features/ws/webSocketAuth.ts](../expo/src/features/ws/webSocketAuth.ts)、設定保存・復元 | legacy tokenとsessionを識別し、login・logout・期限切れを接続へ反映 |
| native共通 | `BittyRunnerConnection.swift`、Push approval responder、widget、native STT | 同じsessionを使用。旧token fallback禁止、401で既存cacheを認証済み扱いにしない |
| 端末切替cache | `BittyWidgetSnapshotStore.swift`、URL/tokenをsource identityへ含めるJS cache | logout・失効・再loginで旧sourceをdeactivate、他端末データを混ぜない |
| pairing | QR生成、`cloudflareAccess.ts`、QR読込・SecureStore保存 | 接続情報だけを設定。旧QRのtokenを認証済みにしない |
| Macローカルcaller | [private_runner/bin/bitty-history](../private_runner/bin/bitty-history)、[skills/bitty-session-orchestrator/scripts/bitty-session.mjs](../skills/bitty-session-orchestrator/scripts/bitty-session.mjs) のHTTP / WS、[private_runner/tools/codex-schedules.mjs](../private_runner/tools/codex-schedules.mjs)、配布元の [scripts/skills/install-bitty-session.mjs](../scripts/skills/install-bitty-session.mjs)、その他の管理・測定script | UDS対応、credential保存先とownerを維持、HTTP fallback禁止 |
| 起動・運用 | [private_runner/run-local.sh](../private_runner/run-local.sh) の `BITTY_RUNNER_URL` export、[private_runner/restart-keep-token.sh](../private_runner/restart-keep-token.sh)、worktree bootstrap | shared tokenと認証storeの役割を分離。起動ごとのsession再生成をしない |

macOS版アプリが既定の127.0.0.1へ接続する場合も、CLIとは区別して本人sessionを要求する。ローカルアプリだからという理由でUDS管理credentialを配布しない。

アプリの既存 `runnerToken` という引数名は、一度に全callerをrenameする必要はない。移行中は「Bearer値」を渡す契約に限定し、発行元・失効状態・保存schemaは認証部分で区別する。sessionを旧共有tokenとして表示・QR出力しない。

Keychainはsession用schemaを明示し、旧key fallbackを廃止するタイミングをJS / Swiftで揃える。token変更時に旧WSを閉じ、widgetの旧snapshot sourceを無効化する。nativeは単なるtoken文字列の置換だけで検証完了としない。

## 11. 段階導入と戻し方

1. **準備**: endpoint / caller棚卸し、owner IDの固定方法、UDS、認証storeの排他・原子的保存を検証する。常用storeへ書き込まずfixtureで行う。
2. **共通化**: 現行token動作のまま認証判定を一箇所へ寄せ、HTTP / WS / native / CLIの回帰を確認する。業務処理は変えない。
3. **隔離検証**: 別のtest store・非公開listenerでowner登録、session、通知を試す。メール送信は明示されたtest宛先だけを使う。
4. **切替準備**: 対応アプリ・native・CLIを配布し、所有者がローカル登録する。repo内sourceの修正だけで済ませず、実際にインストール済みのskill / CLIと子processの接続設定がUDS対応版であることを切替gateにする。remote旧tokenと新sessionを併用する猶予は作らない。
5. **一括切替**: メンテナンス時間に旧remote接続を閉じ、HTTP / LAN / Tunnelの旧共有tokenを拒否し、全gateをsession方式へ切り替える。旧APNs配送登録は停止し、新sessionへの再bindが済んだ登録だけを配送可能にする。UDSだけlocal credentialを許可する。
6. **確認**: 正規ログイン、全経路拒否試験、端末失効、background、再起動後state、通知を確認して旧remote token保存を消す。

両方式を有効にする `session OR RUNNER_TOKEN` は禁止する。先にsession gateを置いても、下流route・別listener・WSに旧token受入れが残れば迂回路になる。

切替に失敗した場合は外部Tunnelを停止してローカル復旧する。コードだけを旧版へ戻して外部公開を再開すると旧token認証へ戻るため、自動rollbackは禁止する。新storeを旧版に読ませたり、消した認証stateを空に戻したりしない。

本番storeの移行、外部設定変更、新依存追加は設計承認とは別に実装時の手順と承認対象を明示する。worktreeは常用logsを共有するため、試験では必ず別storeを指定し常用Runnerを起動・停止しない。

## 12. 実装時の受入条件

- 全HTTP method/path/listener、WS、native、CLIが棚卸しされ、認証漏れ・未分類がない。
- Access通過だけ、旧Runner tokenだけ、query token、偽CFヘッダー、LAN接続だけでは業務APIへ入れない。
- Tunnelからのloopback接続でもlocal credentialが拒否され、UDSでは従来owner権限を維持する。
- 長いworktree pathでも永続dirのrealpathを全callerが共有し、OSのsocket path長超過は起動前に明示失敗する。
- owner未登録時の公開登録、owner取り替え、challenge再送・期限切れ・replay・並行完了が拒否される。
- TOTP公式vector、受入window、同一step replay、再起動後rate limit、メールcode総当たり制限を検証する。
- session失効・期限切れとHTTP / WSの競合で、失効確定後に新規操作・イベント配信を許可しない。
- 再login・token交換でも既存ACL、owner、workspace、idempotencyを保ち、他ownerの過去stateを統合しない。
- JS停止中・cold backgroundのPush応答、widget、音声stream、LAN / Tunnel切替を実機で確認する。
- 期限切れnative応答は失敗通知となり、tokenを元に戻さず、旧snapshotを認証済み表示しない。
- session失効後はその端末への新規APNs送信を止める。旧配送登録・送信直前競合・複数端末を試験する。
- Mailjet未送信ではlogin不可、通知失敗ではlogin維持、outbox有限retry、再起動、重複通知を確認する。
- store破損、鍵欠損、並行writer、保存失敗で認証stateを空にせずfail closedとする。
- 復旧code単回利用、復旧時全失効、旧TOTP拒否、公開reset不可を確認する。
- メール・ログ・QR・URL・計測・error responseへsecretが漏れないことを確認する。

自動テストはtmp storeとmock鍵・配送だけで実施する。実Keychain、実Cloudflare / Mailjet、iOS実機の確認は別途必要であり、自動テスト合格だけで本番安全性を断定しない。

## 13. 採用した事項

| 判断 | 採用内容 | 別案の影響 |
| --- | --- | --- |
| 未設定端末からの入口 | 既存Access維持、所有者QRで接続設定後アプリ内login | URLだけのブラウザloginにはAccess側とclient認証の再設計が必要 |
| login方式 | 新session発行ごとにメールcode＋TOTP | password / passkey採用は別の登録・復旧設計が必要 |
| 新端末メール | 成立後通知、失効は認証済みアプリ | メール承認待ち方式はpending端末stateと到達可能な承認入口が必要 |
| session期限 | 最長30日・未使用7日、重要操作は直近5分の再認証 | 短縮するとbackground操作の再login頻度が上がる |
| ownerと復旧 | 単一owner、復旧code＋メール、最終手段はMacローカル | 複数ownerはACLと管理責務を追加する |
| 追加ライブラリ | 実績あるTOTP検証libraryだけを選定 | 独自暗号実装、汎用認証frameworkは初回不要 |

## 14. 参照仕様

- [OWASP MFA](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html): factor登録・復旧・通知の設計指針。メール＋TOTPの保証を過大評価しない。
- [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html): entropy、期限、サーバー側失効、再認証の設計指針。
- [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238): TOTP方式・時間step・test vector。
- [Cloudflare service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/): Access資格情報はサービス接続用でありBitty ownerのログインと分ける。
- [Cloudflare IP geolocation](https://developers.cloudflare.com/network/ip-geolocation/): visitor location headersの有効化と位置推定の限界。

本案のsession期間、API名、store構成、UDS採用はBittyの現状コードから導く設計提案であり、上記仕様がその値や構造を必須としているものではない。

## 15. 設計レビュー記録

2026年11月8日、作成担当とは別の2名のサブエージェントが順にレビューし、各指摘の修正後に再確認した。

| 回 | 観点 | 指摘と反映 | 再確認結果 |
| --- | --- | --- | --- |
| 1 | セキュリティと認証境界 | Medium 3件。復旧等のpending状態を認証世代へ結び付け、認証フロー間の共通試行上限と、失効端末への全Push配送停止を追加 | 3件解消。設計ドラフトとしてAPPROVE |
| 2 | 影響範囲と移行可能性 | Medium 1件。UDSの実体path共有、OSの長さ上限検査、長いworktreeでの受入条件を追加 | 1件解消。設計ドラフトとしてAPPROVE |

両レビューに未解消のCritical / High / Medium指摘はない。これは設計ドラフトの評価であり、§13の仕様選択、実装承認、本番の安全性検証を代替しない。

文書検査ではローカル参照先の実在、空白、末尾改行、コードブロックの対応を確認した。この設計レビュー時点では実装・動作テスト・Mailjet実送信・本番設定変更は行っていなかった。後続の実装検証は運用手順とPRの検証記録で区別する。
