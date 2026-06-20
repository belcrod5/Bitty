Git Worktreeを使用したサブエージェント開発手順書

1. 目的

ユーザーから受けた修正指示ごとに、専用ブランチと専用worktreeを作成し、サブエージェントに安全に作業させる。

次のサイクルを標準化する。

ユーザー指示
→ 指示内容の確認
→ ブランチ・worktree作成
→ サブエージェントによる実装
→ テスト
→ コミット
→ push
→ Pull Request作成
→ 別エージェントによるレビュー
→ ユーザー承認
→ マージ
→ worktree削除

2. 基本方針

* 1タスクにつき1ブランチを作成する
* 1ブランチにつき1worktreeを作成する
* worktreeのディレクトリ名はブランチ名と一致させる
* メインリポジトリでは直接修正しない
* 実装は修正担当サブエージェントに任せる
* レビューは別のサブエージェントに任せる
* ユーザーとの会話は親エージェントに集約する
* 指示が不明確な場合は推測して進めない
* 権限承認が必要な場合はユーザーへ確認する
* mainへのマージはユーザー承認後に行う
* マージ後はworktreeと作業ブランチを削除する

3. worktree配置先

worktreeのルートディレクトリは、リポジトリ直下の `.env` にある `BITTY_WORKTREE_ROOT` を優先する。

`.env` はGit管理しないローカル設定ファイルのため、LLMはworktree作成前に存在確認し、値を読んでから作業する。

`.env` がない場合の既定値：

../bitty-worktree

ブランチ名が次の場合：

fix/login-validation

worktreeの作成先：

${BITTY_WORKTREE_ROOT}/fix/login-validation

ブランチ名に / が含まれる場合は、ディレクトリも階層化される。

例：

ブランチ：
feat/admin/export-csv
worktree：
${BITTY_WORKTREE_ROOT}/feat/admin/export-csv

3.1 worktree作成後の初期化

worktreeはメインリポジトリと別ディレクトリなので、Git管理外の依存ディレクトリは共有されない。

worktree側でサーバー再起動やiOS実機ビルドを行う場合、ユーザーが個別に `npm install` や `.env` コピーを判断しなくてよいように、実行入口の `.sh` が不足分を初期化する。

初期化は `scripts/worktree/bootstrap-local.sh` に集約する。各入口スクリプトは必要な範囲だけを呼び出す。

* `private_runner/restart.sh` は、ローカル `.env` と `private_runner/node_modules` を準備する
* `scripts/ios/build-expo-ios-device.sh` は、ローカル `.env`、`expo/node_modules`、`expo/ios/Bitty.xcworkspace`、必要なPodsを準備する

ローカル `.env` の値はログに表示しない。表示してよいのは、コピーした相対パスや初期化対象名だけにする。
署名ファイル、証明書、秘密鍵などをOSSに含めない。判断に迷うローカルファイルがある場合は、コピーや追跡の前にユーザーへ確認する。

3.2 worktree側での動作確認

worktree側の修正を確認する場合は、メインリポジトリ側ではなく、対象worktree内のスクリプトを使う。

ユーザーが実行する確認コマンドは、エージェントが代わりに実行せず、チャットに対象worktreeの実パスをMarkdownリンク付きで提示する。

サーバーを再起動する場合：

```sh
cd ${BITTY_WORKTREE_ROOT}/<branch-name>
./private_runner/restart.sh --mode full
```

チャット表示例：

```md
サーバー再起動: [private_runner/restart.sh](/absolute/path/to/worktree/private_runner/restart.sh)
```

iOS実機アプリで確認する場合：

```sh
cd ${BITTY_WORKTREE_ROOT}/<branch-name>
./scripts/ios/build-expo-ios-device.sh
```

チャット表示例：

```md
iOS実機ビルド: [scripts/ios/build-expo-ios-device.sh](/absolute/path/to/worktree/scripts/ios/build-expo-ios-device.sh)
```

これらのスクリプトは、対象worktreeのローカル初期化を先に行ってから本処理を実行する。

4. エージェントの役割

4.1 親エージェント

親エージェントは作業全体を管理する。

担当範囲：

