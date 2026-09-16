# Codex アカウント切替認証 スパイク進捗

## 状態

- 状態: 採用・実装済み（2026-09-16）。本番統合検証待ち
- 基準設計: `docs/CODEX-ACCOUNT-SWITCH-AUTH-DESIGN.md`
- 隔離条件: 既存Bitty Runnerを変更せず、`/private/tmp`の一時`CODEX_HOME`だけを使用
- 秘密情報: token本文、verification URL、user code、callbackを記録しない

## 目的

experimental `chatgptAuthTokens`方式が、通常CLI / VSCodeの`~/.codex/auth.json`を変更せず、Bittyの認証所有権をRunnerへ分離できるか実測する。

## チェック項目

- [x] 1. installed versionと生成schemaにdevice-code、external token、refresh requestが存在
- [x] 2. stagingでfile credential storeを強制し、credential取得・移管が可能
- [x] 3. managed login停止後にhost ownershipへ移管して利用可能
- [x] 4. token endpoint / request schema / client ID / rotationを確認（隔離profileで実測。公開external契約外）
- [x] 5. `experimentalApi: true`でexternal login / refresh contractが利用可能
- [x] 6. external token認証がprocess全体と別RPC接続へ反映
- [x] 7. account A → B → Aを再起動なしで切替可能
- [ ] 8. 401接続へのrefresh応答後に元requestが再試行（本番統合で検証）
- [x] 9. 全操作前後で`~/.codex/auth.json`のhash / mtimeが不変
- [ ] 10. 同じ`CODEX_HOME`の既存threadを切替後もresume可能（本番統合で検証）
- [x] 11. refresh server requestのtimeoutとRunner 8秒上限が安全

凡例: `[ ]`未確認、`[x]`合格、`[!]`不合格、`[-]`ユーザー操作待ち。

## 時系列ログ

- 2026-09-15: OpenAI公式App Server認証仕様を再確認。device-code、external token、約10秒のrefresh request契約を確認。
- 2026-09-15: 設計書、`AGENTS.md`、`docs/GIT-WORKTREE.md`を確認。既存Runner非停止、共有auth内容非読取、隔離実測の制約を確定。
- 2026-09-15: 進捗ファイルを作成。次は現行CLI / schema / transport / configをread-onlyで確認する。
- 2026-09-15: installed versionは`codex-cli 0.154.0`。隔離homeでexperimental schemaを生成し、`chatgptDeviceCode`、`chatgptAuthTokens`、`account/chatgptAuthTokens/refresh`、`experimentalApi`を確認。
- 2026-09-15: `chatgptAuthTokens`はschema上も`UNSTABLE`かつOpenAI内部向けと明記され、access tokenとaccount IDが必須。refresh requestは理由`unauthorized`とprevious account IDを受け、更新後のaccess tokenとaccount IDを返す契約。
- 2026-09-15: 秘密を出力しないstdioプローブを追加。`--strict-config`、file credential store、`experimentalApi: true`で初期化と`account/read`に成功し、空の隔離homeでは未ログインであることを確認。
- 2026-09-15: schema生成・初期化・account read後も通常CLI / VSCode側`auth.json`のsize、hash、mtime、modeは全て基準値から不変。内容は未読取。
- 2026-09-15: ユーザー承認を受領。新規隔離homeでdevice-codeを開始し、完了まではApp Server processを維持する。verification情報は進捗・ファイルへ保存しない。
- 2026-09-15: 隔離device-codeログイン完了通知は成功。App Server processは維持したまま、credentialの内容・構造には未アクセス。
- 2026-09-15: device-code完了後も通常CLI / VSCode側`auth.json`のsize、hash、mtime、modeは基準値から不変。内容は未読取。
- 2026-09-15: 完了通知を再確認後、登録processを正常停止してexitを待機。隔離homeは`0700`、file credentialは想定どおり隔離home直下の`auth.json`へ`0600`で保存された。
- 2026-09-15: 値を出さず構造だけ確認。トップレベルは`OPENAI_API_KEY`、`auth_mode`、`last_refresh`、`tokens`。`tokens`内は`access_token`、`account_id`、`id_token`、`refresh_token`で、必要項目は全て存在した。
- 2026-09-15: credentialは次のownership移管スパイク用に隔離home内で保持。削除試験とtoken本文の読取は未実施。
- 2026-09-15: 別の隔離App Serverへ`chatgptAuthTokens`をprocess内注入 → login accepted → `account/read`でchatgpt account確認。確認した対象の隔離`CODEX_HOME`直下には`auth.json`が生成されなかった。
- 2026-09-15: 承認済みの追加1回を実行。`gpt-5.6-luna` / effort `low`、指定どおりの最小prompt → `turn/completed` status=`completed` → agentMessageのexact `OK`を確認。注入先隔離`CODEX_HOME`直下に`auth.json`なし、process exit code=0。
- 2026-09-15: 通常CLI / VSCode側`auth.json`はsize `4273`、mtime、mode、sha256が前後不変。Bitty/Runnerは停止・再起動していない。
- 2026-09-16: 第2隔離device-code登録成功。保存済み隔離thread記録を本文非表示で分類し、3応答はbare label（A1/B1/A2）で、句読点不一致が前回ハーネスの原因と判明。A/B ID distinctは確認済み。ただし前回実行ではaccount/read identity比較を記録していないため、A→B→Aは未確定扱い。
- 2026-09-16: identity-onlyを同一App Serverで1回実行。A→B→Aすべてlogin accepted、account/read identity matched、external auth mode、profiles distinctを確認。再起動なしで切替成立。前回3turnのcompleted/bare label（A1/B1/A2）回収結果と合わせ、項目7を合格と判定。
- 2026-09-16: M1 canonical store/atomic save/owner lock/mutex/gate/refresh、M2 server-request contract、M3 device-code lifecycle/stdio transportを実装。関連自動テストを確認。
- 2026-09-16: M4 backend cutover（external注入、401 refresh handler、再起動なしswitch、App Server先行起動）とM5 rate-limit/Settings/status UIを実装。関連自動テストを確認。
- 2026-09-16: 両profileでrefresh HTTP 200、rotation、atomic saveを確認。片方はexternal login/account/model catalog（Luna・low）/thread/turn start後に`usageLimitExceeded`でfailed、もう片方はLuna/lowの最小turnがcompletedかつexact OK。送信失敗原因は認証ではなくusage limitと判定。

## 判定

* 総合: external token方式を採用し実装済み。隔離環境で注入、A→B→A、refresh/rotation、rateLimits、実送信を確認。
* 未実測: 本番統合での実401再試行、既存thread resume。
* 制約: 最後のactive profile削除は409。別profileへ切替後のみ削除可能。
* 残存リスク: experimental API、credential schema、OAuth endpoint依存。

## 次アクション（代案の判断）

1. 本番統合で実401再試行と既存thread resumeを検証
2. experimental API／schema／endpoint変更を監視
