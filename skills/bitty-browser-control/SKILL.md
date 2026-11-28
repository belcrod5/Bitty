---
name: bitty-browser-control
description: Let users remotely operate an existing local Chromium page from a Bitty chat panel by clicking, scrolling, dragging and typing, without exposing screen images or user input to the AI.
---

# Remote browser control

Use this skill when the user wants to operate a browser page from Bitty chat, or when an agent browser task needs a manual step. The user can click, scroll, drag and type on the actual page. Private input is one use case; never ask for a private value through ordinary chat or request_user_input.

The browser must expose local Chromium CDP. Both a direct **page** WebSocket and Chrome's user-enabled **browser** WebSocket with an explicit page target ID are supported. A browser-tool tab ID alone is insufficient unless it is the actual CDP target ID for this browser. External CUA/in-app browsers without a local CDP connection are unsupported. Do not launch a different profile or copy a profile to bypass a connection failure.

For ordinary Chrome, enable remote debugging at `chrome://inspect/#remote-debugging` on the Mac. This is Chrome's native permission flow: Chrome asks for approval on the Mac for each new connection, including discovery and opening/reopening a panel. It cannot be approved solely from the Bitty iPhone panel. Allow up to 60 seconds for that approval. Rejection or timeout does not justify switching profiles or retrying repeatedly.

1. Identify the intended existing page and its exact HTTP(S) origin, without reading private fields. If an existing connection supplies its CDP target ID, use it. Otherwise, **before a panel exists**, run origin-filtered discovery below. It reads `DevToolsActivePort`, so Chrome's `/json/version` and `/json/list` need not work.
2. Discovery returns only matching page IDs and origins, never titles, full URLs, images or page contents. An empty list means no matching page is open in that browser. Multiple matches can span profiles: do not guess which one is the user's intended profile/tab from origin alone. Resolve the intended tab with the user or known browser metadata before requesting a panel. Never rediscover while any panel for this browser is pending/active.
3. Request a card using the **current turn's** Bitty app controlContext and explicit page ID. BITTY_REPO_ROOT must point to the repository running the Runner (automatically discovered if you are inside it). The user data directory is the Chrome root containing `DevToolsActivePort`, not its `Default`/`Profile N` subdirectory. No field selectors, option lists, DOM inspection, or private values are needed.
4. Tell the user to tap 「ブラウザを開く」 once and approve Chrome's connection on the Mac if prompted. Card creation opens no browser connection. The command returns pending immediately. End the AI turn; do not wait, poll, or automatically resume.

```sh
# macOS ordinary Chrome; use the actual browser's user data directory on other systems.
node <skill-directory>/scripts/bitty-browser-control.mjs discover \
  --user-data-dir "$HOME/Library/Application Support/Google/Chrome" \
  --origin https://example.com

node <skill-directory>/scripts/bitty-browser-control.mjs request \
  --context ctx_CURRENT_TURN \
  --user-data-dir "$HOME/Library/Application Support/Google/Chrome" --target-id PAGE_ID \
  --origin https://example.com --label 'ブラウザを操作してください（MacのChromeで接続を許可）'
```

Discovery errors contain fixed recovery instructions: enable debugging/check the data directory, reopen Chrome debugging settings if its endpoint is invalid, or approve the Mac permission and explicitly retry after a timeout. Do not print the `DevToolsActivePort` contents or raw protocol errors into chat. A stale/missing selected target or changed origin must be resolved before requesting another card; never silently select another tab.

An existing direct page WebSocket remains usable without discovery. A known browser WebSocket may instead use `--cdp-url ws://127.0.0.1:9222/devtools/browser/BROWSER_ID --target-id PAGE_ID`. Browser endpoints always require an explicit page ID.

```sh
node <skill-directory>/scripts/bitty-browser-control.mjs request \
  --context ctx_CURRENT_TURN \
  --cdp-url ws://127.0.0.1:9222/devtools/page/PAGE_ID \
  --origin https://example.com --label 'ブラウザを操作してください'
```

When the user explicitly asks to redisplay or replace the panel, use `replace` with the same connection options and explicit page target and the **current turn's** context. It cancels the previous panel only if it belongs to this authenticated device and conversation, then creates a new pending card. Validation failures leave the old panel available. The replacement retains the same page's last origin approved during manual control. Browser/page state and entered values remain in place; no browser connection is opened until the user taps Open. Ordinary `request` never cancels another card automatically.

