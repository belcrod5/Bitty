## Edit the Skia board

Use the CLI and existing Runner API for board edits; Computer Use is unnecessary for the operations below. An instruction to add, remove, or replace cards authorizes that board edit, not unrelated session turns or file deletion. Creating or editing a file's contents is separate from adding its card; file cards reference existing Runner-host files using `rootDir` and a path relative to that directory.

1. Run `board` to inspect cards, positions, and `revision`. This calls `GET /skia-board`, which can also ingest new session cards; it is not strictly read-only. For a strict no-board-change investigation, inspect code instead of calling `board`.
2. Prepare a JSON file with `{ "baseRevision": <observed revision>, "ops": [...] }`. Use exact card identities from the snapshot. Apply related changes, such as removing four old cards and adding four replacements, in one batch (maximum 100 operations).
3. Run `node <skill>/scripts/bitty-session.mjs board-apply < board-ops.json`. It posts once to `/skia-board/ops` and returns the resulting snapshot. It does not fetch the board first or retry mutations automatically.
4. Check the returned cards, paths, positions, and appearance against the requested changes. Invalid or missing targets may produce a successful no-op; an HTTP success alone does not verify the edit. On `revision_conflict`, inspect the new board and reconsider the batch. After a timeout, disconnect, or invalid response, check current state before retrying because the write may already have succeeded.

Supported operations (all use the existing server semantics):

| Operation | Fields besides `type` |
| --- | --- |
| `addCard` | `card`: `{kind:"file", rootDir, path}`, `{kind:"directory", directory}`, or `{kind:"session", sessionId, directory?, backendId?}` |
| `removeCard` | `cardId` |
| `moveCard` | `cardId`, `col`, `row` |
| `updateCardAppearance` | `cardId`, `displayNameOverride`, `imagePath` (file/directory cards only; omitted values clear the corresponding override) |
| `renameFileCard` | `rootDir`, `previousPath`, `nextPath` (updates the card reference, not the file itself) |
| `setFileCardUnavailable` | `rootDir`, `path`, `unavailable` |
| `upsertSection` | `section`: `{id, label, col, row, colSpan, rowSpan, color, opacity, borderOnly?}` |
| `removeSection` | `sectionId` |
| `tidyCards` | optional `visibleCardIds` |

Card IDs are `session:<sessionId>`, `directory:<directory>`, and `file:<rootDir>\n<path>`; encode the file ID separator as `\n` inside JSON strings. New cards occupy the first free cell; `addCard` ignores supplied coordinates. To preserve a replaced card's position, follow its removal/addition with `moveCard` in the same batch. Adding an existing card does not duplicate it. Removing a card does not delete its file, directory, or session; session removal also excludes automatic readdition. Adding that session back clears the exclusion. `imagePath` is an absolute Runner-host path.

For example, with revision `12` and files already present under `/work/travel`, a batch that replaces a file card and preserves its position is:

```json
{
  "baseRevision": 12,
  "ops": [
    {"type":"removeCard","cardId":"file:/work/travel\nkyoto.md"},
    {"type":"addCard","card":{"kind":"file","rootDir":"/work/travel","path":"tokyo.md"}},
    {"type":"moveCard","cardId":"file:/work/travel\ntokyo.md","col":0,"row":1}
  ]
}
```

### Remove a session card

When the user has requested removal and the intended session card is confirmed, run `board-remove --session <id> [--backend <id>] [--cwd <path>]`. Use the optional backend and directory arguments when known to guard against selecting the wrong card. The command checks the current board, applies `removeCard` using its revision, and verifies the returned board no longer contains the card. If the board changes between the read and write, the command stops with a revision conflict; inspect the board again before retrying. This removes only the Skia board card and excludes the session from automatic readdition. It does not delete the underlying Codex or Claude session or its conversation history.
