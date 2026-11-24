import { ThreadId } from "@ankielcode/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { AC_HOME } from "../e2e.config.ts";
import { rpcClient, runPromise, test, WEB } from "./ac.ts";

test("The drawer removes a terminal closed by another client", WEB, async ({ ac, app, screen }) => {
  const cwd = await ac.project("demo");
  const thread = await ac.thread({ project: cwd, title: "Shared terminals", messages: ["first"] });
  const threadId = ThreadId.make(thread.threadId);
  const origin = app.baseUrl ?? "";
  const kept = "kept-shell";
  const closed = "closed-elsewhere";

  await runPromise(
    Effect.gen(function* () {
      const client = yield* rpcClient(AC_HOME, origin);
      for (const terminalId of [kept, closed]) {
        yield* client["terminal.open"]({ threadId, terminalId, cwd });
      }
    }).pipe(Effect.scoped),
  );
  await ac.open(thread);
  await screen.getByRole("button", "Toggle terminal drawer").tap();
  await screen.getByRole("button", kept, { exact: true }).tap();
  const closedTab = screen.getByRole("button", closed, { exact: true });
  await closedTab.waitFor();

  await runPromise(
    Effect.gen(function* () {
      const client = yield* rpcClient(AC_HOME, origin);
      yield* client["terminal.close"]({ threadId, terminalId: closed, deleteHistory: true });
    }).pipe(Effect.scoped),
  );

  await app.screenshot("after-close-from-another-client");
  await expect(closedTab).toBeHidden();
});
