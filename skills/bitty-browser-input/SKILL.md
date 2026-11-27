---
name: bitty-browser-input
description: Hand a local Chromium browser page to the user in Bitty chat for private typing and direct page interaction, without passing screen images or user actions through the AI conversation.
---

# Private browser control

When a browser task needs private input or a complex website interaction, let the user control the actual page from a card in the originating Bitty chat. Never ask for a private value through ordinary chat or request_user_input.

The existing browser must expose a local Chromium CDP **page** WebSocket. A browser-tool tab ID alone is insufficient. External CUA/in-app browsers without a page connection are unsupported. Do not switch browser/profile to bypass this limitation.

1. Identify the page CDP URL and current top-level origin using the existing browser connection. No field selectors, option lists, DOM inspection, or private values are needed.
2. Request a card using the **current turn's** Bitty app controlContext. BITTY_REPO_ROOT must point to the repository running the Runner (automatically discovered if you are inside it).
3. Tell the user to open the card, start control, and operate the browser there. The command returns pending immediately. End the AI turn; do not wait, poll, or automatically resume.

```sh
node <skill-directory>/scripts/bitty-browser-input.mjs request \
  --context ctx_CURRENT_TURN \
  --cdp-url ws://127.0.0.1:9222/devtools/page/TAB_ID \
  --origin https://example.com --label 'ログインをお願いします'
```

The card stays in its original session/orchestrator after switching chats or ending a turn. Screen streaming starts only when the user starts control. Closing/leaving the card pauses it, and it can be opened later. Device background/disconnect or Runner restart ends the binding. One page has at most one control card. The user controls only that page; new tabs/windows, Chrome toolbar, browser-native/OS popups, file pickers, and permission dialogs are not remotely displayed/controlled. Native select menus may require Tab/arrow keys/Enter; do not promise full OS-level interaction. Touch defaults to tap/scroll; the user can switch to dragging. Text uses the iPhone's normal keyboard and dedicated input action, including committed Japanese text.

Top-level navigation within the same page is allowed during manual control and the card displays its current origin. It never follows another tab. Navigation before control starts or while paused invalidates the request.

**Yield the target browser to the user. Do not run browser actions, screenshots, DOM/accessibility reads, value inspections, network/console tracing, or page dumps while the card is pending/active.** The app's page stream is private to the user; never fetch or copy it into an AI tool result. Do not make a second CDP connection or use shell/browser tools to observe manual input. The implementation cannot block arbitrary agent shell/CDP access; this restriction is an agent behavior rule.

In a later user-authorized continuation, read only the fixed status:

```sh
node <skill-directory>/scripts/bitty-browser-input.mjs status --request UUID
```

Continue the authorized task only after completed (the user pressed 操作を完了). This means manual control ended, not proof that a form/payment succeeded. Pending includes a paused card. Active/starting means the user still owns the page. Do not recreate or poll a pending card merely because the AI turn ended.

control_status_unknown means actions may have happened before a connection/input failure. Never blindly replay or read private values to decide. Ask the user to confirm the result if needed. Even after control ends, avoid screenshots/DOM/value/tracing while private content remains visible; resume those observations only after the private page/form is gone.

Frames and actions travel only over the authenticated app–Runner connection and local page CDP. They are transient and never put into chat history, agent status, response caches, or application logs. The AI gets only request ID and status. There is no screenshot masking or end-to-end encryption beyond the existing app–Runner TLS path; local CDP stays loopback-only. Do not pass user text via an alternate shell/MCP command, script, environment variable, or tool result.
