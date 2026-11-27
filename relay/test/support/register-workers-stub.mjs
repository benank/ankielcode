import * as NodeModule from "node:module";

const stubUrl = new URL("./workers-stub.mjs", import.meta.url).href;

NodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: stubUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
