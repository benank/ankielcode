import { StoredOrchestrationShellSnapshot } from "@ankielcode/client-runtime/platform";
import { stripShellPullRequests } from "@ankielcode/client-runtime/state/shell";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeStoredShell = Schema.decodeUnknownEffect(StoredOrchestrationShellSnapshot);

/** Caches from older builds still hold pull request links, which are dropped unread. */
export const decodeStoredShellSnapshot = Effect.fnUntraced(function* (raw: string) {
  const parsed = yield* decodeJson(raw);
  if (Predicate.isObject(parsed)) stripShellPullRequests(parsed.snapshot);
  return yield* decodeStoredShell(parsed);
});
