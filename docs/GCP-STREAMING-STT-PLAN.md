# GCP Streaming STT 実装計画

## 文書管理

| 項目 | 内容 |
| --- | --- |
| 状態 | Phase 0〜4、モデル・リージョン詳細設定、iPhoneバイナリ直送の実装・自動テスト完了。Phase 5の実機確認待ち |
| 更新日 | 2026-09-23 |
| 対象プロジェクト | Private Runner に設定した Google Cloud プロジェクト |
| ブランチ | `plan/gcp-streaming-stt` |
| worktree | `${BITTY_WORKTREE_ROOT}/plan/gcp-streaming-stt` |
| ベース | `origin/main` (`2ad7540`) |

このファイルを実装中の進捗・判断・検証結果の正本とする。実装時は各フェーズの完了条件を満たした時点でチェック欄と検証結果を更新する。

## 目的

現在の「録音を完了してから音声ファイル全体を文字起こしする」方式を削除し、Google Cloud Speech-to-Text V2 の双方向ストリーミングへ一本化する。

- 発話途中の暫定結果を通常のチャット入力欄へ逐次表示する。
- Google が確定した結果だけを確定テキストとして保持する。
- 発話終了は端末独自の無音判定ではなく、Google の Voice Activity Events と `speech_end_timeout` に任せる。
- 音声入力はマイクボタンから始まる一つの自動経路へ統合し、旧手動/自動モードの分岐を削除する。`autoReplyAfterStt`は完了後に確定文をcomposerへ残すか送信するかだけを制御する。
- Groq、Apple Speech、録音ファイル経由の STT 実装を削除し、STT の経路を一つにする。
- 設定画面から、Codexアカウント追加に近い操作でPrivate RunnerのGoogle Cloud接続を管理できるようにする。
- Private Runnerで月間利用時間を強制し、設定画面で上限・使用時間・残り時間を確認できるようにする。
- 録音中はチャット下部へ波形と当月使用時間を示すフローティングUIを表示し、高頻度の波形更新をその描画コンポーネント内へ閉じ込める。

## 実装開始前に確認した現状

### Google Cloud

- 対象プロジェクトのIDは Private Runner の `GOOGLE_CLOUD_PROJECT_ID` と一致している。
- 課金は有効。
- `texttospeech.googleapis.com` は有効で、現行Private Runnerがホスト共用の標準ADCから呼び出せることを確認済み。実装後はRunner専用ADCへ切り替える。
- `speech.googleapis.com` は2026-09-22の調査時点では無効だった。有効化はユーザーが担当する。
- 対象プロジェクトにはAPIを有効化できる Owner 権限の Google アカウントがある。
- 現在のホスト共用ADCのquota projectは別プロジェクトを向いている。この標準ADCは変更せず、Runner専用ADCだけへ対象プロジェクトを設定する。

### 料金

- 2026-09-22現在、月60分無料はSpeech-to-Text **V1** の料金であり、V2には適用されない。
- 本計画のV2 `StreamingRecognize` + Chirp 3は、最初の1分から `$0.016/分`。
- 60分利用した場合の概算は月 `$0.96`。設定画面の初期上限を60分にするが、「無料枠」とは表示しない。
- V2は正常に処理された音声をリクエストごとに1秒単位で切り上げて課金する。文字が得られなかった音声も対象になる。
- Bitty以外から同じGoogle Cloudプロジェクトを使った時間は、Private Runnerの集計には含まれない。

### 現在の認証情報管理

- 設定画面から入力できる Runner token と Cloudflare 認証情報は、iPhone の `expo-secure-store`、すなわち iOS Keychain に保存される。
- Groq / ElevenLabs のキーは Private Runner の `.env` に置かれており、設定画面から Private Runner へ保存する仕組みはない。
- Google Cloud TTS は API キーを使わず、現在はPrivate Runnerホストの標準ADCを優先し、失敗時は通常のgcloudログインへfallbackしている。このホスト共用経路はRunner専用ADCへの移行時に削除する。

### 現在の STT

- `runner` / `ios_native` / `ios_native_direct` / `ios_native_runner` の複数経路がある。
- Runner 経路は録音完了後のファイルを Groq へ送る。
- iOS 経路は Apple Speech または録音ファイル後処理を使う。
- 自動モードの終了は端末側の音量・無音時間・watchdog で独自判定している。
- 入力欄とは別の録音中 UI や direct preview があり、通常の入力欄へ一貫して反映する構造ではない。
- 現行の録音中表示は composer 内の入力欄を波形 GIF などへ置き換えるため、文字起こし途中の文字と波形を同時表示できない。

根本原因は、音声取得の単位が「完了済み録音ファイル」であり、STT の結果モデルも「最後に一度返る全文」を前提としていることにある。表示だけを疑似的に分割してもストリーミングにはならないため、音声取得から Runner、Google、入力欄までを一つのストリームとして置き換える。

## Google Cloud接続と認証

### 設定画面

APIキーの文字列入力ではなく、既存のCodexアカウント追加と同じ「開始、ブラウザ認証、状態poll、取消」の操作パターンを使用する。ただしCodexのdevice-code flowとは異なり、Google認証ブラウザはPrivate Runnerを動かしているMac上で開く。

1. ユーザーがGoogle CloudプロジェクトIDを入力する。
2. 「Google Cloudに接続」を押す。
3. iPhoneがRunner Token付き管理APIで認証開始を要求する。
4. Private RunnerがRunner専用の `CLOUDSDK_CONFIG` を指定して、通常の `gcloud auth application-default login` を一時processとして開始する。
5. gcloudがPrivate RunnerのMac上でGoogle認証ページをブラウザに開く。
6. ユーザーがMacのブラウザで認証し、Googleが同じMacのlocalhost callbackへ結果を返す。
7. gcloudがRunner専用ADCへ資格情報を保存して終了する。
8. iPhoneは認証状態をpollし、接続済みアカウント、プロジェクトID、権限確認結果を表示する。

iPhoneにはGoogleの認証URL、device code、authorization code、access token、refresh tokenを渡さない。認証開始APIは秘密値を返さず、設定画面には「Runner Macで認証を続けてください」という状態だけを表示する。Macでブラウザを起動できない、またはlocalhost callbackを受けられない環境では安全に失敗させ、`--no-launch-browser` やauthorization code貼付へfallbackしない。

Private RunnerホストにはGoogle Cloud CLIを必須条件とする。未導入または対応外versionの場合は自動インストールせず、設定画面に導入手順を表示して認証開始前に停止する。

設定画面には次を置く。

- Google CloudプロジェクトID入力。
- 「Google Cloudに接続」「再認証」「接続解除」。
- Runner Macでの認証待機状態と認証取消。認証URLやauthorization codeの入力欄は置かない。
- ADCの接続状態、Googleアカウント、対象プロジェクト。STTの可否は実際の録音時に判定する。
- 「音声入力 > Google Cloud STT」内の接続状態の直下に月間利用カードを置く。
- 月間利用カードには `今月 12分34秒 / 60分` を主表示し、残り時間、概算金額、次回リセット日時を補助表示する。
- 月間上限（分）の編集は同じカード内に置き、接続・再認証ボタンからは分離する。
- 通常のチャット入力欄には常時表示しない。残り10%以下または上限到達時だけ、音声入力開始時に警告する。

Codex用のcomponent/serviceへGoogle処理を追加しない。再利用するのは「開始→ブラウザ認証→状態poll→取消」という画面と管理APIの形だけで、Google専用の小さなcontroller/serviceを作る。Codexのdevice code、複数プロフィール、保存名、切替処理は持ち込まない。Google Cloud接続はRunnerごとに一つとし、TTSとSTTで共有する。

### 資格情報の保存境界

