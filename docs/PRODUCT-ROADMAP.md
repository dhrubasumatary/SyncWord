# SyncWord product direction

## Purpose

Help people publish understandable video in the languages they actually speak.
The product should make Assamese, Bodo, and code-mixed speech as easy to caption
as English without asking creators to become audio engineers.

## The user promise

1. Choose a video.
2. Watch the editable captions on the real video.
3. Tap only what sounds or looks wrong.
4. Pick a caption look.
5. Make a post-ready copy.

The original video is never overwritten. Automatic timing is never presented as
more certain than it is. Export is never required just to preview a change.

## Interface rules

- Show the video before controls.
- Ask for one decision at a time.
- Use creator language, not speech-model language.
- Treat automatic checks as optional listening suggestions, not errors.
- Keep exact timing controls behind an optional disclosure.
- Let a creator export whenever the preview feels right.
- Make the primary action visually obvious and thumb reachable.
- Every destructive or expensive action must explain what happens next.
- Regional scripts receive the same typography quality as Latin text.

## Quality bar

- Preview highlighting follows decoded video frames, not a coarse UI timer.
- Text correction never silently destroys existing timing when word counts match.
- Unreliable word boundaries fall back to a steady phrase instead of fake karaoke.
- A creator can correct a sentence and nudge a word without understanding timecodes.
- A failed network request never loses the selected local video.
- Export progress survives ordinary mobile interruptions where the platform allows.
- Every supported browser has either local export or a clear server fallback.

## Architecture

### Current foundation

- Mobile-first web editor keeps the original video locally for instant preview.
- Cloudflare R2 holds temporary uploads and rendered results.
- Saaras v3 produces the regional-language transcript.
- The alignment service estimates word timing inside speech-aware windows.
- The browser owns text/style correction and preview.
- Server FFmpeg remains the dependable ASS burn-in exporter.

### Next milestone: local-first export

- Render the source video plus caption overlay through Canvas and WebCodecs.
- Use Mediabunny for MP4/WebM output and compatible audio muxing.
- Reuse one caption-style model for the browser renderer and ASS fallback.
- Feature-detect codec support, memory pressure, and browser limitations.
- Keep server FFmpeg as fallback for unsupported devices and difficult inputs.
- Show an honest estimate before choosing local or server export.

This reduces server compute and output bandwidth. It does not make caption burn-in
lossless: any burned-in caption export re-encodes video.

### Reliability milestone

- Resumable multipart uploads for larger mobile files.
- IndexedDB recovery for project edits and interrupted uploads.
- Idempotent jobs so retries cannot occupy multiple queue slots.
- Structured stages, timeouts, cancellation, and user-readable failure recovery.
- Privacy retention controls and automatic deletion of temporary media.
- Small test corpus of consenting Assamese, Bodo, and code-mixed clips with
  transcript and timing acceptance checks.

### Product milestone

- Device-local projects before accounts.
- Optional accounts only when cross-device history is valuable.
- Reusable looks and creator presets.
- Caption import/export without forcing a video render.
- Expo app after the API and export contract are stable; the first native app is
  an upload/edit/download client, not a second processing backend.

## Measurement

The north-star event is a downloaded video after a successful preview session.
Track product health without retaining speech content:

- upload-to-editable-preview time;
- percentage of jobs reaching an editable preview;
- manual text edits and timing nudges per minute of video;
- preview-to-export conversion;
- export duration and fallback rate by device/browser;
- retries, cancellations, queue rejection, and expired-result rate;
- creator-reported sync quality by language and code-mix mode.

## Explicit non-goals for the MVP

- Building a full nonlinear video editor.
- Shipping Premiere, After Effects, or Resolve plugins before timing quality and
  the core API are stable.
- Pretending estimated word timing is ground truth.
- Adding authentication, billing, teams, or permanent video storage before the
  correction and export loop is dependable.
