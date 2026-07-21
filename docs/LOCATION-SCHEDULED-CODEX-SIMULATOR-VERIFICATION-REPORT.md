# Location-scheduled Codex simulator verification report

> This report records an earlier engineering verification run with GPT-5.6 Sol
> and High reasoning. It is not the final recorded submission demo, which uses
> GPT-5.6 Luna with Low reasoning as documented in `DEVPOST.md`.

検証日時: 2026-07-19 09:00〜10:37 JST
worktree / commit: `/Volumes/SSD-500GB-SanDisk/work/bitty-worktree/feat/location-scheduled-codex` / `ec52a6ab8a39772cb92bea5c593d58e5ad6b4e80` (`feat/location-scheduled-codex`)
Simulator model / iOS version / UDID: iPhone 17 Pro / iOS 26.2 / `23B43EC5-37D1-488B-A4F7-CF6971E39E1A`
development build result: `npx expo run:ios --device "iPhone 17 Pro" --no-bundler` → Build Succeeded、`app.bitty.mobile` install 成功
Metro result: `npx expo start --dev-client --localhost --port 8081` → packager-status:running(検証終了時点も稼働中)
Runner health: `./private_runner/run-local.sh status` → all targets look healthy(codex app-server / runner / cloudflared)

検証座標は指示書どおり inside `35.681236,139.767125`、outside `35.690921,139.700258`、半径 200m。
検証ルール設定: cwd `/Volumes/SSD-500GB-SanDisk/work/bitty-public`、model `ChatGPT 5.6 Sol`(`openai-codex/gpt-5.6-sol`)、reasoning effort `high`、time zone `Asia/Tokyo`。

## シナリオ結果

### A. 設定同期と初期 outside: PASS

根拠:

- Simulator を outside に設定し、UI(directory メニュー → 位置・時間実行)からルールを作成・有効化・保存。
- Runner store `private_runner/logs/location_schedules.json` に rule が同期された(`rule_1784420509236_39778`、09:00–12:00 → のち 10:06–11:30 に変更、座標・半径 200・cwd・`openai-codex/gpt-5.6-sol`・`high` が一致)。
- 保存後の初期状態計算により `states` が `outside`(eventId `initial:…`)で登録され、`regionRevision` が rule と一致。
- outside のままでは active window 内でも completed occurrence は作られなかった。
- 位置権限は foreground/background とも要求されるが、Simulator では権限ダイアログが表示されず(後述の発見事項 2)、指示書のフォールバックに従い `xcrun simctl privacy grant location-always app.bitty.mobile` で付与した。

補足(仕様確認): active window 中に新規作成/編集された rule の当該 window は `skipped_edited_active_window` として封鎖される(編集直後の即時発火防止)。このため B 以降は「window 開始前に保存し、開始後に条件を満たす」形で検証した。

### B. background enter と通常 thread: PASS

根拠:

- ルールの window を 10:06–11:30 に変更して保存(保存時は window 未開始のため skip されない)。
- 10:04:33 に `pressKey: home` で Bitty を background 化。以降 foreground へ戻さずに実施。
- 10:06:23 に Simulator を inside 座標へ変更。
- 10:06:26 観測の geofence enter が Runner に届き(`states` = `inside`)、10:06:27 に occurrence 作成 → 10:06:32 に `completed`(所要約5秒)。アプリは background のまま。
- threadId `019f77e9-05b8-7432-b74d-cd03ecd97f20` / turnId `019f77e9-061d-…` とも非空。
- `~/.codex/sessions/2026/07/19/rollout-2026-07-19T10-06-27-019f77e9-05b8….jsonl` に通常の新規 Codex thread として存在。turn_context は `model: gpt-5.6-sol` / `effort: high`、cwd はルール設定値。ルール専用 thread や sub-agent ではない。
- agent 応答は検証 marker `LOCATION_SCHEDULE_SIM_OK_20260719T0915` のみ。

### C. exit / re-enter 重複防止: PASS

根拠:

- 同じ rule・同じ window(10:06–11:30)で outside → inside を2周実施。
- 1周目: 10:08:40 outside 設定 → state `outside`(観測 10:08:48)、10:09:45 inside 設定 → state `inside`(観測 10:10:00)。
- 2周目: exit の配送が遅延(観測 10:12:55 の exit が 10:15:45 受信)したが最終的に到達し、re-enter も 10:21:02 までに state `inside` として到達。
- 複数回の確実な enter が Runner へ届いたにもかかわらず、occurrence は同一 key 1件のまま `completed` を維持し、threadId は `019f77e9-05b8…` から不変。
- Codex セッションファイルも当該時間帯は1件のまま増加なし。

### D. inside-at-window-start: PASS

根拠:

- 既存ルールを UI から削除し、新ルール `rule_1784424190630_98998`(10:33–10:38、同座標・200m・`gpt-5.6-sol`・`high`)を inside 状態で 10:32:40 に保存・同期。
- 保存直後の state は `inside`(eventId `initial:…`)で、開始前に completed occurrence が無いことを確認。
- 10:33:18 に background 化(以降 foreground に戻さず store を確認)。
- 新しい enter event は発生していない(state の eventId は `initial:` のまま)状態で、Runner の時刻評価により window 開始時刻ちょうど(01:33:00.035Z)に occurrence が作られ、01:33:03 に `completed`。
- threadId `019f7801-5110-74a1-a719-7ead9e3dbfcb` / turnId 非空。session ファイルの turn_context は `gpt-5.6-sol` / `high`、応答は marker `LOCATION_SCHEDULE_SIM_OK_D_20260719T1022` のみ。

