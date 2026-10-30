import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { MemoryStore, projectIdentity } from "../src/store.js";

function temporary(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-recall-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("journal and pending cursor survive reopening; projects cannot share a store", (t) => {
  const dir = temporary(t); const file = join(dir, "memory.sqlite");
  let db = new MemoryStore(file, projectIdentity(dir).id);
  const first = db.appendSource("session", "user", "human", "Use Python in this project");
  const second = db.appendSource("session", "assistant", "agent", "Understood");
  db.markProcessed(first.seq); db.close();
  db = new MemoryStore(file, projectIdentity(dir).id);
  assert.deepEqual(db.pending().map((s) => s.id), [second.id]);
  assert.throws(() => db.markProcessed(0), /cursor/);
  assert.throws(() => db.markProcessed(100), /cursor/);
  db.close();
  assert.throws(() => new MemoryStore(file, "another-project"), /different project/);
});

test("deleted evidence stays suppressed after restart, even mixed with a new message", (t) => {
  const dir = temporary(t); const file = join(dir, "memory.sqlite");
  let db = new MemoryStore(file, "project");
  const original = db.appendSource("s", "user", "human", "Maybe Go would work");
  const memory = db.add("hypothesis", "Prefers Go", [original.id]);
  db.remove(memory.id); db.close();
  db = new MemoryStore(file, "project");
  assert.throws(() => db.add("hypothesis", "Likes Golang", [original.id]), /suppressed/);
  const noise = db.appendSource("s", "user", "human", "ok thanks");
  assert.throws(() => db.add("fact", "Prefers Go", [original.id, noise.id]), /suppressed/);
  assert.equal(db.list().length, 0);
  const fresh = db.appendSource("s2", "user", "human", "I now prefer Go");
  assert.equal(db.add("fact", "Now prefers Go", [fresh.id]).kind, "fact");
  assert.equal(db.list().length, 1);
  db.close();
});

test("a fact requires original user evidence; other sources can only support a hypothesis", (t) => {
  const dir = temporary(t); const db = new MemoryStore(join(dir, "db.sqlite"), "project");
  const assistant = db.appendSource("s", "assistant", "agent", "The password rotates monthly");
  const replay = db.appendSource("s", "user", "replay", "Use Go");
  const rpc = db.appendSource("s", "user", "unattested", "Use Go");
  for (const source of [assistant, replay, rpc]) assert.throws(() => db.add("fact", "claim", [source.id]), /user evidence/);
  assert.equal(db.add("hypothesis", "The password may rotate monthly", [assistant.id]).kind, "hypothesis");
  db.close();
});

test("user edit preserves an audit trail and blocks extraction from old evidence", (t) => {
  const dir = temporary(t); const db = new MemoryStore(join(dir, "db.sqlite"), "project");
  const source = db.appendSource("s", "user", "human", "Use pytest");
  const memory = db.add("fact", "pytest", [source.id]);
  const edited = db.edit(memory.id, "Run pytest inside Docker", "s");
  assert.equal(edited.revision, 2);
  assert.equal(db.get(memory.id).text, "Run pytest inside Docker");
  assert.throws(() => db.add("fact", "Use pytest", [source.id]), /suppressed/);
  assert.equal(db.events().filter((x) => x.kind === "memory_edited").length, 1);
  const sourceCount = db.sources().length;
  assert.throws(() => db.edit(memory.id, " ", "s"), /memory/);
  assert.equal(db.sources().length, sourceCount);
  db.close();
});

test("unknown provenance fails without a partial memory write", (t) => {
  const dir = temporary(t); const db = new MemoryStore(join(dir, "db.sqlite"), "p");
  assert.throws(() => db.add("fact", "fact", ["missing"]), /Unknown/);
  assert.equal(db.list().length, 0);
  db.close();
});

test("configuration rejects unknown fields, unsafe endpoints and invalid budgets", () => {
  assert.equal(parseConfig().decision.mode, "managed");
  assert.equal(parseConfig().capture, false);
  assert.throws(() => parseConfig({ recoverEverything: true }), /Unknown/);
  assert.throws(() => parseConfig({ decisionTimeoutMs: -1 }), /milliseconds/);
  assert.throws(() => parseConfig({ decision: { mode: "external", endpoint: "http://example.com", model: "x" } }), /HTTPS/);
  assert.throws(() => parseConfig({ decision: { mode: "external", endpoint: "http://user:password@localhost", model: "x" } }), /credentials/);
  assert.equal(parseConfig({ decision: { mode: "external", endpoint: "http://127.0.0.1:8080/v1", model: "Julia-1" } }).decision.mode, "external");
});
