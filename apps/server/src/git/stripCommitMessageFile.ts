// @effect-diagnostics nodeBuiltinImport:off -- Fast CLI path runs before the Effect runtime loads.
import * as NodeFS from "node:fs";

import { stripCommitMessageFileContent } from "@ankielcode/shared/commitMessage";

export function runStripCommitMessageFile(filePath: string | undefined): void {
  if (!filePath) return;
  let original: string;
  try {
    original = NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  const cleaned = stripCommitMessageFileContent(original);
  if (cleaned !== original) {
    NodeFS.writeFileSync(filePath, cleaned, "utf8");
  }
}
