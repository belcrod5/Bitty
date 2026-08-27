# Skiaボード データのランナー移行 設計書

状態: 設計構想（実装前・ブラッシュアップ中）
作成日: 2026-08-27
改訂: 2026-08-27 レビュー指摘(C-1, H-1, H-2, M-1〜M-5, L系)を反映

## 1. 目的

1. どのデバイスで開いても、Skiaボードが同じ状態で表示されるようにする
2. ボードの表示がドロワーの「5件ずつ読み込み」に依存している構造をなくし、配置済みカードを常に全件表示できるようにする

## 2. 現状整理（調査結果）

- 既読情報は最初からランナー側が正本（`acp_sessions.json` の `agentDirectoryReadStates` / `agentSessionReadStates`）。アプリはローカル保存していない。**今回の移行対象外**
- Skiaボードの配置情報だけがアプリローカルに残っている
  - 保存先: `${documentDirectory}bitty-settings.json` 内の `skiaBoardState` フィールド
  - 構造: `expo/src/features/app/utils/skiaBoardState.ts`
    - `cards`（session / file / directory カードとグリッド座標）
    - `sections`（枠のラベル・色・透明度）
    - `excludedSessionIds`（手動で外したセッション。自動再追加の防止）
    - `ingestedUpdatedAtMs`（自動取り込みのウォーターマーク）
    - `cardTextScale`（文字サイズ 0.8〜1.2）
- 新セッションの自動カード追加（ingest）はアプリ側で実行（`ingestSkiaBoardSessions`）。複数デバイスだと各端末が別々に追加し、位置衝突・二重追加の温床になる
- ボードのカード候補はドロワーのディレクトリツリー（`DIRECTORY_SESSION_PAGE_SIZE = 5` のページング済みウィンドウ）を流用しているため、未読み込みのセッションはカードの位置だけ残って非表示になる
- 設定画面のエクスポート機能は `skiaBoardState` を**含まない**（ボード配置は現状バックアップ対象外）

## 3. 方針: データの置き場所の区分

### ランナーへ移す（デバイス間で共有する）

- Skiaボード配置: `cards` / `sections` / `excludedSessionIds`
- 自動取り込みウォーターマーク `ingestedUpdatedAtMs`（自動追加処理ごとランナーへ移すため）
- ingest対象ディレクトリ `ingestDirectories`（各端末の登録ディレクトリの和集合。後述 6.1）

### アプリに残す（端末ごとに持つのが適切なもの）

- 接続先URL・Runner token・Cloudflare認証（Keychain）
- 音声（TTS/STT）・録音・自動化などの端末設定
- `registeredDirectories`（ドロワーの登録ディレクトリ。端末ごとの表示設定として残す）
- `cardTextScale`（文字サイズは画面サイズ依存の好みのため端末ローカルに変更。レビュー指摘L-3反映）
- ボードのカメラ位置・ズーム・選択状態（一時的なUI状態。永続化もしない現状を維持）
- セッションメッセージのキャッシュ（性能目的の端末キャッシュ）
- 直近取得したボードstateの読み取り専用キャッシュ（オフライン起動時の表示用。後述 8）

この区分により「共有すべきものはランナー、端末固有の設定はアプリ」に一本化され、管理は複雑化しない。

## 4. ランナー側ストア設計

### 4.1 ストアファイル

- パス: `private_runner/logs/skia_board_state.json`
- 既存JSON storeの共通イディオムを踏襲（メモリ常駐 + 遅延ロード、tmp→rename の原子的書き込み、直列化キュー、失敗時ロールバック、`version` フィールド）
- 参考実装: `src/push-device-store.mjs`（最小構成）、`src/codex-schedule-service.mjs`（revision 楽観ロック）

### 4.2 スキーマ（案）

```json
{
  "version": 1,
  "revision": 12,
  "origin": "import",
  "initializedAt": "2026-08-27T00:00:00.000Z",
  "updatedAt": "2026-08-27T00:00:00.000Z",
  "board": {
    "cards": [],
    "sections": [],
    "excludedSessionIds": [],
    "ingestedUpdatedAtMs": 0,
    "ingestDirectories": []
  }
}
```

