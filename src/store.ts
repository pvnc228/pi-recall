import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Source = { seq: number; id: string; session: string; role: "user" | "assistant"; origin: "human" | "agent" | "replay" | "unattested"; text: string };
export type Memory = { id: string; kind: "fact" | "hypothesis"; text: string; sourceIds: string[]; revision: number };

export function projectIdentity(root: string): { root: string; id: string } {
  const canonical = realpathSync(resolve(root));
  const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return { root: canonical, id: createHash("sha256").update(identity).digest("hex") };
}

function nonempty(text: string, field: string, limit = 16_384): string {
  if (!text.trim() || text.length > limit) throw new Error(`${field} must contain 1..${limit} characters`);
  return text;
}

// A connection belongs to exactly one canonical project. SQL never mixes projects.
export class MemoryStore {
  private readonly db: DatabaseSync;
  constructor(file: string, public readonly projectId: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    closeSync(openSync(file, "a", 0o600));
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, session TEXT NOT NULL, role TEXT NOT NULL, origin TEXT NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, source_ids TEXT NOT NULL, revision INTEGER NOT NULL, active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS suppressed_sources (source_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL);
      INSERT OR IGNORE INTO metadata VALUES ('cursor', '0');`);
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('project', ?)").run(projectId);
    const stored = this.db.prepare("SELECT value FROM metadata WHERE key='project'").get() as { value: string };
    if (stored.value !== projectId) { this.db.close(); throw new Error("Store belongs to a different project"); }
  }
  close(): void { this.db.close(); }
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = run(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private audit(kind: string, payload: unknown): void {
    this.db.prepare("INSERT INTO audit(kind,payload) VALUES (?,?)").run(kind, JSON.stringify(payload));
  }
  appendSource(session: string, role: Source["role"], origin: Source["origin"], content: string): Source {
    nonempty(content, "source", 262_144);
    if (!["user", "assistant"].includes(role) || !["human", "agent", "replay", "unattested"].includes(origin) || (origin === "human" && role !== "user")) throw new Error("Invalid source provenance");
    const id = randomUUID();
    const result = this.db.prepare("INSERT INTO sources(id,session,role,origin,text) VALUES (?,?,?,?,?)").run(id, nonempty(session, "session"), role, origin, content);
    return { seq: Number(result.lastInsertRowid), id, session, role, origin, text: content };
  }
  sources(): Source[] { return this.db.prepare("SELECT * FROM sources ORDER BY seq").all() as Source[]; }
  pending(): Source[] {
    return this.db.prepare("SELECT * FROM sources WHERE seq > CAST((SELECT value FROM metadata WHERE key='cursor') AS INTEGER) ORDER BY seq").all() as Source[];
  }
  markProcessed(through: number): void {
    const max = this.watermark();
    const current = Number((this.db.prepare("SELECT value FROM metadata WHERE key='cursor'").get() as { value: string }).value);
    if (!Number.isSafeInteger(through) || through < current || through > max) throw new Error("Invalid queue cursor");
    this.db.prepare("UPDATE metadata SET value=? WHERE key='cursor'").run(String(through));
  }
  private watermark(): number { return Number((this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM sources").get() as { seq: number }).seq); }
  private decode(row: Record<string, unknown>): Memory {
    return { id: String(row.id), kind: row.kind as Memory["kind"], text: String(row.text), sourceIds: JSON.parse(String(row.source_ids)) as string[], revision: Number(row.revision) };
  }
  list(): Memory[] { return this.db.prepare("SELECT * FROM memories WHERE active=1 ORDER BY rowid").all().map((r) => this.decode(r)); }
  get(id: string): Memory {
    const row = this.db.prepare("SELECT * FROM memories WHERE id=? AND active=1").get(id);
    if (!row) throw new Error("Active memory not found");
    return this.decode(row);
  }
  add(kind: Memory["kind"], content: string, sourceIds: string[]): Memory {
    nonempty(content, "memory");
    if (!["fact", "hypothesis"].includes(kind)) throw new Error("Invalid memory kind");
    if (!sourceIds.length || sourceIds.length > 100 || new Set(sourceIds).size !== sourceIds.length) throw new Error("Exact, unique source IDs are required");
    return this.transaction(() => {
      const evidence = sourceIds.map((id) => {
        const source = this.db.prepare("SELECT * FROM sources WHERE id=?").get(id) as Source | undefined;
        if (!source) throw new Error("Unknown evidence source");
        return source;
      });
      const suppressed = this.db.prepare("SELECT 1 FROM suppressed_sources WHERE source_id=?");
      if (sourceIds.some((id) => suppressed.get(id))) throw new Error("Deleted evidence is suppressed");
      if (kind === "fact" && !evidence.some((s) => s.role === "user" && s.origin === "human")) throw new Error("A fact requires original user evidence");
      const memory: Memory = { id: randomUUID(), kind, text: content, sourceIds, revision: 1 };
      this.db.prepare("INSERT INTO memories VALUES (?,?,?,?,?,1)").run(memory.id, kind, content, JSON.stringify(sourceIds), 1);
      this.audit("memory_added", memory);
      return memory;
    });
  }
  private suppress(memory: Memory): void {
    const insert = this.db.prepare("INSERT OR IGNORE INTO suppressed_sources VALUES (?)");
    for (const id of memory.sourceIds) insert.run(id);
  }
  remove(id: string): void {
    this.transaction(() => {
      const memory = this.get(id);
      this.db.prepare("UPDATE memories SET active=0 WHERE id=?").run(id);
      this.suppress(memory);
      this.audit("memory_deleted", memory);
    });
  }
  edit(id: string, text: string, session: string): Memory {
    nonempty(text, "memory");
    return this.transaction(() => {
      const prior = this.get(id);
      this.suppress(prior);
      const source = this.appendSource(session, "user", "human", text);
      const updated: Memory = { ...prior, text, sourceIds: [source.id], revision: prior.revision + 1 };
      this.db.prepare("UPDATE memories SET text=?,source_ids=?,revision=? WHERE id=?").run(text, JSON.stringify(updated.sourceIds), updated.revision, id);
      this.audit("memory_edited", { ...updated, previous: prior });
      return updated;
    });
  }
  events(): { seq: number; kind: string; payload: unknown }[] {
    return this.db.prepare("SELECT * FROM audit ORDER BY seq").all().map((r) => ({ seq: Number(r.seq), kind: String(r.kind), payload: JSON.parse(String(r.payload)) as unknown }));
  }
}
