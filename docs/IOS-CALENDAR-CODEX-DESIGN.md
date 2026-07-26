# CodexからiOSカレンダーを読み書きする実装設計

状態: 第3回レビュー反映済み・実装着手可能（互換性方針更新）
対象: Bitty iOSアプリ、private runner、Codex app-server
更新日: 2026-07-26

## 1. 結論

初回実装は次の範囲に絞る。

- アプリを開いている通常会話では、予定の読み取り・作成・更新・削除を行える。
- 作成・更新・削除は、毎回アプリ内で内容を確認してから実行する。
- GPS・時間ルールでは、明示的に許可したルールだけが予定を読み取れる。
- GPS・時間ルールからの読み取りはバックグラウンドで試行するが、iOSの制約上、
  成功は保証しない。
- GPS・時間ルールでは、予定の作成・更新・削除ツールをCodexへ渡さない。
- GPS・時間ルール用のカレンダー端末は、初回実装では1台に固定する。

バックグラウンド書き込み、複数端末の自動選択、カレンダーデータの同期DBは作らない。
これにより、書き込み承認キュー、複数端末間の競合、重複書き込み復旧を初回実装から
除外する。

## 2. 対象範囲

### 対応する

- iOS 15.1以降。
- 端末に設定済みのiCloud、Google、Exchange、ローカルカレンダー。
- カレンダー一覧の取得。
- 最大31日間の予定検索。
- 予定1件の詳細取得。
- 通常会話からの単発予定の作成・更新・削除。
- GPS・時間ルールからの予定読み取り。
- 権限拒否、端末不在、通信断、読み取り専用カレンダーの明示的なエラー。

### 対応しない

- Android。
- リマインダー。
- カレンダー自体の作成・削除。
- 出席者、招待、参加回答の変更。
- 繰り返し予定の更新・削除。
- バックグラウンドでの予定作成・更新・削除。
- 複数iPhoneからのカレンダー選択。
- Runnerへのカレンダー内容の恒久保存。
- サイレントPushの配信保証。

繰り返し予定は読み取れる。更新・削除しようとした場合は
`recurring_event_write_unsupported`で拒否し、iOSカレンダーアプリでの編集を案内する。

## 3. 実行フロー

### 3.1 通常会話

```text
ユーザー
  ↓ 「今日の予定は？」
Expo
  ↓ Codex app-server RPC
Runner relay
  ↓ item/tool/call
Expo（このターンを開始した端末だけ）
  ↓ expo-calendar / EventKit
iOSカレンダー
  ↓ tool result
Expo → Runner relay → Codex
  ↓
回答
```

通常会話では既存のapp-server relayをそのまま使う。Runnerはカレンダー要求を
実行せず、`turn/start`を送ったExpo接続だけへ配送する。Expoが唯一の応答者になる。

書き込み要求を受けた時点でアプリが前面表示でなければ
`foreground_required`を返す。確認画面の表示中にバックグラウンドへ移った場合も
実行せずに終了する。

コンパクト実行中にHTTPへ退避したqueued turnはRunner自身がapp-serverを操作するため、
Expoをtool応答者にできない。この経路でカレンダーtoolが呼ばれた場合、Runnerは
EventKitへ到達させず、読み取りは`device_unavailable`、書き込みは
`foreground_required`を即時応答する。端末配送や新しいdevice routingは追加しない。
通常のWebSocketターンを再送するようユーザーへ案内する。

turn ownerのExpo接続が切れた場合、Runnerは保留中の読み取りへ
`device_unavailable`、保留中の書き込みへ`result_unknown`を返してtool callを終端する。
tool call/resultは再送ログへ入れず、再接続後に再配送もしない。

### 3.2 GPS・時間ルール

```text
位置状態 → Expo → Runner scheduler
                         ↓ 条件成立
                      Codex
                         ↓ 読み取りtoolのみ
                      Runner
                         ↓ 保留 + サイレントPush
                       Expo
                         ↓ expo-calendar
                       Runner → Codex
```

Runnerを時刻判定の権威とする既存設計は変更しない。バックグラウンド処理は時刻を
判定せず、Runnerが作成済みの読み取り要求を処理するだけにする。

サイレントPushが届かない、アプリが明示終了されている、Background App Refreshが
無効、端末がオフラインの場合は`device_unavailable`で安全に失敗する。

## 4. Codex app-serverとの契約

Expoがカレンダーtool handlerを持つ場合、新しい会話の
`thread/start.dynamicTools`へ常に登録する。現在使っているCodex CLIの
実験的schemaでは、`dynamicTools`は`thread/start`だけに存在し、`thread/resume`や
`turn/start`には存在しない。

そのため次の動作に固定する。

- 機能導入後に作成する新規スレッドへだけツールを登録する。
- 既存スレッドへ後付けしない。
- アプリ全体またはディレクトリー単位のカレンダーON/OFF設定は作らない。
- app-server初期化は`experimentalApi: true`にする。
- Codexのバージョンは固定しない。`thread/start`失敗や`item/tool/call`の形を実行時に
  検証し、契約が合わなければ`codex_dynamic_tools_incompatible`で終了する。
- テストではexperimental schemaの現行契約を検証する。

互換性エラーには`code`、`retryable: false`、`expectedContract:
"calendar-dynamic-tools-v1"`、`phase: "thread_start" | "tool_call_parse" | "tool_response"`を含める。
messageは「Dynamic Tools互換性エラーです。phaseを確認し、Bittyのcalendar tool adapterを
現行schemaへ更新してください。」とする。ExpoとRunnerへ同じ内容を出し、機密情報、
内部例外、自動再試行、Dynamic Toolsなしでの継続は含めない。