* ユーザー指示の整理
* 不明点の確認
* ブランチ名の決定
* worktreeの作成
* サブエージェントの起動
* サブエージェントからの質問受付
* ユーザーへの確認
* 作業状況の管理
* レビュー結果の整理
* マージ前のユーザー承認取得
* マージ
* worktreeの削除
* 最終報告

親エージェントは、原則として実装を直接行わない。
親エージェントは、サブエージェントがローカル手順書を読めない前提で、必要な制約と完了条件を起動プロンプトに含める。
親エージェントは、worktree作成前にリポジトリ直下の `.env` を確認し、`BITTY_WORKTREE_ROOT` などローカル作業に必要な値を読み取る。

4.2 修正担当サブエージェント

担当範囲：

* 対象コードの調査
* 修正方針の検討
* 実装
* テスト追加・更新
* lint、型チェック、テスト
* 差分の自己レビュー
* コミット
* push
* Pull Request作成
* 親エージェントへの結果報告

修正方針：

* 下流の症状ではなく、上流の原因を特定して修正する
* UI、route、adapter、callerで問題が見えても、state、ordering、lifecycle、contractの発生源を先に確認する
* 消費側ごとの冗長なパッチではなく、原因箇所での汎用的な修正を優先する
* 上流境界を安全に変更できない場合だけ、理由を明記して局所対応を検討する

4.3 レビュー担当サブエージェント

担当範囲：

* ユーザー指示との整合性確認
* 実装差分のレビュー
* バグ、回帰、セキュリティ問題の確認
* テスト不足の確認
* 不要な変更の確認
* 問題の重要度分類
* 親エージェントへのレビュー結果報告

修正担当とレビュー担当は分ける。

4.4 ユーザー

ユーザーは、主に次の判断を行う。

* 不明な仕様への回答
* 権限要求の承認または拒否
* 破壊的変更の承認
* 重要な設計変更の承認
* マージの最終承認

5. ユーザー確認ポイント

5.1 作業開始前の確認

次の場合は、worktreeを作成する前にユーザーへ質問する。

* 指示を複数の意味に解釈できる
* 期待する動作が分からない
* 修正対象が特定できない
* 完了条件が不明
* UIやAPIの仕様判断が必要
* 互換性を維持する必要があるか不明
* 複数の実装方法があり、結果が大きく異なる
* データ構造や公開APIの変更が想定される

質問例：

修正方針を確定するため、次の点を確認してください。
現在の動作：
期待する動作：
対象範囲：
互換性を維持する必要があるか：

軽微で結果に影響しない実装詳細は、既存コード規約に従って判断してよい。

5.2 作業中の確認

作業開始後でも、次の場合は作業を停止して確認する。

* 当初の想定より影響範囲が広い
* 関係のない不具合を発見した
* 指示を満たすには追加変更が必要
* 既存仕様とユーザー指示が矛盾する
* テストが現在の仕様と矛盾する
* DBマイグレーションが必要
* 公開APIの破壊的変更が必要
* 新しい外部依存関係が必要
* 認証・認可・課金に影響する
* ユーザーデータを変更または削除する
* セキュリティ上の重大な問題を発見した
* 想定外の大規模リファクタリングが必要

5.3 権限承認

実行環境から権限承認を求められた場合、ユーザーが承認または拒否できる。

対象例：

* リポジトリ外へのファイルアクセス
* 外部ネットワークアクセス
* パッケージのインストール
* システムコマンドの実行
* ファイル削除
* GitHubへのpush
* Pull Request作成
* CIや外部サービスの操作
* データベース操作
* クラウド環境へのアクセス

権限要求時は、次を明示する。

実行しようとしている操作：
必要な理由：
変更される対象：
実行しない場合の影響：

権限が拒否された場合は、無理に回避せず親エージェントへ返す。

5.4 マージ前の確認

mainへのマージ前には、必ずユーザー確認を行う。

報告内容：

* 変更概要
* 対象ブランチ
* Pull Request
* コミット
* 実行したテスト
* テスト結果
* レビュー結果
* CI結果
* 既知の制限
* 残存リスク
* マージ方式

ユーザーの明示的な承認があるまでマージしない。

6. サブエージェントからの質問経路

サブエージェントは、原則としてユーザーへ直接質問しない。

質問経路：

