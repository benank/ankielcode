import type { OrchestrationV2TurnItem } from "@ankielcode/contracts";
import { useGT } from "gt-react";
import { CheckIcon, MinusIcon, XIcon } from "lucide-react";

import { WorkLogRow } from "./WorkLog";

type LinkRequestItem = Extract<OrchestrationV2TurnItem, { type: "link_request" }>;

function linkRequestOutcome(item: LinkRequestItem, gt: ReturnType<typeof useGT>) {
  switch (item.linkStatus) {
    case "linked":
      return {
        Icon: CheckIcon,
        label:
          item.linkedLabel === undefined
            ? gt("Linked a machine")
            : gt("Linked {target}", { target: item.linkedLabel }),
      };
    case "declined":
      return { Icon: MinusIcon, label: gt("Declined") };
    case "failed":
      return {
        Icon: XIcon,
        label:
          item.failure === undefined
            ? gt("Could not link: the other environment refused")
            : gt("Could not link: {failure}", { failure: item.failure }),
      };
    case "pending":
    case "cancelled":
      return { Icon: MinusIcon, label: gt("Request ended") };
  }
}

/** A link request from an older thread. Linking environments is gone, so it is never actionable. */
export function LinkRequestCard({ item }: { readonly item: LinkRequestItem }) {
  const gt = useGT();
  const { Icon, label } = linkRequestOutcome(item, gt);
  return (
    <WorkLogRow
      data-v2-item-type={item.type}
      icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
      label={label}
    />
  );
}
