import * as Effect from "effect/Effect";

// Canonicalized thread pull request links. Migration 114 removes those links, so a database that
// has not run this yet has nothing left to canonicalize.
export default Effect.void;