app-serverから来る要求は次の形である。

```json
{
  "id": 42,
  "method": "item/tool/call",
  "params": {
    "callId": "call_...",
    "threadId": "thread_...",
    "turnId": "turn_...",
    "namespace": null,
    "tool": "calendar_search_events",
    "arguments": {}
  }
}
```

応答は、外側のJSON-RPC `id`へ返す。

```json
{
  "id": 42,
  "result": {
    "success": true,
    "contentItems": [
      {
        "type": "inputText",
        "text": "{\"ok\":true,\"data\":{\"events\":[],\"truncated\":false}}"
      }
    ]
  }
}
```

識別子を混同しない。

- `appServerRequestId`: 外側のJSON-RPC `id`。`string | number`を受け取り、型と値を
  変えずにapp-serverへ返す。
- `callId`: Codexが付けるtool call ID。ターン内の相関用。
- `requestId`: Bittyの配送・重複防止用。
- `namespace`: 現行experimental schemaの必須フィールド。`string | null`のまま保持する。

top-level functionとして登録するため、calendar handlerが受理する`namespace`は
`null`だけとする。非nullは`invalid_arguments`で実行せず終端する。

`requestId`は`threadId`、`turnId`、`callId`、`tool`を連結してSHA-256で生成する。
区切りは各値のUTF-8 byte長を10進数で付けるlength-prefix形式とし、単純連結による
衝突を避ける。全要求で、正規化した引数のSHA-256も`requestHash`として使う。同じ
`requestId`で異なる引数が届いた場合は実行しない。

引数の正規化は、schema検証後の値に対してobject keyを再帰的に昇順化し、array順を
維持してJSON化する。`undefined`、非有限数、schema外フィールドは検証時に拒否する。
文字列をUnicode正規化して意味を変えない。このUTF-8 bytesをhash入力にする。

ドメイン上の失敗はJSON-RPCエラーではなく、`success: false`と固定エラーコードを
含むJSON文字列で返す。不明methodや壊れたJSON-RPCだけをJSON-RPCエラーにする。

tool結果のJSONは次の共通形にする。

```ts
type CalendarToolResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: CalendarErrorCode;
        message: string;
        retryable: boolean;
      };
    };
```

`message`はユーザーへ表示できる短い日本語とし、内部例外やカレンダー本文を含めない。

通常relayは、読み取りを要求到着から30秒で終端する。書き込みはExpoが要求受信から
120秒、Runnerがownerへの転送から125秒で終端する。確認表示開始の通知には依存しない。
timeout、`turn/interrupt`、owner切断時は未応答のserver requestを必ず上記の固定エラーで
閉じる。Runnerはtimeoutとinterrupt時にownerへ`calendar_request_cancel`を送り、
Expo handlerのAbortSignalでmodalを閉じて`received`を`failed`へ変える。通知を失っても
Expo自身の120秒timerが遅延書き込みを防ぐ。

cancel controlのwire形式は次に固定し、relayとdirect `/codex-ws`の両方で同じ形を使う。

```ts
type CalendarCancelControl = {
  channel: "relay";
  op: "calendar_request_cancel";
  operationId: string;
  sessionId: string;
  threadId: string;
  payload: {
    appServerRequestId:
      | { type: "number"; value: number }
      | { type: "string"; value: string };
    turnId: string;
    requestId: string;
    reason: "timeout" | "interrupt";
  };
};
```

## 5. 公開するカレンダーツール

通常会話では6ツール、GPS・時間ルールでは最初の3ツールだけを登録する。

### 5.1 `calendar_list_calendars`

入力は空オブジェクト。返却項目は次に限定する。

```ts
type CalendarSummary = {
  id: string;
  title: string;
  sourceName: string;
  allowsModifications: boolean;
  isDefault: boolean;
};

type CalendarListResult = {
  calendars: CalendarSummary[];
};
```

一覧の`title`は500文字、`sourceName`は200文字で切る。

### 5.2 `calendar_search_events`

```ts
type CalendarSearchInput = {
  start: string;       // offsetを含むISO 8601
  end: string;         // [start, end)
  calendarIds?: string[];
};
```

制限:

- `end`は`start`より後。
- 期間は最大31日。
- `calendarIds`は最大20件。
- `calendarIds`省略時は、取得できるevent calendarのIDを列挙してから検索する。
- `calendarIds`指定時は、全IDが存在することを先に確認する。0件ならEventKitを呼ばず
  空配列を返す。
- EventKitの結果へ`event.start < end && event.end > start`を再適用し、
  終端が検索開始と一致する予定、および開始が検索終了と一致する予定を除く。
- 結果は開始順で最大100件。
- 結果全体はJSON UTF-8で最大128 KiB。
- 1件ずつ追加前に返却全体をJSON化して上限を判定する。最初の1件も入らない場合は
  空配列と`truncated: true`を返す。
- `title`と`calendarTitle`は各500文字で切る。
- 上限超過時は途中まで返し、`truncated: true`を付ける。

検索結果にはメモと場所を含めない。

```ts
type CalendarEventSummary = {
  id: string;
  instanceStart: string | null; // その発生回の実際のstartDate
  calendarId: string;
  calendarTitle: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string | null;
  recurring: boolean;
  detached: boolean;
  allowsModifications: boolean;
  lastModifiedAt: string | null;
};

type CalendarSearchResult = {
  events: CalendarEventSummary[];
  truncated: boolean;
};
```

