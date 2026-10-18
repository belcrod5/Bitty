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
  or usage send a silent refresh hint. The native host fetches and saves data without opening the app UI.
  Hints coalesce to at most one per 20 minutes; iOS may delay or drop them (including after force-quit).
  No continuous polling or exact update interval is promised. A registered installed widget is required.
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

Checks:

```sh
npm run typecheck
npm test -- --runInBand src/features/app/components/WidgetSnapshotPublisher.test.tsx
node --test plugins/withBittyWidgets.node-test.cjs
```
