import type { SecretReference } from "@ankielcode/contracts";
import { useGT } from "gt-react";
import type { ComponentProps } from "react";

import { SecretInput } from "./SecretInput";

type SecretSourceInputProps = Omit<ComponentProps<typeof SecretInput>, "value"> & {
  readonly value: string | SecretReference;
};

/**
 * A secret entered here. Builds that read secrets from a secret provider (1Password) could save a
 * reference to one instead, which this build cannot read: it shows as unsupported until a typed
 * value replaces it.
 */
export function SecretSourceInput({ value, ...rest }: SecretSourceInputProps) {
  const gt = useGT();
  if (typeof value === "string") return <SecretInput {...rest} value={value} />;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <SecretInput {...rest} value="" aria-invalid />
      <p className="text-2xs text-destructive">
        {gt(
          "Read from the secret provider “{provider}”, which Ankiel Code no longer supports. Enter the value to replace it.",
          { provider: value.provider },
        )}
      </p>
    </div>
  );
}
