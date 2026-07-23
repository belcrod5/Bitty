# 引き継ぎ: ワークスペースファイル編集機能 + 位置スケジュール鮮度対策 (2026-07-19)

worktree: `/Volumes/SSD-500GB-SanDisk/work/bitty-worktree/feat/location-scheduled-codex`(ブランチ `feat/location-scheduled-codex`)

このセッションで実装した4機能と、位置スケジュールの実機調査・根本対策の記録。
位置スケジュール機能そのものの設計は [LOCATION-SCHEDULED-CODEX-DESIGN.md](LOCATION-SCHEDULED-CODEX-DESIGN.md) を参照。

## コミット一覧(このセッション分、いずれも未push)

| コミット | 内容 |
| --- | --- |
| `43ea05c` | ファイルエクスプローラから .txt/.md のテキスト編集 |
| `fd20f8b` | ディレクトリ長押しから新規ファイル作成 |
| `378aa50` | 位置スケジュール設定にマップピッカー(react-native-maps) |
| `395f30a` | window開始前のサイレントpush鮮度確認 + マップピッカーのピン消失修正 |

親ブランチ側の直近: `5452b38`(バックグラウンド信頼性改善)、`61e37d5`(turn完了通知のモジュール分離)は push 済み。

---

## 1. テキストファイル編集(.txt / .md)

**フロー**: チャット画面 → git差分数タップ → 右ドローワー → ファイルエクスプローラ → ファイル長押し → コンテキストメニュー「編集」→ 全画面エディタ(読込→編集→保存)。チャット本文中のファイルリンク長押しでも同メニューが出る。

### Runner 側
- `private_runner/src/workspace-files.mjs`
  - `writeTextFile({rootDir, path, content, expectedVersion})`: **既存ファイル限定**の上書き保存。読込時の内容ハッシュと一致しない場合は409で拒否。一時ファイル(`.<name>.write-<uuid>.tmp`)に書いて `fs.rename` する原子的書き込み。元ファイルの mode を保持。root 外パス・シンボリックリンクは `path_invalid` で拒否(既存の `resolveFilePath` を共用)。サイズ上限は `maxUploadBytes`(既定25MB)共通
  - ルーティング: `GET /workspace/files`で本文とversionを読み、`PUT /workspace/files`(JSON body `{rootDir, path, content, expectedVersion}`)で保存。`parseMutationRequest` の body 上限は PUT のみ `maxBytes + 64KB`(PATCH/DELETE は従来16KB)
- `private_runner/src/server-runtime.mjs:8667` 付近: `/workspace/files` の許可メソッドに PUT を追加
- 読み込みも `workspace-files.mjs` に集約し、切り詰めず上限超過を413で返す

### Expo 側
- `expo/src/features/app/utils/workspaceFiles.ts`: `writeWorkspaceTextFile()`(PUT、タイムアウト60秒)
- `expo/src/features/app/components/WorkspaceTextFileEditor.tsx`(新規): 全画面 Modal エディタ。読込中スピナー、dirty 時のみ保存可、未保存で閉じると破棄確認 Alert、monospace フォント
- `expo/src/features/app/hooks/useWorkspaceFileMutations.ts`: `editTarget / requestEdit / cancelEdit / writeFileContent` を追加。保存後 `refreshAfterMutationWithAlert` で **git 差分数も自動更新**
- `expo/src/features/app/utils/runnerFileContextMenu.ts`: `isRunnerEditableTextFile()`(拡張子 txt/md)、`onRequestEdit` パラメータ、「編集」ボタン(`allowMutate` 時のみ)
- 配線: `GitDiffPanel.tsx`(エクスプローラ)と `ChatScreen.tsx`(ファイルリンク)の両方

## 2. 新規ファイル作成(ディレクトリ長押し)

**フロー**: エクスプローラのディレクトリ長押し → メニュー先頭「新規ファイル作成」→ ファイル名入力 → 空ファイル作成 → **.txt/.md ならそのままエディタが開く**(他拡張子は作成のみ)。

