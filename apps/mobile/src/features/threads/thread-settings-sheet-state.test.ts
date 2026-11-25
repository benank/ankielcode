import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { ProviderInstanceId, type ProviderOptionSelection } from "@ankielcode/contracts";
import { getProviderOptionDescriptors } from "@ankielcode/shared/model";

import type { ModelOption } from "../../lib/modelOptions";
import { appAtomRegistry } from "../../state/atom-registry";
import { modelOptionMemoryAtom } from "../../state/use-composer-drafts";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
import {
  canCommitPendingModel,
  findReasoningDescriptor,
  modelFavoriteKey,
  partitionCatalogModels,
  pendingModelAfterPress,
  visibleCatalogModels,
} from "./thread-settings-sheet-state";

function modelOption(
  model: string,
  options: ReadonlyArray<ProviderOptionSelection> = [],
): ModelOption {
  return {
    key: `codex:${model}`,
    label: model,
    subtitle: "",
    providerKey: "codex",
    providerLabel: "Codex",
    providerDriver: "codex",
    isDefault: false,
    isLegacy: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
          ],
          currentValue: "medium",
        },
        {
          id: "serviceTier",
          label: "Service Tier",
          type: "select",
          options: [
            { id: "default", label: "Standard", isDefault: true },
            { id: "priority", label: "Fast" },
          ],
          currentValue: "default",
        },
      ],
    },
    selection: {
      instanceId: ProviderInstanceId.make("codex"),
      model,
      options,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  appAtomRegistry.set(modelOptionMemoryAtom, {});
});

