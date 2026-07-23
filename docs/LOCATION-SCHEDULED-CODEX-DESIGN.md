# Location-scheduled Codex design

## Goal

Run a normal Codex turn on the Mac runner when an iPhone is inside a configured
geofence during a configured daily time window.

The scheduled path does not pass through the chat UI:

```text
Normal chat:  iOS chat -> runner Codex execution -> LLM
Scheduled:    iOS geofence state -> runner condition -> runner Codex execution -> LLM
```

Both paths share the runner's Codex execution boundary. A scheduled run is not a
special agent and does not own a long-lived rule-specific conversation. Each firing
starts an ordinary Codex thread and sends the configured prompt as its user turn, in
the same way a new normal chat is started. The resulting thread remains an ordinary
Codex thread discoverable by the existing session index.

## Scope

The first version supports:

- iOS only.
- Up to 20 enabled rules, matching the iOS monitored-region limit.
- Multiple rules with an enabled flag.
- One daily, non-overnight time window per rule.
- A circular region defined by latitude, longitude, and radius.
- Current-location capture and numeric latitude/longitude entry; no map UI.
- The same model and reasoning-effort values used by normal chat.
- A prompt and runner working directory per rule.
- One initial execution per rule and local-day time window, with guarded re-entry
  executions after a real exit.
- Execution when the device enters during the window or was last known to be inside
  when the window starts.

Weekday selection, overnight windows, continuous location tracking, Android, and a
separate scheduled-run history are out of scope. Ordinary Codex threads and runner
logs remain the execution record.

## Configuration UX

Configuration UI is required; runtime execution does not use UI.

Add location schedules to the existing directory-title modal in `ChatScreen`. Reuse
the existing directory, model, and reasoning-effort sources instead of maintaining
scheduled-only copies of their option lists.

Each rule contains:

```ts
type LocationScheduleRule = {
  id: string;
  enabled: boolean;
  startTime: string;       // local HH:mm
  endTime: string;         // local HH:mm, strictly later than startTime
  timeZone: string;        // IANA zone captured from the iPhone
  latitude: number;
  longitude: number;
  radiusMeters: number;
  cwd: string;
  modelRef: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
  prompt: string;
};
```

Use 200 metres as the default radius. Reject invalid coordinates and non-positive
radii, and warn below 100 metres because small regions are less reliable. Validate
the model and reasoning effort with the same parsers as normal chat. The runner must
validate the working directory at execution time and must not silently fall back to
another directory.

Rules are persisted with the existing `bitty-settings.json` payload. Background-safe
code reads the same persisted field directly, as existing push background actions do.
Serialize in-process reads and mutations and replace the file through a complete
temporary payload so React and background work cannot observe a partial JSON write.
Do not add a second iOS settings store.

When synchronizing a rule to the runner, include the location-only region revision as
an opaque `regionRevision`. The iOS app remains the only place that calculates this
token; the runner stores it and requires state updates to match the currently accepted
token exactly.

## iOS location responsibility

Use iOS region monitoring through Expo Location and TaskManager, not continuous GPS
updates.

- Register the TaskManager task at module top level.
- Request foreground permission followed by Always/background permission when the
  user enables the first rule.
- Configure the iOS background location mode and usage descriptions through Expo.
- Register one geofence per enabled rule and enforce the 20-region limit.
- On rule registration and app launch, get the current position, calculate the
  initial inside/outside state, and sync it to the runner. Registration alone does
  not emit an enter event for a device that is already inside.
- On enter and exit events, persist the state/event before attempting network sync.
- Coalesce unsent events to the newest observation per rule before syncing, so an old
  inside event cannot be evaluated before a newer queued outside event.
- Include a location-only region revision in each monitored identifier. Ignore delayed
  events and queued states whose revision no longer matches the configured centre/radius.
- Re-filter the pending queue against the current rules immediately before sending it.
  The runner's exact revision check remains authoritative if a rule changes while the
  network request is in flight.
- Flush pending state updates on app launch and whenever schedule configuration is
  synchronized.
- Reconcile the complete registered-region set after settings load, permission
  changes, and rule changes so stale regions are removed.

Region monitoring can wake an app in the background, but delivery is best effort.
Explicit force-quit, disabled permissions, disabled Background App Refresh, network
unavailability, and reboot-before-first-unlock can prevent timely updates. The runner
therefore evaluates the last state successfully synchronized by the iPhone. A missed
exit while the phone is offline can cause that state to be stale; continuous tracking
is intentionally not added to disguise this platform limitation.

## Runner responsibility

The runner is the authority for time evaluation, idempotency, and Codex execution.
It must continue to work while the iOS app UI is not running.

Add authenticated APIs for:

- Replacing the iPhone's complete schedule set and timezone metadata.
- Recording geofence state transitions/current state.
- Returning the accepted schedule/state snapshot for reconciliation and diagnostics.

Persist schedules, last-known region states and transition timing,
pending/running/completed fire records, and ordinary Codex thread IDs produced by
completed fires in one runner-owned JSON store. Use the same atomic-write style as
existing runner stores. A runner restart must not lose claimed fires, cooldown state,
or the start of a continuous outside period.

Keep initial window occurrences for 90 days. Terminal re-entry occurrences need only
two days because windows cannot cross midnight; ordinary Codex threads remain the
durable execution history. Never age-prune queued, pending, or running claims. This
bounds the high-frequency re-entry portion of the scheduler store without weakening
an active claim.

