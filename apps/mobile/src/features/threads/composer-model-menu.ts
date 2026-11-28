import {
  resolveFastModeToggle,
  selectableProviderOptionChoices,
} from "@ankielcode/client-runtime/model-traits";
import type { ModelSelection, ProviderOptionDescriptor } from "@ankielcode/contracts";
import { getProviderOptionCurrentValue } from "@ankielcode/shared/model";
import type { MenuAction } from "@react-native-menu/menu";

import { groupByProvider, type ModelOption } from "../../lib/modelOptions";
import { findReasoningDescriptor } from "./thread-settings-sheet-state";

/** Longer catalogs end in "More models…", which opens the searchable thread settings sheet. */
const COMPOSER_MENU_MODELS_PER_PROVIDER = 12;

export type ComposerModelMenuIntent =
  | { readonly kind: "model"; readonly option: ModelOption }
  | {
      readonly kind: "option";
      readonly descriptor: ProviderOptionDescriptor;
      readonly value: string | boolean;
    }
  | { readonly kind: "settings" }
  | { readonly kind: "runtime" };

export type ComposerModelMenuLabels = {
  readonly on: string;
  readonly off: string;
  readonly ultrathink: string;
  readonly fastMode: string;
  readonly favorites: string;
  readonly moreModels: string;
  readonly runtime: string;
  readonly threadSettings: string;
};

export type ComposerModelMenu = {
  readonly actions: MenuAction[];
  readonly intents: ReadonlyMap<string, ComposerModelMenuIntent>;
};

/**
 * Effort, Fast, favorites and each provider's models as one native menu tree. Ids are unique
 * across the tree; submenu ids stay stable so the native menu can refresh while presented.
 */
