import { type ProviderApprovalDecision, type RuntimeRequestId } from "@ankielcode/contracts";
import {
  APPROVAL_REQUEST_LABEL,
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@ankielcode/client-runtime/state/thread-requests";
import { msg, T, useMessages } from "gt-react";
import { TriangleAlertIcon } from "lucide-react";
import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { PixelStatus } from "../PixelStatus";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { composerFloatingLayerProps } from "./composerEventScope";
import { cn } from "~/lib/utils";

const APPROVAL_DETAIL_LABEL = {
  command: msg("Command", { $context: "noun, shell command awaiting approval" }),
  "file-change": msg("File change"),
  "file-read": msg("File to read"),
  permission: msg("Permission request"),
  "mcp-elicitation": msg("App access request"),
} satisfies Record<PendingApproval["requestKind"], string>;

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  disabled?: boolean;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  className?: string;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  disabled = false,
  isResponding,
  onRespondToApproval,
  className,
}: ComposerPendingApprovalPanelProps) {
  const m = useMessages();
  const label = m(APPROVAL_REQUEST_LABEL[approval.requestKind]);
  const canRespond = approval.responseCapability === "live";
  const Detail = approval.requestKind === "mcp-elicitation" ? "span" : "code";
  const warning = approval.options?.find((option) => option.warning)?.warning;

  return (
    <div
      aria-label={label}
      className={cn("flex min-w-0 flex-1 flex-col gap-3", className)}
      role="group"
      data-approval-popup="true"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <PixelStatus kind="attention" />
        <span className="text-sm font-medium text-foreground">{label}</span>
        {approval.appName ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{approval.appName}</span>
        ) : null}
        {approval.fullAccessOverride ? (
          <Popover>
            <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
              {m(FULL_ACCESS_OVERRIDE_QUESTION)}
            </PopoverTrigger>
            <PopoverPopup
              {...composerFloatingLayerProps}
              aria-label={m(FULL_ACCESS_OVERRIDE_QUESTION)}
              tooltipStyle
              side="top"
              className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
            >
              {fullAccessOverrideExplanation(approval.fullAccessOverride, m)}
            </PopoverPopup>
          </Popover>
        ) : null}
        {pendingCount > 1 ? (
          <span className="ms-auto shrink-0 text-xs font-medium text-muted-foreground tabular-nums">
            1/{pendingCount}
          </span>
        ) : null}
      </div>

      <Detail
        aria-label={m(APPROVAL_DETAIL_LABEL[approval.requestKind])}
        className={cn(
          "block w-full min-w-0 overflow-auto rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-xs leading-5 text-foreground select-text [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
          approval.requestKind === "mcp-elicitation"
            ? "max-h-24 whitespace-pre-wrap font-sans wrap-break-word"
            : "max-h-40 whitespace-pre-wrap font-mono wrap-anywhere",
        )}
        data-approval-detail="complete"
        tabIndex={0}
      >
        {approval.detail || label}
      </Detail>

      {approval.reason ? (
        <p className="w-full min-w-0 text-xs leading-5 text-muted-foreground select-text wrap-anywhere">
          {approval.reason}
        </p>
      ) : null}

      {warning ? (
        <p className="flex items-start gap-1.5 text-xs leading-5 text-muted-foreground wrap-anywhere">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>{warning}</span>
        </p>
      ) : null}

      {!canRespond ? (
        <p className="text-xs leading-5 text-muted-foreground">
          <T>Provider process is gone. Interrupt or restart the run to respond.</T>
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <ComposerPendingApprovalActions
            requestId={approval.requestId}
            disabled={disabled}
            isResponding={isResponding}
            canRespond={canRespond}
            options={approval.options}
            onRespondToApproval={onRespondToApproval}
          />
        </div>
      )}
    </div>
  );
});
