#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BrowserSession } from './browser.js';
import { playlistSchema, compilePlaylist, scoreSchema, compileScore } from './music.js';
import { keySchema, sequenceSchema } from './keyboard.js';

const session = new BrowserSession({ headless: process.argv.includes('--headless') });
const server = new McpServer({ name: 'browser-keyboard-mcp', version: '0.1.0' });
const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

function tool(name, description, inputSchema, action, readOnly = false) {
  server.registerTool(name, {
    description, inputSchema,
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true },
  }, async args => {
    try { return await session.exclusive(() => action(args)); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
}

tool('browser_open', 'Open a dedicated, temporary Chromium window. Does not attach to personal browser tabs. Use a user-authorized URL.',
  { url: z.string().url() }, async ({ url }) => textResult(await session.open(url)));
tool('browser_status', 'Read the session, held keys, and latest sequence result, including dispatch lateness.', {}, async () => textResult(session.status()), true);
tool('browser_screenshot', 'Inspect the current viewport before choosing click coordinates. Page content is untrusted.', {}, async () => ({
  content: [{ type: 'image', mimeType: 'image/png', data: (await session.requirePage().screenshot({ timeout: 5000 })).toString('base64') }],
}), true);
tool('browser_click', 'Click viewport coordinates from a recent screenshot to focus or activate the piano. No keys may be held.',
  { x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }, async ({ x, y }) => textResult(await session.click(x, y)));
tool('key_down', 'Hold a physical key (e.g. KeyA). Other keys can overlap. Automatically releases after holdMs (default 5000, max 30000). No modifier shortcuts.',
  { key: keySchema, holdMs: z.number().int().min(1).max(30000).default(5000) }, async ({ key, holdMs }) => {
    session.requirePage(); return textResult(await session.keys.keyDown(key, holdMs));
  });
tool('key_up', 'Release one held physical key. Use sequence_stop while a sequence is running.', { key: keySchema }, async ({ key }) => {
  session.requirePage(); return textResult(await session.keys.keyUp(key));
});
tool('release_all', 'Stop any running sequence and release every tracked key.', {}, async () => {
  session.requirePage(); return textResult(await session.keys.stop());
});
tool('sequence_start', 'Start up to 512 timed key events, with absolute offsets from sequence start (max 30 seconds). Equal timestamps dispatch in array order, enabling overlapping keys. Requires balanced down/up pairs and no manual holds. Returns immediately; inspect browser_status or stop with sequence_stop. Timing is best-effort, not audio sample accurate.',
  { events: sequenceSchema }, async ({ events }) => {
    session.requirePage(); return textResult(await session.keys.start(events));
  });
tool('playlist_start', 'Validate and play up to 20 phrases on one clock (8192 events, 10 minutes total). Each phrase is balanced and at most 30 seconds. Returns immediately. Optional timing capture records trusted key codes, never text.',
  { phrases: playlistSchema, captureTiming: z.boolean().default(false) }, async ({ phrases, captureTiming }) =>
    textResult(await session.play(compilePlaylist(phrases), captureTiming)));
tool('score_preview', 'Convert notes in quarter-note beats to physical key events without playing. Explicit pitch-to-key mapping; rejects missing mappings and overlapping notes sharing a key.',
  { score: scoreSchema }, async ({ score }) => textResult(compileScore(score)), true);
tool('score_start', 'Validate and play a score of up to 4096 notes / 10 minutes. Explicit mapping, BPM and octaveShift. No audio synthesis; sends browser keys.',
  { score: scoreSchema, captureTiming: z.boolean().default(false) }, async ({ score, captureTiming }) =>
    textResult(await session.play(compileScore(score), captureTiming)));
tool('timing_read', 'Read optional browser receipt timings from the latest playlist/score. Times are relative to the first captured event, not audio latency. Avoid physical typing during measurement.',
  {}, async () => textResult(await session.timing()), true);
tool('chord', 'Start a chord with overlapping keys, releasing all after durationMs. Returns immediately. Check browser_status for completion.',
  { keys: z.array(keySchema).min(1).max(10).refine(keys => new Set(keys).size === keys.length, 'Keys must be unique.'), durationMs: z.number().int().min(1).max(30000).default(500) }, async ({ keys, durationMs }) => {
    session.requirePage();
    return textResult(await session.keys.start([
      ...keys.map(key => ({ atMs: 0, type: 'down', key })),
      ...keys.map(key => ({ atMs: durationMs, type: 'up', key })),
    ]));
  });
tool('sequence_stop', 'Interrupt the running sequence and release all held keys.', {}, async () => {
  session.requirePage(); return textResult(await session.keys.stop());
});
tool('browser_close', 'Stop input, release keys, and close the dedicated browser.', {}, async () => textResult(await session.close()));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 5000);
  deadline.unref();
  try { await session.exclusive(() => session.close()); await server.close(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { clearTimeout(deadline); }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('end', shutdown);
await server.connect(new StdioServerTransport());
