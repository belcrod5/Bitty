# 引き継ぎ: 位置・時間実行デモ録画(買い物リストシナリオ)

作成日: 2026-07-19 / worktree: `/Volumes/SSD-500GB-SanDisk/work/bitty-worktree/feat/location-scheduled-codex`(ブランチ `feat/location-scheduled-codex`、`2568012` まで実装済み・push済み)

## ゴール

iOS Simulator で以下のユーザーストーリーを通しで録画する。

1. 「買い物リスト」ディレクトリのチャットで **ChatGPT 5.6 Luna / low** に今夜の晩御飯を相談し、食材の買い物リストの Markdown ファイルを作らせる
2. 位置・時間実行を設定する: ロサンゼルスの有名スーパーを**マップピッカー**で選択し、時間帯・モデル・プロンプト(そのファイルを参照して買い物を促す)を設定
3. シミュレーターの**仮想移動**でスーパーに到着 → ルール発火 → 通知表示 → Codex が買い物リストを提示する画面を見せる

制約・割り切り(ユーザー了承済み):
- 移動は実移動不可なので `simctl location` による仮想移動でよい
- 通知は実APNs不要。**`simctl push` で仮想的に表示すればよい**(シミュレーターには実APNsは届かない)

## 非ゴール

- 実機検証・測位精度の検証(済み/別管理。`HANDOFF-2026-07-19-WORKSPACE-EDITING-AND-LOCATION-FRESHNESS.md` 参照)
- production コードの変更。録画のためにデバッグAPIや強制発火を追加しない

## シナリオ素材(そのまま使ってよい)

- **晩御飯テーマ**: タコスナイト(LAらしい)。チャット相談で別メニューが提案されたらそれでもよい
- **食材例**: トルティーヤ / 牛挽肉 500g / アボカド 2個 / トマト / 紫玉ねぎ / シラントロ / ライム / チェダーチーズ / サルサ / サワークリーム
- **スーパー**: Whole Foods Market(Santa Monica, 500 Wilshire Blvd)
  - 中心座標(inside): `34.0187, -118.4933`、半径 `200` m
  - 出発点(outside): Santa Monica Pier `34.0101, -118.4965`(約1km離れており境界揺れの心配なし)
- **モデル**: 「ChatGPT 5.6 Luna」(value `gpt-5.6-luna`)、思考レベル `low`
- **Scene 1 のチャット例**:
  1. 「今夜の晩御飯なにがいいと思う？」
  2. 「いいね、それでいこう。必要な食材の買い物リストを `買い物リスト.md` としてこのディレクトリに作成して」
- **ルールのプロンプト例**: 「`買い物リスト.md` を読んで、その内容を買い物リストとして提示し、ユーザーに買い物をするようリマインドしてください。」
- **仮想通知の payload 例**(`push-payload.json`):
  ```json
  {
    "aps": {
      "alert": {
        "title": "Bitty",
        "body": "Whole Foods Market に到着しました。今夜の買い物リストをご確認ください 🛒"
      },
      "sound": "default"
    }
  }
  ```

## 初期設定タスク(録画前に完了させる)

1. **Runner 稼働確認**: `./private_runner/run-local.sh status`(worktree 内で実行)。healthy なら**再起動しない**。再起動が必要な場合のみ `RUN_LOCAL_RUNNER_TOKEN="$(cat private_runner/logs/runner-token)" ./private_runner/restart.sh` — 素の restart はトークンが変わり全デバイス再ペアリングになる(実機も切れるので厳禁)
2. **Runner ストアのバックアップ**(実機の既存ルール保護の保険): `cp private_runner/logs/location_schedules.json private_runner/logs/location_schedules.backup-demo.json`
   - アプリの保存はルール一覧全体を同期するが、アプリは開いた時に Runner から既存ルールを読み込むため、**既存ルールを消さずデモルールを追加**すれば実機ルールは保持される。念のためのバックアップ
3. **Simulator 起動 + アプリビルド**: 録画品質のため Release 推奨(dev メニュー・警告オーバーレイが出ない、Metro 不要)
   ```sh
   cd expo && npx expo run:ios --configuration Release --device "iPhone 17 Pro"
   ```
   - `expo prebuild`(特に `--clean`)は走らせない(ios プロジェクト直編集分が消える)。`run:ios` は既存 ios/ を使うので可
   - UDID 取得: `xcrun simctl list devices booted`
4. **Runner とペアリング**: アプリの `Current Settings` デバッグ画面で対話設定
   - Aux Server URL: `http://127.0.0.1:8788` / Codex WS URL: `ws://127.0.0.1:8788/runner-ws`
   - Token: `pbcopy < private_runner/logs/runner-token` で clipboard 経由。**トークンを画面・ログ・レポートに残さない**
   - 短いチャット1往復で接続確認