`recurring`は`recurrenceRule != null || originalStartDate != null || isDetached`で算出する。
`instanceStart`は`recurring`のときだけ実`startDate`を入れ、それ以外は`null`とする。

### 5.3 `calendar_get_event`

```ts
type CalendarGetInput = {
  eventId: string;
  instanceStart?: string;
  detached?: boolean;
};
```

1件だけ再取得し、検索結果の項目に加えて`location`と`notes`を返す。
`title`は500文字、`location`は1,000文字、`notes`は8,000文字で切る。

```ts
type CalendarEventDetail = CalendarEventSummary & {
  location: string | null;
  notes: string | null;
};

type CalendarGetResult = {
  event: CalendarEventDetail;
};
```

`instanceStart`はExpoが返す`startDate`をoffset付きISOへ変換した値とし、
`originalStartDate`（iOSの`occurrenceDate`）ではない。移動済みdetached occurrenceでも
移動後の実startを使う。`instanceStart`がある場合は`getEventAsync`を信用せず、全event
calendar IDを取得してその前後36時間を`getEventsAsync`で検索し、`eventId`、
`startDate === instanceStart`、`isDetached`の期待値が一致する1件だけを返す。
検索結果から詳細取得するときは`instanceStart`と`detached`を組で渡す。
`instanceStart`なしで取得した予定が繰り返しなら`invalid_arguments`を返す。

### 5.4 `calendar_create_event`

```ts
type CalendarCreateInput = {
  calendarId?: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timeZone?: string;
  location?: string;
  notes?: string;
  alarms?: Array<{ minutesBefore: number }>;
};
```

- 時刻予定の`start`と`end`はoffset付きISO 8601で、`timeZone`も必須。
- 終日予定の`start`と`end`は`YYYY-MM-DD`。`end`は終了日の翌日を示す排他的日付。
- `timeZone`はIANA timezone ID。
- `alarms`は最大5件。`minutesBefore`は有限の整数で0以上40,320以下。
  Expoへ渡すときだけ負の`relativeOffset`へ変換する。
- `calendarId`省略時は、書き込み可能な既定カレンダーを使用する。

```ts
type CalendarCreateResult = {
  eventId: string;
  lastModifiedAt: string | null;
};
```

### 5.5 `calendar_update_event`

```ts
type CalendarUpdateInput = {
  eventId: string;
  expectedLastModifiedAt: string | null;
  changes: {
    calendarId?: string;
    title?: string;
    start?: string;
    end?: string;
    allDay?: boolean;
    timeZone?: string;
    location?: string | null;
    notes?: string | null;
    alarms?: Array<{ minutesBefore: number }>;
  };
};
```

実行直前に予定を再取得し、`expectedLastModifiedAt`、繰り返し状態、書き込み可否を
確認する。`expo-calendar`の更新APIは未指定フィールドを消す可能性があるため、
取得済みの現在値へ`changes`をマージし、変更可能フィールドを完全な形で渡す。

EventKitの保存と更新日時確認は原子的ではないため、これは完全なCASではない。
確認後に外部アプリから変更される競合は残ることを既知の制約とする。

`alarms`を変更する場合もcreateと同じ上限を適用する。`allDay`を変更する場合は
`start`と`end`も必須とし、時刻予定へ変更する場合だけ`timeZone`を指定できる。
現在予定または入力の`expectedLastModifiedAt`が`null`なら
`event_version_unavailable`で拒否する。`calendarId`変更を含む保存後は、
`updateEventAsync`の返却IDを正とし、そのIDで再取得した更新日時を返す。
`recurring || detached`なら`recurring_event_write_unsupported`で拒否する。

```ts
type CalendarUpdateResult = {
  eventId: string;
  lastModifiedAt: string | null;
};
```

### 5.6 `calendar_delete_event`

```ts
type CalendarDeleteInput = {
  eventId: string;
  expectedLastModifiedAt: string | null;
};
```

削除直前に予定を再取得し、確認画面にはモデルが渡した文言ではなく、再取得した
実データを表示する。`recurring || detached`なら拒否する。現在予定または入力の
`expectedLastModifiedAt`が`null`なら`event_version_unavailable`で拒否する。

```ts
type CalendarDeleteResult = {
  deletedEventId: string;
};
```

各toolの成功時`data`は上記の対応する型に固定し、任意の`unknown`を返さない。

## 6. 日時の扱い

- 時刻予定はoffset付きISO 8601（`Z`または`±HH:MM`）で入出力し、そのoffsetが示す
  instantを正とする。offsetのない日時は拒否する。
- `timeZone`にはIANA IDだけを返す。
- 時刻予定では`timeZone`を必須にする。そのIANA zoneのoffsetが`start`と`end`
  それぞれのinstantで入力ISOのoffsetと一致することを検証し、不一致なら
  `invalid_arguments`。ExpoからEventKitへ必ずIANA IDを渡し、`timeZone = nil`の
  floating eventを意図せず作らない。
- 終日予定で`timeZone`指定は拒否する。
- 終日予定はfloating dateとして扱い、`new Date("YYYY-MM-DD")`を使用しない。
- 終日予定は`YYYY-MM-DD`と排他的終了日で入出力する。
- EventKitへ渡すときは各日付を端末timezoneのローカル0時として
  `new Date(year, month - 1, day, 0, 0, 0, 0)`相当に変換する。
- EventKitから返る終日予定は、返却instantを端末timezoneの年月日に分解して
  `YYYY-MM-DD`へ戻す。UTCの年月日部分を切り出さない。
- 検索範囲は`[start, end)`。
- DSTは上記のoffsetとIANA zoneの一致確認で扱う。曖昧・存在しないローカル時刻を
  offsetなし文字列から推測する処理は作らない。
