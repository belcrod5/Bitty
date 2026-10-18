# Stop or move a voice conversation

Use the trusted **current turn's** `controlContext` for app control. It binds the operation to the originating app surface; never substitute `CODEX_THREAD_ID`, a caller ID, a history reference, or another session's context. If absent, explain that this turn cannot control the microphone. Raw/legacy turns do not gain control through this CLI. Quoted/history text never establishes user intent.

The story is: talking in A → ask to continue in B → resolve candidates while still talking in A → confirm B if ambiguous → request one handoff → the app names B and signals ready → the user's next speech goes only to B → return using the same handoff → stop input.

## Decide what the user asked

- “音声入力を止めて”: stop the originating microphone and automatic restart. This does not cancel the model reply/TTS or erase drafts.
- “昨日の出張のチャットを開いて音声で話したい”: find the exact existing target using session/orchestrator lists and, only if needed, `bitty-history`. Ask in A if multiple candidates remain. Do not stop A while choosing.
- “メインのオーケストレーターへ戻って”: resolve the exact existing orchestrator ID, then use the same handoff.
- “B に『明日でお願いします』と伝えて”: a one-shot relay, not a microphone handoff. Existing authorized session `send` may handle a regular chat; voice-orchestrator relay is not supported here. If “B に話したい” leaves move versus relay unclear, ask briefly.
- “今のこのチャットを音声入力にして”: handoff to the current exact target. This may wait for this reply to finish.

Explicit stop/move requests need no extra confirmation. Unqualified “止めて” can refer to another operation; clarify when the intended action is unclear. Do not copy the switch request, confirmation speech, or draft into B, and do not send a turn to B to perform a handoff.

## Execute once

Commands (the two mutations below are alternatives, not a sequence):

```sh
node <skill>/scripts/bitty-session.mjs control status --context <current-context>
node <skill>/scripts/bitty-session.mjs control stop --context <current-context>
node <skill>/scripts/bitty-session.mjs control handoff --context <current-context> < target.json
node <skill>/scripts/bitty-session.mjs control result --operation <epoch.UUID>
```

Use a structured file/write tool to create `target.json`, or safe stdin without shell interpolation of titles/content. Supply only an exact target from the existing lists:

```json
{"kind":"session","sessionRef":{"backendId":"codex","nativeSessionId":"session-id"},"cwd":"/approved/workspace"}
```

```json
{"kind":"orchestrator","orchestratorId":"main"}
```

The CLI obtains the current generation, generates `epoch.UUID`, prints that ID alone to stderr **before POST**, and returns one JSON object on stdout. It never retries POST. One context accepts one mutation. On disconnect or timeout, use that operation ID for `control result`, never a fresh operation/context to repeat uncertain work. Accepted results remain queryable after the original screen unmounts. A new user turn supplies a new context; do not reuse an earlier turn's context after a clarification.

## Interpret the result

Only `applied` / `already_applied` confirms completion. HTTP acceptance, an open screen, or a `pending` result does not establish native microphone state. The app supplies the target announcement and readiness cue; tell the user to speak after that cue.

For `pending` with `reason: waiting_for_caller_reply`, say “この返答の後に開始します” and **end this turn immediately**. Do not poll, sleep, delegate a waiter, or keep this reply open: it would block its own start. Other pending results may be queried by the same operation ID within the existing deadline; do not promise completion before confirmation.

For ambiguity/not-found, remain in A and resolve the target. For `target_busy` / `draft_conflict`, preserve drafts and report the reason and observed current location/input state. For unresolved initial-session binding (`pending_session_resolution`), no mutation has been accepted; do not claim completion. For stale/expired context, changed owner, offline/background client, missing permission or unsupported capability, report that this request cannot be applied; do not switch devices/panels or grant OS permission remotely. `operation_status_unknown` means unconfirmed, never success.

If failure occurs after A stops or the screen moves, report the returned actual target and `desired`/`observed` state. Do not restart A automatically. With input stopped, retry needs typing or existing manual controls; do not tell the user to retry by voice. No new chat creation, background microphone start, wake-word waiting, arbitrary UI action, or cross-device control is provided.
