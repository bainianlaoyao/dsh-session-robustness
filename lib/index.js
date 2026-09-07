import z from '@deepseek-ai/schemastery';

/**
 * dsh-session-robustness host half.
 *
 * Rides AFTER the shipped `@deepseek-ai/dsh-llm-retry` executor on the
 * `agent/request-error` waterfall. Official normal mode retries a bounded
 * set of codes (default maxRetries=5) then delegates; this plugin keeps
 * retrying every capturable network / transport failure until success,
 * user cancel, pause, or dispose: timeout, transport, rate-limit, 5xx,
 * empty response, dropped SSE (`STREAM_CLOSED`), malformed SSE
 * (`MALFORMED_RESPONSE`), unclassified stream (`STREAM`), adapter-native
 * stream-read failures (`stream_read_error` / `STREAM_READ_ERROR`), and
 * HTTP 408 / 409 / 425 / 429 / 499 / 5xx.
 *
 * Adapters do not always map transient upstream text onto that code set.
 * OpenAI Codex overloaded arrives as `PI_AI_ERROR` with
 * "Codex error: Our servers are currently overloaded. Please try again later."
 * Gateway wording such as `Upstream request failed` is the same shape.
 * Catch-all / unknown adapter codes still use a message heuristic.
 * Permanent failures (AUTH / QUOTA / abort / missing or invalid
 * credentials / context overflow / no adapter) are never retried.
 *
 * Recovery stays on the open-step loop boundary so each retry re-runs
 * the same step over the same durable history. `llm/stream` is wrapped
 * only to observe a failed openai-codex finish and drop the pi-ai
 * WebSocket continuation (`previous_response_id`); chunks are forwarded
 * unchanged and the stream is never retried from inside the wrap.
 */

const name = 'dsh-session-robustness';
const inject = ['webServer'];
const VERSION = '0.1.6';
const NS = 'session-robustness';
const API_PREFIX = '/session-robustness/api';

const DEFAULT_RETRYABLE = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'STREAM_CLOSED',
  'MALFORMED_RESPONSE',
  'STREAM',
  'STREAM_READ_ERROR',
  'STREAM_READ',
]);

/** Failures that waiting cannot fix. Extra codes still cannot override these. */
const NEVER_RETRY = Object.freeze([
  'AUTH',
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'QUOTA',
  'CONTEXT_WINDOW_EXCEEDED',
  'NO_ADAPTER',
  'INVALID_CREDENTIAL_CODE',
  'ABORTED',
]);

/**
 * Network / transport codes retried even when the user trimmed
 * `retryableCodes`. HTTP 5xx and a few 4xx timeouts are matched by prefix.
 */
const NETWORK_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'STREAM_CLOSED',
  'MALFORMED_RESPONSE',
  'STREAM',
  'STREAM_READ_ERROR',
  'STREAM_READ',
]);

/** HTTP statuses that are load / timeout / disconnect, not a bad request. */
const NETWORK_HTTP_STATUSES = Object.freeze([408, 409, 425, 429, 499]);

/**
 * Catch-all adapter codes that mix transient and permanent. Official
 * llm-retry never retries these; we only do when the message looks like
 * a network / overload failure.
 */
const CATCHALL_CODES = Object.freeze([
  'PI_AI_ERROR',
  'UNKNOWN',
]);

/** Codex / gateway / transport wording that waiting can recover. */
const TRANSIENT_MESSAGE = /overloaded|try again later|please try again|try your request again|you can retry|please retry|service.?unavailable|temporarily unavailable|server.?error|internal.?error|too many requests|upstream.?connect|upstream.?request|upstream.?fail|bad gateway|gateway.?timeout|stream[_ ]?read|read.?error|connection.?refused|reset before headers|stream ended|ended without|ended before|malformed SSE|no response body|websocket|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up|premature close|other side closed|HTTP2 request did not get a response|fetch failed|network.?error|connection.?error|connection.?lost|connection.?reset|timed? out|timeout|terminated|ResourceExhausted|provider.?returned.?error/i;

/** Adapter-native codes that are stream / transport, not a DSH standard code. */
const NETWORK_CODE_RE = /stream[_ ]?read|stream[_ ]?closed|stream[_ ]?error|read[_ ]?error|sock[_ ]?hang|und_err|econnreset|enotfound|eai_again|upstream/i;

