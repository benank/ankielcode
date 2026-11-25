import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";

export const layer = Layer.succeed(
  Tracer.Tracer,
  Tracer.make({
    span(options) {
      return new Tracer.NativeSpan(options);
    },
  }),
);
