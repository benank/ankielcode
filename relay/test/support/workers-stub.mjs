// Minimal stand-in for `cloudflare:workers` so RelayRoom can be unit-tested under Node.
// oxlint-disable-next-line typescript/no-extraneous-class -- mirrors the runtime base class RelayRoom extends.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
