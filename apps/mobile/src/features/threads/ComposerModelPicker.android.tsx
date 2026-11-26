import {
  getPromptControlledTraits,
  getTraitSelectChange,
  resolveFastModeToggle,
  selectableProviderOptionChoices,
} from "@ankielcode/client-runtime/model-traits";
import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@ankielcode/contracts";
import { getProviderOptionCurrentValue } from "@ankielcode/shared/model";
import { useAtomMount } from "@effect/atom-react";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { use, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
  type ScrollViewInstance,
  type ViewInstance,
} from "react-native";
import Animated, { Easing, FadeIn, ReduceMotion } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ComposerModelControl } from "../../components/ComposerModelControl";
import { ComposerThinkingSlider } from "../../components/ComposerThinkingSlider";
import { ProviderIcon, ProviderInstanceIcon } from "../../components/ProviderIcon";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { OverlayPortal } from "../../components/ui/OverlayPortal";
import { useHardwareBack } from "../../lib/backHandler";
import { cn } from "../../lib/cn";
import {
  deriveMenuHorizontalPlacement,
  deriveMenuVerticalPlacement,
} from "../../lib/menu-placement";
import { WindowHingeContext } from "../../native/window-hinge-context";
import { groupByProvider, type ModelOption } from "../../lib/modelOptions";
import {
  applyProviderOptionSelection,
  resolveProviderOptionDescriptors,
} from "../../lib/providerOptions";
import { providerWorkspaceSnapshotRefresh } from "../../state/provider-workspace-snapshot-refresh";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type {
  ComposerModelPickerPage,
  ComposerModelPickerProps,
} from "./ComposerModelPicker.types";
import { findReasoningDescriptor } from "./thread-settings-sheet-state";

type PickerProps = ComposerModelPickerProps;

/** `/model` opens this overlay's model page. */
export const COMPOSER_MODEL_COMMAND_OPENS_SETTINGS: boolean = false;

type Frame = { x: number; y: number; width: number; height: number };
const ThemedSvg = withUniwind(Svg);
const MENU_EASE = Easing.bezier(0.23, 1, 0.32, 1);
const MENU_ENTER = FadeIn.duration(150).easing(MENU_EASE).reduceMotion(ReduceMotion.System);

function ModelPickerCatalogScan(props: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  cwd: string;
}) {
  useAtomMount(providerWorkspaceSnapshotRefresh(props));
  return null;
}

function ComposerModelIcon(props: { option: ModelOption | null; surfaceColor: string }) {
  const { option } = props;
  const badge = option?.providerBadge;
  return badge?.showBadge ? (
    <ProviderInstanceIcon
      iconUrl={option?.providerIconUrl}
      provider={option?.providerDriver}
      displayName={badge.displayName}
      accentColor={badge.accentColor}
      showBadge
      surfaceColor={props.surfaceColor}
      size={17}
    />
  ) : (
    <ProviderIcon iconUrl={option?.providerIconUrl} provider={option?.providerDriver} size={17} />
  );
}