- timezoneが得られない時刻予定は`null`のまま返し、Runnerで補わない。
- `allDay`を切り替える更新では`start`と`end`を必須にし、切替後の形式で検証する。
- 不正日付、実在しない暦日、`end <= start`はEventKit呼び出し前に拒否する。

## 7. 権限と画面

読み取りにはEventKitのフルアクセスが必要である。OS権限とBitty内の書き込み確認を
別に扱う。

- iOS 17以降: `NSCalendarsFullAccessUsageDescription`。
- iOS 15、16: `NSCalendarsUsageDescription`。
- 通常会話では、初めてカレンダーtoolを実行した時だけ権限を要求する。
- GPS・時間ルールでは、「カレンダーを参照する」を有効にした時だけ権限を要求する。
- 権限ダイアログは前面表示中にだけ出す。
- バックグラウンド処理中は権限を要求しない。
- 拒否時は設定アプリへの案内を表示する。
- `expo-calendar`でfull accessとwrite-onlyを区別できない版では、
  `calendar_permission_denied`へ統一する。

通常会話用の設定項目は追加しない。権限未決定ならforeground tool handlerが
OS権限を要求し、拒否済みなら`calendar_permission_denied`を返す。書き込みは確認完了後と
EventKit直前にも`AppState === "active"`を確認する。

GPS・時間設定には次を追加する。

- カレンダー端末として登録されているiPhone名または「このiPhone」。
- 各ルールの「カレンダーを参照する」ON/OFF。

既存ルールはすべて`calendarAccess: "none"`として読み込む。更新後にユーザーが
明示的にONへ変更したルールだけ`"read"`にする。

## 8. 書き込み確認と重複防止

作成、更新、削除では、Expo上に次を表示する。

- 操作種別。
- 書き込み先カレンダー。
- タイトル。
- 開始・終了、timezone、終日かどうか。
- 場所、メモ、通知。
- 更新では変更前と変更後。

承認後にだけEventKitを呼ぶ。通知から直接承認する仕組みは作らない。

Expoには書き込み要求だけの小さな永続ledgerを置く。

```ts
type CalendarWriteLedgerEntry = {
  requestId: string;
  requestHash: string;
  state: "received" | "executing" | "succeeded" | "failed" | "result_unknown";
  result?:
    | {
        ok: true;
        data: CalendarCreateResult | CalendarUpdateResult | CalendarDeleteResult;
      }
    | {
        ok: false;
        error: { code: CalendarErrorCode; retryable: boolean };
      };
  updatedAt: string;
};
```

ledgerへ予定タイトル、日時、場所、メモ、全tool引数、EventKitの全結果は保存しない。
成功時は`eventId`と`lastModifiedAt`、失敗時はerror codeと`retryable`だけを保存し、
表示messageはcodeから再構築する。確認中の要求本文と完全なtool結果はメモリだけに置く。

処理順:

1. 引数検証後に`received`を保存する。
2. ユーザー承認後、前面表示を再確認してから`executing`を保存する。
3. EventKit直前にもう一度前面表示を確認する。
4. 成功または既知の失敗を保存してからapp-serverへ返す。
5. 起動時に残った`received`は`failed`へ変え、`request_cancelled`を保存する。
6. 起動時に残った`executing`は`result_unknown`へ変える。
7. `result_unknown`は自動再実行しない。
8. `succeeded`または`failed`の再配送では保存済み結果だけを返す。

ledgerはアプリのdocuments領域にJSONで保存し、一時ファイルからrenameする。
最大100件または30日で古い終端項目を削除する。起動時の上記復旧を先に行うため、
`received`と`executing`が無期限に残ることはない。EventKitとledgerを原子的に更新
できないため、書き込みは「exactly once」
ではなく「at-most-once attempt」と定義する。

前面離脱、ユーザー拒否、timeout、`turn/interrupt`では、まだ`received`なら
`failed`へ変えてEventKitを呼ばない。`executing`後に接続または制御を失った場合だけ
`result_unknown`とする。RunnerはExpoの応答を待つ間にownerを失うと、tool種別だけを
見て読み取りは`device_unavailable`、書き込みは`result_unknown`でapp-server要求を
終端する。遅れて届いた結果はapp-serverへ再送しないが、Expoのledgerには保存する。
Expoはowner接続終了、`calendar_request_cancel`、120秒timerを同じAbortSignalへまとめ、
modalを閉じた後の承認callbackを無効化する。
共通abort処理は`received`なら`failed/request_cancelled`、`executing`なら
`result_unknown`を即時応答する。abort後にEventKitが完了してもledgerだけを更新し、
wireへ結果を送らない。

## 9. バックグラウンド読み取り

バックグラウンド対象は読み取り3ツールだけである。Runnerは接続状態にかかわらず
要求をメモリ上に最大60秒保留し、対象端末へ内容を含まない
`calendar_request_available`サイレントPushを送る。初回実装では、GPS・時間ルール用に
別のWebSocket配送経路を追加しない。

Expoの通知Taskは次の順で動く。

1. Pushのmarkerだけを判定する。
2. SecureStoreから`deviceId`とRunner認証情報を読む。
3. 認証付きHTTPで自端末の保留要求を最大3件取得する。
4. 各要求の直前にruleの`calendarAccess: "read"`、対象device ID、期限を確認する。
5. カレンダー権限が既にある場合だけ読み取る。バックグラウンドでは要求しない。
6. EventKit完了後とPOST直前に、rule ID/revision/access、device ID、期限を
   もう一度読み直す。1つでも変わっていれば結果を送らない。
