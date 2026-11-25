import { useMemo } from "react";

import type { HeaderUsageLimitsControl } from "./useHeaderUsageLimitsControl";
import { HeaderUsageLimitsButton } from "./HeaderUsageLimits";

export function useHeaderUsageLimitsControl(): HeaderUsageLimitsControl {
  return useMemo(() => ({ trailing: <HeaderUsageLimitsButton /> }), []);
}
