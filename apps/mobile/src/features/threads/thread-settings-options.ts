import type { RuntimeMode } from "@ankielcode/contracts";
import { msg } from "gt-react-native";

export const RUNTIME_MODE_CHOICES: ReadonlyArray<{
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "approval-required",
    label: msg("Supervised"),
    description: msg("Ask before commands and file changes."),
  },
  {
    mode: "auto-accept-edits",
    label: msg("Auto-accept edits"),
    description: msg("Auto-approve edits, ask before other actions."),
  },
  {
    mode: "auto",
    label: msg("Auto"),
    description: msg("Supported providers approve routine actions; others still ask."),
  },
  {
    mode: "full-access",
    label: msg("Full access"),
    description: msg("Allow commands and edits without prompts."),
  },
];

export function runtimeModeChoicesForSupportedModes(
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
) {
  return supportedRuntimeModes && supportedRuntimeModes.length > 0
    ? RUNTIME_MODE_CHOICES.filter((choice) => supportedRuntimeModes.includes(choice.mode))
    : RUNTIME_MODE_CHOICES;
}

export type RuntimeModeChoice = (typeof RUNTIME_MODE_CHOICES)[number];

export function compatibleRuntimeModeForChoices(
  runtimeMode: RuntimeMode,
  choices: ReadonlyArray<{ readonly mode: RuntimeMode }>,
): RuntimeMode {
  return choices.some((choice) => choice.mode === runtimeMode)
    ? runtimeMode
    : (choices[0]?.mode ?? runtimeMode);
}

export { selectableProviderOptionChoices as selectableChoices } from "@ankielcode/client-runtime/model-traits";
