# Contributing

This is a dual-half DSH plugin (`dsh.bundle.patch` + `dsh.client`). Keep that shape.

## Layout

- `lib/index.js` — host half. Listens on `agent/request-error` **after** official `@deepseek-ai/dsh-llm-retry`. Do not append `llm/retry` events: a retry count above the official max would break session invariants.
- `lib/client.js` — browser half. Settings section + composer dock. Talks to the host over `POST /session-robustness/api/<method>`.
- `cordis.patch.yml` — one `insert` row so `dsh plugin add` mounts the host half.

## Rules

- Retry only failures that already reached `agent/request-error` and that waiting can fix.
- Never retry `AUTH` / `QUOTA` / `ABORTED` / `CONTEXT_WINDOW_EXCEEDED` / missing adapter or credentials.
- Do not wrap `ctx.llm.stream()`.
- Host and client stay plain JavaScript (no TypeScript, JSX, or bundler).

## Test

```bash
npm test
```
