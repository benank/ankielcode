import type { PixelStatusTone } from "@ankielcode/shared/pixelStatus";
import { View } from "react-native";

import { PixelStatus, STATUS_TONE_VARIABLE } from "../../components/PixelStatus";
import { cn } from "../../lib/cn";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { SubagentRowTone } from "./threadAgentsPresentation";

const DOT_TONE = {
  completed: "done",
  failed: "failed",
  stopped: "done",
} as const satisfies Record<Exclude<SubagentRowTone, "working">, PixelStatusTone>;

export function SubagentStatusDot({
  tone,
  placement = "inline",
}: {
  readonly tone: SubagentRowTone;
  readonly placement?: "inline" | "sheet";
}) {
  const { themeVariables } = useAppearancePreferences();
  // A working agent shows the sidebar's pixel light; its name carries no status word.
  if (tone === "working") return <PixelStatus kind="working" />;
  return (
    <View
      className={cn("shrink-0 rounded-full", placement === "sheet" ? "h-2 w-2" : "h-1.5 w-1.5")}
      style={{ backgroundColor: themeVariables[STATUS_TONE_VARIABLE[DOT_TONE[tone]]] }}
    />
  );
}
