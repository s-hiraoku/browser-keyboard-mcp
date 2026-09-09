import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { KeyboardController, keySchema, sequenceSchema } from '../src/keyboard.js';

const down = (key, atMs = 0) => ({ type: 'down', key, atMs });
const up = (key, atMs = 20) => ({ type: 'up', key, atMs });
function fixture(overrides = {}) {
  const log = [];
  const controller = new KeyboardController({
    async down(key) { log.push(['down', key]); },
    async up(key) { log.push(['up', key]); },
    ...overrides,
  });
  return { controller, log };
}
async function finished(controller) {
  const deadline = Date.now() + 2000;
  while (controller.state.run?.status === 'running') {
    if (Date.now() > deadline) throw new Error('Sequence did not finish.');
    await sleep(5);
  }
  return controller.state;
}

test('independent holds overlap and can be released separately', async () => {
  const { controller, log } = fixture();
  await controller.keyDown('KeyA');
  await controller.keyDown('KeyD');
  assert.deepEqual(controller.state.heldKeys, ['KeyA', 'KeyD']);
  await controller.keyUp('KeyA');
  assert.deepEqual(controller.state.heldKeys, ['KeyD']);
  await controller.close();
  assert.deepEqual(log, [['down', 'KeyA'], ['down', 'KeyD'], ['up', 'KeyA'], ['up', 'KeyD']]);
});

test('manual hold expires automatically', async () => {
  const { controller } = fixture();
  await controller.keyDown('Space', 20);
  await sleep(80);
  assert.deepEqual(controller.state.heldKeys, []);
  await controller.close();
});

test('duplicate downs fail without releasing an existing hold', async () => {
  const { controller } = fixture();
  await controller.keyDown('KeyA');
  await assert.rejects(controller.keyDown('KeyA'), /already held/);
  assert.deepEqual(controller.state.heldKeys, ['KeyA']);
  await controller.close();
});

test('sequence preserves simultaneous event order and overlapping holds', async () => {
  const { controller, log } = fixture();
  await controller.start([down('KeyA'), down('KeyD'), up('KeyD'), up('KeyA', 40)]);
  const state = await finished(controller);
  assert.equal(state.run.status, 'completed');
  assert.equal(state.run.eventsCompleted, 4);
  assert.deepEqual(state.heldKeys, []);
  assert.deepEqual(log, [['down', 'KeyA'], ['down', 'KeyD'], ['up', 'KeyD'], ['up', 'KeyA']]);
});

test('stop interrupts a distant deadline and releases held keys', async () => {
  const { controller, log } = fixture();
  await controller.start([down('KeyA'), up('KeyA', 30000)]);
  await sleep(10);
  const start = Date.now();
  await controller.stop();
  assert.ok(Date.now() - start < 1000);
  assert.equal(controller.state.run.status, 'stopped');
  assert.deepEqual(controller.state.heldKeys, []);
  assert.deepEqual(log, [['down', 'KeyA'], ['up', 'KeyA']]);
});

test('stop waits for an in-flight down before releasing it', async () => {
  const log = [];
  const { controller } = fixture({
    async down(key) { await sleep(30); log.push(['down', key]); },
    async up(key) { log.push(['up', key]); },
  });
  await controller.start([down('KeyA'), up('KeyA', 30000)]);
  await controller.stop();
  assert.deepEqual(log, [['down', 'KeyA'], ['up', 'KeyA']]);
  assert.deepEqual(controller.state.heldKeys, []);
});

test('failed dispatch releases all keys and records failure', async () => {
  const released = [];
  const { controller } = fixture({
    async down(key) { if (key === 'KeyD') throw new Error('Disconnected'); },
    async up(key) { released.push(key); },
  });
  await controller.start([down('KeyA'), down('KeyD'), up('KeyD'), up('KeyA')]);
  const state = await finished(controller);
  assert.equal(state.run.status, 'failed');
  assert.match(state.run.error, /Disconnected/);
  assert.deepEqual(new Set(released), new Set(['KeyA', 'KeyD']));
  assert.deepEqual(state.heldKeys, []);
});

test('release tries all keys and retains failures for retry', async () => {
  let fail = true;
  const released = [];
  const { controller } = fixture({ async up(key) {
    released.push(key);
    if (key === 'KeyA' && fail) throw new Error('Transient failure');
  } });
  await controller.keyDown('KeyA');
  await controller.keyDown('KeyD');
  await assert.rejects(controller.stop(), /Some keys/);
  assert.deepEqual(released, ['KeyA', 'KeyD']);
  assert.deepEqual(controller.state.heldKeys, ['KeyA']);
  fail = false;
  await controller.stop();
  assert.deepEqual(controller.state.heldKeys, []);
});

test('a running sequence rejects another sequence and manual down', async () => {
  const { controller } = fixture();
  await controller.start([down('KeyA'), up('KeyA', 30000)]);
  await assert.rejects(controller.start([down('KeyD'), up('KeyD')]), /running/);
  await assert.rejects(controller.keyDown('KeyD'), /running/);
  await controller.close();
  assert.deepEqual(controller.state.heldKeys, []);
  await assert.rejects(controller.keyDown('KeyA'), /closed/);
});

test('manual holds cannot be taken over by a sequence', async () => {
  const { controller } = fixture();
  await controller.keyDown('KeyA');
  await assert.rejects(controller.start([down('KeyD'), up('KeyD')]), /manually held/);
  await controller.close();
});

test('validation rejects shortcuts, alias keys, excessive and malformed sequences', () => {
  for (const key of ['a', 'Control', 'Meta', 'Control+KeyA', 'Enter']) assert.equal(keySchema.safeParse(key).success, false);
  for (const events of [[], [up('KeyA')], [down('KeyA')], [down('KeyA'), down('KeyA'), up('KeyA')], [down('KeyA', 10), up('KeyA', 5)], [down('KeyA'), up('KeyA', 30001)]]) {
    assert.equal(sequenceSchema.safeParse(events).success, false);
  }
});

test('playlist shares one run and stop discards pending phrases including trailing rests', async () => {
  const { compilePlaylist } = await import('../src/music.js');
  const { controller, log } = fixture();
  const phrase = { durationMs: 30, events: [down('KeyA'), up('KeyA', 10)] };
  await controller.play(compilePlaylist([phrase, phrase]));
  const state = await finished(controller);
  assert.equal(state.run.eventsCompleted, 4);
  assert.ok(state.run.elapsedMs >= 55);
  assert.ok(state.run.maxDispatchStartLateMs >= 0);
  assert.deepEqual(log, [['down', 'KeyA'], ['up', 'KeyA'], ['down', 'KeyA'], ['up', 'KeyA']]);
  await controller.play(compilePlaylist([{ ...phrase, durationMs: 30000 }, phrase]));
  await sleep(20);
  await controller.stop();
  assert.equal(controller.state.run.status, 'stopped');
  assert.equal(controller.state.run.eventsCompleted, 2);
  assert.deepEqual(controller.state.heldKeys, []);
});

test('completion callback still runs when release cleanup fails', async () => {
  let finished = false;
  const controller = new KeyboardController({ async down() {}, async up() { throw new Error('lost transport'); } }, async () => { finished = true; });
  await controller.start([down('KeyA'), up('KeyA')]);
  await sleep(60);
  assert.equal(controller.state.run.status, 'failed');
  assert.equal(finished, true);
});
