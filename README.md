# subtitles — by miithii

`subtitles` is a caption-first video studio for Assamese and Bodo. It turns a
source video into an editable, revisioned subtitle project and lets creators
shape the rhythm of a line with small and large words before rendering a new
MP4. The original upload is never overwritten.

## Language contract

The creator explicitly chooses **Assamese** (`as-IN`) or **Bodo** (`brx-IN`) before
processing. There is no automatic language-detection choice.

`codemix` is a transcription/writing mode inside the selected language. It
allows regional-script speech and embedded English to be written faithfully;
it does not guess which language the video contains.

## Primary project flow

The hosted application uses the durable project API:

1. The browser creates a `Project`.
2. It reserves a source `Asset` and streams the original video once to the
   project-scoped R2 object.
3. It creates a `ProcessingJob` for that asset, selected language, and writing
   mode. The Worker dispatches the immutable request to the compute service's
   `/v3/processing-jobs` surface.
4. Compute downloads the source through a scoped capability, runs speech
   transcription, word alignment, and coverage checks, then returns a
   normalized editor document.
5. The Worker validates that document, stores the first immutable
   `ProjectRevision`, and advances the project head. A valid
   `review_required` result remains editable but cannot render until its speech
   gaps are repaired.
6. Text, timing, and small/large word-style changes remain local while editing.
   Saving creates another immutable revision from an explicit
   `baseRevisionId`; it never mutates an earlier revision.
7. Export creates a `RenderJob` containing only a saved `revisionId`, an export
   specification, a renderer revision, and an idempotency key. The renderer
   never reads an unsaved browser draft or the mutable project head.
8. Compute hash-verifies the revision, verifies the source facts available to
   it, generates the video and caption files, and uploads each artifact through
   job-scoped callback URLs.
9. The Worker records durable `ExportArtifact` rows only after the corresponding
   R2 objects exist. The browser polls the render independently and downloads
   the exact artifact produced for that revision.

The Worker is the authorization and state-transition boundary. D1 stores
project, revision, job, and artifact metadata; R2 stores source media, immutable
revision documents, and exported files. Speech models and FFmpeg stay in the
separate compute service.

## Local setup

Requirements:

- Node.js 22.13 or newer
- npm
- FFmpeg available on `PATH` (or set `FFMPEG_PATH`)
- a Sarvam API key for transcription
- a deployed Modal alignment endpoint

Install dependencies and create the local environment file:

```powershell
npm install
Copy-Item .env.example .env
```

Set at least these values in `.env`:

```dotenv
SARVAM_API_KEY=...
MODAL_ALIGNER_URL=...
NEXT_PUBLIC_RENDER_API_URL=http://localhost:8787
```

Start the web editor and local compute service together:

```powershell
npm run dev
```

For isolated debugging, `npm run dev:web` and `npm run dev:engine` run the two
processes separately.

The editor is served at `http://localhost:3000`; the render service defaults to
`http://localhost:8787`. The interface can load locally, but caption generation
is not network-offline: it requires the configured transcription and alignment
services. The editor now reports a missing local API key directly instead of
silently waiting on the engine.

Useful checks:

```powershell
npm run lint
npm test
```

`npm test` builds the vinext/Cloudflare application before running the Node test
suite.

## API surfaces

The primary hosted contract is `/api/projects` and its nested resources:

- assets and source upload/content
- processing jobs and their immutable first revision
- revisions created with optimistic concurrency
- render jobs and artifact callbacks
- project export history and artifact content

The compute plane receives `/v3/processing-jobs` and `/v3/render-jobs` requests
from that project API.

Two compatibility surfaces remain intentionally reachable:

- `/v1/jobs` supports the direct local/configured render-server workflow.
- `/api/media/jobs`, backed by compute `/v2/jobs`, restores older hosted drafts
  that predate durable projects.

New hosted uploads must use the project flow. Do not add new product behavior to
the compatibility routes; remove them only after local development has a
project-mode replacement and old hosted drafts have passed their recovery
window.

## Current limits

- Dispatch is direct. A bounded lease and owner-poll redrive can repair a stale
  attempt, but there is no autonomous durable queue or workflow yet.
- Source upload is one streamed PUT, not resumable multipart upload.
- The editor range-serves the authenticated source; thumbnail strips, proxy
  media, and HLS previews are not implemented.
- Ownership is an HttpOnly project capability, not account identity. Losing the
  cookie cannot be repaired from browser storage.
- Upload finalization records size and ETag. SHA-256, duration, dimensions, and
  codec facts are verified only when the relevant stage has actually produced
  them.
- Caption coverage is a quality gate, not a claim of mathematically perfect
  speech detection. Uncertain or uncovered speech can require manual repair.
- The renderer is caption-first. A general scene/layer composition graph is out
  of scope.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the control-plane
boundaries and enforced invariants.
