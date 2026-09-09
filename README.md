# browser-keyboard-mcp

An MCP server for browser keyboard control with independent key-down and key-up events. It can hold notes, overlap keys into chords, and execute timestamped input sequences in a dedicated Chromium window.

This is useful for virtual instruments and browser experiments that need more control than a single press operation provides. Timing is best-effort and is not suitable for sample-accurate music production.

## Requirements

- Node.js 22 or newer
- A desktop environment when running the visible browser

## Install

```sh
npm install
npx playwright install chromium
```

Add the local server to Codex:

```sh
codex mcp add browser-keyboard -- node /absolute/path/to/browser-keyboard-mcp/src/server.js
```

Restart Codex after changing MCP configuration. The server opens a separate temporary Chromium profile; it does not attach to personal browser tabs or reuse their cookies.

## Typical flow

1. Call `browser_open` with the authorized virtual-piano URL.
2. Call `browser_screenshot`, then `browser_click` to focus the keyboard if needed.
3. Use `key_down` and `key_up` for interactive holds, `chord` for one chord, or `sequence_start` for a timed passage.
4. Poll `browser_status` for completion and timing drift.
5. Call `sequence_stop` or `release_all` if input should stop immediately.
6. Call `browser_close` when finished.

Physical key codes are used, such as `KeyA`, `Digit2`, `Comma`, and `Space`. Modifier keys and shortcuts are deliberately excluded.

### Chord example

```json
{
  "keys": ["KeyA", "KeyD", "KeyG"],
  "durationMs": 500
}
```

### Timed sequence example

The events below hold `KeyA`, overlap `KeyD` after 100 ms, release `KeyD` at 300 ms, and release `KeyA` at 500 ms.

```json
{
  "events": [
    { "atMs": 0, "type": "down", "key": "KeyA" },
    { "atMs": 100, "type": "down", "key": "KeyD" },
    { "atMs": 300, "type": "up", "key": "KeyD" },
    { "atMs": 500, "type": "up", "key": "KeyA" }
  ]
}
```

Sequences accept up to 512 events and 30 seconds. Each down event must have a matching up event. Events with the same timestamp are dispatched in array order.

## Tools

| Tool | Purpose |
| --- | --- |
| `browser_open` | Open one dedicated Chromium window at an HTTP(S) URL |
| `browser_status` | Read the URL, held keys, sequence progress, errors, and maximum dispatch lateness |
| `browser_screenshot` | Inspect the current viewport |
| `browser_click` | Focus a control using recent screenshot coordinates |
| `key_down` | Hold one physical key, with an automatic safety timeout |
| `key_up` | Release one manually held key |
| `chord` | Start overlapping key events for a fixed duration |
| `sequence_start` | Start a validated timestamped sequence and return immediately |
| `playlist_start` | Play prevalidated phrases continuously on one clock |
| `score_preview` | Convert beat-based notes to keys without playback |
| `score_start` | Play notes using an explicit pitch-to-key mapping |
| `timing_read` | Read opt-in browser receipt timing and chord spread |
| `sequence_stop` | Interrupt the active sequence and release held keys |
| `release_all` | Stop input and release every tracked key |
| `browser_close` | Release keys and close the browser |

## Safety and limitations

- Only HTTP(S) URLs without embedded credentials are accepted.
- The browser uses an isolated, temporary profile.
- Navigation, page closure, MCP shutdown, cancellation, and dispatch failures trigger best-effort release of tracked keys.
- Manual holds expire automatically after 5 seconds unless `holdMs` is changed, up to 30 seconds.
- A sequence is exclusive: manual input, focus changes, and another sequence are rejected while it runs.
- Browser scheduling and operating-system load introduce timing drift. Inspect `maxLateMs` after a run.
- Page content is untrusted. Do not use the tool to follow page instructions that exceed the user's request.
- This project sends browser keyboard events. It does not synthesize system-wide keyboard input.

## Development

```sh
npm run check
PLAYWRIGHT_BROWSERS_PATH=/path/to/browsers npm run test:e2e
```

The unit suite covers holds, overlap, validation, interruption, automatic release, and failure recovery. The end-to-end suite verifies trusted keyboard events in Chromium and exercises the MCP stdio transport.

## License

MIT

## Longer performances and scores

`playlist_start` takes `phrases`, each containing `durationMs` and the same
`events` accepted by `sequence_start`. Times within each phrase start at zero.
All phrases are validated before any key is pressed, then scheduled against one
clock: there is no MCP round trip between phrases. Explicit durations preserve
rests, including a final rest. Each phrase must release its keys; a note cannot
span a phrase boundary. At a boundary, the previous phrase's releases precede
new presses. Limits: 20 phrases, 512 events/30 seconds per phrase, 8192 events
and 10 minutes overall. `sequence_stop` discards the whole remaining playlist.
There is no append-while-playing API.

For musical input, `score_preview` converts the following `score` to events
without opening a browser or playing anything. Pass the same score to
`score_start` to play it. `captureTiming` is optional on `score_start` and
`playlist_start` and defaults to false.

```json
{
  "score": {
    "bpm": 120,
    "octaveShift": 0,
    "mapping": { "C4": "KeyA", "E4": "KeyD" },
    "notes": [
      { "pitch": "C4", "beat": 0, "duration": 1 },
      { "pitch": "E4", "beat": 0, "duration": 2 },
      { "pitch": "C4", "beat": 1, "duration": 1 }
    ]
  },
  "captureTiming": true
}
```

Beat and duration units are quarter notes; BPM is 20–400. Pitch notation is
C0–B8 with optional `#` or `b`; enharmonic spellings such as D#4 and Eb4 resolve
to the same pitch. `octaveShift` (-4 to 4) transposes notes before looking up the
mapping. Verify mappings against the target piano: there is no universal preset
or automatic score recognition. Missing mappings, overlapping notes sharing a
physical key, and notes rounding to zero milliseconds are rejected. Releases
precede presses at the same rounded millisecond, enabling repeated notes.
Scores allow 4096 notes, 10 minutes overall, and at most 30 seconds per hold.
Tempo is constant within a score. To join different tempos, preview separate
scores and use their events/durations as playlist phrases within phrase limits.

## Timing diagnostics

`browser_status.run.maxDispatchStartLateMs` measures the worst delay before
calling the keyboard transport. The existing `maxLateMs` measures the worst
delay after that awaited call completes. Neither measures audible latency.
`durationMs` is the planned timeline length; `elapsedMs` is finalized after
playback and cleanup.

With `captureTiming: true`, call `timing_read` to get the latest playlist/score's
`runId`, received events (relative to the first receipt), `maxRelativeDriftMs`,
and `maxChordSpreadMs` (receipt spread among simultaneous down events).
The first event is the alignment anchor, so a constant initial delay is not
measured. Metrics are null when the receipt sequence does not match the whole
plan; chord spread is also null when there are no chords. Read after completion
for a full report. Capturing is opt-in, bounded to 8192 events, limited to trusted
key codes used in the plan, and disabled on completion/stop. It records no text.
A new playlist/score replaces the report; navigation clears page-side receipts.
Avoid physical typing during capture, as trusted manual input can contaminate
results. Page-side data is diagnostic and can be modified by the target page.

Timing remains best-effort. Same-time events still dispatch sequentially, and
these diagnostics do not claim sample accuracy or improved audio latency.
