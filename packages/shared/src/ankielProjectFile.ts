import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { AnkielProjectFile } from "@ankielcode/contracts";

import { fromLenientJson } from "./schemaJson.ts";

export const AnkielProjectFileFromJson = fromLenientJson(AnkielProjectFile);

const decodeAnkielProjectFile = Schema.decodeExit(AnkielProjectFileFromJson);

export function parseAnkielProjectFile(contents: string): AnkielProjectFile | null {
  const decoded = decodeAnkielProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}
