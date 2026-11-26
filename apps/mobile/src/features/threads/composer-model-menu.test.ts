import { describe, expect, it } from "@effect/vitest";

import {
  ProviderInstanceId,
  type ModelCapabilities,
  type ModelSelection,
  type ProviderOptionDescriptor,
} from "@ankielcode/contracts";
import type { MenuAction } from "@react-native-menu/menu";

import type { ModelOption } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import {
  buildComposerModelMenu,
  COMPOSER_MENU_MODELS_PER_PROVIDER,
  type ComposerModelMenu,
} from "./composer-model-menu";

const LABELS = {
  on: "On",
  off: "Off",
  ultrathink: "Ultrathink",
  fastMode: "Fast mode",
  favorites: "Favorites",
  moreModels: "More models…",
  runtime: "Runtime",
  threadSettings: "Thread settings",
};

const CODEX_DESCRIPTORS: ReadonlyArray<ProviderOptionDescriptor> = [
  {
    id: "reasoningEffort",
    label: "Reasoning",
    type: "select",
    options: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium", isDefault: true },
      { id: "high", label: "High", description: "Slower, more thorough" },
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
];

const CLAUDE_DESCRIPTORS: ReadonlyArray<ProviderOptionDescriptor> = [
  {
    id: "effort",
    label: "Effort",
    type: "select",
    options: [
      { id: "medium", label: "Medium", isDefault: true },
      { id: "high", label: "High" },
      { id: "ultrathink", label: "Ultrathink" },
    ],
    promptInjectedValues: ["ultrathink"],
    currentValue: "medium",
  },
  { id: "fastMode", label: "Fast Mode", type: "boolean" },
];

const THINKING_TOGGLE_DESCRIPTORS: ReadonlyArray<ProviderOptionDescriptor> = [
  { id: "thinking", label: "Thinking", type: "boolean", currentValue: true },
];

function option(
  provider: string,
  model: string,
  extra: Partial<ModelOption> & {
    readonly descriptors?: ReadonlyArray<ProviderOptionDescriptor>;
  } = {},
): ModelOption {
  const { descriptors, ...rest } = extra;
  const capabilities: ModelCapabilities | null = descriptors
    ? { optionDescriptors: [...descriptors] }
    : null;
  return {
    key: `${provider}:${model}`,
    label: model,
    subtitle: "",
    providerKey: provider,
    providerLabel: provider.toUpperCase(),
    providerDriver: provider,
    isDefault: false,
    isLegacy: false,
    capabilities,
    selection: { instanceId: ProviderInstanceId.make(provider), model },
    ...rest,
  };
}

function build(input: {
  readonly options: ReadonlyArray<ModelOption>;
  readonly current: ModelOption;
  readonly selection?: ModelSelection;
  readonly favoriteKeys?: ReadonlySet<string> | null;
  readonly disabled?: boolean;
  readonly ultrathinkPromptControlled?: boolean;
  readonly permissionsLabel?: string;
}): ComposerModelMenu {
  const selection = input.selection ?? input.current.selection;
  return buildComposerModelMenu({
    options: input.options,
    currentOption: input.current,
    selection,
    descriptors: resolveProviderOptionDescriptors({
      capabilities: input.current.capabilities,
      selections: selection.options,
    }),
    ultrathinkPromptControlled: input.ultrathinkPromptControlled ?? false,
    favoriteKeys: input.favoriteKeys ?? null,
    disabled: input.disabled ?? false,
    permissionsLabel: input.permissionsLabel,
    labels: LABELS,
  });
}

function section(menu: ComposerModelMenu, id: string): MenuAction | undefined {
  return menu.actions.find((action) => action.id === id);
}

function allIds(actions: ReadonlyArray<MenuAction>): string[] {
  return actions.flatMap((action) => [action.id ?? "", ...allIds(action.subactions ?? [])]);
}

function checked(actions: ReadonlyArray<MenuAction> | undefined): string[] {
  return (actions ?? []).filter((action) => action.state === "on").map((action) => action.title);
}

describe("buildComposerModelMenu", () => {
  it("offers a Codex model's effort levels and service-tier Fast toggle", () => {
    const current = option("codex", "gpt-next", { descriptors: CODEX_DESCRIPTORS });
    const menu = build({ options: [current], current });

    const reasoning = section(menu, "reasoning");
    expect(reasoning?.title).toBe("Reasoning");
    expect(reasoning?.displayInline).toBe(true);
    expect(reasoning?.subactions?.map((action) => action.title)).toEqual(["Low", "Medium", "High"]);
    expect(checked(reasoning?.subactions)).toEqual(["Medium"]);
    expect(reasoning?.subactions?.[2]?.subtitle).toBe("Slower, more thorough");
    expect(menu.intents.get("reasoning:2")).toMatchObject({ kind: "option", value: "high" });

    const fast = section(menu, "fast-mode")?.subactions?.[0];
    expect(fast).toMatchObject({ id: "fast", state: "off", image: "bolt" });
    expect(fast?.attributes?.keepsMenuPresented).toBe(true);
    expect(menu.intents.get("fast")).toMatchObject({ kind: "option", value: "priority" });
  });

  it("hides prompt-injected Ultrathink and marks it current while the prompt sets it", () => {
    const current = option("claude", "opus", { descriptors: CLAUDE_DESCRIPTORS });
    const selection = { ...current.selection, options: [{ id: "fastMode", value: true }] };

    const plain = build({ options: [current], current, selection });
    expect(section(plain, "reasoning")?.subactions?.map((action) => action.title)).toEqual([
      "Medium",
      "High",
    ]);
    expect(section(plain, "fast-mode")?.subactions?.[0]?.state).toBe("on");
    expect(plain.intents.get("fast")).toMatchObject({ kind: "option", value: false });

    const prompted = build({ options: [current], current, ultrathinkPromptControlled: true });
    const levels = section(prompted, "reasoning")?.subactions ?? [];
    expect(checked(levels)).toEqual(["Ultrathink"]);
    expect(levels[0]?.attributes?.disabled).toBe(true);
    expect(prompted.intents.has("reasoning:ultrathink")).toBe(false);
  });

  it("offers On and Off for a boolean thinking control without a Fast toggle", () => {
    const current = option("cursor", "composer", { descriptors: THINKING_TOGGLE_DESCRIPTORS });
    const menu = build({ options: [current], current });

    const reasoning = section(menu, "reasoning");
    expect(reasoning?.title).toBe("Thinking");
    expect(reasoning?.subactions?.map((action) => action.title)).toEqual(["Off", "On"]);
    expect(checked(reasoning?.subactions)).toEqual(["On"]);
    expect(section(menu, "fast-mode")).toBeUndefined();
  });

  it("omits effort and Fast for a model that declares no options", () => {
    const current = option("acp", "agent-default");
    const menu = build({ options: [current], current, permissionsLabel: "Supervised" });

    expect(section(menu, "reasoning")).toBeUndefined();
    expect(section(menu, "fast-mode")).toBeUndefined();
    expect(menu.actions.map((action) => action.id)).toEqual(["provider:acp", "thread"]);
    expect(section(menu, "thread")?.subactions?.map((action) => action.id)).toEqual([
      "runtime",
      "settings",
    ]);
    expect(section(menu, "thread")?.subactions?.[0]?.subtitle).toBe("Supervised");
  });

  it("lists one provider inline and several as provider submenus", () => {
    const current = option("codex", "gpt-next");
    const single = build({ options: [current, option("codex", "gpt-mini")], current });
    const inline = section(single, "provider:codex");
    expect(inline).toMatchObject({ title: "CODEX", displayInline: true });
    expect(checked(inline?.subactions)).toEqual(["gpt-next"]);

    const multi = build({
      options: [current, option("codex", "gpt-mini"), option("claude", "opus")],
      current,
    });
    const providers = section(multi, "providers")?.subactions ?? [];
    expect(providers.map((provider) => [provider.id, provider.title, provider.subtitle])).toEqual([
      ["provider:codex", "CODEX", "gpt-next"],
      ["provider:claude", "CLAUDE", undefined],
    ]);
    expect(providers[1]?.displayInline).toBeUndefined();
    expect(multi.intents.get("model:claude:opus")).toMatchObject({ kind: "model" });
  });

  it("drops hidden and stale legacy models but keeps the current one", () => {
    const current = option("codex", "old-current", { isLegacy: true });
    const menu = build({
      options: [
        current,
        option("codex", "old-other", { isLegacy: true }),
        option("codex", "secret", { isHidden: true }),
        option("codex", "gpt-next"),
      ],
      current,
    });
    expect(section(menu, "provider:codex")?.subactions?.map((action) => action.title)).toEqual([
      "old-current",
      "gpt-next",
    ]);
  });

  it("disables unavailable models, and every change while the composer is locked", () => {
    const current = option("codex", "gpt-next", { descriptors: CODEX_DESCRIPTORS });
    const offline = option("codex", "gpt-offline", { isUnavailable: true });
    const open = build({ options: [current, offline], current });
    const models = section(open, "provider:codex")?.subactions ?? [];
    expect(models.map((action) => action.attributes?.disabled === true)).toEqual([false, true]);

    const locked = build({ options: [current, offline], current, disabled: true });
    const disabledIds = allIds(locked.actions).filter((id) => {
      const find = (actions: ReadonlyArray<MenuAction>): MenuAction | undefined =>
        actions
          .map((action) => (action.id === id ? action : find(action.subactions ?? [])))
          .find(Boolean);
      return find(locked.actions)?.attributes?.disabled === true;
    });
    expect(disabledIds).toEqual([
      "reasoning:0",
      "reasoning:1",
      "reasoning:2",
      "fast",
      "model:codex:gpt-next",
      "model:codex:gpt-offline",
    ]);
  });

  it("disables effort and Fast when the current model is unavailable", () => {
    const current = option("codex", "gpt-next", {
      descriptors: CODEX_DESCRIPTORS,
      isUnavailable: true,
    });
    const menu = build({ options: [current], current });
    expect(
      section(menu, "reasoning")?.subactions?.every((action) => action.attributes?.disabled),
    ).toBe(true);
    expect(section(menu, "fast-mode")?.subactions?.[0]?.attributes?.disabled).toBe(true);
  });

  it("shows loaded favorites with their provider, under ids distinct from the provider list", () => {
    const current = option("codex", "gpt-next");
    const opus = option("claude", "opus", { subtitle: "Bedrock" });
    const options = [current, option("codex", "gpt-mini"), opus];

    expect(section(build({ options, current }), "favorites")).toBeUndefined();

    const menu = build({ options, current, favoriteKeys: new Set([opus.key, "gone:model"]) });
    const favorites = section(menu, "favorites");
    expect(favorites?.title).toBe("Favorites");
    expect(favorites?.subactions?.map((action) => [action.id, action.subtitle])).toEqual([
      ["favorite:claude:opus", "CLAUDE · Bedrock"],
    ]);
    const ids = allIds(menu.actions);
    expect(new Set(ids).size).toBe(ids.length);
    expect(menu.intents.get("favorite:claude:opus")).toMatchObject({ kind: "model", option: opus });
  });

  it("caps long catalogs, keeps the current model, and ends with More models", () => {
    const models = Array.from({ length: COMPOSER_MENU_MODELS_PER_PROVIDER + 5 }, (_, index) =>
      option("opencode", `model-${index}`),
    );
    const current = models.at(-1)!;
    const menu = build({ options: models, current });
    const list = section(menu, "provider:opencode")?.subactions ?? [];

    expect(list).toHaveLength(COMPOSER_MENU_MODELS_PER_PROVIDER + 2);
    expect(list.at(-2)?.title).toBe(current.label);
    expect(list.at(-1)).toMatchObject({ id: "more:opencode", title: "More models…" });
    expect(menu.intents.get("more:opencode")).toEqual({ kind: "settings" });
  });
});