- `board` の中身はアプリ側 `SkiaBoardState` を基本にするが、**セッションカードには `directory` と `backendId` を追加する**（スキーマ拡張）。現行カードは `sessionId` しか持たず、サマリ取得APIがディレクトリ単位のため、カード単独でランナーに問い合わせるにはこの2つが必要（レビュー指摘H-2反映）
- `revision` はストア全体の単調増加カウンタ。更新APIの楽観ロックと、他デバイスへの変更通知に使う
- `origin`: `"import"`（アプリからの引き継ぎで初期化）または `"ingest"`（ランナーの自動生成で初期化）。移行時の上書き事故防止に使う（後述 5.3、レビュー指摘C-1反映）

### 4.3 排他制御（複数デバイス同時編集）

- Codexスケジュールと同じ `baseRevision` 方式を踏襲
  - 更新リクエストに `baseRevision` を含める
  - 不一致なら `409 revision_conflict` + 現行stateを返す
  - アプリは最新stateを取り込み直して再適用（カード移動はセルの空き再計算で自動解決）
- 更新粒度は「ボード全体の置換」ではなく**操作単位の差分API**にする（後述 5.2）。全体置換だと2台同時編集で相手の変更を丸ごと消すため

## 5. API設計

認証はすべて既存ルートと同じ `Authorization: Bearer <RUNNER_TOKEN>`（`parseAuthToken` のパターン）を使う。

### 5.1 取得

- `GET /skia-board`
  - 返却: `{ revision, origin, board }`
- WSイベント: `board.updated { revision }` を全接続クライアントへ配信
  - 配信基盤は llm channel の `turn_completed_notification` と同じ「`runnerWsActiveClients` への全接続broadcast」パターンを使う（agent channel は runId 単位配信のため不適。レビュー指摘M-1反映）
  - 受信したアプリは `GET /skia-board` で再取得（イベントに全データは載せない。既存の「通知→再取得」パターンと同じ）
  - WS切断中の取り逃し対策として、再接続時とフォアグラウンド復帰時にも `GET /skia-board` を実行する（レビュー指摘M-3反映）

### 5.2 更新（操作単位の差分API）

- `POST /skia-board/ops`
  - body: `{ baseRevision, ops: [...] }`
  - op種別（アプリの既存操作を全列挙して1:1対応。レビュー指摘M-5反映）:
    - `moveCard { cardId, col, row }`
    - `addCard { card }` / `removeCard { cardId }`（removeはsessionカードなら `excludedSessionIds` へ追加）
    - `upsertSection { section }` / `removeSection { sectionId }`
    - `updateCardAppearance { cardId, displayNameOverride?, imagePath? }`
    - `renameFileCard { cardId, path, displayNameOverride }`
    - `setFileCardUnavailable { cardId, unavailable }`
    - `tidyCards {}` … **並び替え計算はランナー側で実行する**。クライアントが全カードの新座標を送る方式だと事実上のボード全置換になり、同時編集で相手の変更を消すため
  - 適用後 `{ revision, board }` を返す
  - 409（`revision_conflict`）時は現行の `{ revision, board }` を同梱して返す。既存のCodexスケジュール409（`{ error, revision }` のみ）からの意図的な逸脱で、再取得の往復を減らすため
- 連続ドラッグ中はアプリ側でデバウンスし、ドロップ確定時に1 opとして送る（通信量配慮。network-usage-reduction の方針と整合）

### 5.3 移行（初回アップロード）