5. **権限**: 位置情報(ルール有効化時に foreground→Always の順で要求される。ダイアログで許可)、通知許可。権限状態が不安定なときのみ `xcrun simctl privacy <udid> grant location-always app.bitty.mobile`(app が落ちるので再起動)
6. **デモ用ディレクトリ**: ワークスペースルート(= この worktree ルート)配下に `買い物リスト` を作成し、アプリのディレクトリエクスプローラで「このディレクトリを登録」
7. **初期位置を LA に設定**(マップピッカーの初期表示が LA になり見栄えが良い): `xcrun simctl location <udid> set 34.0101,-118.4965`
8. **リハーサル**: 下記シーンを一度通しで流し、発火まで確認してから本番録画する

## 録画タスク(シーン分解)

録画は `xcrun simctl io <udid> recordVideo --codec h264 demo-scene<N>.mov`(Ctrl+C で停止)。シーンごとに分割録画し、後で結合するのが安全。

- **Scene 1 — 晩御飯相談とファイル作成**
  1. 「買い物リスト」ディレクトリのチャットを開き、モデル `ChatGPT 5.6 Luna`・think `low` を選択(フッターの選択UIを映す)
  2. 上記チャット例の2往復。`買い物リスト.md` が作成されるのを待つ
  3. git差分数 → 右ドローワー → ファイルエクスプローラで `買い物リスト.md` を開いて中身を見せる(今回実装したビューア/編集画面のアピールポイント)
- **Scene 2 — 位置・時間実行の設定**
  1. ディレクトリメニューから「位置・時間実行」を開く → 「ルールを追加」
  2. 「マップで選択」→ (初期位置がLA付近) Whole Foods Market にタップでピン → 決定。半径 `200`
  3. 時間帯: **開始 = 現在時刻の2〜3分後**、終了 = +30分(当時は active window 中の保存を当日分から封鎖していたため未来開始にした。現在は active window 中の新規作成・編集も当日から有効)
  4. ディレクトリ `買い物リスト` / モデル `ChatGPT 5.6 Luna` / 思考レベル `low`(新しいコンパクトなプルダウンを映す)、プロンプトに上記ルールプロンプト(キーボードに隠れず入力できる修正済み挙動も自然に映る)
  5. 有効化 → 保存(位置権限ダイアログが出たら許可)
- **Scene 3 — 仮想移動(到着)**
  1. アプリをホームに戻す(バックグラウンド化)
  2. 時間窓が開始したのを確認してから `xcrun simctl location <udid> set 34.0187,-118.4933`(スーパーに到着)
  3. geofence enter → アプリがバックグラウンドで Runner に inside を報告 → 新鮮な状態なので鮮度ゲートを通過し即発火する。発火確認は `private_runner/logs/location_schedules.json` の occurrence が `completed`(threadId あり)になること
  - 演出オプション: 到着前に Apple Maps を開いて現在地が動くのを見せる
- **Scene 4 — 通知と結果**
  1. ホーム画面のまま `xcrun simctl push <udid> app.bitty.mobile push-payload.json` で通知バナーを表示(発火確認後に打つ)
  2. 通知をタップ → Bitty 起動 → セッション一覧に新規スレッド → 開いて「買い物リスト提示+リマインド」の応答を見せて終了

## ハマりどころ・注意

- **鮮度ゲート**: window 開始時に位置状態が3分より古いとサイレントpush確認 → シミュレーターには届かず **90秒(実質最大約2分)待ってから**フォールバック発火する。Scene 3 のように「window 開始後に enter イベントを起こす」流れなら新鮮な報告で即発火し、この待ちは発生しない。逆に「先に inside にしてから window 開始を待つ」構成にする場合は、開始3分前以降にアプリを一度フォアグラウンドにして状態を新鮮にしておくこと
- enter イベントは座標変更後最大60秒程度かかることがある。録画は発火・通知のタイミングを確認したリハーサル後に
- 実機(ユーザーの iPhone)も同じ Runner に接続しているため、デモ中に実機へ push が飛ぶ可能性があるが実害なし。**実機の既存ルールを消さない**ことだけ厳守
- シミュレーターのタイムゾーンは Mac と同じ(Asia/Tokyo)。ルールの時刻は JST でそのまま設定してよい
- トークン・Cloudflare 資格情報・store 全文をレポートや動画に映さない(`Current Settings` 画面を録画に含めない)

## 後片付け

1. シミュレーター側アプリでデモルールを削除して保存(実機ルールは残す)
2. `買い物リスト` ディレクトリと `買い物リスト.md` を削除(git 管理外だが worktree 直下にあるため)
3. バックアップと突き合わせて `private_runner/logs/location_schedules.json` に実機ルールが残っていることを確認。万一消えていたら: Runner 停止 → バックアップを書き戻し → `RUN_LOCAL_RUNNER_TOKEN="$(cat private_runner/logs/runner-token)" ./private_runner/restart.sh`
4. 録画ファイルの保存先をユーザーへ報告

## 参考

- シミュレーター検証の詳細手順(ペアリング・権限・観測方法): `docs/LOCATION-SCHEDULED-CODEX-SIMULATOR-VERIFICATION.md`
- 機能全体の実装状況・診断ログ一覧: `docs/HANDOFF-2026-07-19-WORKSPACE-EDITING-AND-LOCATION-FRESHNESS.md`
- 設計: `docs/LOCATION-SCHEDULED-CODEX-DESIGN.md`
