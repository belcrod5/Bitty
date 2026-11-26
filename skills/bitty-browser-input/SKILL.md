---
name: bitty-browser-input
description: Let the user enter a password, card number, or other private value in Bitty chat and fill a local Chromium browser field without passing the value through the AI conversation. Use when browser automation needs private user input and the current tab has a local CDP page connection.
---

# Private browser input

Use the dedicated Bitty form when a browser task requires a private value. Never ask the user to paste the value into ordinary chat or `request_user_input`.

The browser must already expose a local Chromium CDP **page** WebSocket. The browser tool's tab ID alone is not a CDP connection. External CUA and in-app browsers without this connection are unsupported; explain the limitation and let the user complete the browser step manually. Do not start a different browser/profile to bypass this limitation.

1. Identify the current browser tab, destination origin, a unique CSS selector, and optional frame ID using the existing browser connection. Inspect only field metadata, never its value. Use the current turn's `Bitty app controlContext`.
2. Run the command below with non-secret metadata. `BITTY_REPO_ROOT` must refer to the repository running the Runner. If running inside that repository it is discovered from the working directory. The CLI uses its existing private Unix control socket and token; neither is sent to the browser.
3. The command creates a card in the originating chat timeline and returns `pending` immediately. Tell the user to enter the value on that card and press **ブラウザへ入力**. End the current response normally; do not keep the AI turn or CLI running while waiting for input.

```sh
node <skill-directory>/scripts/bitty-browser-input.mjs request \
  --context ctx_CURRENT_TURN \
  --cdp-url ws://127.0.0.1:9222/devtools/page/TAB_ID \
  --origin https://example.com --selector '#password' --label 'パスワード'
```

Add `--frame-id FRAME_ID` when the field is in a supported child frame; the origin must be that frame's origin. One card fills one field. Multiple cards can coexist. The card stays with its original native session/orchestrator when the user switches chats or the AI turn finishes. There is no two-minute input deadline. Navigation, element replacement, device disconnect/background, Runner restart, or cancellation can invalidate it.

Out-of-process frames (including some hosted card forms), closed shadow roots and fields that cannot be uniquely selected in the chosen frame are unsupported and fail closed. Do not claim that every payment form can be filled.

The command prints a request ID. In a later user-authorized continuation, read its status separately:

```sh
node <skill-directory>/scripts/bitty-browser-input.mjs status --request UUID
```

Continue the authorized browser task only after `completed`; it means input only and does not submit a form or payment. `pending` means the user has not submitted the card yet. Do not recreate a pending card merely because the original AI turn ended, and do not start an automatic polling/resume loop. The user can return to the card and explicitly continue later.

`input_status_unknown` means a write may have happened before cancellation or a connection failure. Do not blindly retry or read the private value to decide; tell the user the status and ask them to confirm the browser step if needed.

While requesting/filling private input, and while it may remain on the page, do not take screenshots, DOM/accessibility snapshots, inspect `.value`, enable network/console tracing, or save page dumps that could expose it. Resume screenshots only after the private form is gone. Screenshot masking and blocking arbitrary later browser reads are not implemented; these are agent behavior rules.

The private value is sent only from the app to the Runner and then the bound browser element. The AI receives status only. Do not invent an alternate shell/MCP call with the user's value as an argument, script, environment variable, or tool result.
