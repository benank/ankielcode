import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@ankielcode/contracts";
import { createModelCapabilities } from "@ankielcode/shared/model";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  ComposerEffortControls,
  ComposerFastToggle,
  describeComposerEffort,
} from "./ComposerModelEffort";
import { ComposerPickerCompactContext } from "./ProviderModelPicker";
import type { TraitsSelectionInput } from "./TraitsPicker";

// Shaped like Devin over ACP: its session mode comes first, and its reasoning id is its own.
const models: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "fusion",
    name: "Fusion (Claude Opus 5.5 Medium + SWE-2 High)",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        {
          id: "mode",
          label: "Session Mode",
          type: "select",
          currentValue: "bypass",
          options: [
            { id: "code", label: "Code" },
            { id: "plan", label: "Plan" },
            { id: "bypass", label: "Bypass Permissions" },
          ],
        },
        {
          id: "thought_level",
          label: "Thinking",
          type: "select",
          role: "reasoning",
          currentValue: "medium",
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
        {
          id: "speed",
          label: "Speed",
          type: "select",
          currentValue: "standard",
          options: [
            { id: "standard", label: "Standard" },
            { id: "fast", label: "Fast" },
          ],
        },
        {
          id: "serviceTier",
          label: "Service Tier",
          type: "select",
          currentValue: "default",
          options: [
            { id: "default", label: "Standard" },
            { id: "priority", label: "Fast" },
          ],
        },
        { id: "auto_approve", label: "Auto-approve tools", type: "boolean", currentValue: false },
      ],
    }),
  },
];

function traitsInput(
  modelOptions: ReadonlyArray<ProviderOptionSelection>,
  onModelOptionsChange: (next: ReadonlyArray<ProviderOptionSelection> | undefined) => void,
): TraitsSelectionInput {
  return {
    provider: ProviderDriverKind.make("acpRegistry"),
    instanceId: ProviderInstanceId.make("devin"),
    models,
    model: "fusion",
    modelOptions,
    onModelOptionsChange,
  };
}

function Column({ compact = false }: { compact?: boolean }) {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection>>([]);
  const traits = traitsInput(options, (next) => setOptions(next ?? []));
  return (
    <>
      <div data-model-picker-effort>
        <ComposerPickerCompactContext value={compact}>
          <ComposerEffortControls traits={traits} />
        </ComposerPickerCompactContext>
      </div>
      <ComposerFastToggle traits={traits} />
      <p role="status">{describeComposerEffort(traits, "bars", "sm").suffix}</p>
    </>
  );
}

it("draws an agent's reasoning as bars and keeps its mode out of the levels", async () => {
  await using screen = await render(<Column />, { router: false }); // no routes involved
  const status = screen.getByRole("status");
  expect(status.element().querySelector("[data-composer-effort-glyph]")).not.toBeNull();
  await expect.element(status).toHaveTextContent("");

  const slider = screen.getByRole("slider", { name: "Thinking" });
  await expect.element(slider).not.toBeInTheDocument();

  await userEvent.tab();
  await userEvent.keyboard("{ArrowDown}");
  const speed = screen.getByRole("button", { name: "Speed: Standard" });
  await expect.element(speed).toHaveFocus();
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("menuitemradio", { name: "Standard" })).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
  await expect.element(speed).toHaveFocus();

  await userEvent.click(screen.getByText("Auto-approve tools"));
  await expect
    .element(screen.getByRole("switch", { name: "Auto-approve tools" }))
    .toHaveAttribute("aria-checked", "true");

  await userEvent.click(screen.getByRole("button", { name: "Session Mode: Bypass Permissions" }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "Plan" }));
  await expect
    .element(screen.getByRole("button", { name: "Session Mode: Plan" }))
    .toBeInTheDocument();
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
});

it("steps through the provider's reasoning levels with the slider keys", async () => {
  await using screen = await render(<Column compact />, { router: false }); // no routes involved
  const slider = screen.getByRole("slider", { name: "Thinking" });
  await userEvent.tab();
  await expect.element(slider).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(slider).toHaveAttribute("aria-valuetext", "Low");
  await userEvent.keyboard("{End}");
  await expect.element(slider).toHaveAttribute("aria-valuetext", "High");
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(slider).toHaveAttribute("aria-valuetext", "Medium");
});

it("toggles the service tier with one bolt button", async () => {
  await using screen = await render(<Column compact />, { router: false }); // no routes involved
  const toggle = screen.getByRole("button", { name: "Fast mode" });
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
});
