import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderInstanceId,
  type EnvironmentId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@ankielcode/contracts";
import { RegistryContext } from "@effect/atom-react";
import { T, useGT } from "gt-react";
import {
  createContext,
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { ModelPickerContent, resolveModelPickerSelectedModel } from "./ModelPickerContent";
import { retainedModelWhileProviderLocked } from "./ProviderModelPicker.logic";
import { ChatGptSharingControl } from "./ChatGptSharingControl";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ModelEsque, getDisplayModelName, getTriggerDisplayModelName } from "./providerIconUtils";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";
import { takeOpenTarget, useComposerMenuProps } from "./composerEventScope";
import { shortcutLabelForCommand } from "../../keybindings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/** Holds the page still behind the open picker; its lifetime is the popup element's. */
function lockBackgroundScroll(popup: HTMLElement | null) {
  if (!popup) return;
  const { documentElement, body } = document;
  const previousDocumentOverscrollBehavior = documentElement.style.overscrollBehavior;
  const previousBodyOverflow = body.style.overflow;
  const previousBodyPaddingRight = body.style.paddingRight;
  const scrollbarWidth = window.innerWidth - documentElement.clientWidth;

  documentElement.style.overscrollBehavior = "contain";
  body.style.overflow = "hidden";
  if (scrollbarWidth > 0) {
    body.style.paddingRight = `${scrollbarWidth}px`;
  }

  const shouldAllowOverlayScroll = (target: EventTarget | null) => {
    return (
      target instanceof Element &&
      target.closest(
        "[data-model-picker-content], [data-model-picker-effort], [data-model-picker-option-menu]",
      )
    );
  };
  const preventBackgroundWheel = (event: WheelEvent) => {
    if (shouldAllowOverlayScroll(event.target)) {
      return;
    }
    event.preventDefault();
  };
  const preventBackgroundTouchMove = (event: TouchEvent) => {
    if (shouldAllowOverlayScroll(event.target)) {
      return;
    }
    event.preventDefault();
  };

  document.addEventListener("wheel", preventBackgroundWheel, { capture: true, passive: false });
  document.addEventListener("touchmove", preventBackgroundTouchMove, {
    capture: true,
    passive: false,
  });

  return () => {
    document.removeEventListener("wheel", preventBackgroundWheel, { capture: true });
    document.removeEventListener("touchmove", preventBackgroundTouchMove, { capture: true });
    documentElement.style.overscrollBehavior = previousDocumentOverscrollBehavior;
    body.style.overflow = previousBodyOverflow;
    body.style.paddingRight = previousBodyPaddingRight;
  };
}

