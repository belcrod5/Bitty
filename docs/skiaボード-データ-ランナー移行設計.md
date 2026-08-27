# Skiaボード データのランナー移行 設計書

状態: 設計構想（実装前・ブラッシュアップ中）
作成日: 2026-08-27

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

- Skiaボード配置: `cards` / `sections` / `excludedSessionIds` / `cardTextScale`
- 自動取り込みウォーターマーク `ingestedUpdatedAtMs`（自動追加処理ごとランナーへ移すため）

### アプリに残す（端末ごとに持つのが適切なもの）

- 接続先URL・Runner token・Cloudflare認証（Keychain）
- 音声（TTS/STT）・録音・自動化などの端末設定
- ボードのカメラ位置・ズーム・選択状態（一時的なUI状態。永続化もしない現状を維持）
- セッションメッセージのキャッシュ（性能目的の端末キャッシュ）

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
  "updatedAt": "2026-08-27T00:00:00.000Z",
  "board": {
    "cards": [],
    "sections": [],
    "excludedSessionIds": [],
    "cardTextScale": 1.0,
    "ingestedUpdatedAtMs": 0
  }
}
```

- `board` の中身はアプリ側 `SkiaBoardState` と同一構造（変換レイヤを作らず型を共有できる形にする）
- `revision` はストア全体の単調増加カウンタ。更新APIの楽観ロックと、他デバイスへの変更通知に使う

### 4.3 排他制御（複数デバイス同時編集）

- Codexスケジュールと同じ `baseRevision` 方式を踏襲
  - 更新リクエストに `baseRevision` を含める
  - 不一致なら `409 revision_conflict` + 現行stateを返す
  - アプリは最新stateを取り込み直して再適用（カード移動はセルの空き再計算で自動解決）
- 更新粒度は「ボード全体の置換」ではなく**操作単位の差分API**にする（後述 5.2）。全体置換だと2台同時編集で相手の変更を丸ごと消すため

## 5. API設計

### 5.1 取得

- `GET /skia-board`
  - 返却: `{ revision, board }`
- WSイベント: `board.updated { revision }` を全接続クライアントへ配信（agent channel の既存イベント基盤に相乗り）
  - 受信したアプリは `GET /skia-board` で再取得（イベントに全データは載せない。既存の「通知→再取得」パターンと同じ）

### 5.2 更新（操作単位の差分API）

- `POST /skia-board/ops`
  - body: `{ baseRevision, ops: [...] }`
  - op種別（アプリの既存操作と1:1）:
    - `moveCard { cardId, col, row }`
    - `addCard { card }` / `removeCard { cardId }`（removeはsessionカードなら `excludedSessionIds` へ追加）
    - `upsertSection { section }` / `removeSection { sectionId }`
    - `setCardTextScale { value }`
    - `setDisplayNameOverride { cardId, value }` などカード属性更新
  - 適用後 `{ revision, board }` を返す
- 連続ドラッグ中はアプリ側でデバウンスし、ドロップ確定時に1опとして送る（通信量配慮。network-usage-reduction の方針と整合）

### 5.3 移行（初回アップロード）

- `POST /skia-board/import`
  - body: `{ board }`（アプリローカルの `skiaBoardState` 全体）
  - **ランナー側ストアが未作成（空）のときだけ受理**。既にあれば `409 already_initialized` を返し、アプリはランナー側を正としてローカルを破棄
  - これにより複数デバイスが順に接続しても、最初の1台だけが引き継ぎ元になり、上書き事故が起きない

## 6. 自動カード追加（ingest）のランナー移管

- `ingestSkiaBoardSessions` 相当のロジックをランナーへ移す
- トリガ: セッションの updatedAt 更新をランナーが検知したタイミング（ターン完了・セッション作成時）。ポーリング不要
- 処理: `updatedAt > ingestedUpdatedAtMs` かつ `excludedSessionIds` に無いセッションを空きセルへ追加し、`ingestedUpdatedAtMs` を前進、`revision` を上げて `board.updated` を配信
- 書き手がランナー1箇所になるため、二重追加・位置衝突が構造的に消える
- アプリ側の ingest コードは削除（下流パッチではなく発生源の一本化）

## 7. ボード表示の脱・ドロワー依存（5件制限の解消)

- ボードは自分のカードの `sessionId` リストを使い、`POST /session-summaries`（既存API）で直接サマリ（タイトル・updatedAt・lastReadAt・contextUsedPct）を取得する
- ドロワーの `directorySessionsById`（5件ページングウィンドウ）への依存を撤廃
- これにより「配置済みなのに読み込みウィンドウ外で非表示」が構造的に消える。ドロワー側の5件ページングはそのまま（ドロワーのUXは変更しない）

## 8. アプリ側の変更概要

1. `SkiaBoardContext` のデータソースをローカルファイル→ランナーAPIへ切替
   - 起動時: `GET /skia-board`（ランナー空なら `import` → 再取得）
   - 操作時: `POST /skia-board/ops`（楽観的にローカルstateへ即時反映し、409なら再取得して再適用）
   - `board.updated` 受信時: 再取得
2. オフライン時の扱い: ボードは閲覧のみ（最後に取得したstateをメモリ表示）。編集はランナー接続時のみ。※ボードはランナーのセッションを表示する画面なので、オフライン編集の必要性は低い
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
  2. ボード配置は、実装前にランナー側で `logs/` 一式をコピー…では守れない（アプリ内データのため）。よって実装の最初のステップとして「エクスポートに `skiaBoardState` を含める」小修正を先行リリースし、その後にバックアップ→移行の順で進める

## 10. 実装ステップ（段階分割）

1. **Step 0（保険）**: 設定エクスポートに `skiaBoardState` を含める小修正。ユーザーがバックアップを取得
2. **Step 1（ランナー）**: `skia_board_state.json` ストア + `GET /skia-board` + `POST /skia-board/ops` + `POST /skia-board/import` + `board.updated` イベント + テスト
3. **Step 2（アプリ）**: データソース切替（ローカル→API）+ import による引き継ぎ + `session-summaries` 直接取得（5件制限解消）
4. **Step 3（ランナー）**: ingest 移管、アプリ側 ingest 削除
5. **Step 4（掃除）**: アプリのローカル永続化コード削除（1リリース置いてから）

各Stepは1ブランチ=1worktree=1PR。Step間は独立に検証可能。

## 11. リスク・留意点

- 同一 `logs/` を共有するRunnerの多重起動禁止は本ストアにも適用（既存運用のまま）
- worktree運用では `private_runner/logs` がmainへシンボリックリンクされるため、worktree検証でも本番のボードstateを共有する点に注意（検証時は誤操作でカードを消さない）
- `revision_conflict` 時の再適用でカード位置が僅かにずれる可能性（空きセル再配置）。同時編集は稀なので許容
- ファイルカード（`SkiaBoardFileCard`）の `rootDir`/`path` は端末非依存（ランナー上のパス）なのでそのまま共有可能