- iPhoneは既存のRunner tokenだけを保持する。Googleのauthorization codeやtokenは永続化だけでなく、iPhoneとRunner間の通信にも載せない。
- Private RunnerはBitty専用のGoogle認証ディレクトリを所有する。既定は `$HOME/.bitty/private-runner/google-cloud` とし、環境変数 `BITTY_GOOGLE_AUTH_DIR` でのみ変更可能にする。
- 専用ディレクトリは `0700`、その中のADCファイルは `0600` とする。リポジトリ、iPhone、ログ、API responseへ資格情報を出さない。
- login、quota project設定、状態確認、再認証、取消の全gcloud processへ `CLOUDSDK_CONFIG=$BITTY_GOOGLE_AUTH_DIR` を明示する。ホストの `$HOME/.config/gcloud` にある標準ADCは読まず、書かず、失効させない。
- Google client libraryには専用ADCファイルを明示的に渡し、暗黙のADC探索へfallbackさせない。プロセス全体の `GOOGLE_APPLICATION_CREDENTIALS` は書き換えず、BittyのGoogle認証境界内だけで資格情報を使用する。
- STTとTTSは一つのGoogle認証境界と一つの保存済みプロジェクトIDを共有する。現行TTSの `gcloud auth print-access-token` fallbackは削除し、専用ADCが未接続なら両方とも開始を拒否する。
- 現行の `GOOGLE_CLOUD_PROJECT_ID` は保存済みプロジェクトIDがない初回移行時だけ初期値として取り込み、それ以降はRunner側の保存値を正本とする。
- CodexのRunner側資格情報もmacOS Keychainではなく、権限を制限したファイルへ保存されている。Googleも「Runner側管理」という境界には合わせるが、Codex固有の保存形式は流用しない。
- APIキーやサービスアカウントJSONを設定画面、iPhone、リポジトリへ保存しない。
- 接続解除はRunner専用ADCだけを失効・削除する。Google Cloud TTSも利用不能になることを確認画面で明示するが、Bitty以外のGoogle CLIやアプリのログイン状態には影響させない。
- 将来RunnerをGoogle Cloud上へ移す場合は、ユーザーADCではなく実行環境へ付与したサービスアカウントを使用する。

### ユーザーが行うGoogle Cloud側の準備

API有効化とIAM設定はBittyから自動実行しない。ユーザーがGoogle Cloud ConsoleまたはCLIで次を行う。

- 対象プロジェクトでbillingを有効にする。
- `speech.googleapis.com` を有効にする。
- 接続するGoogleアカウントへ `roles/speech.client` と `serviceusage.services.use` を含む必要権限を付与する。

Bittyは接続時にRunner専用ADCとアカウント・プロジェクトを確認する。Speech APIの可否は実際のストリームの応答から判定し、API・IAM・billing不足を秘密値なしで表示する。空の音声を使った疑似的な認識リクエストは送らない。

## 採用アーキテクチャ

```text
iPhone / Mac microphone (PCM16 / mono / 16 kHz)
  -> authenticated /stream-stt WebSocket (binary PCM)
  -> Private Runner
  -> Google Cloud Speech-to-Text V2 StreamingRecognize (gRPC)
  -> interim / final / speech activity events
  -> /stream-stt WebSocket (JSON)
  -> normal chat composer
```

### iPhone の音声取得

以下は初期実装の選定記録。実機フィードバック後に決めた次期経路は「iPhone音声バイナリ直接送信の次期設計」を参照する。

現行 Expo SDK 54 の `expo-av` は録音中の PCM バッファを提供しないため、そのままでは真のストリーミングを実装できない。

リポジトリは React Native 0.81 系を iOS と `react-native-macos` で共有している。公式の microphone `AudioStream` がある Expo SDK 56/57 へ上げると React Native の世代が変わり、現行 `react-native-macos` と両立しない。そのため本タスクでは Expo/RN 全体の更新を行わない。

まず `@siteed/audio-studio` を候補として、次の条件だけを検証する。

- Expo SDK 54 の iOS ビルドが成功する。
- PCM16、mono、16 kHz の実時間バッファを取得できる。
- ファイルを生成しない stream-only 録音ができる。
- iOS 専用境界へ置くことで macOS の依存解決・型検査を壊さない。

`@siteed/audio-studio` 3.2.1 は iOS 16.4 以上を要求する。最低対応 iOS を
16.4 へ上げることはユーザー承認済みで、`expo/app.json` の
`expo-build-properties` を正本として設定する。生成される Podfile や Xcode project は
直接編集しない。

適合しなければ、その場で停止して報告する。依存パッケージへの場当たり的パッチ、Expo 全体の更新、独自 Swift モジュールへの切り替えは、別途合意なしに行わない。

### Mac の音声取得

macOS では `@siteed/audio-studio` を Podfile から除外し、Apple 標準の `AVAudioEngine` と `AVAudioConverter` を使う専用ネイティブモジュールから同じ PCM16 / mono / 16 kHz を取得する。マイク許可の用途文と audio-input entitlement を macOS アプリへ追加する。録音ファイルは作らない。

### WebSocket

既存 `/runner-ws` は長寿命の制御接続で、バイナリを拒否し、自動再接続を前提としている。音声を混在させると再送・順序・backpressure の責務が増えるため、既存 `/stream-tts` と同じく短寿命の専用 `/stream-stt` を追加する。

- 認証は既存 Runner bearer token と任意の Cloudflare ヘッダーを再利用する。
- 一つのソケットが一つの発話セッションを表す。
- 音声はバイナリ、制御と結果は JSON に限定する。
- 切断時に音声を再送しない。現在のセッションを明示的に失敗させ、二重文字起こしを防ぐ。
- Runner は端末バッファを Google の上限以下、最大 15,360 bytes のチャンクに分割する。

#### クライアントから Runner

```json
{ "type": "start", "sampleRate": 16000 }
```

- `start`: 固定の sample rate を通知する。
- binary frame: little-endian PCM16 mono。
- `stop`: ユーザーが録音中のマイクボタンを押した場合だけ入力側を閉じる。別モードは作らず、受信済みのfinalを待って完了する。

#### Runner からクライアント

```json
{ "type": "transcript", "text": "...", "isFinal": false, "stability": 0.82 }
```

- `ready`: Google のストリームが開始でき、音声送信可能。
- `transcript`: 暫定または確定結果。
- `speech_activity_begin`: Google が発話開始を検出。
- `speech_activity_end`: Google が発話終了を検出。ただし、このイベント単独では確定しない。
- `usage`: Runnerで確保済みの当月利用秒数と月間上限秒数。開始時、課金秒の加算時、終了時に返す。
- `done`: Google の最終結果を受信し、ストリームが正常終了。
- `error`: セッション失敗。ユーザーに再試行可能なエラーを示す。

#### 確定プロトコル

- クライアントは接続後に最初のJSONとして
  `{ "type": "start", "sampleRate": 16000 }`
  を一度だけ送る。sample rateは固定で`16000`だけを許可し、未知フィールド、順序違反、二重startを拒否する。
- Runnerは専用ADC、project、利用上限、start payload、Google stream設定がすべて有効になった後だけ`ready`を返す。iPhoneは`ready`を受けるまでmicrophone captureを開始せず、PCMも送らない。
- binary frameはPCM16 little-endian mono、偶数byte、1〜65,536 bytesに限定する。RunnerはGoogleへ渡す前に15,360 bytes以下へ分割し、gRPCの`drain`を待って順序を保つ。
- iPhoneはWebSocketの`bufferedAmount`を256 KiB以下に保ち、超過時は音声を黙って欠落させずセッションを失敗させる。Runnerも未処理音声を256 KiBまでに制限し、超過時は`backpressure_exceeded`で終了する。
- `usage`は
  `{ "type": "usage", "usedSeconds": 754, "limitSeconds": 3600, "remainingSeconds": 2846, "monthUtc": "2026-09", "resetAt": "2026-10-01T00:00:00.000Z" }`
  とする。開始時、予約秒の増加時、正常終了時にRunnerのledger snapshotを返す。
- `done`は
  `{ "type": "done", "reason": "user_stop" | "speech_end_timeout" | "no_speech_timeout" | "limit_reached" | "max_duration", "hasSpeech": true, "usage": { ... } }`
  とする。nested `usage`はstandalone usage eventから`type`だけを除いた同じsnapshotとする。RunnerはGoogleの`SPEECH_ACTIVITY_BEGIN`を一度でも受けたかを記録し、Googleが正常にstreamを閉じた時、未検出なら`no_speech_timeout`、検出済みなら`speech_end_timeout`と判定する。`hasSpeech`は空白を除くfinal transcriptが一つ以上ある場合だけtrueとする。
