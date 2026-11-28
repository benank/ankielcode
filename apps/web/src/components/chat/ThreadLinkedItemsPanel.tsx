import type { ScopedThreadRef } from "@ankielcode/contracts";
import { T, useGT } from "gt-react";

import { useServerConfigs, useThreadShell } from "~/state/entities";
import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";
import { ThreadDetailsIssueRows } from "./ThreadDetailsIssueRows";

/** The issues linked to a thread. */
export function ThreadLinkedItemsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const configs = useServerConfigs();
  const thread = useThreadShell(threadRef);
  if (configs.get(threadRef.environmentId) === undefined) {
    return (
      <PullRequestsUnavailableState
        title={gt("Linked items unavailable")}
        error={gt("The thread's environment is not available.")}
      />
    );
  }
  const issues = thread?.issues ?? [];
  if (issues.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        <T>No linked issues</T>
      </div>
    );
  }
  return (
    <section
      aria-label={gt("Linked issues")}
      className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain p-1.5"
    >
      <ThreadDetailsIssueRows
        links={issues}
        threadRef={threadRef}
        compact={false}
        mountScope="linked-items"
      />
    </section>
  );
}
