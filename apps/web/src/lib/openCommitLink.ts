import type { ScopedThreadRef } from "@ankielcode/contracts";
import { type MouseEvent } from "react";
import { msg } from "gt-react";

import { sourceControlClients } from "@ankielcode/client-runtime/source-control-clients";

import { canOpenLinksInApp } from "../browser/browserLinkTarget";
import { useOpenLink } from "../browser/useOpenLink";
import { useClientSettings } from "../hooks/useSettings";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import { useRightPanelStore } from "../rightPanelStore";
import {
  selectThreadBranchBaseRef,
  selectThreadDiffPanelSelection,
  useDiffPanelStore,
} from "../diffPanelStore";
import { readProject, readThreadShell } from "../state/entities";
import { reviewEnvironment } from "../state/review";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";

/** Opens a link to a commit of the thread's own repository in its diff panel. */
export function useOpenCommitLink(
  threadRef?: ScopedThreadRef,
): (
  event: Pick<
    MouseEvent<HTMLElement>,
    "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey"
  > &
    Partial<Pick<MouseEvent<HTMLElement>, "button" | "shiftKey" | "altKey">>,
  targetUrl: string,
  targetThreadRef?: ScopedThreadRef,
  onCommitUnavailable?: () => void,
) => boolean {
  const ignoreWhitespace = useClientSettings((settings) => settings.diffIgnoreWhitespace);
  const browserLinkTarget = useClientSettings((settings) => settings.browserLinkTarget);
  const readDiffPreview = useAtomQueryRunner(reviewEnvironment.diffPreview, {
    reportFailure: false,
    refresh: true,
  });
  const openLink = useOpenLink(threadRef);
  return (event, targetUrl, targetThreadRef, onCommitUnavailable) => {
    if (event.metaKey || event.ctrlKey || event.button === 1) return false;
    // Shift and Alt keep their browser meaning (new window, download) on commit links.
    if (event.shiftKey || event.altKey) return false;
    const resolvedThreadRef = targetThreadRef ?? threadRef;
    const commitThread = resolvedThreadRef ? readThreadShell(resolvedThreadRef) : null;
    const commitProject =
      commitThread && resolvedThreadRef
        ? readProject({
            environmentId: resolvedThreadRef.environmentId,
            projectId: commitThread.projectId,
          })
        : null;
    const identity = commitProject?.repositoryIdentity;
    const parsedCommit = sourceControlClients.parseCommitUrl(targetUrl, identity?.provider);
    if (
      parsedCommit === null ||
      !commitThread ||
      !resolvedThreadRef ||
      commitProject?.environmentId !== resolvedThreadRef.environmentId ||
      !identity ||
      identity.provider !== parsedCommit.definition.kind ||
      !parsedCommit.definition.isChangeRequestInRepository(identity, parsedCommit.link)
    ) {
      return false;
    }
    const commit = parsedCommit.link;
    event.preventDefault();
    event.stopPropagation();
    const userActionRevision = useRightPanelStore.getState().markUserAction(resolvedThreadRef);
    const baseRef = selectThreadBranchBaseRef(useDiffPanelStore.getState(), resolvedThreadRef);
    const selection = selectThreadDiffPanelSelection(
      useDiffPanelStore.getState().byThreadKey,
      resolvedThreadRef,
    );
    void readDiffPreview({
      environmentId: resolvedThreadRef.environmentId,
      input: {
        cwd: commitThread.worktreePath ?? commitProject.workspaceRoot,
        ...(baseRef ? { baseRef } : {}),
        commitSha: commit.sha,
        ignoreWhitespace,
      },
    })
      .then((result) => {
        if (
          useRightPanelStore.getState().getUserActionRevision(resolvedThreadRef) !==
            userActionRevision ||
          selectThreadDiffPanelSelection(
            useDiffPanelStore.getState().byThreadKey,
            resolvedThreadRef,
          ) !== selection
        )
          return;
        if (
          result._tag === "Success" &&
          result.value.sources.some(
            (source) => source.kind === "commit" && source.headRef === commit.sha,
          )
        ) {
          useDiffPanelStore.getState().selectCommit(resolvedThreadRef, commit.sha);
          useRightPanelStore.getState().open(resolvedThreadRef, "diff");
          return;
        }
        if (onCommitUnavailable) return onCommitUnavailable();
        // A popup opened after the lookup has lost the click's activation, so browsers block it.
        if (
          window.desktopBridge === undefined &&
          (browserLinkTarget !== "app" || !canOpenLinksInApp(resolvedThreadRef))
        ) {
          const toastId = toastManager.add(
            stackedThreadToast({
              type: "info",
              title: m(msg("This commit is not in the thread's workspace")),
              actionProps: {
                children: m(msg("Open link")),
                onClick: () => {
                  toastManager.close(toastId);
                  window.open(targetUrl, "_blank", "noopener,noreferrer");
                },
              },
            }),
          );
          return;
        }
        return openLink(targetUrl, {
          event: { metaKey: event.metaKey, ctrlKey: event.ctrlKey, button: event.button },
          threadRef: resolvedThreadRef,
        });
      })
      .catch((error: unknown) => console.error(error));
    return true;
  };
}
