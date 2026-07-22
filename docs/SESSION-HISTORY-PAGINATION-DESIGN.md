# Codexセッション履歴ページング設計

## 0. 設計判断

履歴ページングはOpenAI Codex本体を変更せず、Bittyの`private_runner`でrolloutを後方から必要な範囲だけ読む。先に作った`thread/turns/list`試作は根本解決にならないため採用しない。試作は未commitであり、確定実装へ積み増さず、実装開始時に差し替える。

- 対象セッションは本文を読まないSQLite metadata確認で`history_mode=legacy`、作成CLIは`0.144.6`だった。
- Codex `0.145.0`のlegacy実装は、`limit: 10`でも各requestでrollout全体をreplayしてから10 turnへ絞る。61MBの内部読込は残る。
- CLIを更新しても既存legacy threadはpaginated形式へ自動移行されない。公式の移行API/CLIも確認できなかった。
- `itemsView: "summary"`は各turnの最初のuser messageと最後のagent messageだけを返し、command execution rowを含まない。
- `itemsView: "full"`はcommandを返すが、巨大なcommand outputも同時に運ぶ。commandだけを軽量取得する公式viewはない。

したがって「対象legacyセッションを高速化する」「command rowを維持する」は、現在の公式App Server APIだけでは同時に満たせない。Bittyが所有するrunner境界で、表示に必要なJSONL recordだけをbyte cursorで読む。

この判断は一時的な回避策ではなく、Bitty側で完結する履歴読取の責務とする。将来Codex APIへ戻す場合は、次の2点が公式実装で解消されたことを実測と互換テストで確認してから、この文書、コードコメント、回帰テストを同じ変更で更新する。

1. legacy threadのpage取得がrollout全体をreplayしない。
2. 巨大なtool outputを転送せずcommand rowを取得できる。

## 1. 状態

- 状態: 実装・自動検証済み、実機スクロール確認待ち
- 対象ブランチ: `fix/session-history-pagination`
- 対象worktree: `/Volumes/SSD-500GB-SanDisk/work/bitty-worktree/fix/session-history-pagination`
- この文書の範囲: 調査、runner後方読取の設計、未commit試作のレビュー結果
- 未実施: 実機確認、commit、push、PR

## 2. 目的

長いCodexセッションをExpo Bittyで開く際、会話全文の取得、解析、state保持、Markdown描画を初期表示の前提にしない。

初回は最新ページだけを表示し、上端へスクロールした時だけ過去ページを取得する。取得元からUIまで同じカーソル契約を使い、UIで全文を取得してから`slice`する下流対応は行わない。

## 3. 対象外

- Markdownレンダラーの置き換え
- 新しいリストライブラリの導入
- Codex本体とrollout保存形式の変更
- 古いCodex App Serverとの互換経路
- 会話履歴の削除や圧縮
- セッション一覧自体のページング変更
- TTS、承認、relayの仕様変更

## 4. 調査時の安全条件

指定セッション`019f7ce7-4e10-7fd3-8683-ed52cba8509d`の本文は表示していない。確認はファイル名、`stat`、`wc`、`jq`による件数・型・バイト数の集計、本文を除外した診断ログに限定した。

## 5. 実測結果

### 5.1 rollout

| 指標 | 値 |
| --- | ---: |
| JSONLファイル | 61,338,731 bytes |
| JSONL行数 | 5,944 |
| 最大1行 | 2,634,967 bytes |
| 100KB以上の行 | 76 |
| response message | 306件 |
| response message本文合計 | 286,069 bytes |
| 最新10 message本文合計 | 7,592 bytes |
| 最新20 message本文合計 | 32,404 bytes |

約61MBのファイルに対し、最新10 messageの本文は約7.6KBである。初回表示に全文を運ぶ必要はない。

`custom_tool_call_output`は936件あり、集計上およそ54.3MBを占める。画面に表示する会話本文より、全turn/itemを復元する途中データが支配的である。

### 5.2 実行時診断

本文・previewを除外した既存診断ログでは、同じセッションに次の2経路があった。

