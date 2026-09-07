# dsh-session-robustness

工程级会话鲁棒：当一次 turn 的模型请求因 **超时 / 传输 / 限流 / 5xx / 空响应 / SSE 断流** 失败时，不要在官方默认的「再试五次」之后把会话掐死，而是 **继续重试直到成功、你取消、或你暂停**。

这不是客户端发「继续」续跑，也不是换模型。它接在官方 `dsh-llm-retry` 后面，在同一个打开的 step 上重跑同一条请求。

## 为什么需要它

DSH 已经有官方重试执行器 `@deepseek-ai/dsh-llm-retry`：

- 挂在 host 组合里（`dsh-base` 已启用）
- 策略写在每个 provider 的 `retryPolicy` 上
- **省略时是 `mode: normal`，默认 `maxRetries = 5`**
- 合格 code：`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`（官方）；本插件额外无条件覆盖 `STREAM_CLOSED` / `MALFORMED_RESPONSE` / `STREAM` / `HTTP_408` / `HTTP_409` / `HTTP_425` / `HTTP_429` / `HTTP_499` / `HTTP_5xx`

所以一次 TIMEOUT 通常是：界面「已重试模型请求 (n/5)」，5/5 之后 `agent/request-error` 不再返回 `{ kind: 'retry' }`，loop 把失败当成终态，turn 结束。

官方也有 `retryPolicy.mode: always`（无次数上限、连 AUTH/QUOTA 也会一直重）。本插件 **不走那条路**：永久错误等也没用，无限重试会把会话挂死并烧钱。本插件只覆盖瞬时 API 失败。

## 行为

```
adapter 流失败
  → agent/request-error waterfall
    → compaction（只处理 CONTEXT_WINDOW_EXCEEDED）
    → dsh-llm-retry（normal：合格 code 最多 5 次）
    → 本插件（官方预算耗尽后，瞬时失败继续重试）
```

- 每次重试都在 **同一个打开的 turn / 同一个 step** 上重跑，失败分片不会进入模型可见历史
- 退避：指数 + 抖动；提供方 `Retry-After` 在上限内优先
- 用户点 Stop / 取消 turn：立即停止
- 设置页可暂停 / 关闭，不必卸插件
- 父会话和 in-process 子 agent 共用 host 上的 `agent/request-error` waterfall，都会接管。进程外 / ACP 子 agent 不会。

永不重试：`AUTH`、`MISSING_CREDENTIAL`、`INVALID_CREDENTIAL`、`QUOTA`、`CONTEXT_WINDOW_EXCEEDED`、`NO_ADAPTER`、`ABORTED`。上下文溢出仍交给官方 compaction。用户 Stop 不会被重试。

0.1.3 起，能进 `agent/request-error` 的**网络失败一律无条件重试**，不再依赖文案：SSE 对端关闭（`STREAM_CLOSED`，例如 `ended without [DONE]`）、半截 JSON（`MALFORMED_RESPONSE`）、Responses 未识别流失败（`STREAM`）、HTTP 408/409/425/429/499/5xx。0.1.5 起还包括适配器原样透传的 `stream_read_error`，以及网关文案 `Upstream request failed`（pi-ai 常落成 `PI_AI_ERROR`）。`PI_AI_ERROR` / `UNKNOWN` / 未知码仍用文案启发式（Codex overloaded、Upstream request failed 等）。`HTTP_400` / `INVALID_REQUEST` / `CONTENT_FILTER` 仍不重试。

进不了 waterfall 的失败本插件也接不到：`prepareCall` 抛错、标题/摘要走的 `ctx.llm.stream()`、工具调用失败。

### Codex overloaded 为什么也要覆盖

`openai-codex` 走 pi-ai。上游 SSE 事件 `error` / `response.failed` 会变成：

`Codex error: Our servers are currently overloaded. Please try again later.`

pi-ai 的 `classifyPiAiError()` 只认 HTTP 状态码和少数关键词，**不认 `overloaded`**，于是失败码落成兜底的 `PI_AI_ERROR`。官方 `dsh-llm-retry` 只重试那 5 个标准码，本插件原先也只看码表，所以这条瞬时失败会直接变成「本轮运行失败」。

0.1.2 起：`PI_AI_ERROR` / `UNKNOWN` 若文案明显是瞬时故障（overloaded、try again later、service unavailable 等），也会继续重试。AUTH / QUOTA 等永久码仍优先，即使文案里写了 try again。

## 安装

```bash
dsh plugin --profile web add dsh-session-robustness
```

或从 GitHub：

```bash
dsh plugin --profile web add github:bainianlaoyao/dsh-session-robustness
```

包声明了 `dsh.bundle.patch` + `dsh.client`。安装后重启 web profile，设置页会出现 **会话鲁棒性**。

本地开发（本仓库）：

```bash
dsh plugin --profile web add D:/Data/DEV/dsh/dsh-session-robustness
```

## 使用

1. 打开 **设置 → 会话鲁棒性**
2. 默认已启用、次数上限 0（无限）
3. 官方还在重试时，聊天里是「已重试模型请求 (n/5)」——这时还没轮到本插件
4. 5/5 之后 composer 上方会出现「官方 5 次已用完，正在接管第 N 次」，可当场暂停
5. 需要硬上限时把「次数上限」改成正整数（这是 **官方 5 次之后** 的额外次数）

也可直接写 `$DSH_HOME/settings.yaml`：

```yaml
session-robustness:
  enabled: true
  paused: false
  maxRetries: 0          # 0 = 无限（官方 5 次之后）
  initialDelayMs: 1000
  maxDelayMs: 30000
  jitterRatio: 0.2
  extraRetryableCodes: [] # 例如 INVALID_REQUEST；永久错误仍会被拒绝
```

## 不是什么

- 不是 `dsh-client-auto-retry`：那个在 turn **已经结束** 后自动发「继续」
- 不是 `retryPolicy.mode: always`：那个会重试 AUTH/QUOTA
- 不是改官方 npm 包：升级不会被覆盖
- 不包装 `ctx.llm.stream()`：原始流无法持久区分已发出的分片

## 卸载

```bash
dsh plugin --profile web remove dsh-session-robustness
```

设置里的 `session-robustness` 段会留在 `$DSH_HOME/settings.yaml`；不需要了就手动删。

## 开发与测试

```bash
npm test   # 静态冒烟：waterfall 接管、永不重试码、HTTP JSON 桥
```

## License

MIT
