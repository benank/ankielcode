import type { PullRequestChangeBreakdown } from "@ankielcode/contracts";
import { summarizeChangedFiles } from "@ankielcode/shared/changedFileKind";
import type { ProviderFileStats } from "@ankielcode/source-control-core/server/PullRequestProvider";

export function toChangeBreakdown(stats: ProviderFileStats): PullRequestChangeBreakdown {
  if (stats.truncated) return null;
  return summarizeChangedFiles(stats.files);
}
