import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ reduceMotion: false }));

vi.mock("expo-symbols", () => ({
  SymbolView: (props: { readonly animationSpec?: object }) => (
    <i data-animated={props.animationSpec ? "yes" : "no"} />
  ),
}));
vi.mock("uniwind", () => ({ withUniwind: <T,>(component: T) => component }));
vi.mock("../../lib/appState", () => ({ useReduceMotionEnabled: () => harness.reduceMotion }));
vi.mock("@tabler/icons-react-native/IconGitBranch", () => ({ default: () => null }));
vi.mock("@tabler/icons-react-native/IconGitMerge", () => ({ default: () => null }));
vi.mock("@tabler/icons-react-native/IconGitCommit", () => ({ default: () => null }));
vi.mock("@tabler/icons-react-native/IconGitPullRequestClosed", () => ({ default: () => null }));
vi.mock("@tabler/icons-react-native/IconGitPullRequestDraft", () => ({ default: () => null }));
vi.mock("@tabler/icons-react-native/IconCircleDot", () => ({ default: () => null }));
vi.mock("@tabler/icons-react-native/IconGitPullRequest", () => ({ default: () => null }));
vi.mock("@tabler/icons-react-native/IconFileDiff", () => ({ default: () => null }));
vi.mock("@tabler/icons-react-native/IconRobot", () => ({ default: () => null }));

import { SymbolView } from "./AppSymbol";

it("bounces only when bounce turns true after mount, and not under Reduce Motion", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const animatedAfter = (bounce: boolean) => {
    act(() => root.render(<SymbolView name="star" bounce={bounce} />));
    return container.querySelector("i")?.getAttribute("data-animated");
  };
  try {
    harness.reduceMotion = false;
    const states = [animatedAfter(true), animatedAfter(false), animatedAfter(true)];
    harness.reduceMotion = true;
    states.push(animatedAfter(false), animatedAfter(true));

    expect(states).toEqual(["no", "no", "yes", "no", "no"]);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