### E. Runner restart 後 at-most-once: PASS

根拠:

- restart 前(10:34:50): occurrence 総数4、completed 2件(threadId `019f77e9-05b8…` / `019f7801-5110…`)、Codex セッション 10 時台 2件。
- Simulator は inside、window 10:33–10:38 が active のまま `./private_runner/run-local.sh restart` を実行(10:34:53 healthy)。
- restart 後 90 秒経過時点(10:36:34、window はまだ active): occurrence 総数4のまま、completed 2件の threadId・updatedAt が不変、rules / states も保持。新しい occurrence / Codex thread は作られていない。
- store の破損・空初期化は発生していない。

## 任意シナリオ

未実施(killApp による process death、位置編集直後の旧 regionRevision 拒否、network 切断中の coalesce、半径 100m 未満の警告 UI)。

## 未検証範囲

- 実機の測位精度・省電力・Background App Refresh の影響・force-quit 後の挙動・再起動後 unlock 前の挙動(指示書どおり Simulator では対象外)。
- 位置権限ダイアログの UI 表示(Simulator では表示されなかったため。発見事項 2)。
- ディレクトリ/モデル/思考レベルの Picker ホイール操作(Maestro で操作困難なため、rule のデフォルト継承で設定。model/effort は事前にアプリ現在値を `gpt-5.6-sol` / `high` にして継承させた。reasoning effort は一度 `low` で作成されたルールを設定ファイル編集で `high` に修正しており、思考レベル Picker 自体の UI 操作は未検証)。
- prompt は入力安定性のため指示書テンプレートと同旨の英語文で代替(marker 文字列は一意)。

## 発見した不具合・事象

1. **Runner token 不一致(401)時、位置ルール保存が busy のまま完了せず、エラー表示も出ない。**
   - 再現条件: アプリの Runner Token が現在の Runner と不一致の状態で、位置・時間実行のルールを有効化して保存。
   - 期待値: 保存失敗として「位置・時間実行を保存できません」等のエラー表示、busy 解除。
   - 実測値: 保存スピナーが数分以上表示され続け、Alert なし。`PUT /location-schedules` の TCP 接続は開始から約6秒後に cancel され、応答がアプリ側で処理された形跡がない(Runner は同一 payload の curl に 11ms で応答)。app 再起動まで UI 操作不能。
   - 付記: token 正常化後は同じ保存操作が数秒で完了するため、機能経路自体の問題ではない。401 経路のハンドリング(fetch が resolve しない/エラーが握り潰される)を確認する価値がある。
2. **iOS Simulator で位置権限プロンプトが表示されず、保存フローが権限待ちで進まない。**
   - 再現条件: 位置権限未付与の Simulator で enabled ルールを保存(`reconcileLocationSchedules` が `requestForegroundPermissionsAsync` を呼ぶ)。
   - 期待値: foreground → background 権限のシステムダイアログが順に表示される。
   - 実測値: ダイアログは表示されず保存が完了しない。`simctl privacy grant location-always` 付与後は全フロー正常。実機では権限フローが機能することを実機検証(2026-07-19 progress 参照)で確認済みのため、Simulator 固有事象の可能性が高いが、1 の 401 事象と同時に発生していたため単独の切り分けは未実施。
3. **仕様メモ(不具合ではない)**: active window 中のルール新規作成・編集は当該 window を `skipped_edited_active_window` にする。UI にはこの旨の説明がないため、「今の時間帯に合わせてルールを作ったのに発火しない」という誤解が起き得る。UX 改善候補。

## 検証環境ノート(Maestro)

- 本アプリの UI には testID が無く、directory メニュー modal は accessibility 上1要素に flatten されるため、項目タップは point 指定が必要。
- Maestro `eraseText` はカーソル後方の文字を消せず、`inputText` は稀に文字を欠落させる(経度の小数点が2回連続で欠落)。Runner Token の投入は自動化が安定せず、最終的に手動ペーストで設定した(token は flow・レポート・ログに残していない)。
- token が混入した Maestro debug ログ(`.maestro-home/.maestro/tests/`)と診断用ファイルは検証後に削除済み。

## 保存した成果物

- 本レポート(このファイル)。
- Runner store の検証前バックアップ: セッション scratchpad `location_schedules.backup-20260719-082832.json`(実機で作成された既存ルール1件を含む。今回の検証で Runner store は Simulator のルールに置き換わっている)。
- 発火した通常 thread: `019f77e9-05b8-7432-b74d-cd03ecd97f20`(B)、`019f7801-5110-74a1-a719-7ead9e3dbfcb`(D)。
- video / screenshot は token 写り込み防止のため保存していない。

## 検証後の状態・要フォローアップ

- シナリオ E の restart で `RUNNER_TOKEN` が更新されたため、**Simulator・実機とも既存 pairing は無効**。実機で継続利用するには `./private_runner/run-local.sh pairing-qr` で再 pairing が必要。
- Runner store のルールは Simulator 検証用ルール(10:33–10:38、東京駅座標)に置き換わっている。実機の元ルールを戻す場合は実機アプリから再保存する(バックアップは上記 scratchpad)。
- Metro(port 8081)と Simulator は起動したまま。
