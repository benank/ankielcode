import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@ankielcode/provider-core/server/runtimeInstructions";

import {
  ANKIEL_CODE_BROWSER_TOOL_INSTRUCTIONS,
  ANKIEL_CODE_DEVICE_TOOL_INSTRUCTIONS,
  ANKIEL_CODE_ORCHESTRATION_SECTIONS,
} from "@ankielcode/provider-core/server/orchestrationInstructions";

export interface AnkielCodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | AnkielCodeToolAvailability,
): AnkielCodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/** Instructions for unavailable tools would steer the model away from its remaining automation. */
const toolInstructions = (availability: boolean | AnkielCodeToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    tools.browser ? ANKIEL_CODE_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.device ? ANKIEL_CODE_DEVICE_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | AnkielCodeToolAvailability = true,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      ANKIEL_CODE_ORCHESTRATION_SECTIONS.map((section, index) => [
        `ankiel_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    ankiel_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    ...(tools ? { ankiel_code_tools: { kind: "application", value: tools } } : {}),
  };
}
