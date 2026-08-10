// @ts-check

/**
 * Keep only the newest preview seek while the media element is resolving the
 * previous one. Transport jumps (play, loop, word selection) always win now.
 *
 * @param {HTMLMediaElement} media
 * @param {{ timeoutMs?: number, epsilon?: number }} [options]
 */
export function createLatestSeekController(media, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1400;
  const epsilon = options.epsilon ?? 0.006;
  /** @type {number | null} */
  let pendingPreview = null;
  /** @type {(() => void) | null} */
  let activeCleanup = null;
  let disposed = false;

  const finishActiveSeek = () => {
    activeCleanup?.();
  };

  const runPendingPreview = () => {
    if (disposed || activeCleanup || pendingPreview === null) return;
    const target = pendingPreview;
    pendingPreview = null;

    if (Math.abs(media.currentTime - target) <= epsilon) {
      runPendingPreview();
      return;
    }

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      media.removeEventListener("seeked", finish);
      media.removeEventListener("error", finish);
      globalThis.clearTimeout(timeout);
      activeCleanup = null;
      runPendingPreview();
    };
    const timeout = globalThis.setTimeout(finish, timeoutMs);
    activeCleanup = finish;
    media.addEventListener("seeked", finish);
    media.addEventListener("error", finish);
    media.currentTime = target;

    // Some already-buffered seeks complete synchronously without a seeked
    // event. Let the assignment settle, then release the next preview target.
    queueMicrotask(() => {
      if (!media.seeking && Math.abs(media.currentTime - target) <= epsilon) {
        finish();
      }
    });
  };

  return {
    /** Queue a scrub-preview position, replacing any older queued position. */
    preview(/** @type {number} */ seconds) {
      if (disposed || !Number.isFinite(seconds)) return;
      pendingPreview = Math.max(0, seconds);
      runPendingPreview();
    },

    /** Move immediately for an explicit transport action. */
    jump(/** @type {number} */ seconds) {
      if (disposed || !Number.isFinite(seconds)) return;
      pendingPreview = null;
      finishActiveSeek();
      media.currentTime = Math.max(0, seconds);
    },

    dispose() {
      disposed = true;
      pendingPreview = null;
      finishActiveSeek();
    },
  };
}