7. 全体18秒のdeadline内で結果を返し、残りは処理しない。

GETとPOSTは各5秒でAbortControllerにより中断する。EventKit読み取りは1要求8秒の
logical timeoutを設け、timeout後の結果をPOSTしない。残り時間が5秒未満なら新しい
要求を開始しない。これによりiOSの終了猶予を使い切らない。

API:

```text
GET  /calendar/requests?deviceId=<stable-device-id>
POST /calendar/requests/<requestId>/result
```

GETの応答:

```ts
type PendingCalendarReadRequest = {
  requestId: string;
  requestHash: string;
  ruleId: string;
  ruleRevision: string;
  tool:
    | "calendar_list_calendars"
    | "calendar_search_events"
    | "calendar_get_event";
  arguments: unknown;
  expiresAt: string;
};

type CalendarRequestsResponse = {
  requests: PendingCalendarReadRequest[];
};
```

POSTのbody:

```ts
type CalendarResultBody = {
  deviceId: string;
  requestHash: string;
  result: CalendarToolResult<
    CalendarListResult | CalendarSearchResult | CalendarGetResult
  >;
};
```

結果POSTには`deviceId`、`requestHash`、構造化結果を含める。Runnerは対象端末、
期限、request hash、未完了状態が一致した場合だけ受理する。
Expoは`ruleId`と`ruleRevision`が現在保存されている有効ruleと一致し、
`calendarAccess: "read"`かつ自端末IDである場合だけEventKitへ進む。

通知Taskは有効な位置・時間ルールがある間だけ登録する。calendar markerは現在のruleが
`calendarAccess: "read"`でなければEventKitへ進まない。登録解除失敗やRunner上の古い
要求を認可境界にしない。

APNs payloadには予定名、日時、メモ、場所、tool引数を含めない。Pushは
`content-available: 1`、background push、priority 5で送る。

サイレントPushはヒントでありジョブキューではない。届かなければ失敗で終了し、
同じCodexターンを自動再実行しない。

`expo/index.ts`はnotification task定義を最初にimportするが、
`bootstrapLocationSchedules()`をmodule top-levelで呼ばない。通常起動時のApp側effectへ
移し、`AppState === "active"`のときだけ呼ぶ。headless notification起動でRunner同期、
位置権限、task再調整が並行実行される副作用をなくす。

## 10. GPS・時間ルールの安全境界

`LocationScheduleRule`へ次を追加する。

```ts
type CalendarAccess = "none" | "read";

type CalendarRuleFields = {
  calendarAccess: CalendarAccess;
  calendarDeviceId: string | null;
};
```

`calendarAccess: "read"`のルールは次の条件でCodexを開始する。

- Runnerへ最後に同期されたruleが有効で`calendarAccess: "read"`。
- `experimentalApi: true`。
- `dynamicTools`はlist、search、getだけ。
- `approvalPolicy: "never"`。
- `turn/start.sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" }`。
- external sandbox workerはhost filesystemをmountせず、空のread-only filesystemと
  scrub済み環境変数だけをtool processへ渡す。Runner/Codex認証情報を渡さない。
- calendar付きscheduleは必須の`CALENDAR_CODEX_WS_UPSTREAM_URL`だけへ接続し、既存の
  共有`CODEX_WS_PROXY_UPSTREAM_URL`へrouteまたはfallbackしない。
- 認証付き`CALENDAR_CODEX_CAPABILITY_URL`が`calendar-read-v1`、host mountなし、
  inherited envなし、tool networkなしを返すことを起動前に確認する。
- `thread/start.config`で`web_search: "disabled"`、appsとagentsを無効化する。
- `config/read`と`plugin/list`後、有効pluginごとに`plugin/read`して全MCPを無効化する。
  thread作成後・turn開始前の`mcpServerStatus/list(threadId)`が0件でなければ失敗する。
- 専用URL未設定、capability不一致、接続失敗ならturnを開始せず`calendar_api_failed`。

予定のタイトル、場所、メモは命令ではなく外部データであることをdynamic toolの説明と
developer instructionの両方へ明記する。カレンダー内容を読んだことを根拠に、
コマンド実行、ファイル変更、ネットワーク送信、カレンダー書き込みを指示しない。
組み込みshellが存在しても、host file・host環境変数・networkへ到達できないことを
外部sandboxの合格条件にする。

カレンダー参照をONにすると、そのルールは隔離external sandboxで動くことを設定画面に
表示する。既存ルールの動作を黙って変えない。

RunnerはExpoの`bitty-settings.json`を直接読まない。Runner側のruleが古くても、
Expoのbackground handlerが現在のrule ID/revision/access/device IDを再確認する。
Runnerの開始判定は無駄なturnを減らす条件、Expoのlive gateはEventKitの最終認可境界とする。

## 11. 端末の扱い

Expoが既に生成している`bitty.pushDeviceId.v2`をカレンダー端末IDにも使う。
ルール保存時に、その端末IDを`calendarDeviceId`へ入れる。

初回実装では次に固定する。

- 通常会話は`turn/start`を送ったExpo接続だけが処理する。
- GPS・時間ルールは保存時の`calendarDeviceId`だけが処理する。
- 別端末へのフォールバックはしない。
- `calendarAccess: "read"`を持つ全ルールは、同じ`calendarDeviceId`でなければならない。
- 別iPhoneへ切り替える場合は、既存ルールのカレンダー参照をすべてOFFにしてから
  新しい端末でONにする。

既存のRunner Bearer tokenは共有資格情報なので、device IDは端末の取り違え防止で
あり、強い端末認証ではない。複数端末対応時は端末別secretを別設計する。

