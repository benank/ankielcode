import {
  isReasoningControl,
  selectableProviderOptionChoices,
} from "@ankielcode/client-runtime/model-traits";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionDescriptor,
} from "@ankielcode/contracts";

export function findReasoningDescriptor(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ProviderOptionDescriptor | null {
  return (
    descriptors.find(
      (descriptor) =>
        isReasoningControl(descriptor) &&
        (descriptor.type === "boolean" || selectableProviderOptionChoices(descriptor).length > 0),
    ) ?? null
  );
}

export function modelFavoriteKey(provider: ProviderInstanceId, model: string): string {
  return `${provider}:${model}`;
}

export function favoritesFirst(
  models: ReadonlyArray<ModelOption>,
  favoriteKeys: ReadonlySet<string>,
): ReadonlyArray<ModelOption> {
  const favorites: ModelOption[] = [];
  const others: ModelOption[] = [];
  for (const model of models) {
    (favoriteKeys.has(model.key) ? favorites : others).push(model);
  }
  return [...favorites, ...others];
}

export function modelMatchesCatalogQuery(input: {
  readonly model: ModelOption;
  readonly providerLabel: string;
  readonly query: string;
}): boolean {
  const query = input.query.trim().toLocaleLowerCase();
  if (query.length === 0) {
    return true;
  }

  return [
    input.model.label,
    input.model.subtitle,
    input.model.selection.model,
    input.providerLabel,
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

export function visibleCatalogModels(input: {
  readonly models: ReadonlyArray<ModelOption>;
  readonly providerLabel: string;
  readonly query: string;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly favoritesOnly: boolean;
  readonly showLegacy: boolean;
  readonly isDisplayed: (model: ModelOption) => boolean;
}): ReadonlyArray<ModelOption> {
  const catalogModels =
    input.showLegacy || input.favoritesOnly || input.query.trim().length > 0
      ? input.models
      : input.models.filter(
          (model) =>
            !model.isLegacy || input.isDisplayed(model) || input.favoriteKeys.has(model.key),
        );
  return favoritesFirst(
    catalogModels.filter(
      (model) =>
        (!input.favoritesOnly || input.favoriteKeys.has(model.key)) &&
        modelMatchesCatalogQuery({
          model,
          providerLabel: input.providerLabel,
          query: input.query,
        }),
    ),
    input.favoriteKeys,
  );
}

export type CatalogProviderModels = {
  readonly group: ProviderGroup;
  readonly models: ReadonlyArray<ModelOption>;
};

export function partitionCatalogModels(input: {
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly providerFilter: string | null;
  readonly query: string;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly favoritesOnly: boolean;
  readonly showLegacy: boolean;
  readonly isDisplayed: (model: ModelOption) => boolean;
}): {
  readonly favorites: ReadonlyArray<ModelOption>;
  readonly providers: ReadonlyArray<CatalogProviderModels>;
} {
  const favorites: ModelOption[] = [];
  const providers: CatalogProviderModels[] = [];
  for (const group of input.providerGroups) {
    if (input.providerFilter !== null && group.providerKey !== input.providerFilter) {
      continue;
    }
    const visible = visibleCatalogModels({
      models: group.models,
      providerLabel: group.providerLabel,
      query: input.query,
      favoriteKeys: input.favoriteKeys,
      favoritesOnly: input.favoritesOnly,
      showLegacy: input.showLegacy,
      isDisplayed: input.isDisplayed,
    });
    const remaining: ModelOption[] = [];
    for (const model of visible) {
      if (input.favoriteKeys.has(model.key)) {
        favorites.push(model);
      } else {
        remaining.push(model);
      }
    }
    if (!input.favoritesOnly) {
      providers.push({ group, models: remaining });
    }
  }
  return { favorites, providers };
}

export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null;
  readonly pressed: ModelOption;
  readonly pressedIsApplied: boolean;
  readonly restoreSelection?: (selection: ModelSelection) => ModelSelection;
}): ModelOption | null {
  if (input.pressedIsApplied) {
    return null;
  }
  if (input.current?.key === input.pressed.key) {
    return input.current;
  }
  return input.restoreSelection
    ? { ...input.pressed, selection: input.restoreSelection(input.pressed.selection) }
    : input.pressed;
}

export function canCommitPendingModel(
  pending: ModelOption,
  groups: ReadonlyArray<ProviderGroup>,
): boolean {
  return groups.some((group) =>
    group.models.some(
      (model) => model.key === pending.key && !model.isUnavailable && !model.isHidden,
    ),
  );
}

export function providerSectionIsCollapsed(input: {
  readonly defaultExpanded: boolean;
  readonly hasExpansionOverride: boolean;
  readonly isNarrowed: boolean;
}): boolean {
  if (input.isNarrowed) {
    return false;
  }
  return input.defaultExpanded ? input.hasExpansionOverride : !input.hasExpansionOverride;
}