- `done.hasSpeech=true`かつ確定全文が空でない場合だけ完了対象とする。`autoReplyAfterStt`がOFFならcomposerへ残し、ONなら正常なdone後に送信する。`no_speech_timeout`または`hasSpeech=false`では空メッセージを送らず待受を再開する。
- `error`は
  `{ "type": "error", "code": "stable_machine_code", "message": "safe user-facing message", "retryable": true }`
  とする。認証情報、Google raw response、音声、transcriptを含めない。
- 接続が残っている一つのセッションは0回以上の`transcript`/`usage`/activity eventの後、`done`または`error`のどちらか一つだけをterminal eventとして返し、その後WebSocketを閉じる。`error`後に`done`は返さず、interimをfinalへ昇格しない。
- 画面離脱やtransport断でクライアントが先に消えた場合はterminal eventを送れない例外とする。RunnerはGoogle streamを中止し、予約済みusageを戻さず、音声・文字列を含まない内部終了理由だけを記録する。再接続・音声再送はしない。録音を破棄する専用`cancel` messageは追加せず、ユーザーstopはfinalを待つ`stop`、セッション放棄はsocket closeで表す。
- `limit_reached`と`max_duration`では追加PCMをGoogleへ送らずinputを正常終了し、受信済みのfinalを待ってから`done`を返す。製品側の最大長は4分50秒とする。
- `/stream-stt`はRunnerのupgrade routingとiPhoneのWebSocket認証対象の両方へ明示し、Runner tokenと既存Cloudflare headerを他の専用streamと同じ規則で付与する。

## Google STT 設定

- API: Speech-to-Text V2 `StreamingRecognize`
- 初期model: `chirp_3`。実機比較用の選択方針は下記「認識モデル・リージョンの詳細設定」を参照する。
- 初期location: `us`。接続先endpointとRecognizerのlocationは常に同じ値にする。
- language code: `ja-JP`
- encoding: `LINEAR16`
- channels: `1`
- sample rate: `16000 Hz` 固定。異なる値は開始時に拒否する。
- `interim_results: true`
- automatic punctuation: 有効
- standard endpointing: 使用
- `enable_voice_activity_events: true`

### 認識モデル・リージョンの詳細設定（2026-09-23実装・実機未検証）