## 12. Expo側の実装修正

### 依存関係とネイティブ設定

| ファイル | 修正 |
| --- | --- |
| `expo/package.json` | `expo-calendar`をSDK 54互換の`15.0.8`へ固定。`patch-package`と`postinstall`を追加 |
| `expo/package-lock.json` | 上記依存を固定 |
| `expo/app.json` | `expo-calendar` pluginと新旧カレンダー用途説明を追加 |
| `expo/patches/expo-calendar+15.0.8.patch` | 下記3点のiOS修正を固定 |

`expo-calendar` 15.0.8のiOSコードには予定開始日時を`print`する箇所があるため削除する。
また、timezone返却をローカライズ済み短縮名ではなく`TimeZone.identifier`へ変更する。
リマインダー機能を無効にした場合は、起動時に未設定のリマインダー権限文言を参照しない。
パッチが適用できない依存更新はinstall時に失敗させ、無視しない。

### カレンダー境界

新規ディレクトリは`expo/src/features/calendar/`だけにする。

| ファイル | 責任 |
| --- | --- |
| `calendarToolSpecs.ts` | 通常会話用6ツールのschema |
| `calendarService.ts` | 権限、入力検証、日時正規化、繰り返し発生回の検索、expo-calendar呼び出し |
| `calendarToolHandler.ts` | `item/tool/call`の検証、確認UI呼び出し、結果整形 |
| `calendarWriteLedger.ts` | 書き込み状態の原子的保存と重複防止 |
| 対応する`.test.ts` | 上記の単体テスト |

`calendarService.ts`はReact状態やRunner通信を持たない。
`calendarToolHandler.ts`はEventKit固有値を直接扱わない。この2つはOS境界と
tool境界という別責任があるため分ける。それ以外の汎用repositoryやproviderは作らない。

### 既存ファイル

| ファイル | 修正 |
| --- | --- |
| `expo/src/features/codex/client/turn.ts` | 新規thread/startへ6ツールを登録。`item/tool/call`をcalendar handlerへ渡す |
| `expo/src/features/codex/client/types.ts` | JSON-RPC IDを`string | number`のまま扱い、カレンダー確認callbackと結果型を追加 |
| `expo/src/features/app/hooks/useCodexReplyRequest.ts` | calendar確認callbackをturn実行へ渡す |
| `expo/src/features/app/hooks/useCalendarWriteRequestController.ts` | 書き込み確認の待機、承認、背景遷移時の拒否 |
| `expo/src/features/app/components/CalendarWriteApprovalModal.tsx` | カレンダー専用の確認画面 |
| `expo/src/features/app/components/AppOverlays.tsx` | 上記モーダルを既存overlayへ接続 |
| `expo/src/features/app/AppRoot.tsx` | controllerとturn callbackの接続、通常起動時のlocation bootstrapを追加 |
| `expo/src/features/locationSchedules/locationScheduleRules.ts` | `calendarAccess`と`calendarDeviceId`、revision計算を追加 |
| `expo/src/features/locationSchedules/LocationScheduleSettings.tsx` | 明示的な読み取りON/OFFとforeground権限要求を追加 |
| `expo/src/features/locationSchedules/locationScheduleRuntime.ts` | 通知Task定義を共通routerへ移す |
| `expo/src/features/app/utils/pushNotifications.ts` | calendar requestの取得・結果送信を追加 |
| `expo/index.ts` | task定義を先にimportし、module top-levelのlocation bootstrapを削除 |

通知Taskは`expo/src/features/app/utils/backgroundNotificationTask.ts`へ1つだけ定義し、
`location_state_refresh`と`calendar_request_available`をmarkerで分岐する。
有効な位置・時間ルールがある間だけTask登録を維持する。

## 13. Runner側の実装修正

### 新規ファイル

| ファイル | 責任 |
| --- | --- |
| `private_runner/src/calendar-tool-service.mjs` | 読み取りtool schema、保留Map、Push、期限、結果検証 |
| `private_runner/tests/calendar-tool-service.test.mjs` | 配送・期限・端末不一致・重複結果のテスト |

保留Mapは読み取り要求だけなので永続化しない。Runner再起動後に元のapp-server callへ
応答できないため、復元可能に見せる永続キューを作らない。

### 既存ファイル

| ファイル | 修正 |
| --- | --- |
| `private_runner/src/codex-turn-execution.mjs` | `dynamicTools`、external sandbox、MCP/plugin preflight、server request handler、型付きIDを扱う |
| `private_runner/src/location-schedule-service.mjs` | ruleのcalendar項目を検証し、external sandbox条件でCodexを起動 |
| `private_runner/src/server-runtime.mjs` | 専用upstream/capability必須化、calendar service、HTTP、対象端末Pushを接続 |
| `private_runner/src/push-device-store.mjs` | device ID指定取得を追加。汎用選択ロジックは追加しない |
| `private_runner/tests/codex-turn-execution.test.mjs` | experimental初期化、dynamicTools、server responseを追加 |
| `private_runner/tests/location-schedule-service.test.mjs` | 既存ruleのnone移行、external sandbox起動を追加 |
| `private_runner/tests/runner-ws-multiplex.test.mjs` | tool callがturn ownerだけへ届くことを追加 |

`createCodexRpcClient`は、`method`と`id`の両方を持つmessageをnotificationとして
捨てず、server request handlerへ渡す。handlerの結果を同じ型・値の`id`へ返す。
Runner initiatedのqueued turnにはカレンダー実行handlerを接続せず、calendar tool名なら
readは`device_unavailable`、writeは`foreground_required`を返す固定handlerを接続する。
これにより既存threadがdynamic toolを保持していてもturnを停止させない。

