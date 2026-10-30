# 通信量の調査と共通転送の圧縮

## 観測範囲と限界

2026-10-30の調査時点で、`private_runner/logs/client_auto_logs` の保持10ファイルを集計した。
`network_usage_snapshot` は628件、記録時刻は2026-10-28 01:27〜10-29 21:56 UTC。
ログは稼働中に追記・ローテートされるため、この期間の全通信を保証するものではない。
累計カウンタはアプリ起動・resetごとに分け、隣接snapshotの差分で読む。累計値を足し合わせない。
回線種別がsnapshotにないため、モバイル回線だけの通信量とは断定できない。

初回調査で確認した10/29の約24分の起動区間では、受信約160MBのうちHTTP「その他」約124MB、
Runner WS約36MB、TTS media約0.07MBだった。現在の主要な計測量は音声以外にもある。
別の区間では1分でHTTP「その他」が約32〜37MB増えていた。
保持ログの子一覧取得完了は1,788件、報告された一覧WS envelopeは合計約821MBだった。
診断ログには間引き・欠落があり、これを実要求回数や全通信の総量とは扱わない。

従来のHTTP「その他」は`/client-state`、`/agent/session-history`、ボード、Git、選択中Runner以外への
fetchを混在させる。これだけで約124MBの取得先や再取得の原因は特定できない。
`client-state`はdraft保存のPOSTでも全snapshotを返すが、その経路が支配的だと断定する証拠はまだない。

## 確認した転送の問題と変更

- 共通JSON応答と`client-state`応答は無圧縮だった。共通送信境界へ統合し、`Accept-Encoding`が許す
  1KiB以上のJSONを非同期gzipで圧縮する。小さい応答、圧縮が大きくなる場合、gzip非対応クライアントは
  identityのまま返す。新規依存・設定項目・個別画面のキャッシュは追加しない。
- `client-state`のETagはsnapshotを識別するweak validatorに統一し、identity/gzipをまたいで再検証する。
  `Vary: Authorization, Accept-Encoding`を保ち、304は本文・Content-Encoding・Content-Lengthを返さない。
- Runner WSは圧縮交渉が無効だった。標準の`permessage-deflate`を有効にする。対応クライアントだけが
  交渉し、非対応クライアントは従来どおり接続できる。context takeoverを無効にして接続ごとの状態を抑え、
  小さいメッセージは圧縮しない。音声専用WSの符号化や履歴の鮮度・ページング契約は変えない。
- HTTPカウンタにclient-state、agent-history、skia-board、git、client-logs、other-originを追加した。
  other-originは「選択中Runner以外」であり、同じRunnerの別local/Cloudflare URLも含む。
  URL・query・セッション本文をログへ追加せず、固定カテゴリのバイト数だけを記録する。

## 公開可能な合成データでの確認

`private_runner`で次を実行する。実ユーザーの会話本文をfixtureや成果物に含めない。

```sh
node --test tests/http-json.test.mjs tests/client-state-endpoint.test.mjs tests/runner-ws-compression.test.mjs
```

300件の合成一覧でHTTP JSON本文71,194 bytes → gzip転送本文1,991 bytes（約97.2%減）。
WSは同一JSON本文42,151 bytesに対し、handshakeと初期readyを含むソケット受信量が
非交渉42,500 bytes → 圧縮交渉2,279 bytes（約94.6%減）だった。
本文の同一性、交渉しないクライアント、再接続、GET/POST/304、HEAD、認証・更新後の再検証をテストする。
これは合成一覧の結果であり、実機の総通信量の削減率ではない。

## 実機での再測定

同じ操作（起動、一覧、子一覧、会話再表示、入力・draft保存）を同程度の時間行い、
新しい`network_usage_snapshot`の起動内差分をHTTPカテゴリ別に比較する。
大きなHTTP「その他」の帰属を特定し、要求頻度・同じ内容の再送の要否を次に調べる。

HTTPはContent-Lengthがあればその転送本文長、なければ取得後の本文長を使う。
Runner WSはネイティブが展開したJSONの長さであり、圧縮してもこの値は減らない。
ログへ`runnerWsMeasurement: decoded_payload_bytes`等を明記し、接続情報の
`perMessageDeflate`で実際に圧縮交渉したかを確認する。
ヘッダ、TLS、再送等はカウンタに含まれず、実際の携帯回線使用量はOS側の計測と照合が必要。
iOS実機の圧縮交渉・Cloudflare経由・総通信量の改善は、この変更の自動テストでは未検証。
