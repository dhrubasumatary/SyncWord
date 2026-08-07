import assert from "node:assert/strict";
import test from "node:test";
import { createLatestSeekController } from "../shared/preview-transport.mjs";

class FakeMedia extends EventTarget {
  #currentTime = 0;

  seeking = false;
  assignments = [];

  get currentTime() {
    return this.#currentTime;
  }

  set currentTime(value) {
    this.#currentTime = value;
    this.assignments.push(value);
    this.seeking = true;
  }

  settle() {
    this.seeking = false;
    this.dispatchEvent(new Event("seeked"));
  }
}

test("scrubbing retains only the newest position while a seek is active", () => {
  const media = new FakeMedia();
  const controller = createLatestSeekController(media);

  controller.preview(1);
  controller.preview(2);
  controller.preview(3.25);
  assert.deepEqual(media.assignments, [1]);

  media.settle();
  assert.deepEqual(media.assignments, [1, 3.25]);
  media.settle();
  controller.dispose();
});

test("an explicit jump cancels stale preview work", () => {
  const media = new FakeMedia();
  const controller = createLatestSeekController(media);

  controller.preview(1);
  controller.preview(2);
  controller.jump(4.5);
  media.settle();

  assert.deepEqual(media.assignments, [1, 4.5]);
  controller.dispose();
});
