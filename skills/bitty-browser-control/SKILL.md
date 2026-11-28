---
name: bitty-browser-control
description: Let users remotely operate an existing local Chromium page from a Bitty chat panel by clicking, scrolling, dragging and typing, without exposing screen images or user input to the AI.
---

# Remote browser control

Use this skill when the user wants to operate a browser page from Bitty chat, or when an agent browser task needs a manual step. The user can click, scroll, drag and type on the actual page. Private input is one use case; never ask for a private value through ordinary chat or request_user_input.

Ordinary Chrome uses the Bitty extension, installed once in the user's intended profile with the Native Messaging host. Setup is documented in `<repository>/private_runner/browser-extension/README.md`; the installer is dry-run by default. Let the user approve the initial installation. Native Messaging stays on the local Mac and uses the existing owner-only Runner Unix socket; no browser token, user text or pixels are shared with the AI. Each later Open attaches only the specified existing tab without Chrome's per-connection remote-debugging approval dialog. Keep the user's actual profile and tab; never copy profiles or open another tab as a handoff.

1. Before a panel exists, identify the intended page's exact HTTP(S) origin and run `discover` below. This reads bounded metadata through the installed extension. It returns a `browserId` and matching `targetId`, Chrome `tabId`, and origin only. A browser-tool opaque ID is not a Chrome tab ID or CDP target ID; match real tab metadata rather than guessing. Multiple origin matches or connected profiles must be resolved before selecting a target. Do not rediscover while a panel is pending/active.
2. Request a card using the selected **actual CDP targetId**, its `browserId`, and the **current turn's** Bitty app controlContext. BITTY_REPO_ROOT must point to the repository running the Runner (automatically discovered if you are inside it). No field selectors, DOM inspection, images, or private values are needed.
3. Tell the user to tap 「ブラウザを開く」 once and operate the existing page. The command returns pending immediately. End the AI turn; do not wait, poll, or automatically resume.

```sh
node <skill-directory>/scripts/bitty-browser-control.mjs discover --origin https://example.com
node <skill-directory>/scripts/bitty-browser-control.mjs request \
  --context ctx_CURRENT_TURN --browser-id BROWSER_UUID --target-id CDP_PAGE_ID \
  --origin https://example.com --label 'ブラウザを操作してください'
```

`browser_extension_not_connected` requires the one-time setup or starting Chrome/Runner. `browser_extension_ambiguous` means several profiles are connected; do not select a profile arbitrarily. Keep Bitty installed/enabled only in the intended profile. A browserId belongs to one native connection: Chrome/native-host reconnection requires fresh discovery and a new card, so a stale request can never select another profile. App Wi-Fi changes/backgrounding do not change that native identity. Resolve a failed stale card in a new user-authorized turn; never replay uncertain input.

An existing direct loopback Chromium CDP **page** WebSocket remains usable with `--cdp-url ws://127.0.0.1:9222/devtools/page/PAGE_ID` instead of browserId/targetId. External CUA/in-app browsers without local CDP or the Bitty extension are unsupported. The standard Chrome approval-based browser endpoint is not the no-confirmation extension transport.

When the user explicitly asks to redisplay or replace the panel, use `replace` with the same browserId/targetId (or direct page CDP target) and the **current turn's** context. It cancels the previous panel only if it belongs to this authenticated device and conversation, then creates a new pending card. Validation failures leave the old panel available. The replacement retains the same page's last origin approved during manual control. Browser/page state and entered values remain in place; no page control session or stream is opened until the user taps Open. Ordinary `request` never cancels another card automatically.

```sh
node <skill-directory>/scripts/bitty-browser-control.mjs replace \
  --context ctx_CURRENT_TURN \
  --browser-id BROWSER_UUID --target-id CDP_PAGE_ID \
  --origin https://example.com --label 'ブラウザ操作の再表示'
```

When the user explicitly asks to close the panel, cancel that request using the current context:

