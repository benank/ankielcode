import type { ProjectIconOverride } from "@ankielcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveProjectChipIcon } from "./projectIcon";

const project = (title: string, projectIcon?: ProjectIconOverride) => ({
  title,
  workspaceRoot: `/work/${title}`,
  projectIcon,
});

describe("resolveProjectChipIcon", () => {
  const favicon = () => "https://env.example/favicon.png";
  const noFavicon = () => null;

  it("shows the chat bubble for unknown threads and the no-project folder", () => {
    expect(resolveProjectChipIcon(null, "/scratch", favicon)).toBeNull();
    expect(resolveProjectChipIcon(project("scratch"), "/work/scratch", favicon)).toBeNull();
  });

  it("prefers a custom icon over the favicon", () => {
    expect(
      resolveProjectChipIcon(
        project("ankielcode", { kind: "monogram", text: "Q7", color: "violet" }),
        null,
        favicon,
      ),
    ).toEqual({ kind: "monogram", text: "Q7", color: "violet" });
    expect(
      resolveProjectChipIcon(project("ankielcode", { kind: "emoji", emoji: "🚀" }), null, favicon),
    ).toEqual({ kind: "emoji", emoji: "🚀" });
    expect(
      resolveProjectChipIcon(
        project("lucide proj", { kind: "lucide", name: "rocket", color: "emerald" }),
        null,
        favicon,
      ),
    ).toEqual({ kind: "monogram", text: "LP", color: "emerald" });
  });

  it("uses the favicon, and no generated icon without one", () => {
    expect(resolveProjectChipIcon(project("ankielcode"), null, favicon)).toEqual({
      kind: "favicon",
      uri: "https://env.example/favicon.png",
    });
    expect(resolveProjectChipIcon(project("Auto Monogram"), null, noFavicon)).toBeNull();
    expect(
      resolveProjectChipIcon(
        project("ankielcode"),
        null,
        () => "https://env.example/api/assets/project-favicon-missing",
      ),
    ).toBeNull();
  });
});