/** Wording that waiting cannot recover, even if mixed with "try again". */
const PERMANENT_MESSAGE = /insufficient_quota|out of budget|quota exceeded|GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|invalid.?api.?key|missing.?credential|unauthorized|forbidden|context.?length|maximum context|context window/i;

const MAX_TIMER_DELAY_MS = 2147483647;

const ConfigSchema = z.object({
  enabled: z.boolean().default(true),
  paused: z.boolean().default(false),
  retryableCodes: z.array(z.string()).default([...DEFAULT_RETRYABLE]),
  extraRetryableCodes: z.array(z.string()).default([]),
  initialDelayMs: z.number().default(1000),
  maxDelayMs: z.number().default(30_000),
  jitterRatio: z.number().default(0.2),
  /** 0 = unbounded (keep retrying until success / cancel / pause). */
  maxRetries: z.number().step(1).min(0).default(0),
});

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeCodes(list, fallback) {
  if (!Array.isArray(list) || list.length === 0) return [...fallback];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const code = String(item || '').trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out.length > 0 ? out : [...fallback];
}

function resolveConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const retryableCodes = normalizeCodes(src.retryableCodes, DEFAULT_RETRYABLE);
  const extraRetryableCodes = normalizeCodes(src.extraRetryableCodes, []);
  const initialDelayMs = clampNumber(src.initialDelayMs, 1000, 1, MAX_TIMER_DELAY_MS);
  let maxDelayMs = clampNumber(src.maxDelayMs, 30_000, 1, MAX_TIMER_DELAY_MS);
  if (initialDelayMs > maxDelayMs) maxDelayMs = initialDelayMs;
  const jitterRatio = clampNumber(src.jitterRatio, 0.2, 0, 1);
  const maxRetries = Math.max(0, Math.trunc(clampNumber(src.maxRetries, 0, 0, Number.MAX_SAFE_INTEGER)));
  return {
    enabled: src.enabled !== false,
    paused: src.paused === true,
    retryableCodes,
    extraRetryableCodes,
    initialDelayMs,
    maxDelayMs,
    jitterRatio,
    maxRetries,
  };
}

function eligibleCodes(config) {
  const set = new Set([...config.retryableCodes, ...config.extraRetryableCodes]);
  for (const code of NEVER_RETRY) set.delete(code);
  return set;
}

function localDelay(config, retry, random) {
  const exponent = Math.min(Math.max(retry, 1) - 1, 1024);
  const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs);
  const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random();
  return Math.min(exponential * jitter, config.maxDelayMs);
}

function computeDelay(config, retry, failure, random) {
  const after = failure && failure.providerRetryAfterMs;
  if (after !== undefined && Number.isFinite(after) && after > 0) {
    if (after > config.maxDelayMs) return localDelay(config, retry, random);
    return after;
  }
  return localDelay(config, retry, random);
}

function isRetryable(config, code) {
  if (!code || NEVER_RETRY.includes(code)) return false;
  return eligibleCodes(config).has(code);
}

function isTransientMessage(message) {
  const text = message == null ? '' : String(message);
  if (!text) return false;
  if (PERMANENT_MESSAGE.test(text)) return false;
  return TRANSIENT_MESSAGE.test(text);
}

function httpStatusOf(code, failure) {
  if (failure && Number.isInteger(failure.status) && failure.status >= 100 && failure.status <= 599) {
    return failure.status;
  }
  const m = /^HTTP_(\d{3})$/.exec(code || '');
  return m ? Number(m[1]) : 0;
}

function isNetworkHttpStatus(status) {
  if (!status) return false;
  if (status >= 500 && status <= 599) return true;
  return NETWORK_HTTP_STATUSES.includes(status);
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[-\s]+/g, '_');
}

function isNeverRetryCode(code) {
  if (!code) return false;
  return NEVER_RETRY.includes(code) || NEVER_RETRY.includes(normalizeCode(code));
}

function isNetworkCode(code) {
  if (!code || isNeverRetryCode(code)) return false;
  const upper = normalizeCode(code);
  if (NETWORK_CODES.includes(code) || NETWORK_CODES.includes(upper)) return true;
  if (NETWORK_CODE_RE.test(code) || NETWORK_CODE_RE.test(upper)) return true;
  return isNetworkHttpStatus(httpStatusOf(code, null)) || isNetworkHttpStatus(httpStatusOf(upper, null));
}

