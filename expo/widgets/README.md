# Bitty iOS widget

Home Screen widgets require iOS 17 or later. The main app retains its existing iOS 16.4 minimum.
After installing a native build, open Bitty and connect to the Runner once. Add **Bitty オーケストレーター**
from the Home Screen widget gallery. Long-press **Edit Widget** to select an existing orchestrator.
Add multiple widgets to keep different voice recipients nearby.

- Small: recipient icon/name, global running agents, remaining 5h/weekly allowance, voice shortcut.
- Medium/large: the same information plus the existing global main To Do overview.
- The voice shortcut opens the existing app voice conversation and starts recording once the app is active
  and that recipient is ready. Recording is not performed inside the widget extension.
- Foreground and background use the same authenticated `/app/status-snapshot` read model. With existing
  Push/APNs configured and notification permission granted, changes to tasks, orchestrators, execution
  or usage send a silent refresh hint. Ordinary completion, voice completion, approval, usage-limit and
  schedule-failure notifications also request a refresh through `content-available`, in foreground or
  background. The native host fetches and saves data through the same path without opening the app UI.
  Only dedicated silent hints coalesce to at most one per 20 minutes; ordinary notifications do not wait
  for that timer. iOS may delay or omit the app callback even when an alert appears, particularly after
  force-quit. No continuous polling or exact update interval is promised. An installed widget is required.
- Last-known values remain visible with “更新待ち” and usage clock indicators when stale. Missing values
  show `--`; timestamps remain tied to the actual field fetch. A Runner change clears its previous snapshot.
  The extension still receives only display data, never credentials or a Runner connection.
- To Do time and usage time come from their own fetches, not unrelated icon/count updates. The widget
  never falls back to the original task checklist or stores chat messages.

`plugins/withBittyWidgets.js` recreates the extension, host/extension App Group entitlements, build phases,
embedding and dependency during Expo prebuild. The group identifier is derived from the app bundle ID.
The small local `modules/bitty-widgets` module writes only display data atomically into that group,
resizes embedded icons and requests WidgetKit reloads. Native refresh uses the existing app Keychain,
paired TLS trust and same-origin Cloudflare headers; App Group credentials and Keychain sharing are not added.
Responses must pass the display schema, source identity and ordering checks before an atomic write. App Groups must be available in the development
team's automatic signing profiles for both targets; no profiles or credentials belong in this directory.

## Diagnosing a missed refresh

The host and widget extension both emit `[widget-refresh]` at OSLog **notice** level with subsystem
`app.bitty.widgets` and category `refresh`. Notice logs can be retained by iOS; retention is limited, so
start a filtered capture **before reproducing**. Do not collect a whole-device log archive. With the
iPhone connected to the Mac and trusted, the existing `idevicesyslog` tool can capture just these lines:

```sh
idevicesyslog --no-colors --match '[widget-refresh]' --output /private/tmp/bitty-widget-refresh.log
```

Stop with Ctrl-C after two normal chats have finished and the widget has been observed. Alternatively,
select the connected iPhone in macOS Console and filter by subsystem `app.bitty.widgets`; include both
the Bitty host process and widget extension. Do not launch the app to collect logs, since foreground
refresh would obscure the background result. Read only the filtered capture and Runner lines beginning
`[widget-refresh]` in `private_runner/logs/run-local.log`.

Every notification receipt gets a random `id`, passed to the native refresh and HTTP request. Runner
`event=response` logs the same validated UUID, HTTP status, returned count and duration after the response
finishes. App-initiated refreshes have their own ID and `app_initiated=true`; notification-triggered refreshes
have `app_initiated=false` even if the app is active. `event=received` records UIKit state (`0` active, `1` inactive, `2` background),
and `silent` distinguishes the dedicated hint from an ordinary notification. No receipt line means the
host callback was not observed during capture; displaying a notification through the service extension
does not prove that this callback ran.

Follow the ID through `event=http`, `event=decoded`, and `event=save`. A successful save records `count`
and `updated_at_ms`; the widget's `event=timeline` records those same fields when it reads that snapshot.
`event=preview` is a gallery/system snapshot request, not a timeline reload. `count=-1` means unknown.
Failures use fixed outcome codes for unavailable configuration/connection, source changes, superseded
requests, transport/HTTP/schema failures, the 22-second deadline, and writes. A `reload outcome=requested`
line confirms the call to WidgetKit, not that iOS rendered the widget immediately. Matching saved and
timeline timestamps with different visible UI points to WidgetKit presentation, while a newer save with
no subsequent timeline read separates scheduling from fetching/saving. Log timestamps identify the
reproduction window; IDs are unrelated to chat/session/account identity. Logs contain no notification
body, task overview, recipient names/icons, URLs, credentials, session IDs or raw error messages.

Checks:

```sh
npm run typecheck
npm test -- --runInBand src/features/app/components/WidgetSnapshotPublisher.test.tsx
node --test plugins/withBittyWidgets.node-test.cjs
```