```sh
node <skill-directory>/scripts/bitty-browser-control.mjs cancel \
  --context ctx_CURRENT_TURN --request UUID
```

Cancellation ends only the private control panel and discards queued input; it does not close the browser tab or undo actions already applied. Cancellation/replacement replies remain fixed status metadata. An uncertain in-flight action stays marked uncertain on a replacement card; never replay it to check the result.

The card stays in its original session/orchestrator after switching chats or ending a turn. It can be created while the originating phone is offline or in the background: creation records only card metadata and opens no page control session or stream. Opening or reopening the card establishes a fresh page control session after checking the original authenticated login/device and mounted conversation. Wi-Fi changes and backgrounding clear the private view, keyboard and unsent input; the same card can be explicitly reopened. Input is never automatically replayed. Unopened/paused cards are retained in Runner memory for up to 24 hours from creation; Runner restart or logout ends recovery.

The page uses mouse-mode touchpad controls: slide one finger to move the visible cursor relatively, tap to click at the cursor, and double-tap then drag to hold the mouse button and move an object or select text. Parallel two-finger movement scrolls the website horizontally or vertically; pinching zooms the private view locally without a mode switch. While zoomed, one-finger movement immediately pans the view to keep the cursor centered as far as page boundaries allow; at normal scale the cursor moves freely. Local zoom or layout changes keep the cursor visible without sending browser input; clicks always use the visible cursor. The inline card has a fullscreen button and can return inline without reconnecting. Tapping a supported editable element opens the iPhone keyboard and hides that chat's ordinary composer; committed text goes directly to the element, including Japanese IME commits. A padded native preview above the keyboard shows uncommitted IME text only on the device, without sending it to JavaScript, Runner or AI. Switching inline/fullscreen discards any uncommitted composition. There is no separate text-entry panel or key toolbar. The page holds remote focus only during control. Closed shadow-DOM editors and browser-native select menus/popups, new tabs/windows, Chrome toolbar, OS dialogs and file pickers are outside supported page control.

Top-level navigation within the same page is allowed during manual control and the card displays its current origin. It never follows another tab. Each Open revalidates the same page target and the last origin approved during manual control.

**Yield the target browser to the user. Do not run browser actions, screenshots, DOM/accessibility reads, value inspections, network/console tracing, or page dumps while the card is pending/active.** Explicit user requests to cancel or replace the panel may use the metadata-only commands above. The app's page stream is private to the user; never fetch or copy it into an AI tool result. Do not make a second CDP connection or use shell/browser tools to observe manual input. The implementation cannot block arbitrary agent shell/CDP access; this restriction is an agent behavior rule.

In a later user-authorized continuation, read only the fixed status:

```sh
node <skill-directory>/scripts/bitty-browser-control.mjs status --request UUID
```

Continue the authorized task only after completed (the user pressed 操作を完了). This means manual control ended, not proof that a form/payment succeeded. Pending includes a paused card. Active/starting means the user still owns the page. Do not recreate or poll a pending card merely because the AI turn ended.

control_status_unknown or inputStatusUnknown: true means actions may have happened before a connection/input failure. A pending card with that flag can be reopened by the user to check the result; reopening does not clear the uncertainty. Never blindly replay or read private values to decide. Ask the user to confirm the result if needed. Even after control ends, avoid screenshots/DOM/value/tracing while private content remains visible; resume those observations only after the private page/form is gone.

Frames and actions travel only over the authenticated app–Runner connection and the selected local page connection (Native Messaging or loopback CDP). They are transient and never put into chat history, agent status, response caches, or application logs. The AI gets only request ID, status and an optional fixed uncertainty flag. Keyboard-focus metadata contains only bounded editable/type/revision information and stays on the private app channel; no remote field values are returned. There is no screenshot masking or end-to-end encryption beyond the existing app–Runner TLS path; local CDP stays loopback-only. Do not pass user text via an alternate shell/MCP command, script, environment variable, or tool result.