対話relayでは`turn/start`を送った接続をturn ownerとして記録する。
`item/tool/call`はownerだけへ送り、observerへbroadcastしない。tool callとtool resultは
relayの汎用event logへ保存・再送しない。owner以外から同じRPC IDへの応答が来た場合は
Runnerで破棄する。

ownerは接続だけでなく`(connection, operationId, sessionId, turnId)`で識別する。
配送と応答受理のすべてでこのtupleを照合し、同じWebSocket上のobserverや別turnを
ownerとして扱わない。

JSON-RPC IDは`parseCodexRpcMeta`、ack、request/pending Mapの全経路で数値化しない。
Map keyはnumberを`n:<値>`、stringを`s:<値>`へencodeし、`42`と`"42"`を別要求として
扱う。wire responseには保存した元の型・値をそのまま使う。

relayは各server requestにowner tuple、tool名、deadlineだけを保持する。owner切断、
`turn/interrupt`、deadline超過時は固定失敗をapp-serverへ一度だけ返し、pendingから
削除する。再接続したExpoを同じ要求へattachしない。遅い応答は破棄する。

event log除外は`item/tool/call`要求だけでなく、calendar dynamic toolの引数を含む
`item/started`と結果を含む`item/completed`にも適用する。item typeが
`dynamicToolCall`でtool名が`calendar_` prefixなら保存・replay・debug `head`生成を
行わず、live broadcastもowner tupleだけに限定してobserverへ送らない。

既に1万行を超えている`server-runtime.mjs`へカレンダー業務ロジックを追加しない。
同ファイルにはrouteとservice接続だけを置く。

## 14. エラー契約

固定コード:

- `calendar_permission_undetermined`
- `calendar_permission_denied`
- `calendar_not_found`
- `calendar_read_only`
- `event_not_found`
- `event_changed`
- `event_version_unavailable`
- `recurring_event_write_unsupported`
- `invalid_arguments`
- `invalid_date_range`
- `foreground_required`
- `user_denied`
- `device_unavailable`
- `calendar_device_ambiguous`
- `request_expired`
- `request_conflict`
- `request_cancelled`
- `result_unknown`
- `calendar_api_failed`
- `codex_dynamic_tools_incompatible`

0件と取得失敗を区別する。内部例外、予定内容、認証情報をエラーメッセージへ含めない。

## 15. ログとプライバシー

- カレンダー名、予定名、日時、場所、メモ、tool引数、tool結果をログへ出さない。
- ログへ出せるのはrequest IDの先頭、tool名、件数、状態、所要時間だけ。
- Runnerのdebug log、relay event log、例外の`head`へカレンダー本文を入れない。
- APNsにはmarkerだけを入れる。
- Runnerはバックグラウンド要求を最大60秒だけメモリ保持する。
- Expoの書き込みledgerには要求と結果を必要最小限だけ保存する。
- カレンダーの読み取り結果はCodexのスレッド履歴へ入ることを設定画面で説明する。
- 予定内の文字列はすべて非信頼データとして扱う。

## 16. 実装順

### Phase 1: Expo単体

1. `expo-calendar`、用途説明、ネイティブpatchを導入する。
2. 初回利用時のforeground権限要求とbackground非要求を実装する。
3. list、search、繰り返し発生回を含むgetと日時正規化を実装する。
4. write ledger、create、update、deleteを実装する。
5. Expo単体テストとiOS Release buildのログ検査を行う。

完了条件: Codexを通さず、テスト用呼び出しで実機カレンダーを安全に読み書きできる。

### Phase 2: 通常会話

1. 新規threadへ6ツールを登録する。
2. relayをturn owner限定配送へ修正する。
3. queued turn用の固定失敗handlerを追加する。
4. Expo handlerと書き込み確認画面を接続する。
5. 新規thread、既存thread、再接続、重複RPCをテストする。

完了条件: 「今日の予定は？」と、確認付きの作成・更新・削除が前面表示で動く。

### Phase 3: GPS・時間ルール

1. ruleへ明示的な`calendarAccess`と端末IDを追加する。
2. Runner-started app-server clientをserver request対応にする。
3. 読み取りtool、external sandbox、保留Map、HTTP、Pushを接続する。
4. headless起動から通常bootstrapの副作用を除く。
5. 実機で前面、背景、明示終了、通信断を確認する。

完了条件: 条件成立時に、端末を起動できた場合だけ予定を参照して回答できる。

各Phaseを独立して完了させる。Phase 2が安定するまでPhase 3へ進まない。

## 17. テスト

### 自動テスト

