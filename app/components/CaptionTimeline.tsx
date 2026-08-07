"use client";

import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

export type TimelineCue = {
  id: string;
  start: number;
  end: number;
  text: string;
};

type DragState = {
  cueId: string;
  mode: "start" | "move" | "end";
  pointerId: number;
  originX: number;
  originStart: number;
  originEnd: number;
  start: number;
  end: number;
};

type CaptionTimelineProps = {
  cues: TimelineCue[];
  duration: number;
  currentTime: number;
  selectedCueId: string;
  onSelect: (cueId: string, time: number) => void;
  onChange: (cueId: string, start: number, end: number) => void;
};

const pixelsPerSecond = 24;
const minimumCueDuration = 0.18;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function CaptionTimelineComponent({
  cues,
  duration,
  currentTime,
  selectedCueId,
  onSelect,
  onChange,
}: CaptionTimelineProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const safeDuration = Math.max(
    1,
    duration,
    cues.at(-1)?.end ?? 0,
  );
  const trackWidth = Math.max(520, safeDuration * pixelsPerSecond);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [selectedCueId]);

  const startDrag = (
    event: ReactPointerEvent<HTMLElement>,
    cue: TimelineCue,
    mode: DragState["mode"],
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect(cue.id, cue.start);
    setDrag({
      cueId: cue.id,
      mode,
      pointerId: event.pointerId,
      originX: event.clientX,
      originStart: cue.start,
      originEnd: cue.end,
      start: cue.start,
      end: cue.end,
    });
  };

  const continueDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const track = trackRef.current;
    if (!track) return;
    const secondsPerPixel = safeDuration / track.getBoundingClientRect().width;
    const delta = (event.clientX - drag.originX) * secondsPerPixel;
    const cueIndex = cues.findIndex((cue) => cue.id === drag.cueId);
    const previousEnd = cues[cueIndex - 1]?.end ?? 0;
    const nextStart = cues[cueIndex + 1]?.start ?? safeDuration;
    let start = drag.originStart;
    let end = drag.originEnd;

    if (drag.mode === "move") {
      const cueDuration = drag.originEnd - drag.originStart;
      start = clamp(
        drag.originStart + delta,
        previousEnd,
        Math.max(previousEnd, nextStart - cueDuration),
      );
      end = start + cueDuration;
    } else if (drag.mode === "start") {
      start = clamp(
        drag.originStart + delta,
        previousEnd,
        drag.originEnd - minimumCueDuration,
      );
    } else {
      end = clamp(
        drag.originEnd + delta,
        drag.originStart + minimumCueDuration,
        nextStart,
      );
    }

    setDrag((current) =>
      current
        ? {
            ...current,
            start: Number(start.toFixed(3)),
            end: Number(end.toFixed(3)),
          }
        : null,
    );
  };

  const finishDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (
      Math.abs(drag.start - drag.originStart) > 0.005 ||
      Math.abs(drag.end - drag.originEnd) > 0.005
    ) {
      onChange(drag.cueId, drag.start, drag.end);
    }
    setDrag(null);
  };

  const nudgeEdge = (
    cue: TimelineCue,
    edge: "start" | "end",
    delta: number,
  ) => {
    const cueIndex = cues.findIndex((item) => item.id === cue.id);
    const previousEnd = cues[cueIndex - 1]?.end ?? 0;
    const nextStart = cues[cueIndex + 1]?.start ?? safeDuration;
    const nextStartEdge =
      edge === "start"
        ? clamp(cue.start + delta, previousEnd, cue.end - minimumCueDuration)
        : cue.start;
    const nextEndEdge =
      edge === "end"
        ? clamp(cue.end + delta, cue.start + minimumCueDuration, nextStart)
        : cue.end;
    onChange(cue.id, nextStartEdge, nextEndEdge);
  };

  return (
    <section className="caption-timeline" aria-label="Caption timeline">
      <div className="timeline-label">
        <span>Caption timing</span>
        <small>Drag a line or either edge</small>
      </div>
      <div className="timeline-viewport" ref={viewportRef}>
        <div
          className="timeline-track"
          ref={trackRef}
          style={{ width: trackWidth } as CSSProperties}
        >
          <div className="timeline-baseline" aria-hidden="true" />
          {cues.map((cue, cueIndex) => {
            const activeDrag = drag?.cueId === cue.id ? drag : null;
            const start = activeDrag?.start ?? cue.start;
            const end = activeDrag?.end ?? cue.end;
            const left = (start / safeDuration) * trackWidth;
            const width = Math.max(34, ((end - start) / safeDuration) * trackWidth);
            const selected = cue.id === selectedCueId;

            return (
              <div
                key={cue.id}
                ref={selected ? selectedRef : undefined}
                className={`timeline-cue ${selected ? "selected" : ""} ${
                  activeDrag ? "dragging" : ""
                }`}
                style={{ left, width } as CSSProperties}
                role="group"
                aria-label={`Caption ${cueIndex + 1}: ${cue.text}`}
              >
                <span
                  className="timeline-handle start"
                  role="slider"
                  tabIndex={selected ? 0 : -1}
                  aria-label="Caption start"
                  aria-valuemin={0}
                  aria-valuemax={cue.end}
                  aria-valuenow={start}
                  onPointerDown={(event) => startDrag(event, cue, "start")}
                  onPointerMove={continueDrag}
                  onPointerUp={finishDrag}
                  onPointerCancel={finishDrag}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                      event.preventDefault();
                      nudgeEdge(cue, "start", event.key === "ArrowLeft" ? -0.05 : 0.05);
                    }
                  }}
                />
                <button
                  type="button"
                  className="timeline-cue-body"
                  onClick={() => onSelect(cue.id, cue.start)}
                  onPointerDown={(event) => startDrag(event, cue, "move")}
                  onPointerMove={continueDrag}
                  onPointerUp={finishDrag}
                  onPointerCancel={finishDrag}
                >
                  <b>{String(cueIndex + 1).padStart(2, "0")}</b>
                  <span>{cue.text}</span>
                </button>
                <span
                  className="timeline-handle end"
                  role="slider"
                  tabIndex={selected ? 0 : -1}
                  aria-label="Caption end"
                  aria-valuemin={cue.start}
                  aria-valuemax={safeDuration}
                  aria-valuenow={end}
                  onPointerDown={(event) => startDrag(event, cue, "end")}
                  onPointerMove={continueDrag}
                  onPointerUp={finishDrag}
                  onPointerCancel={finishDrag}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                      event.preventDefault();
                      nudgeEdge(cue, "end", event.key === "ArrowLeft" ? -0.05 : 0.05);
                    }
                  }}
                />
              </div>
            );
          })}
          <div
            className="timeline-current"
            style={{ left: (clamp(currentTime, 0, safeDuration) / safeDuration) * trackWidth }}
            aria-hidden="true"
          />
        </div>
      </div>
    </section>
  );
}

export const CaptionTimeline = memo(CaptionTimelineComponent);
