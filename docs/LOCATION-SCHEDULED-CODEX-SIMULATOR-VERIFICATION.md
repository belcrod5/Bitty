# Location-scheduled Codex simulator verification

## この指示書の目的

`feat/location-scheduled-codex` の位置・時間実行を、iOS Simulator と常時起動中の Runner を使って end-to-end 検証する。

対象 worktree:

```text
/Volumes/SSD-500GB-SanDisk/work/bitty-worktree/feat/location-scheduled-codex
```

メインリポジトリではなく、必ずこの worktree 内のコードとスクリプトを使うこと。検証中に不具合を見つけても、その場で仕様を変えたり回避実装を追加したりせず、再現条件、期待値、実測値、関連ログを先に報告すること。

## 結論: Simulator でどこまで検証できるか

今回の主要な機能経路は Simulator で検証できる。

```text
iOS simulated location
  -> Expo geofence / background TaskManager
  -> Runner state API
  -> time-window evaluation / occurrence claim
  -> ordinary Codex thread
  -> LLM
```

Simulator は座標を固定または経路として変更でき、Maestro は iOS アプリを background にできる。そのため、次は今回の合否判定に使える。

- ルール設定と Runner への同期。
- 時間枠開始時に既に region 内にいる場合の発火。
- 時間枠内に region 外から内へ入った場合の発火。
- アプリが background の間の geofence event と Runner への同期。
- exit / enter を繰り返しても同一時間枠で一度しか実行されないこと。
- 発火ごとに専用agentではなく、通常の新規 Codex thread が作られること。
- 設定した cwd、model、reasoning effort、prompt が使われること。
- Runner 再起動後も同じ occurrence が再実行されないこと。

ただし Simulator だけでは、次を保証できない。

- 実機の GPS、Wi-Fi、基地局を組み合わせた測位精度。
- 実機の省電力・メモリ圧迫・Background App Refresh の影響を受けた配送時間。
- 半径境界付近での実機固有の揺れ方や、200m 未満の geofence の信頼性。
- ユーザーがアプリを明示的に force-quit した後の挙動。
- 再起動後、初回unlock前の挙動。

したがって今回の Simulator 検証は「アプリと Runner の機能経路が正しい」ことの E2E 確認には向いているが、「実機でイベントが必ず時間どおり届く」ことの保証には使わない。

## 先に読む資料

1. `maestro/README.md`
2. `docs/LOCATION-SCHEDULED-CODEX-DESIGN.md`
3. `docs/LOCATION-SCHEDULED-CODEX-PROGRESS.md`
4. この指示書

## 検証時の固定条件

再現性とプライバシーのため、実際の自宅・職場座標は使わず、次の公開地点をテスト座標にする。

```text
region center / inside: 35.681236,139.767125
outside:                35.690921,139.700258
radius:                 200m
```

outside は境界直外ではなく十分離れている。Core Location の region event は境界通過直後に届くとは限らないため、各移動後は最大 60 秒待つ。5m 程度の疑似的な揺れではなく、まず十分離れた座標で enter / exit が実際に Runner へ届くことを確認する。

検証用 prompt は副作用を起こさない一意な文字列にする。`<run-id>` は実行開始時刻などで置き換える。

```text
シミュレーター検証です。ファイル変更やコマンド実行はせず、LOCATION_SCHEDULE_SIM_OK_<run-id> だけを返してください。
```

設定値:

- cwd: この worktree、または Runner がアクセスできる既存の検証用 directory。
- model: 通常チャットで選択できる `GPT 5.6 Sol`。
- reasoning effort: `high`。
- radius: `200`。
- time zone: Simulator の現在の time zone。原則 `Asia/Tokyo`。

## 準備

### 1. worktree と Runner を確認する

```sh
cd /Volumes/SSD-500GB-SanDisk/work/bitty-worktree/feat/location-scheduled-codex
git status --short --branch
./private_runner/run-local.sh status
```

