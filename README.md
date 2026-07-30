# SyncWord

SyncWord is a web-first caption studio for Indian-language video. The browser
handles upload, phrase editing, and instant style preview; a companion Node
service handles ffmpeg, Saaras v3 Batch STT in `codemix` mode, ASS generation,
and the final burn-in.

## Product flow

1. Add a video and choose Assamese, Bodo, or automatic language detection.
2. The render service extracts 16 kHz mono WAV audio with ffmpeg.
3. Saaras v3 Batch STT returns phrase-level timestamps.
4. Review the transcript and tune font, color, outline, placement, and motion
   in the browser without re-rendering the video.
5. Approve the look to generate ASS and burn the final MP4 with ffmpeg.

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

## Important timing constraint

Sarvam Batch STT supplies chunk-level sentence or phrase timestamps, not
word-level timings. SyncWord therefore promises strong subtitle-block sync.
Karaoke-style word wipes require a separate forced-alignment system.
