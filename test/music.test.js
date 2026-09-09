import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePlaylist, compileScore } from '../src/music.js';
const phrase = { durationMs: 30000, events: [{ atMs: 0, key: 'KeyA', type: 'down' }, { atMs: 30000, key: 'KeyA', type: 'up' }] };
const score = { bpm: 120, mapping: { C4: 'KeyA', 'D#4': 'KeyS' }, notes: [{ pitch: 'C4', beat: 0, duration: 1 }, { pitch: 'Eb4', beat: 0, duration: 2 }, { pitch: 'C4', beat: 1, duration: 1 }] };
test('playlist uses explicit durations and releases before boundary retrigger', () => {
  const result = compilePlaylist([phrase, phrase]);
  assert.equal(result.durationMs, 60000);
  assert.deepEqual(result.events.map(e => [e.atMs, e.type]), [[0, 'down'], [30000, 'up'], [30000, 'down'], [60000, 'up']]);
  assert.throws(() => compilePlaylist([phrase, { ...phrase, durationMs: 10 }]));
  assert.throws(() => compilePlaylist(Array(21).fill(phrase)));
  const dense = { durationMs: 1000, events: Array.from({ length: 256 }, (_, i) => [{ atMs: i * 2, type: 'down', key: 'KeyA' }, { atMs: i * 2 + 1, type: 'up', key: 'KeyA' }]).flat() };
  assert.throws(() => compilePlaylist(Array(17).fill(dense)), /8192/);
});
test('score handles chords, enharmonics, tempo, octave shift and retriggers', () => {
  const result = compileScore(score);
  assert.equal(result.durationMs, 1000);
  assert.deepEqual(result.events.filter(e => e.atMs === 500).map(e => e.type), ['up', 'down']);
  assert.equal(result.events[1].key, 'KeyS');
  assert.equal(compileScore({ ...score, bpm: 60 }).durationMs, 2000);
  assert.equal(compileScore({ bpm: 120, octaveShift: 1, mapping: { C5: 'KeyB' }, notes: [{ pitch: 'C4', beat: 0, duration: 1 }] }).events[0].key, 'KeyB');
});
test('score rejects missing mappings, key collisions, rounding and unsafe duration', () => {
  assert.throws(() => compileScore({ ...score, mapping: {} }), /No key mapping/);
  assert.throws(() => compileScore({ ...score, mapping: { C4: 'KeyA', 'D#4': 'KeyA' } }), /Overlapping/);
  assert.throws(() => compileScore({ ...score, mapping: { 'D#4': 'KeyA', Eb4: 'KeyB' } }), /Conflicting/);
  for (const note of [{ pitch: 'C4', beat: 0, duration: 0.00001 }, { pitch: 'C4', beat: 0, duration: 61 }, { pitch: 'C4', beat: 1200, duration: 1 }]) assert.throws(() => compileScore({ ...score, notes: [note] }));
});
