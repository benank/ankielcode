import {
  PIXEL_ANIMATIONS,
  PIXEL_GRID_PATH,
  PIXEL_LEVEL_OPACITY,
  PIXEL_STATUS_BOX as BOX,
  PIXEL_STATUS_PITCH as PITCH,
  pixelSpriteStrip,
  type PixelStatusKind,
  type PixelStatusTone,
} from "@ankielcode/shared/pixelStatus";
import { useId, type CSSProperties } from "react";

import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";

export type { PixelStatusKind };

/** The one color per status tone; dots, icons and lights that show a state all read from here. */
export const STATUS_TONE_TEXT_CLASS: Record<PixelStatusTone, string> = {
  active: "text-signal-active",
  attention: "text-warning",
  failed: "text-destructive",
  done: "text-muted-foreground",
};

export const STATUS_TONE_DOT_CLASS: Record<PixelStatusTone, string> = {
  active: "bg-signal-active",
  attention: "bg-warning",
  failed: "bg-destructive",
  done: "bg-muted-foreground/60",
};

/**
 * A small glowing dot-matrix that animates a thread's state. The glow is baked into a
 * sprite strip that slides by whole frames, so playing it repaints nothing.
 */
export function PixelStatus(props: { kind: PixelStatusKind; className?: string }) {
  const filterId = `pixel-glow-${useId().replace(/[^\w-]/g, "")}`;
  const animation = PIXEL_ANIMATIONS[props.kind];
  const strip = pixelSpriteStrip(props.kind);
  const animated = animation.frames.length > 1;
  const lastFrameY = -(animation.frames.length - 1) * PITCH;
  const style = {
    "--pixel-frames": animation.frames.length,
    "--pixel-duration": `${animation.durationMs}ms`,
    "--pixel-iterations": String(animation.iterations),
    "--pixel-end": `${lastFrameY}px`,
    "--pixel-rest": animation.iterations === "infinite" ? "0px" : `${lastFrameY}px`,
  } as CSSProperties;
  return (
    <span
      aria-hidden
      data-pixel-status={props.kind}
      className={cn(
        "relative inline-block size-4 shrink-0 overflow-hidden",
        STATUS_TONE_TEXT_CLASS[animation.tone],
        animation.dim && "opacity-80",
        props.className,
      )}
    >
      <svg
        width={BOX}
        height={BOX}
        viewBox={`0 0 ${BOX} ${BOX}`}
        className="absolute top-0 left-0 opacity-15"
      >
        <path d={PIXEL_GRID_PATH} fill="currentColor" />
      </svg>
      <svg
        // Keyed so a kind change restarts the strip from its first frame.
        key={props.kind}
        ref={animated ? observeVisibleAnimation : undefined}
        width={BOX}
        height={strip.height}
        viewBox={`0 0 ${BOX} ${strip.height}`}
        style={style}
        className={cn("absolute top-0 left-0 overflow-visible", animated && "pixel-status-strip")}
      >
        <defs>
          <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g filter={`url(#${filterId})`}>
          {strip.paths.map(([level, d]) => (
            <path key={level} d={d} fill="currentColor" fillOpacity={PIXEL_LEVEL_OPACITY[level]} />
          ))}
        </g>
      </svg>
    </span>
  );
}
