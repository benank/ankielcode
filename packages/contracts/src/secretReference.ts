import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// Separate module avoids an import cycle between settings and provider instance contracts.
// Final once shipped: older builds drop entries whose key fails here, and erase them on their next save.
// Unlike provider slugs it may start with a digit, so a provider named "1Password" fits.
export const SecretProviderSlug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
);

export const SecretProviderId = SecretProviderSlug.pipe(Schema.brand("SecretProviderId"));
export type SecretProviderId = typeof SecretProviderId.Type;

// Provider-specific syntax is the secret provider driver's to check.
export const SecretReferencePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(/^[^\r\n]+$/),
);

/**
 * Points at a secret held by a secret provider (1Password), which older builds could read. Kept
 * so settings that still hold one decode; nothing in this build reads it.
 */
export const SecretReference = Schema.Struct({
  provider: SecretProviderId,
  reference: SecretReferencePath,
});
export type SecretReference = typeof SecretReference.Type;
