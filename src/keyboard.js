import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

// Physical codes avoid aliases such as "a" and "KeyA" tracking the same key twice.
export const keySchema = z.string().regex(/^(Key[A-Z]|Digit[0-9]|Space|Arrow(Up|Down|Left|Right)|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote)$/);
export const eventSchema = z.object({
  atMs: z.number().int().min(0).max(30000),
  type: z.enum(['down', 'up']),
  key: keySchema,
}).strict();
export const sequenceSchema = z.array(eventSchema).min(1).max(512).superRefine((events, ctx) => {
  const held = new Set();
  let previous = -1;
  for (const [i, event] of events.entries()) {
    if (event.atMs < previous) ctx.addIssue({ code: 'custom', path: [i, 'atMs'], message: 'Events must be ordered by atMs.' });
    previous = event.atMs;
    if (event.type === 'down') {
      if (held.has(event.key)) ctx.addIssue({ code: 'custom', path: [i], message: 'Duplicate down: release the key before retriggering.' });
      held.add(event.key);
    } else {
      if (!held.has(event.key)) ctx.addIssue({ code: 'custom', path: [i], message: 'Key up without a preceding down.' });
      held.delete(event.key);
    }
  }
  if (held.size) ctx.addIssue({ code: 'custom', message: 'Every down must have a matching up.' });
});

export class KeyboardController {
  #queue = Promise.resolve();
  #held = new Map();
  #run;
  #disposed = false;

  constructor(keyboard, onFinish = async () => {}) { this.keyboard = keyboard; this.onFinish = onFinish; }

  #serialize(action) {
    const next = this.#queue.then(action);
    this.#queue = next.catch(() => {});
    return next;
  }

  #assertIdle() {
    if (this.#disposed) throw new Error('Keyboard session is closed.');
    if (this.#run?.status === 'running') throw new Error('A sequence is running. Stop it before changing keyboard state.');
  }

  get state() {
    const { done, abort, ...run } = this.#run ?? {};
    return { heldKeys: [...this.#held.keys()], run: this.#run ? run : null, closed: this.#disposed };
  }

  async #down(key, holdMs) {
    if (this.#held.has(key)) throw new Error(`${key} is already held.`);
    // Track before dispatch so a transport failure still triggers a best-effort up.
    const entry = {};
    this.#held.set(key, entry);
    try {
      await this.keyboard.down(key);
      if (holdMs) {
        entry.timer = setTimeout(() => {
          void this.#serialize(async () => {
            if (this.#held.get(key) === entry) await this.#up(key);
          }).catch(error => { this.lastError = error.message; });
        }, holdMs);
        entry.timer.unref?.();
      }
    } catch (error) {
      try { await this.#up(key); } catch { /* Keep the tracked key for release_all. */ }
      throw error;
    }
  }

  async #up(key) {
    const entry = this.#held.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    await this.keyboard.up(key);
    this.#held.delete(key);
  }

  async #release() {
    const failures = [];
    for (const key of [...this.#held.keys()]) {
      try { await this.#up(key); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Some keys could not be released; retry release_all or close the browser.');
  }

  keyDown(key, holdMs = 5000) {
    keySchema.parse(key);
    z.number().int().min(1).max(30000).parse(holdMs);
    return this.#serialize(async () => {
      this.#assertIdle();
      await this.#down(key, holdMs);
      return this.state;
    });
  }

  keyUp(key) {
    keySchema.parse(key);
    return this.#serialize(async () => {
      this.#assertIdle();
      await this.#up(key);
      return this.state;
    });
  }

  start(events) {
    const parsed = sequenceSchema.parse(events);
    return this.play({ events: parsed, durationMs: parsed.at(-1).atMs });
  }

  // Internal entry point: callers must compile and validate the entire timeline first.
  play({ events: parsed, durationMs }) {
    return this.#serialize(() => {
      this.#assertIdle();
      if (this.#held.size) throw new Error('Release manually held keys before starting a sequence.');
      const run = {
        id: randomUUID(), status: 'running', eventsTotal: parsed.length,
        eventsCompleted: 0, maxLateMs: 0, maxDispatchStartLateMs: 0, elapsedMs: 0, durationMs, abort: new AbortController(),
      };
      this.#run = run;
      run.done = this.#execute(parsed, run);
      return this.state;
    });
  }

  async #execute(events, run) {
    const start = performance.now();
    try {
      for (const event of events) {
        const delay = event.atMs - (performance.now() - start);
        if (delay > 0) await sleep(delay, undefined, { signal: run.abort.signal });
        run.abort.signal.throwIfAborted();
        run.maxDispatchStartLateMs = Math.max(run.maxDispatchStartLateMs, performance.now() - start - event.atMs);
        if (event.type === 'down') await this.#down(event.key);
        else await this.#up(event.key);
        run.maxLateMs = Math.max(run.maxLateMs, performance.now() - start - event.atMs);
        run.eventsCompleted++;
      }
      const remaining = run.durationMs - (performance.now() - start);
      if (remaining > 0) await sleep(remaining, undefined, { signal: run.abort.signal });
      run.abort.signal.throwIfAborted();
      run.status = 'completed';
    } catch (error) {
      run.status = run.abort.signal.aborted ? 'stopped' : 'failed';
      if (run.status === 'failed') run.error = error.message;
    } finally {
      // Keep the run exclusive until cleanup has finished.
      const result = run.status;
      run.status = 'running';
      try {
        try { await this.#release(); }
        finally { await this.onFinish(); }
        run.status = result;
      } catch (error) {
        run.status = 'failed';
        run.error = error.message;
      }
      run.elapsedMs = Math.round(performance.now() - start);
      run.maxDispatchStartLateMs = Math.round(run.maxDispatchStartLateMs * 100) / 100;
      run.maxLateMs = Math.round(run.maxLateMs * 100) / 100;
    }
  }

  async stop() {
    return this.#serialize(async () => {
      const run = this.#run;
      if (run?.status === 'running') {
        run.abort.abort();
        await run.done;
      }
      await this.#release();
      return this.state;
    });
  }

  async close() {
    return this.#serialize(async () => {
      this.#disposed = true;
      if (this.#run?.status === 'running') {
        this.#run.abort.abort();
        await this.#run.done;
      }
      await this.#release();
    });
  }
}
