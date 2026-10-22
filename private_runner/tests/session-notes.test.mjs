import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClientStateStore } from "../src/client-state-store.mjs";

async function withStore(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-notes-"));
  const file = path.join(directory, "client-state.json");
  try { await run(createClientStateStore(file), file); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}
const key = (backend, session = "same") => JSON.stringify([backend, session]);
const noteOperation = (note, expectedNote = "", backendId = "codex", sessionId = "same") => ({
  type: "session.set", backendId, sessionId, note, expectedNote,
});

test("notes persist by backend and session without entering title lookup, drafts or history", async () => withStore(async (store, file) => {
  const note = "検証中\n  明日再開する\n";
  await store.mutate(noteOperation(note));
  await store.mutate(noteOperation("Claude note", "", "claude"));
  await store.mutate(noteOperation("Other session", "", "codex", "other"));
  await store.setGeneratedTitle({ backendId: "codex", nativeSessionId: "same" }, "Generated title");
  await store.mutate({ type: "session.set", backendId: "codex", sessionId: "same", title: "Renamed", markerColor: "green" });
  const snapshot = await createClientStateStore(file).snapshot();
  assert.equal(snapshot.sessions[key("codex")].note, note);
  assert.equal(snapshot.sessions[key("claude")].note, "Claude note");
  assert.equal(snapshot.sessions[key("codex", "other")].note, "Other session");
  assert.equal(snapshot.sessions[key("codex")].title, "Renamed");
  assert.equal(snapshot.sessions[key("codex")].markerColor, "green");
  assert.deepEqual(snapshot.drafts, {});
  assert.deepEqual(snapshot.composerHistory, []);
  assert.deepEqual(await store.getSessionTitles([{ backendId: "codex", nativeSessionId: "same" }]), ["Renamed"]);
}));

test("legacy sessions accept notes; clearing preserves title and marker", async () => withStore(async (store, file) => {
  await store.mutate({ type: "session.set", backendId: "codex", sessionId: "same", title: "Existing", markerColor: "red" });
  const legacy = await createClientStateStore(file).snapshot();
  assert.equal(legacy.sessions[key("codex")].note, undefined);
  await store.mutate(noteOperation("New note"));
  await store.mutate(noteOperation(" \n ", "New note"));
  assert.deepEqual((await store.snapshot()).sessions[key("codex")], { title: "Existing", titleSource: "manual", markerColor: "red", note: "" });
}));

test("stale editors and invalid notes cannot overwrite saved state", async () => withStore(async (store) => {
  await store.mutate(noteOperation("First edit"));
  await assert.rejects(store.mutate(noteOperation("Stale edit")), /別の画面/);
  const before = await store.snapshot();
  for (const note of [null, {}, "x".repeat(100_001)]) {
    await assert.rejects(store.mutate(noteOperation(note, "First edit")), /invalid note/);
  }
  assert.deepEqual(await store.snapshot(), before);
  await store.mutate(noteOperation("Second edit", "First edit"));
  assert.equal((await store.snapshot()).sessions[key("codex")].note, "Second edit");
}));

test("a failed disk write leaves the saved note and revision intact", async () => withStore(async (store, file) => {
  await store.mutate(noteOperation("Saved"));
  const before = await store.snapshot();
  await fs.rename(file, `${file}.previous`);
  await fs.mkdir(file);
  await assert.rejects(store.mutate(noteOperation("Cannot save", "Saved")));
  assert.deepEqual(await store.snapshot(), before);
}));
