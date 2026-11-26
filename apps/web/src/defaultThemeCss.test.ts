// @effect-diagnostics nodeBuiltinImport:off - compares committed files on disk with what the palette renders.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  ANKIEL_CODE_DARK_THEME_COLORS,
  ANKIEL_CODE_LIGHT_THEME_COLORS,
} from "@ankielcode/shared/themePalettes";

import { DEFAULT_THEME_CSS_FILE, renderDefaultThemeCSS } from "./defaultThemeCss";

it("keeps the generated default theme in step with the shared palette", () => {
  const committed = NodeFS.readFileSync(
    NodePath.resolve(import.meta.dirname, DEFAULT_THEME_CSS_FILE),
    "utf8",
  );
  expect(committed, "run `vp run generate:default-theme` in apps/web").toBe(
    renderDefaultThemeCSS(),
  );
});

it("paints the boot splash in the default theme's colors", () => {
  const html = NodeFS.readFileSync(NodePath.resolve(import.meta.dirname, "../index.html"), "utf8");
  for (const colors of [ANKIEL_CODE_LIGHT_THEME_COLORS, ANKIEL_CODE_DARK_THEME_COLORS]) {
    expect(html).toContain(`background: "${colors.canvas}"`);
    expect(html).toContain(`foreground: "${colors.text}"`);
  }
});
