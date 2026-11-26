import {
  type SourceControlAppAccess,
  type SourceControlAppAccessInput,
  SourceControlSignInError,
  type SourceControlSignInInput,
  type SourceControlSignInPrompt,
  type SourceControlSignInResult,
  type SourceControlStarredInput,
} from "@ankielcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { githubIntegrationEnabled } from "./githubIntegrationEnabled.ts";
import * as SourceControlBuiltInDrivers from "./builtInDrivers.ts";

/** Signs the server in to a forge through the forge's own app, and reads what its account did. */
export class SourceControlSignIn extends Context.Service<
  SourceControlSignIn,
  {
    readonly start: (
      input: SourceControlSignInInput,
    ) => Effect.Effect<SourceControlSignInPrompt, SourceControlSignInError>;
    readonly wait: (
      input: SourceControlSignInInput,
    ) => Effect.Effect<SourceControlSignInResult, SourceControlSignInError>;
    readonly cancel: (
      input: SourceControlSignInInput,
    ) => Effect.Effect<void, SourceControlSignInError>;
    readonly access: (input: SourceControlAppAccessInput) => Effect.Effect<SourceControlAppAccess>;
    readonly starred: (input: SourceControlStarredInput) => Effect.Effect<boolean>;
    readonly star: (input: SourceControlStarredInput) => Effect.Effect<boolean>;
  }
>()("@ankielcode/server/sourceControl/SourceControlSignIn") {}

const make = Effect.gen(function* () {
  const drivers = yield* SourceControlBuiltInDrivers.SourceControlDrivers;

  const githubEnabled = yield* githubIntegrationEnabled;
  const driverFor = (provider: SourceControlSignInInput["provider"]) =>
    (provider === "github" ? githubEnabled : Effect.succeed(true)).pipe(
      Effect.map((enabled) =>
        enabled ? drivers.find(({ driver }) => driver.kind === provider)?.instance : undefined,
      ),
    );

  const signInFor = Effect.fnUntraced(function* (input: SourceControlSignInInput) {
    const signIn = (yield* driverFor(input.provider))?.signIn;
    return signIn === undefined
      ? yield* new SourceControlSignInError({
          provider: input.provider,
          host: input.host,
          reason: "unsupported",
          detail:
            input.provider === "github"
              ? "Enable GitHub integration in Settings."
              : `This server cannot sign in to ${input.provider}. Use a token or the host's CLI.`,
        })
      : signIn;
  });

  return SourceControlSignIn.of({
    start: Effect.fn("SourceControlSignIn.start")(function* (input) {
      return yield* (yield* signInFor(input)).start(input.host);
    }),
    wait: Effect.fn("SourceControlSignIn.wait")(function* (input) {
      return yield* (yield* signInFor(input)).wait(input.host);
    }),
    cancel: Effect.fn("SourceControlSignIn.cancel")(function* (input) {
      return yield* (yield* signInFor(input)).cancel(input.host);
    }),
    access: Effect.fn("SourceControlSignIn.access")(function* (input) {
      const signIn = (yield* driverFor(input.provider))?.signIn;
      return {
        status:
          signIn === undefined ? "signed-out" : yield* signIn.access(input.host, input.repository),
      } satisfies SourceControlAppAccess;
    }),
    starred: Effect.fn("SourceControlSignIn.starred")(function* (input) {
      const isStarred = (yield* driverFor(input.provider))?.isRepositoryStarred;
      return isStarred === undefined ? false : yield* isStarred(input.host, input.repository);
    }),
    star: Effect.fn("SourceControlSignIn.star")(function* (input) {
      const star = (yield* driverFor(input.provider))?.starRepository;
      return star === undefined ? false : yield* star(input.host, input.repository);
    }),
  });
});

export const layer = Layer.effect(SourceControlSignIn, make);
