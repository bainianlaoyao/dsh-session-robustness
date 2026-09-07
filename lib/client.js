window.__ModuleLoader__.load({
  id: "dsh-session-robustness",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    const inject = ["slots"];
    const PLUGIN = "dsh-session-robustness";
    const VERSION = "0.1.5";

    const NETWORK_LABELS = [
      ["TIMEOUT", "超时"],
      ["TRANSPORT", "传输 / 断连（含 fetch failed）"],
      ["RATE_LIMIT", "限流 429"],
      ["SERVER", "服务端 5xx"],
      ["EMPTY_RESPONSE", "空响应"],
      ["STREAM_CLOSED", "SSE 断流"],
      ["MALFORMED_RESPONSE", "畸形 SSE"],
      ["STREAM", "流失败"],
      ["stream_read_error", "读流出错（适配器原码）"],
      ["HTTP_408+", "HTTP 408 / 409 / 425 / 429 / 499 / 5xx"]
    ];
    const NEVER_LABELS = [
      ["AUTH", "认证失败"],
      ["QUOTA", "额度耗尽"],
      ["CONTEXT_WINDOW_EXCEEDED", "上下文溢出（交给压缩）"],
      ["ABORTED", "你点了停止"],
      ["MISSING_CREDENTIAL", "缺少密钥"],
      ["NO_ADAPTER", "没有对应模型适配器"]
    ];

    function parseBody(res) {
      return res.text().then((text) => {
        const trimmed = String(text || "").trim();
        if (!trimmed) {
          throw new Error("Host 半边未挂载（空响应 HTTP " + res.status + "）。当前进程是在安装前启动的：重启 dsh web 后本页即可工作。");
        }
        try {
          return JSON.parse(trimmed);
        } catch (err) {
          throw new Error("Host 返回了非 JSON（HTTP " + res.status + "）。若刚安装插件，请重启 dsh web。");
        }
      });
    }

    function callHost(method, args) {
      return fetch("/session-robustness/api/" + method, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args || {}),
        credentials: "same-origin"
      }).then((res) => parseBody(res).then((body) => {
        if (!res.ok || (body && body.ok === false)) {
          throw new Error((body && (body.error || body.note)) || ("HTTP " + res.status));
        }
        return body;
      }));
    }

    function insertStyles(css) {
      if (typeof document === "undefined") return () => {};
      const tagId = PLUGIN + "/styles";
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return () => {};
      const tag = document.createElement("style");
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
      return () => { try { if (tag.parentNode) tag.parentNode.removeChild(tag); } catch {} };
    }

    const CSS =
      ".sr-root{display:flex;flex-direction:column;gap:16px;padding:2px 2px 28px;font-size:13px;color:var(--dsw-alias-label-primary);line-height:1.45}" +
      ".sr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}" +
      ".sr-title{display:flex;flex-direction:column;gap:2px}" +
      ".sr-name{font-weight:600;font-size:15px}" +
      ".sr-muted{color:var(--dsw-alias-label-secondary);font-size:12px}" +
      ".sr-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}" +
      ".sr-btn{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer}" +
      ".sr-btn:hover{border-color:var(--dsw-alias-brand-primary)}" +
      ".sr-btn:disabled{opacity:.5;cursor:not-allowed}" +
      ".sr-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-on-brand, #fff)}" +
      ".sr-btn.danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}" +
      ".sr-msg{padding:8px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;white-space:pre-wrap}" +
      ".sr-msg.error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}" +
      ".sr-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px}" +
      ".sr-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
      ".sr-field{display:flex;flex-direction:column;gap:4px}" +
      ".sr-field label{font-size:11px;color:var(--dsw-alias-label-secondary)}" +
      ".sr-field input,.sr-field textarea{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:6px 8px;font-size:12px}" +
      ".sr-chip{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:2px 8px;font-size:11px;color:var(--dsw-alias-label-secondary)}" +
      ".sr-chip.ok{color:var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary));border-color:currentColor}" +
      ".sr-chip.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}" +
      ".sr-chip.bad{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}" +
      ".sr-status{display:flex;align-items:center;gap:10px}" +
      ".sr-dot{width:10px;height:10px;border-radius:99px;background:var(--dsw-alias-brand-primary);flex:0 0 auto}" +
      ".sr-dot.warn{background:var(--dsw-alias-state-warn-primary)}" +
      ".sr-dot.off{background:var(--dsw-alias-label-secondary)}" +
      ".sr-status-copy{display:flex;flex-direction:column;gap:2px}" +
      ".sr-status-title{font-weight:600;font-size:14px}" +
      ".sr-steps{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}" +
      ".sr-step{display:grid;grid-template-columns:22px 1fr;gap:8px;align-items:start}" +
      ".sr-n{width:22px;height:22px;border-radius:99px;border:1px solid var(--dsw-alias-border-l1);display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--dsw-alias-label-secondary)}" +
      ".sr-live{display:flex;flex-direction:column;gap:8px}" +
      ".sr-live-row{padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:4px}" +
      ".sr-cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}" +
      ".sr-item{display:flex;flex-direction:column;gap:1px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}" +
      ".sr-item:last-child{border-bottom:none}" +
      ".sr-code{font-family:ui-monospace,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-secondary)}" +
      ".sr-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}" +
      ".sr-dock{display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-primary)}" +
      ".sr-pulse{width:8px;height:8px;border-radius:99px;background:var(--dsw-alias-state-warn-primary)}" +
      "@media (max-width:640px){.sr-cols,.sr-grid{grid-template-columns:1fr}}";

    function formatDelay(ms) {
      if (!Number.isFinite(ms)) return "?";
      if (ms < 1000) return Math.round(ms) + "ms";
      return (ms / 1000).toFixed(1) + "s";
    }

    function remainMs(row) {
      const nextAt = row && Number(row.nextAt);
      if (!Number.isFinite(nextAt) || nextAt <= 0) return Number(row && row.delayMs) || 0;
      return Math.max(0, nextAt - Date.now());
    }

    function statusView(cfg) {
      if (cfg.enabled === false) {
        return { title: "已关闭", detail: "瞬时 API 失败会在官方 5 次之后结束本轮。", dot: "off", chip: "已关闭", chipClass: "bad" };
      }
      if (cfg.paused) {
        return { title: "已暂停", detail: "新的失败不再接管；进行中的退避已中止。点启用可恢复。", dot: "warn", chip: "已暂停", chipClass: "warn" };
      }
      const cap = (cfg.maxRetries || 0) === 0 ? "官方 5 次之后无限重试" : ("官方 5 次之后最多再试 " + cfg.maxRetries + " 次");
      return { title: "运行中", detail: cap + "。父会话和 in-process 子 agent 都会接管。", dot: "", chip: "已启用", chipClass: "ok" };
    }

    function RobustnessSettings() {
      const [data, setData] = react.useState(null);
      const [busy, setBusy] = react.useState("");
      const [msg, setMsg] = react.useState("");
      const [err, setErr] = react.useState("");
      const [form, setForm] = react.useState(null);

      const refresh = react.useCallback(() => {
        return callHost("status", {}).then(
          (r) => {
            setData(r);
            setErr("");
            const c = r.config || {};
            setForm((prev) => prev || {
              extraRetryableCodes: (c.extraRetryableCodes || []).join(", "),
              initialDelayMs: String(c.initialDelayMs ?? 1000),
              maxDelayMs: String(c.maxDelayMs ?? 30000),
              jitterRatio: String(c.jitterRatio ?? 0.2),
              maxRetries: String(c.maxRetries ?? 0)
            });
            return r;
          },
          (e) => { setErr("加载失败: " + String(e && e.message || e)); }
        );
      }, []);

      react.useEffect(() => { refresh(); }, [refresh]);
      react.useEffect(() => {
        const id = setInterval(() => { refresh(); }, 1500);
        return () => clearInterval(id);
      }, [refresh]);

      const run = (label, p) => {
        setBusy(label);
        setMsg("");
        setErr("");
        return Promise.resolve(p).then(
          (r) => { if (r && r.note) setMsg(String(r.note)); return refresh(); },
          (e) => setErr(label + " 失败: " + String(e && e.message || e))
        ).finally(() => setBusy(""));
      };

      const cfg = data && data.config ? data.config : {};
      const active = data && Array.isArray(data.active) ? data.active : [];
      const st = statusView(cfg);
      const extras = (cfg.extraRetryableCodes || []).filter(Boolean);

      const elems = [
        react.createElement("div", { key: "head", className: "sr-head" },
          react.createElement("div", { className: "sr-title" },
            react.createElement("span", { className: "sr-name" }, "会话鲁棒性"),
            react.createElement("span", { className: "sr-muted" }, "网络失败不要掐会话 · v" + VERSION)
          )
        )
      ];

      if (err) elems.push(react.createElement("div", { key: "err", className: "sr-msg error" }, err));
      if (msg) elems.push(react.createElement("div", { key: "msg", className: "sr-msg" }, msg));
      if (busy) elems.push(react.createElement("div", { key: "busy", className: "sr-msg" }, busy + " …"));

      elems.push(react.createElement("div", { key: "state", className: "sr-card" },
        react.createElement("div", { className: "sr-status" },
          react.createElement("span", { className: "sr-dot" + (st.dot ? " " + st.dot : "") }),
          react.createElement("div", { className: "sr-status-copy" },
            react.createElement("div", { className: "sr-status-title" }, st.title),
            react.createElement("div", { className: "sr-muted" }, st.detail)
          )
        ),
        react.createElement("div", { className: "sr-row" },
          react.createElement("span", { className: "sr-chip " + st.chipClass }, st.chip),
          react.createElement("span", { className: "sr-chip" }, (cfg.maxRetries || 0) === 0 ? "无次数上限" : ("接管后最多 " + cfg.maxRetries + " 次")),
          react.createElement("span", { className: "sr-chip" }, "退避 " + formatDelay(cfg.initialDelayMs || 1000) + " → " + formatDelay(cfg.maxDelayMs || 30000))
        ),
        react.createElement("div", { className: "sr-row" },
          react.createElement("button", {
            className: "sr-btn" + (cfg.enabled !== false && !cfg.paused ? "" : " primary"),
            disabled: !!busy || (cfg.enabled !== false && !cfg.paused),
            onClick: () => run("启用", callHost("resume", {}))
          }, "启用"),
          react.createElement("button", {
            className: "sr-btn",
            disabled: !!busy || cfg.enabled === false || cfg.paused,
            onClick: () => run("暂停", callHost("pause", {}))
          }, "暂停接管"),
          react.createElement("button", {
            className: "sr-btn danger",
            disabled: !!busy || cfg.enabled === false,
            onClick: () => run("关闭", callHost("update", { enabled: false }))
          }, "关闭")
        )
      ));

      elems.push(react.createElement("div", { key: "how", className: "sr-card" },
        react.createElement("div", { className: "sr-name" }, "聊天里你会看到什么"),
        react.createElement("ol", { className: "sr-steps" },
          react.createElement("li", { className: "sr-step" },
            react.createElement("span", { className: "sr-n" }, "1"),
            react.createElement("div", null,
              react.createElement("div", null, "官方先重试，最多 5 次"),
              react.createElement("div", { className: "sr-hint" }, "文案是「已重试模型请求 (n/5)」。这时还没轮到本插件。")
            )
          ),
          react.createElement("li", { className: "sr-step" },
            react.createElement("span", { className: "sr-n" }, "2"),
            react.createElement("div", null,
              react.createElement("div", null, "5/5 之后本插件接管，同一条请求继续重"),
              react.createElement("div", { className: "sr-hint" }, "composer 上方会出现「API 瞬时失败，第 N 次重试」。官方计数不再涨。")
            )
          ),
          react.createElement("li", { className: "sr-step" },
            react.createElement("span", { className: "sr-n" }, "3"),
            react.createElement("div", null,
              react.createElement("div", null, "成功、你点停止、或在这里暂停，才会结束"),
              react.createElement("div", { className: "sr-hint" }, "认证失败、额度耗尽、上下文溢出不会重试，避免空转烧钱。")
            )
          )
        )
      ));

      if (active.length > 0) {
        elems.push(react.createElement("div", { key: "live", className: "sr-card" },
          react.createElement("div", { className: "sr-row" },
            react.createElement("span", { className: "sr-name" }, "正在接管"),
            react.createElement("span", { className: "sr-chip warn" }, active.length + " 条")
          ),
          react.createElement("div", { className: "sr-live" },
            active.map((row) => react.createElement("div", { key: String(row.sessionId) + ":" + row.turn + ":" + row.step, className: "sr-live-row" },
              react.createElement("div", { className: "sr-row" },
                react.createElement("span", { className: "sr-chip warn" }, "第 " + row.attempt + " 次"),
                react.createElement("span", { className: "sr-chip" }, row.provider || "?"),
                react.createElement("span", { className: "sr-chip" }, row.code || ""),
                react.createElement("span", { className: "sr-muted" }, "还需 " + formatDelay(remainMs(row)))
              ),
              row.message ? react.createElement("div", { className: "sr-muted" }, String(row.message).slice(0, 220)) : null
            ))
          )
        ));
      }

      elems.push(react.createElement("div", { key: "cover", className: "sr-card" },
        react.createElement("div", { className: "sr-name" }, "覆盖范围"),
        react.createElement("div", { className: "sr-cols" },
          react.createElement("div", null,
            react.createElement("div", { className: "sr-muted" }, "会无限重试（网络失败）"),
            NETWORK_LABELS.map((pair) => react.createElement("div", { key: pair[0], className: "sr-item" },
              react.createElement("span", null, pair[1]),
              react.createElement("span", { className: "sr-code" }, pair[0])
            )),
            react.createElement("div", { className: "sr-item" },
              react.createElement("span", null, "Codex overloaded / Upstream request failed 等兜底文案"),
              react.createElement("span", { className: "sr-code" }, "PI_AI_ERROR / UNKNOWN + 瞬时文案")
            )
          ),
          react.createElement("div", null,
            react.createElement("div", { className: "sr-muted" }, "不会重试"),
            NEVER_LABELS.map((pair) => react.createElement("div", { key: pair[0], className: "sr-item" },
              react.createElement("span", null, pair[1]),
              react.createElement("span", { className: "sr-code" }, pair[0])
            )),
            react.createElement("div", { className: "sr-item" },
              react.createElement("span", null, "坏请求 / 内容过滤"),
              react.createElement("span", { className: "sr-code" }, "INVALID_REQUEST / HTTP_400 / CONTENT_FILTER")
            )
          )
        )
      ));

      if (form) {
        elems.push(react.createElement("div", { key: "form", className: "sr-card" },
          react.createElement("div", { className: "sr-name" }, "接管后的退避"),
          react.createElement("div", { className: "sr-hint" }, "这是官方 5 次之后的参数。次数上限 0 = 一直重到成功或你取消。"),
          react.createElement("div", { className: "sr-grid" },
            react.createElement("div", { className: "sr-field" },
              react.createElement("label", null, "初始延迟（毫秒）"),
              react.createElement("input", { value: form.initialDelayMs, onChange: (e) => setForm(Object.assign({}, form, { initialDelayMs: e.target.value })) }),
              react.createElement("span", { className: "sr-hint" }, "第一次接管等待多久")
            ),
            react.createElement("div", { className: "sr-field" },
              react.createElement("label", null, "最大延迟（毫秒）"),
              react.createElement("input", { value: form.maxDelayMs, onChange: (e) => setForm(Object.assign({}, form, { maxDelayMs: e.target.value })) }),
              react.createElement("span", { className: "sr-hint" }, "指数退避的上限，默认 30s")
            ),
            react.createElement("div", { className: "sr-field" },
              react.createElement("label", null, "抖动 0–1"),
              react.createElement("input", { value: form.jitterRatio, onChange: (e) => setForm(Object.assign({}, form, { jitterRatio: e.target.value })) }),
              react.createElement("span", { className: "sr-hint" }, "避免多会话同时打爆网关")
            ),
            react.createElement("div", { className: "sr-field" },
              react.createElement("label", null, "次数上限（0 = 无限）"),
              react.createElement("input", { value: form.maxRetries, onChange: (e) => setForm(Object.assign({}, form, { maxRetries: e.target.value })) }),
              react.createElement("span", { className: "sr-hint" }, "只限制本插件，不含官方那 5 次")
            )
          ),
          react.createElement("div", { className: "sr-field" },
            react.createElement("label", null, "额外可重试 code（逗号分隔）"),
            react.createElement("input", {
              value: form.extraRetryableCodes,
              placeholder: "一般不用填。AUTH / QUOTA 仍会被拒绝",
              onChange: (e) => setForm(Object.assign({}, form, { extraRetryableCodes: e.target.value }))
            })
          ),
          extras.length ? react.createElement("div", { className: "sr-row" }, extras.map((c) => react.createElement("span", { key: c, className: "sr-chip" }, c))) : null,
          react.createElement("div", { className: "sr-row" },
            react.createElement("button", {
              className: "sr-btn primary",
              disabled: !!busy,
              onClick: () => run("保存", callHost("update", {
                extraRetryableCodes: form.extraRetryableCodes.split(/[,\s]+/).filter(Boolean),
                initialDelayMs: Number(form.initialDelayMs),
                maxDelayMs: Number(form.maxDelayMs),
                jitterRatio: Number(form.jitterRatio),
                maxRetries: Number(form.maxRetries)
              }))
            }, "保存")
          )
        ));
      }

      return react.createElement("div", { className: "sr-root" }, elems);
    }

    function RetryDock(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : "";
      const [row, setRow] = react.useState(null);
      react.useEffect(() => {
        let cancelled = false;
        const tick = () => {
          callHost("status", {}).then(
            (r) => {
              if (cancelled) return;
              const list = r && Array.isArray(r.active) ? r.active : [];
              const hit = sessionId ? list.find((x) => x.sessionId === sessionId) : list[0];
              setRow(hit || null);
            },
            () => { if (!cancelled) setRow(null); }
          );
        };
        tick();
        const id = setInterval(tick, 1000);
        return () => { cancelled = true; clearInterval(id); };
      }, [sessionId]);
      if (!row) return null;
      return react.createElement("div", { className: "sr-dock" },
        react.createElement("span", { className: "sr-pulse" }),
        react.createElement("span", null, "官方 5 次已用完，正在接管第 " + row.attempt + " 次"),
        react.createElement("span", { className: "sr-muted" }, (row.code || "") + " · 还需 " + formatDelay(remainMs(row))),
        react.createElement("button", { className: "sr-btn danger", onClick: () => callHost("pause", {}).then(() => setRow(null)) }, "暂停接管")
      );
    }

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots === undefined) return;
      const disposeStyles = insertStyles(CSS);
      ctx.effect(() => disposeStyles);
      slots.inject("settings.section", () => slots.register(
        { name: "settings.section", id: "session-robustness", order: 13, label: () => "会话鲁棒性" },
        RobustnessSettings
      ));
      slots.inject("conversation.input.dock", () => slots.register(
        { name: "conversation.input.dock", id: "session-robustness", order: 5, label: () => "会话鲁棒性" },
        RetryDock
      ));
    }

    module.exports = { inject, apply, PLUGIN, VERSION };
    return module.exports;
  }
});
