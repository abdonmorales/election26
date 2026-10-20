// Requests to Texas SOS sites that sit behind a Cloudflare bot check.
//
// We try a plain request first. If Cloudflare answers with its challenge (403/503), we open the
// site's landing page in headless Chromium (Playwright), wait for the check to clear, and make the
// same request from inside the page with fetch(), exactly as the site's own scripts do.

import { fetchText, HttpError } from "./http.js";

const isChallenge = (err) => err instanceof HttpError && (err.status === 403 || err.status === 503 || /just a moment|cf-chl|challenge/i.test(err.body || ""));

export class CloudflareSession {
  /** origin: "https://results.texas-election.com"; landing: a page on that origin to open in the browser. */
  constructor({ origin, landing, log = console.log }) {
    this.origin = origin;
    this.landing = landing;
    this.log = log;
    this.browser = null;
    this.page = null;
  }

  /** GET or form-POST `path` (relative to origin). Returns the response text. */
  async text(path, { form } = {}) {
    const url = `${this.origin}${path}`;
    const init = form
      ? { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }
      : { method: "GET" };
    if (!this.page) {
      try {
        return await fetchText(url, { retries: 1, ...(form ? { init } : {}) });
      } catch (err) {
        if (!isChallenge(err)) throw err;
        this.log(`${new URL(this.origin).host}: plain request blocked (${err.message}); switching to headless browser`);
        await this.open();
      }
    }
    const res = await this.page.evaluate(async ([u, i]) => {
      const r = await fetch(u, { ...i, cache: "no-store" });
      return { status: r.status, text: await r.text() };
    }, [url, init]);
    if (res.status !== 200) {
      // Clearance can expire during a long election night; start over on the next call.
      if (res.status === 403 || res.status === 503) await this.close();
      throw new HttpError(`HTTP ${res.status} for ${path} (browser)`, res.status);
    }
    return res.text;
  }

  async json(path, opts) {
    const text = await this.text(path, opts);
    try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON for ${path}`); }
  }

  async open() {
    let playwright;
    try {
      playwright = await import("playwright");
    } catch {
      throw new Error(`${new URL(this.origin).host} requires a browser (Cloudflare check) but Playwright is not installed`);
    }
    const launch = { args: ["--disable-blink-features=AutomationControlled"] };
    if (process.env.HTTPS_PROXY) launch.proxy = { server: process.env.HTTPS_PROXY };
    this.browser = await playwright.chromium.launch(launch);
    const ctx = await this.browser.newContext({ ignoreHTTPSErrors: !!process.env.HTTPS_PROXY });
    this.page = await ctx.newPage();
    await this.page.goto(this.landing, { waitUntil: "domcontentloaded", timeout: 60000 });
    await this.page.waitForFunction(() => !/just a moment/i.test(document.title), null, { timeout: 60000 });
    await this.page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  }

  async close() {
    await this.browser?.close().catch(() => {});
    this.browser = this.page = null;
  }
}