Runner が healthy なら、最初の検証前に不要な restart はしない。`restart` は `RUNNER_TOKEN` を更新し、Simulator 側の既存pairingを無効にするためである。Runner が unhealthy の場合だけ次を使う。

```sh
./private_runner/run-local.sh restart
./private_runner/run-local.sh status
```

### 2. iOS development build と Metro を起動する

Expo Go では iOS background TaskManager を検証できない。`maestro/README.md` の手順どおり development build を使う。

Terminal A:

```sh
cd /Volumes/SSD-500GB-SanDisk/work/bitty-worktree/feat/location-scheduled-codex/expo
npx expo run:ios --device "iPhone 17 Pro" --no-bundler
```

Terminal B:

```sh
cd /Volumes/SSD-500GB-SanDisk/work/bitty-worktree/feat/location-scheduled-codex/expo
npx expo start --dev-client --localhost --port 8081
```

既存 smoke flow でアプリが起動できることを先に確認する。

```sh
cd /Volumes/SSD-500GB-SanDisk/work/bitty-worktree/feat/location-scheduled-codex
./scripts/maestro/run-ios-simulator.sh
```

`maestro/flows/ios-smoke.yaml` は起動確認用であり、位置・時間実行の合否を確認する flow ではない。必要なら別の一時 flow を作り、既存scriptへ引数として渡してよい。機能検証のためだけに production code や汎用wrapperを追加しないこと。

### 3. Simulator UDID と位置操作を確認する

```sh
xcrun simctl list devices booted
```

以下の `<udid>` は同じ booted Simulator の UDID へ置き換える。

```sh
xcrun simctl location <udid> set 35.690921,139.700258
```

Maestro flow 内で変更する場合は、同等の `setLocation` command を使ってよい。移動経路が必要な場合は `xcrun simctl location <udid> start ...` も使えるが、今回の合否には固定座標の切り替えで十分である。

### 4. Runner 接続を確認する

Simulator の既存設定で Runner 接続が成功するならそのまま使う。再pairingが必要な場合、QRやtokenをスクリーンショット、Maestro flow、report、shell引数へ残さない。

Simulator のcamera経由のQR読取が使えない場合は、development build の `Current Settings` debug画面で次を対話的に設定できる。

- Aux Server URL: `http://127.0.0.1:8788`
- Codex WS URL: `ws://127.0.0.1:8788/runner-ws`
- Runner Token: 現在の `private_runner/logs/runner-token`
- Codex WS Token: 同じtoken

token は画面やログへ出力せず、必要ならmacOS clipboardへ直接読み込んで手動pasteする。

```sh
pbcopy < private_runner/logs/runner-token
```

設定後、debug画面の接続probeまたは通常チャットの短いturnで Runner / Codex 接続が成功することを確認する。

### 5. 位置権限を確認する

最初のルール有効化時に、foreground に続いて background / Always の位置権限が要求されることを確認する。許可後、Simulator の設定で Bitty の位置情報が「常に」に相当する状態であることを確認する。

権限dialog自体の確認を一度終えた後、Simulator の権限状態だけが不安定な場合は次で明示的に許可してよい。

```sh
xcrun simctl privacy <udid> grant location-always app.bitty.mobile
```

このcommandは実行中のappを終了させる場合があるため、実行後はBittyを起動し直す。また、権限説明や要求処理の不具合を隠し得るため、最初から権限UIの検証を省略する目的では使わない。

## 観測方法と合否の根拠

画面表示だけで合否を決めない。Runner の永続storeを主な観測点にする。

```text
private_runner/logs/location_schedules.json
```

確認対象:

- `rules`: Simulator で保存したルールが1件あり、座標、半径、cwd、model、reasoning effort、時間帯が一致する。
- `states[ruleId]`: `outside` / `inside` と `observedAt` が移動に応じて更新される。
- `occurrences`: 同一時間枠の occurrence が一つだけ存在する。
- completed occurrence: `status=completed` で `threadId` と `turnId` が空でない。
- failure: `status=failed` の場合は `errorMessage` を記録し、成功扱いしない。