1. `thread/read(includeTurns: true)`が約544msで成功し、288表示messageを復元。
2. 別の復元では同RPCが25,035msでtimeout。
3. timeout後、`/session-messages?limit=all`へfallback。
4. fallback応答は約306KBだが、正規化後は最大1,473表示rowを一括でstateとMarkdown描画へ渡した。

体感遅延は、全履歴RPCを25秒待ってから全件fallbackする直列構造で説明できる。成功時も全件の転送、正規化、state保持、初期描画が残る。

## 6. 現在の処理と根本原因

```text
session選択
  -> thread/read(includeTurns: true)
  -> 全turn/itemsをWebSocket転送
  -> Expoで全件normalize
  -> 全messageをconversation/runtime/panel snapshotへ格納
  -> LegendListへ全件を渡す
  -> 可視rowをMarkdown描画
  -> 失敗時は /session-messages?limit=all で再び全件取得
```

主な発生源は次のとおり。

- `expo/src/features/codex/client/threads.ts`
  - `thread/read`へ`includeTurns: true`を渡す。
  - not-loaded時の`thread/resume`も全turnを返す。
- `expo/src/features/app/hooks/useLlmSessionExplorer.ts`
  - fallbackへ明示的に`limit=all`を渡す。
- `private_runner/src/llm-session-rollout-readers.mjs`
  - `all`は全文を`fs.readFile`、split、全行`JSON.parse`する。
  - 数値limitでも最大8MBを読み、全行parse後に末尾をsliceする。cursorはない。
- `expo/src/features/app/AppRoot.tsx`
  - active restoreとpanel hydrationが全件をruntime snapshotへ適用する。
- `expo/src/features/app/screens/ChatScreen.tsx`
  - 全件をLegendListへ渡し、初期bottom settleを複数回行う。

UI側で`messages.slice(-10)`するだけでは、ファイルI/O、WebSocket転送、JSON parse、stateメモリの大部分が残るため採用しない。

## 7. 過去履歴から分かったこと

公開Git履歴は`9ad16b1`（2026-06-14、Initial public release）がroot commitで、その時点ですでに全件読み込みである。reflogと到達不能objectを含めても、「Markdownの位置ずれを理由にwindowingを削除した」コミットや説明は確認できなかった。したがって原因をMarkdownだったと断定しない。

ただし、削除済みwindowingの痕跡はある。

- `useConversationMessageWindowController`は`resetVisibleCount`、`visibleCount`、`totalCountOverride`を受け取る。
- 現在はそれらを無視し、常に全件をstateへ入れる。
- `sessionRestoreUi`は今も`resetVisibleCount`と`totalCountOverride`を渡す。

この残骸を再利用してクライアント側だけをwindow化しない。実装時は新しいページ契約へ置き換え、不要になったoptionを削除する。

関連修正から維持すべき契約は次のとおり。

- `ba90281`: サブエージェントの親継承範囲、child開始境界、cwdを維持する。
- `54d40f9` / `51dbbcc`: hydrationが新しいlive runtimeを古い取得結果で上書きしない。
- `8e842f8`: prependで既存message IDを変えず、TTS targetとwaveformを維持する。
- `715f852`: 過去読み込みRPCが進行中turnのrelay identityを奪わない。
- `bcbf6c98`: 新しいWebSocketを開かず、既存`RunnerWebSocketManager`を共有する。

## 8. 採用する設計

### 8.1 ページ単位

ページ単位は「画面に表示する最新10 row」とする。ユーザー/アシスタントのmessageとcommand executionをそれぞれ1 rowと数える。

表示しないAGENTS指示、environment/permissions挿入message、reasoning、tool outputは数えない。境界をturnに合わせて件数を増減させず、常に最大10 rowとする。

ページサイズは設定化せず、runnerを正とする単一定数にする。Expoは件数の意味を再実装しない。

### 8.2 primary: private_runnerの後方reader

履歴取得は既存の認証済み`/session-messages`をcursor対応にする。

```text
GET /session-messages?sessionId=...&limit=10
  -> 最新10 row + olderCursor

GET /session-messages?sessionId=...&limit=10&cursor=...
  -> 直前の10 row + 次のolderCursor
```

