import { chromium } from 'playwright';
import { KeyboardController } from './keyboard.js';

export class BrowserSession {
  #queue = Promise.resolve();

  constructor({ headless = false } = {}) { this.headless = headless; }

  exclusive(action) {
    const next = this.#queue.then(action);
    this.#queue = next.catch(() => {});
    return next;
  }

  async open(url) {
    const target = new URL(url);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) {
      throw new Error('Use an http(s) URL without embedded credentials.');
    }
    if (this.browser) throw new Error('A browser is already open. Close it before opening another session.');
    this.browser = await chromium.launch({ headless: this.headless });
    try {
      this.context = await this.browser.newContext({ viewport: { width: 1280, height: 900 } });
      this.page = await this.context.newPage();
      this.keys = new KeyboardController(this.page.keyboard);
      const page = this.page;
      const keys = this.keys;
      page.on('framenavigated', frame => {
        if (frame === page.mainFrame()) void keys.stop().catch(error => { this.lastError = error.message; });
      });
      page.on('close', () => { void keys.close().catch(error => { this.lastError = error.message; }); });
      await this.page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return this.status();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  requirePage() {
    if (!this.page || this.page.isClosed()) throw new Error('Open a browser session first.');
    return this.page;
  }

  status() {
    return {
      open: Boolean(this.page && !this.page.isClosed()),
      url: this.page?.isClosed() === false ? this.page.url() : null,
      ...this.keys?.state,
      lastError: this.lastError ?? this.keys?.lastError ?? null,
    };
  }

  async click(x, y) {
    const page = this.requirePage();
    if (this.keys.state.run?.status === 'running' || this.keys.state.heldKeys.length) {
      throw new Error('Stop the sequence and release keys before moving focus.');
    }
    const size = page.viewportSize();
    if (x < 0 || y < 0 || x >= size.width || y >= size.height) throw new Error('Click is outside the viewport.');
    await page.mouse.click(x, y);
    return this.status();
  }

  async close() {
    try { await this.keys?.close(); }
    finally {
      await this.browser?.close();
      this.browser = this.context = this.page = this.keys = undefined;
    }
    return this.status();
  }
}
