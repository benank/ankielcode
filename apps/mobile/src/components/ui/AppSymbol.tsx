import IconGitBranch from "@tabler/icons-react-native/IconGitBranch";
import IconGitMerge from "@tabler/icons-react-native/IconGitMerge";
import IconGitCommit from "@tabler/icons-react-native/IconGitCommit";
import IconGitPullRequestClosed from "@tabler/icons-react-native/IconGitPullRequestClosed";
import IconGitPullRequestDraft from "@tabler/icons-react-native/IconGitPullRequestDraft";
import type { AnimationSpec, SFSymbol, SymbolViewProps } from "expo-symbols";
import IconCircleDot from "@tabler/icons-react-native/IconCircleDot";
import IconGitPullRequest from "@tabler/icons-react-native/IconGitPullRequest";
import IconFileDiff from "@tabler/icons-react-native/IconFileDiff";
import IconRobot from "@tabler/icons-react-native/IconRobot";
import { SymbolView as ExpoSymbolView } from "expo-symbols";
import { useState } from "react";
import { withUniwind } from "uniwind";

import { useReduceMotionEnabled } from "../../lib/appState";
import type { AppSymbolViewProps } from "./AppSymbol.android";

export type { SFSymbol } from "expo-symbols";
export type { AppSymbolName, AppSymbolViewProps } from "./AppSymbol.android";

const CUSTOM_ICONS = {
  "file.diff": IconFileDiff,
  "arrow.triangle.pull": IconGitPullRequest,
  "arrow.triangle.merge": IconGitMerge,
  "arrow.triangle.branch": IconGitBranch,
  "arrow.branch": IconGitBranch,
  "git.pull-request.closed": IconGitPullRequestClosed,
  "git.pull-request.draft": IconGitPullRequestDraft,
  "git.commit": IconGitCommit,
  "git.issue": IconCircleDot,
  robot: IconRobot,
};

const BOUNCE: AnimationSpec = { effect: { type: "bounce" } };

function AppSymbolView({ bounce, ...props }: AppSymbolViewProps) {
  const name = typeof props.name === "string" ? props.name : props.name.ios;
  const CustomIcon = CUSTOM_ICONS[name as keyof typeof CUSTOM_ICONS];
  if (CustomIcon) {
    return (
      <CustomIcon
        accessibilityLabel={props.accessibilityLabel}
        color={props.tintColor}
        size={props.size}
        strokeWidth={2}
        style={props.style}
        testID={props.testID}
      />
    );
  }

  if (bounce === undefined) return <ExpoSymbolView {...props} name={name as SFSymbol} />;
  return <BouncingSymbolView {...props} name={name as SFSymbol} bounce={bounce} />;
}

// The native view replays its effect on every prop update while a spec is set,
// so the spec is present only while `bounce` is true, and never for a mount that starts true.
function BouncingSymbolView({ bounce, ...props }: SymbolViewProps & { bounce: boolean }) {
  const reduceMotion = useReduceMotionEnabled();
  const [armed, setArmed] = useState(!bounce);
  if (!bounce && !armed) setArmed(true);
  return (
    <ExpoSymbolView
      {...props}
      animationSpec={bounce && armed && !reduceMotion ? BOUNCE : undefined}
    />
  );
}

export const SymbolView = withUniwind(AppSymbolView);
