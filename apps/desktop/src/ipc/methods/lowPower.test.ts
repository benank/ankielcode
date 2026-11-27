import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";

import * as ElectronPowerMonitor from "../../electron/ElectronPowerMonitor.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { installLowPowerState, isLowPower } from "./lowPower.ts";

describe("isLowPower", () => {
  it("holds on battery or under serious and critical thermal pressure", () => {
    expect(isLowPower(false, "unknown")).toBe(false);
    expect(isLowPower(false, "nominal")).toBe(false);
    expect(isLowPower(false, "fair")).toBe(false);
    expect(isLowPower(false, "serious")).toBe(true);
    expect(isLowPower(false, "critical")).toBe(true);
    expect(isLowPower(true, "unknown")).toBe(true);
    expect(isLowPower(true, "nominal")).toBe(true);
  });
});

describe("installLowPowerState", () => {
  it.effect("answers the current state and broadcasts only changes", () =>
    Effect.gen(function* () {
      let onBattery = false;
      const simple = new Map<string, () => void>();
      let thermal: ((state: ElectronPowerMonitor.ElectronThermalState) => void) | undefined;
      const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
      const sent = yield* Queue.unbounded<readonly unknown[]>();
      const event = { sender: { id: 1 } };
      const get = () =>
        Effect.promise(() =>
          Promise.resolve(handlers.get("desktop:get-low-power-state")!(event, undefined)),
        );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* installLowPowerState();
          expect(yield* get()).toBe(false);

          onBattery = true;
          simple.get("on-battery")!();
          expect(yield* Queue.take(sent)).toEqual(["desktop:low-power-state", true]);
          // An event that changes nothing stays quiet: the next broadcast is the unplug's reverse.
          simple.get("resume")!();
          onBattery = false;
          simple.get("on-ac")!();
          expect(yield* Queue.take(sent)).toEqual(["desktop:low-power-state", false]);

          thermal!("serious");
          expect(yield* Queue.take(sent)).toEqual(["desktop:low-power-state", true]);
          thermal!("fair");
          expect(yield* Queue.take(sent)).toEqual(["desktop:low-power-state", false]);

          // Windows and Linux never say they unplugged; a read still finds it and tells every window.
          onBattery = true;
          expect(yield* get()).toBe(true);
          expect(yield* Queue.take(sent)).toEqual(["desktop:low-power-state", true]);
          expect(yield* get()).toBe(true);
          expect(yield* Queue.size(sent)).toBe(0);
        }),
      ).pipe(
        Effect.provide([
          Layer.succeed(
            ElectronPowerMonitor.ElectronPowerMonitor,
            ElectronPowerMonitor.ElectronPowerMonitor.of({
              isOnBatteryPower: Effect.sync(() => onBattery),
              getSystemIdleTime: Effect.succeed(0),
              getSystemIdleState: () => Effect.succeed("active"),
              getCurrentThermalState: Effect.succeed("nominal"),
              onSimpleEvent: (name, listener) =>
                Effect.acquireRelease(
                  Effect.sync(() => void simple.set(name, listener)),
                  () => Effect.sync(() => void simple.delete(name)),
                ),
              onThermalStateChange: (listener) =>
                Effect.sync(() => {
                  thermal = listener;
                }),
              onSpeedLimitChange: () => Effect.void,
            }),
          ),
          Layer.succeed(
            ElectronWindow.ElectronWindow,
            ElectronWindow.ElectronWindow.of({
              sendAll: (channel: string, ...args: readonly unknown[]) =>
                Effect.sync(() => void Queue.offerUnsafe(sent, [channel, ...args])),
            } as unknown as ElectronWindow.ElectronWindow["Service"]),
          ),
          DesktopIpc.layerTest({
            handle: (channel, handler) => {
              handlers.set(channel, handler);
            },
            removeHandler: (channel) => {
              handlers.delete(channel);
            },
            on: vi.fn(),
            removeAllListeners: vi.fn(),
          }),
        ]),
      );
      expect(simple.size).toBe(0);
      expect(handlers.size).toBe(0);
    }),
  );
});
