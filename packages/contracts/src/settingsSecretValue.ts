import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";

import { TrimmedString } from "./baseSchemas.ts";
import { SecretReference } from "./secretReference.ts";

/**
 * A credential setting: the literal, which is kept in the secret store and redacted for
 * clients. Builds that read secrets from a secret provider (1Password) could also store a
 * reference to one, which this build still decodes but cannot read: forms show it as
 * unsupported, and its consumer fails with `SettingsSecretUnresolvedError`.
 */
export const SettingsSecretValue = Schema.Union([TrimmedString, SecretReference]).pipe(
  Schema.annotateKey({ settingsSecret: true, settingsSecretReference: true }),
);
export type SettingsSecretValue = typeof SettingsSecretValue.Type;

export const isSecretReference = Schema.is(SecretReference);

/** Whether a reference appears anywhere in `value`, such as a settings patch or an RPC payload. */
export function containsSecretReference(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (isSecretReference(value)) return true;
  return Object.values(value).some(containsSecretReference);
}

/** The literal a credential setting holds, or `""` when it names a secret instead. */
export function settingsSecretLiteral(value: SettingsSecretValue | undefined): string {
  return typeof value === "string" ? value : "";
}

export class SettingsSecretUnresolvedError extends Schema.TaggedError<SettingsSecretUnresolvedError>()(
  "SettingsSecretUnresolvedError",
  { provider: Schema.String },
) {
  override get message(): string {
    return `This credential is read from the secret provider "${this.provider}", which Ankiel Code no longer supports. Enter the value in Settings, then try again.`;
  }
}

/**
 * The literal a credential setting holds. A reference to a secret provider cannot be read, and
 * fails instead of passing for a missing token, so callers that would fall back to another
 * credential cannot silently switch accounts.
 */
export const requireSettingsSecretLiteral = (
  value: SettingsSecretValue | undefined,
): Effect.Effect<string, SettingsSecretUnresolvedError> =>
  isSecretReference(value)
    ? Effect.fail(new SettingsSecretUnresolvedError({ provider: value.provider }))
    : Effect.succeed(value ?? "");

export function acceptsSecretReference(schema: Schema.Top): boolean {
  return Schema.resolveAnnotationsKey(schema)?.settingsSecretReference === true;
}

const declaresSecretReference = (ast: SchemaAST.AST) =>
  ast.context?.annotations?.settingsSecretReference === true;

interface SecretReferenceField {
  readonly field: string;
  readonly keyed: boolean;
}

/**
 * Fields of a settings struct typed `SettingsSecretValue`, or a record of it such as one value
 * per host; any other schema has none.
 */
function secretReferenceSettingsFields(schema: Schema.Top): ReadonlyArray<SecretReferenceField> {
  if (!SchemaAST.isObjects(schema.ast)) return [];
  return schema.ast.propertySignatures.flatMap<SecretReferenceField>(({ name, type }) => {
    if (typeof name !== "string") return [];
    if (declaresSecretReference(type)) return [{ field: name, keyed: false }];
    return SchemaAST.isObjects(type) &&
      type.indexSignatures.some((signature) => declaresSecretReference(signature.type))
      ? [{ field: name, keyed: true }]
      : [];
  });
}

/** Where a reference sits: a field, or one key of a record field. */
export interface SettingsSecretSlot {
  readonly field: string;
  readonly key: string | undefined;
}

interface SettingsSecretReference extends SettingsSecretSlot {
  readonly reference: SecretReference;
}

/** Each declared reference slot of `settings` that holds a reference, in field order. */
export function secretReferencesInSettings(
  schema: Schema.Top,
  settings: unknown,
): ReadonlyArray<SettingsSecretReference> {
  if (settings === null || typeof settings !== "object") return [];
  const values = settings as Readonly<Record<string, unknown>>;
  return secretReferenceSettingsFields(schema).flatMap<SettingsSecretReference>(
    ({ field, keyed }) => {
      const value = values[field];
      if (!keyed)
        return isSecretReference(value) ? [{ field, key: undefined, reference: value }] : [];
      if (value === null || typeof value !== "object") return [];
      return Object.entries(value).flatMap(([key, entry]) =>
        isSecretReference(entry) ? [{ field, key, reference: entry }] : [],
      );
    },
  );
}
