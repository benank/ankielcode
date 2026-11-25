import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@ankielcode/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { memo } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { Button, InlineButton } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ComposerPendingApprovalActionsProps {
  presentation?: "composer" | "inline";
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
  {
    decision: "cancel",
    label: msg("Cancel", { $context: "verb, response to an approval request" }),
  },
] satisfies ReadonlyArray<ProviderApprovalOption>;

function composerOptionVariant(decision: ProviderApprovalDecision) {
  if (decision === "accept") return "default" as const;
  if (decision === "decline") return "destructive-outline" as const;
  if (decision === "cancel") return "ghost-muted" as const;
  return "outline" as const;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  presentation = "composer",
  requestId,
  isResponding,
  canRespond,
  disabled = false,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const gt = useGT();
  const m = useMessages();
  // Provider options carry server-authored labels; only the built-in defaults are translated.
  const optionLabel = (label: string) => (options === DEFAULT_APPROVAL_OPTIONS ? m(label) : label);

  if (presentation === "composer") {
    return (
      <>
        {options.map((option) => {
          const button = (
            <Button
              key={option.decision}
              disabled={disabled || isResponding || !canRespond}
              aria-description={option.warning}
              size="sm"
              variant={composerOptionVariant(option.decision)}
              onClick={() => {
                if (!disabled && !isResponding && canRespond) {
                  void onRespondToApproval(requestId, option.decision);
                }
              }}
            >
              {option.warning ? <TriangleAlertIcon className="size-3.5 shrink-0" /> : null}
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
        })}
      </>
    );
  }

  const primaryOptions = options.filter(
    (option) => option.decision === "decline" || option.decision === "accept",
  );
  const moreOptions = options.filter(
    (option) => option.decision !== "decline" && option.decision !== "accept",
  );

  return (
    <>
      {primaryOptions.map((option) => {
        const buttonProps = {
          disabled: disabled || isResponding || !canRespond,
          "aria-description": option.warning,
          onClick: () => {
            if (!disabled && !isResponding && canRespond) {
              void onRespondToApproval(requestId, option.decision);
            }
          },
        };
        const content = (
          <>
            {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
            <span className="whitespace-normal">{optionLabel(option.label)}</span>
          </>
        );
        const button = (
          <InlineButton
            key={option.decision}
            {...buttonProps}
            tone={option.decision === "accept" ? "default" : "muted"}
          >
            {content}
          </InlineButton>
        );
        return option.warning ? (
          <Tooltip key={option.decision}>
            <TooltipTrigger render={button} />
            <TooltipPopup side="top">{option.warning}</TooltipPopup>
          </Tooltip>
        ) : (
          button
        );
      })}
      {moreOptions.length > 0 ? (
        <Menu>
          <MenuTrigger
            disabled={disabled || isResponding || !canRespond}
            render={<InlineButton tone="muted" aria-label={gt("More approval options")} />}
          >
            {gt("More", { $context: "button that opens more approval options" })}
          </MenuTrigger>
          <MenuPopup {...composerFloatingLayerProps} side="top" align="end" width="content">
            {moreOptions.map((option) => {
              const item = (
                <MenuItem
                  key={option.decision}
                  disabled={disabled || isResponding || !canRespond}
                  aria-description={option.warning}
                  onClick={() => {
                    if (!disabled && !isResponding && canRespond)
                      void onRespondToApproval(requestId, option.decision);
                  }}
                >
                  {option.warning ? <TriangleAlertIcon className="size-3 text-warning" /> : null}
                  <span className="min-w-0 whitespace-normal wrap-break-word">
                    {optionLabel(option.label)}
                  </span>
                </MenuItem>
              );
              return option.warning ? (
                <Tooltip key={option.decision}>
                  <TooltipTrigger render={item} />
                  <TooltipPopup side="top">{option.warning}</TooltipPopup>
                </Tooltip>
              ) : (
                item
              );
            })}
          </MenuPopup>
        </Menu>
      ) : null}
    </>
  );
});
