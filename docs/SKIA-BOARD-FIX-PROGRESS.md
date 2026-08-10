# Skia board fixes — plan and progress

Updated: 2026-08-10
Branch: `fix/skia-board-interactions`
Worktree: `/Volumes/SSD-500GB-SanDisk/work/bitty-worktree/fix/skia-board-interactions`

## Goal

Fix the Skia board at the owning boundaries, without duplicating file-opening logic,
leaking board layout into chat, or adding generic abstractions with only one caller.

## Requirements

- [x] Long press opens the context menu even when a card is already selected, as
      long as pointer movement remains within the long-press threshold.
- [x] A file card's second tap opens the file with its normal type-specific action;
      long press remains the way to open its context menu.
- [x] Tidy has a defined order and does not leave odd gaps caused by non-visible cards.
- [x] Remove the header background, title, and explanatory text.
- [x] Put Tidy and Reset in a compact menu opened by a top-right ellipsis button.
- [x] Add card-text size minus/plus controls to that menu.
- [x] Persist and restore the card-text size on the device.
- [x] Remove the board footer safe-area whitespace without changing chat/drawer layout.
- [x] Compact the card title/body area and halve the footer time-area padding.

## Confirmed causes and intended fixes

### Gesture ownership

The selected-card long-press suppression is application behavior, not a limitation of
React Native Gesture Handler. The current pan gesture marks a selected card active at
touch-down, and the long-press handler then returns early. RNGH already supports a
movement tolerance (10 pt by default). The fix must separate touch-down from drag
activation so long press and drag resolve from movement/hold thresholds.

### File opening

File tap currently routes to the context menu, while the type-specific open behavior is
implemented inside that menu utility. Extract the existing open decision at its current
domain boundary and reuse it from both the menu and the board tap. Do not duplicate the
file-type switch in the screen.

### Tidy order and gaps

Tidy currently follows persisted `state.cards` order in two-column row-major order.
Initial session ingestion is newest-first, while later additions are appended. Persisted
cards that are currently hidden are still included in layout and can create visible gaps.
The fix must compact visible cards deterministically while preserving hidden cards for
future reappearance. The resulting order must be covered by tests and documented in UI
or code naming where needed.

### Header and font size

Keep only the transparent left navigation button and a transparent right ellipsis button.
Use a small screen-local modal menu for Tidy, Reset, and font minus/plus; do not create a
generic menu layer. Store a normalized card text scale in the existing Skia board state,
which already owns board persistence. Apply it only to Skia card title/body fonts.

### Safe area

The bottom whitespace comes from AppRoot's shared SafeAreaView. Removing that wrapper
globally could affect chat, debug, audio, and overlays. Make only the Skia board full
bleed and retain top inset handling for its header. Existing chat/drawer safe-area paths
must remain unchanged.

## Implementation checkpoints

- [x] Update focused tests to express the requested behavior before/with implementation.
- [x] Implement gesture arbitration without selection-state special cases.
- [x] Share the file default-open behavior between tap and context-menu callers.
- [x] Make visible-card tidy compact and deterministic while preserving hidden state.
- [x] Add compact header menu and remove obsolete header UI.
- [x] Persist a bounded card text scale in Skia board state.
- [x] Scope full-bleed layout to the Skia board only.
- [x] Run focused tests.
- [x] Run relevant typecheck/lint checks.
- [x] Review the final diff for unnecessary abstractions and oversized files.
- [x] Obtain an independent read-only agent review and address findings.
- [x] Prepare and provide device verification commands before any commit/push/PR.

## Verification record

- `npm test -- --runInBand src/features/app/utils/skiaBoardState.test.ts src/features/app/utils/runnerFileContextMenu.test.ts src/features/app/hooks/useSkiaMiniChatSessions.test.tsx src/features/app/screens/SkiaMiniBoardScreen.test.tsx`
  - Initial attempt: could not start because `expo/node_modules` was absent (`jest: command not found`).
  - After worktree-only Expo bootstrap, final regression updates, and card-spacing
    compaction: PASS, 4 suites / 69 tests.
- `npm test -- --runInBand`
  - PASS, 97 suites / 668 tests. Existing React Native `SafeAreaView` deprecation
    warnings were printed by several suites; there were no test failures.
- `npx tsc --noEmit`
  - PASS.
- `git diff --check`
  - PASS.
- Independent read-only reviews after fixes, token-handoff follow-up, and card-spacing
  compaction
  - APPROVE with no remaining findings.
- `BITTY_MAIN_REPO_ROOT=/Volumes/SSD-500GB-SanDisk/work/bitty-public ./scripts/worktree/bootstrap-local.sh --repo-root /Volumes/SSD-500GB-SanDisk/work/bitty-worktree/fix/skia-board-interactions --env --expo --ios-native`
  - PASS. Local `.env`, Expo dependencies, iOS workspace, and Pods are ready.
- `BITTY_MAIN_REPO_ROOT=/Volumes/SSD-500GB-SanDisk/work/bitty-public ./scripts/worktree/bootstrap-local.sh --repo-root /Volumes/SSD-500GB-SanDisk/work/bitty-worktree/fix/skia-board-interactions --env --private-runner`
  - PASS. Private Runner dependencies and the reusable Runner token file are ready.
    `npm install` reported one existing high-severity dependency advisory; dependency
    versions were not changed in this task.
- `node --test private_runner/tests/run-local-script.test.mjs`
  - PASS, 7 tests. Includes missing-token copy and local-token preservation coverage.
- No lint script is defined in `expo/package.json`; lint was not run.

## Manual device verification

Run from the task worktree before any commit/push/PR:

```sh
cd /Volumes/SSD-500GB-SanDisk/work/bitty-worktree/fix/skia-board-interactions
./private_runner/restart-keep-token.sh --mode full
./scripts/ios/build-expo-ios-device.sh
```

Check selected-card long press within the movement threshold, drag after crossing the
threshold, supported file second-tap opening, long-press file menu, Tidy/Reset, persisted
80%-120% card text sizes, top-right menu placement, and notch/home-indicator spacing.

## Decisions / risks

- Font scale bounds and step must respect the fixed card height and remain readable;
  implementation uses 0.8-1.2 in 0.1 steps and locks normalization with tests.
- Unsupported file types must retain an explicit fallback rather than silently doing
  nothing; second tap now displays an unsupported-type alert.
- Tidy order is persisted board order with currently visible cards stably partitioned
  before hidden retained cards. All cards receive unique row-major positions, so a hidden
  card can reappear without overlapping the compacted visible cards.
- `AppRoot` scopes its conditional `SafeAreaView`/`View` to active screen content only.
  The existing overlays and calendar modal remain mounted beneath a stable absolute
  `SafeAreaView`; `DrawerSessionPopupHost` remains unchanged.
- A persisted scale-only state remains semantically uninitialized for session ingestion:
  it preserves the scale while taking the normal newest-first/latest-six initial path.
- Persisted scale accepts only an actual finite number. `null`, empty strings, and other
  invalid values default to 1 and cannot make an otherwise empty payload valid.
- The canvas remains full bleed, while only the status pill is bottom-safe-area-aware.
  Header/menu actions and separate minus/plus controls have non-overlapping 44pt targets.
- Device-level gesture feel, menu placement, and safe-area appearance still need manual
  verification on an iPhone build from this worktree.
- No commit, push, PR, or merge is authorized yet.