サブエージェント
→ 親エージェント
→ ユーザー
→ 親エージェント
→ サブエージェント

これにより、ユーザーとの会話窓口を一本化する。

サブエージェントは質問が必要になった場合、作業を停止し、次の形式で親エージェントへ報告する。

状態：USER_INPUT_REQUIRED
現在の作業：
判明した内容：
判断できない点：
選択肢：
推奨案：
回答がない場合に進められない理由：

親エージェントは内容を整理してユーザーへ質問する。

7. 作業状態

各タスクは、次のいずれかの状態として管理する。

PLANNING
USER_INPUT_REQUIRED
READY
IMPLEMENTING
PERMISSION_REQUIRED
TESTING
PUSHING
REVIEWING
CHANGES_REQUESTED
READY_TO_MERGE
MERGE_APPROVAL_REQUIRED
MERGING
CLEANUP
COMPLETED
BLOCKED

状態の意味

状態 意味
PLANNING 指示内容を整理中
USER_INPUT_REQUIRED ユーザー回答待ち
READY 作業開始可能
IMPLEMENTING 実装中
PERMISSION_REQUIRED 権限承認待ち
TESTING テスト・確認中
PUSHING コミット・push・PR作成中
REVIEWING レビュー中
CHANGES_REQUESTED レビュー修正中
READY_TO_MERGE マージ可能
MERGE_APPROVAL_REQUIRED ユーザーのマージ承認待ち
MERGING マージ処理中
CLEANUP worktree削除中
COMPLETED 完了
BLOCKED 解決できない問題で停止

8. 全体フロー

ユーザーの修正指示
    ↓
親エージェントが指示を整理
    ↓
不明点があるか
    ├─ ある → ユーザーへ質問
    │          ↓
    │        回答を反映
    └─ ない
    ↓
ブランチ名を決定
    ↓
リモート情報を更新
    ↓
ブランチとworktreeを作成
    ↓
修正担当サブエージェントを起動
    ↓
調査・実装
    ↓
質問または権限承認が必要か
    ├─ 必要 → 親エージェントへ返す
    │          ↓
    │        ユーザー確認
    │          ↓
    │        作業再開
    └─ 不要
    ↓
テスト・lint・型チェック
    ↓
コミット
    ↓
push
    ↓
Pull Request作成
    ↓
レビュー担当サブエージェントを起動
    ↓
レビュー指摘があるか
    ├─ ある → 修正担当へ戻す
    │          ↓
    │        修正・再テスト・push
    │          ↓
    │        再レビュー
    └─ ない
    ↓
CI結果を確認
    ↓
ユーザーへマージ前報告
    ↓
ユーザー承認
    ├─ 承認しない → 作業停止または追加修正
    └─ 承認する
    ↓
マージ
    ↓
worktreeとローカルブランチを削除
    ↓
完了報告

9. タスク内容を整理する

親エージェントは、ユーザー指示から次を整理する。

目的：
現在の問題：
期待する結果：
対象範囲：
対象外：
完了条件：
必要なテスト：
互換性条件：
破壊的変更の可否：

不明点が作業結果に影響する場合は、先にユーザーへ確認する。

10. ブランチ名を決める

ブランチ名は作業内容が判別できる名前にする。

例：

fix/login-validation
feat/export-csv
refactor/payment-service
docs/setup-guide
test/add-payment-tests

推奨プレフィックス：

種類 プレフィックス
バグ修正 fix/
機能追加 feat/
リファクタリング refactor/
ドキュメント docs/
テスト test/
保守作業 chore/

ブランチ名はタスク開始後に変更しない。

11. リモート情報を更新する

メインリポジトリで実行する。

git fetch origin --prune

現在の状態を確認する。

git status --short
git worktree list

メインリポジトリに未コミット変更がある場合でもworktreeは作成できるが、その変更を新しいworktreeへ引き継がないことを確認する。

12. worktreeとブランチを作成する

環境変数を設定する。

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

BRANCH="fix/login-validation"
WORKTREE_ROOT="${BITTY_WORKTREE_ROOT:-../bitty-worktree}"
WORKTREE_PATH="${WORKTREE_ROOT}/${BRANCH}"
BASE_BRANCH="origin/main"

親ディレクトリを作成する。