- 権限未決定、許可、拒否。
- 初回foreground tool callで権限を要求し、backgroundでは要求しないこと。
- handlerを持つ新規threadへ常に6ツールを登録し、既存threadへ後付けしないこと。
- 31日、100件、128 KiBの境界。
- 先頭1件が128 KiBへ入らない場合に空配列と`truncated: true`になること。
- calendar IDs省略、存在しないID、空のevent calendar一覧、検索境界の重なり判定。
- timezone、DST、offsetとIANA zone不一致、終日予定、排他的終了日。
- 時刻予定のtimeZone省略を拒否し、EventKitへ常にIANA IDを渡すこと。
- 端末timezoneがUTC以外でも終日日付がずれず、`new Date("YYYY-MM-DD")`を通らないこと。
- all-dayでのtimezone拒否、all-day切替時のstart/end必須。
- 検索結果にnotes/locationが入らないこと。
- 繰り返し予定の2回目以降を`eventId + instanceStart`で正しく取得すること。
- detached occurrenceは移動後`startDate`をinstanceStartとして取得すること。
- detachedまたはoriginalStartDateありの予定を、recurrenceRuleがnullでも書き込み拒否すること。
- `instanceStart`なしの繰り返し詳細取得を拒否すること。
- 作成・更新・削除の承認、拒否、背景遷移。
- 書き込みの要求到着後、承認後、`executing`直前、EventKit直前の背景遷移。
- alarmの件数、非整数、非有限数、上限値。
- 部分更新で未指定フィールドが消えないこと。
- lastModifiedAtがnullの更新・削除を`event_version_unavailable`で拒否すること。
- calendar移動後はAPI返却の新しいevent IDで結果を返すこと。
- 繰り返し予定と読み取り専用カレンダーの拒否。
- ledgerの各状態と、`received`/`executing`を含む各保存地点でのクラッシュ復旧。
- 同じrequest ID、異なるhash、同時タップ、結果再送。
- canonical JSONでobject key順がhashへ影響せず、array順が影響すること。
- dynamicToolsが新規threadにだけ入ること。
- Codexを固定せず、`thread/start`拒否、tool callの必須フィールド不足、tool応答拒否を
  正しい`phase`の`codex_dynamic_tools_incompatible`として出し、再試行・fallbackしないこと。
- server requestのstring/number外側ID、namespace、call IDを混同しないこと。
- `42`、`"42"`、非数値string IDがpending/ack Mapで衝突せず、非null namespaceを拒否すること。
- turn owner以外へtool callを送らないこと。
- 同一WebSocketの別operation/session/turnをownerと誤認しないこと。
- owner切断、interrupt、timeoutでread/writeが一度だけ終端し、再接続で再送されないこと。
- Expo 120秒、Runner 125秒timeoutとcancel通知喪失の全経路で遅延writeしないこと。
- cancel controlがowner tupleと型付きRPC IDに一致する要求だけをabortすること。
- `executing`中timeoutは即時`result_unknown`となり、遅いEventKit結果を送信しないこと。
- compact queued turnの全calendar toolが固定失敗になり、turnが停止しないこと。
- 既存GPS・時間ruleが`calendarAccess: "none"`になること。
- calendar ruleが隔離external sandboxかつ読み取り3ツールだけであること。
- schedule turnのexternal sandboxからhost file、host環境変数、networkへ到達できず、
  web/apps/MCP/plugin MCP/agentsがないこと。専用URL・能力確認失敗時は起動せず、
  共有upstreamへfallbackしないこと。
- 端末不一致、期限切れ、Runner再起動、壊れた結果の拒否。
- ruleのcalendar accessが`none`ならGET/EventKitを呼ばないこと。
- 有効な位置・時間ルールがない時だけ共通Taskを解除すること。
- headless通知起動でlocation bootstrapが走らないこと。
- GET/POST/全体deadline超過時に安全に打ち切ること。
- EventKit完了後またはPOST直前のrule変更/device変更で結果を送らないこと。
- ログ、APNs、relay event logへカレンダー内容が出ないこと。
- calendar dynamic toolの`item/started`と`item/completed`もevent logへ入らないこと。
- 上記2通知がowner以外へlive broadcastされないこと。
- 悪意ある予定メモを読んでも、ファイル変更や外部送信が起きないこと。

### 実機テスト

- iOS 15または16とiOS 17以降での権限表示、iCloudとGoogleカレンダーの読み取り。
- 前面での作成・更新・削除、終日予定とDSTをまたぐ予定。
- Release buildで予定日時がconsoleへ出ず、背景サイレントPushから読み取れること。
- アプリ終了、Background App Refresh無効、rule変更後の古いPushで安全に失敗すること。

Expo GoとSimulatorだけを合格条件にしない。

実行コマンド:

```sh
cd expo
npm test -- --runInBand
npx expo prebuild --platform ios --clean
npx expo run:ios --configuration Release

cd ../private_runner
node --test tests/calendar-tool-service.test.mjs
node --test tests/codex-turn-execution.test.mjs
node --test tests/location-schedule-service.test.mjs
node --test tests/runner-ws-multiplex.test.mjs
```

## 18. 完了条件

- 新規の通常会話から予定一覧、詳細、繰り返し予定の指定発生回を取得できる。
- 前面での明示承認後に限り単発予定を作成・更新・削除できる。
- 初回foreground利用時だけ権限を要求し、backgroundでは権限ダイアログを出さない。
- 同じ書き込み要求を二度実行せず、成否不明なら自動再試行しない。
- 明示的に許可したGPS・時間ルールだけが読み取れ、書き込みtoolは公開されない。
- GPS・時間ルールは隔離sandboxで動き、背景失敗を成功扱いにせず、tool callを未応答で残さない。
- カレンダー内容がAPNs、Runnerログ、relay event logへ出ない。
- ExpoとRunnerの自動テスト、iOS実機テスト、Release build検証が完了している。

## 19. 残るリスク

- dynamic toolsは実験的APIである。バージョンは固定せず、実行時エラーと契約テストで
  変更箇所を特定して追従する。
- サイレントPushはiOSが実行を保証しない。
- EventKit更新直前の外部変更を完全には排除できない。
- EventKit成功直後にアプリが停止すると`result_unknown`になる。
- EventKitアカウント同期中は外部サービスの最新状態でない可能性がある。
- `expo-calendar`のnative patchはバージョン更新ごとに再確認が必要。

これらは自動再試行や同期DBで隠さず、ユーザーへ失敗として表示する。