function isCatchallCode(code) {
  if (!code) return true;
  const upper = normalizeCode(code);
  if (CATCHALL_CODES.includes(code) || CATCHALL_CODES.includes(upper)) return true;
  if (isNeverRetryCode(code) || isNetworkCode(code)) return false;
  if (/^HTTP_\d{3}$/.test(upper)) return false;
  if (upper === 'INVALID_REQUEST' || upper === 'CONTENT_FILTER') return false;
  return true;
}

/**
 * Unconditional retry for capturable network / transport failures.
 * Permanent codes still win. Catch-all codes (`PI_AI_ERROR` / `UNKNOWN`)
 * only retry when the message is clearly a network or overload failure.
 */
function isRetryableFailure(config, failure) {
  const code = failure && failure.code ? String(failure.code) : '';
  const message = failure && failure.message != null ? String(failure.message) : '';
  if (isNeverRetryCode(code)) return false;
  if (isNetworkCode(code) || isNetworkHttpStatus(httpStatusOf(code, failure))) return true;
  if (code && (isRetryable(config, code) || isRetryable(config, normalizeCode(code)))) return true;
  if (!isCatchallCode(code)) return false;
  return isTransientMessage(message) || isTransientMessage(code);
}

function sessionKey(agent) {
  const id = agent && (agent.id || (agent.session && agent.session.id));
  return id == null ? '' : String(id);
}

function isCodexProvider(provider) {
  const p = String(provider || '').trim().toLowerCase();
  return p === 'openai-codex' || p.startsWith('openai-codex/');
}

/**
 * openai-codex (pi-ai websocket-cached / auto) stores lastResponseId on the
 * reused WebSocket. A failed stream can still mint a response.id; the next
 * retry then sends previous_response_id against that incomplete response,
 * so recovery never happens even after the API is healthy.
 *
 * Only openai-codex is closed. A successful stream keeps its continuation.
 * Official bounded retries never reach recover(), so llm/stream also drops
 * after a failed finish / throw.
 */
const CODEX_WS_SPECS = Object.freeze([
  '@earendil-works/pi-ai/api/openai-codex-responses.js',
  '@earendil-works/pi-ai/api/openai-codex-responses',
  '@earendil-works/pi-ai',
]);

let cachedCodexCloser;

async function loadCodexCloser() {
  if (cachedCodexCloser && typeof cachedCodexCloser.close === 'function') {
    return cachedCodexCloser;
  }
  const tried = [];
  for (const spec of CODEX_WS_SPECS) {
    try {
      const mod = await import(spec);
      tried.push(spec);
      if (typeof mod.closeOpenAICodexWebSocketSessions === 'function') {
        cachedCodexCloser = {
          close: (sessionId) => {
            mod.closeOpenAICodexWebSocketSessions(sessionId);
            if (typeof mod.resetOpenAICodexWebSocketDebugStats === 'function') {
              mod.resetOpenAICodexWebSocketDebugStats(sessionId);
            }
          },
          via: spec,
        };
        return cachedCodexCloser;
      }
    } catch (err) {
      tried.push(spec + ':' + String(err && err.code || err && err.message || err));
    }
  }
  return { close: null, via: '', tried };
}

async function dropCodexContinuation(sessionId, closer) {
  if (!sessionId) return { dropped: false, reason: 'no-session' };
  const loaded = closer || await loadCodexCloser();
  if (!loaded || typeof loaded.close !== 'function') {
    return { dropped: false, reason: 'not-loaded', tried: loaded && loaded.tried };
  }
  loaded.close(sessionId);
  return { dropped: true, via: loaded.via || 'injected' };
}

function wrapCodexStream(inner, sessionId, closer) {
  return (async function* () {
    let failed = false;
    try {
      for await (const chunk of inner) {
        if (chunk && chunk.type === 'finish') {
          const kind = chunk.reason && chunk.reason.kind;
          if (kind === 'error' || kind === 'aborted') failed = true;
        }
        yield chunk;
      }
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      if (failed) {
        try { await dropCodexContinuation(sessionId, closer); }
        catch { /* drop is best-effort; retry still proceeds */ }
      }
    }
  })();
}

