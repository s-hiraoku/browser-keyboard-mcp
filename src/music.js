import { z } from 'zod';
import { keySchema, sequenceSchema } from './keyboard.js';

export const playlistSchema = z.array(z.object({
  durationMs: z.number().int().min(1).max(30000),
  events: sequenceSchema,
}).strict()).min(1).max(20).superRefine((phrases, ctx) => {
  if (phrases.reduce((n, p) => n + p.events.length, 0) > 8192)
    ctx.addIssue({ code: 'custom', message: 'Playlist exceeds 8192 events.' });
  for (const [i, p] of phrases.entries()) if (p.events.at(-1).atMs > p.durationMs)
    ctx.addIssue({ code: 'custom', path: [i], message: 'Events exceed phrase duration.' });
});

export function compilePlaylist(input) {
  const phrases = playlistSchema.parse(input);
  let durationMs = 0;
  const events = [];
  for (const phrase of phrases) {
    events.push(...phrase.events.map(e => ({ ...e, atMs: e.atMs + durationMs })));
    durationMs += phrase.durationMs;
  }
  return { events, durationMs };
}

const pitchSchema = z.string().regex(/^[A-G](?:#|b)?[0-8]$/);
export const scoreSchema = z.object({
  bpm: z.number().min(20).max(400),
  octaveShift: z.number().int().min(-4).max(4).default(0),
  mapping: z.record(pitchSchema, keySchema),
  notes: z.array(z.object({
    pitch: pitchSchema,
    beat: z.number().min(0).max(4000),
    duration: z.number().positive().max(200),
  }).strict()).min(1).max(4096),
}).strict();

function midi(pitch) {
  const [, letter, accidental, octave] = /^([A-G])(#|b)?([0-8])$/.exec(pitch);
  return 12 * (+octave + 1) + { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[letter]
    + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0);
}

export function compileScore(input) {
  const { bpm, octaveShift, mapping, notes } = scoreSchema.parse(input);
  const keys = new Map();
  for (const [pitch, key] of Object.entries(mapping)) {
    const number = midi(pitch);
    if (keys.has(number) && keys.get(number) !== key) throw new Error(`Conflicting mapping for ${pitch}.`);
    keys.set(number, key);
  }
  const events = [];
  for (const note of notes) {
    const key = keys.get(midi(note.pitch) + octaveShift * 12);
    if (!key) throw new Error(`No key mapping for ${note.pitch} with octaveShift ${octaveShift}.`);
    const start = Math.round(note.beat * 60000 / bpm);
    const end = Math.round((note.beat + note.duration) * 60000 / bpm);
    if (end <= start) throw new Error('Note duration rounds to zero milliseconds.');
    if (end - start > 30000) throw new Error('A note may be held for at most 30 seconds.');
    if (end > 600000) throw new Error('Score exceeds 10 minutes.');
    events.push({ atMs: start, type: 'down', key }, { atMs: end, type: 'up', key });
  }
  events.sort((a, b) => a.atMs - b.atMs || (a.type === b.type ? 0 : a.type === 'up' ? -1 : 1));
  const held = new Set();
  for (const e of events) {
    if (e.type === 'down') {
      if (held.has(e.key)) throw new Error(`Overlapping notes share ${e.key}.`);
      held.add(e.key);
    } else held.delete(e.key);
  }
  return { events, durationMs: events.at(-1).atMs };
}
