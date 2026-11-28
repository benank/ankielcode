import type * as Electron from "electron";
import { msg } from "gt-i18n";

import { m } from "../i18n/messages.ts";

const WAIT = 0;
const RELOAD = 1;

/** Wait is the default and the cancel answer, so an aborted box resolves as Wait. */
export function unresponsiveDialogOptions(signal: AbortSignal): Electron.MessageBoxOptions {
  return {
    type: "warning",
    title: m(msg("Ankiel Code isn't responding")),
    message: m(msg("Ankiel Code isn't responding.")),
    detail: m(
      msg("Wait for it to respond, or reload the window. Reloading doesn't stop running threads."),
    ),
    buttons: [
      m(msg("Wait", { $context: "button, keeps waiting for a frozen window" })),
      m(msg("Reload", { $context: "button, reloads a frozen window" })),
    ],
    defaultId: WAIT,
    cancelId: WAIT,
    noLink: true,
    signal,
  };
}

export interface UnresponsivePrompt {
  /** Shows the box unless one is already open. */
  readonly unresponsive: () => void;
  /** Closes an open box as Wait, as when the window responds again or goes away. */
  readonly dismiss: () => void;
}

export function makeUnresponsivePrompt(options: {
  readonly show: (signal: AbortSignal) => Promise<Electron.MessageBoxReturnValue>;
  readonly reload: () => void;
}): UnresponsivePrompt {
  let open: AbortController | null = null;
  return {
    unresponsive: () => {
      if (open !== null) return;
      const controller = new AbortController();
      open = controller;
      const close = () => {
        if (open === controller) open = null;
      };
      options.show(controller.signal).then(({ response }) => {
        close();
        if (response === RELOAD && !controller.signal.aborted) options.reload();
      }, close);
    },
    dismiss: () => {
      open?.abort();
      open = null;
    },
  };
}