function ComposerModelPickerPanel(props: PickerProps & { maxHeight: number }) {
  const gt = useGT();
  const [providerKey, setProviderKey] = useState(
    props.currentOption?.providerKey ?? props.selection.instanceId,
  );
  const modelsPage = props.page === "models";
  const [preview, setPreview] = useState<{ model: ModelSelection; index: number } | null>(null);
  const groups = modelsPage
    ? groupByProvider(props.options.filter((option) => !option.isHidden))
    : [];
  const group = groups.find((candidate) => candidate.providerKey === providerKey) ?? groups[0];
  const providerTabs = useRef<ScrollViewInstance>(null);
  const descriptors = resolveProviderOptionDescriptors({
    capabilities: props.currentOption?.capabilities,
    selections: props.selection.options,
  });
  const reasoning = findReasoningDescriptor(descriptors);
  const promptTraits = getPromptControlledTraits(descriptors, props.prompt);
  const reasoningId = reasoning?.id;
  const primaryId = promptTraits.primarySelectDescriptor?.id;
  const promptControlled = reasoningId === primaryId && promptTraits.ultrathinkPromptControlled;
  const promptLocked = promptControlled && promptTraits.ultrathinkInBodyText;
  const choices =
    reasoning?.type === "select"
      ? selectableProviderOptionChoices(reasoning).map((choice) => ({
          value: choice.id,
          label: choice.label,
        }))
      : [
          { value: false, label: gt("Off", { $context: "option state" }) },
          { value: true, label: gt("On", { $context: "option state" }) },
        ];
  const value =
    reasoning && getProviderOptionCurrentValue(reasoning, props.selection, props.reportedSelection);
  const currentIndex = choices.findIndex((choice) => choice.value === value);
  const previewIndex = preview && preview.model === props.selection ? preview.index : currentIndex;
  const level =
    promptControlled && previewIndex === currentIndex ? "Ultrathink" : choices[previewIndex]?.label;
  const changeThinking = (index: number) => {
    const choice = choices[index];
    if (!choice || !reasoning || props.disabled || promptLocked) return;
    if (reasoning.type === "select" && typeof choice.value === "string") {
      const change = getTraitSelectChange(
        { ...promptTraits, descriptors },
        reasoning,
        props.prompt,
        choice.value,
      );
      if (change) props.onChangeOptions(change.modelOptions ?? [], change.prompt);
    } else {
      const options = applyProviderOptionSelection(descriptors, {
        id: reasoning.id,
        value: choice.value,
      });
      if (options) props.onChangeOptions(options, props.prompt);
    }
  };
  const fast = resolveFastModeToggle(descriptors, props.selection, props.reportedSelection);
  const optionsDisabled = props.disabled || props.currentOption?.isUnavailable === true;
  const selectedScanInstance = group?.models[0]?.selection.instanceId;
  const modelLabel = props.currentOption?.label ?? props.selection.model;

  return (
    <GlassSurface
      accessibilityViewIsModal
      onAccessibilityEscape={() => props.onPageChange(modelsPage ? "thinking" : null)}
      style={{ maxHeight: props.maxHeight, borderRadius: modelsPage ? 24 : 20 }}
      className="px-2 pt-2"
    >
      <View className="shrink-0 flex-row items-center gap-1">
        <View className="w-11">
          {fast ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Fast mode")}
              accessibilityState={{ selected: fast.enabled, disabled: optionsDisabled }}
              disabled={optionsDisabled}
              className="size-11 items-center justify-center rounded-xl active:bg-subtle disabled:opacity-50"
              onPress={() => {
                const options = applyProviderOptionSelection(descriptors, {
                  id: fast.descriptor.id,
                  value: fast.value,
                });
                if (options) props.onChangeOptions(options, props.prompt);
              }}
            >
              <ThemedSvg
                width={22.5}
                height={22.5}
                viewBox="0 0 24 24"
                accessible={false}
                colorClassName={fast.enabled ? "accent-foreground" : "accent-foreground-muted"}
              >
                <Path
                  d="M13 2 3 14h8l-1 8 11-12h-8l1-8Z"
                  fill={fast.enabled ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
              </ThemedSvg>
            </Pressable>
          ) : null}
        </View>
        <View className="min-w-0 flex-1 items-center">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("{label}, {value}", {
              label: modelsPage ? gt("Back to thinking level") : gt("Change model"),
              value: modelLabel,
            })}
            accessibilityState={{ expanded: modelsPage }}
            className="min-h-11 max-w-full flex-row items-center justify-center gap-2 rounded-xl px-2 py-1 active:bg-subtle"
            onPress={() => props.onPageChange(modelsPage ? "thinking" : "models")}
          >
            <ComposerModelIcon option={props.currentOption} surfaceColor={props.surfaceColor} />
            <View className="min-w-0 shrink flex-row items-baseline gap-1">
              <Text
                className="shrink text-sm font-ankiel-semibold text-foreground"
                numberOfLines={1}
              >
                {modelLabel}
              </Text>
              {!modelsPage && level ? (
                <Text className="shrink text-sm text-foreground-muted" numberOfLines={1}>
                  {level}
                </Text>
              ) : null}
            </View>
            <SymbolView
              name={modelsPage ? "chevron.down" : "chevron.right"}
              size={11}
              tintColorClassName="accent-icon-muted"
            />
          </Pressable>
        </View>
        {modelsPage && props.permissionsLabel ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("{label}, {value}", {
              label: gt("Runtime", { $context: "agent permission mode setting" }),
              value: props.permissionsLabel,
            })}
            className="min-h-11 max-w-[35%] flex-row items-center gap-1.5 rounded-xl px-2 active:bg-subtle"
            onPress={() => props.onOpenSettings("runtime")}
          >
            <SymbolView
              name={{ ios: "lock", android: "lock" }}
              size={14}
              tintColorClassName="accent-icon-muted"
            />
            <Text
              className="shrink text-xs font-ankiel-medium text-foreground-muted"
              numberOfLines={1}
            >
              {props.permissionsLabel}
            </Text>
          </Pressable>
        ) : (
          <View className="w-11" />
        )}
      </View>
      {modelsPage ? (
        <>
          {props.cwd && selectedScanInstance ? (
            <ModelPickerCatalogScan
              environmentId={props.environmentId}
              instanceId={selectedScanInstance}
              cwd={props.cwd}
            />
          ) : null}
          <View className="shrink-0 border-b border-border">
            <ScrollView
              ref={providerTabs}
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="always"
              contentContainerClassName="gap-1 p-1"
            >
              {groups.map((candidate) => {
                const selected = candidate.providerKey === group?.providerKey;
                return (
                  <Pressable
                    key={candidate.providerKey}
                    accessibilityRole="tab"
                    accessibilityState={{ selected }}
                    onLayout={
                      selected
                        ? ({ nativeEvent }) => {
                            providerTabs.current?.scrollTo({
                              x: Math.max(0, nativeEvent.layout.x - 4),
                              animated: false,
                            });
                          }
                        : undefined
                    }
                    onPress={() => setProviderKey(candidate.providerKey)}
                    className={cn(
                      "min-h-11 flex-row items-center gap-2 rounded-full px-3 active:bg-subtle",
                      selected && "bg-subtle",
                    )}
                  >
                    <ComposerModelIcon
                      option={candidate.models[0] ?? null}
                      surfaceColor={props.surfaceColor}
                    />
                    <Text
                      className={cn(
                        "text-sm",
                        selected ? "font-ankiel-semibold text-foreground" : "text-foreground-muted",
                      )}
                    >
                      {candidate.providerLabel}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
          <ScrollView
            key={group?.providerKey}
            style={{
              maxHeight: 240,
              flexGrow: 0,
              flexShrink: 1,
            }}
            contentContainerClassName="gap-0.5 py-1.5"
            keyboardShouldPersistTaps="always"
          >
            {group?.models.length ? (
              group.models.map((item) => {
                const selected =
                  item.selection.instanceId === props.selection.instanceId &&
                  item.selection.model === props.selection.model;
                const disabled = props.disabled || item.isUnavailable === true;
                return (
                  <Pressable
                    key={item.key}
                    accessibilityRole="button"
                    accessibilityState={{ selected, disabled }}
                    disabled={disabled}
                    onPress={() => {
                      if (!selected) props.onSelectModel(item);
                    }}
                    className={cn(
                      "min-h-11 flex-row items-center gap-3 rounded-xl px-3 py-1.5 active:bg-subtle",
                      selected && "bg-subtle",
                      disabled && "opacity-50",
                    )}
                  >
                    <ComposerModelIcon option={item} surfaceColor={props.surfaceColor} />
                    <Text className="min-w-0 flex-1 text-sm text-foreground">{item.label}</Text>
                    {selected ? (
                      <SymbolView name="checkmark" size={16} tintColorClassName="accent-icon" />
                    ) : null}
                  </Pressable>
                );
              })
            ) : (
              <Text className="p-3 text-sm text-foreground-muted">{gt("No models found")}</Text>
            )}
          </ScrollView>
        </>
      ) : null}
      <View className={cn("shrink-0 px-2 pb-2", modelsPage && "border-t border-border pt-2")}>
        {modelsPage ? null : reasoning ? (
          <>
            {promptLocked ? (
              <Text className="text-xs text-foreground-muted">
                {gt(
                  'Your prompt contains "ultrathink" in the text. Remove it to change this option.',
                )}
              </Text>
            ) : null}
            <ComposerThinkingSlider
              key={`${props.currentOption?.key}:${reasoning.id}`}
              label={reasoning.label}
              valueLabel={level}
              index={Math.max(0, currentIndex)}
              activeIndex={Math.max(0, previewIndex)}
              onPreviewChange={(index) =>
                setPreview(index === null ? null : { model: props.selection, index })
              }
              choices={choices}
              disabled={optionsDisabled || promptLocked}
              onChange={changeThinking}
            />
          </>
        ) : (
          <Text className="py-2 text-center text-xs text-foreground-muted">
            {gt("No effort levels")}
          </Text>
        )}
        {modelsPage ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => props.onOpenSettings()}
            className="mt-1 min-h-11 flex-row items-center justify-between gap-2 rounded-xl px-2 active:bg-subtle"
          >
            <Text className="text-xs font-ankiel-medium text-foreground-muted">
              {gt("Thread settings")}
            </Text>
            <SymbolView name="chevron.right" size={10} tintColorClassName="accent-icon-muted" />
          </Pressable>
        ) : null}
      </View>
    </GlassSurface>
  );
}

