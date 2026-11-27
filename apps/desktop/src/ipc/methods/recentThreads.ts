import { DesktopRecentThreadsSchema, type DesktopRecentThread } from "@ankielcode/contracts";
import * as HostProcess from "@ankielcode/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopWebLinks from "../../app/DesktopWebLinks.ts";
import { onLocaleChange } from "../../i18n/messages.ts";
import { recentThreadsDockMenu, recentThreadsJumpList } from "../../window/DesktopRecentThreads.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/**
 * The renderer reports its recent threads; macOS shows them in the dock menu and Windows in the
 * jump list. Picking one opens its thread link, as if the OS had handed it over.
 */
export const installRecentThreads = Effect.fn("desktop.ipc.installRecentThreads")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const ipc = yield* DesktopIpc.DesktopIpc;
  const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
  const program = yield* HostProcess.ExecutablePath;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  let threads: ReadonlyArray<DesktopRecentThread> = [];

  // Linux has no dock menu or jump list, so the list is accepted and ignored there.
  const show = () => {
    if (environment.platform !== "darwin" && environment.platform !== "win32") return;
    if (environment.platform === "darwin") {
      const template = recentThreadsDockMenu(threads, (link) => {
        runFork(webLinks.receive(link));
      });
      Electron.app.dock?.setMenu(Electron.Menu.buildFromTemplate(template));
      return;
    }
    const categories = recentThreadsJumpList(
      threads,
      { program, leadingArgs: environment.isPackaged ? [] : [environment.appPath] },
      Electron.app.getJumpListSettings().removedItems,
    );
    Electron.app.setJumpList(categories);
  };
  const apply = () => {
    try {
      show();
    } catch (cause) {
      runFork(Effect.logWarning("Could not update the recent threads menu", cause));
    }
  };

  yield* Effect.acquireRelease(
    Effect.sync(() => onLocaleChange(apply)),
    (stop) => Effect.sync(stop),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.SET_RECENT_THREADS_CHANNEL,
      payload: DesktopRecentThreadsSchema,
      result: Schema.Void,
      handler: Effect.fn("desktop.ipc.recentThreads.set")(function* (next) {
        threads = next;
        yield* Effect.sync(apply);
      }),
    }),
  );
});
