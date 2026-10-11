# MotionMirror

A webcam practice mirror for choreography, dance or sports drills. Shows your
own camera feed delayed by a configurable number of seconds, so you can
perform a move and then watch yourself do it a few seconds later without
breaking flow. Also records whatever is on screen, and lets you pick camera
resolution/fps. Built as a plain HTML/CSS/JS site (no framework, no build
step) so there is nothing between the camera and the screen.

Everything runs entirely in the browser — there is no backend, no account,
and no server that ever sees your camera feed. Nothing is uploaded anywhere;
recordings stay in the browser tab until you download them yourself.

## Using the deployed version

**Live at:** https://motion-mirror-gamma.vercel.app/ — just open it and click
"Activar cámara". Works on desktop and mobile, no install needed.

## Running it locally

```
npm start
```

or directly: `node server.js` (any Node >= 14 works; no dependencies).

This starts two servers:

- `http://localhost:8080` — for this PC. Plain HTTP is enough here because
  Chrome/Edge/Firefox treat `localhost` as a "secure context" automatically,
  which is what `getUserMedia()` requires.
- `https://<your-LAN-IP>:8443` — for your phone or any other device on the
  same Wi-Fi. This one needs real HTTPS (a browser will only grant camera
  access to `http://` on `localhost`, not to a LAN IP), so the server
  generates a self-signed certificate on first run. The exact URL to use is
  printed in the terminal every time you start the server. The first time you
  open it on a device, the browser will show a privacy warning — that's
  expected for a self-signed cert; choose "Advanced" → "Proceed". You only
  need to do this once per device (or again if your LAN IP changes, since the
  server regenerates the cert automatically when that happens).

The plain-HTTP port is bound to `127.0.0.1` only, so the unencrypted feed is
never reachable from the network — LAN devices are forced through the HTTPS
port.

If you have multiple Node versions installed, any Node >= 14 works fine —
nothing here depends on a specific version.

## Features

- **Live / delayed mirror** — toggle between a normal live feed and a view
  delayed by `n` seconds (adjustable with a slider).
- **Camera quality controls** — pick the input device, resolution and fps
  from what your camera actually reports supporting.
- **Recording (live view only)** — records camera + microphone into a
  regular MP4 (H.264 + AAC) per take: real duration, instant seeking, plays
  in any phone gallery or desktop player.
- **Guardar / Enviar** (`share.js`) — a web page can't write into the
  gallery or Google Photos directly, so "Guardar" offers the two real routes
  on phones: download (Android lists it in the gallery's "Download" album) or
  the OS share sheet (Google Photos "Subir a Fotos"; "Guardar video" on
  iPhone). On desktop it's a plain download. "Enviar" opens the share sheet
  with *only* the `video/mp4` file — no title/text — so WhatsApp & co. send
  it as a playable video rather than as a document.
- **Built-in player** — full-screen overlay for reviewing takes, works with
  mouse, keyboard and touch: slow motion (0.25×–2×), ±5 s skip, frame
  stepping, loop, mirror, fullscreen. Double-tap left/right to skip on touch.
- **Mirror flip, practice/focus mode** (hides all controls to maximize the
  preview), **screen wake lock** (keeps the screen on while a camera is
  active), and a debug panel with live capture/render fps and buffer memory
  use.
- Responsive layout: single column with a bottom control panel on narrow
  (phone) screens, sidebar layout on wide (desktop) screens.

## How the delay works

The delayed mirror is two independent loops sharing a buffer: **capture**
(driven by `requestVideoFrameCallback` — falls back to polling
`requestAnimationFrame` on browsers without it, e.g. Firefox) pushes
timestamped frames in; **render** (`requestAnimationFrame`) pulls out
whichever buffered frame is at least `n` seconds old and draws it to the
`<canvas>`, then discards it. Neither loop waits for the other — the camera
keeps handing capture new frames on its own clock, the display keeps asking
render for a new picture on its own clock.

There are two implementations of that buffer, in `public/js/`:

- **`delayEngineWebCodecs.js` (used whenever the browser supports it — Chrome/
  Edge 94+, Firefox 130+ desktop, Safari 26+):** every captured frame is
  compressed as an independent H.264 keyframe via `VideoEncoder`, and only
  decoded back via `VideoDecoder` once it's actually due to be shown. A real
  video codec is built for continuous real-time throughput in a way per-frame
  JPEG isn't — measured on real hardware (this project's webcam), ~15ms to
  encode and ~10ms to decode a 1080p frame, both well
  under the 33ms budget at 30fps, at roughly **1/100th the size** of a raw
  frame (~80KB vs ~8MB at 1080p). That's what unlocks 30+ second delays
  instead of 2-3.
- **`delayEngineRaw.js` (fallback):** buffers uncompressed `ImageBitmap`s
  directly — simpler, universally supported, but memory-bound to a few
  seconds at 1080p (raw RGBA is `width × height × 4` bytes/frame). Used
  automatically when `VideoEncoder`/`VideoDecoder` don't exist, and as a
  runtime fallback if WebCodecs exists but fails to actually configure for
  the current device.

`delayEngine.js` is a thin wrapper that picks between the two at
construction and exposes one interface (`start()`, `stop()`, `setDelay()`,
`getMaxDelaySeconds()`, `.stats`) so the rest of the app doesn't care which
one is active — `main.js` just reads `delayEngine.usingWebCodecs` to show
which mode is running in the debug panel.