storeにはpromptが含まれるため、ファイル全体をreportやチャットへ貼らない。必要なfieldだけを抽出する。生成された `threadId` が `private_runner/logs/cli_sessions_index.json` またはアプリの通常session一覧に現れ、検証markerへの応答を持つ通常の Codex thread であることも確認する。

background 検証では、アプリをforegroundへ戻す前に Runner storeを確認する。foreground復帰時のbootstrap / pending flushで初めて状態が届いた場合は、background delivery成功と判定しない。

## 必須シナリオ

各シナリオで、開始前後の時刻、Simulator座標、ルールID、state、occurrence status、threadIdを記録する。token、Cloudflare credential、prompt全文は記録しない。

### A. 設定同期と初期 outside

1. Simulator を outside 座標へ設定する。
2. Bitty で対象directoryのメニューから `位置・時間実行` を開く。
3. ルールを追加し、半径、cwd、model、high、検証promptを設定する。
4. 現在時刻を含む、終了まで5分以上ある時間枠を設定する。
5. ルールを有効化して保存する。
6. Runner storeを確認する。

合格条件:

- ruleがRunnerへ同期される。
- stateが`outside`になる。
- outsideのままでは active window 内でも completed occurrence が作られない。
- 権限拒否やRunner接続失敗を成功として閉じない。

### B. background中の enter と通常thread生成

シナリオAのルールをそのまま使い、時間枠がactiveな間に行う。

1. Maestro の `pressKey: home` または同等操作でBittyをbackgroundへ移す。
2. Bittyをforegroundへ戻さない。
3. Simulatorをinside座標へ変更する。
4. 最大60秒待ち、Bittyをforegroundへ戻す前にRunner storeを確認する。
5. occurrenceがcompletedになった後、通常session indexとLLM応答を確認する。

合格条件:

- BittyがbackgroundのままRunner stateが`inside`へ変わる。
- active window内でoccurrenceが一つ作られ、最終的に`completed`になる。
- `threadId`と`turnId`が空でない。
- 通常sessionとして発見でき、応答に一意な検証markerがある。
- ルール専用の継続threadやsub-agentではなく、新規の通常threadである。

60秒以内に届かない場合は直ちに実装不良と断定しない。Simulator位置が有効か、Always権限か、app processがbackgroundか、時間枠がactiveかを確認してから、実測待ち時間とログをfailure reportへ残す。

### C. exit / re-enterの重複防止

シナリオBで一度completedになった同じルール・同じ時間枠を使う。

1. Simulatorをoutsideへ移し、Runner stateが`outside`になるまで最大60秒待つ。
2. insideへ戻し、Runner stateが`inside`になるまで最大60秒待つ。
3. 可能ならもう一度 outside -> inside を繰り返す。
4. occurrencesと通常session数を確認する。

合格条件:

- state transitionはRunnerへ届く。
- 同じ occurrence key は一つだけである。
- completed threadIdは変わらない。
- Codex thread / LLM実行が追加されない。

これはアプリ側で境界揺れを推測するテストではなく、複数の確実なenterが届いてもRunnerの永続occurrence claimが重複実行を止めることのテストである。

### D. 時間枠開始時に既にinside

新しいルールIDで行う。既存ルールはUIから無効化または削除する。

1. Simulatorをinside座標へ設定する。
2. 開始を現在から2分後、終了を開始から5分後にした新規ルールを保存する。
3. 保存直後のRunner stateが`inside`で、開始前にはcompleted occurrenceがないことを確認する。
4. Bittyをbackgroundへ移す。
5. 開始時刻を越えて最大90秒待つ。
6. Bittyをforegroundへ戻す前にRunner storeを確認する。

合格条件:

- 開始前には発火しない。
- 新しいenter eventがなくても、Runnerの時刻評価で開始後に一度発火する。
- completed occurrenceに通常threadId / turnIdがある。

