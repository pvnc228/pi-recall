# Contributing

Start with the scope in the [README](README.md). The project is an early scaffold.
Never describe a fake-engine test as model validation.

## Checks

```sh
npm ci --ignore-scripts
npm run check
npm test
python -m unittest discover -s python/tests -v
python -m py_compile python/worker.py python/tests/test_worker.py
ruff check python test/fixtures
npm audit --audit-level=high
npm pack --dry-run
```

Ruff is a development-only tool. Python runtime code uses the standard library;
the real Julia runtime is installed separately. The npm override of `undici`
patches a transitive SDK development dependency. It does not update a user's
existing Pi installation or audit its bundled runtime.

## Boundaries

- Keep changes local; do not auto-install into a user's active Pi configuration.
- Keep TypeScript host integration small. Use Pi's configured model API for
  future generation rather than introducing another provider abstraction.
- Managed/external decision services share the System One protocol.
- Source provenance is immutable. Do not invent a human source from assistant
  output, an RPC replay, a compaction summary or a model's confidence score.
- Add behavioral tests for lifecycle/race/data-loss fixes. Prefer standard
  library tooling to new infrastructure.
- Never commit databases, model weights, tokens or transcripts.
- Commits and releases must not contain AI co-author attribution or generator
  footers. No hooks should be bypassed.

Before expanding any disabled capability, update its status, tests and user-facing
limitations together. Run model-quality evaluation separately from unit tests.