export function ComposerModelPicker(props: PickerProps) {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const hinge = use(WindowHingeContext);
  const open = props.page !== null && focused;
  const triggerRef = useRef<ViewInstance>(null);
  const [anchor, setAnchor] = useState<Frame | null>(null);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const keyboardHeight = useKeyboardState((state) => state.height);
  const insets = useSafeAreaInsets();
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const close = () => props.onPageChange(null);
  useHardwareBack(open, () => {
    if (props.page === "models") props.onPageChange("thinking");
    else close();
    return true;
  });
  const closeOnBlur = useEffectEvent(() => {
    setAnchor(null);
    close();
  });
  // oxlint-disable-next-line ankielcode/no-unreasoned-state-sync -- dismisses the overlay when its owning navigation screen loses focus
  useEffect(() => navigation.addListener("blur", () => closeOnBlur()), [navigation]);
  const refresh = useEffectEvent(() => {
    void refreshProviders({
      environmentId: props.environmentId,
      input: { modelCatalogOnly: true },
    });
  });
  const shouldRefresh = open && props.page === "models" && props.canRefreshCatalog;
  // oxlint-disable-next-line ankielcode/no-unreasoned-state-sync -- refreshes the server catalog when entering the full picker
  useEffect(() => {
    if (shouldRefresh) refresh();
  }, [shouldRefresh]);

  // oxlint-disable-next-line ankielcode/no-unreasoned-state-sync -- measures the native trigger in the overlay's coordinate space when its window or keyboard moves
  useLayoutEffect(() => {
    if (!open) return;
    let active = true;
    triggerRef.current?.measureInWindow((x, y, width, height) => {
      if (active) setAnchor({ x, y, width, height });
    });
    return () => {
      active = false;
    };
  }, [
    open,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- keyboard and window changes move the native trigger even when its own layout is unchanged
    windowWidth,
    windowHeight,
    keyboardHeight,
  ]);

  const changePage = (page: ComposerModelPickerPage | null) => {
    if (page === null) {
      close();
      return;
    }
    props.onPageChange(page);
  };

  return (
    <>
      <View ref={triggerRef} collapsable={false}>
        <ComposerModelControl
          size={props.size}
          modelOption={props.currentOption}
          selection={props.selection}
          provider={props.provider}
          reportedSelection={props.reportedSelection}
          prompt={props.prompt}
          surfaceColor={props.surfaceColor}
          iconOnly={props.iconOnly}
          onPress={() => changePage("thinking")}
        />
      </View>
      {open && anchor ? (
        <OverlayPortal>
          <ComposerModelPickerOverlay
            {...props}
            anchor={anchor}
            keyboardHeight={keyboardHeight}
            insets={insets}
            hinge={hinge}
            onPageChange={changePage}
            onOpenSettings={(page) => {
              close();
              props.onOpenSettings(page);
            }}
          />
        </OverlayPortal>
      ) : null}
    </>
  );
}

