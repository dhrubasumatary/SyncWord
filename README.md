# SyncWord

SyncWord is a web-first caption studio for Indian-language video. The browser
handles upload, phrase editing, and instant style preview; a companion Node
service handles ffmpeg, Saaras v3 Batch STT in `codemix` mode, ASS generation,
and the final burn-in.

## Product flow

1. Add a video and choose Assamese, Bodo, or automatic language detection.
2. The render service extracts 16 kHz mono WAV audio with ffmpeg.
3. Saaras v3 Batch STT returns phrase-level timestamps.
4. SyncWord splits each phrase into script-safe words, samples a 20 ms audio
   energy envelope, and globally optimizes word boundaries around waveform
   valleys. Grapheme length supplies the timing prior; Sarvam's phrase start
   and end remain hard anchors.
5. Review low-confidence boundaries, nudge them when needed, and tune font,
   highlight, outline, placement, and motion in the browser without
   re-rendering the video.
6. Approve the result to generate ASS `\kf` karaoke events and burn the final
   MP4 with ffmpeg.

The API is deliberately client-agnostic so a future Expo app can remain a pure
upload/status/download client.

## Local setup

Copy `.env.example` to `.env`, set `SARVAM_API_KEY`, then run:

```bash
npm install
npm run dev
npm run render-server
```

The web editor runs at `http://localhost:3000`; the render API runs at
`http://localhost:8787`.

## Container render service

`server/Dockerfile` installs ffmpeg plus Noto script fonts and starts the render
API. Set `SARVAM_API_KEY`, `ALLOWED_ORIGINS`, and a persistent volume mounted at
`/data/syncword` in production.

## API

- `POST /v1/jobs` — multipart video upload; begins extraction and Batch STT
- `GET /v1/jobs/:id` — processing state and phrase captions
- `POST /v1/jobs/:id/render` — approved caption blocks and style
- `GET /v1/jobs/:id/download` — final MP4
- `GET /v1/jobs/:id/captions.ass` — generated ASS file
- `GET /health` — service readiness

## WordSync timing model

Sarvam Batch STT supplies chunk-level sentence or phrase timestamps, not
word-level timings. SyncWord's word boundaries are therefore inferred by a
phrase-anchored waveform aligner rather than claimed as model-provided
timestamps. Each boundary carries a confidence score; weak boundaries are
surfaced for manual review and fall back to a grapheme-weighted timing prior
when the audio does not contain enough usable frames.

This is deliberately script-agnostic and works with Assamese/Bengali and
Devanagari text, but it is not phoneme-aware forced alignment. Music, crosstalk,
and words spoken without an audible energy transition can still require a
manual nudge.