export function buildComposerModelMenu(input: {
  readonly options: ReadonlyArray<ModelOption>;
  readonly currentOption: ModelOption | null;
  readonly selection: ModelSelection;
  readonly reportedSelection?: ModelSelection | null;
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  /** An "Ultrathink:" prompt sets the primary effort select. */
  readonly ultrathinkPromptControlled: boolean;
  /** Null until favorites load. */
  readonly favoriteKeys: ReadonlySet<string> | null;
  readonly disabled: boolean;
  readonly permissionsLabel: string | undefined;
  readonly labels: ComposerModelMenuLabels;
}): ComposerModelMenu {
  const { labels } = input;
  const intents = new Map<string, ComposerModelMenuIntent>();
  const action = (
    id: string,
    intent: ComposerModelMenuIntent | null,
    fields: Omit<MenuAction, "id">,
  ): MenuAction => {
    if (intent) intents.set(id, intent);
    return { id, ...fields };
  };
  const section = (id: string, title: string, subactions: MenuAction[]): MenuAction[] =>
    // A native menu entry without children renders as a plain action, so drop empty sections.
    subactions.length > 0 ? [{ id, title, displayInline: true, subactions }] : [];
  const optionsDisabled = input.disabled || input.currentOption?.isUnavailable === true;
  const isCurrent = (option: ModelOption) =>
    option.selection.instanceId === input.selection.instanceId &&
    option.selection.model === input.selection.model;

  const reasoning = findReasoningDescriptor(input.descriptors);
  const reasoningActions: MenuAction[] = [];
  if (reasoning) {
    const primarySelect = input.descriptors.find((descriptor) => descriptor.type === "select");
    const promptControlled = input.ultrathinkPromptControlled && primarySelect?.id === reasoning.id;
    const current = getProviderOptionCurrentValue(
      reasoning,
      input.selection,
      input.reportedSelection,
    );
    const choices =
      reasoning.type === "select"
        ? selectableProviderOptionChoices(reasoning).map((choice) => ({
            value: choice.id as string | boolean,
            label: choice.label,
            description: choice.description,
          }))
        : [
            { value: false, label: labels.off, description: undefined },
            { value: true, label: labels.on, description: undefined },
          ];
    if (promptControlled) {
      reasoningActions.push(
        action("reasoning:ultrathink", null, {
          title: labels.ultrathink,
          state: "on",
          attributes: { disabled: true },
        }),
      );
    }
    choices.forEach((choice, index) => {
      reasoningActions.push(
        action(
          `reasoning:${index}`,
          { kind: "option", descriptor: reasoning, value: choice.value },
          {
            title: choice.label,
            ...(choice.description ? { subtitle: choice.description } : {}),
            state: !promptControlled && choice.value === current ? "on" : "off",
            ...(optionsDisabled ? { attributes: { disabled: true } } : {}),
          },
        ),
      );
    });
  }

  const fast = resolveFastModeToggle(input.descriptors, input.selection, input.reportedSelection);
  const fastActions = fast
    ? [
        action(
          "fast",
          { kind: "option", descriptor: fast.descriptor, value: fast.value },
          {
            title: labels.fastMode,
            image: "bolt",
            state: fast.enabled ? "on" : "off",
            // A toggle, not a pick: stay open so effort can change next.
            attributes: { disabled: optionsDisabled, keepsMenuPresented: true },
          },
        ),
      ]
    : [];

  const favoriteKeys = input.favoriteKeys;
  const visible = input.options.filter(
    (option) =>
      option.isHidden !== true &&
      (!option.isLegacy || isCurrent(option) || favoriteKeys?.has(option.key) === true),
  );
  const modelAction = (idPrefix: string, option: ModelOption, showProvider: boolean) => {
    const subtitle = [showProvider ? option.providerLabel : null, option.subtitle]
      .filter(Boolean)
      .join(" · ");
    return action(
      `${idPrefix}:${option.key}`,
      { kind: "model", option },
      {
        title: option.label,
        ...(subtitle ? { subtitle } : {}),
        state: isCurrent(option) ? "on" : "off",
        ...(input.disabled || option.isUnavailable === true
          ? { attributes: { disabled: true } }
          : {}),
      },
    );
  };
  const providerModels = (providerKey: string, models: ReadonlyArray<ModelOption>) => {
    const shown = models.filter(
      (model, index) => index < COMPOSER_MENU_MODELS_PER_PROVIDER || isCurrent(model),
    );
    return [
      ...shown.map((model) => modelAction("model", model, false)),
      ...(shown.length < models.length
        ? [
            action(
              `more:${providerKey}`,
              { kind: "settings" },
              { title: labels.moreModels, image: "ellipsis" },
            ),
          ]
        : []),
    ];
  };

  const favoriteActions = favoriteKeys
    ? visible
        .filter((option) => favoriteKeys.has(option.key))
        .map((option) => modelAction("favorite", option, true))
    : [];

  const groups = groupByProvider(visible);
  const singleGroup = groups.length === 1 ? groups[0] : undefined;
  const modelSections = singleGroup
    ? section(
        `provider:${singleGroup.providerKey}`,
        singleGroup.providerLabel,
        providerModels(singleGroup.providerKey, singleGroup.models),
      )
    : section(
        "providers",
        "",
        groups.map((group) => {
          const current = group.models.find(isCurrent);
          return {
            id: `provider:${group.providerKey}`,
            title: group.providerLabel,
            ...(current ? { subtitle: current.label } : {}),
            subactions: providerModels(group.providerKey, group.models),
          };
        }),
      );

  const threadActions = [
    ...(input.permissionsLabel
      ? [
          action(
            "runtime",
            { kind: "runtime" },
            { title: labels.runtime, subtitle: input.permissionsLabel, image: "lock" },
          ),
        ]
      : []),
    action(
      "settings",
      { kind: "settings" },
      { title: labels.threadSettings, image: "slider.horizontal.3" },
    ),
  ];

  return {
    actions: [
      ...section("reasoning", reasoning?.label ?? "", reasoningActions),
      ...section("fast-mode", "", fastActions),
      ...section("favorites", labels.favorites, favoriteActions),
      ...modelSections,
      ...section("thread", "", threadActions),
    ],
    intents,
  };
}