function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk)));
    });
    req.on('end', () => {
      const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
      resolve(new TextDecoder().decode(merged));
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
  res.end(JSON.stringify(body));
}

function publicActive(entry) {
  if (!entry) return null;
  return {
    sessionId: entry.sessionId,
    turn: entry.turn,
    step: entry.step,
    provider: entry.provider,
    code: entry.code,
    message: entry.message,
    attempt: entry.attempt,
    delayMs: entry.delayMs,
    startedAt: entry.startedAt,
    nextAt: entry.nextAt,
    waiting: entry.waiting,
    ...entry.codexDrop ? { codexDrop: entry.codexDrop } : {},
  };
}

async function apply(ctx) {
  let current = resolveConfig({});
  const lifetime = new AbortController();
  let pauseCtl = new AbortController();
  const activeOps = new Set();
  const attempts = new Map();
  const live = new Map();
  const random = Math.random;
  const listeners = [];
  const internals = arguments[1] && typeof arguments[1] === 'object' ? arguments[1] : {};
  const injectedCloser = internals.codexCloser;

  function track(operation) {
    const tracked = operation.finally(() => activeOps.delete(tracked));
    activeOps.add(tracked);
    return tracked;
  }

  function setLive(sessionId, entry) {
    if (!sessionId) return;
    if (entry) live.set(sessionId, entry);
    else live.delete(sessionId);
  }

  function clearSession(sessionId) {
    if (!sessionId) return;
    live.delete(sessionId);
    for (const key of [...attempts.keys()]) {
      if (key.startsWith(sessionId + ':')) attempts.delete(key);
    }
  }

  function attemptKey(sessionId, turn, step) {
    return sessionId + ':' + String(turn) + ':' + String(step);
  }

  async function persist(patch) {
    const settings = ctx.get('settings');
    if (settings && typeof settings.update === 'function') {
      await settings.update(NS, patch);
      return;
    }
    current = resolveConfig({ ...current, ...patch });
  }

  async function recover(payload, next) {
    const failure = payload && payload.failure;
    const code = failure && failure.code ? String(failure.code) : '';
    const signal = payload && payload.signal;
    const agent = payload && payload.agent;
    const sid = sessionKey(agent);
    const turn = payload && payload.turn;
    const step = payload && payload.step;
    const provider = payload && payload.provider ? String(payload.provider) : '';

    if (lifetime.signal.aborted) return next();
    if (!current.enabled || current.paused) return next();
    if (signal && signal.aborted) return next();
    if (!isRetryableFailure(current, failure)) return next();

    const key = attemptKey(sid, turn, step);
    const previous = attempts.get(key) || 0;
    if (current.maxRetries > 0 && previous >= current.maxRetries) return next();
    const retry = previous + 1;
    attempts.set(key, retry);

    const delayMs = computeDelay(current, retry, failure, random);
    const startedAt = Date.now();
    setLive(sid, {
      sessionId: sid,
      turn,
      step,
      provider,
      code,
      message: failure && failure.message ? String(failure.message) : code,
      attempt: retry,
      delayMs,
      startedAt,
      nextAt: startedAt + delayMs,
      waiting: true,
    });

    const fusedSources = [lifetime.signal, pauseCtl.signal];
    if (signal) fusedSources.push(signal);
    const fused = (typeof AbortSignal.any === 'function')
      ? AbortSignal.any(fusedSources)
      : (signal || lifetime.signal);
    const waited = await cancellableDelay(delayMs, fused);
    const stillLive = live.get(sid);
    if (stillLive && stillLive.startedAt === startedAt) {
      stillLive.waiting = false;
    }
    if (!waited || lifetime.signal.aborted || (signal && signal.aborted)) {
      if (stillLive && stillLive.startedAt === startedAt) live.delete(sid);
      return undefined;
    }
    if (isCodexProvider(provider)) {
      const drop = await dropCodexContinuation(sid, injectedCloser);
      if (stillLive && stillLive.startedAt === startedAt) {
        stillLive.codexDrop = drop;
      }
    }
    return { kind: 'retry' };
  }

  listeners.push(ctx.on('llm/stream', (options, next) => {
    if (!isCodexProvider(options && options.provider)) return next();
    const sid = options && options.sessionId != null ? String(options.sessionId) : '';
    if (!sid) return next();
    try {
      return wrapCodexStream(next(), sid, injectedCloser);
    } catch (err) {
      return (async function* () {
        try { await dropCodexContinuation(sid, injectedCloser); }
        catch { /* ignore */ }
        throw err;
      })();
    }
  }));

  listeners.push(ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined);
    return track(recover(payload, next));
  }));

  listeners.push(ctx.on('agent/status', (payload) => {
    const sid = sessionKey(payload && payload.agent);
    if (!sid) return;
    if (payload && payload.status === 'idle') clearSession(sid);
  }));

  listeners.push(ctx.on('agent/error', (payload) => {
    const sid = sessionKey(payload && payload.agent);
    if (sid) setLive(sid, null);
  }));

  listeners.push(ctx.on('agent/disposed', (payload) => {
    const sid = sessionKey(payload && payload.agent);
    if (sid) clearSession(sid);
  }));

  const settingsSvc = ctx.get('settings');
  if (settingsSvc && typeof settingsSvc.register === 'function') {
    try {
      const scope = settingsSvc.register(NS, ConfigSchema, {
        base: resolveConfig({}),
        applies: 'live',
      });
      current = resolveConfig(scope.get());
      ctx.effect(() => scope.watch((next) => {
        current = resolveConfig(next);
      }), 'session-robustness: watch settings');
    } catch (err) {
      console.error('[dsh-session-robustness] settings register skipped: ' + (err && err.message || err));
    }
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      try {
        const scope = settingsCtx.settings.register(NS, ConfigSchema, {
          base: resolveConfig({}),
          applies: 'live',
        });
        current = resolveConfig(scope.get());
        ctx.effect(() => scope.watch((next) => {
          current = resolveConfig(next);
        }), 'session-robustness: watch settings (late)');
      } catch (err) {
        console.error('[dsh-session-robustness] settings register skipped: ' + (err && err.message || err));
      }
    });
  }

  const webServer = ctx.get('webServer') || ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('dsh-session-robustness: webServer is required to expose /session-robustness/api');
  }
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const m = /^\/session-robustness\/api\/([a-z]+)$/.exec(pathname);
      const method = m ? m[1] : null;
      const httpMethod = String(req.method || 'GET').toUpperCase();
      if (!method) {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      if (httpMethod === 'GET' && method === 'status') {
        sendJson(res, 200, {
          ok: true,
          version: VERSION,
          config: current,
          neverRetry: [...NEVER_RETRY],
          active: [...live.values()].map(publicActive),
        });
        return;
      }
      if (httpMethod !== 'POST') {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      let args = {};
      try {
        const text = await readBody(req);
        if (text) args = JSON.parse(text);
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }
      try {
        if (method === 'status') {
          sendJson(res, 200, {
            ok: true,
            version: VERSION,
            config: current,
            neverRetry: [...NEVER_RETRY],
            active: [...live.values()].map(publicActive),
          });
          return;
        }
        if (method === 'update') {
          const patch = args && typeof args === 'object' ? args : {};
          const next = resolveConfig({ ...current, ...patch });
          await persist(next);
          current = next;
          sendJson(res, 200, { ok: true, config: current });
          return;
        }
        if (method === 'pause') {
          await persist({ paused: true });
          current = { ...current, paused: true };
          if (!pauseCtl.signal.aborted) pauseCtl.abort();
          sendJson(res, 200, { ok: true, config: current, note: 'paused; in-flight backoff aborted, later failures are no longer retried until resume.' });
          return;
        }
        if (method === 'resume') {
          await persist({ paused: false, enabled: true });
          current = { ...current, paused: false, enabled: true };
          if (pauseCtl.signal.aborted) pauseCtl = new AbortController();
          sendJson(res, 200, { ok: true, config: current });
          return;
        }
        sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message || err) });
      }
    },
  }), 'dsh-session-robustness: /session-robustness/api');

  ctx.effect(() => async () => {
    for (const dispose of listeners) {
      try { dispose(); } catch { /* ignore */ }
    }
    if (!lifetime.signal.aborted) lifetime.abort();
    await Promise.allSettled([...activeOps]);
    live.clear();
    attempts.clear();
  }, 'dsh-session-robustness: abort and drain');

  console.log('[dsh-session-robustness] ready v' + VERSION + ' enabled=' + current.enabled + ' paused=' + current.paused);
}

export {
  apply,
  inject,
  name,
  VERSION,
  NS,
  DEFAULT_RETRYABLE,
  NEVER_RETRY,
  resolveConfig,
  isRetryable,
  isRetryableFailure,
  isTransientMessage,
  isNetworkCode,
  CATCHALL_CODES,
  NETWORK_CODES,
  computeDelay,
  dropCodexContinuation,
  loadCodexCloser,
  isCodexProvider,
  wrapCodexStream,
  ConfigSchema,
};