- Runner: `createTextFile({rootDir, targetDirectory, fileName, content=""})` = `saveFile` の `allowEmpty: true` 版。`PUT /workspace/files` に `create: true` を付けて呼ぶ。既存ファイルは 409 `file_exists`
- Expo: `createWorkspaceTextFile()`、フックに `createFileDirectory / requestCreateFile / cancelCreateFile / createFile`
- `WorkspaceFileRenameDialog` を汎用化(`title` / `submitLabel` prop 追加)して作成ダイアログにも流用

## 3. マップピッカー(位置スケジュール設定)

- `react-native-maps@1.20.1` を追加(Apple マップ、APIキー不要)。`pod install` 済み
- `expo/src/features/locationSchedules/LocationMapPicker.tsx`(新規): タップでピン設置、半径円プレビュー、初期位置は設定済み座標(未設定なら現在地、それも無理なら東京駅)。「決定」で緯度経度を反映
- `LocationScheduleSettings.tsx`: 「現在地を使用」の隣に「マップで選択」ボタン

### 修正済みバグ: ピンが一瞬出て消える(実機報告)
原因: 親(`LocationScheduleSettings`)の再レンダーごとに `mapPickerTarget` オブジェクトが再生成され、ピッカーの `useEffect([target])` が再実行されて座標が元値にリセットされていた。
対策(両側):
1. 親: `useMemo`(deps は `mapPickerRuleId`)で参照を安定化
2. ピッカー: `openedRef` で「閉→開の遷移時のみ初期化」するガード
**実機での再確認は未実施**(ビルドはインストール済み)。

## 4. 位置スケジュール: サイレントpush鮮度確認(根本対策)

### 実機調査の経緯(2026-07-19、いずれもJST)
- **16:31 の発火疑義**: iOS ジオフェンス(16:31:46 inside)とアプリ測位(16:31:06 recover, changed=0)の2系統が独立に「圏内」判定 → 発火は正当。半径100mは測位誤差と同レベルなので200m以上推奨
- **18:20 の誤発火(本題)**: 18:07:52 フォアグラウンドで「圏内」→ ユーザーは車で10km以上移動 → iOS の exit イベントは **18:55:46 まで届かず** → 18:20 の window 開始時に Runner は13分前の stale な「圏内」で発火してしまった。15分定期タスク(BGTaskScheduler)もこの間実行されず(iOS任せで保証なし)
- 教訓: バックグラウンド起床自体は機能する(18:55の exit はバックグラウンドで受信)。問題は **window開始時点の状態の鮮度**

### 実装した対策
window開始時、最終状態が古ければサイレントpushで端末に現在地を再報告させてから発火判定する。

Runner (`private_runner/src/location-schedule-service.mjs`):
- 定数: `STATE_FRESH_MS = 3分`, `STATE_REFRESH_TIMEOUT_MS = 90秒`, リクエスト記録の保持 6時間
- `claimEligibleRules`: 対象ルールの `observedAt` が3分より古い場合、claim せず `staleRules` に積んで `stateRefreshRequests`(in-memory Map, occurrenceKey→requestedAtMs)に記録。次回以降の evaluate で
  - 新しい inside 報告が来た → 即発火(recordState → evaluate 経由)
  - 新しい outside 報告が来た → 発火しない
  - 90秒経過しても報告なし → **従来どおり最終状態で発火**(圏外・電源断など端末が応答できないケースで実行を取りこぼさないためのフォールバック)。evaluate はタイマーで毎分実行なので、実際の遅延は最大約2分
- `requestStateRefresh` はオプション注入。未指定(push無効環境)なら鮮度ゲート自体が無効=従来動作
- `server-runtime.mjs`: `requestStateRefresh` の実装 = 全登録デバイスへ APNs サイレントpush `{aps:{"content-available":1}, bitty:{type:"location_state_refresh"}}`、`pushType: "background"`, `priority: 5`