- runnerはsession IDから既存indexでrollout pathを解決する。cursorへpathを入れず、別sessionのpathを指定できないようにする。
- cursorなしではEOF、cursorありではcursorのbyte offsetを起点に、固定長chunkを後方へ読む。
- 改行が見つかるまで後方chunk走査する。通常lineは完全なlineになってからUTF-8 decodeするが、上限を超えるlineは連結せず、有界prefix/suffixだけを保持してstreaming分類する。
- 最新から古い順に走査し、10個の表示rowを満たした境界で止める。返却時は古い順へ反転する。
- `response_item`をmessageの正とし、対応する`response_item`がない場合だけ`event_msg`をfallbackに使う。同じrole・時刻・本文の重複recordは1 rowにする。
- command rowは実行command文字列、`running/completed/failed`、exit codeを返す。command output本文、その他のtool JSON、reasoning本文は返さない。
- 巨大recordは行全体の`JSON.parse`やUTF-8文字列化をしない。バイト列の有界prefix/suffixでrecord種別、call ID、status、exit codeだけを識別し、不明な形式は本文を読まず診断countに回す。
- 各rowの安定IDはrollout内の永続item/call IDを優先する。IDがない場合だけrecord指紋を使い、byte offsetだけをIDにしない。live itemと履歴rowが同じ永続IDなら更新、fallback IDならrole・時刻・種別の指紋で一度だけ照合する。
- cursorはクライアントにとってopaqueとし、version、session ID、次回の排他的読取終了byte offset、rolloutのdevice/inode、境界前後の有界hashを持つ。
- 追記はcursorを無効化しない。truncate、置換、または先頭metadata書き換えでoffsetがずれた場合はdevice/inode・ファイル長・境界hashで検出し、全文読取へfallbackせず`stale_history_cursor`を返す。
- 初期実装ではsidecar indexを作らない。後方cursorだけで同じ範囲を再走査せずに済み、cache生成・失効・cleanupの複雑性を持ち込まない。実測で必要になった場合だけ別設計とする。

subagent判定、親継承境界、model、reasoning、context、cwdはmessage pageと混ぜない。subagentは先頭からchild開始recordまでforward chunk scanし、境界offsetをrollout指紋とともにプロセス内cacheする。既存のcwd優先順位と`preferCliRollout`は変えない。

### 8.3 App Serverを履歴sourceにしない理由

App Serverはlive turn、status、approvalなど実行時情報には引き続き使用する。一方、保存済み履歴には`thread/turns/list`と`itemsView`を使用しない。

実装コードの後方reader直上に、この節とOpenAI Codex issue #25215への参照コメントを置く。さらに禁止経路を呼ぶと失敗するテストダブルを使い、初回復元が`thread/read(includeTurns:true)`、`thread/turns/list`、`limit=all`へ戻らないことを挙動で固定する。ソース文字列の検索だけを回帰テストにせず、コメントアウトコードも残さない。

### 8.4 Codex App Server version gate

`private_runner/run-local.sh`がapp-serverを起動する前に、実際に起動する`codex --version`を確認し、サポート最低version未満なら起動を止めてCodexの更新を案内する。versionを取得できない場合も同様に明示的なエラーにする。

既存processを再利用する場合はhandshakeから実processのversionを検証する。検証できなければ再利用せず、version確認済みbinaryで再起動する。このgateは履歴ページングのfallback分岐とは分離する。この変更でのサポート最低versionは`0.145.0`とし、version比較を1か所に置く。

### 8.5 Expoページ契約

```ts
type RunnerSessionMessagesResult = {
  // 既存metadata/status
  messages: RunnerSessionMessage[];
  olderCursor: string | null;
};
```

同じ`fetchRunnerSessionMessages`を次の2用途にする。

- cursorなし: 最新ページとmetadata/statusを取得
- cursorあり: 同一sessionの過去ページだけを取得