```sh
node <skill-directory>/scripts/bitty-browser-control.mjs replace \
  --context ctx_CURRENT_TURN \
  --cdp-url ws://127.0.0.1:9222/devtools/page/TAB_ID \
  --origin https://example.com --label 'ブラウザ操作の再表示'
```

When the user explicitly asks to close the panel, cancel that request using the current context:

```sh
node <skill-directory>/scripts/bitty-browser-control.mjs cancel \
  --context ctx_CURRENT_TURN --request UUID
```

Cancellation ends only the private control panel and discards queued input; it does not close the browser tab or undo actions already applied. Cancellation/replacement replies remain fixed status metadata. An uncertain in-flight action stays marked uncertain on a replacement card; never replay it to check the result.

The card stays in its original session/orchestrator after switching chats or ending a turn. It can be created while the originating phone is offline or in the background: creation records only card metadata and opens no browser connection. Opening or reopening the card establishes a fresh connection after checking the original authenticated login/device and mounted conversation. Wi-Fi changes and backgrounding clear the private view, keyboard and unsent input; the same card can be explicitly reopened. Input is never automatically replayed. Unopened/paused cards are retained in Runner memory for up to 24 hours from creation; Runner restart or logout ends recovery.

The page uses mouse-mode touchpad controls: slide one finger to move the visible cursor relatively, tap to click at the cursor, and double-tap then drag to hold the mouse button and move an object or select text. Parallel two-finger movement scrolls the website horizontally or vertically; pinching zooms the private view locally without a mode switch. While zoomed, one-finger movement immediately pans the view to keep the cursor centered as far as page boundaries allow; at normal scale the cursor moves freely. Local zoom or layout changes keep the cursor visible without sending browser input; clicks always use the visible cursor. The inline card has a fullscreen button and can return inline without reconnecting. Tapping a supported editable element opens the iPhone keyboard and hides that chat's ordinary composer; committed text goes directly to the element, including Japanese IME commits. A padded native preview above the keyboard shows uncommitted IME text only on the device, without sending it to JavaScript, Runner or AI. Switching inline/fullscreen discards any uncommitted composition. There is no separate text-entry panel or key toolbar. The page holds remote focus only during control. Closed shadow-DOM editors and browser-native select menus/popups, new tabs/windows, Chrome toolbar, OS dialogs and file pickers are outside supported page control.

Top-level navigation within the same page is allowed during manual control and the card displays its current origin. It never follows another tab. Each Open revalidates the same page target and the last origin approved during manual control.

**Yield the target browser to the user. Do not run browser actions, screenshots, DOM/accessibility reads, value inspections, network/console tracing, or page dumps while the card is pending/active.** Explicit user requests to cancel or replace the panel may use the metadata-only commands above. The app's page stream is private to the user; never fetch or copy it into an AI tool result. Do not make a second CDP connection or use shell/browser tools to observe manual input. The implementation cannot block arbitrary agent shell/CDP access; this restriction is an agent behavior rule.

In a later user-authorized continuation, read only the fixed status:

```sh
node <skill-directory>/scripts/bitty-browser-control.mjs status --request UUID
```

Continue the authorized task only after completed (the user pressed 操作を完了). This means manual control ended, not proof that a form/payment succeeded. Pending includes a paused card. Active/starting means the user still owns the page. Do not recreate or poll a pending card merely because the AI turn ended.

control_status_unknown or inputStatusUnknown: true means actions may have happened before a connection/input failure. A pending card with that flag can be reopened by the user to check the result; reopening does not clear the uncertainty. Never blindly replay or read private values to decide. Ask the user to confirm the result if needed. Even after control ends, avoid screenshots/DOM/value/tracing while private content remains visible; resume those observations only after the private page/form is gone.

Frames and actions travel only over the authenticated app–Runner connection and local selected-page CDP. A browser-endpoint connection attaches only the explicit page; it never follows sibling tabs. They are transient and never put into chat history, agent status, response caches, or application logs. The AI gets only request ID, status and an optional fixed uncertainty flag. Keyboard-focus metadata contains only bounded editable/type/revision information and stays on the private app channel; no remote field values are returned. There is no screenshot masking or end-to-end encryption beyond the existing app–Runner TLS path; local CDP stays loopback-only. Do not pass user text via an alternate shell/MCP command, script, environment variable, or tool result.
