export type Config = {
  capture: boolean;
  decisionTimeoutMs: number;
  decision: { mode: "managed"; python: string; modelDir: string | null }
    | { mode: "external"; endpoint: string; model: string; tokenEnv: string | null };
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be an object");
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown configuration field: ${key}`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  return value;
}

function milliseconds(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 600_000) throw new Error(`${field} must be 1..600000 milliseconds`);
  return Number(value);
}

export function parseConfig(input: unknown = {}): Config {
  const value = object(input);
  keys(value, ["capture", "decisionTimeoutMs", "decision"]);
  if (value.capture !== undefined && typeof value.capture !== "boolean") throw new Error("capture must be boolean");
  const d = object(value.decision ?? { mode: "managed" });
  let decision: Config["decision"];
  if (d.mode === "managed") {
    keys(d, ["mode", "python", "modelDir"]);
    decision = { mode: "managed", python: text(d.python ?? "python", "python"), modelDir: d.modelDir == null ? null : text(d.modelDir, "modelDir") };
  } else if (d.mode === "external") {
    keys(d, ["mode", "endpoint", "model", "tokenEnv"]);
    const endpoint = new URL(text(d.endpoint, "endpoint"));
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("endpoint must be an HTTP(S) base URL without credentials, query or fragment");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if (!local && endpoint.protocol !== "https:") throw new Error("Non-loopback endpoints require HTTPS");
    decision = { mode: "external", endpoint: endpoint.href.replace(/\/$/, ""), model: text(d.model, "model"), tokenEnv: d.tokenEnv == null ? null : text(d.tokenEnv, "tokenEnv") };
  } else throw new Error("decision.mode must be managed or external");
  return { capture: value.capture ?? false, decisionTimeoutMs: milliseconds(value.decisionTimeoutMs, 1_000, "decisionTimeoutMs"), decision };
}

export const CAPABILITIES = Object.freeze({
  stage: "foundation",
  journalAndManualMemory: "implemented; capture opt-in",
  automaticExtraction: "not implemented",
  automaticRecall: "not implemented",
  lateRecallUI: "not implemented",
  decisionTransport: "explicit diagnostic calls only",
  recoveryGuard: "disabled; no files protected",
  shellRecovery: "unsupported",
});