- `POST /skia-board/import`
  - body: `{ board }`（アプリローカルの `skiaBoardState` 全体）
  - 受理条件（レビュー指摘C-1反映）:
    1. ランナー側ストアが未作成 → 受理し `origin: "import"` で初期化
    2. ストアが存在するが `origin: "ingest"`（ランナー自動生成のみで、ユーザー編集が入っていない）→ 受理して上書きし `origin: "import"` へ変更
    3. `origin: "import"`、または ingest 初期化後にユーザー編集opが入った → `409 already_initialized` + 現行stateを返す
  - 409を受けたアプリはランナー側を正として切り替えるが、**ローカルの `skiaBoardState` は破棄せず退避フィールド（例: `skiaBoardStateBackup`）へ移す**。手動復旧の余地を残す
  - これにより「アプリ更新が遅れた端末より先にランナーの自動生成が走り、ユーザーの配置が自動生成6枚に置き換わって失われる」事故を防ぐ

## 6. 自動カード追加（ingest）のランナー移管

- `ingestSkiaBoardSessions` 相当のロジックをランナーへ移す
- 処理: `updatedAt > ingestedUpdatedAtMs` かつ `excludedSessionIds` に無いセッションを空きセルへ追加し、`ingestedUpdatedAtMs` を前進、`revision` を上げて `board.updated` を配信
- **空ストアの自動初期化はしない**: 現行アプリ版ingestの「空なら最新6件で初期化」は、`origin: "import"` のストアが無い間は実行しない（5.3 の受理条件と対で、移行前のデータ喪失を防ぐ。レビュー指摘C-1反映）。移行が済んだ環境で新規にボードを使い始める場合のみ `origin: "ingest"` で初期化する
- 書き手がランナー1箇所になるため、二重追加・位置衝突が構造的に消える
- アプリ側の ingest コードは削除（下流パッチではなく発生源の一本化）

### 6.1 ingest対象ディレクトリ（レビュー指摘H-1反映）

- ランナーには「登録ディレクトリ」の正本が無いため、ボードストアに `ingestDirectories` を持たせる
- 各アプリは接続時に自端末の `registeredDirectories` を送り、ランナーは**和集合**でマージする（op: `syncIngestDirectories { directories }`）
- ドロワーの登録ディレクトリ自体は端末ローカルのまま（端末ごとに表示するディレクトリを変えられる現状を維持）。ボードの自動追加対象だけを共有する
- ディレクトリの削除はドロワー解除に連動させず、明示的な除去op（将来の設定UI）とする。自動連動させると「片方の端末で解除→全端末のボード追加が止まる」意図しない副作用が出るため

### 6.2 ingestトリガ（レビュー指摘M-2反映)

- 主トリガ: ランナー経由のターン完了・セッション作成イベント（relay / スケジュール実行 / agent run の既存3経路）
- 補完トリガ: `GET /skia-board` の処理時に ingest スイープを実行（ランナーを経由せずホスト上で直接CLIから作られたセッションを拾うため。ファイル監視は導入しない）
- スイープはセッション一覧の既存読み取りを流用し、`ingestedUpdatedAtMs` 以降の差分だけ見る（通信・IO増を抑える）

## 7. ボード表示の脱・ドロワー依存（5件制限の解消)

- セッションカードがスキーマ拡張で `directory` / `backendId` を持つため（4.2）、ボードはカードをディレクトリ単位にグループ化し、`POST /session-summaries`（既存API・`directory` 必須）でサマリ（タイトル・updatedAt・lastReadAt・contextUsedPct・modelRef）を取得する（レビュー指摘H-2反映）
- `SESSION_SUMMARY_MAX_IDS = 100` の制限に合わせ、ディレクトリごとに最大100件でバッチ分割する
- サマリの返却フィールドがカード表示・hydrationに足りるかは Step 2 実装前に洗い出し、不足があれば `session-summaries` 側に追加する（消費側での別API追い足しはしない）
- ドロワーの `directorySessionsById`（5件ページングウィンドウ）への依存を撤廃
- これにより「配置済みなのに読み込みウィンドウ外で非表示」が構造的に消える。ドロワー側の5件ページングはそのまま（ドロワーのUXは変更しない）

## 8. アプリ側の変更概要