### E. Runner restart後のat-most-once

tokenが変わるため、このシナリオは最後に行う。

1. completed occurrenceの数、occurrence key、threadIdを記録する。
2. Simulatorはinside、時間枠はactiveのままにする。
3. 正式scriptでRunnerをrestartする。

```sh
./private_runner/run-local.sh restart
./private_runner/run-local.sh status
```

4. Runner起動後90秒待つ。
5. location schedule storeとsession indexを確認する。

合格条件:

- restart前のoccurrenceが保持される。
- 同じ時間枠で新しいoccurrence / Codex threadが作られない。
- store破損や空初期化が起きない。

restart後に追加のiOS検証を続ける場合だけ、Simulatorを新しいtokenへ再pairingする。

## 任意の探索シナリオ

必須シナリオが通った後に限り、次を探索してよい。

- Maestro `killApp` でsystem-initiated process deathを作り、次のgeofence eventでiOSがappを再起動してRunnerへ同期できるか。
- ルール変更直後に古い`regionRevision`のeventが拒否されるか。
- network切断中にoutside -> inside -> outsideを作り、復旧後に最新outsideだけが同期されるか。
- 半径を100m未満にした場合の警告UI。

ただし `killApp` は実機でユーザーが行うforce-quitと同一ではない。任意シナリオの成功をforce-quit保証として報告しない。

## 失敗時に切り分ける順序

1. RunnerとCodex app-serverがhealthyか。
2. SimulatorのRunner URL / tokenが現在のRunnerと一致しているか。
3. development buildであり、Expo Goではないか。
4. `location-always`権限があるか。
5. Simulatorの現在位置が意図したinside / outsideか。
6. ruleがenabledで、Runner storeのruleと`regionRevision`が一致しているか。
7. Simulatorとruleのtime zone、および`[startTime,endTime)`がactiveか。
8. 同じoccurrenceが既にclaimedされていないか。
9. appをforegroundへ戻す前にstateが届いたか。
10. LLM失敗の場合、location経路ではなくcwd / model / Codex接続の失敗ではないか。

原因を切り分けるためにproduction codeへdebug API、schedule専用executor、強制発火fallbackを追加しない。

## 完了報告フォーマット

別エージェントは次を含むMarkdown reportを作成し、ファイル名と保存先を報告する。

```text
検証日時:
worktree / commit:
Simulator model / iOS version / UDID:
development build result:
Metro result:
Runner health:

A. 設定同期と初期outside: PASS / FAIL / BLOCKED
根拠:

B. background enterと通常thread: PASS / FAIL / BLOCKED
根拠:

C. exit / re-enter重複防止: PASS / FAIL / BLOCKED
根拠:

D. inside-at-window-start: PASS / FAIL / BLOCKED
根拠:

E. Runner restart後at-most-once: PASS / FAIL / BLOCKED
根拠:

任意シナリオ:
未検証範囲:
発見した不具合:
保存したvideo / screenshot / Maestro output / 最小化したRunner観測結果:
```

PASSには、画面上の印象ではなくRunner state、occurrence、threadId / turnId、通常sessionの根拠を添える。秘密値やstore全文は添付しない。失敗時は、再現手順、期待値、実測値、最初に期待と異なった観測点を明記する。

## 参考資料

- Maestro: [setLocation](https://docs.maestro.dev/reference/commands-available/setlocation)
- Maestro: [pressKey](https://docs.maestro.dev/reference/commands-available/presskey)
- Expo: [Location / Background location](https://docs.expo.dev/versions/latest/sdk/location/)
- Expo: [TaskManager](https://docs.expo.dev/versions/v54.0.0/sdk/task-manager/)
- Apple: [Simulating location in tests](https://developer.apple.com/documentation/xcode/simulating-location-in-tests)
- Apple: [Region Monitoring and iBeacon / Testing](https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/LocationAwarenessPG/RegionMonitoring/RegionMonitoring.html)