Reject state updates whose `regionRevision` does not match the current rule. A location
change must produce a new revision, while time, prompt, model, and effort edits keep it
stable. This closes the race where an old in-flight state arrives after a schedule edit.
If an existing runner store cannot be parsed and validated, fail closed without
overwriting it or executing; only a missing store may initialize empty. Schedule APIs
report this state as HTTP 503, while request validation errors remain HTTP 400.

The scheduler reacts to three inputs:

1. A schedule/state sync.
2. A region enter event.
3. The next time-window start boundary.

For a local window `[startTime, endTime)`:

- At `startTime`, fire if the last synchronized state is inside.
- During the window, fire immediately when an inside state is received.
- Do not fire outside the window or from an unknown state.
- If the runner starts or recovers during the window, fire if the state is inside and
  that window has not yet had its initial fire.
- After a fire, re-arm only when the state has remained outside for at least five
  minutes. A later enter may fire again only when at least fifteen minutes have also
  elapsed since the previous fire claim. Both device observation timestamps and
  Runner receipt timestamps must independently satisfy the five-minute outside
  minimum, so accepted device-clock skew cannot shorten it.
- Repeated inside reports, duplicate iOS delivery, API retry, and short boundary
  bounces do not count as a new enter. An enter that fails either timing condition is
  not delayed into a later fire; another real exit and enter is required.
- Do not run two fires for the same rule concurrently. A claimed fire counts even if
  Codex execution later fails. If a qualified enter arrives during an earlier fire,
  persist it as queued and start it automatically when that fire finishes. A later
  exit or the window end does not discard an already-claimed enter.

Use a deterministic window key derived from rule ID, local calendar date, start time,
end time, and timezone. The initial fire uses that key directly; a qualified re-entry
adds the persisted inside-transition timestamp and event ID. Atomically persist each
fire claim before starting Codex. The persisted claim is the at-most-once boundary for
that enter cycle. Store only a fixed-size SHA-256 rule fingerprint on each claim; do
not duplicate the prompt or complete rule per occurrence. Do not add an unsupported
idempotency field to the Codex app-server RPC.

Disabling or deleting a rule takes effect as soon as the runner accepts the new
complete schedule set. Creating or editing a rule during its active window applies
immediately: a synchronized inside state may produce the initial fire, while an
outside or unknown state waits for a later enter. A window that already fired keeps
the normal outside-duration and cooldown requirements for re-entry.

## Shared Codex execution boundary

Do not make the scheduler call the runner's HTTP endpoint through localhost and do
not duplicate the app-server RPC sequence.

The existing queued-turn implementation already owns Codex initialization,
`thread/resume`, `turn/start`, model/effort forwarding, and completion handling.
Extract only the real shared execution operation needed by both existing queued turns
and scheduled starts. It must support:

- Resuming an existing thread for the current queued-turn caller.
- Starting an ordinary new thread when the scheduled caller has no thread ID.
- The same `cwd`, `model`, `effort`, approval policy, and user-text validation.
- Returning the ordinary thread and turn identifiers to the caller.

This is a two-call-site domain boundary, not a scheduled-only wrapper. Queue ordering
and compact-wait behavior stay in the existing queue layer. Schedule occurrence and
location decisions stay in the scheduler layer.

## Failure semantics

- Unknown location state: do not execute.
- iPhone or runner API temporarily unreachable: retain pending iOS state and retry on
  the next available foreground/background opportunity.
- Runner recovers inside the active window: execute the initial fire if not already
  recorded, or a previously qualified unclaimed re-entry after any in-flight fire ends.
- Runner restart: do not retry a pending/running fire whose execution is ambiguous;
  a separately persisted queued fire is known not to have started and may run once.
- Runner recovers after the window: wait for the next daily occurrence.
- Invalid/missing cwd, model, or prompt: record the occurrence as failed; never use a
  different fallback configuration.
- Codex execution failure: record failure. Do not automatically start another turn for
  the same enter cycle, because doing so could duplicate side effects after an
  ambiguous failure. The failed claim still starts the fifteen-minute cooldown.

## Security and privacy

- Use the existing runner bearer-token authentication.
- Send only configured region centres/radii and state transitions; do not stream a
  location trail.
- Do not log the full prompt or precise current-position samples beyond the configured
  region data.
- Validate schedule payload size, rule count, IDs, coordinates, times, timezone,
  prompt, model, effort, and cwd on the runner.

## Tests and verification

Add focused tests for:

- Schedule parsing and validation on iOS and runner.
- Local time-window evaluation, including exact boundaries and timezone/DST cases.
- Already-inside-at-start, enter-during-window, qualified exit/re-entry, short outside
  periods, cooldown rejection, duplicate inside reports, and unknown state.
- Duplicate events, duplicate API requests, and runner restart persistence.
- Creation and edits during an active window using synchronized inside/outside state.
- Starting a normal new Codex thread with configured prompt/cwd/model/effort through
  the shared runner execution operation.
- iOS background event persistence and later flush.
- Reconciliation of enabled geofences and the 20-rule limit.

Run the relevant Jest and Node test suites, TypeScript checks available in the Expo
project, `git diff --check`, and an iOS development build because Expo Go cannot run
background location tasks.
