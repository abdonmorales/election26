// Small fetch wrapper: identifies the bot, times out, and retries transient failures.

export const USER_AGENT = "election26-data-bot/1.0 (+https://github.com/abdonmorales/election26)";

export class HttpError extends Error {
  constructor(message, status, body = "") {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchText(url, { retries = 3, timeoutMs = 20000, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json, text/html;q=0.9, */*;q=0.5", ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.text();
      if (res.ok) return body;
      lastErr = new HttpError(`HTTP ${res.status} from ${new URL(url).host}`, res.status, body.slice(0, 500));
      // 4xx other than 408/429 will not get better by retrying.
      if (res.status < 500 && res.status !== 408 && res.status !== 429) break;
      const retryAfter = Number(res.headers.get("retry-after"));
      if (attempt < retries) await sleep(retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 2000 * 2 ** attempt);
    } catch (err) {
      lastErr = err instanceof HttpError ? err : new HttpError(`${err.name === "TimeoutError" ? "Timed out" : err.message} fetching ${new URL(url).host}`, 0);
      if (attempt < retries) await sleep(2000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

export async function fetchJSON(url, opts) {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`Invalid JSON from ${new URL(url).host}`, 200, text.slice(0, 200));
  }
}
