// Minimal Phabricator Conduit client built on fetch, so it runs in Workers and Node alike.

export class BudgetExceededError extends Error {}

const MAX_RETRIES = 4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// minIntervalMs spaces out request starts so a cold-cache sync doesn't burst into
// Phabricator's rate limiter.
export function createConduit({ baseUrl, token, budget = Infinity, minIntervalMs = 200, fetchImpl = fetch }) {
  const apiBase = baseUrl.replace(/\/+$/, '') + '/api/';
  let used = 0;
  let nextStart = 0;

  async function throttle() {
    const now = Date.now();
    const wait = nextStart - now;
    nextStart = Math.max(now, nextStart) + minIntervalMs;
    if (wait > 0) await sleep(wait);
  }

  async function call(method, params = {}) {
    const body = new URLSearchParams({
      params: JSON.stringify({ ...params, __conduit__: { token } }),
      output: 'json',
      __conduit__: '1',
    });
    let res;
    for (let attempt = 0; ; attempt++) {
      // Every attempt is a subrequest as far as the Workers runtime is concerned.
      if (used >= budget) throw new BudgetExceededError(`Subrequest budget of ${budget} exhausted`);
      used++;
      await throttle();
      res = await fetchImpl(apiBase + method, { method: 'POST', body });
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) break;
      const retryAfter = Number(res.headers.get('Retry-After'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
    }
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const json = await res.json();
    if (json.error_code) throw new Error(`${method}: ${json.error_code}: ${json.error_info}`);
    return json.result;
  }

  return {
    call,
    get used() { return used; },
    get remaining() { return budget - used; },
  };
}

// Follows `after` cursors for *.search methods and returns all rows.
export async function searchAll(conduit, method, params, { maxPages = 20 } = {}) {
  const rows = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const result = await conduit.call(method, { limit: 100, ...params, ...(after ? { after } : {}) });
    rows.push(...result.data);
    after = result.cursor?.after;
    if (!after) break;
  }
  return rows;
}