App Serverのmetadata-only readとrunnerのbounded metadata readerは、model、reasoning、context、statusに必要な情報だけを取得し、最新pageの表示を止めない。履歴本文はrunner responseだけを正とする。

過去ページ取得はruntime全体を置換せず、IDでdedupeして先頭へ追加する。

```text
next = dedupeByStableId([...olderPage, ...current])
```

ページ状態はsessionごとに保持する。

- `olderCursor`
- `loadingOlder`
- request generation/session ID
- 最後に失敗した過去ページの再試行可否

session切替後に前sessionの応答が返った場合はgenerationで破棄する。`loadingOlder`で同じcursorの多重取得を抑止する。
過去ページの終端は`olderCursor === null`だけで表し、重複する`hasOlder`状態は持たない。

live message appendとhistory prependは別操作として扱う。freshness判定は「ページの件数が少ない」ことを古いsnapshotの根拠にしない。

### 8.6 UIとスクロール位置

新依存は追加せず、既存`@legendapp/list` 2.0.19を使う。

```text
data: 古い -> 新しい通常順
onStartReached: loadOlder
keyExtractor: 永続message ID
maintainVisibleContentPosition: 有効
inverted: 使用しない
```

LegendList v2は`maintainVisibleContentPosition`を既定で有効にし、prependとsize changeで可視位置を維持する設計である。実装では意図を明確にするためpropを明示し、既存versionの型と挙動を確認する。
検証は最終位置だけでなく、prependからMarkdown/Mermaidの高さ確定までのanchor Y座標を連続計測し、一時的な最大ずれも受入基準に含める。

Markdown、code block、table、Mermaid WebViewなどの実測高さはLegendListへ任せる。次は行わない。

- prepend前後のcontent height差を1回だけoffsetへ加算
- `setTimeout`後の手動`scrollToOffset`
- 高さや配列indexをkeyへ含める
- page追加のたびにListの`key`を変える
- `inverted`による座標反転
- FlashList追加

現行の「message count増加時にbottomへ移動する」処理は、prependとappendを判別できるようにする。prependではbottom scrollを発火させず、末尾付近のlive appendだけ従来どおり追従する。

## 9. 実装境界

### private_runner

- `private_runner/src/llm-session-history-page-reader.mjs`
  - cursor付き後方chunk reader、row境界、stable IDを履歴pageの責務として持つ。
- `private_runner/src/llm-session-rollout-readers.mjs`
  - rollout形式のmessage抽出とsubagent metadataを提供し、全文履歴読取を廃止する。
- `private_runner/src/server-runtime.mjs`
  - `/session-messages`でcursorを受け、`olderCursor`を返す。
  - routeには読取ロジックを置かない。
- `private_runner/tests/llm-session-rollout-readers.test.mjs`
  - byte境界、大きいline、cursor、subagent、巨大output非parseの回帰テストを置く。

### Codex App Server起動

- `private_runner/run-local.sh`
  - app-server起動・再利用前の最低version確認と更新案内。

### Expo state

- `expo/src/features/app/hooks/useLlmSessionExplorer.ts`
  - `/session-messages`へcursorを渡し、runner responseをpage contractへ正規化。
- `expo/src/features/codex/client/threads.ts`
  - 保存済み履歴の取得責務を削除し、App Serverのmetadata/live stateだけに限定。
- 既存session restore/runtime utilとcontext
  - cursor、終端、loading、generationをsession単位で保持。
  - active/panelのprependを共通化。
- `AppRoot.tsx`
  - 配線だけに留める。既に7,000行超のためページングロジックを追加しない。

### UI

- `expo/src/features/app/screens/ChatScreen.tsx`
  - `onStartReached`、loading/terminal表示、prepend/append判定。
  - 通常、MiniBoard、popupで同じpage actionを使用。

単なるforwarding wrapper、sidecar cache、新しい設定値は追加しない。ページサイズはコード上の単一定数10とし、設定画面や環境変数へ広げない。

## 10. 実装順序

