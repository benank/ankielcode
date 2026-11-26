import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const SERVER_TRACKER_DETAILS = [msg("Issues cannot be browsed for this host yet.")];

/** A tracker's `detail` from the issue list, translated when it is a fixed server line. */
export function issueTrackerDetailText(detail: string, resolve: MFunctionType = mFallback): string {
  const known = SERVER_TRACKER_DETAILS.find((candidate) => mFallback(candidate) === detail);
  return known === undefined ? detail : resolve(known);
}
