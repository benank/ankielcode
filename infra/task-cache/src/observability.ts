import * as Axiom from "@alchemy.run/axiom";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { cacheName } from "./resources.ts";

export const Observability = Effect.gen(function* () {
  const name = yield* cacheName;
  const traces = yield* Axiom.Dataset("CacheTraces", {
    name: `${name}-traces`,
    kind: "otel:traces:v1",
    description: "Shared task cache service traces.",
    retentionDays: 30,
    useRetentionPeriod: true,
  });
  const token = yield* Axiom.ApiToken("CacheIngestToken", {
    name: `${name}-otel-ingest`,
    datasetCapabilities: Output.map(traces.name, (dataset) => ({
      [dataset]: { ingest: ["create" as const] },
    })),
  });
  return { traces, token };
});
