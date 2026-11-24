import { assert, describe, it } from "@effect/vitest";

import {
  AC_CODE_DEVICE_TOOL_INSTRUCTIONS,
  AC_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  AC_CODE_ORCHESTRATION_INSTRUCTIONS,
  ankielAcpPromptWithInstructions,
  ankielOrchestrationPrompt,
  ankielOrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("Ankiel device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(AC_CODE_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(AC_CODE_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__ankiel-code__device_list,mcp__ankiel-code__device_open,mcp__ankiel-code__device_screenshot,mcp__ankiel-code__device_close`.";
    assert.include(AC_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      AC_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      AC_CODE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      AC_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      AC_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(ankielOrchestrationSystemPrompt(true, true), AC_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(ankielOrchestrationSystemPrompt(true, false), "## Ankiel Code devices");
    assert.isUndefined(ankielOrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      ankielOrchestrationPrompt({
        prompt: "Check the login screen.",
        hasAnkielMcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), AC_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## Ankiel Code devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      ankielOrchestrationPrompt({
        prompt: "Check the login screen.",
        hasAnkielMcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), AC_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), AC_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");

    // A provider's own guidance reaches a conversation that already had the rest.
    const providerRun = (providerInstructionsDelivered: boolean) =>
      ankielOrchestrationPrompt({
        prompt: "Check the login screen.",
        hasAnkielMcp: true,
        hasDeviceTools: false,
        orchestrationDelivered: true,
        deviceInstructionsDelivered: false,
        providerInstructions: "Mark awaited shells.",
        providerInstructionsDelivered,
      });
    assert.include(providerRun(false), "Mark awaited shells.");
    assert.notInclude(providerRun(false), AC_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(providerRun(true), "Check the login screen.");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = {
      interactionMode: "default",
      hasAnkielMcp: true,
      hasDeviceTools: false,
    } as const;
    const withDevices = ankielAcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, AC_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      ankielAcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(
      ankielAcpPromptWithInstructions({ prompt: "Hi.", state }),
      "## Ankiel Code devices",
    );
  });
});
