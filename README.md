# SyncWord

SyncWord is a web-first caption studio for Indian-language video. The browser
handles upload, phrase editing, and instant style preview; a companion Node
service handles ffmpeg, Saaras v3 Batch STT in `codemix` mode, ASS generation,
and the final burn-in.

## Product flow

1. Add a video and choose Assamese, Bodo, or automatic language detection.
2. The render service extracts 16 kHz mono WAV audio with ffmpeg. Sarvam
   auto-detects the WAV container; `input_audio_codec` is intentionally omitted
   because that parameter is required only for raw PCM uploads.
3. Saaras v3 Batch STT returns phrase-level timestamps.
4. SyncWord sends each timestamped phrase and its audio window to a Modal T4
   worker running Meta's dedicated `MMS_FA` forced-alignment model. Uroman
   normalizes Assamese, Bodo, English, and code-mixed display words onto the
   model's shared acoustic alphabet. MMS star spans absorb transcript/audio
   mismatches instead of stretching a neighboring word across a long gap.
5. The first upload automatically generates ASS `\kf` karaoke events and burns
   a social-ready H.264/AAC MP4 with ffmpeg.
6. The player switches to that real rendered file. Optional transcript,
   boundary, or style changes preview instantly in the browser and create a new
   final MP4 only when the user taps **Update final video**.

The browser stores source videos, job state, ASS files, and rendered MP4s in
Cloudflare R2. Render remains a stateless Saaras/ffmpeg worker for the MVP, and
the API stays client-agnostic so a future Expo app can remain a pure
upload/status/download client.

## Local setup

Copy `.env.example` to `.env`, set `SARVAM_API_KEY` and
`MODAL_ALIGNER_URL`, then run:

```bash
npm install
npm run dev
npm run render-server
```

The web editor runs at `http://localhost:3000`; the render API runs at
`http://localhost:8787`.

## Container render service

`server/Dockerfile` installs ffmpeg plus Noto script fonts and starts the render
API. Set `SARVAM_API_KEY` and `ALLOWED_ORIGINS` in production.

`render.yaml` defines one serialized hobby render worker in Singapore. The
production web app accepts reels up to 90 MB and three minutes, stores uploads
and results in R2, and retains them for 24 hours. A Render restart can interrupt
the current compute attempt, but it no longer deletes the uploaded source or a
completed export.

## API

- `POST /v1/jobs` — multipart video upload; runs the complete caption + render
  pipeline automatically
- `GET /v1/jobs/:id` — processing state and phrase captions
- `POST /v1/jobs/:id/render` — re-render edited captions or style
- `GET /v1/jobs/:id/result` — inline final MP4 used by the real final preview
- `GET /v1/jobs/:id/download` — final MP4
- `GET /v1/jobs/:id/captions.ass` — generated ASS file
- `GET /health` — service readiness

Production web clients use the durable `/api/media/jobs` surface. It creates
an R2-backed job, accepts the source upload, starts the Render worker, persists
progress, serves range-enabled video previews, and supports re-rendering edited
captions. The legacy `/v1/jobs` routes remain useful for local development.

## WordSync timing model

Sarvam Batch STT supplies chunk-level sentence or phrase timestamps, not
word-level timings. SyncWord treats those timestamps as search windows rather
than inventing uniform word durations. Meta's CTC model scores the actual
speech frames against the known Sarvam transcript, and Viterbi decoding finds
the highest-probability monotonic character path. Word boundaries come from
that path. Each word carries a confidence score; unsupported or impossible
phrases fall back explicitly to the older grapheme prior and are surfaced for
review.

This is honest forced alignment rather than native Sarvam word timestamps.
Transcript errors, heavy music, crosstalk, and fully overlapping speech can
still require a manual nudge.
