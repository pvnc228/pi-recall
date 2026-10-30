import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CAPABILITIES, parseConfig, type Config } from "./config.js";
import { decide, ManagedDecision } from "./decision.js";
import { MemoryStore, projectIdentity, type Memory } from "./store.js";

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((x): x is { type: "text"; text: string } => !!x && x.type === "text" && typeof x.text === "string").map((x) => x.text).join("\n");
}

export default function recallExtension(pi: ExtensionAPI): void {
  let store: MemoryStore | undefined;
  let session: string | undefined;
  let root: string | undefined;
  let configFile: string | undefined;
  let config: Config = parseConfig();
  const managed = new ManagedDecision();

  function release(): void { managed.stop(); store?.close(); store = undefined; session = undefined; root = undefined; }
  function open(ctx: ExtensionContext): MemoryStore {
    const project = projectIdentity(ctx.cwd);
    const currentSession = ctx.sessionManager.getSessionId();
    if (store && session === currentSession && root === project.root) return store;
    release();
    const dataHome = process.env.PI_RECALL_DATA_DIR ?? join(homedir(), ".pi", "agent", "recall");
    // A cloned repository must never select an executable, endpoint or token env.
    configFile = join(dataHome, project.id, "config.json");
    config = parseConfig(existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {});
    store = new MemoryStore(join(dataHome, project.id, "memory.sqlite"), project.id);
    root = project.root; session = currentSession;
    return store;
  }
  function report(ctx: ExtensionContext, error: unknown): void { ctx.ui.notify(`Pi Recall: ${error instanceof Error ? error.message : "operation failed"}`, "error"); }
  async function chooseMemory(db: MemoryStore, ctx: ExtensionContext): Promise<Memory | undefined> {
    const memories = db.list();
    if (!memories.length) { ctx.ui.notify("No active memories.", "info"); return; }
    const labels = memories.map((m) => `[${m.kind}] ${m.text.slice(0, 100)} (${m.id.slice(0, 8)})`);
    const chosen = await ctx.ui.select("Select memory", labels);
    const index = chosen === undefined ? -1 : labels.indexOf(chosen);
    return index < 0 ? undefined : memories[index];
  }

  pi.on("session_start", (_event, ctx) => {
    try {
      open(ctx);
      ctx.ui.setStatus("pi-recall", "Recall: foundation | auto/recovery OFF");
    } catch (error) { report(ctx, error); }
  });
  pi.on("input", (event, ctx) => {
    const db = open(ctx);
    if (config.capture && event.text.trim()) db.appendSource(ctx.sessionManager.getSessionId(), "user", event.source === "interactive" ? "human" : event.source === "rpc" ? "unattested" : "agent", event.text);
  });
  pi.on("message_end", (event, ctx) => {
    const db = open(ctx);
    if (!config.capture || event.message.role !== "assistant") return;
    const text = contentText(event.message.content);
    if (text.trim()) db.appendSource(ctx.sessionManager.getSessionId(), "assistant", "agent", text);
  });
  // Writes are synchronous FULL transactions; unprocessed sources remain pending.
  pi.on("session_before_compact", (_event, ctx) => { open(ctx); });
  pi.on("session_shutdown", () => { release(); });

  pi.registerCommand("recall", {
    description: "Project-memory foundation: status, configure, list, add, edit, delete, audit, injections, decide",
    handler: async (args, ctx) => {
      try {
        const db = open(ctx);
        const split = args.trim().indexOf(" ");
        const command = (split < 0 ? args.trim() : args.trim().slice(0, split)) || "status";
        const rest = split < 0 ? "" : args.trim().slice(split + 1).trim();
        if (command === "status") {
          ctx.ui.notify(JSON.stringify({ ...CAPABILITIES, configFile, capture: config.capture, decisionMode: config.decision.mode, memories: db.list().length, pendingSources: db.pending().length }, null, 2), "info");
        } else if (command === "configure") {
          const edited = await ctx.ui.editor("Recall local configuration: endpoints and executables are trusted settings", JSON.stringify(config, null, 2));
          if (edited === undefined) return;
          const parsed = parseConfig(JSON.parse(edited));
          const temporary = `${configFile!}.${randomUUID()}.tmp`;
          writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
          renameSync(temporary, configFile!);
          release(); open(ctx);
          ctx.ui.notify("Local configuration saved. No decision request was sent.", "info");
        } else if (command === "list") {
          const memory = await chooseMemory(db, ctx);
          if (memory) {
            const sources = db.sources().filter((s) => memory.sourceIds.includes(s.id));
            await ctx.ui.editor("Memory and provenance (read-only view)", JSON.stringify({ ...memory, sources }, null, 2));
          }
        } else if (command === "add") {
          if (!rest) throw new Error("Usage: /recall add <explicit memory text>");
          const kind = await ctx.ui.select("Memory type", ["fact", "hypothesis"]);
          if (kind !== "fact" && kind !== "hypothesis") return;
          const source = db.appendSource(ctx.sessionManager.getSessionId(), "user", "human", rest);
          const memory = db.add(`manual:${source.id}`, kind, rest, [source.id]);
          ctx.ui.notify(`Saved ${memory.kind}: ${memory.text}`, "info");
        } else if (command === "edit" || command === "delete") {
          const memory = await chooseMemory(db, ctx);
          if (!memory) return;
          if (command === "delete") { db.remove(memory.id); ctx.ui.notify("Deleted; previous evidence is suppressed.", "info"); }
          else {
            const edited = await ctx.ui.editor("Edit memory", memory.text);
            if (edited !== undefined && edited !== memory.text) { db.edit(memory.id, edited, ctx.sessionManager.getSessionId()); ctx.ui.notify("Memory updated; previous evidence is suppressed.", "info"); }
          }
        } else if (command === "audit") {
          await ctx.ui.editor("Memory audit (read-only view)", JSON.stringify(db.events(), null, 2));
        } else if (command === "injections") {
          ctx.ui.notify("No context insertions: automatic recall is not implemented in this foundation.", "info");
        } else if (command === "decide") {
          if (!rest) throw new Error("Usage: /recall decide <task and candidate memory>; diagnostic only, no context insertion");
          const d = config.decision;
          let endpoint: string; let token: string | undefined; let model: string;
          if (d.mode === "managed") {
            if (!d.modelDir) throw new Error("Set decision.modelDir with /recall configure; see README");
            ({ endpoint, token } = await managed.start(d.python, d.modelDir)); model = "Julia-1";
          } else {
            endpoint = d.endpoint; token = d.tokenEnv ? process.env[d.tokenEnv] : undefined; model = d.model;
            if (d.tokenEnv && !token) throw new Error("Configured decision token environment variable is not set");
          }
          const answer = await decide(endpoint, model, rest, token, config.decisionTimeoutMs);
          ctx.ui.notify(`Decision diagnostic (not applied): ${JSON.stringify(answer)}`, "info");
        } else throw new Error("Commands: status, configure, list, add <text>, edit, delete, audit, injections, decide <state>");
      } catch (error) { report(ctx, error); }
    },
  });
}
