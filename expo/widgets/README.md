# Bitty iOS widget

Home Screen widgets require iOS 17 or later. The main app retains its existing iOS 16.4 minimum.
After installing a native build, open Bitty and connect to the Runner once. Add **Bitty オーケストレーター**
from the Home Screen widget gallery. Long-press **Edit Widget** to select an existing orchestrator.
Add multiple widgets to keep different voice recipients nearby.

- Small: recipient icon/name, global running agents, remaining 5h/weekly allowance, voice shortcut.
- Medium/large: the same information plus the existing global main To Do overview.
- The voice shortcut opens the existing app voice conversation and starts recording once the app is active
  and that recipient is ready. Recording is not performed inside the widget extension.
- Snapshots update while the app is active. The extension has no Runner connection or credentials;
  closing the app does not keep polling the server. Snapshot expiry entries turn cached metrics into
  `--` after 15 minutes. The displayed update time and “アプリで更新” distinguish cached information.
- To Do time and usage time come from their own fetches, not unrelated icon/count updates. The widget
  never falls back to the original task checklist or stores chat messages.

`plugins/withBittyWidgets.js` recreates the extension, host/extension App Group entitlements, build phases,
embedding and dependency during Expo prebuild. The group identifier is derived from the app bundle ID.
The small local `modules/bitty-widgets` module writes only display data atomically into that group,
resizes embedded icons and requests WidgetKit reloads. App Groups must be available in the development
team's automatic signing profiles for both targets; no profiles or credentials belong in this directory.

Checks:

```sh
npm run typecheck
npm test -- --runInBand src/features/app/contexts/OrchestratorStatusContext.test.tsx
node --test plugins/withBittyWidgets.node-test.cjs
```
