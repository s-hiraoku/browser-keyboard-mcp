import { randomUUID } from 'node:crypto';
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
      this.timingPlan = null;
      this.timingRunId = null;
      this.timingSlot = `__keyboardTiming_${randomUUID().replaceAll('-', '')}`;
      this.keys = new KeyboardController(this.page.keyboard, async () => {
        if (!this.page.isClosed()) await this.page.evaluate(slot => {
          const recorder = window[slot];
          if (recorder) recorder.active = false;
        }, this.timingSlot);
      });
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

  async play(timeline, captureTiming = false) {
    const page = this.requirePage();
    if (this.keys.state.run?.status === 'running' || this.keys.state.heldKeys.length)
      throw new Error('Stop input and release keys before starting playback.');
    await page.evaluate(({ slot, enabled, codes, limit }) => {
      const previous = window[slot];
      if (previous) for (const type of ['keydown', 'keyup']) window.removeEventListener(type, previous.listener, true);
      const recorder = { active: enabled, events: [], listener: null };
      const allowed = new Set(codes);
      recorder.listener = event => {
        if (!recorder.active || !event.isTrusted || !allowed.has(event.code)) return;
        if (recorder.events.length >= limit) { recorder.active = false; return; }
        recorder.events.push({ key: event.code, type: event.type === 'keydown' ? 'down' : 'up', atMs: performance.now() });
      };
      window[slot] = recorder;
      if (enabled) for (const type of ['keydown', 'keyup']) window.addEventListener(type, recorder.listener, true);
    }, { slot: this.timingSlot, enabled: captureTiming, codes: [...new Set(timeline.events.map(e => e.key))], limit: 8192 });
    this.timingPlan = captureTiming ? timeline.events : null;
    try {
      const state = await this.keys.play(timeline);
      this.timingRunId = state.run.id;
      return state;
    }
    catch (error) {
      await page.evaluate(slot => { window[slot].active = false; }, this.timingSlot);
      throw error;
    }
  }

  async timing() {
    const captured = await this.requirePage().evaluate(slot => window[slot]?.events ?? [], this.timingSlot);
    const planned = this.timingPlan ?? [];
    const matched = captured.length === planned.length && captured.every((e, i) => e.key === planned[i].key && e.type === planned[i].type);
    const events = captured.map(e => ({ ...e, atMs: Math.round((e.atMs - captured[0].atMs) * 100) / 100 }));
    const chords = new Map();
    if (matched) for (const [i, e] of planned.entries()) {
      if (e.type !== 'down') continue;
      const group = chords.get(e.atMs) ?? [];
      group.push(events[i].atMs);
      chords.set(e.atMs, group);
    }
    const spreads = [...chords.values()].filter(group => group.length > 1).map(group => Math.max(...group) - Math.min(...group));
    return { runId: this.timingRunId ?? null,
      maxChordSpreadMs: matched && spreads.length ? Math.max(...spreads) : null,
      enabled: this.timingPlan !== null && this.timingPlan !== undefined, matched,
      events, maxRelativeDriftMs: matched && events.length ? Math.max(...events.map((e, i) => Math.abs(e.atMs - (planned[i].atMs - planned[0].atMs)))) : null };
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
