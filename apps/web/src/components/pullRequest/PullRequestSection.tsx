import { ChevronRightIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

const STICKY_EDGE_TOLERANCE_PX = 1;

/** Where to scroll so a collapsing section's pinned heading stays in place, or null to stay. */
function sectionCollapseAnchorScrollTop(input: {
  readonly scrollTop: number;
  readonly viewportTop: number;
  readonly sectionTop: number;
  readonly headingTop: number;
}): number | null {
  const sectionHasScrolledPastViewport = input.sectionTop < input.viewportTop;
  const headingIsPinned = input.headingTop <= input.viewportTop + STICKY_EDGE_TOLERANCE_PX;
  if (!sectionHasScrolledPastViewport || !headingIsPinned) return null;

  return Math.max(0, input.scrollTop + input.sectionTop - input.viewportTop);
}

export function PullRequestMetaRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-7 min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 text-xs sm:min-h-6">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="min-w-0 text-foreground">{children}</span>
    </div>
  );
}

export function PullRequestSection({
  title,
  name,
  defaultOpen = true,
  keepMounted = false,
  revealCount = 0,
  actions,
  children,
}: {
  title: string;
  /** Stable key for links that reveal this section, since the title is translated. */
  name?: string;
  defaultOpen?: boolean;
  keepMounted?: boolean;
  /** Reopens the section each time a link reveals it. */
  revealCount?: number;
  actions?: ReactNode;
  children: ReactNode;
}) {
  // A reveal opens at once: the opening animation would move what was just scrolled to.
  const [open, setOpen] = useState<boolean | "revealed">(
    revealCount > 0 ? "revealed" : defaultOpen,
  );
  const [seenRevealCount, setSeenRevealCount] = useState(revealCount);
  if (revealCount !== seenRevealCount) {
    setSeenRevealCount(revealCount);
    setOpen("revealed");
  }
  const headingRef = useRef<HTMLDivElement>(null);
  const setOpenWithScrollAnchor = (nextOpen: boolean) => {
    if (!nextOpen) {
      const heading = headingRef.current;
      const section = heading?.closest<HTMLElement>("[data-pull-request-summary-section]");
      const scroller = heading?.closest<HTMLElement>("[data-pull-request-summary-scroll]");
      if (heading && section && scroller) {
        const target = sectionCollapseAnchorScrollTop({
          scrollTop: scroller.scrollTop,
          viewportTop: scroller.getBoundingClientRect().top,
          sectionTop: section.getBoundingClientRect().top,
          headingTop: heading.getBoundingClientRect().top,
        });
        // Adjust before paint to keep the collapsed heading in place.
        if (target !== null) scroller.scrollTop = target;
      }
    }
    setOpen(nextOpen);
  };
  return (
    <Collapsible
      open={open !== false}
      onOpenChange={setOpenWithScrollAnchor}
      render={<section aria-label={title} />}
      data-pull-request-summary-section={name ?? ""}
    >
      <div
        ref={headingRef}
        className="sticky top-0 z-10 flex w-full items-center bg-background pr-4"
      >
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 px-4 py-3 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
          <span>{title}</span>
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground/60 transition-transform",
              open && "rotate-90",
            )}
          />
        </CollapsibleTrigger>
        {actions}
      </div>
      <CollapsiblePanel keepMounted={keepMounted} animate={open !== "revealed"}>
        <div className="px-4 pb-4">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
