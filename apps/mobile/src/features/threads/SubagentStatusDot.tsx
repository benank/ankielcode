import { View } from "react-native";

import { PixelStatus } from "../../components/PixelStatus";
import { cn } from "../../lib/cn";
import type { SubagentRowTone } from "./threadAgentsPresentation";

const TONE_CLASS = {
  working: "bg-adaptive-sky-600-400",
  completed: "bg-adaptive-emerald-600-400",
  failed: "bg-adaptive-rose-600-400",
  stopped: "bg-foreground-muted",
} as const satisfies Record<SubagentRowTone, string>;

export const SUBAGENT_TONE_TEXT_CLASS = {
  working: "text-adaptive-sky-600-400",
  completed: "text-adaptive-emerald-600-400",
  failed: "text-adaptive-rose-600-400",
  stopped: "text-foreground-muted",
} as const satisfies Record<SubagentRowTone, string>;

export function SubagentStatusDot({
  tone,
  placement = "inline",
}: {
  readonly tone: SubagentRowTone;
  readonly placement?: "inline" | "sheet";
}) {
  // A working agent shows the sidebar's pixel light; its name carries no status word.
  if (tone === "working") return <PixelStatus kind="working" />;
  return (
    <View
      className={cn(
        "shrink-0 rounded-full",
        placement === "sheet" ? "h-2 w-2" : "h-1.5 w-1.5",
        TONE_CLASS[tone],
      )}
    />
  );
}
