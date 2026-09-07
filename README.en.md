# dsh-session-robustness

Engineering-level session robustness for DeepSeek Harness.

When a turn's model request fails with a **transient API error** (timeout, transport, rate limit, 5xx, empty response, dropped SSE), do not let the official bounded retry (`maxRetries = 5`) close the turn. Keep retrying the **same open step** until success, user cancel, or pause.

This is not a client-side "continue" after the turn has already ended, and it does not switch models. It sits after official `dsh-llm-retry` and re-runs the same request on the still-open step.

## Why

`@deepseek-ai/dsh-llm-retry` is already mounted in `dsh-base`. Provider `retryPolicy` defaults to `mode: normal` with `maxRetries: 5` for `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`. The UI shows `已重试模型请求 (n/5)`. After that budget the waterfall delegates, the loop treats the failure as terminal, and the session stops.

Official `mode: always` retries **every** failure including AUTH/QUOTA. This plugin does not: permanent errors cannot succeed by waiting.

From 0.1.3 every capturable network failure that reaches `agent/request-error` is retried unconditionally: `STREAM_CLOSED`, `MALFORMED_RESPONSE`, `STREAM`, `HTTP_408` / `409` / `425` / `429` / `499` / `5xx`. From 0.1.5 that also includes adapter-native `stream_read_error` and gateway wording `Upstream request failed` (usually classified as catch-all `PI_AI_ERROR`). Catch-all `PI_AI_ERROR` / `UNKNOWN` / unknown adapter codes still use the message heuristic.

OpenAI Codex overloaded is a special case: pi-ai classifies

`Codex error: Our servers are currently overloaded. Please try again later.`

as catch-all `PI_AI_ERROR`, not `SERVER`. From 0.1.2 the plugin retries catch-all codes when the message is clearly transient (`overloaded`, `try again later`, `service unavailable`, …). AUTH / QUOTA still win over the heuristic.

Never retried: `AUTH`, `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, `QUOTA`, `CONTEXT_WINDOW_EXCEEDED`, `NO_ADAPTER`, `ABORTED`. Context overflow stays with official compaction. User Stop is not retried.

Failures that never enter `agent/request-error` are out of scope: throws from `prepareCall`, title/summary `ctx.llm.stream()`, and tool failures. In-process subagents share the host waterfall; ACP / out-of-process subagents do not.

From 0.1.6, **openai-codex only**: a failed stream drops that session's WebSocket continuation (`previous_response_id`). pi-ai `websocket-cached` / `auto` can keep a failed stream's `response.id` as the next-request anchor, so later retries stay stuck even after the API is healthy. The drop also runs during the official 5 retries (`llm/stream` is observed, not retried in-stream). Successful Codex streams keep their continuation. Server-side prompt cache and the DSH session log are untouched. Other providers are not closed.

## Install

```bash
dsh plugin --profile web add dsh-session-robustness
```

or from GitHub:

```bash
dsh plugin --profile web add github:bainianlaoyao/dsh-session-robustness
```

Then restart the web profile. Settings → **会话鲁棒性**.

The package declares `dsh.bundle.patch` + `dsh.client`. `dsh plugin add` installs the package and appends it to `dsh.profile.bundles`.

## Usage

1. Open **Settings → 会话鲁棒性**
2. Enabled by default; extra-retry cap `0` means unbounded after the official 5
3. While official retry is in control you see `已重试模型请求 (n/5)` — this plugin has not taken over yet
4. After `5/5` a composer dock appears: "官方 5 次已用完，正在接管第 N 次". Pause from there or from Settings
5. Set a positive cap if you want a hard limit **after** the official 5

You can also write `$DSH_HOME/settings.yaml`:

```yaml
session-robustness:
  enabled: true
  paused: false
  maxRetries: 0          # 0 = unbounded (after official 5)
  initialDelayMs: 1000
  maxDelayMs: 30000
  jitterRatio: 0.2
  extraRetryableCodes: [] # e.g. INVALID_REQUEST; permanent codes are still refused
```

## Not this

- Not `dsh-client-auto-retry`: that sends "continue" after the turn has already ended
- Not `retryPolicy.mode: always`: that retries AUTH/QUOTA
- Not a patch of official npm packages: upgrades will not overwrite it
- Does not wrap `ctx.llm.stream()`: a raw stream cannot durably separate already-emitted chunks

## Uninstall

```bash
dsh plugin --profile web remove dsh-session-robustness
```

The `session-robustness` block in `$DSH_HOME/settings.yaml` stays; delete it manually if you no longer need it.

## Development

```bash
npm test   # static smoke: waterfall takeover, never-retry codes, HTTP JSON bridge
```

## License

MIT