目的は、途中結果の遅さが`chirp_3`固有か、Googleへの通信距離によるものかを、同じ音声経路で切り分けること。`interim_results`は途中結果の有無を指定するだけで、返却間隔は指定できない。iPhone側は既に約100 msごとにPCMを生成し、Runnerは受信分をGoogleへ逐次書くため、ここでは新しいchunk設定や自動A/B実行機構を追加しない。[RPC仕様](https://docs.cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v2)、[Googleの100 ms推奨](https://docs.cloud.google.com/speech-to-text/docs/best-practices)、[モデル差の報告](https://github.com/googleapis/google-cloud-go/issues/13543)。

- 設定画面の既存「音声入力 · Google Cloud STT」に折りたたみの「詳細設定」を置き、そこへ「リージョン」と「認識モデル」の選択を収める。別画面や別のSTTモードは作らない。
- リージョンの選択肢はまず`us`と`asia-northeast1`、認識モデルは`chirp_3`、`long`、`short`とする。初期値は現行動作と同じ`us / chirp_3`。東京は2026-09-23に開ける[公式Chirp 3対応表](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3)と[対応言語一覧](https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages)では確認できず、古い検索結果と食い違うため、UIに「検証中」と明示して実際の録音で試す。東京で各モデルが使えるとは表示しない。
- Runnerが選択値をプロジェクトID・月間上限と同じ設定境界で保存し、許可した値だけを受け付ける。クライアントは`/stream-stt`の`start`へ設定値を重複送信せず、Runnerがセッション開始時に保存済み設定を読み取る。設定変更は次の録音セッションから適用し、進行中のセッションは変えない。
- 月間利用時間はモデル・リージョンを切り替えても同じプロジェクトの台帳へ合算し、比較試行で上限を迂回できないようにする。
- Runnerは選択したregionに対応する`{region}-speech.googleapis.com`と`projects/{project}/locations/{region}/recognizers/_`を必ず対にする。STTのリージョン選択をGoogle Cloud TTSやADCの接続先へ波及させない。
- 選んだ組合せをGoogleが拒否した場合は、モデル・リージョンが利用できない旨を秘密値なしで表示し、`us`や別モデルへ黙ってfallbackしない。接続時の空音声preflightは復活させず、実際のストリーム応答で判定する。
- A/B比較は設定の手動切替で行う。各セッションの構造化ログにregion・modelと、既存の初回音声受信／初回gRPC書込／初回発話検出／初回interim／初回finalの時刻、interim件数を残す。音声・文字起こし文はログに含めない。`result_end_offset`を使う場合は結果の音声位置として記録し、単独でモデル内部の遅延と断定しない。
- 最初は同じ`us`で`chirp_3`と`long`を比較し、必要なら`short`、東京でGoogleが受け付けた組合せを同条件で比較する。暫定結果までの時間、確定までの時間、認識精度を実機で確認する。二重STTや「Chirp 3のfinalでlongの文字を置換する」構成は、この比較結果が出るまで追加しない。

## 月間利用時間の上限

### 設定と表示

- 初期値: `60分/月`。これは無料枠ではなく、概算最大 `$0.96/月` の利用上限。
- 設定単位: 1分単位の正の整数。無制限は設けず、意図しない課金を初期状態から防ぐ。
- 集計単位: Google CloudプロジェクトIDとUTC暦月。
- 設定画面の「音声入力 > Google Cloud STT」で、接続状態の直下に月間利用カードを表示する。
- カードの主表示は `今月 12分34秒 / 60分` とし、残り時間、概算金額、次回UTCリセット日時を併記する。
- 設定画面を開いた時、画面へ戻った時、音声入力を終えた時にRunnerから最新値を取得する。
- 上限を当月使用済み時間より小さく変更した場合、次のストリーム開始から拒否する。
- 表示値は「Bitty Private Runnerで送信した音声の安全側の推定値」と明記し、Google Cloud請求額そのものとは表現しない。

### 記録と月次リセット

- Runnerの月別usage ledgerへ、プロジェクトID、対象月、利用秒数、上限、最終更新日時を永続化する。
- 各セッション終了時に、開始・終了日時、加算秒数、当月累計、終了理由を構造化ログへ残す。音声データ、認識テキスト、Google認証情報は記録しない。
- UTC月が変わった最初の参照またはストリーム開始時に新しい月bucketを0秒で作成する。定期jobは追加しない。
- リセットは新しいbucketへの切替で行い、過去月の値は消去しない。これによりRunner再起動後も月別利用量を確認できる。
- 利用者向けの手動リセットは設けない。途中で0へ戻すと月間上限を超えて利用できるため、上限変更だけを提供する。
- UIが表示する「今月」の値は必ずRunnerのledgerを正とし、iPhone内のカウンターは持たない。

### Runnerでの強制

上限はiPhone側の表示制御ではなく、GCPへ音声を送る唯一の箇所であるPrivate Runnerが強制する。

- mono PCMの送信bytesから、そのセッションの課金対象秒数を算出する。
- Googleの課金規則に合わせ、各ストリームを1秒単位で切り上げる。
- セッションが新しい課金秒へ入る直前に、project/month単位のusageをmutex内で原子的に加算・永続化してから音声をGCPへ送る。
- 複数iPhoneや複数ストリームでも、同じ残時間を二重に消費できないようにする。
- Runnerが異常終了しても過少集計にならないよう、Googleエラーや途中切断時も既に予約した秒数は戻さない。
- 上限到達時は追加音声をGCPへ送らず、現在のGoogleストリームを正常終了して取得済みのfinalを返す。以後の新規開始は翌月または上限変更まで拒否する。
- usageはworktreeやdeployの切替で消えないRunner専用の永続data boundary（既定では`BITTY_GOOGLE_AUTH_DIR`配下の資格情報とは別のJSON）へ権限を制限して保存し、1秒増えるごとにatomic renameで更新する。月が変わったら新しいbucketを作り、過去月の集計は履歴として保持する。

Google CloudのBudgetは通知でありハード停止ではない。Speech-to-Textのquotaも音声分数の月額上限には使えないため、このRunner台帳がBitty内の強制境界になる。同じプロジェクトをBitty以外から利用した分は把握できないので、ユーザー向け手順としてGoogle Cloud Billingの予算アラート設定も案内する。

### 発話完了判定

Google の `voice_activity_timeout.speech_end_timeout` を使用する。初期値は現在の製品挙動に合わせて `850 ms` とし、Google が音声終了後の timeout でストリームを閉じるのを待つ。

- `SPEECH_ACTIVITY_END` を受けただけでは送信しない。
- `is_final=false` は表示専用で、確定テキストに追加しない。
- `is_final=true` を一度だけ確定テキストへ追加する。
- Google 由来の正常な stream completion 後にだけ、確定全文をチャット送信する。
- 発話前の長時間待機は `voice_activity_timeout.speech_start_timeout`（Nodeでは`voiceActivityTimeout.speechStartTimeout`）を使い、初期値 `55 s` で無音ストリームを閉じて待受セッションを再開する。これは発話完了扱いにしない。
- V2はtimeout種別そのものを終了eventとして返さないため、Runnerは`SPEECH_ACTIVITY_BEGIN`受信有無から上記`done.reason`を決定する。送信可否はさらに空でないfinal transcriptを示す`hasSpeech`で判定する。
- ユーザーが録音中にマイクボタンを押した場合はcaptureを止め、残りのPCMと`stop`を送る。RunnerはGoogleの入力側を閉じた後もfinalと正常終了を待つが、これは別の録音モードではない。
- `latest_short` / `END_OF_SINGLE_UTTERANCE` は短い音声コマンド向け Preview のため使用しない。

### 入力欄への反映

録音開始時に、既存入力文字列を `baseText` として固定する。

```text
表示値 = baseText + 確定済みセグメント + 現在の暫定セグメント
```

- 暫定結果は前の暫定結果を置換する。
- 確定結果は一度だけ確定済みセグメントへ移し、暫定部分を消す。
- 録音中は通常の composer を表示し続ける。
- 録音中の composer は編集不可にし、キーボード編集と STT 更新の競合を作らない。
- 正常な`done`後、`autoReplyAfterStt`がOFFなら確定全文を入力欄へ残し、ONなら送信して既存のTTS・次セッション開始フローへ戻る。

## 録音中フローティングUI

### 表示

- マイクボタンで録音を開始した時だけ、通常の composer と画面最下部の設定footerの上へ、横長のフローティングパネルを重ねて表示する。
- パネルは composer を置き換えない。ストリーミング中の文字は通常の入力欄へ表示し続ける。
- 背景は黒、波形は蛍光グリーンとする。テーマ色へ変換せず、録音状態を一目で識別できる固定配色にする。
- 利用時間は `12:34 / 60m` と端的に表示する。左側の値は当月累計、右側は月間上限で、録音中もRunnerの `usage` 通知に合わせて更新する。右側の値が見切れないよう、波形側を縮める。
- 停止操作は既存のマイクボタンが切り替わる停止ボタンを使う。フローティングパネルへ重複した停止操作は追加しない。
- 録音停止、正常終了、取消、接続失敗のいずれでもパネルを確実に閉じる。Googleのfinal待機中は波形を止め、短い英語表示 `FINALIZING` に切り替える。
- Safe Area、キーボード、Mini Board表示でも入力欄と停止ボタンを覆わない位置を使用する。

### 再描画境界

- 既存依存の `@shopify/react-native-skia` を使用し、新しい波形描画ライブラリやGIFを追加しない。
- PCM送信に使う同じ音声chunkからRMS音量を算出し、波形専用の固定長ring bufferへ渡す。波形表示のための二重録音は行わない。
- 音量sampleは `AppRoot`、`ChatScreen`、React Context、通常のReact stateへ流さない。波形コンポーネントのimperative refへ渡し、Skia側の値だけを更新する。
- 波形描画は最大30fpsに制限し、sample到着ごとの配列生成とReact renderを発生させない。
- フローティングパネルのmount/unmountは録音開始・終了時だけ行う。利用時間テキストの更新はパネル内部に閉じ、最大1回/秒とする。
- 波形コンポーネントを `React.memo` で固定し、利用時間テキストの更新でもSkia Canvasを再mountしない。
- transcript更新によるcomposerの再描画は必要な更新として許容するが、波形sampleの到着を理由にメッセージ一覧、composer、画面全体を再描画しない。

## 残す責務

- マイクボタンから始まる一つの音声入力UXと、`autoReplyAfterStt`による保持/送信の選択。
- 通常の chat composer と `setTranscript` 相当の入力状態更新。
- 自動返信、TTS、TTS 中断、次の音声待受。
- 顔検出など既存の開始条件。
- マイク権限と入力デバイス選択。
- Runner token / Cloudflare 認証の既存 Keychain 管理。

TTS 中断のための「発話開始検出」は、STT の「発話終了判定」と別責務として必要最小限を残す。終了判定に端末の音量ロジックを再利用しない。

旧実装ではTTS barge-in、顔による開始gate、audio session復旧・次回待受が、端末の無音判定・録音file確定・旧STT起動と同じhook群へ密結合している。2026-09-23にユーザー承認を得て、Phase 3の前処理としてこの結合を整理する。残す責務を既存の最小の境界へ移し、旧STT終了判定から参照されない状態にしてから旧経路を削除する。単なる引数転送wrapperや新旧STTの並存は採用しない。

## 削除対象

実装完了後、参照がなくなったことを確認してから削除する。

- STT provider/mode の選択肢と別名変換。
- Groq STT の `/stt` HTTP route、環境変数、呼び出し処理。
- Apple Speech の native/direct/runner クライアントと plugin/dependency。
- 録音ファイルを完了後に文字起こしする controller/service。
- direct preview 専用 UI と経路。
- composerを置き換える既存の波形GIF、`composerWaveformVisible` と波形sampleを `AppRoot` まで持ち上げる経路。
- STT provider 設定 UI。
- file recorder専用の録音品質preset/tuningと、そのstate・永続化・設定UI。live PCMは16 kHz / mono / PCM16固定とする。
- streamingでは常に文字起こしするため意味を失う`autoTranscribeOnStop`。完了後の保持/送信を決める`autoReplyAfterStt`だけを残す。
- Groq 固有の hallucination filter。
- 自動 STT 終了用の端末 dB/silence/watchdog。
- STT 用録音ファイルの生成、アップロード、一時ファイル処理。

ファイル単位の削除は実装時に `rg` で参照を確認する。顔検出や TTS barge-in と共有されているロジックは責務を分けてから不要部分だけを削除する。

## 変更範囲

### Private Runner

- 公式 Node.js client `@google-cloud/speech` を追加する。
- Runner専用ADCのMacブラウザ認証開始、状態確認、取消と、STT/TTSの資格情報取得を一つのGoogle認証serviceで扱う。
- Google CloudプロジェクトIDと月間上限をRunner側へ保存する。
- project/month別の利用秒数を原子的に永続化し、上限をGCP送信直前に強制する。
- Google streaming session を扱う小さな独立モジュールを追加する。
- WebSocket upgrade に `/stream-stt` を追加する。
- 認証、メッセージ検証、チャンク分割、Google イベント変換を実装する。
- 既存Google TTSをRunner専用ADC/project境界へ移し、ホスト共用ADCと通常gcloudログインへのfallbackを削除する。
- Groq STT と旧 `/stt` route を削除する。

巨大な `server-runtime.mjs` に Google セッション状態を埋め込まず、WebSocket 接続から呼ばれる一つのまとまった責務として分離する。単なる引数転送 wrapper は作らない。

### Expo iOS

- Codexアカウント追加と同じ操作パターンのGoogle Cloud設定sectionを追加する。
- プロジェクトIDと月間上限以外のGoogle秘密値は受け取らず保存しない。認証結果はRunner Macのlocalhost callbackだけで完了する。
- ADCの接続状態、使用済み時間、残り時間をRunner管理APIから表示する。STTの可否は録音時のGoogle応答で確認する。
- PCM stream recorder を iOS の platform boundary に置く。
- 短寿命の STT WebSocket client を追加する。
- transcript の `base/final/interim` 状態を一か所で管理する。
- 通常 composer へ逐次反映する。
- composerを置き換えない録音中フローティングパネルと、独立したSkia波形コンポーネントを追加する。
- Runnerの `usage` 通知をフローティングパネル内部だけへ反映する。
- 旧 provider 切り替え、ファイル後処理、direct controller を削除する。

## 実施フェーズ

### Phase 0: 音声取得の適合性ゲート

- [x] `@siteed/audio-studio` の対応版を 3.2.1 に固定した。
- [x] iOS で PCM16 / mono / 16 kHz の live buffer を取得する最小境界と contract test を追加した。
- [x] primary/compressed output を無効化し、start/stop の戻り値でもファイル URI がないことを検証する stream-only 境界にした。
- [x] iOS build、Expo doctor、TypeScript、macOS 側の依存解決と build を確認した。
- [x] 当初の iOS 15.1 不適合を停止・報告し、承認後に最低 iOS 16.4 を正本から設定して再検証した。

完了条件: アプリ全体の SDK/RN 更新や独自 native patch なしで live PCM を取得できる。

### Phase 1: Google Cloud接続と利用上限

- [x] 既存Codex UIと同じ開始・ブラウザ認証・poll・取消の操作パターンをGoogle専用sectionへ実装し、ブラウザはRunner Macで開くことを明示する。
- [x] `BITTY_GOOGLE_AUTH_DIR` の専用ディレクトリとADCファイルを `0700` / `0600` で作成・検証する。
- [x] Runnerが専用 `CLOUDSDK_CONFIG` を渡した通常の `gcloud auth application-default login` を一時processとして管理する。
- [x] Macブラウザ起動、localhost callback完了、timeout、取消、process cleanupをテストする（process mock）。
- [x] iPhone向けAPI、ログ、標準出力へ認証URL、authorization code、tokenを出さないことをテストする。
- [x] プロジェクトIDをRunnerへ保存し、ADC quota projectへ反映する。
- [x] Google TTSを同じ専用ADC/projectへ移し、ホスト共用ADCと通常gcloudログインへのfallbackを削除する。
- [x] ADCの接続状態とアカウントを秘密値なしで返し、IAM/API不足は実際のストリームエラーから安全に表示する。
- [x] 月間上限設定とproject/month usage ledgerをRunnerへ実装する。
- [x] 月替わり時は過去月を削除せず、新しい月bucketを0秒で作る。
- [x] セッション終了時に、音声・文字列・秘密値を含まない利用集計ログを記録する。
- [x] 60分を初期値として、`今月の使用時間 / 上限`、残り時間、概算金額、次回リセットを設定画面のGoogle Cloud STT接続状態直下へ表示する。
- [x] 不要なAPI keyやサービスアカウント鍵を作っていないことを確認する。

`speech.googleapis.com` の有効化、billing、IAM付与はユーザーが行う。実装作業ではこれらのGoogle Cloud状態を変更しない。

### Phase 2: Runner streaming path

- [x] `/stream-stt` の認証と protocol validation をテストする。
- [x] 接続済みADC、プロジェクトID、残り利用時間が揃わない場合は開始を拒否する。
- [x] V2 `StreamingRecognize` を設定する。
- [x] PCM binary frame を上限以下へ分割して順序通り送る。
- [x] 音声送信前に課金秒数を原子的に予約し、上限到達時に正常終了する。
- [x] interim/final/activity/done/error をクライアント protocol へ変換する。
- [x] ユーザーstopとGoogle voice activity timeoutの完了順序をテストする。
- [x] 切断・Google error・5分上限を安全に終了する。

### Phase 3: iOS と composer

- [x] TTS barge-in、顔による開始gate、audio session復旧・次回待受を旧STT終了/file処理から分離する。
- [x] 分離後もTTS割り込み・顔gate・session復旧の既存挙動をfocused testで固定する。
- [x] microphone PCM を `/stream-stt` へ送る。
- [x] `base + final + interim` の reducer/state をテストする。
- [x] 通常 composer に暫定文字を逐次表示する。
- [x] 録音開始時だけ、黒背景・蛍光グリーンの丸棒波形・`mm:ss / Nm` を持つフローティングパネルをfooter上へ表示する。
- [x] 同じPCM chunkからRMSを算出し、波形専用ring bufferへ渡す。
- [x] 波形更新をSkiaコンポーネント内へ閉じ、React state/contextを音量sampleごとに更新しない。
- [x] Runnerのusage通知を最大1回/秒でパネルの英語表示へ反映する。
- [x] ユーザーstop時もfinalを待ち、`autoReplyAfterStt`による保持/送信を確認する。
- [x] Google終了判定、送信、TTS、再待受を確認する。
- [x] エラー時に途中の暫定結果を確定扱いしない。

### Phase 4: 旧 STT 削除

- [x] Groq STT route/config/dependency を削除する。
- [x] Apple Speech の旧クライアント/plugin/dependency を削除する。
- [x] 録音ファイル後処理と direct preview を削除する。
- [x] provider/mode 設定を削除して GCP 一経路にする。
- [x] 端末独自の STT 終了判定を削除する。
- [x] `rg` で旧 mode/provider/Groq/Apple Speech の残存参照を確認する。

### Phase 5: 総合検証と文書更新

- [x] 単体テストと型検査を実行する（Expoにlint scriptはない）。
- [x] Runner test suite を実行する。
- [x] iOS Release Simulator build を実行する。
- [ ] 実機で日本語の自動終了/ユーザーstop/長い発話/間のある発話を確認する。
- [x] macOS の既存 build/typecheck が退行していないことを確認する。
- [x] 本書へ実際のコマンドと結果、残課題を記録する。

## 必須テストケース

### Google Cloud接続

- iPhoneから認証開始するとRunner Macのブラウザが開き、localhost callback完了後に接続済みへ遷移する。
- 認証のtimeout・取消・ブラウザ起動失敗・callback失敗で一時processと一時状態が残らない。
- iPhone向けAPIと画面に認証URL、device code、authorization code、Google tokenが現れない。
- iPhoneの永続設定、ログ、HTTP responseへGoogle tokenが出ない。
- login、再認証、quota project変更、接続解除の前後で、ホストの標準ADCファイルと通常gcloudアカウントが変更されない。
- 専用ADCがない状態では、ホストの標準ADCや通常gcloudログインが有効でもSTT/TTSを開始できない。
- 専用認証ディレクトリまたはADCファイルの権限が広すぎる場合は起動時に拒否し、秘密値を含めず理由を表示する。
- プロジェクトIDの変更時にquota projectとADCの接続状態が更新される。
- 実際のストリームでAPI無効、IAM不足、billing不足を区別可能な表示へ変換する。
- 接続解除前にTTS/STT双方へ影響することを表示し、確認後にRunner専用ADCだけを失効させる。

### 月間利用時間

- 初期上限が60分で、無料枠とは表示しない。
- 同一セッションの音声時間を1秒単位で切り上げる。
- 複数セッションをそれぞれ切り上げて合算する。
- 並行ストリームでも上限を超えて予約できない。
- 上限到達直前のストリームをfinalまで完了し、それ以上の音声を送信しない。
- Google error・クライアント切断・Runner再起動後も予約済み時間を戻さない。
- UTC月替わりで新しい月の使用量が0になり、前月記録を保持する。
- 月替わりに定期jobを必要とせず、最初の参照または利用で新しい月へ切り替わる。
- セッション終了ログに加算秒数、当月累計、終了理由が残り、音声・認識テキスト・認証情報は残らない。
- 設定画面を再表示した時と音声入力終了後に、Runnerの当月累計がUIへ反映される。
- 手動リセットで月間上限を迂回できない。
- 上限変更を即時反映し、使用済み未満へ下げた場合は新規開始を拒否する。
- iPhoneを再インストールしてもRunner側の上限・使用量が失われない。

### 認識モデル・リージョンの詳細設定（自動検証済み・実機A/B待ち）

- 詳細設定を閉じても現在の選択値が分かり、開くとリージョンと認識モデルを変更できる。
- 既存の設定では`us / chirp_3`から動作が変わらず、Runner再起動・別端末接続後も選択が保たれる。
- 無効な値をRunnerが拒否し、endpointとRecognizerのlocationが一致する。
- 東京で非対応の組合せが拒否された場合、理由を表示し、別リージョン・モデルへ暗黙に切り替えない。
- 設定変更中の録音には旧設定を使い、次の録音から新設定を使う。
- 各セッションのログに選択値と初回interim/final時刻が残り、音声・文字起こし文・認証情報は残らない。
- `chirp_3`と`long`を同一リージョン・同条件で比較し、途中表示、確定、認識精度の実機結果を記録する。

### Transcript state

- 暫定 `A` の後に暫定 `AB` が来た場合、`AAB` ではなく `AB` を表示する。
- 暫定結果が確定結果へ変わった場合、一度だけ追加する。
- 複数の final result が来た場合、順序を保って結合する。
- 既存の入力文字がある場合、それを消さずに音声結果を後置する。
- error/cancel 時に暫定結果を確定しない。

### 録音中フローティングUI

- 録音中も通常のcomposerが残り、interim/final文字列と波形を同時に確認できる。
- 表示文言が `mm:ss / Nm` と `FINALIZING` だけである。
- 黒背景と蛍光グリーンの波形がlight/dark themeの両方で変化しない。
- 音量sampleを連続投入しても、波形コンポーネント以外のrender回数が増えないことをrender counterテストで確認する。
- 利用時間更新ではパネル内のテキストだけが再描画され、Skia Canvasが再mountされない。
- 30fps上限、固定長buffer、録音終了後の描画loop停止を実機計測で確認する。
- stop、cancel、Google error、画面離脱のすべてでパネルと描画loopが残らない。

### 発話完了

- Google の発話終了 timeout 前の短い間では送信しない。
- `SPEECH_ACTIVITY_END` の直後では送信せず、final と正常終了を待つ。
- 55秒発話がない場合は空メッセージを送らず、待受を再開する。
- ユーザーstop後も最後のfinal resultを待ち、停止直前の音声を欠落させない。
- TTS 再生中の発話開始で既存の中断挙動を維持する。

### Transport / failure

- 無認証接続を拒否する。
- JSON の順序違反、未知 message、想定外 binary を安全に拒否する。
- Runner/Google 切断で二重送信・音声再送をしない。
- Google API error を利用者へ示し、旧 STT へ暗黙 fallback しない。

## 受け入れ条件

- 発話中の文字が通常の入力欄へ逐次表示される。
- 暫定文字は修正され得るものとして置換され、確定文字の重複がない。
- 通常の終了判断はGoogleの公式Voice Activity Timeoutによる。
- ユーザーstopでもGoogleのfinalを待ち、別のSTTモードは持たない。
- STT は GCP 一経路だけになり、Groq/Apple/file-after-recording のコードが残らない。
- 設定画面からGoogle Cloudの接続・再認証・解除とプロジェクト選択ができる。
- Google 認証情報を iPhone やリポジトリへ保存しない。
- Runner専用ADCがホストの標準ADCから隔離され、Bittyの接続・再認証・解除がほかのGoogle利用へ影響しない。
- Google STT/TTSが専用ADCだけを共有し、ホスト資格情報へのfallbackがない。
- 月間上限を設定でき、RunnerがGCP送信直前に強制する。
- 当月使用時間、残り時間、概算金額、次回リセットを設定画面で確認できる。
- 録音中はfooter上の黒いフローティングパネルで、蛍光グリーンの波形と英語の当月使用時間を確認できる。
- 波形更新によって波形以外の画面要素が再描画されない。
- 60分はV2の無料枠ではなく、概算 `$0.96` の上限として正しく表示される。
- iOS の既存機能と Private Runner、macOS の依存関係を壊さない。
- テストと実機確認の結果がこの文書へ記録される。

## 停止条件

次の場合は力技で進めず、その時点で停止して報告する。

- live PCM dependency が Expo SDK 54 または iOS build に適合しない。
- dependency が `react-native-macos` の解決や build を壊す。
- Runner Macでブラウザを起動できない、またはgcloudのlocalhost callbackを安定して完了できない。
- Google の StreamingRecognize が対象プロジェクト/ADC/IAM で利用できない。
- 公式仕様と既存 UX の両立に、SDK 全体更新または独自 native module が必要になる。
- 旧ロジックが STT 以外の責務と密結合し、安全に削除できない。

## 採用しない案

- 暫定文字をタイマーで疑似表示する: 根本の音声処理は batch のままなので不採用。
- Groq/Apple/GCP の fallback を残す: 経路とテストの組合せが増えるため不採用。
- Google API key を iPhone 設定へ追加する: StreamingRecognize の認証方式と責務境界に合わないため不採用。
- `gcloud auth application-default login --no-launch-browser` とauthorization code貼付を使う: Google秘密値をiPhoneとRunner間へ流すため不採用。
- Codexと同じGoogle device-code flowを自作する: Googleのlimited-input device flowはSpeechで必要な `cloud-platform` scopeを許可しないため不採用。
- 認証のためだけにCloudflare HTTPSを必須化する: Runner Macのブラウザとlocalhost callbackでGoogle秘密値を端末間送信せず完了できるため不採用。
- Google Cloud APIをBittyから自動有効化する: billing・IAMを含むクラウド側管理はユーザーの責務とするため不採用。
- 音声を既存 `/runner-ws` に混ぜる: 制御通信へ binary/replay/backpressure を持ち込むため不採用。
- 本タスクで Expo SDK 57 へ上げる: 現行 `react-native-macos` と React Native 世代が合わないため不採用。
- 初期実装から独自 Swift recorder を作る: 当時は保守対象を増やすため不採用。実機フィードバック後の直接バイナリ送信は、下記の次期設計として改めて採用する。

## 2026-09-23 実機フィードバック後の調査メモ（未実装）

この節は次の修正を決めるための記録。静的なコード調査と公式資料の確認結果であり、音声経路・電池消費の実機計測や修正完了を意味しない。

- **音が小さくなる:** iOSの`useLivePcmCapture.ts`は`@siteed/audio-studio`の録音を開始するが、iOS音声セッションを指定していない。同ライブラリの既定は`PlayAndRecord`、`AllowBluetooth`、`MixWithOthers`で、`DefaultToSpeaker`はない。Appleによれば`PlayAndRecord`の既定出力は受話口。録音停止ではライブラリが非同期にセッションを無効化する一方、再生用カテゴリは復元しない。`expo-av`も別に音声セッションを管理するため、最初の録音後に受話口経由となるのが有力な原因。ただし実機で出力ポートは未確認。録音開始・終了・TTS再生時と有線/無線イヤホン接続時のルートを実測する。`DefaultToSpeaker`を無条件に加えるだけではイヤホン等の経路を変える恐れがあるため、録音と再生の音声セッション管理・復元を同じ境界で検討する。[Appleの経路説明](https://developer.apple.com/documentation/audiotoolbox/1618372-audio-session-category-route-ove)、[DefaultToSpeaker](https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/defaulttospeaker)。
- **無音時の現状:** iOSは16 kHz・mono・PCM16を約100 msごとに取得し、`useStreamingStt.ts`は音量に関係なく全chunkをWebSocketへ送る。Runnerも全音声をGoogleへ転送し、送ったPCM量で月間利用時間を予約する。Googleの`55 s`発話開始timeoutで無音セッションが終わっても、待受中は`250 ms`後に次のセッションを始める。したがって待受中の無音も通信・Google処理・利用時間に含まれる。[Google料金](https://cloud.google.com/speech-to-text/pricing)。
- **無音の判定案:** ユーザー提案どおり、端末の判定を**発話開始だけ**に使う余地がある。待受中は端末内で短い音声pre-rollを保持し、発話検出時に冒頭からGoogleへ送り、発話後から終了までは無音を含め連続送信する。終了判定は従来どおりGoogleのVoice Activity Events/timeoutに任せ、自動再待受も維持する。単に開いたGoogle streamから無音chunkだけを抜く方法は、Googleのtimeoutが経過時間ではなく受信音声量で進むため不可。現在の波形用RMSは音量であって発話検出器ではなく、小声・騒音で誤判定し得る。端末側検出の方式、pre-roll長、Google streamを発話まで開かない開始順序、Runnerの`ready`起点の最大290秒タイマーを併せて設計・実機検証する。[Google VAD仕様](https://docs.cloud.google.com/speech-to-text/docs/voice-activity-events)。
- **圧縮と電池:** 現行PCMは`16,000 × 16 bit × 1 ch = 256 kbps`（約32 KB/s）。iOSネイティブ側で必要に応じてリサンプリング・PCM16変換し、Base64でJavaScriptへ渡し、JSが復号・RMS計算・WebSocket送信をする。録音ライブラリの追加音声解析とファイル出力は無効。Google V2はコンテナ化した`OGG_OPUS`/`WEBM_OPUS`を受け付けるが、現在のiOSライブラリはOpus指定をAACにfallbackし、圧縮データをファイルへ書く。現行のfileless PCM経路を設定一つでOpusへ変更できず、RunnerのPCM前提の形式検証・利用時間計算も変更が要る。圧縮は通信量を減らせる一方、符号化CPUを増やし得る。Googleの課金はbyte数でなく処理音声時間なので、圧縮だけでは利用料金を減らさない。[Google V2対応形式](https://docs.cloud.google.com/speech-to-text/docs/reference/rest/v2/projects.locations.recognizers)、[Googleの音声品質推奨](https://docs.cloud.google.com/speech-to-text/docs/best-practices)。
- **電池調査の次手:** 通話アプリとの単純な体感比較やPCM通信量だけで主因を決めない。iPhone実機で、待受無音・発話中・待受停止の各状態について、Xcode/Instrumentsで`Audio`、`Networking`、`Processing`、`Display`を分けて測る。通信が主因ならcodec/送信頻度、処理が主因ならネイティブ変換・Base64/JS bridge、待受中のGoogle通信が主因なら発話開始gateを優先して比較する。100→200 msのchunk間隔はbridge/送信回数を減らす可能性があるが、暫定結果の遅延を増やし、マイク稼働やGoogle処理時間は減らさないため、測定なしには採用しない。[Appleの電池解析](https://developer.apple.com/documentation/xcode/analyzing-your-app-s-battery-use)、[Google推奨frame長](https://docs.cloud.google.com/speech-to-text/docs/best-practices)。

## iPhone音声バイナリ直接送信の次期設計（2026-09-23実装・実機未検証）

目的は、iPhoneの音声バッファをBase64化してReact NativeのJavaScriptへ渡す経路をなくし、iPhoneのネイティブ層からPrivate Runnerへ**バイナリ音声を直接送る**こと。現行でもRunnerへのWebSocket送信自体はバイナリであり、Base64はiOSネイティブ→JS bridge内だけで使われる。この節は実装方針であり、CPU・電池改善量は未計測。

- Expo SDK 54で利用できる[ローカルExpoモジュール](https://docs.expo.dev/modules/get-started/)をiOSに作り、[AVAudioEngineの入力tap](https://developer.apple.com/documentation/avfaudio/avaudionode/installtap(onbus:buffersize:format:block:))、[AVAudioConverter](https://developer.apple.com/documentation/avfaudio/avaudioconverter)、[URLSessionWebSocketTask](https://developer.apple.com/documentation/foundation/urlsessionwebsockettask)を使う。既存のiOS向け`@siteed/audio-studio`録音とJSでのBase64復号・PCM送信を置き換える。録音ファイルは作らない。
- 既存と同じ16 kHz・mono・little-endian PCM16を約100 ms単位で送る。`/stream-stt`とRunner→Google V2の形式・プロトコルは変えず、まずcodecやRunnerの課金計算を変更しない。Macの録音経路にも触れない。
- iOSの1セッションにつきネイティブのWebSocketを1本だけ所有し、`start`・binary PCM・`stop`を同じ接続で送受信する。Runner tokenと、対象Runnerで必要なCloudflare Accessヘッダーを現行の認証条件どおりに付ける。既存URLの`http→ws`、`https→wss`を維持し、ローカル通信のためだけに暗号化を追加しない。
- JSは開始・停止指示とRunnerのJSONイベント（`ready`、transcript、usage、done、error等）の処理、composer反映、自動再待受を担当する。音声PCMはJSへ渡さない。波形に必要な低頻度の音量値だけをネイティブから通知し、描画コンポーネントの更新に閉じ込める。WebSocketをJSとネイティブの両方で開かない。
- 音声tapのリアルタイムcallbackでは重い変換、JS呼出し、ネットワーク送信、待機を行わない。バッファを短時間で専用の直列処理へ渡し、変換・送信順序を保つ。[Appleのリアルタイム音声処理指針](https://developer.apple.com/library/archive/qa/qa1715/_index.html)に従い、未送信キューを有界にし、超過・切断時は黙って音声を欠落させずセッションを失敗させる。`ready`前は録音を開始せず、停止時は既存どおりGoogleのfinalと`done`を待つ。
- 実装時は既存の`useStreamingStt`の状態遷移、文字起こし確定・利用時間・再待受を生かし、iOSの音声取得・送信境界だけを置換する。二重のセッション管理や汎用音声転送ライブラリは作らない。置換後、iOS専用で不要になった`@siteed/audio-studio`依存とBase64復号処理を削除する。

他案の判断: 現行`@siteed/audio-studio`のraw streamはBase64であり、`float32`でもiOSでは数値配列でJSを経由する。Expo SDK 56の`useAudioStream`は`ArrayBuffer`を返せるが、SDK更新が必要で、JS経由も残る。React Native向けの別ライブラリでJSへ`ArrayBuffer`を渡す案も「iPhoneネイティブからRunnerへ直接」という要件を満たさない。Opusは通信量を減らせるが符号化負荷・Runner形式変更を伴い、Googleの音声時間課金も減らさないため、現段階では採用しない。[Expo SDK 56 Audio](https://docs.expo.dev/versions/v56.0.0/sdk/audio/)、[Google音声形式・品質推奨](https://docs.cloud.google.com/speech-to-text/docs/best-practices)。

実装前後に実機で、発話中・無音待受・停止中のCPU、電池、送信byte数、暫定表示遅延を同条件で比較する。Runner認証・Cloudflare経由、停止・再待受・接続断・backpressure、受話口/スピーカー/イヤホン経路を確認する。無音時にGoogle接続を開かない「発話開始gate」と音声セッション復元は別の論点として扱い、今回のバイナリ化だけで電池問題や音量低下が解決したとはみなさない。

## 公式資料

- [Speech-to-Text streaming recognize](https://docs.cloud.google.com/speech-to-text/docs/streaming-recognize)
- [Speech-to-Text V2 RPC reference](https://docs.cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v2)
- [Voice activity events and timeouts](https://docs.cloud.google.com/speech-to-text/docs/voice-activity-events)
- [Speech-to-Text authentication](https://docs.cloud.google.com/speech-to-text/docs/v1/authentication)
- [Speech-to-Text IAM](https://docs.cloud.google.com/speech-to-text/docs/iam)
- [Chirp 3 model](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3)
- [Speech-to-Text quotas and limits](https://docs.cloud.google.com/speech-to-text/docs/quotas)
- [Speech-to-Text pricing](https://cloud.google.com/speech-to-text/pricing)
- [Application Default Credentials](https://docs.cloud.google.com/docs/authentication/application-default-credentials)
- [`gcloud auth application-default login`](https://docs.cloud.google.com/sdk/gcloud/reference/auth/application-default/login)
- [Google OAuth 2.0 for limited-input devices](https://developers.google.com/identity/protocols/oauth2/limited-input-device)
- [Cloud Billing budgets](https://docs.cloud.google.com/billing/docs/how-to/budgets)
- [Service account key best practices](https://docs.cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys)
- [Expo Audio SDK 56 reference](https://docs.expo.dev/versions/v56.0.0/sdk/audio/)
- [Expo SDK 56 changelog](https://expo.dev/changelog/sdk-56)
- [`@siteed/audio-studio` recording configuration](https://deeeed.github.io/audiolab/docs/api-reference/recording-config/)

## 検証記録

| 日付 | フェーズ | 結果 | 詳細 |
| --- | --- | --- | --- |
| 2026-09-22 | 調査 | 完了 | GCP project、billing、API 状態、ADC、既存 STT/credential 経路を確認 |
| 2026-09-22 | 料金再確認 | 完了 | 60分無料はV1のみ。V2 Chirp 3は `$0.016/分` と確認 |
| 2026-09-22 | 計画 | 完了 | Google接続UIと月間上限を追加。実装・API有効化は未着手 |
| 2026-09-22 | 計画 | 完了 | 録音中フローティングUI、英語の月間使用時間表示、独立したSkia波形描画境界を追加 |
| 2026-09-22 | 計画レビュー | 完了 | Google認証をRunner専用ADCへ隔離し、STT/TTSのホスト共用ADC fallbackを廃止する方針を確定 |
| 2026-09-22 | Phase 0 | 完了 | `@siteed/audio-studio` 3.2.1を固定。Expo SDK 54 / React Native 0.81は維持し、承認済みの最低iOS 16.4を`expo/app.json`から生成 |
| 2026-09-22 | Phase 0 | 完了 | PCM16 / mono / 16 kHz、raw live buffer、primary/compressed output無効のhook test 2件、base/macOS TypeScript、Expo doctor 18/18が成功 |
| 2026-09-22 | Phase 0 | 完了 | iOS prebuild / Pod installでAudioStudio 3.2.1をPodとExpoModulesProviderへ組み込み、Release arm64 Simulator buildが成功 |
| 2026-09-22 | Phase 0 | 完了 | macOS Pod installでAudioStudioを除外し、Debug arm64 macOS buildが成功 |
| 2026-09-22 | Phase 0 | 注意 | Debug Simulator buildはAudioStudio compile後、既存React Native/Fabricの未解決symbolで最終linkに失敗。Release arm64 Simulator buildでは再現しない |
| 2026-09-23 | 認証設計 | 完了 | iPhoneで開始し、Runner Macの通常ブラウザとlocalhost callbackでADC認証を完了する方式に確定。Google秘密値はiPhone/Runner通信へ載せない |
| 2026-09-23 | iOS責務整理 | 承認 | 旧STT終了判定と密結合したTTS barge-in・顔gate・audio session復旧を先に分離し、その後に旧STT経路を削除する方針を確定 |
| 2026-09-23 | Phase 1〜4 | 自動検証完了 | GCP専用ADC接続、月間usage、RunnerのV2 stream、iOSの逐次composer・録音footerを追加し、旧STT経路を削除。レビュー指摘の認証開始競合・録音停止重複・利用上限の同時変更・下書き付き録音開始を修正 |
| 2026-09-23 | Phase 5 | 自動検証完了 | worktreeルートで `node --test private_runner/tests/*.test.mjs`: 802件（801 pass・1 skip）。`expo`で `npm test -- --runInBand --silent`: 157 suites / 1228 tests pass。`npm run typecheck` と `npm run typecheck:macos` pass。`git diff --check` pass |
| 2026-09-23 | Phase 5 | iOS build完了 | `expo/ios`で `xcodebuild -workspace Bitty.xcworkspace -scheme Bitty -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath /private/tmp/bitty-gcp-stt-derived CODE_SIGNING_ALLOWED=NO -quiet build` 成功。生成PodからExpoSpeechRecognitionを除去済み |
| 2026-09-23 | Phase 5 | macOS build完了 | `expo/macos`で `xcodebuild -workspace bitty.xcworkspace -scheme bitty-macOS -configuration Debug -destination 'generic/platform=macOS' -derivedDataPath /private/tmp/bitty-gcp-stt-macos-derived CODE_SIGNING_ALLOWED=NO -quiet build` 成功 |
| 2026-09-23 | Phase 5 | 未確認 | 実機のMacブラウザ認証、Google V2応答、日本語発話終了・停止・長い発話、設定UIと録音footer、実際のGCP使用量を未確認 |
| 2026-09-23 | 実機フィードバック | 原因特定・修正 | Google接続は成功したが録音時に `Google Cloud Speech availability could not be verified`。旧preflightが空音声の`Recognize`を送り、Googleは`FAILED_PRECONDITION (Audio cannot be empty)`を返していた。疑似preflightを削除し、実際のstream応答でエラーを判定する。`speech.googleapis.com` は読み取りCLIで有効と確認。修正後のRunner全802件（801 pass・1 skip）、Expo設定画面8件、Expo型チェックが成功。修正後の実機録音は未確認 |
| 2026-09-23 | 認証表示レビュー | 修正 | 再認証失敗時も保存済みADCが有効なら接続済み表示を維持し、安全な失敗メッセージを示す。初回認証失敗は未接続のまま。追加修正後の認証focused test 16件と構文チェックが成功（Runner全体はこの一行修正後には再実行していない） |
| 2026-09-23 | Mac音声入力・録音footer | 自動検証完了 | MacのAVAudioEngine録音とPCM変換、中央の丸棒から端の点へ続くSkia波形、使用時間の右端表示を追加。macOS Debug build、iOS/macOS型チェック、関連4 suites / 48 tests、plist/project lintが成功。Mac実機のマイク許可・発話、幅の狭いfooter表示は未確認 |
| 2026-09-23 | Mac録音開始レビュー | 修正・自動検証完了 | 音声tapからの共有世代値の読みをやめ、旧録音開始が保留中の停止→即再開始では旧開始の完了・後片付けを待ってから新録音を始める。再現テストを追加。修正後のmacOS Debug build、iOS/macOS型チェック、関連4 suites / 49 testsが成功。実機でのマイク許可と再開始は未確認 |
| 2026-09-23 | Runner音声タイミング | 診断追加・実機未確認 | `session_finished` に内容を含まないセッション開始からの相対時刻（最初の音声受信→gRPC書込→発話開始/終了→最初の暫定/確定結果）と最大usage予約待ち時間を記録し、遅延箇所を切り分ける。Runnerの関連15 testsが成功。実GCPでの原因判定はまだ行っておらず、次回の実機再現時にログの時系列を確認する |
| 2026-09-23 | iPhoneバイナリ直接送信 | 自動検証完了・実機待ち | iOSローカルExpoモジュールで録音・PCM変換・単一WebSocketバイナリ送信を実装し、JSへのBase64/PCM転送と`@siteed/audio-studio`依存を削除。接続失敗時の終了、送信順序・有界キュー、音声セッション復元をレビュー後に修正。iOS Release Simulatorアプリ全体のビルド、Expo 160 suites / 1237 tests、iOS/macOS型チェック、Runner 809 tests（808 pass・1 skip）が成功。実iPhoneでの音声・経路・CPU・電池・遅延は未確認 |
| 2026-09-23 | iPhoneバイナリ直接送信 | Mac退行確認完了 | 不要なAudioStudioのmacOS Pod除外を削除し、Mac Debugアプリ全体のビルドが成功。iPhone専用BittySttTransportはiOS Podのみに自動登録された |
| 2026-09-23 | モデル・リージョン比較 | 自動検証完了・実機A/B待ち | 既存のGoogle Cloud STT設定へ折りたたみ詳細設定を追加し、Runner保存・許可値検証・新規セッションへの反映・選択値ログ・非対応時の安全なエラーを実装。Runner関連39件と全テスト、Expo設定画面10件、iOS/macOS型チェックが成功。独立レビューで指摘なし。実Googleでの組合せ可否・遅延・精度は未確認 |
| 2026-09-23 | 実機モデル比較・終了エラー | 自動修正完了・実機再確認待ち | ユーザー実機では東京の`chirp_3`は利用不可、`long`は応答が大幅に速いとの報告。選択機能は維持し、詳細設定は選択時に自動保存へ変更。共有Runnerログでは確定結果後の`google_stream_failed`が4件あったが元例外は未記録。Googleの無音タイムアウトによる正常終了と音声書込の競合に限定して正常終了待ちを追加し、Google側エラーと利用時間保存エラーを区別して安全なコードを記録する。過去4件の原因は未確定で、修正後の実機ログで要確認。電池・CPUの改善量はログに計測値がなく未判定。Runner全817件は直列実行で816 pass・1 skip、Expo全160 suites / 1238 tests、iOS/macOS型チェックが成功。Runner並列実行では無関係のスケジュール競合テスト1件が失敗し、単独実行では成功 |
