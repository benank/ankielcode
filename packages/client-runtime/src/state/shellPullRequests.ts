import { OrchestrationV2ShellSnapshot } from "@ankielcode/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/**
 * Removes each parsed thread row's pull request links from `snapshot` in place. Clients no longer
 * show them, and older servers and caches still send them, so they are dropped before decoding.
 */
export function stripShellPullRequests(snapshot: unknown): void {
  if (!Predicate.isObject(snapshot)) return;
  const rows: unknown = snapshot.threads;
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (Predicate.isObject(row)) delete row.pullRequests;
  }
}

const decodeShellSnapshotJson = Schema.decodeUnknownEffect(
  Schema.toCodecJson(OrchestrationV2ShellSnapshot),
);

export const decodeShellSnapshotWithoutPullRequests = Effect.fnUntraced(function* (json: unknown) {
  stripShellPullRequests(json);
  return yield* decodeShellSnapshotJson(json);
});
