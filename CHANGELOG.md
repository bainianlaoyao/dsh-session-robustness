# Changelog

## 0.1.5

- Retry adapter-native `stream_read_error` / `STREAM_READ_ERROR` (shown as 本轮运行失败 `stream_read_error`).
- Retry catch-all `Upstream request failed` (gateway / proxy wording that pi-ai maps to `PI_AI_ERROR`).
- Treat unknown adapter codes as catch-all when the message or the code itself looks like a stream / upstream failure.

## 0.1.4

- Settings page: status card, official-vs-takeover steps, coverage columns, live takeover list.
- Composer dock copy: "官方 5 次已用完，正在接管第 N 次".
- Docs: official default is `maxRetries = 5` (UI `n/5`), not 2.

## 0.1.3

- Unconditional retry for capturable network codes that reach `agent/request-error`: `STREAM_CLOSED`, `MALFORMED_RESPONSE`, `STREAM`, HTTP 408 / 409 / 425 / 429 / 499 / 5xx.
- Pause uses a dedicated controller so pausing does not abort the plugin lifetime.

## 0.1.2

- Catch-all `PI_AI_ERROR` / `UNKNOWN` retry when the message is clearly transient (Codex overloaded, try again later, service unavailable).
- AUTH / QUOTA still win over the heuristic.

## 0.1.1

- HTTP JSON bridge `res.text()` parse so empty/auth bodies do not crash the settings page.

## 0.1.0

- Dual-half plugin: host waterfall after `@deepseek-ai/dsh-llm-retry`, client settings page and composer dock.
- Default: enabled, `maxRetries: 0` (unbounded after official budget).
