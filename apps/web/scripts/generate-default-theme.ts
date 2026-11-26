#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { DEFAULT_THEME_CSS_FILE, renderDefaultThemeCSS } from "../src/defaultThemeCss.ts";

NodeFS.writeFileSync(
  NodePath.resolve(import.meta.dirname, "../src", DEFAULT_THEME_CSS_FILE),
  renderDefaultThemeCSS(),
);
