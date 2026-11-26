import {
  type DesktopUpdateChannel,
  type ServerConfig,
  ServerReleaseError,
} from "@ankielcode/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";

import { environmentSummaries } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { serverEnvironment } from "./server";

const isServerReleaseError = Schema.is(ServerReleaseError);

function unsupportedLookup(config: ServerConfig | null): ServerReleaseError | null {
  if (config === null) {
    return new ServerReleaseError({
      reason: m(msg("Connect to this server to check releases.")),
    });
  }
  return config.environment.capabilities.releaseLookup === true
    ? null
    : new ServerReleaseError({
        reason: m(msg("This server cannot check releases. Update it before switching tracks.")),
      });
}

export function serverReleaseFailureMessage(
  cause: Cause.Cause<unknown>,
  resolve: MessageResolver = m,
): string {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  return isServerReleaseError(error)
    ? error.message
    : resolve(
        msg(
          "Could not check Ankiel Code releases from this environment. Check its internet connection.",
        ),
      );
}

export const serverReleaseAtom = Atom.family((channel: DesktopUpdateChannel) =>
  Atom.make((get) => {
    const primary = get(primaryEnvironmentIdAtom);
    // With the desktop's local server turned off there is no primary, so a connected server answers.
    const candidates =
      primary === null ? get(environmentSummaries.connectedEnvironmentIdsAtom) : [primary];
    const environmentId =
      candidates.find(
        (id) => unsupportedLookup(get(serverEnvironment.configValueAtom(id))) === null,
      ) ?? candidates[0];
    if (environmentId === undefined) {
      return Effect.fail(
        new ServerReleaseError({ reason: m(msg("Connect to a server to check releases.")) }),
      );
    }
    const unsupported = unsupportedLookup(get(serverEnvironment.configValueAtom(environmentId)));
    if (unsupported !== null) return Effect.fail(unsupported);
    return get
      .result(serverEnvironment.release({ environmentId, input: { channel } }))
      .pipe(
        Effect.map((release) =>
          release === null
            ? null
            : { version: release.version, databaseMigration: release.databaseMigration },
        ),
      );
  }).pipe(Atom.withLabel(`server-release:${channel}`)),
);