1. 未commitのApp Server page試作をrunner設計へ差し替え、不要な型・hook・version仮定を先に削除する。
2. runnerの後方chunk reader、opaque cursor、stable IDとテストを追加する。
3. `/session-messages`とExpo page contractへcursorを通す。
4. active restoreとpanel hydrationにcursor stateを通す。
5. stable IDによるprepend/dedupeを追加する。
6. ChatScreenへ`onStartReached`を接続する。
7. prependとappendのbottom-scroll判定を分離する。
8. dead window optionを削除する。
9. App Server version gateの最低version根拠を確認して追加する。
10. 単体・結合テスト後、release buildで対象sessionを計測する。
11. 実機でMarkdown/Mermaidのanchor位置を確認する。

## 11. テスト計画

### 11.1 runner後方reader

- 初回がEOFから最新10表示rowだけを返す。
- 2page目が1page目の直前10表示rowを返し、重複と欠落がない。
- 1 JSONL lineがchunkより大きくても正しく次の改行へ到達する。
- multi-byte UTF-8がchunk境界をまたいでも壊れない。
- 古い巨大なtool outputがあるfixtureで、初回にファイル先頭まで読まない。
- `custom_tool_call_output`の巨大line全体をbuffer化・`JSON.parse`せず、output本文をresponseへ含めない。
- command rowは実行command、status、exit code、stable IDを持ち、output本文を含まない。
- `response_item`/`event_msg`の重複と、AGENTS/environment/permissions挿入messageを表示件数に数えない。
- 永続item IDがあるrowはlive itemと同じIDになり、IDがないrowの指紋もページ間で変わらない。
- rollout追記後も発行済みolder cursorが同じ過去範囲を指す。
- truncate・置換・同inodeの先頭書き換え・別session cursor・範囲外offsetを明示的に拒否する。
- cursor終端、空page、重複pageを処理する。
- subagentの親継承範囲とcwdを既存fixtureで維持する。
- model、reasoning、context metadataをpage取得で失わない。

### 11.2 Expo/API契約

- 初回と過去pageが`/session-messages`へそれぞれcursorなし・ありで1回だけrequestする。
- `limit=all`、`thread/read(includeTurns:true)`、`thread/turns/list`を履歴復元に使用しない。
- read-only履歴取得がrelay identityとturn ownershipを変更しない。
- live state用の既存`RunnerWebSocketManager`以外のsocketを作らない。

### 11.3 Version gate

- `0.145.0`以上は起動を許可する。
- `0.145.0`未満、解析不能、command失敗は更新案内を返す。
- 既存app-serverはhandshakeの実versionが最低条件を満たす場合だけ再利用する。

### 11.4 State/runtime

- active、panel、MiniBoard、popupで同じsession pageを共有する。
- 多重`onStartReached`が同じcursorを二重取得しない。
- session切替後の遅い応答を捨てる。
- prependがlive runtime statusを上書きしない。
- TTS target、waveform、承認待ち、進行中turnを維持する。
- 新着appendと過去prependを区別する。

### 11.5 Scroll/Markdown

- 短文、長文、heading、list、table、code blockを含むpageをprependする。
- prependから高さ確定まで、最初の可視message IDと画面上Y座標の最大一時変化を計測する。
- Mermaidの160ms/700ms後の高さ変更後もanchorが動かない。
- prependがbottom scrollを発火しない。
- 末尾付近のlive appendは従来どおり追従する。
- iOS実機のrelease buildで確認する。Androidを正式対象にする場合は同じfixtureで確認する。

## 12. 性能受入基準

対象sessionで変更前後を同じrelease条件で比較する。

- 初回履歴取得にApp Serverのturn replayを使用しない。
- 初回pageは10表示rowを超えて返さない。
- 初回に全61MBをExpoへ転送しない。
- 初回に全1,473 rowをMarkdownへ渡さない。
- `thread/read`の25秒timeoutを正常フローに含めない。
- runner diagnosticsへ開始・終了byte、read bytes、parse件数、巨大output skip件数、response bytesを出す。本文は出さない。
- 診断へsource、page count、read/parse/normalize時間、time-to-first-chatを記録する。
- 上端1回につきcursorが1回だけ進む。
- prependからMarkdown/Mermaid高さ確定までanchor IDが同じで、Y座標の最大一時変化が実機許容値内である。

