# Location-scheduled Codex progress

## 現在の状態

- 状態: 実装・自動テスト・iOS 実機ビルド／インストール・Runner 再起動検証済み
- Branch: `feat/location-scheduled-codex`
- Worktree: `/Volumes/SSD-500GB-SanDisk/work/bitty-worktree/feat/location-scheduled-codex`
- Base: `origin/main` at `a4d1ec54dbd4b81fd3df655fa8b01838ed288615`
- Implementation HEAD: `ada37002a6c35c5bc993d40e35364a9f3bbe86a6`
- Design: `docs/LOCATION-SCHEDULED-CODEX-DESIGN.md`
- 最終更新: 2026-07-19

実装は feature worktree 内で完結している。`origin/main` への merge、push、PR 作成はまだ行っていない。

## 確定した仕様

通常のチャットと GPS／時間発火は、入口だけが異なり、Runner 内の同じ Codex 実行境界を利用する。

```text
通常:       iOS chat -> Runner Codex execution -> LLM
GPS／時間:  iOS geofence state -> Runner condition -> Runner Codex execution -> LLM
```

- GPS／時間発火はチャット UI や現在開いているチャットスレッドを経由しない。
- 発火ごとに通常の新規 Codex thread を作り、設定済み prompt を user message として送る。
- ルール専用の長期 thread、専用 agent、sub-agent は作らない。
- model と reasoning effort は通常チャットと同じ値をルールに保存して実行時に渡す。
- cwd、時間帯、位置、半径、model、reasoning effort、prompt をルール単位で設定する。
- Runner は常時起動を前提とし、時間判定、重複防止、Codex 実行を担当する。
- iOS は連続 GPS 追跡ではなく region monitoring を使い、enter／exit と現在の inside／outside 状態だけを Runner に同期する。
- 同一ルール・同一時間枠では一度だけ実行する。
- 時間枠開始時に既に inside の場合と、時間枠内に enter した場合の両方を扱う。
- 境界付近の出入りが繰り返されても、Runner の永続 occurrence claim により同じ時間枠では再実行しない。

## 実装済み

### iOS

- `expo-location` と `expo-task-manager` によるバックグラウンド region monitoring。
- TaskManager task をアプリの top-level bootstrap で登録。
- Always／background location permission と `UIBackgroundModes=location` を Expo 設定へ追加。
- 最大 20 個の enabled region を完全 reconciliation。
- 初回登録・アプリ起動時に現在位置から initial inside／outside を計算。
- enter／exit をネットワーク送信前に永続化し、送れなかった状態を後から flush。
- 未送信状態をルールごとの最新値へ coalesce し、古い inside の後に新しい outside がある場合の誤発火を防止。
- 位置と半径だけから opaque な `regionRevision` を生成。
- 位置編集後に届いた古い region event／queue を iOS と Runner の双方で拒否。
- `bitty-settings.json` の既存 settings payload を共有し、location schedule 専用の二重 store は追加していない。
- settings の read／mutation を直列化し、background task と React 側の同時更新による部分書き込みを防止。
- 既存の directory-title modal 内に設定を統合し、通常チャットの directory／model／reasoning effort source を再利用。

主なファイル:

- `expo/index.ts`
- `expo/src/features/locationSchedules/LocationScheduleSettings.tsx`
- `expo/src/features/locationSchedules/locationScheduleRules.ts`
- `expo/src/features/locationSchedules/locationScheduleRuntime.ts`
- `expo/src/features/app/utils/persistedSettingsFile.ts`

### Runner

- bearer token 認証付き API を追加。
  - `GET /location-schedules`
  - `PUT /location-schedules`
  - `POST /location-schedules/state`
- schedule、last-known state、occurrence、実行結果を Runner 所有の JSON store に永続化。
- local timezone の日次 `[startTime, endTime)` window を評価。
- schedule／state sync、enter event、次の window start、Runner restart／recovery を評価入口として統合。
- occurrence key を永続化してから Codex を開始し、重複 event、再入場、API retry、Runner restart に対して at-most-once を保証。
- cwd、prompt、model、reasoning effort を必須検証し、通常チャット側の default へ黙って fallback しない。
- Runner store が存在しない場合だけ空で初期化。
- 既存 store が破損・不正な場合は上書きも実行もせず fail closed。
- store 利用不能時は schedule API が HTTP 503 `location_schedule_store_unavailable` を返し、入力不正の HTTP 400 と区別。
- current rule と state の `regionRevision` が一致しない限り発火しない。
- 通常の queued turn と schedule firing が同じ Codex RPC 実行処理を利用。
- schedule firing は内部 HTTP self-call を行わず、Runner 内で通常の新規 Codex thread を直接開始。

主なファイル:

- `private_runner/src/codex-turn-execution.mjs`
- `private_runner/src/location-schedule-service.mjs`
- `private_runner/src/server-runtime.mjs`

## 単純化の方針

この機能のためだけの実行系や会話概念は追加していない。

- schedule 専用 LLM executor を作らず、実際の Codex turn 実行境界を通常 turn と共有。
- ルール専用 thread／agent／sub-agent を作らず、発火ごとに普通の Codex thread を作成。
- Runner から Runner への localhost HTTP 呼び出しを作らず、同一プロセス内の実行境界を呼び出す。
- continuous location tracking を追加せず、iOS region monitoring に限定。
- iOS に schedule 専用 settings store を追加せず、既存 settings file を共有。
- `regionRevision` の計算責任は iOS の一箇所だけに置き、Runner は opaque token として比較。
- 時間・位置・重複実行の判断は UI や route に漏らさず、Runner の schedule service に集約。

