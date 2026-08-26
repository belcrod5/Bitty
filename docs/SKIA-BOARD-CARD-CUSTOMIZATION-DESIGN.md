# Skiaボード カード表示カスタマイズ設計

## 目的

Skiaボード上のファイル／ディレクトリカードを長押しメニューから変更できるようにする前に、実体と見た目の所有範囲、保存形式、画像取得経路を定める。

本書はデータ設計と、今回実装する最小範囲を記録する。

## 所有範囲

| 所有者 | 保存・処理するもの |
| --- | --- |
| Runner | 実ファイル操作、セッション既読、指定された画像ファイルの読み出し |
| アプリ | Skiaボードの配置と見た目、画像パス、実行中だけの画像キャッシュ |

ボードの見た目は既存のアプリ設定ファイル `bitty-settings.json` の `skiaBoardState` に保存する。新しいDB、Runner側の見た目保存、画像本体の複製は追加しない。

## 現状と問題

現行データは概略として次の形になっている。

```json
{
  "registeredDirectories": [
    {
      "path": "/work/bitty",
      "displayName": "Bitty開発"
    }
  ],
  "skiaBoardState": {
    "cards": [
      {
        "kind": "directory",
        "directory": "/work/bitty",
        "name": "Bitty"
      },
      {
        "kind": "file",
        "rootDir": "/work/bitty",
        "path": "docs/guide.md",
        "name": "guide.md"
      }
    ]
  }
}
```

- ディレクトリ名は `registeredDirectories[].displayName` とディレクトリカードの `name` に重複している。
- ディレクトリカードの `name` は追加時のスナップショットで、変更UIがないため古い値が残り得る。
- ファイルカードの `name` も実ファイル名のコピーであり、実体の参照は別途 `rootDir` と `path` が持っている。
- 現在のファイル名変更は成功後に旧カードを `unavailable` にする。名前変更としては参照更新が不足している。

## 表示名

通常表示名はボードカードには保存せず、表示時に次から導出する。

- ディレクトリ: 対応する `registeredDirectories[].displayName`
- ファイル: `path` のbasename

表示順は `displayNameOverride`、登録済みディレクトリ名、パスのbasenameとする。ファイルでは登録済みディレクトリ名を使用しない。対応する登録済みディレクトリがない場合、ディレクトリもパスのbasenameへfallbackする。

ボードだけで名前を変えた場合に限り、カードへ `displayNameOverride` を保存する。UIでは次の操作を別の意味として扱う。

- 「ボード上の表示名を変更」: 実体を変更せず `displayNameOverride` を変更する。
- 「実ファイル名を変更」: Runner上のファイルを変更する。
- 「登録ディレクトリ名を変更」: `registeredDirectories[].displayName` を変更し、そのディレクトリを参照する通常表示へ反映する。

## 推奨データ形

カードの識別情報と、設定された場合だけ存在する見た目情報を同じカードに直接持たせる。汎用メタデータ層は追加しない。

```json
{
  "skiaBoardState": {
    "cards": [
      {
        "kind": "directory",
        "directory": "/work/bitty",
        "displayNameOverride": "重要プロジェクト",
        "imagePath": "/Users/example/Pictures/bitty.png",
        "col": 0,
        "row": 0
      },
      {
        "kind": "file",
        "rootDir": "/work/bitty",
        "path": "docs/guide.md",
        "col": 1,
        "row": 0
      }
    ]
  }
}
```

- ディレクトリカードの実体参照は `directory`。
- ファイルカードの実体参照は `rootDir + path`。
- `imagePath` はカードに表示する別の画像の参照であり、ファイルカードの `rootDir + path` とは別物。
- `displayNameOverride` と `imagePath` は未指定なら保存しない。`imagePath` があれば画像表示、なければ通常表示とし、同じ意味を持つ `displayMode` は追加しない。初期状態へリセットすると、これらの見た目設定を取り除く。

既存カードの `name` は復元時に読み捨て、上書きへは移行しない。導出可能な通常名を再保存せず、ユーザーが明示した上書きだけを保存する。

## 実ファイル名変更

ファイル名変更はRunnerで実行し、成功した場合だけアプリがカードの `rootDir + path` を変更後の参照へ置き換える。座標、表示名上書き、画像パスはそのまま維持する。失敗時はカードを変更しない。

変更通知は、画面ごとに旧カードを処理するのではなく、ファイル変更結果を受ける既存の共通経路からSkiaボード状態へ反映する。renameは旧参照を新参照へ置換し、deleteは旧参照を `unavailable` にする。変更先を参照するカードが既にある場合は、既存カードを残して旧カードをボードから除く。

## ユーザー指定画像

1. ユーザーはスケジュール設定と同じく、登録済みディレクトリを選び、その配下を既存のファイルExplorerで開いて画像を選ぶ。ファイルExplorerはカード編集モーダル内へ埋め込まず、別のページシートで開く。
2. アプリは `imagePath` だけを `skiaBoardState` に保存する。画像本体は保存しない。
3. アプリは絶対パスの親ディレクトリを `rootDir`、絶対パスを `path` として既存の認証付き `/files/media` へ要求する。URL生成は既存の `buildRunnerMediaFileUrl` を再利用する。
4. Runnerは既存処理で指定パスから画像バイナリを読み出して返す。新しいAPIや許可ルート設定は追加しない。
5. アプリは受け取った画像をデコードしてSkiaカードへ描画する。取得済みバイト列はRunner URL・認証・画像URL単位でアプリ実行中のメモリだけに置き、画像本体を永続化しない。取得にはタイムアウトを設け、表示対象がなくなった場合は通信を中断する。失敗・中断した保留リクエストはキャッシュから除き、再表示時に再試行できるようにする。

すでに保存された登録外または登録解除済みの絶対パスは消さずに表示・保持する。ディレクトリ選択肢にも「登録解除済み」として残し、スケジュールと同じく選び直すまでExplorerの起点にできる。

対応形式は既存 `/files/media` が返せる画像形式とする。画像でない、読めない、移動済み、削除済みの場合は通常カードへfallbackし、`imagePath` は保持する。カードの再表示またはパスの再設定で再試行する。今回、新しい容量設定や更新監視は追加しない。

## カスタマイズ範囲

初期候補は次のとおり。

- ボード上の表示名
- ユーザー指定画像の絶対パス
- 初期状態へリセット

画像はカード範囲へ収まるよう縦横比を保って表示する。色は対象とUIが未確定のため今回のデータ形と実装範囲には含めない。

## 今回の実装範囲

- ファイル／ディレクトリカードの長押しメニューから、ボード表示名と画像を設定・解除する。画像は登録済みディレクトリ選択後、既存ファイルExplorerから選ぶ。
- ファイルカードでは既存の実ファイル名変更を引き続き別操作として提供する。
- 実ファイルのrename成功時はカード参照を更新し、delete成功時だけ `unavailable` にする。
- 画像ファイル自体のrenameや移動には `imagePath` を自動追従させない。

## 現行コードの確認箇所

- `expo/src/features/app/utils/skiaBoardState.ts`: カード型、識別子、保存・復元、`unavailable` 化
- `expo/src/features/app/utils/persistedSettingsFile.ts`: `bitty-settings.json` と `skiaBoardState` の保存境界
- `expo/src/features/app/hooks/useAppSettingsPersistenceController.ts`: `registeredDirectories` の保存
- `expo/src/features/app/hooks/useWorkspaceFileMutations.ts`: Runnerでのファイル名変更後の共通処理
- `expo/src/features/app/contexts/SkiaBoardContext.tsx`: ボード状態のアプリ側所有
