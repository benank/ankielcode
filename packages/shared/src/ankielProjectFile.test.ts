import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { parseAnkielProjectFile, AnkielProjectFileFromJson } from "./ankielProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(AnkielProjectFileFromJson);

describe("AnkielProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", "stopOnSettle": true, },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev", stopOnSettle: true });
  });
});

describe("parseAnkielProjectFile", () => {
  it("reads project defaults from JSONC with a URL in a block comment", () => {
    expect(
      parseAnkielProjectFile(`{
        /* See https://code.ankiel.com/schema/ankiel.json */
        "defaultThreadEnvMode": "worktree"
      }`),
    ).toEqual({ defaultThreadEnvMode: "worktree" });
  });
});
