import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@ankielcode/contracts";
import { msg, useMessages } from "gt-react";
import { memo } from "react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ComposerPendingApprovalActionsProps {
  requestId: RuntimeRequestId;
  isResponding: boolean;
  canRespond: boolean;
  disabled?: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

// Stop already sits beside the panel, so the defaults leave out "cancel" (decline and stop).
const DEFAULT_APPROVAL_OPTIONS = [
  {
    decision: "accept",
    label: msg("Approve", { $context: "verb, response to an approval request" }),
  },
  { decision: "acceptForSession", label: msg("Always allow this session") },
  {
    decision: "decline",
    label: msg("Decline", { $context: "verb, response to an approval request" }),
  },
] satisfies ReadonlyArray<ProviderApprovalOption>;

function optionVariant(decision: ProviderApprovalDecision) {
  if (decision === "accept") return "default" as const;
  if (decision === "acceptForSession") return "outline" as const;
  return "ghost-muted" as const;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  canRespond,
  disabled = false,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const m = useMessages();
  // Provider options carry server-authored labels; only the built-in defaults are translated.
  const optionLabel = (label: string) => (options === DEFAULT_APPROVAL_OPTIONS ? m(label) : label);

  return options.map((option) => {
    const button = (
      <Button
        key={option.decision}
        disabled={disabled || isResponding || !canRespond}
        aria-description={option.warning}
        size="sm"
        variant={optionVariant(option.decision)}
        onClick={() => {
          if (!disabled && !isResponding && canRespond) {
            void onRespondToApproval(requestId, option.decision);
          }
        }}
      >
        <span className="max-w-56 truncate">{optionLabel(option.label)}</span>
      </Button>
    );
    return option.warning ? (
      <Tooltip key={option.decision}>
        <TooltipTrigger render={button} />
        <TooltipPopup {...composerFloatingLayerProps} side="top">
          {option.warning}
        </TooltipPopup>
      </Tooltip>
    ) : (
      button
    );
  });
});
