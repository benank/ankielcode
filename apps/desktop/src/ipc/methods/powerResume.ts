import * as Effect from "effect/Effect";

import * as ElectronPowerMonitor from "../../electron/ElectronPowerMonitor.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { POWER_RESUME_CHANNEL } from "../channels.ts";

/** Tells every window the system woke from sleep, so each renderer can reconnect. */
export const installPowerResume = Effect.fn("desktop.ipc.installPowerResume")(function* () {
  const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  yield* powerMonitor.onSimpleEvent("resume", () => {
    void runFork(electronWindow.sendAll(POWER_RESUME_CHANNEL));
  });
});
