import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";
import { decide, ManagedDecision } from "../src/decision.js";

async function server(t: { after: (fn: () => Promise<void>) => void }, handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const s = createServer(handler).listen(0, "127.0.0.1");
  await once(s, "listening");
  t.after(async () => { s.closeAllConnections(); await new Promise<void>((resolve) => s.close(() => resolve())); });
  const address = s.address();
  if (!address || typeof address === "string") throw new Error("Missing server port");
  return `http://127.0.0.1:${address.port}`;
}

test("System One diagnostic validates request, authentication and typed probabilities", async (t) => {
  const endpoint = await server(t, (req, res) => {
    assert.equal(req.url, "/v1/systemone"); assert.equal(req.headers.authorization, "Bearer test-token");
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      const input = JSON.parse(body) as { state: string; questions: { gate: { type: string } } };
      assert.equal(input.state, "task and candidate"); assert.equal(input.questions.gate.type, "choice");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ answers: { gate: { type: "choice", choice: "review", probabilities: { keep: .1, skip: .2, review: .7 } } } }));
    });
  });
  assert.equal((await decide(`${endpoint}/v1`, "Julia-1", "task and candidate", "test-token", 1000)).choice, "review");
});

test("invalid model answers and HTTP errors are surfaced, never treated as keep", async (t) => {
  const endpoint = await server(t, (_req, res) => res.end(JSON.stringify({ answers: { gate: { type: "choice", choice: "keep", probabilities: { keep: 7, skip: 0, review: 0 } } } })));
  await assert.rejects(decide(endpoint, "x", "input", undefined, 1000), /probabilities/);
  const failed = await server(t, (_req, res) => { res.statusCode = 500; res.end("do not expose prompt"); });
  await assert.rejects(decide(failed, "x", "input", undefined, 1000), /HTTP 500/);
});

test("slow decision work times out instead of hanging", async (t) => {
  const endpoint = await server(t, () => {});
  await assert.rejects(decide(endpoint, "x", "input", undefined, 30), (error: unknown) => error instanceof Error && error.name === "TimeoutError");
});

test("missing managed runtime fails clearly and does not leave a startup stuck", async () => {
  const managed = new ManagedDecision();
  await assert.rejects(managed.start("definitely-missing-pi-recall-python", "missing-model"), /Cannot start/);
  managed.stop();
});

test("managed worker readiness and parent EOF lifecycle use no real model", async () => {
  const managed = new ManagedDecision();
  try {
    const result = await managed.start("python", "unused-test-model", join(process.cwd(), "test", "fixtures", "ready-worker.py"));
    assert.match(result.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(result.token.length, 64);
    const same = await managed.start("python", "unused-test-model");
    assert.equal(same.endpoint, result.endpoint);
  } finally { managed.stop(); }
});
