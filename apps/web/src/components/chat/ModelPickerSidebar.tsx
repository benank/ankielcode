import { Toolbar } from "@base-ui/react/toolbar";
import { type ProviderInstanceId } from "@ankielcode/contracts";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { msg, T, useMessages } from "gt-react";
import { StarIcon } from "lucide-react";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import type { MessageResolver } from "../../i18n/messages";
import {
  isProviderInstancePickerReady,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";

function describeUnavailableInstance(
  entry: ProviderInstanceEntry,
  resolve: MessageResolver,
): string {
  const label = entry.displayName;
  // An unavailable instance (a driver this build lacks or the policy leaves out) says why instead.
  if ((!entry.enabled && entry.isAvailable) || entry.status === "disabled") {
    return resolve(msg("{label}: Disabled in settings.", { label }));
  }
  if (entry.status === "ready" && entry.isAvailable) {
    return label;
  }
  const message = entry.snapshot.message?.trim();
  if (message) {
    return resolve(
      entry.status === "error"
        ? msg("{label}: Unavailable. {message}", { label, message })
        : entry.status === "warning"
          ? msg("{label}: Limited. {message}", { label, message })
          : msg("{label}: Not ready. {message}", { label, message }),
    );
  }
  return resolve(
    entry.status === "error"
      ? msg("{label}: Unavailable.", { label })
      : entry.status === "warning"
        ? msg("{label}: Limited.", { label })
        : msg("{label}: Not ready.", { label }),
  );
}

const PICKER_TOOLTIP_SIDE = "left" as const;
const PICKER_TOOLTIP_SIDE_OFFSET = 8;

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  selectedInstanceId: ProviderInstanceId | "favorites";
  onSelectInstance: (instanceId: ProviderInstanceId | "favorites") => void;
  onFocusModels: () => void;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  showFavorites?: boolean;
  horizontal?: boolean;
  disabledInstanceIds?: ReadonlySet<ProviderInstanceId>;
  selectableUnavailableInstanceIds?: ReadonlySet<ProviderInstanceId>;
  getDisabledInstanceTooltip?: (entry: ProviderInstanceEntry) => string;
}) {
  const m = useMessages();
  const handleSelect = (instanceId: ProviderInstanceId | "favorites") => {
    props.onSelectInstance(instanceId);
  };
  const showFavorites = props.showFavorites ?? true;
  const [hoveredInstanceId, setHoveredInstanceId] = useState<ProviderInstanceId | null>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const [selectedIndicatorTop, setSelectedIndicatorTop] = useState<number | null>(null);
  // oxlint-disable-next-line ankielcode/no-unreasoned-state-sync -- reads the selected provider item's DOM offset to position the selection indicator
  useLayoutEffect(() => {
    const content = sidebarContentRef.current;
    if (!content) {
      return;
    }
    const selectedItem = Array.from(
      content.querySelectorAll<HTMLElement>("[data-model-picker-provider]"),
    ).find((item) => item.dataset.modelPickerProvider === props.selectedInstanceId);
    if (!selectedItem) {
      setSelectedIndicatorTop(null);
      return;
    }
    if (props.horizontal) {
      const scroll = content.parentElement;
      if (!scroll) return;
      const left = selectedItem.offsetLeft;
      const right = left + selectedItem.offsetWidth;
      if (left < scroll.scrollLeft || right > scroll.scrollLeft + scroll.clientWidth) {
        scroll.scrollLeft = left;
      }
    } else {
      setSelectedIndicatorTop(selectedItem.offsetTop + selectedItem.offsetHeight / 2 - 10);
    }
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Adding, removing or reordering providers moves the selected item, so the indicator re-measures.
    props.instanceEntries,
    props.selectedInstanceId,
    showFavorites,
    props.horizontal,
  ]);

  const horizontal = props.horizontal;
  const itemClass = horizontal
    ? "flex h-9 cursor-pointer items-center gap-1.5 rounded-full px-3 text-sm text-muted-foreground outline-none hover:bg-foreground/8 focus-visible:bg-foreground/8 aria-pressed:bg-foreground/12 aria-pressed:text-foreground"
    : "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none";
  const tooltipSide = horizontal ? "top" : PICKER_TOOLTIP_SIDE;
  return (
    <Toolbar.Root
      className={
        horizontal
          ? "shrink-0 overflow-hidden border-b border-border/70"
          : "w-11 shrink-0 overflow-hidden bg-muted/30"
      }
      data-model-picker-sidebar="true"
      aria-label={m(msg("Providers"))}
      orientation={horizontal ? "horizontal" : "vertical"}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === (horizontal ? "ArrowDown" : "ArrowRight")) {
          event.preventDefault();
          props.onFocusModels();
          return;
        }
      }}
    >
      <div
        className={cn(
          "overscroll-contain",
          horizontal
            ? "overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
            : "h-full overflow-y-auto [scrollbar-width:none]",
        )}
      >
        <div
          ref={sidebarContentRef}
          className={cn(
            "relative flex gap-1 p-1",
            horizontal ? "w-max min-w-full" : "min-h-full flex-col",
          )}
        >
          {!horizontal && selectedIndicatorTop !== null ? (
            <div
              data-model-picker-selected-indicator="true"
              className="pointer-events-none absolute right-1 z-10 h-5 w-0.75 rounded-full bg-primary transition-[top] duration-200 ease-out"
              style={{ top: selectedIndicatorTop }}
            />
          ) : null}
          {showFavorites ? (
            <>
              <div
                className={horizontal ? "shrink-0" : "relative w-full"}
                data-model-picker-provider="favorites"
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Toolbar.Button
                        className={itemClass}
                        onClick={() => handleSelect("favorites")}
                        type="button"
                        aria-label={m(msg("Favorites"))}
                        aria-pressed={props.selectedInstanceId === "favorites"}
                      >
                        <StarIcon
                          className={cn("fill-current shrink-0", horizontal ? "size-4" : "size-5")}
                          aria-hidden
                        />
                      </Toolbar.Button>
                    }
                  />
                  <TooltipPopup
                    side={tooltipSide}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                  >
                    <T>Favorites</T>
                  </TooltipPopup>
                </Tooltip>
              </div>
              {!horizontal ? (
                <div className="border-b border-border/70" aria-hidden="true" />
              ) : null}
            </>
          ) : null}

          {props.instanceEntries.map((entry) => {
            const isUnavailable = !isProviderInstancePickerReady(entry);
            const isContextDisabled = props.disabledInstanceIds?.has(entry.instanceId) ?? false;
            const unavailableSelectionIsReachable =
              props.selectableUnavailableInstanceIds?.has(entry.instanceId) ?? false;
            const isDisabled =
              (isUnavailable && !unavailableSelectionIsReachable) || isContextDisabled;
            const isSelected = props.selectedInstanceId === entry.instanceId;
            const isHovered = hoveredInstanceId === entry.instanceId;
            const showInstanceBadge = shouldShowInstanceBadge(entry, props.instanceEntries);

            const tooltip = isUnavailable
              ? describeUnavailableInstance(entry, m)
              : isContextDisabled
                ? (props.getDisabledInstanceTooltip?.(entry) ?? entry.displayName)
                : entry.displayName;

            const button = (
              <Toolbar.Button
                className={cn(
                  itemClass,
                  isDisabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
                )}
                data-provider-accent-color={entry.accentColor}
                onClick={() => !isDisabled && handleSelect(entry.instanceId)}
                onMouseEnter={() => setHoveredInstanceId(entry.instanceId)}
                onMouseLeave={() =>
                  setHoveredInstanceId((current) => (current === entry.instanceId ? null : current))
                }
                onFocus={() => setHoveredInstanceId(entry.instanceId)}
                onBlur={() =>
                  setHoveredInstanceId((current) => (current === entry.instanceId ? null : current))
                }
                disabled={isDisabled}
                focusableWhenDisabled={!isDisabled}
                aria-pressed={isSelected}
                type="button"
                aria-label={isUnavailable || isContextDisabled ? tooltip : entry.displayName}
              >
                <ProviderInstanceIcon
                  driverKind={entry.driverKind}
                  displayName={entry.displayName}
                  accentColor={entry.accentColor}
                  acpRegistryAgentId={entry.acpRegistryAgentId}
                  acpRegistryIconUrl={entry.acpRegistryIconUrl}
                  showBadge={showInstanceBadge}
                  className={horizontal ? "size-4" : "size-6 z-30"}
                  iconClassName={horizontal ? "size-4" : "size-5"}
                  indicatorBackground={
                    isHovered && !isDisabled
                      ? "var(--muted)"
                      : isSelected
                        ? "var(--background)"
                        : "color-mix(in oklab, var(--muted) 30%, transparent)"
                  }
                  {...(entry.accentColor ? { badgeClassName: "h-3 min-w-3 px-0.5 text-5xs" } : {})}
                />
                {horizontal ? <span>{entry.displayName}</span> : null}
              </Toolbar.Button>
            );

            const trigger = isDisabled ? (
              <span className="relative block w-full">{button}</span>
            ) : (
              button
            );

            return (
              <div
                key={entry.instanceId}
                className={horizontal ? "shrink-0" : "relative w-full"}
                data-model-picker-provider={entry.instanceId}
              >
                <Tooltip>
                  <TooltipTrigger render={trigger} />
                  <TooltipPopup
                    side={tooltipSide}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                  >
                    {tooltip}
                  </TooltipPopup>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </div>
    </Toolbar.Root>
  );
});
