# Voice transcript correction

After STT returns a final transcript, the shared `useStreamingStt` hook asks the Runner for one contextual correction before its existing automatic send path. Recent visible conversation messages are bounded on both client and Runner and serialized as data. Typed messages and manual transcript submissions do not enter this path.

The Runner connects to the already running Codex app server, starts an ephemeral thread in an isolated scratch directory, disables configured MCP servers, apps, plugins, shell tools, hooks, memories, and agents, and requests a structured `{changed,text}` result. It checks the output and rejects any observed tool activity. The correction model and reasoning effort are persisted together in the existing STT settings file; the default is GPT-6 Luna with low effort. Omitting a workspace from `turn/start` is not known to improve latency, so the scratch directory is explicit. No live latency claim is made.

The isolation settings follow the [Codex app server documentation](https://learn.chatgpt.com/docs/app-server) and [config reference](https://learn.chatgpt.com/docs/config-file/config-reference).

An unchanged result sends immediately. A changed result appears above the voice input and sends three seconds after it is displayed, unless tapped to send sooner or canceled for editing. Changing the conversation, editing, stopping, leaving the app, or unmounting invalidates a pending correction. A correction error leaves the finalized transcript as an editable draft and shows an error; it never guesses or silently sends. The reply cycle starts only when the actual send begins.

Local tests use a mock app server and mock STT transport. Real model quality, account availability, and device timing still require user verification with the worktree Runner and iOS app.
