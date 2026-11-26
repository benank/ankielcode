import { isSecretReference } from "@ankielcode/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/**
 * Why a credential field shows empty when an older build saved a secret provider reference in
 * it, or null when it holds a typed value.
 */
export function unsupportedSecretNotice(
  value: unknown,
  resolve: MFunctionType = mFallback,
): string | null {
  return isSecretReference(value)
    ? resolve(
        msg(
          "Read from the secret provider “{provider}”, which Ankiel Code no longer supports. Enter the value to replace it.",
          { provider: value.provider },
        ),
      )
    : null;
}
