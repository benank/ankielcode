import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";

export const githubIntegrationEnabled = Effect.map(
  ServerSettings.ServerSettingsService,
  ({ getSettings }) =>
    getSettings.pipe(
      Effect.map((settings) => settings.githubIntegrationEnabled),
      Effect.orElseSucceed(() => false),
    ),
);
