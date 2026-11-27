import * as Schema from "effect/Schema";

export const PushAlertKind = Schema.Literals(["completed", "failed", "approval", "input"]);
export type PushAlertKind = typeof PushAlertKind.Type;

export const PushPlatform = Schema.Literals(["ios", "android"]);
export type PushPlatform = typeof PushPlatform.Type;

export const PushApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type PushApnsEnvironment = typeof PushApnsEnvironment.Type;

const PushAlertKinds = Schema.Array(PushAlertKind).check(Schema.isMaxLength(4));
const PushLocale = Schema.String.check(Schema.isMaxLength(35));

// The relay rejects a whole batch over one malformed delivery, so tokens and ids match its patterns.
export const PushRegisterInput = Schema.Union([
  Schema.Struct({
    platform: Schema.Literal("ios"),
    token: Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{32,200}$/)),
    /** The bundle id, which APNs takes as the topic. */
    appId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/)),
    apnsEnvironment: PushApnsEnvironment,
    kinds: PushAlertKinds,
    locale: PushLocale,
  }),
  Schema.Struct({
    platform: Schema.Literal("android"),
    token: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_:.-]{1,1024}$/)),
    /** The package name. */
    appId: Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.]{0,254}$/)),
    kinds: PushAlertKinds,
    locale: PushLocale,
  }),
]);
export type PushRegisterInput = typeof PushRegisterInput.Type;

export const PushStatus = Schema.Struct({
  relayConfigured: Schema.Boolean,
  relayConnected: Schema.Boolean,
  /** What the connected relay can deliver to; false while it is disconnected. */
  available: Schema.Struct({ ios: Schema.Boolean, android: Schema.Boolean }),
  /** This session's registration. */
  registration: Schema.NullOr(
    Schema.Struct({ platform: PushPlatform, kinds: Schema.Array(PushAlertKind) }),
  ),
});
export type PushStatus = typeof PushStatus.Type;

/** Carries no cause: a failed statement can echo the device token. */
export class PushRegistrationError extends Schema.TaggedError<PushRegistrationError>()(
  "PushRegistrationError",
  { operation: Schema.Literals(["register", "unregister", "status"]) },
) {
  override get message(): string {
    return `Push notification ${this.operation} failed.`;
  }
}