function ComposerModelPickerOverlay(
  props: PickerProps & {
    anchor: Frame;
    keyboardHeight: number;
    insets: ReturnType<typeof useSafeAreaInsets>;
    hinge: React.ContextType<typeof WindowHingeContext>;
  },
) {
  const overlayRef = useRef<ViewInstance>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const gt = useGT();
  const measure = () =>
    overlayRef.current?.measureInWindow((x, y, width, height) => {
      setFrame({ x, y, width, height });
    });
  const gap = 8;
  const modelsPage = props.page === "models";

  const panelPosition = (() => {
    if (!frame) return null;
    const originX = frame.x + props.insets.left;
    const originY = frame.y + props.insets.top;
    const overlayWidth = frame.width - props.insets.left - props.insets.right;
    const { left, width } = deriveMenuHorizontalPlacement({
      anchorX: props.anchor.x - originX,
      anchorWidth: props.anchor.width,
      overlayWidth,
      desiredWidth: overlayWidth,
      margin: gap,
      hinge: props.hinge && { ...props.hinge, x: props.hinge.x - originX },
    });
    const vertical = deriveMenuVerticalPlacement({
      anchorY: props.anchor.y - originY,
      anchorHeight: props.anchor.height,
      overlayHeight: frame.height - props.insets.top,
      keyboardInset: Math.max(props.keyboardHeight, props.insets.bottom),
      gap,
      margin: gap,
      minHeight: modelsPage ? 250 : 128,
    });
    if (width <= 0 || vertical.maxHeight <= 0) return null;
    return {
      left: left + props.insets.left,
      width,
      maxHeight: vertical.maxHeight,
      ...("top" in vertical
        ? { top: (vertical.top ?? 0) + props.insets.top }
        : { bottom: vertical.bottom }),
    };
  })();

  return (
    <View
      ref={overlayRef}
      collapsable={false}
      pointerEvents="box-none"
      className="absolute inset-0"
      onLayout={measure}
    >
      <Pressable
        className="absolute inset-0"
        accessibilityRole="button"
        accessibilityLabel={gt("Close model picker")}
        onPress={() => props.onPageChange(null)}
      />
      {panelPosition ? (
        <Animated.View entering={MENU_ENTER} style={{ position: "absolute", ...panelPosition }}>
          <ComposerModelPickerPanel {...props} maxHeight={panelPosition.maxHeight} />
        </Animated.View>
      ) : null}
    </View>
  );
}