## レビューで修正した重要事項

独立レビューを複数回行い、以下を上流側で修正した。

1. offline backlog に古い inside と新しい outside があるときの誤発火。
2. 位置編集後に遅延到着した旧 geofence event の受理。
3. model／reasoning effort 欠落時の暗黙 default。
4. Codex RPC が対応していない request idempotency field の送信。
5. background task と UI による settings file read／write race。
6. app bootstrap の未処理 rejection。
7. 破損 Runner store を空として再初期化し、occurrence claim を失う危険。
8. schedule edit と pending state flush が競合する revision race。
9. store 利用不能時の async GET handler rejection と Runner process crash の危険。
10. store 利用不能を validation error と同じ HTTP 400 で返す曖昧さ。

最終独立レビューでは、追加の actionable finding はなかった。

## Commit

実装は次の 5 commits に整理されている。

1. `3362ff5 docs: define location scheduled Codex design`
2. `56b34a4 feat: run Codex from location schedules`
3. `f303500 fix: harden location schedule state delivery`
4. `fe67c61 fix: fail closed on unsafe schedule state`
5. `ada3700 fix: report unavailable schedule store`

## 自動テストと静的検証

実装完了時に以下を確認した。

- Expo full Jest: 48 suites / 269 tests passed。
- Runner full tests: 168 total、167 passed、0 failed、既存 1 skipped。
- Runner location schedule focused tests: 13 / 13 passed。
- `npx tsc --noEmit`: passed。
- Expo `config --type prebuild`: passed。
- Expo `config --type introspect`: passed。
- introspection で `UIBackgroundModes: ["location"]` と location permission descriptions を確認。
- `git diff --check origin/main...HEAD`: passed。
- 新規 responsibility file はすべて 1,000 lines 未満。
- feature worktree は clean。

## 2026-07-19 実機・Runner 検証

### iOS build／install

正式な repository script を使用した。

```sh
./scripts/ios/build-expo-ios-device.sh
```

結果:

- Expo prebuild: succeeded。
- CocoaPods install: succeeded。
- `EXTaskManager 14.0.9` と `ExpoLocation 19.0.8` の組み込みを確認。
- scheme `Bitty`、configuration `Release`、arm64 device build: `BUILD SUCCEEDED`。
- device `00008120-000678181E07C01E` (`iPhone d5 14 Pro`) への install: succeeded。
- installed bundle id: `app.bitty.mobile`。
- script result: `[build-ios] Completed successfully`。

初回試行は端末が Xcode destination として利用できず timeout した。端末接続に依存しない Release／arm64 build でコードと署名を切り分けた後、正式 script を再実行し、最終的に build と実機 install の両方が成功した。

生成された app では次を確認した。

- code signing verification: passed。
- `UIBackgroundModes`: `fetch`, `location`。
- `NSLocationAlwaysAndWhenInUseUsageDescription`: 設定済み。
- `NSLocationWhenInUseUsageDescription`: 設定済み。

### Runner restart／smoke test

正式な repository script を使用した。

```sh
./private_runner/run-local.sh restart
./private_runner/run-local.sh status
```

最終結果:

- Codex app-server `http://127.0.0.1:4500/healthz`: healthy。
- Runner `http://127.0.0.1:8788/health`: healthy。
- Cloudflare tunnel: running／healthy。
- status result: `all targets look healthy`。
- bearer token 付き `GET /location-schedules`: HTTP 200。
- response: `ok=true`、現在の `ruleCount=0`。

`restart` は random `RUNNER_TOKEN` を更新する。実機から接続する前に必要なら次を実行し、QR を再読込する。QR 読込後に再度 restart すると token が再び変わるため注意する。

```sh
./private_runner/run-local.sh pairing-qr
```

## 未検証・残作業

コード、build、install、server process、schedule API までは検証済み。次は実環境での end-to-end 動作確認を行う。

1. 実機を最新 Runner token へ pairing。
2. 実機で位置情報を「常に許可」にし、Background App Refresh が有効であることを確認。
3. 検証用 rule を作成し、Runner の `GET /location-schedules` に同期されることを確認。
4. 時間枠開始時に既に region 内にいるケースを確認。
5. 時間枠内に region 外から内へ移動するケースを確認。
6. 境界付近で exit／enter を繰り返しても、同じ時間枠で Codex が一度だけ実行されることを確認。
7. アプリを background にした状態で geofence delivery と Codex execution を確認。
8. 発火後に通常の Codex thread として session index から確認できることを確認。
9. Runner restart 後も同じ occurrence が再実行されないことを確認。

iOS の region monitoring は background で利用できるが best effort である。ユーザーがアプリを明示的に force-quit した場合、位置情報権限や Background App Refresh が無効な場合、ネットワークに接続できない場合などは、イベントの即時配送を保証できない。この制約を continuous GPS で隠す実装は行っていない。

## Merge 前チェック

- 上記 end-to-end 実機確認の結果をこのファイルへ追記する。
- 必要なら Expo／Runner full test を merge 直前に再実行する。
- `git diff --check origin/main...HEAD` と worktree clean を再確認する。
- `docs/GIT-WORKTREE.md` に従い、ユーザーの明示承認後に merge／push／PR を行う。