mkdir -p "$(dirname "$WORKTREE_PATH")"

新しいブランチとworktreeを作成する。

git worktree add \
  -b "$BRANCH" \
  "$WORKTREE_PATH" \
  "$BASE_BRANCH"

作成結果を確認する。

git worktree list
git -C "$WORKTREE_PATH" status
git -C "$WORKTREE_PATH" branch --show-current

期待結果：

fix/login-validation

作成に失敗した場合

ブランチが既に存在する場合：

git worktree add "$WORKTREE_PATH" "$BRANCH"

リモートブランチから再開する場合：

git worktree add \
  -b "$BRANCH" \
  "$WORKTREE_PATH" \
  "origin/$BRANCH"

同じパスが既に存在する場合は、内容を確認せず削除しない。

ls -la "$WORKTREE_PATH"
git worktree list

13. 修正担当サブエージェントを起動する

サブエージェントには、必ず次を渡す。

* worktreeの絶対パス
* ブランチ名
* ベースブランチ
* ユーザー指示
* 整理した要件
* 完了条件
* 実行するテスト
* 変更禁止範囲
* 権限確認ルール
* 質問の返却方法
* コミット・push・PR作成の可否
* mainへマージしてはいけないこと

修正担当への指示には、上記項目に加えて、指定worktree以外を変更しないこと、mainへ直接コミット・マージしないこと、不明点や権限要求は親エージェントへ返すことを必ず含める。

14. 修正作業

修正担当サブエージェントは次の順序で進める。

リポジトリ内の指示ファイル確認
→ 対象コード調査
→ 現在の動作確認
→ 修正方針決定
→ 実装
→ テスト追加・更新
→ formatter
→ lint
→ 型チェック
→ テスト
→ git diff確認

最初に確認するファイル例：

AGENTS.md
README.md
CONTRIBUTING.md
package.json
pyproject.toml
Makefile
既存のCI設定

修正後：

git status --short
git diff
git diff --check

15. 作業中に質問が発生した場合

修正担当は、勝手に解釈せず親エージェントへ返す。

状態：USER_INPUT_REQUIRED
現在の作業：
判明した内容：
判断できない点：
選択肢：
推奨案：
回答がない場合に進められない理由：

親エージェントはユーザーへ質問し、回答をサブエージェントへ返す。

16. 権限承認が必要になった場合

サブエージェントは次の形式で親エージェントへ返す。

状態：PERMISSION_REQUIRED
実行しようとしている操作：
対象：
必要な理由：
実行しない場合の影響：

親エージェントは内容を整理してユーザーへ承認を求める。

承認された場合のみ再開する。

拒否された場合は、代替案を検討するか BLOCKED として報告する。

17. テストを実行する

プロジェクト固有のコマンドに従う。

例：

npm run format
npm run lint
npm run typecheck
npm test

または：

ruff check .
mypy .
pytest

テスト結果は省略せず報告する。

実行コマンド：
結果：
成功件数：
失敗件数：
未実行項目：
未実行理由：

全テストの実行が現実的でない場合は、関連テストを実行し、未実行範囲を報告する。

18. コミットする

差分を最終確認する。

git status --short
git diff
git diff --check

ステージング：

git add -A

コミット：

git commit -m "fix: validate login form input"

コミット内容確認：

git show --stat --oneline HEAD

コミットには対象タスク以外の変更を含めない。

19. pushする

git push -u origin "$BRANCH"

実行環境から権限承認が求められた場合は、ユーザーに承認を求める。

原則として禁止：

git push --force
git push --force-with-lease

履歴修正が必要な場合は、理由を親エージェントへ報告し、ユーザー承認を得る。

20. Pull Requestを作成する

GitHub CLIを使用する場合：

gh pr create \
  --base main \
  --head "$BRANCH" \
  --fill

PR本文には、変更内容、修正理由、実装方針、確認方法、実行したテスト、影響範囲、既知の制限、関連タスクを含める。

PR作成時に権限承認が必要な場合は、ユーザーへ確認する。

PRを作成しただけではマージしない。

21. 修正担当からの完了報告