export const ComposerPickerCompactContext = createContext(false);

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  environmentId: EnvironmentId | null;
  workspaceCwd?: string | null;
  activeInstanceId: ProviderInstanceId;
  model: string;
  selectedModels?: ReadonlyArray<{ instanceId: ProviderInstanceId; model: string }>;
  onToggleModel?: (instanceId: ProviderInstanceId, model: string) => void;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  activeProviderIconClassName?: string;
  instanceIndicatorBackground?: string;
  size?: ComposerControlSize;
  compact?: boolean;
  isComposerOwned?: boolean;
  disabled?: boolean;
  terminalOpen?: boolean;
  open?: boolean;
  popupAlign?: "start" | "end";
  triggerClassName?: string;
  triggerLabel?: string;
  triggerAriaLabel?: string;
  onOpenChange?: (open: boolean) => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  /** Shown after the model name inside the same trigger, such as the effort level. */
  triggerSuffix?: ReactNode;
  /** Names the suffix for the tooltip and screen readers. */
  triggerDetail?: string | null;
  reasoningLevel?: string | null;
  leadingControl?: ReactNode;
  /** Composer shortcuts this trigger answers besides the picker's own. */
  triggerShortcuts?: string;
  effortControls?: ReactNode;
  footer?: ReactNode;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;
  const [compactMenu, setCompactMenu] = useState(false);
  const hasEffortControls = props.effortControls !== undefined;
  const registry = useContext(RegistryContext);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const refreshModelCatalog = useEffectEvent(() => {
    const environmentId = props.environmentId;
    if (environmentId === null) return;
    // An older server drops the field and probes every provider.
    const config = registry.get(serverEnvironment.configValueAtom(environmentId));
    if (config?.environment.capabilities.modelCatalogRefresh !== true) return;
    void refreshProviders({ environmentId, input: { modelCatalogOnly: true } });
  });
  // oxlint-disable-next-line ankielcode/no-unreasoned-state-sync -- asks the server for newly released models on every open; a parent, a keybinding or the palette can open the picker, so no one handler sees them all
  useEffect(() => {
    if (isMenuOpen && !compactMenu) refreshModelCatalog();
  }, [isMenuOpen, compactMenu]);
  const gt = useGT();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modelListFocusRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const menuHeaderRef = useRef<HTMLButtonElement>(null);
  // Touch opens on the popup itself so the on-screen keyboard stays down until the search is tapped.
  const isCoarsePointer = useMediaQuery({ pointer: "coarse" });
  const size = props.size ?? "sm";

  const activeEntry =
    props.instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null;

  const activeInstanceId = props.activeInstanceId;
  const selectedInstanceOptions = props.modelOptionsByInstance.get(activeInstanceId) ?? [];
  const selectedModel =
    resolveModelPickerSelectedModel({
      driverKind: activeEntry?.driverKind,
      model: props.model,
      options: selectedInstanceOptions,
    }) ??
    retainedModelWhileProviderLocked(activeEntry, props.model) ??
    (activeEntry?.driverKind === "opencode" || activeEntry?.driverKind === "antigravity"
      ? undefined
      : selectedInstanceOptions[0]);
  const triggerTitle = selectedModel
    ? getTriggerDisplayModelName(selectedModel, activeEntry?.driverKind)
    : props.model === ANTIGRAVITY_DEFAULT_MODEL
      ? gt("Choose model")
      : props.model || gt("Choose model");
  const withUnavailable = (model: string, isUnavailable: boolean | undefined) =>
    isUnavailable ? gt("{model} (Unavailable)", { model }) : model;
  const triggerLabel = selectedModel
    ? withUnavailable(getDisplayModelName(selectedModel), selectedModel.isUnavailable)
    : triggerTitle;
  const showInstanceBadge =
    activeEntry !== null && shouldShowInstanceBadge(activeEntry, props.instanceEntries);

  const setIsMenuOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(open);
    }
  };

  const focusEffort = (fallback = false) => {
    const controls = popupRef.current?.querySelector("[data-model-picker-effort]");
    const control =
      controls?.querySelector<HTMLElement>("[data-effort-slider]:not(:disabled)") ??
      (fallback ? controls?.querySelector<HTMLElement>("[data-effort-row]:not(:disabled)") : null);
    control?.focus({ preventScroll: true });
    control?.scrollIntoView({ block: "nearest" });
  };
  const focusPermissions = () => {
    popupRef.current
      ?.querySelector<HTMLButtonElement>("[data-composer-permissions-trigger]")
      ?.click();
  };

  const handleInstanceModelChange = (instanceId: ProviderInstanceId, model: string) => {
    if (props.disabled) return;
    props.onInstanceModelChange(instanceId, model);
    if (!hasEffortControls) {
      setIsMenuOpen(false);
      return;
    }
    modelListFocusRef.current?.focus({ preventScroll: true });
  };

  const shortcutLabel = props.keybindings
    ? shortcutLabelForCommand(props.keybindings, "modelPicker.toggle")
    : null;
  const selectedEntries = props.selectedModels?.map((selection) => {
    const entry = props.instanceEntries.find(
      (candidate) => candidate.instanceId === selection.instanceId,
    );
    const model = resolveModelPickerSelectedModel({
      driverKind: entry?.driverKind,
      model: selection.model,
      options: props.modelOptionsByInstance.get(selection.instanceId) ?? [],
    });
    return {
      ...selection,
      entry,
      label: model
        ? withUnavailable(getTriggerDisplayModelName(model, entry?.driverKind), model.isUnavailable)
        : selection.model,
      fullLabel: model
        ? withUnavailable(getDisplayModelName(model), model.isUnavailable)
        : selection.model,
    };
  });
  const multipleLabel = selectedEntries
    ? selectedEntries.length === 0
      ? gt("Choose models")
      : selectedEntries.length > 2
        ? gt("{count, plural, one {{models}, {count} more} other {{models}, {count} more}}", {
            models: selectedEntries
              .slice(0, 2)
              .map((selection) => selection.label)
              .join(", "),
            count: selectedEntries.length - 2,
          })
        : selectedEntries.map((selection) => selection.label).join(", ")
    : undefined;
  const allModelNames = selectedEntries
    ? selectedEntries.map((selection) => selection.fullLabel).join(", ") || gt("Choose models")
    : undefined;
  const triggerTooltipContent = [
    props.triggerLabel ?? allModelNames ?? triggerLabel,
    props.triggerDetail,
    shortcutLabel,
  ]
    .filter(Boolean)
    .join(" · ");

  const triggerText = props.triggerLabel ?? multipleLabel ?? triggerTitle;
  const triggerTextProps = {
    className: cn(
      "min-w-0 flex-1 overflow-hidden truncate",
      // Long names such as "Fusion (Claude Opus 5.5 Medium + SWE-2 High)" would push the composer.
      props.isComposerOwned && "max-w-56",
    ),
    "data-chat-provider-model-picker-label": "true",
  } as const;

  const picker = (
    <ModelPickerContent
      searchInputRef={searchInputRef}
      environmentId={props.environmentId}
      workspaceCwd={props.workspaceCwd ?? null}
      activeInstanceId={activeInstanceId}
      model={props.model}
      {...(props.selectedModels !== undefined ? { selectedModels: props.selectedModels } : {})}
      {...(props.onToggleModel
        ? {
            onToggleModel: (instanceId: ProviderInstanceId, model: string) => {
              if (!props.disabled) props.onToggleModel?.(instanceId, model);
            },
          }
        : {})}
      lockedProvider={props.lockedProvider}
      lockedContinuationGroupKey={props.lockedContinuationGroupKey ?? null}
      instanceEntries={props.instanceEntries}
      {...(props.keybindings ? { keybindings: props.keybindings } : {})}
      modelOptionsByInstance={props.modelOptionsByInstance}
      terminalOpen={props.terminalOpen ?? false}
      onRequestClose={() => setIsMenuOpen(false)}
      {...(props.onOpenProviderSetup ? { onOpenProviderSetup: props.onOpenProviderSetup } : {})}
      getModelDisabledReason={(instanceId, model) =>
        props.disabled
          ? gt("Model picker is disabled")
          : (props.getModelDisabledReason?.(instanceId, model) ?? null)
      }
      onInstanceModelChange={handleInstanceModelChange}
      {...(hasEffortControls
        ? {
            composerLayout: true,
            modelListFocusRef,
            onFocusEffort: () => {
              menuHeaderRef.current?.focus({ preventScroll: true });
              setCompactMenu(true);
              window.requestAnimationFrame(() => focusEffort());
            },
            ...(props.selectedModels === undefined
              ? { listFooter: <ChatGptSharingControl provider={activeEntry?.snapshot ?? null} /> }
              : {}),
          }
        : {})}
    />
  );

  return (
    <Popover
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        if (open && hasEffortControls) {
          setCompactMenu(triggerRef.current?.dataset.openToPermissions !== "true");
        }
        setIsMenuOpen(open);
      }}
      onOpenChangeComplete={(open) => {
        const target = takeOpenTarget(triggerRef.current);
        if (!hasEffortControls) return;
        if (!open) {
          setCompactMenu(false);
          return;
        }
        if (target === "effort") focusEffort(true);
        if (target === "permissions") focusPermissions();
      }}
    >
      <PopoverTrigger
        payload={hasEffortControls ? (compactMenu ? "thinking" : "models") : undefined}
        render={
          <ComposerControl
            ref={triggerRef}
            aria-label={[
              props.triggerAriaLabel ?? props.triggerLabel ?? allModelNames ?? triggerLabel,
              props.triggerDetail,
            ]
              .filter(Boolean)
              .join(", ")}
            size={size}
            data-chat-provider-model-picker="true"
            data-composer-shortcut={props.triggerShortcuts}
            onClick={(event) => {
              if (!isMenuOpen || !hasEffortControls) return;
              const target = takeOpenTarget(triggerRef.current);
              if (!target) return;
              // A shortcut aimed at the open picker moves within it instead of closing it.
              (
                event as typeof event & { preventBaseUIHandler?: () => void }
              ).preventBaseUIHandler?.();
              const nextCompact = target === "effort";
              if (nextCompact === compactMenu) {
                if (nextCompact) focusEffort(true);
                else focusPermissions();
                return;
              }
              menuHeaderRef.current?.focus({ preventScroll: true });
              setCompactMenu(nextCompact);
              window.requestAnimationFrame(() => {
                if (nextCompact) focusEffort(true);
                else focusPermissions();
              });
            }}
            className={cn(
              "min-w-0 shrink justify-between whitespace-nowrap",
              props.compact
                ? "max-w-42 shrink-0"
                : !props.isComposerOwned && "max-w-48 sm:max-w-56",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn("flex min-w-0 flex-1 items-center", size === "xs" ? "gap-1" : "gap-1.5")}
        >
          {selectedEntries && props.triggerLabel === undefined ? (
            <span
              data-chat-provider-model-picker-icon
              className="flex shrink-0 items-center -space-x-1"
              aria-hidden="true"
            >
              {selectedEntries
                .slice(0, 3)
                .map((selection) =>
                  selection.entry ? (
                    <ProviderInstanceIcon
                      key={`${selection.instanceId}:${selection.model}`}
                      driverKind={selection.entry.driverKind}
                      displayName={selection.entry.displayName}
                      accentColor={selection.entry.accentColor}
                      acpRegistryAgentId={selection.entry.acpRegistryAgentId}
                      acpRegistryIconUrl={selection.entry.acpRegistryIconUrl}
                      className="size-4 rounded-full bg-(--chat-composer-glass-surface,var(--background)) ring-2 ring-(--chat-composer-glass-surface,var(--background))"
                      iconClassName="size-4"
                    />
                  ) : null,
                )}
              {selectedEntries.length > 3 ? (
                <span className="relative z-30 flex size-4 items-center justify-center rounded-full bg-(--chat-composer-glass-surface,var(--background)) text-3xs ring-2 ring-(--chat-composer-glass-surface,var(--background))">
                  +{selectedEntries.length - 3}
                </span>
              ) : null}
            </span>
          ) : activeEntry && props.triggerLabel === undefined ? (
            // Narrow compacted composers hide the provider icon before truncating the name.
            <span data-chat-provider-model-picker-icon className="contents">
              <ProviderInstanceIcon
                driverKind={activeEntry.driverKind}
                displayName={activeEntry.displayName}
                accentColor={activeEntry.accentColor}
                acpRegistryAgentId={activeEntry.acpRegistryAgentId}
                acpRegistryIconUrl={activeEntry.acpRegistryIconUrl}
                showBadge={showInstanceBadge}
                className="size-4"
                iconClassName={cn("size-4", props.activeProviderIconClassName)}
                indicatorBackground={props.instanceIndicatorBackground ?? "var(--contrast-input)"}
                badgeClassName={cn(
                  "right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs",
                  size === "xs" && "shadow-none",
                )}
              />
            </span>
          ) : null}
          {props.isComposerOwned ? (
            <span {...triggerTextProps}>{triggerText}</span>
          ) : (
            <Tooltip>
              <TooltipTrigger render={<span {...triggerTextProps} />}>{triggerText}</TooltipTrigger>
              <TooltipPopup side="top">{triggerTooltipContent}</TooltipPopup>
            </Tooltip>
          )}
          {props.triggerSuffix}
          {selectedModel?.isUnavailable && !selectedEntries && props.triggerLabel === undefined ? (
            <Badge variant="outline" size="sm">
              <T context="badge on a model that cannot be selected">Unavailable</T>
            </Badge>
          ) : null}
        </span>
      </PopoverTrigger>
      <PopoverPopup
        {...(props.isComposerOwned ? composerFloatingLayerProps : {})}
        ref={(popup) => {
          popupRef.current = popup;
          const unlock = lockBackgroundScroll(popup);
          return () => {
            popupRef.current = null;
            unlock?.();
          };
        }}
        initialFocus={
          isCoarsePointer || compactMenu
            ? popupRef
            : hasEffortControls
              ? modelListFocusRef
              : searchInputRef
        }
        align={props.popupAlign ?? "start"}
        // Docked, the popup opens above the composer and slides over it when that space is short,
        // so a short window gets its full height (Floating UI sizes to the viewport) instead of a sliver.
        {...(hasEffortControls
          ? { side: "top" as const, collisionAvoidance: { side: "flip", align: "shift" } as const }
          : {})}
        variant={hasEffortControls ? "composer" : "default"}
        className="before:hidden"
        padding="none"
        touchBackdrop
      >
        {hasEffortControls ? (
          <div
            className={cn(
              "flex max-h-(--available-height) max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-2xl",
              compactMenu ? "w-68" : "w-94",
            )}
          >
            <div className="relative shrink-0 px-2 pt-2">
              {props.leadingControl ? (
                <div className="absolute inset-s-2 inset-y-0 flex items-center pt-2">
                  {props.leadingControl}
                </div>
              ) : null}
              <button
                ref={menuHeaderRef}
                type="button"
                aria-label={compactMenu ? gt("Change model") : gt("Back to thinking level")}
                aria-expanded={!compactMenu}
                className="flex w-full min-w-0 items-center justify-center gap-2 rounded-xl px-9 py-2 text-sm font-medium hover:bg-foreground/8 focus-visible:bg-foreground/8 focus-visible:outline-none"
                onClick={() => {
                  setCompactMenu(!compactMenu);
                  if (!isCoarsePointer) {
                    window.requestAnimationFrame(() => {
                      (compactMenu ? modelListFocusRef.current : menuHeaderRef.current)?.focus({
                        preventScroll: true,
                      });
                    });
                  }
                }}
              >
                {activeEntry ? (
                  <ProviderInstanceIcon
                    driverKind={activeEntry.driverKind}
                    displayName={activeEntry.displayName}
                    accentColor={activeEntry.accentColor}
                    acpRegistryAgentId={activeEntry.acpRegistryAgentId}
                    acpRegistryIconUrl={activeEntry.acpRegistryIconUrl}
                    showBadge={showInstanceBadge}
                    className="size-4"
                    iconClassName="size-4"
                  />
                ) : null}
                <span className="flex min-w-0 items-baseline gap-1">
                  <span className="truncate">{triggerText}</span>
                  {compactMenu && props.reasoningLevel ? (
                    <span className="shrink-0 text-muted-foreground">{props.reasoningLevel}</span>
                  ) : null}
                </span>
                {compactMenu ? (
                  <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                )}
              </button>
            </div>
            {!compactMenu ? picker : null}
            <div
              data-model-picker-effort
              className={cn(
                "min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-width:thin]",
                !compactMenu &&
                  "max-h-[min(12rem,35dvh)] shrink-0 border-t border-border/70 empty:hidden",
              )}
              onKeyDown={(event) => {
                if (
                  compactMenu ||
                  event.key !== "ArrowLeft" ||
                  event.altKey ||
                  event.ctrlKey ||
                  event.metaKey ||
                  (event.target as HTMLElement).matches("[data-effort-slider]")
                )
                  return;
                event.preventDefault();
                event.stopPropagation();
                modelListFocusRef.current?.focus({ preventScroll: true });
              }}
            >
              <ComposerPickerCompactContext value={compactMenu}>
                {props.effortControls}
              </ComposerPickerCompactContext>
            </div>
            {!compactMenu ? props.footer : null}
          </div>
        ) : (
          picker
        )}
        {props.selectedModels === undefined && !hasEffortControls ? (
          <ChatGptSharingControl provider={activeEntry?.snapshot ?? null} />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
});