describe("thread settings sheet state", () => {
  it("preserves in-progress edits when the staged model is pressed again", () => {
    rememberModelOptions("codex", "gpt-next", [{ id: "effort", value: "medium" }]);
    const pending = modelOption("gpt-next", [{ id: "effort", value: "high" }]);

    expect(
      pendingModelAfterPress({
        current: pending,
        pressed: modelOption("gpt-next"),
        pressedIsApplied: false,
        restoreSelection: withRememberedModelOptions,
      })?.selection.options,
    ).toEqual([{ id: "effort", value: "high" }]);
  });

  it("previews remembered options before Save when switching models", () => {
    const remembered = [
      { id: "effort", value: "high" },
      { id: "serviceTier", value: "priority" },
    ];
    rememberModelOptions("codex", "gpt-other", remembered);
    const pressed = modelOption("gpt-other");

    const pending = pendingModelAfterPress({
      current: modelOption("gpt-next"),
      pressed,
      pressedIsApplied: false,
      restoreSelection: withRememberedModelOptions,
    });

    expect(pending?.selection).toEqual({ ...pressed.selection, options: remembered });
    const preview = getProviderOptionDescriptors({
      caps: pressed.capabilities!,
      selections: pending?.selection.options,
    });
    expect(preview.map(({ id, currentValue }) => ({ id, value: currentValue }))).toEqual(
      remembered,
    );
    expect(pending?.selection).toEqual(withRememberedModelOptions(pressed.selection));
  });

  it("keeps catalog defaults for scheduled-task picks even when options are remembered", () => {
    rememberModelOptions("codex", "gpt-other", [
      { id: "effort", value: "high" },
      { id: "serviceTier", value: "priority" },
    ]);
    const pressed = modelOption("gpt-other");

    const pending = pendingModelAfterPress({
      current: modelOption("gpt-next"),
      pressed,
      pressedIsApplied: false,
    });

    expect(pending?.selection).toEqual(pressed.selection);
    const preview = getProviderOptionDescriptors({
      caps: pressed.capabilities!,
      selections: pending?.selection.options,
    });
    expect(preview.map(({ id, currentValue }) => ({ id, value: currentValue }))).toEqual([
      { id: "effort", value: "medium" },
      { id: "serviceTier", value: "default" },
    ]);
  });

  // regression: #16816 sync model favorites and visibility across clients
  it("cannot select a hidden model exposed only for visibility management", () => {
    const pending = modelOption("gpt-next");
    expect(
      canCommitPendingModel(pending, [
        { providerKey: "codex", providerLabel: "Codex", models: [{ ...pending, isHidden: true }] },
      ]),
    ).toBe(false);
  });

  it("cannot save a staged model after sign-out removes it from the catalog", () => {
    const pending = modelOption("gemini-native");
    const group = { providerKey: "codex", providerLabel: "Codex", models: [pending] };

    expect(canCommitPendingModel(pending, [group])).toBe(true);
    expect(canCommitPendingModel(pending, [])).toBe(false);
    expect(
      canCommitPendingModel(pending, [
        {
          ...group,
          models: [{ ...pending, isUnavailable: true }],
        },
      ]),
    ).toBe(false);
  });

  it("finds legacy models by search without enabling Show legacy models", () => {
    const current = modelOption("gpt-next");
    const legacy = { ...modelOption("claude-opus-4-8"), label: "Claude Opus 4.8", isLegacy: true };
    const visible = (query: string) =>
      visibleCatalogModels({
        models: [current, legacy],
        providerLabel: "Codex",
        query,
        favoriteKeys: new Set(),
        favoritesOnly: false,
        showLegacy: false,
        isDisplayed: () => false,
      }).map((model) => model.label);

    expect(visible("")).toEqual(["gpt-next"]);
    expect(visible("   ")).toEqual(["gpt-next"]);
    expect(visible("Claude Opus 4.8")).toEqual(["Claude Opus 4.8"]);
  });

  it("moves favorited models into a top section without duplicating them under providers", () => {
    const codexFav = modelOption("gpt-5.4");
    const codexOther = modelOption("gpt-5.4-mini");
    const claudeFav: ModelOption = {
      ...modelOption("claude-opus-4-6"),
      key: "claudeAgent:claude-opus-4-6",
      providerKey: "claudeAgent",
      providerLabel: "Claude",
      providerDriver: "claudeAgent",
      selection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
        options: [],
      },
    };
    const claudeLegacyFav: ModelOption = {
      ...claudeFav,
      key: "claudeAgent:claude-opus-4-5",
      label: "claude-opus-4-5",
      isLegacy: true,
      selection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-5",
        options: [],
      },
    };
    const claudeOther: ModelOption = {
      ...claudeFav,
      key: "claudeAgent:claude-sonnet-4-6",
      label: "claude-sonnet-4-6",
      selection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
        options: [],
      },
    };
    const providerGroups = [
      { providerKey: "codex", providerLabel: "Codex", models: [codexFav, codexOther] },
      {
        providerKey: "claudeAgent",
        providerLabel: "Claude",
        models: [claudeFav, claudeLegacyFav, claudeOther],
      },
    ];
    const favoriteKeys = new Set([
      modelFavoriteKey(ProviderInstanceId.make("codex"), "gpt-5.4"),
      modelFavoriteKey(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-6"),
      modelFavoriteKey(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-5"),
    ]);

    const partitioned = partitionCatalogModels({
      providerGroups,
      providerFilter: null,
      query: "",
      favoriteKeys,
      favoritesOnly: false,
      showLegacy: false,
      isDisplayed: () => false,
    });

    expect(partitioned.favorites.map((model) => model.key)).toEqual([
      "codex:gpt-5.4",
      "claudeAgent:claude-opus-4-6",
      "claudeAgent:claude-opus-4-5",
    ]);
    expect(
      partitioned.providers.map((entry) => ({
        provider: entry.group.providerKey,
        models: entry.models.map((model) => model.key),
      })),
    ).toEqual([
      { provider: "codex", models: ["codex:gpt-5.4-mini"] },
      { provider: "claudeAgent", models: ["claudeAgent:claude-sonnet-4-6"] },
    ]);

    const favoritesOnly = partitionCatalogModels({
      providerGroups,
      providerFilter: null,
      query: "",
      favoriteKeys,
      favoritesOnly: true,
      showLegacy: false,
      isDisplayed: () => false,
    });
    expect(favoritesOnly.favorites.map((model) => model.key)).toEqual([
      "codex:gpt-5.4",
      "claudeAgent:claude-opus-4-6",
      "claudeAgent:claude-opus-4-5",
    ]);
    expect(favoritesOnly.providers).toEqual([]);

    const filtered = partitionCatalogModels({
      providerGroups,
      providerFilter: "claudeAgent",
      query: "opus",
      favoriteKeys,
      favoritesOnly: false,
      showLegacy: false,
      isDisplayed: () => false,
    });
    expect(filtered.favorites.map((model) => model.key)).toEqual([
      "claudeAgent:claude-opus-4-6",
      "claudeAgent:claude-opus-4-5",
    ]);
    expect(filtered.providers.map((entry) => entry.models.length)).toEqual([0]);
  });

  it("finds select and boolean reasoning descriptors while skipping non-reasoning or empty ones", () => {
    const serviceTier = {
      id: "serviceTier",
      label: "Service Tier",
      type: "select" as const,
      options: [{ id: "default", label: "Standard", isDefault: true }],
      currentValue: "default",
    };
    const effort = {
      id: "effort",
      label: "Reasoning",
      type: "select" as const,
      options: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "medium",
    };
    const acpReasoning = {
      id: "mode_reasoning",
      label: "Thinking level",
      type: "select" as const,
      role: "reasoning" as const,
      options: [{ id: "deep", label: "Deep" }],
      currentValue: "deep",
    };
    const promptOnlyEffort = {
      id: "effort",
      label: "Reasoning",
      type: "select" as const,
      options: [{ id: "ultrathink", label: "Ultrathink" }],
      promptInjectedValues: ["ultrathink"],
      currentValue: "ultrathink",
    };
    const booleanThinking = {
      id: "thinking",
      label: "Thinking",
      type: "boolean" as const,
      currentValue: true,
    };

    expect(findReasoningDescriptor([serviceTier])).toBeNull();
    expect(findReasoningDescriptor([serviceTier, effort])).toEqual(effort);
    expect(findReasoningDescriptor([serviceTier, acpReasoning])).toEqual(acpReasoning);
    expect(findReasoningDescriptor([promptOnlyEffort])).toBeNull();
    expect(findReasoningDescriptor([serviceTier, booleanThinking])).toEqual(booleanThinking);
  });
});
