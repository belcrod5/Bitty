# オーケストレータ活動表示：実装記録

最終更新（2026-10-05）：後続の実機確認でアプリ起動、セッションカードの活動アイコン、グロー演出を確認済み。カードは小さく、初回は表示を見落としていた。
虹色の 500 ms 回転とグローの 1.5 秒脈動は自動テスト済み。最新の 1.5 秒脈動の実機での見た目は未確認。以下は実装途中の時点ごとの記録。

状態: 製品コードと指定スキルの変更、関連自動テスト、独立レビュー完了。main マージは未完了。

目的は既存のオーケストレーションの見える化。CLI が実行元を自動付加し、Runner が親オーケストレータと活動を解決して、既存通信でカードと固定表示へ渡す。認証、承認、実行方法、接続寿命は維持する。

## 外部スキルの変更

指定された原本に以下のレビュー済み変更を適用済み。repo 内へスキルのコピーや配布基盤は作っていない。変更前の原本との SHA-256 一致を確認して適用した。

```diff
--- /Users/daigo-nakamura/.codex/skills/bitty-session-orchestrator/scripts/bitty-session.mjs
+++ /Users/daigo-nakamura/.codex/skills/bitty-session-orchestrator/scripts/bitty-session.mjs
@@ -62 +62,3 @@
-    headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
+    headers: { authorization: `Bearer ${token}`,
+      ...(process.env.CODEX_THREAD_ID ? { "x-bitty-display-caller": process.env.CODEX_THREAD_ID } : {}),
+      ...(init.body ? { "content-type": "application/json" } : {}) },
@@ -90 +92,3 @@
-  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
+  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}`,
+    ...(process.env.CODEX_THREAD_ID ? { "x-bitty-display-caller": process.env.CODEX_THREAD_ID } : {}),
+  } });
--- /Users/daigo-nakamura/.codex/skills/bitty-session-orchestrator/SKILL.md
+++ /Users/daigo-nakamura/.codex/skills/bitty-session-orchestrator/SKILL.md
@@ -8,0 +9,2 @@
+
+For Bitty operations, use this CLI and the existing `bitty-history` CLI for history. Preserve the normal environment when invoking them or native subagents; both CLIs attach `CODEX_THREAD_ID` automatically for activity display. Do not pass caller or parent IDs manually. Native subagents use the registered parent orchestrator icon. Wait for delegated work before finishing when its live activity needs to remain visible. Missing caller information does not prevent the operation, but the display cannot identify its orchestrator.
```

原本の `node --check`、実 CLI の HTTP/WS 関数を fake 通信に接続した実行元 ID 有／無の 4 経路は成功。既存 Bearer と出力を保持し、`CODEX_SESSION_ID` を実行元に誤用しないことを確認。常用 Runner／provider への通信は行っていない。

`skill-creator` の `quick_validate.py` は通常実行では PyYAML が未導入のため起動できなかった。新しい依存を入れず、既存 Node YAML parser を `safe_load` に接続して同じ validator を実行し成功。

## 製品テストとレビュー

親エージェントの製品コード回帰確認（仕上げ中の追加変更以前）:

```sh
node --test private_runner/tests/orchestrator-activity.test.mjs private_runner/tests/agent-transport.test.mjs private_runner/tests/agent-runtime.test.mjs private_runner/tests/agent-workspace-admission.test.mjs private_runner/tests/voice-context-service.test.mjs private_runner/tests/voice-orchestrator-service.test.mjs private_runner/tests/skia-board-endpoint.test.mjs private_runner/tests/conversation-history-cli.test.mjs
```

145 成功、0 失敗、0 skip、約 52.9 秒。voice の応答、承認、既読・未読、履歴、既存 board・transport と最初の活動テストを含む。後続修正箇所は、最終の関連テストを別途実行する。

最新 UI の親エージェント確認:

```sh
cd expo
npm test -- --runInBand src/features/app/hooks/useOrchestratorActivities.test.tsx src/features/app/screens/SkiaMiniBoardScreen.test.tsx src/features/app/components/VoiceOrchestratorIcon.test.tsx
```

3 suites、60 成功、0 失敗、約 2.1 秒。担当の `npm run typecheck` / `npm run typecheck:macos` は両方成功。切断と再接続、古い通知、並行活動、カード／global 配置、登録画像更新・不正画像の fallback、Skia 画像の回収、既存未読保持を検証した。実機 Skia の描画やパン／ズームの体感はこの mock renderer テストでは証明しない。

`node --check private_runner/src/server-runtime.mjs` / `node --check private_runner/bin/bitty-history` と `git diff --check` は成功。最終の追加修正に関係する Runner 確認:

```sh
node --test private_runner/tests/orchestrator-activity.test.mjs private_runner/tests/agent-transport.test.mjs private_runner/tests/agent-runtime.test.mjs private_runner/tests/skia-board-endpoint.test.mjs
node --test private_runner/tests/conversation-history-cli.test.mjs
```

前者は親の最終実行で 33 成功（新規活動テスト 13 件を含む）、0 失敗、約 1.2 秒。後者 5 成功。表示用登録の失敗、親探索中の通知順、実際のローカル HTTP socket abort、他の活動を残した期限回収、root 終了後も target run が親アイコンとツール表示を保持すること、短い run の replay を検証した。常用 Runner は起動・停止していない。voice の実行開始前に登録されることと、その後の既存接続の解放は先述の voice 回帰テストで確認した。

担当による製品 module の fixture 測定: 1 階層の親照合は 1 RPC。単活動の snapshot は実行中 250 bytes、終了時 252 bytes、登録画像は含まない。実 RPC の所要時間、実機パン／ズーム負荷や多量の同時活動での配送負荷の測定ではない。

別エージェントの製品差分・外部スキル・テスト確認結果は **APPROVE**。Critical / High / Medium の未解決指摘はない。認証、承認、実行エンジン、root 接続寿命、既存 run observer の変更はなく、活動は単一メモリ管理から既存 WebSocket に配送する。新しい認証 API、永続 store、設定、依存、接続 pool は追加していない。


## 確認が残る範囲

実機 Skia の画像・右上配置・固定表示・パン／ズームの体感と、常用 Runner を使った製品全体のライブ配送は未確認。root が子の結果を待たずに終了した場合、接続寿命を延ばさないため、残った native 子の継続観測は保証せず、既に観測した未終了ツールは状態不明として終了させる。一方、開始済み target run の観測は既存 Agent Service を通じて実 run 終了まで維持する。

実行元は登録 Codex root と通常環境を継ぐ native 子の既存 CLI 経路。経路外の独立 CLI や Claude caller の帰属は今回の対象外。未登録の実行元は誰かのアイコンを代用せず表示しない。履歴本文や既存利用者の会話はこの作業で読んでいない。

## 実機確認の入口

`.env` と依存ディレクトリを準備し、iOS workspace は main から build・利用者設定・署名関連ファイルを除外した rsync で worktree に準備済み。常用 logs は既存の main への symlink を維持し、Runner token を変更していない。最初の依存初期化は expo の npm cache 権限で失敗したため、既存依存の利用へ戻して初期化確認に成功。不要な package/lock 内容変更はない。

```sh
cd /Volumes/SSD-500GB-SanDisk/work/bitty-worktree/docs/orchestrator-activity-test-plan
./private_runner/restart-keep-token.sh --mode full
./scripts/ios/build-expo-ios-device.sh
```

ボードの個別セッション取得・会話で右上、一覧・全体操作で固定位置、native 子に親のアイコン、ツール呼び出しの状態が表示されることを確認する。パン／ズームで固定表示が動かないことと、既存操作を邪魔しないことも確認する。コマンドはユーザー検証用で、エージェントは再起動とビルドを実行していない。

## 実機起動時の Hermes 修復

ユーザーの初回 iPhone ビルドは画面表示前、Hermes 初期化中に `EXC_BAD_ACCESS` で終了した。生成されたアプリの React は 0.81.6 Release、Hermes は 0.81.6 Debug（UUID `B670DC88-9C32-323A-AD5D-AF6735FCA0EF`）だった。main からコピーされた `Pods/.last_build_configuration` は古い `Release` のままで、後の pod install が Debug 実体へ更新したため、React Native の置換スクリプトが Release ビルドでも Hermes の切り替えを省略した。

`bootstrap-local.sh` は Expo prebuild に `--no-install` を指定して Pod 更新を既存の `ensure_ios_pods` に集約した。初回 native workspace コピー時は Pod 更新を必ず行い、更新前または Manifest が marker より新しい時に RN の 3 種の configuration marker を空にする。次の xcodebuild が要求した Debug / Release の実体を選択する。Pod install が失敗しても古い `Release` 判定は残らない。Pods 全消去や依存追加はしていない。

隔離した shell fixture の `bash scripts/worktree/test-bootstrap-ios-native.sh` と `bash -n` は成功。コピー直後、既存の古い marker、正常な cache hit、pod install 失敗を確認した。親エージェントは実際の RN 0.81.6 置換スクリプトと両 Hermes archive を一時ディレクトリで実行し、古い marker では Debug UUID が残り、空 marker では Release UUID `DC7E3016…` に変わり、Debug 要求なら Debug UUID になることを確認した。アプリ再ビルド後の実機起動は未確認。

## 実機カード表示の切り分け

再ビルド後の iPhone ではアプリが起動し、音声オーケストレーターの全体アイコンと native ツール状態は表示されたが、既存「テストA」セッションカードには活動アイコンが付かなかった。読み取り専用の board / sessions 応答で、このカードと送信先の backend およびセッション ID は一致した。native ツール表示は CLI の実行元ヘッダー到着とは別経路なので、現時点で送信活動の実行元欠落と親解決失敗を区別できない。

既存 `RUNNER_LOG_REQUESTS` が有効な場合に限り、活動管理の HTTP / WS 開始、親照合結果、native 開始を記録する。内容、認証情報、完全なセッション ID は記録せず、backend と妥当な ID の先頭 8 桁だけを残す。診断は表示以外の処理を変更しない。実機の再試行とログ照合後に原因を確定し、不要な診断行は整理する。

隔離した欠落 caller・親不明・正しい対象・logger 障害の試験を含め、親エージェントの `node --test private_runner/tests/orchestrator-activity.test.mjs private_runner/tests/agent-transport.test.mjs` は 26 成功、0 失敗、0 skip。manager / server の `node --check` と `git diff --check` も成功。別エージェントの診断差分レビューは **APPROVE**。実機再試行前なので根因とカード表示の改善は未検証。