状態：IMPLEMENTATION_COMPLETED
ブランチ：
worktree：
変更概要：
変更ファイル：
コミット：
push結果：
Pull Request：
実行したテスト：
テスト結果：
未実行テスト：
既知の制限：
確認してほしい点：

22. レビュー担当サブエージェントを起動する

修正担当とは別のサブエージェントを使用する。

確認項目：
- ユーザー指示を満たしているか
- 期待動作に合っているか
- バグや回帰がないか
- 不要な変更が含まれていないか
- エラーハンドリングが適切か
- セキュリティ上の問題がないか
- テストが不足していないか
- 公開APIを意図せず変更していないか
- lint、型チェック、テスト結果に問題がないか
原則としてコードを変更せず、まずレビュー結果を報告してください。
問題は次の重要度で分類してください。
- Critical
- High
- Medium
- Low
- Suggestion
問題がない場合も、確認内容と残存リスクを報告してください。

レビュー差分：

git diff origin/main...HEAD

コミット一覧：

git log --oneline origin/main..HEAD

23. レビュー結果

レビュー担当は次の形式で報告する。

状態：REVIEW_COMPLETED
総合判断：
APPROVE / CHANGES_REQUESTED / BLOCKED
指摘事項：
重要度：
対象ファイル：
対象箇所：
問題：
影響：
推奨修正：
確認済み項目：
テスト評価：
残存リスク：

24. レビュー指摘を修正する

指摘がある場合は、原則として元の修正担当サブエージェントへ戻す。

レビュー指摘
→ 修正
→ テスト再実行
→ コミット
→ push
→ 再レビュー

修正担当への返却例：

レビューで次の指摘がありました。
重要度：
対象：
問題：
期待する修正：
同じworktreeで修正してください。
修正後に関連テストを再実行し、コミット・pushして結果を報告してください。
mainへのマージは行わないでください。

25. CI結果を確認する

PRのCIを確認する。

GitHub CLIの例：

gh pr checks "$BRANCH"

CIが失敗している場合はマージ前確認へ進まない。

失敗理由を調査し、修正担当へ戻す。

CIを実行できない場合は、その理由を明記する。

26. マージ前のユーザー確認

次をすべて満たした場合、状態を MERGE_APPROVAL_REQUIRED にする。

* 実装が完了している
* 必要なテストが成功している
* レビュー指摘が解消している
* レビュー結果が承認相当である
* CIが成功している、または未実行理由が明確である
* 既知の重大な問題がない

ユーザーへの確認例

実装・テスト・レビューが完了しました。
ブランチ：
fix/login-validation
変更概要：
ログインフォームの入力検証を修正しました。
Pull Request：
PR番号またはURL
コミット：
コミットID
実行した確認：
- formatter
- lint
- 型チェック
- 関連テスト
テスト結果：
すべて成功
レビュー結果：
重大な指摘なし
CI結果：
成功
既知の制限：
なし
残存リスク：
特定の外部認証環境では手動確認していません。
予定するマージ方式：
Squash merge
この内容でmainへマージしてよいですか？

「はい」「マージして」「承認」など、明示的な許可を得るまでマージしない。

27. ユーザーがマージを承認しなかった場合

ユーザーの指示に従う。

想定される対応：

* 追加修正
* 追加テスト
* PRを保留
* PRをクローズ
* 作業を中止
* ブランチを残す
* worktreeを残す
* worktreeだけ削除する

勝手にPRやブランチを削除しない。

28. マージする

ユーザー承認後に実行する。

Squash mergeの例：

gh pr merge "$BRANCH" --squash --delete-branch

Merge commitの例：

gh pr merge "$BRANCH" --merge --delete-branch

Rebase mergeの例：

gh pr merge "$BRANCH" --rebase --delete-branch

マージ方式はリポジトリのルールまたはユーザー指示に従う。

マージ結果を確認する。

gh pr view "$BRANCH"
git fetch origin --prune

29. worktreeを削除する

最初に未保存変更がないことを確認する。

git -C "$WORKTREE_PATH" status --short

何も表示されないことを確認する。

worktreeを削除する。

git worktree remove "$WORKTREE_PATH"

ローカルブランチを削除する。

git branch -d "$BRANCH"

空になった親ディレクトリを削除する。

rmdir -p "$(dirname "$WORKTREE_PATH")" 2>/dev/null || true

