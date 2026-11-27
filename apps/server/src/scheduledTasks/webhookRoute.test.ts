import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  EnvironmentHttpApi,
  ScheduledTaskWebhookDeliveryId,
  ScheduledTaskError,
} from "@ankielcode/contracts";
import {
  ScheduledTaskService,
  type WebhookTriggerRequest,
  type WebhookTriggerResult,
} from "./ScheduledTaskService.ts";
import { WEBHOOK_MAX_BODY_BYTES } from "./webhookRoute.ts";
import * as WebhookRoute from "./webhookRoute.ts";
import * as Workflows from "../workflows/Workflows.ts";

class WebhookTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.webhooks) {}

const workflowDeliveries: Array<Parameters<Workflows.Workflows["Service"]["deliver"]>[0]> = [];
const hooks = Layer.mock(Workflows.Workflows)({
  deliver: (delivery) =>
    Effect.sync(() => {
      workflowDeliveries.push(delivery);
      return delivery.token === "tok" ? Option.some({ runId: "run-1" }) : Option.none();
    }).pipe(
      Effect.filterOrFail(
        () => delivery.token !== "busy",
        () => new Workflows.WorkflowHookBusyError({ hook: "push" }),
      ),
    ),
});

const handlerFor = (
  trigger: (
    request: WebhookTriggerRequest,
  ) => Effect.Effect<WebhookTriggerResult, ScheduledTaskError>,
) =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(WebhookTestApi).pipe(
      Layer.provide(WebhookRoute.layer),
      Layer.provide(Layer.mock(ScheduledTaskService)({ triggerWebhook: trigger })),
      Layer.provide(hooks),
      Layer.provide(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide([NodeServices.layer, PlatformNodeCrypto.layerSignature]),
    ),
    { disableLogger: true },
  );

const post = (
  path: string,
  body: string | Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {},
) => new Request(`http://env.local${path}`, { method: "POST", body, headers });

describe("webhook route", () => {
  it("keeps a browser's session cookie out of the request a task reads", async () => {
    const received: Array<WebhookTriggerRequest> = [];
    const { handler, dispose } = handlerFor((request) => {
      received.push(request);
      return Effect.succeed({
        _tag: "accepted",
        deliveryId: ScheduledTaskWebhookDeliveryId.make("delivery:1"),
        outcome: "accepted",
      });
    });
    try {
      const response = await handler(
        new Request("http://env.local/api/hooks/id/tok", {
          headers: { Cookie: "ankiel_session=session-secret", "x-github-event": "push" },
        }),
      );
      expect(response.status).toBe(202);
      expect(received[0]?.headers).not.toHaveProperty("cookie");
      expect(received[0]?.headers["x-github-event"]).toBe("push");
    } finally {
      await dispose();
    }
  });

  it("rejects oversized bodies and malformed paths before reaching the service", async () => {
    let calls = 0;
    const { handler, dispose } = handlerFor(() => {
      calls += 1;
      return Effect.succeed({ _tag: "not_found" });
    });
    try {
      const big = new Uint8Array(WEBHOOK_MAX_BODY_BYTES + 1);
      expect((await handler(post("/api/hooks/id/tok", big))).status).toBe(413);
      expect((await handler(post("/api/hooks/id", "{}"))).status).toBe(404);
      expect((await handler(post("/api/hooks/id/tok/extra", "{}"))).status).toBe(404);
      expect((await handler(post("/api/hooks/%E0/tok", "{}"))).status).toBe(404);
      const chunked = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let sent = 0; sent <= WEBHOOK_MAX_BODY_BYTES; sent += 64 * 1024) {
            controller.enqueue(new Uint8Array(64 * 1024));
          }
          controller.close();
        },
      });
      const streamed = await handler(
        new Request("http://env.local/api/hooks/id/tok", {
          method: "POST",
          body: chunked,
          // Node's fetch needs duplex for streamed bodies.
          duplex: "half",
        }),
      );
      expect(streamed.status).toBe(413);
      expect(calls).toBe(0);
    } finally {
      await dispose();
    }
  });

  it("hides service failures and defects behind a fixed 500", async () => {
    const failures = [
      Effect.fail(new ScheduledTaskError({ message: "database locked" })),
      Effect.die(new Error("database exploded")),
    ];
    for (const failure of failures) {
      const { handler, dispose } = handlerFor(() => failure);
      try {
        const response = await handler(post("/api/hooks/id/tok", "{}"));
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: "internal_error" });
      } finally {
        await dispose();
      }
    }
  });
});