絶対時間は端末・接続条件の影響を受けるため、実装前baselineを取り、設計レビュー後に数値目標を確定する。

## 13. 失敗時の動作

- 最低version未満: Codexの更新案内を表示する。
- 初回runner page失敗: セッション復元を失敗として表示し、App Server replayやrollout全文読み込みへfallbackしない。
- 過去page失敗: 現在表示を保持し、上端の再試行UIだけを出す。
- stale cursor: 現在表示を保持し、履歴を再度開く案内を出す。自動で最新pageへ飛ばない。
- 終端: `olderCursor=null`として追加RPCを止める。
- stale response: 表示中sessionへ適用せず破棄する。

## 14. ロールバック

実装は既存全件経路をfeature flagで並存させない。恒久的な二重経路は複雑性と再発源になるためである。

問題があれば作業ブランチのcommitをrevertする。公開後の緊急時も、明示的な全件fallbackやApp Server replayを追加せず、cursor readerを修正する。

## 15. 複雑性を減らす点

- 無効な`visibleCount`系optionを削除する。
- 全件restoreとpage restoreの二重state modelを作らない。
- App Serverとrunnerの二重履歴経路を作らない。
- 既存LegendListを使い、新依存を追加しない。
- 手動scroll補正timerを追加しない。
- sidecar indexとその失効管理を追加しない。
- byte cursorをUIで解釈しない。
- page sizeの設定UIや環境変数を追加しない。

## 16. リスク

- CodexのJSONL record形式が将来変わる可能性がある。
- 10 rowの間に巨大なtool output recordがある場合、そのpageのdisk scan量は大きくなる。
- 未知の巨大recordは本文を読まずskipするため、将来の新形式では表示行を取りこぼす可能性がある。
- stable IDの変更はTTSとruntime reconciliationへ影響する。
- Markdown/Mermaidの遅延layoutは単体テストだけでは保証できない。

これらはrecord種別fixture、byte diagnostics、永続ID/指紋、実機anchor計測で抑える。未知recordは無理に表示せず診断countだけを残す。

## 17. 確定事項

1. ページ単位は画面上の10表示row。user/assistant messageとcommand executionを1 rowずつ数える。
2. command execution rowは実行command、status、exit codeを含め、output本文は含めない。
3. 過去page失敗時は現在位置を保ったまま上端に再試行表示を出す。
4. 古いCodex App Serverはサポートせず、起動時にversion確認して更新を案内する。
5. OpenAI Codex本体は変更せず、保存済み履歴のページングをprivate_runnerで吸収する。
6. App Serverのlegacy全replay問題は、この文書、runnerコードコメント、回帰テストで削除理由ごと固定する。

## 18. 参考資料

- [OpenAI Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
  - App Serverのthread API契約。保存済みlegacy履歴の採用APIではなく、非採用判断の比較対象。
- [OpenAI Codex issue #25215](https://github.com/openai/codex/issues/25215)
  - legacyの`thread/turns/list`も各requestでrollout全体をreplayする既知の上流問題。
- [LegendList v2](https://legendapp.com/open-source/list/v2/version-2/)
  - `maintainVisibleContentPosition`の再実装、既定有効、双方向infinite scroll。
- [LegendList v2 props](https://legendapp.com/open-source/list/v2/props/)
  - `onStartReached`と位置維持の契約。
- [React Native ScrollView](https://reactnative.dev/docs/scrollview#maintainvisiblecontentposition)
  - chatでの可視位置維持とreorder時の注意。

## 19. 設計承認後の完了条件

- 17章の仕様が確定している。
- runner後方reader、page API、version gateの関連テストが成功している。
- typecheck、Expo関連Jest、private_runner test、`git diff --check`が成功している。
- 対象sessionの本文をログへ出さず、release buildで性能差を計測している。
- Markdown/Mermaid prependの実機anchor確認が成功している。
- 別エージェントのレビューとCIが完了している。
- mainへのmerge前にユーザー承認を得ている。