Storing frames isn't free even compressed, so both engines cap the maximum
selectable delay to whatever fits their own memory budget, shown live on the
slider and recalculated whenever resolution/fps changes. Two things had to
be true at once for this to actually stay smooth (both broke in testing
before being fixed, in both engines):

- Capture only starts encoding/copying a new frame once the previous one has
  finished. Without this guard, at resolutions where that work takes close
  to as long as a frame interval, calls start overlapping faster than they
  finish, piling up concurrent work until the GPU/main thread chokes.
- The selectable max delay only ever uses ~70% of the buffer's real capacity
  (`SAFETY_MARGIN`/`DELAY_SAFETY_MARGIN`). Capture and render tick
  independently, so if the delay were set to use *all* of the buffer's
  capacity, the memory-eviction cap and the "is this frame old enough to
  show" check race for the same oldest frame — and eviction reliably wins,
  permanently discarding frames moments before they're due to render. The
  delayed view then just freezes. The margin keeps a standing cushion so
  that can't happen — verified by deliberately pinning the slider to its
  exact max and confirming capture/render stayed matched instead of
  starving.

The WebCodecs engine also **pre-warms** its encoder (right when the camera
starts, and again after any quality change) by configuring it and encoding
one throwaway frame ahead of time, since a codec's first-ever frame carries
a one-time ~0.2-1.2s setup cost — without pre-warming, that cost would land
on the first real frame of whichever session first enters delay mode.

## Recording design

Recording is only offered in the live view; in delay mode the record
controls are replaced by a note (the delayed view is for watching yourself
back, not for capturing).

The output is a **non-fragmented MP4 with the `moov` index at the front**
(H.264 video, AAC audio) — the same shape a phone camera produces. Plain
`MediaRecorder` output can't be used directly for that: Chrome/Firefox WebM
has no duration or cues (unseekable in most players, unplayable in iOS
Photos), and `MediaRecorder` MP4 is fragmented. So `recorder.js` uses
[Mediabunny](https://mediabunny.dev) (MPL-2.0, vendored in `public/vendor/`
so the `script-src 'self'` CSP stays intact; loaded on demand):

- **Primary path:** `MediaStreamVideoTrackSource` / `MediaStreamAudioTrackSource`
  encode the camera and mic tracks with WebCodecs and mux straight into the
  MP4 (`fastStart: 'in-memory'`). 1 s keyframe interval so scrubbing is
  precise. If the browser can't encode AAC natively (e.g. Firefox), a WASM
  AAC encoder (`@mediabunny/aac-encoder`) is loaded instead.
- **Fallback** (no WebCodecs H.264/HEVC encoder): `MediaRecorder`, then a
  Mediabunny remux pass that writes a proper MP4 (or a cued WebM if the
  codecs don't fit MP4). The original file is kept if that fails, so a take
  is never lost.

The microphone is requested per take, not at camera start, so using the
mirror alone never asks for it. Browser audio processing (noise suppression,
echo cancellation, AGC) is **off by default** because it's tuned for speech
and mangles music; a checkbox turns it on. If mic access is denied the take
is recorded video-only, with a toast. The on-screen mirror flip does not
affect recordings (the player has its own mirror toggle).

Recordings live in memory for the session (blob URLs); nothing is written to
disk until you download or share one. They are lost on reload.

## Deployment & security headers

The public site is a static deploy of `public/` on Vercel's free tier —
there's no server-side code involved at all in production; `server.js` only
exists for local LAN testing with a self-signed cert (see above) and isn't
part of what gets deployed.

`vercel.json` adds security headers appropriate for a page that requests
camera access: `frame-ancestors 'none'` (Content-Security-Policy) stops the
page from being embedded in someone else's iframe to trick a visitor into
granting camera permission they think they're giving to a different site,
and `Permissions-Policy: camera=(self), microphone=(self)` keeps those
permissions from being delegated to embedded content. The CSP also allows
`'wasm-unsafe-eval'` and `worker-src blob:`, which Mediabunny and its WASM
AAC encoder need (they spin up inline blob workers); the same policy is
mirrored in the page's `<meta>` CSP for local serving. Since GitHub Pages doesn't support custom
response headers, it isn't used for the deploy despite being a free option
too.

## Known limitations

- WebCodecs (the compressed-buffer delay engine) needs Chrome/Edge 94+,
  Firefox 130+ desktop only (not yet on Firefox for Android), or Safari 26+.
  Older or unsupported browsers automatically fall back to the raw-buffer
  engine, with its much shorter max delay.
- Firefox lacks `requestVideoFrameCallback`; the app falls back to polling
  `video.currentTime` on `requestAnimationFrame`, which works but captures
  slightly less precisely than Chrome/Edge/Safari. This applies to either
  delay engine.
- The raw engine's memory budget is a heuristic, not a hard device
  measurement — `navigator.deviceMemory` is only available on Chromium
  browsers and only reports a rough bucket; on Firefox/Safari it silently
  assumes 4 GB. The WebCodecs engine sidesteps most of this since compressed
  frames are tiny regardless, but its own max-delay estimate starts from a
  fixed reference (refined from real measured chunk sizes once capture
  starts) rather than a true per-device number.
- Self-signed cert: every new device needs to click through one browser
  warning the first time it connects over HTTPS.
