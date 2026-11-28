import { useSyncExternalStore } from "react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import type { ThreadRouteTarget } from "../threadRoutes";
import { ComposerSurface } from "./chat/ComposerSurface";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

type ThreadRouteViewModule = typeof import("./ThreadRouteView");
type ThreadRouteViewLoad =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly module: ThreadRouteViewModule }
  | { readonly status: "failed"; readonly error: unknown };

let load: ThreadRouteViewLoad = { status: "loading" };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

const settle = (next: ThreadRouteViewLoad) => {
  load = next;
  for (const listener of listeners) listener();
};

// The thread view is most of the renderer's code. Loading it apart from the route lets the
// sidebar and this placeholder paint while it downloads and parses, instead of the boot splash.
export function preloadThreadRouteView(): Promise<void> {
  loading ??= import("./ThreadRouteView").then(
    (module) => settle({ status: "loaded", module }),
    (error: unknown) => settle({ status: "failed", error }),
  );
  return loading;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  void preloadThreadRouteView();
  return () => {
    listeners.delete(listener);
  };
}

const readLoad = () => load;

// Not React.lazy: a Suspense boundary here would also catch every later suspension inside the
// mounted thread view, and hiding then revealing it re-runs layout effects the composer can't survive.
export function LazyThreadRouteView(props: {
  readonly target: ThreadRouteTarget;
  readonly background: boolean;
}) {
  const state = useSyncExternalStore(subscribe, readLoad, readLoad);
  if (state.status === "failed") throw state.error;
  if (state.status === "loading") {
    return (
      <ThreadRoutePlaceholder draft={props.target.kind === "draft"} background={props.background} />
    );
  }
  const { ThreadRouteView } = state.module;
  return <ThreadRouteView target={props.target} background={props.background} />;
}

/** Static: same frame, header height and composer slot as ChatView, so its arrival doesn't shift. */
function ThreadRoutePlaceholder(props: { readonly draft: boolean; readonly background: boolean }) {
  return (
    <SidebarInset
      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
      inert={props.background}
      aria-busy
      data-thread-route-placeholder
    >
      <WorkspacePageHeader electron={isElectron} />
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          // Drafts open in the centred hero layout; short windows pin it to the bottom.
          props.draft ? "justify-center [@media(max-height:34rem)]:justify-end" : "justify-end",
        )}
      >
        <div className="chat-composer-lane w-full">
          <ComposerSurface.Shell contextRow={props.draft}>
            <ComposerSurface.Host>
              <div className="p-px">
                <div className="px-4 pt-3.5 pb-2 sm:pt-4">
                  <div className="h-[2lh] text-(length:--font-size-prompt,var(--text-sm)) leading-relaxed" />
                </div>
                <div className="h-10" />
              </div>
            </ComposerSurface.Host>
            {/* A draft always shows the context strip under its card. */}
            {props.draft ? <div className="h-9 sm:h-8" /> : null}
          </ComposerSurface.Shell>
          <div className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]" />
        </div>
      </div>
    </SidebarInset>
  );
}
