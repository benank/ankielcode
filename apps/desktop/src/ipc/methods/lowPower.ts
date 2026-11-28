import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronPowerMonitor from "../../electron/ElectronPowerMonitor.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { GET_LOW_POWER_STATE_CHANNEL, LOW_POWER_STATE_CHANNEL } from "../channels.ts";

/** While this holds the renderer drops glass, the activity shimmer and animated scrolling. */
function isLowPower(
  onBattery: boolean,
  thermalState: ElectronPowerMonitor.ElectronThermalState,
): boolean {
  return onBattery || thermalState === "serious" || thermalState === "critical";
}

export const installLowPowerState = Effect.fn("desktop.ipc.installLowPowerState")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  // Thermal state is macOS-only ("unknown" elsewhere), and `on-battery` fires only on macOS,
  // so every read polls the battery and the renderer asks again whenever it regains focus.
  let thermalState = yield* powerMonitor.getCurrentThermalState;
  let published = isLowPower(yield* powerMonitor.isOnBatteryPower, thermalState);
  const refresh = Effect.gen(function* () {
    const lowPower = isLowPower(yield* powerMonitor.isOnBatteryPower, thermalState);
    if (lowPower !== published) {
      published = lowPower;
      yield* electronWindow.sendAll(LOW_POWER_STATE_CHANNEL, lowPower);
    }
    return lowPower;
  });
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const refreshLater = () => void runFork(refresh);

  yield* powerMonitor.onSimpleEvent("on-battery", refreshLater);
  yield* powerMonitor.onSimpleEvent("on-ac", refreshLater);
  yield* powerMonitor.onSimpleEvent("resume", refreshLater);
  yield* powerMonitor.onThermalStateChange((state) => {
    thermalState = state;
    refreshLater();
  });
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: GET_LOW_POWER_STATE_CHANNEL,
      payload: Schema.Void,
      result: Schema.Boolean,
      handler: () => refresh,
    }),
  );
});