Expo (`expo/src/features/locationSchedules/locationScheduleRuntime.ts`):
- タスク `bitty-location-state-refresh-push` を `TaskManager.defineTask`(モジュールスコープ)+ `Notifications.registerTaskAsync` で登録(ルール有効時。`reconcileLocationRefreshTask` 内)
- ペイロードに `location_state_refresh` マーカーが含まれる場合のみ `recoverLocationScheduleState("silent_push")` を実行(ペイロード形状がOS/バージョンで揺れるため JSON.stringify での包含判定)
- `UIBackgroundModes` に `remote-notification` を追加(`expo/ios/Bitty/Info.plist` 直編集 + 将来の prebuild 用に `expo/app.json` の `ios.infoPlist` にも)

### 診断ログ(runner の `logs/client_auto_logs/*.jsonl`、source=`location_schedule`)
| イベント | 意味 |
| --- | --- |
| `location_push_refresh_fired` | サイレントpushで起床し再報告した(新規) |
| `location_push_refresh_task_error` / `location_push_refresh_task_register_failed` | 同タスクの失敗(新規) |
| `location_geofence_task_fired` | ジオフェンスイベント受信(state/identifier付き) |
| `location_refresh_task_fired` | 15分定期タスク実行 |
| `location_recover_ran` | 起動/復帰/push時の現在地照合(origin, changed付き) |

## 検証状態

| 項目 | 状態 |
| --- | --- |
| Runner テスト | workspace-files 10/10、location-schedule 15/15(鮮度ゲート2件新規)。全体は main と同じ既知の環境起因9件のみ失敗 |
| Expo | `tsc --noEmit` クリーン、jest 48スイート269件パス |
| 実機ビルド | `395f30a` 時点の Release ビルドをインストール済み(iPhone d5 14 Pro) |
| Runner | トークン引き継ぎで再起動済み・新コード稼働中 |
| **未検証(実地)** | ①サイレントpush鮮度確認の実動作(`location_push_refresh_fired` をログで確認) ②マップピッカーのピン修正 ③アプリを開かない境界横断での自然なジオフェンス起床 |

## 運用手順・ハマりどころ

- **実機ビルド**: `cd expo/ios && xcodebuild -workspace Bitty.xcworkspace -scheme Bitty -configuration Release -destination 'platform=iOS,id=00008120-000678181E07C01E' -derivedDataPath build/claude-device-build DEVELOPMENT_TEAM=E3W35HZ355 build`
  - expo prebuild は署名チームを誤選択(U8SYKSPD98)するので走らせない。チームは **E3W35HZ355** 固定
  - インストール: `xcrun devicectl device install app --device 6A85B2F2-C1CA-597C-A955-3803E0CD572F <path>/Bitty.app`(UDID指定だとタイムアウトすることがある。`xcrun devicectl list devices` の UUID を使う。デバイスロック中/Wi-Fi切断中は失敗)
- **Runner 再起動(トークン維持)**: `RUN_LOCAL_RUNNER_TOKEN="$(cat private_runner/logs/runner-token)" ./private_runner/restart.sh` — これで再ペアリング不要。素の `restart` はトークンが変わり再ペアリングになる
- **active window 中のルール保存**: この引き継ぎ作成時は当日分を `skipped_edited_active_window` で封鎖していたが、現在は保存直後から通常の初回発火判定対象になる。圏内なら同期状態で発火し、圏外なら次の enter を待つ
- サイレントpushの制約: ユーザーがアプリスイッチャーから強制終了した端末には配送されない(iOS仕様)。その場合は90秒タイムアウト→従来動作
- Runner のストア/ログ: `private_runner/logs/location_schedules.json`(rules/states/occurrences)、`private_runner/logs/client_auto_logs/`(端末診断)

## 次アクション候補
1. 実地検証(上記「未検証」3点)。移動を伴うテスト時にログを確認
2. 問題なければ push → PR(ユーザー承認後)
3. 任意: 診断ログに座標・精度を含める(測位誤差問題の切り分け用)、半径のデフォルト/推奨値の見直し(現100m→200m)
