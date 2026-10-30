import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CAPABILITIES, parseConfig } from "../src/config.js";
import { executionDecision, isCurrent } from "../src/policy.js";
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

test("deletion blocks paraphrased old evidence after restart; assistant/replay are not new human evidence", (t) => {
  const dir = temporary(t); const file = join(dir, "memory.sqlite");
  let db = new MemoryStore(file, "project");
  const original = db.appendSource("s", "user", "human", "Maybe Go would work");
  const memory = db.add("preferred-language", "hypothesis", "Prefers Go", [original.id]);
  db.remove(memory.id); db.close();
  db = new MemoryStore(file, "project");
  assert.throws(() => db.add("different-key", "hypothesis", "Likes Golang", [original.id]), /suppressed/);
  const assistant = db.appendSource("s", "assistant", "agent", "User prefers Go");
  const replay = db.appendSource("s", "user", "replay", "Maybe Go would work");
  const rpc = db.appendSource("s", "user", "unattested", "I now prefer Go");
  assert.throws(() => db.add("preferred-language", "hypothesis", "Prefers Go", [assistant.id]), /suppressed/);
  assert.throws(() => db.add("preferred-language", "hypothesis", "Prefers Go", [replay.id]), /suppressed/);
  assert.throws(() => db.add("preferred-language", "hypothesis", "Prefers Go", [rpc.id]), /suppressed/);
  const fresh = db.appendSource("s2", "user", "human", "I now prefer Go");
  const replacement = db.add("preferred-language", "fact", "Now prefers Go", [fresh.id]);
  assert.equal(db.list().length, 1);
  assert.equal(replacement.kind, "fact");
  assert.match(JSON.stringify(db.events().at(-1)), /supersedesTombstoneIds/);
  db.close();
});

test("user edit preserves an audit trail and blocks extraction from old evidence", (t) => {
  const dir = temporary(t); const db = new MemoryStore(join(dir, "db.sqlite"), "project");
  const source = db.appendSource("s", "user", "human", "Use pytest");
  const memory = db.add("test-command", "fact", "pytest", [source.id]);
  const edited = db.edit(memory.id, "Run pytest inside Docker", "s");
  assert.equal(edited.revision, 2);
  assert.equal(db.get(memory.id).text, "Run pytest inside Docker");
  assert.throws(() => db.add("paraphrase", "fact", "Use pytest", [source.id]), /suppressed/);
  assert.equal(db.events().filter((x) => x.kind === "memory_edited").length, 1);
  const sourceCount = db.sources().length;
  assert.throws(() => db.edit(memory.id, " ", "s"), /memory/);
  assert.equal(db.sources().length, sourceCount);
  db.close();
});

test("unknown provenance and duplicate active claims fail without partial memory writes", (t) => {
  const dir = temporary(t); const db = new MemoryStore(join(dir, "db.sqlite"), "p");
  assert.throws(() => db.add("x", "fact", "fact", ["missing"]), /Unknown/);
  assert.equal(db.list().length, 0);
  const s = db.appendSource("s", "user", "human", "some evidence");
  db.add("x", "fact", "fact", [s.id]);
  assert.throws(() => db.add("x", "fact", "another", [s.id]), /UNIQUE/);
  assert.equal(db.list().length, 1); db.close();
});

test("configuration rejects unknown fields, unsafe endpoints and invalid budgets", () => {
  assert.equal(parseConfig().decision.mode, "managed");
  assert.equal(parseConfig().capture, false);
  assert.throws(() => parseConfig({ recoverEverything: true }), /Unknown/);
  assert.throws(() => parseConfig({ decisionTimeoutMs: -1 }), /milliseconds/);
  assert.throws(() => parseConfig({ decision: { mode: "external", endpoint: "http://example.com", model: "x" } }), /HTTPS/);
  assert.throws(() => parseConfig({ decision: { mode: "external", endpoint: "http://user:password@localhost", model: "x" } }), /credentials/);
  assert.equal(parseConfig({ decision: { mode: "external", endpoint: "http://127.0.0.1:8080/v1", model: "Julia-1" } }).decision.mode, "external");
  assert.equal(CAPABILITIES.recoveryGuard, "disabled; no files protected");
});

test("checkpoint failure never executes on silence; explicit exception is one decision", () => {
  assert.equal(executionDecision("failed"), "blocked");
  assert.equal(executionDecision("unsupported"), "blocked");
  assert.equal(executionDecision("pending", "proceed-without-recovery"), "blocked");
  assert.equal(executionDecision("failed", "proceed-without-recovery"), "execute-unprotected");
  assert.equal(executionDecision("failed"), "blocked");
  assert.equal(executionDecision("failed", "cancel"), "cancel");
  assert.equal(executionDecision("failed", "retry"), "retry");
  assert.equal(executionDecision("ready"), "execute-protected");
});

test("late recall origin cannot match another run, project or memory revision", () => {
  const origin = { project: "p", session: "s", run: "r", conversationRevision: 1, memoryRevision: 1 };
  assert.equal(isCurrent(origin, { ...origin }), true);
  assert.equal(isCurrent(origin, { ...origin, run: "new" }), false);
  assert.equal(isCurrent(origin, { ...origin, project: "other" }), false);
  assert.equal(isCurrent(origin, { ...origin, memoryRevision: 2 }), false);
});
