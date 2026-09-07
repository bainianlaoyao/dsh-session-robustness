#!/usr/bin/env node
// Static-package smoke: load lib/index.js against a mocked ctx and drive
// the agent/request-error waterfall plus /session-robustness/api routes.
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

const files = new Map();
const routes = [];
const listeners = new Map();
const settingsState = { ns: null, value: null, watchers: [] };

function makeAbort() {
  const c = new AbortController();
  return c;
}

function makeCtx() {
  const ctx = {
    get: (k) => ({
      settings: {
        register(ns, _schema, options) {
          settingsState.ns = ns;
          settingsState.value = options && options.base ? { ...options.base } : {};
          return {
            get: () => settingsState.value,
            watch: (cb) => {
              settingsState.watchers.push(cb);
              return () => {
                const i = settingsState.watchers.indexOf(cb);
                if (i >= 0) settingsState.watchers.splice(i, 1);
              };
            },
            update: async (patch) => {
              settingsState.value = { ...settingsState.value, ...patch };
              for (const w of settingsState.watchers) w(settingsState.value);
            },
          };
        },
        update: async (ns, patch) => {
          if (ns !== settingsState.ns) throw new Error('unknown ns ' + ns);
          settingsState.value = { ...settingsState.value, ...patch };
          for (const w of settingsState.watchers) w(settingsState.value);
        },
      },
      webServer: {
        register: (opts) => { routes.push(opts); return () => {}; },
      },
      fs: {
        async resolve(p) { return p; },
        async stat(p) { return files.has(p) ? { size: 1 } : null; },
        async readText(p) { return files.get(p); },
        async writeText(p, t) { files.set(p, t); },
      },
    }[k]),
    on(event, fn) {
      const list = listeners.get(event) || [];
      list.push(fn);
      listeners.set(event, list);
      return () => {
        const cur = listeners.get(event) || [];
        listeners.set(event, cur.filter((x) => x !== fn));
      };
    },
    effect(fn) {
      const d = fn();
      return typeof d === 'function' ? d : () => {};
    },
  };
  return ctx;
}

function waterfall(event, payload, inner) {
  const cbs = [...(listeners.get(event) || [])];
  const next = () => {
    const cb = cbs.shift();
    if (!cb) return inner();
    return cb(payload, next);
  };
  return next();
}

function fakeRes() {
  const r = { status: 0, body: '' };
  r.writeHead = (s) => { r.status = s; };
  r.end = (b) => { r.body = b; };
  return r;
}

