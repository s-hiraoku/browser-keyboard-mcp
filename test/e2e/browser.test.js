import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { BrowserSession } from '../../src/browser.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function site(t) {
  const http = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('Keyboard integration test');
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  return `http://127.0.0.1:${http.address().port}`;
}

test('Chromium receives trusted overlapping down/up events and navigation stops input', async t => {
  const url = await site(t);
  const session = new BrowserSession({ headless: true });
  t.after(() => session.close());
  await session.open(url);
  await session.page.evaluate(() => {
    window.inputEvents = [];
    window.heldCodes = new Set();
    for (const type of ['keydown', 'keyup']) window.addEventListener(type, event => {
      if (type === 'keydown') window.heldCodes.add(event.code);
      else window.heldCodes.delete(event.code);
      window.inputEvents.push({ type, code: event.code, trusted: event.isTrusted, held: [...window.heldCodes], time: performance.now() });
    });
  });
  await session.keys.keyDown('KeyA');
  await session.keys.keyDown('KeyD');
  await session.keys.keyUp('KeyD');
  await session.keys.keyUp('KeyA');
  const events = await session.page.evaluate(() => window.inputEvents);
  assert.equal(events.length, 4);
  assert.ok(events.every(event => event.trusted));
  assert.deepEqual(events[1].held, ['KeyA', 'KeyD']);
  assert.deepEqual(events[2].held, ['KeyA']);
  assert.deepEqual(events[3].held, []);
  await session.keys.start([
    { atMs: 0, type: 'down', key: 'KeyA' },
    { atMs: 100, type: 'down', key: 'KeyD' },
    { atMs: 200, type: 'up', key: 'KeyD' },
    { atMs: 300, type: 'up', key: 'KeyA' },
  ]);
  await session.page.waitForFunction(() => window.inputEvents.length === 8);
  const timed = await session.page.evaluate(() => window.inputEvents.slice(4));
  assert.deepEqual(timed[1].held, ['KeyA', 'KeyD']);
  assert.ok(timed[3].time - timed[0].time >= 200, 'Hold duration should survive dispatch overhead.');
  await session.keys.stop();
  await session.keys.start([{ atMs: 0, type: 'down', key: 'KeyA' }, { atMs: 30000, type: 'up', key: 'KeyA' }]);
  await session.page.goto(`${url}/next`);
  await session.keys.stop();
  assert.notEqual(session.keys.state.run.status, 'running');
  assert.deepEqual(session.keys.state.heldKeys, []);
});

test('MCP stdio lists tools, reports validation errors, plays a chord, and can interrupt', async t => {
  const url = await site(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/server.js', '--headless'],
    env: { ...process.env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'keyboard-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 11);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const read = result => JSON.parse(result.content[0].text);
  assert.equal((await call('key_down', { key: 'KeyA' })).isError, true);
  assert.equal((await call('browser_open', { url: 'file:///tmp/secret' })).isError, true);
  assert.equal(read(await call('browser_open', { url })).open, true);
  assert.equal((await call('key_down', { key: 'Control' })).isError, true);
  assert.equal((await call('sequence_start', { events: [{ atMs: 0, type: 'down', key: 'KeyA' }] })).isError, true);
  assert.equal(read(await call('chord', { keys: ['KeyA', 'KeyD', 'KeyG'], durationMs: 100 })).run.status, 'running');
  let state;
  for (let attempt = 0; attempt < 100; attempt++) {
    state = read(await call('browser_status'));
    if (state.run.status !== 'running') break;
    await sleep(20);
  }
  assert.equal(state.run.status, 'completed');
  assert.equal(state.run.eventsCompleted, 6);
  assert.deepEqual(state.heldKeys, []);
  await call('chord', { keys: ['KeyA'], durationMs: 30000 });
  assert.equal(read(await call('sequence_stop')).run.status, 'stopped');
  const screenshot = await call('browser_screenshot');
  assert.equal(screenshot.content[0].mimeType, 'image/png');
  assert.equal(read(await call('browser_close')).open, false);
});
