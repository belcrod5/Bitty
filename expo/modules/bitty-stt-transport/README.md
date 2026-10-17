# iOS STT capture diagnostics

An iOS rebuild is required to collect `stt_capture_diagnostic` events. Older native builds continue recording without these diagnostics. The module's `captureDiagnosticsVersion` constant allows JavaScript to register the additional event only when supported.

Events use the existing `useStreamingStt` diagnostic callback and Runner `client_auto_logs` retention. Each event contains a random capture `sessionId`, the hook's `version`, monotonic `elapsedMs`, and allowlisted counts/booleans. No transcript, audio, URL, headers, device name, or raw error is recorded.

Read the stages in order to locate a stall:

| Stages | Boundary |
| --- | --- |
| `session_started`, `socket_opened`, `ready_received` | Native session, WebSocket open, Runner ready received |
| `permission_requested`, `permission_result` | Microphone permission request and response |
| `audio_session_configuring`, `audio_session_active` | Audio session configuration/activation |
| `engine_starting`, `engine_started` | Input format known, audio engine started |
| `first_tap`, `first_pcm` | First captured buffer processed on the transport queue, first nonempty converted PCM |
| `first_audio_queued`, `first_audio_send_started`, `first_audio_sent` | First PCM frame queued, WebSocket send invoked, send completion succeeded |
| `stop_requested`, `runner_done`, `runner_error`, `socket_closed`, `failed`, `aborted` | Stop or terminal snapshot with cumulative capture/convert/queue/send counts |

Every stage is emitted at most once per session; there is no periodic buffer/sample/send logging. Diagnostics run on the existing transport queue, outside the real-time audio callback. A WebSocket send completion is not proof that the Runner received the data; compare Runner's audio counts. `aborted` is best effort because the JavaScript listener is removed before native abort, as before this diagnostic addition.