function post(route, path, body) {
  const req = new Readable({ read() {} });
  req.url = path;
  req.method = 'POST';
  req.push(JSON.stringify(body ?? {}));
  req.push(null);
  const res = fakeRes();
  return route.handler(req, res).then(() => ({ status: res.status, body: res.body ? JSON.parse(res.body) : null }));
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const {
  apply, name, VERSION, inject,
  DEFAULT_RETRYABLE, NEVER_RETRY, NETWORK_CODES,
  resolveConfig, isRetryable, isRetryableFailure, isNetworkCode, computeDelay,
  dropCodexContinuation, wrapCodexStream, isCodexProvider,
} = await import('../lib/index.js');

check('exports name/version/inject', name === 'dsh-session-robustness' && VERSION === '0.1.6' && inject.includes('webServer'), `${name}@${VERSION} inject=${JSON.stringify(inject)}`);
check('default retryable includes TIMEOUT and STREAM_CLOSED', DEFAULT_RETRYABLE.includes('TIMEOUT') && DEFAULT_RETRYABLE.includes('TRANSPORT') && DEFAULT_RETRYABLE.includes('RATE_LIMIT') && DEFAULT_RETRYABLE.includes('STREAM_CLOSED') && DEFAULT_RETRYABLE.includes('MALFORMED_RESPONSE') && DEFAULT_RETRYABLE.includes('STREAM_READ_ERROR'), JSON.stringify(DEFAULT_RETRYABLE));
check('never-retry includes AUTH/QUOTA/CONTEXT/ABORTED', NEVER_RETRY.includes('AUTH') && NEVER_RETRY.includes('QUOTA') && NEVER_RETRY.includes('CONTEXT_WINDOW_EXCEEDED') && NEVER_RETRY.includes('NO_ADAPTER') && NEVER_RETRY.includes('ABORTED'), JSON.stringify(NEVER_RETRY));
check('NETWORK_CODES covers stream drop codes', NETWORK_CODES.includes('STREAM_CLOSED') && NETWORK_CODES.includes('MALFORMED_RESPONSE') && NETWORK_CODES.includes('STREAM'), JSON.stringify(NETWORK_CODES));

const cfg = resolveConfig({});
check('resolveConfig defaults: enabled, unbounded', cfg.enabled === true && cfg.paused === false && cfg.maxRetries === 0 && cfg.initialDelayMs === 1000 && cfg.maxDelayMs === 30000, JSON.stringify(cfg));
check('isRetryable TIMEOUT yes', isRetryable(cfg, 'TIMEOUT') === true);
check('isRetryable AUTH no', isRetryable(cfg, 'AUTH') === false);
check('isRetryable QUOTA no even if extra listed', isRetryable(resolveConfig({ extraRetryableCodes: ['QUOTA'] }), 'QUOTA') === false);
check('isRetryable extra INVALID_REQUEST yes', isRetryable(resolveConfig({ extraRetryableCodes: ['INVALID_REQUEST'] }), 'INVALID_REQUEST') === true);
check('Codex overloaded PI_AI_ERROR is retryable', isRetryableFailure(cfg, { code: 'PI_AI_ERROR', message: 'Codex error: Our servers are currently overloaded. Please try again later.' }) === true);
check('PI_AI_ERROR without transient text is not retryable', isRetryableFailure(cfg, { code: 'PI_AI_ERROR', message: 'pi-ai deferred response is not supported' }) === false);
check('AUTH still not retryable even with overloaded text', isRetryableFailure(cfg, { code: 'AUTH', message: 'overloaded, try again later' }) === false);
check('quota text on catch-all is not retryable', isRetryableFailure(cfg, { code: 'UNKNOWN', message: 'insufficient_quota, try again later' }) === false);
check('STREAM_CLOSED without keyword is network retry', isRetryableFailure(cfg, { code: 'STREAM_CLOSED', message: 'SSE stream ended without [DONE]' }) === true && isNetworkCode('STREAM_CLOSED') === true);
check('stream_read_error as adapter-native code is network retry', isRetryableFailure(cfg, { code: 'stream_read_error', message: 'stream_read_error' }) === true && isNetworkCode('stream_read_error') === true);
check('STREAM_READ_ERROR uppercase is network retry', isRetryableFailure(cfg, { code: 'STREAM_READ_ERROR', message: '' }) === true);
check('PI_AI_ERROR Upstream request failed is retryable', isRetryableFailure(cfg, { code: 'PI_AI_ERROR', message: 'Upstream request failed' }) === true);
check('Upstream request failed as code is retryable', isRetryableFailure(cfg, { code: 'Upstream request failed', message: 'Upstream request failed' }) === true);
check('empty code with Upstream request failed message is retryable', isRetryableFailure(cfg, { code: '', message: 'Upstream request failed' }) === true);
{
  const closed = [];
  const drop = await dropCodexContinuation('sess-codex', {
    close: (id) => { closed.push(id); },
    via: 'test',
  });
  check('dropCodexContinuation closes injected websocket cache', drop.dropped === true && closed[0] === 'sess-codex', JSON.stringify({ drop, closed }));
  const missing = await dropCodexContinuation('');
  check('dropCodexContinuation no-session is a no-op', missing.dropped === false && missing.reason === 'no-session', JSON.stringify(missing));
}
check('isCodexProvider matches openai-codex only', isCodexProvider('openai-codex') === true && isCodexProvider('openai-codex/gpt') === true && isCodexProvider('aiwnawugrok') === false && isCodexProvider('openai') === false);
{
  const closed = [];
  const closer = { close: (id) => { closed.push(id); }, via: 'test' };
  async function* okStream() {
    yield { type: 'delta', text: 'hi' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const kept = [];
  for await (const chunk of wrapCodexStream(okStream(), 'sess-ok', closer)) kept.push(chunk);
  check('successful Codex stream keeps continuation', closed.length === 0 && kept[1].reason.kind === 'stop', JSON.stringify({ closed, kinds: kept.map((c) => c.type) }));

  async function* failStream() {
    yield { type: 'start' };
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TIMEOUT' } } };
  }
  for await (const _chunk of wrapCodexStream(failStream(), 'sess-fail', closer)) { /* drain */ }
  check('failed Codex finish drops continuation', closed.length === 1 && closed[0] === 'sess-fail', JSON.stringify(closed));

  async function* boomStream() {
    yield { type: 'start' };
    throw new Error('websocket reset');
  }
  let threw = false;
  try {
    for await (const _chunk of wrapCodexStream(boomStream(), 'sess-boom', closer)) { /* drain */ }
  } catch {
    threw = true;
  }
  check('thrown Codex stream drops continuation and rethrows', threw === true && closed.includes('sess-boom'), JSON.stringify({ threw, closed }));
}
check('MALFORMED_RESPONSE is network retry', isRetryableFailure(cfg, { code: 'MALFORMED_RESPONSE', message: 'malformed SSE payload: {' }) === true);
check('STREAM default text is network retry', isRetryableFailure(cfg, { code: 'STREAM', message: 'model response failed' }) === true);
check('HTTP_408 is network retry', isRetryableFailure(cfg, { code: 'HTTP_408', message: 'request timeout' }) === true);
check('HTTP_499 is network retry', isRetryableFailure(cfg, { code: 'HTTP_499' }) === true);
check('HTTP_502 is network retry', isRetryableFailure(cfg, { code: 'HTTP_502', message: 'bad gateway' }) === true);
check('HTTP_400 is not network retry', isRetryableFailure(cfg, { code: 'HTTP_400', message: 'bad request' }) === false);
check('ABORTED is never retry', isRetryableFailure(cfg, { code: 'ABORTED', message: 'user cancelled' }) === false);
check('CONTENT_FILTER is not retry', isRetryableFailure(cfg, { code: 'CONTENT_FILTER', message: 'model stopped: content_filter' }) === false);
check('network still retries after user trimmed retryableCodes', isRetryableFailure(resolveConfig({ retryableCodes: ['TIMEOUT'] }), { code: 'STREAM_CLOSED', message: 'ended without done' }) === true);

const d1 = computeDelay({ initialDelayMs: 1000, maxDelayMs: 30000, jitterRatio: 0 }, 1, {}, () => 0.5);
const d2 = computeDelay({ initialDelayMs: 1000, maxDelayMs: 30000, jitterRatio: 0 }, 2, {}, () => 0.5);
const d3 = computeDelay({ initialDelayMs: 1000, maxDelayMs: 4000, jitterRatio: 0 }, 8, {}, () => 0.5);
check('backoff exponential then cap', d1 === 1000 && d2 === 2000 && d3 === 4000, `${d1},${d2},${d3}`);
const after = computeDelay({ initialDelayMs: 1000, maxDelayMs: 30000, jitterRatio: 0 }, 1, { providerRetryAfterMs: 2500 }, () => 0.5);
check('honors Retry-After inside cap', after === 2500, String(after));

const closedSessions = [];
await apply(makeCtx(), {
  codexCloser: {
    close: (id) => { closedSessions.push(id); },
    via: 'test',
  },
});
check('settings ns registered', settingsState.ns === 'session-robustness', String(settingsState.ns));
check('api route mounted', routes.length === 1 && routes[0].path === '/session-robustness/api', JSON.stringify(routes.map((r) => r.path)));
check('listens agent/request-error', (listeners.get('agent/request-error') || []).length === 1);
check('listens llm/stream', (listeners.get('llm/stream') || []).length === 1);

const route = routes[0];
const st = await post(route, '/session-robustness/api/status', {});
check('status → enabled unbounded', st.status === 200 && st.body.ok && st.body.config.enabled === true && st.body.config.maxRetries === 0, JSON.stringify(st.body.config));

await post(route, '/session-robustness/api/update', { initialDelayMs: 40, maxDelayMs: 40, jitterRatio: 0 });

const abort = makeAbort();
const agent = { id: 'sess-1', session: { id: 'sess-1' } };

const timeoutPayload = {
  agent, turn: 1, step: 1, provider: 'aiwnawugrok',
  failure: { code: 'TIMEOUT', message: 'request timed out' },
  signal: abort.signal,
};

const t0 = Date.now();
const timeoutDecision = await waterfall('agent/request-error', timeoutPayload, () => Promise.resolve(undefined));
const elapsed = Date.now() - t0;
check('TIMEOUT after official budget → retry', timeoutDecision && timeoutDecision.kind === 'retry', JSON.stringify(timeoutDecision));
check('non-codex TIMEOUT retry does not drop Codex cache', closedSessions.length === 0, JSON.stringify(closedSessions));
check('TIMEOUT waited the configured delay', elapsed >= 20 && elapsed < 800, 'elapsed=' + elapsed);

const live = await post(route, '/session-robustness/api/status', {});
check('status shows active retry row', live.body.active && live.body.active.length === 1 && live.body.active[0].code === 'TIMEOUT' && live.body.active[0].attempt === 1, JSON.stringify(live.body.active));

const authDecision = await waterfall('agent/request-error', {
  agent, turn: 1, step: 2, provider: 'aiwnawugrok',
  failure: { code: 'AUTH', message: '401' },
  signal: abort.signal,
}, () => Promise.resolve({ delegated: true }));
check('AUTH delegates (never retry)', authDecision && authDecision.delegated === true, JSON.stringify(authDecision));

const quotaDecision = await waterfall('agent/request-error', {
  agent, turn: 1, step: 3, provider: 'aiwnawugrok',
  failure: { code: 'QUOTA', message: 'out of credits' },
  signal: abort.signal,
}, () => Promise.resolve({ delegated: true }));
check('QUOTA delegates', quotaDecision && quotaDecision.delegated === true, JSON.stringify(quotaDecision));

const overflowDecision = await waterfall('agent/request-error', {
  agent, turn: 1, step: 4, provider: 'aiwnawugrok',
  failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' },
  signal: abort.signal,
}, () => Promise.resolve({ delegated: true }));
check('CONTEXT_WINDOW_EXCEEDED delegates to compaction', overflowDecision && overflowDecision.delegated === true, JSON.stringify(overflowDecision));

const overloadedDecision = await waterfall('agent/request-error', {
  agent, turn: 1, step: 5, provider: 'openai-codex',
  failure: { code: 'PI_AI_ERROR', message: 'Codex error: Our servers are currently overloaded. Please try again later.' },
  signal: abort.signal,
}, () => Promise.resolve({ delegated: true }));
check('Codex overloaded PI_AI_ERROR → retry', overloadedDecision && overloadedDecision.kind === 'retry', JSON.stringify(overloadedDecision));
check('Codex overloaded retry drops websocket continuation', closedSessions.includes('sess-1'), JSON.stringify(closedSessions));

const catchallPermanent = await waterfall('agent/request-error', {
  agent, turn: 1, step: 6, provider: 'openai-codex',
  failure: { code: 'PI_AI_ERROR', message: 'pi-ai deferred response is not supported' },
  signal: abort.signal,
}, () => Promise.resolve({ delegated: true }));
check('non-transient PI_AI_ERROR delegates', catchallPermanent && catchallPermanent.delegated === true, JSON.stringify(catchallPermanent));

const closedDecision = await waterfall('agent/request-error', {
  agent, turn: 1, step: 7, provider: 'openai-codex',
  failure: { code: 'STREAM_CLOSED', message: 'SSE stream ended without [DONE]' },
  signal: abort.signal,
}, () => Promise.resolve({ delegated: true }));
check('STREAM_CLOSED → retry', closedDecision && closedDecision.kind === 'retry', JSON.stringify(closedDecision));

const malformedDecision = await waterfall('agent/request-error', {
  agent, turn: 1, step: 8, provider: 'cc-switch',
  failure: { code: 'MALFORMED_RESPONSE', message: 'malformed SSE payload: {' },
  signal: abort.signal,
}, () => Promise.resolve({ delegated: true }));
check('MALFORMED_RESPONSE → retry', malformedDecision && malformedDecision.kind === 'retry', JSON.stringify(malformedDecision));

const http408Decision = await waterfall('agent/request-error', {
  agent, turn: 1, step: 9, provider: 'aiwnawugrok',
  failure: { code: 'HTTP_408', message: 'timeout' },
  signal: abort.signal,
}, () => Promise.resolve({ delegated: true }));
check('HTTP_408 → retry', http408Decision && http408Decision.kind === 'retry', JSON.stringify(http408Decision));

const http400Decision = await waterfall('agent/request-error', {
  agent, turn: 1, step: 10, provider: 'aiwnawugrok',
  failure: { code: 'HTTP_400', message: 'bad request' },
  signal: abort.signal,
}, () => Promise.resolve({ delegated: true }));
check('HTTP_400 delegates', http400Decision && http400Decision.delegated === true, JSON.stringify(http400Decision));

const streamReadDecision = await waterfall('agent/request-error', {
  agent, turn: 1, step: 11, provider: 'aiwnawugrok',
  failure: { code: 'stream_read_error', message: 'stream_read_error' },
  signal: abort.signal,
}, () => Promise.resolve({ delegated: true }));
check('stream_read_error → retry', streamReadDecision && streamReadDecision.kind === 'retry', JSON.stringify(streamReadDecision));

const upstreamDecision = await waterfall('agent/request-error', {
  agent, turn: 1, step: 12, provider: 'aiwnawugrok',
  failure: { code: 'PI_AI_ERROR', message: 'Upstream request failed' },
  signal: abort.signal,
}, () => Promise.resolve({ delegated: true }));
check('Upstream request failed → retry', upstreamDecision && upstreamDecision.kind === 'retry', JSON.stringify(upstreamDecision));

{
  const before = closedSessions.length;
  async function* okCodex() {
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  for await (const _chunk of waterfall('llm/stream', { provider: 'openai-codex', sessionId: 'sess-ok-stream' }, () => okCodex())) { /* drain */ }
  check('successful openai-codex llm/stream keeps continuation', closedSessions.length === before, JSON.stringify(closedSessions.slice(before)));

  async function* failCodex() {
    yield { type: 'start' };
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'STREAM_CLOSED' } } };
  }
  for await (const _chunk of waterfall('llm/stream', { provider: 'openai-codex', sessionId: 'sess-stream-fail' }, () => failCodex())) { /* drain */ }
  check('failed openai-codex llm/stream drops continuation', closedSessions.includes('sess-stream-fail'), JSON.stringify(closedSessions));

  async function* otherProvider() {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TIMEOUT' } } };
  }
  const beforeOther = closedSessions.length;
  for await (const _chunk of waterfall('llm/stream', { provider: 'aiwnawugrok', sessionId: 'sess-other' }, () => otherProvider())) { /* drain */ }
  check('non-codex llm/stream does not drop continuation', closedSessions.length === beforeOther, JSON.stringify(closedSessions.slice(beforeOther)));
}

const pause = await post(route, '/session-robustness/api/pause', {});
check('pause persists', pause.status === 200 && pause.body.config.paused === true, JSON.stringify(pause.body.config));

const pausedDecision = await waterfall('agent/request-error', {
  agent, turn: 2, step: 1, provider: 'aiwnawugrok',
  failure: { code: 'TIMEOUT', message: 'request timed out' },
  signal: abort.signal,
}, () => Promise.resolve({ delegated: true }));
check('paused TIMEOUT delegates', pausedDecision && pausedDecision.delegated === true, JSON.stringify(pausedDecision));

const resume = await post(route, '/session-robustness/api/resume', {});
check('resume clears pause', resume.status === 200 && resume.body.config.paused === false && resume.body.config.enabled === true, JSON.stringify(resume.body.config));

await post(route, '/session-robustness/api/update', { maxRetries: 1, initialDelayMs: 50, maxDelayMs: 50, jitterRatio: 0 });
const boundedAbort = makeAbort();
const p = {
  agent: { id: 'sess-2', session: { id: 'sess-2' } },
  turn: 9, step: 1, provider: 'x',
  failure: { code: 'TRANSPORT', message: 'reset' },
  signal: boundedAbort.signal,
};
const first = await waterfall('agent/request-error', p, () => Promise.resolve({ delegated: true }));
const second = await waterfall('agent/request-error', p, () => Promise.resolve({ delegated: true }));
check('maxRetries=1: first TRANSPORT retries', first && first.kind === 'retry', JSON.stringify(first));
check('maxRetries=1: second TRANSPORT delegates', second && second.delegated === true, JSON.stringify(second));

const cancelAbort = makeAbort();
const waiting = waterfall('agent/request-error', {
  agent: { id: 'sess-3', session: { id: 'sess-3' } },
  turn: 3, step: 1, provider: 'x',
  failure: { code: 'SERVER', message: '502' },
  signal: cancelAbort.signal,
}, () => Promise.resolve({ delegated: true }));
await delay(10);
cancelAbort.abort();
const cancelled = await waiting;
check('abort during backoff does not retry', cancelled === undefined, JSON.stringify(cancelled));

// Simulate official llm-retry sitting OUTER (registered first, Cordis
// shift-first): it retries twice then delegates. Our plugin is INNER
// (registered later) and must retry after that budget is gone.
listeners.set('agent/request-error', []);
settingsState.ns = null;
settingsState.value = null;
settingsState.watchers = [];
routes.length = 0;

function officialRetry() {
  let n = 0;
  return (payload, next) => {
    const code = payload.failure && payload.failure.code;
    if (!['TIMEOUT', 'TRANSPORT', 'RATE_LIMIT', 'SERVER', 'EMPTY_RESPONSE'].includes(code)) return next();
    n += 1;
    if (n <= 2) return Promise.resolve({ kind: 'retry', from: 'official', n });
    return next();
  };
}

const ctx2 = makeCtx();
ctx2.on('agent/request-error', officialRetry());
await apply(ctx2);
await post(routes[0], '/session-robustness/api/update', { initialDelayMs: 40, maxDelayMs: 40, jitterRatio: 0, maxRetries: 0 });

const pOff = {
  agent: { id: 'sess-4', session: { id: 'sess-4' } },
  turn: 1, step: 1, provider: 'x',
  failure: { code: 'TIMEOUT', message: 'timed out' },
  signal: makeAbort().signal,
};
const r1 = await waterfall('agent/request-error', pOff, () => Promise.resolve(undefined));
const r2 = await waterfall('agent/request-error', pOff, () => Promise.resolve(undefined));
const r3 = await waterfall('agent/request-error', pOff, () => Promise.resolve(undefined));
check('official attempt 1 still owned by official', r1 && r1.from === 'official' && r1.n === 1, JSON.stringify(r1));
check('official attempt 2 still owned by official', r2 && r2.from === 'official' && r2.n === 2, JSON.stringify(r2));
check('after official budget, plugin retries', r3 && r3.kind === 'retry' && r3.from !== 'official', JSON.stringify(r3));

console.log(failures === 0 ? '\nsmoke: ALL GREEN' : `\nsmoke: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
