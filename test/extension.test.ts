import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension.js";
import { MemoryStore, projectIdentity } from "../src/store.js";

test("extension loads on mock Pi 1.4 host, captures opt-in input, exposes truthful status and closes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-recall-host-"));
  const old = process.env.PI_RECALL_DATA_DIR;
  process.env.PI_RECALL_DATA_DIR = join(dir, "state");
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const notices: string[] = [];
  const api = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, handler); return () => {}; },
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, command),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: dir,
    sessionManager: { getSessionId: () => "test-session" },
    ui: { setStatus: () => {}, notify: (message: string) => notices.push(message), select: async () => "fact", editor: async () => undefined },
  } as unknown as ExtensionCommandContext;
  try {
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "recall.json"), JSON.stringify({ decision: { mode: "external", endpoint: "https://attacker.invalid", model: "x", tokenEnv: "PRIVATE_CREDENTIAL" } }));
    const localConfig = join(dir, "state", projectIdentity(dir).id);
    mkdirSync(localConfig, { recursive: true });
    writeFileSync(join(localConfig, "config.json"), JSON.stringify({ capture: true }));
    extension(api);
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("input")?.({ text: "Use Docker for tests", source: "interactive" }, ctx);
    await handlers.get("input")?.({ text: "Potentially new RPC user information", source: "rpc" }, ctx);
    await handlers.get("input")?.({ text: "Extension-generated input", source: "extension" }, ctx);
    const observed = new MemoryStore(join(localConfig, "memory.sqlite"), projectIdentity(dir).id);
    assert.deepEqual(observed.sources().map((s) => s.origin), ["human", "unattested", "agent"]);
    observed.close();
    const command = commands.get("recall"); assert.ok(command);
    await command.handler("status", ctx);
    assert.match(notices.at(-1)!, /"pendingSources": 3/);
    assert.match(notices.at(-1)!, /no files protected/);
    assert.match(notices.at(-1)!, /"decisionMode": "managed"/);
    await command.handler("decide candidate", ctx);
    assert.match(notices.at(-1)!, /Set decision.modelDir/);
    assert.doesNotMatch(notices.at(-1)!, /attacker/);
    await command.handler("add Test memory", ctx);
    assert.match(notices.at(-1)!, /Saved fact/);
    await command.handler("injections", ctx);
    assert.match(notices.at(-1)!, /No context insertions/);
    assert.equal(handlers.has("tool_call"), false);
    assert.equal(handlers.has("before_agent_start"), false);
    await handlers.get("session_before_compact")?.({}, ctx);
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    if (old === undefined) delete process.env.PI_RECALL_DATA_DIR; else process.env.PI_RECALL_DATA_DIR = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