1. `SkiaBoardContext` のデータソースをローカルファイル→ランナーAPIへ切替
   - 起動時: `GET /skia-board`（ランナー空なら `import` → 再取得）
   - 操作時: `POST /skia-board/ops`（楽観的にローカルstateへ即時反映し、409なら再取得して再適用）
   - `board.updated` 受信時: 再取得
2. オフライン時の扱い: 直近取得したボードstateを**読み取り専用ローカルキャッシュ**としてディスク保存し、コールドスタート時オフラインでも表示できるようにする（メモリのみだと起動直後に空になるため。レビュー指摘M-3反映）。編集はランナー接続時のみ。※ボードはランナーのセッションを表示する画面なので、オフライン編集の必要性は低い
3. `ingestSkiaBoardSessions` と `skiaBoardState` のローカル永続化コードを削除（移行完了後）
4. カード候補収集を `session-summaries` 直接取得へ変更（7章）

## 9. データ移行とバックアップ

### 9.1 移行フロー

1. アプリ更新後の初回接続時、ローカル `skiaBoardState` があれば `POST /skia-board/import`
2. 成功（またはランナー側が既に初期化済み）を確認したら、ローカルの `skiaBoardState` フィールドは読み取り対象から外す（即削除はせず、1リリース分は残して保険にする）

### 9.2 ユーザーによる事前バックアップ（実装着手前に依頼する手順）

- 設定画面のエクスポートは `skiaBoardState` を含まないため、**エクスポートだけではボード配置はバックアップできない**
- 依頼する手順:
  1. 設定画面の「設定をクリップボードへ書き出す」を実行し、テキストをメモ等へ保存（一般設定のバックアップ）
  2. 実装の最初のステップ（Step 0）として「エクスポート/インポートの両方で `skiaBoardState` を扱う」小修正を先行リリースし、その後にバックアップ→移行の順で進める
- Step 0 の実装注意（レビュー指摘M-4反映）: `skiaBoardState` はReact stateに無いため、エクスポート時は `readPersistedSettingsField` でディスクから読む。インポート側（`importSettingsJson` / `applyPersistedSettings`）にも復元経路を追加し、「書き出せるが戻せない」片道バックアップにしない

## 10. 実装ステップ（段階分割）

1. **Step 0（保険）**: 設定エクスポート/インポートで `skiaBoardState` を扱う小修正。ユーザーがバックアップを取得
2. **Step 1（ランナー）**: `skia_board_state.json` ストア + `GET /skia-board` + `POST /skia-board/ops` + `POST /skia-board/import` + `board.updated` イベント + テスト
3. **Step 2（アプリ）**: ボードのデータソース切替（ローカル→API）+ import による引き継ぎ
4. **Step 3（アプリ）**: `session-summaries` 直接取得への切替（5件制限解消）。Step 2 と分離して独立に検証する（レビュー指摘L-6反映）
5. **Step 4（ランナー）**: ingest 移管、アプリ側 ingest 削除
6. **Step 5（掃除）**: アプリのローカル永続化コード削除（1リリース置いてから）

各Stepは1ブランチ=1worktree=1PR。Step間は独立に検証可能。

## 11. リスク・留意点

- 同一 `logs/` を共有するRunnerの多重起動禁止は本ストアにも適用（既存運用のまま）
- worktree運用では `private_runner/logs` がmainへシンボリックリンクされるため、worktree検証でも本番のボードstateを共有する点に注意（検証時は誤操作でカードを消さない）
- `revision_conflict` 時の再適用でカード位置が僅かにずれる可能性（空きセル再配置）。同時編集は稀なので許容
- ファイルカード（`SkiaBoardFileCard`）の `rootDir`/`path` は端末非依存（ランナー上のパス）なのでそのまま共有可能
- 旧バージョンアプリが併存する期間は、旧端末のローカルingestが動き続けボードが二重管理になる。ただし旧端末はランナーストアを見ないため、実害が出るのは移行タイミングのみ（許容）
- 引き継ぎ元は「最初に接続した1台」だが、古い配置しか持たない端末が先に接続するリスクがある。移行案内では**普段使いのメイン端末から先に接続する**ことをユーザーに依頼する
