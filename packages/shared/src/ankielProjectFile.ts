import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { AnkielProjectFile, AC_PROJECT_FILE_SCHEMA_URL } from "@ankielcode/contracts";

import { fromLenientJson } from "./schemaJson.ts";

export const AnkielProjectFileFromJson = fromLenientJson(AnkielProjectFile);

const decodeAnkielProjectFile = Schema.decodeExit(AnkielProjectFileFromJson);

export function parseAnkielProjectFile(contents: string): AnkielProjectFile | null {
  const decoded = decodeAnkielProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

export function buildAnkielProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(AnkielProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: AC_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
