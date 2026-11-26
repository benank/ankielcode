import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
} from "@ankielcode/contracts";
import { collectProviderUsageLimits } from "@ankielcode/shared/usageLimits";

export function resolveThreadDetailsLimits(
  providerInstanceId: ProviderInstanceId | null,
  providers: readonly ServerProvider[],
  now: number,
): ServerProviderUsageLimits | null {
  const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
  if (!provider) return null;
  const report = collectProviderUsageLimits(provider.instanceId, providers, now);
  // Only this instance's data: the report keeps one instance per login, and any other entry may be
  // a different login or workspace, so fall back to the instance's own snapshot.
  return (
    report?.accounts.find((entry) => entry.instanceId === provider.instanceId)?.limits ??
    provider.usageLimits ??
    null
  );
}
