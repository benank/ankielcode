import type {
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItemStatus,
  OrchestrationProjectShell,
  ServerProvider,
  ProviderDriverKind,
  ProviderInstanceId,
  OrchestrationV2Subagent,
} from "@ankielcode/contracts";
import {
  resolveSubagentMetadata,
  subagentDetailPreview,
} from "@ankielcode/client-runtime/state/subagent-display";
import { readSelectedEffortValue } from "@ankielcode/client-runtime/state/thread-execution";
import { resolveSelectableModel } from "@ankielcode/shared/model";
import { getTraitsSpeedDisplay, TraitsSpeedIcon } from "./TraitsSpeed";
import { useMessages } from "gt-react";
import type { ReactNode } from "react";
import {
  BotIcon,
  CheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  FolderIcon,
  GitBranchIcon,
  TerminalIcon,
} from "lucide-react";
import { ThreadHoverCard } from "../ThreadHoverCard";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { STATUS_TONE_TEXT_CLASS } from "../PixelStatus";
import {
  threadRelationshipStatusLabel,
  threadRelationshipStatusTone,
} from "./ThreadRelationshipIcon";
import { cn } from "~/lib/utils";
import { deriveProviderInstanceEntries, shouldShowInstanceBadge } from "../../providerInstances";

export function SubagentTooltipContent(props: {
  title: string;
  model: string | null;
  providerInstanceId: ProviderInstanceId;
  origin: OrchestrationV2Subagent["origin"];
  modelSelection?: OrchestrationV2Subagent["modelSelection"];
  provider?: ServerProvider | undefined;
  providers?: ReadonlyArray<ServerProvider> | undefined;
  driver?: ProviderDriverKind | undefined;
  elapsed?: ReactNode;
  parentThread?: Pick<OrchestrationV2ThreadShell, "projectId" | "worktreePath"> | undefined;
  childThread?:
    | Pick<OrchestrationV2ThreadShell, "branch" | "worktreePath" | "modelSelection">
    | undefined;
  parentProject?: Pick<OrchestrationProjectShell, "workspaceRoot"> | undefined;
  childProject?: Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot"> | undefined;
  status: OrchestrationV2TurnItemStatus;
  result?: string | null | undefined;
  progress?: string | null | undefined;
}) {
  const messages = useMessages();
  const childSelection =
    props.modelSelection ??
    (props.origin === "app_owned" ? props.childThread?.modelSelection : undefined);
  const {
    modelLabel,
    modelSlug,
    workspace: metadata,
  } = resolveSubagentMetadata({ ...props, modelSelection: childSelection }, messages);
  const hasProjectRow =
    props.parentThread !== undefined &&
    props.childProject !== undefined &&
    props.childProject.id !== props.parentThread.projectId;
  const preview = subagentDetailPreview(props);
  const providerModel = props.provider?.models.find((candidate) => candidate.slug === modelSlug);
  const childModel = props.provider
    ? (resolveSelectableModel(
        props.provider.driver,
        childSelection?.model,
        props.provider.models,
      ) ?? childSelection?.model.trim())
    : childSelection?.model.trim();
  const provider = props.provider;
  const matchingSelection =
    childModel === modelSlug && childSelection?.instanceId === props.providerInstanceId
      ? childSelection
      : undefined;
  const effort = readSelectedEffortValue(
    matchingSelection,
    providerModel?.capabilities?.optionDescriptors,
  );
  const speed = provider
    ? providerModel?.capabilities?.optionDescriptors
        ?.map((descriptor) => {
          const saved = matchingSelection?.options?.find((option) => option.id === descriptor.id);
          if (
            descriptor.id === "fastMode" &&
            descriptor.type === "boolean" &&
            typeof saved?.value === "boolean"
          ) {
            return getTraitsSpeedDisplay(
              {
                ...descriptor,
                currentValue: saved.value,
              },
              messages,
            );
          }
          if (
            descriptor.id === "serviceTier" &&
            descriptor.type === "select" &&
            typeof saved?.value === "string" &&
            descriptor.options.some((option) => option.id === saved.value)
          ) {
            return getTraitsSpeedDisplay(
              {
                ...descriptor,
                currentValue: saved.value,
              },
              messages,
            );
          }
          return null;
        })
        .find(Boolean)
    : undefined;
  const driver = props.provider?.driver ?? props.driver;
  const entries = deriveProviderInstanceEntries(props.providers ?? []);
  const entry = entries.find((candidate) => candidate.instanceId === props.provider?.instanceId);
  const showInstanceBadge = entry !== undefined && shouldShowInstanceBadge(entry, entries);
  const tone = threadRelationshipStatusTone(props.status);
  const StatusIcon =
    tone === "failed" ? CircleXIcon : props.status === "completed" ? CheckIcon : CircleDashedIcon;
  return (
    <ThreadHoverCard title={props.title}>
      <div className="flex min-w-0 items-center gap-2">
        {driver ? (
          <ProviderInstanceIcon
            driverKind={driver}
            displayName={entry?.displayName ?? props.provider?.displayName ?? driver}
            accentColor={entry?.accentColor}
            acpRegistryIconUrl={props.provider?.iconUrl}
            showBadge={showInstanceBadge && entry?.accentColor !== undefined}
            badgeContent="none"
            badgeClassName="h-2 min-w-2 px-0"
            iconClassName="size-3 shrink-0 opacity-60"
          />
        ) : (
          <BotIcon className="size-3 shrink-0" />
        )}
        <span className="inline-flex min-w-0 items-center gap-1 text-foreground/75">
          <span className="min-w-0 truncate">
            {showInstanceBadge ? `${modelLabel} · ${entry.displayName}` : modelLabel}
          </span>
          {effort || speed?.speedIcon ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              {effort ? " · " : null}
              {speed?.speedIcon ? <TraitsSpeedIcon speedIcon={speed.speedIcon} size="xs" /> : null}
              {effort}
            </span>
          ) : null}
        </span>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-4">
        <span className="inline-flex items-center gap-1 font-medium">
          <StatusIcon aria-hidden className={cn("size-3 shrink-0", STATUS_TONE_TEXT_CLASS[tone])} />
          {threadRelationshipStatusLabel(props.status, messages)}
        </span>
        {props.elapsed}
      </div>
      {metadata.map(({ label, value }, index) => {
        const Icon =
          props.childThread?.branch && !(hasProjectRow && index === 0) ? GitBranchIcon : FolderIcon;
        return (
          <div key={label} className="flex min-w-0 items-center gap-2">
            <Icon aria-hidden className="size-3 shrink-0" />
            <span className="sr-only">{label}</span>
            <MiddleTruncate value={value} className="flex" showTitle={false} />
          </div>
        );
      })}
      {preview ? (
        <div className="flex min-w-0 items-center gap-2">
          <TerminalIcon aria-hidden className="size-3 shrink-0" />
          <MiddleTruncate value={preview} className="flex" showTitle={false} />
        </div>
      ) : null}
    </ThreadHoverCard>
  );
}
