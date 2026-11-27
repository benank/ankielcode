import { useGT } from "gt-react";

import { cn } from "~/lib/utils";

export function GhostBar({ className }: { className?: string | undefined }) {
  return <span aria-hidden className={cn("block h-3 rounded bg-muted-foreground/15", className)} />;
}

const TITLE_WIDTHS = ["w-3/5", "w-2/5", "w-1/2", "w-2/3", "w-2/5", "w-3/5", "w-1/2"];
const META_WIDTHS = ["w-2/5", "w-1/3", "w-2/5", "w-1/4", "w-1/3", "w-2/5", "w-1/3"];

export function PullRequestListGhost({ rows = 7, caption }: { rows?: number; caption?: string }) {
  const gt = useGT();
  return (
    <div role="status" aria-label={caption ?? gt("Loading issues")} className="space-y-0.5">
      {/* Outside the pulse so the explanation stays readable. */}
      {caption ? (
        <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">{caption}</p>
      ) : null}
      <div className="motion-safe:animate-skeleton space-y-0.5">
        {Array.from({ length: rows }, (_, index) => (
          <div
            key={index}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-3 py-2.5"
          >
            <GhostBar className="size-4 rounded-full" />
            <div className="min-w-0 space-y-1.5">
              <GhostBar className={cn("h-4", TITLE_WIDTHS[index % TITLE_WIDTHS.length])} />
              <GhostBar className={cn("h-3.5", META_WIDTHS[index % META_WIDTHS.length])} />
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <GhostBar className="w-12" />
              <GhostBar className="w-16" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PullRequestPeopleGhost({ rows = 4 }: { rows?: number }) {
  const gt = useGT();
  return (
    <div
      role="status"
      aria-label={gt("Loading people")}
      className="motion-safe:animate-skeleton space-y-1 p-1"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-7 items-center gap-2 rounded-md px-2">
          <GhostBar className="size-4 rounded-full" />
          <GhostBar className={META_WIDTHS[index % META_WIDTHS.length]} />
        </div>
      ))}
    </div>
  );
}