最後に確認する。

git worktree list
git branch --list "$BRANCH"

削除できない場合

未コミット変更がある場合は、強制削除しない。

git -C "$WORKTREE_PATH" status

変更内容を親エージェントへ報告し、保存、コミット、破棄の判断をユーザーへ求める。

原則として次は使用しない。

git worktree remove --force

30. 中断と再開

ユーザー回答や権限承認待ちで中断する場合、worktreeとブランチは残す。

中断報告：

状態：
USER_INPUT_REQUIRED / PERMISSION_REQUIRED / BLOCKED
ブランチ：
worktree：
現在までの変更：
コミット済みか：
push済みか：
Pull Request：
停止理由：
ユーザーへ確認したい内容：
再開時に行うこと：

再開時は最初に状態を確認する。

git -C "$WORKTREE_PATH" status
git -C "$WORKTREE_PATH" branch --show-current
git -C "$WORKTREE_PATH" log --oneline -5

31. 失敗時の扱い

テストが失敗した場合

* 原因を調査する
* 今回の変更による失敗か確認する
* 修正可能なら修正する
* 既存不具合なら明記する
* 解決できない場合は BLOCKED として報告する

pushに失敗した場合

* 認証エラー
* 権限不足
* リモート更新との競合
* ブランチ保護
* ネットワークエラー

原因を報告し、無断で強制pushしない。

PR作成に失敗した場合

コミットとpushが完了していることを確認し、エラー内容を報告する。

マージに失敗した場合

* CI失敗
* レビュー未承認
* コンフリクト
* ブランチ保護
* 権限不足

原因を解消するまでマージ済みとして扱わない。

32. 禁止事項

* 複数のサブエージェントに同じworktreeを同時編集させない
* メインリポジトリで直接修正しない
* 異なるタスクを同じブランチに混ぜない
* 不明な仕様を勝手に決めない
* ユーザー回答待ちの状態で作業を進めない
* 権限承認を迂回しない
* ユーザーデータを無断で変更・削除しない
* 新しい依存関係を無断で追加しない
* テスト未実行を隠さない
* テスト失敗を無視しない
* レビュー前にマージしない
* ユーザー承認前にマージしない
* mainへ直接pushしない
* 理由なく強制pushしない
* 未コミット変更があるworktreeを強制削除しない
* PR作成をマージ承認と解釈しない
* サブエージェントにmainへの直接マージを許可しない

33. ユーザー確認を省略できる範囲

次の操作は、事前にユーザーから包括的な許可がある場合、個別確認を省略できる。

* worktree作成
* 作業ブランチ作成
* コード修正
* テスト実行
* formatter実行
* lint実行
* 型チェック実行
* コミット
* 作業ブランチへのpush
* Pull Request作成
* レビューサブエージェントの起動

ただし、次は包括許可があっても原則として個別確認する。

* mainへのマージ
* 強制push
* データ削除
* DBの破壊的変更
* 本番環境への変更
* 課金が発生する操作
* 秘密情報へのアクセス
* 大規模な仕様変更
* リポジトリ外への重大な変更

34. 推奨する標準運用

通常は次の範囲を自動化する。

worktree作成
→ 実装
→ テスト
→ コミット
→ push
→ PR作成
→ レビュー
→ CI確認

ここで停止し、ユーザーへ結果を報告する。

ユーザー承認
→ マージ
→ cleanup

つまり、標準の停止地点はマージ直前とする。

ただし、作業途中で不明点や権限要求が発生した場合は、その時点でも停止する。

35. 最終完了報告

状態：COMPLETED
タスク：
ブランチ：
worktree：
変更概要：
変更ファイル：
コミット：
Pull Request：
実行した確認：
テスト結果：
レビュー結果：
CI結果：
ユーザー承認：
マージ方式：
マージ結果：
リモートブランチ削除結果：
worktree削除結果：
ローカルブランチ削除結果：
既知の制限：
残存課題：

36. 運用原則の要約

不明なら質問する
権限が必要なら承認を求める
実装担当とレビュー担当を分ける
ユーザーとの会話は親エージェントに集約する
PR作成までは自動化できる
マージ前には必ずユーザーへ確認する
マージ後にworktreeを削除する
