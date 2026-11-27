import { describe, expect, it, vi } from "vite-plus/test";

import { makeUnresponsivePrompt } from "./UnresponsiveDialog.ts";

const WAIT = 0;
const RELOAD = 1;

function harness() {
  const boxes: Array<{
    readonly signal: AbortSignal;
    readonly answer: (response: number) => void;
  }> = [];
  const reload = vi.fn();
  const prompt = makeUnresponsivePrompt({
    show: (signal) =>
      new Promise((resolve) => {
        const answer = (response: number) => resolve({ response, checkboxChecked: false });
        // Electron resolves an aborted box as if it were cancelled.
        signal.addEventListener("abort", () => answer(WAIT));
        boxes.push({ signal, answer });
      }),
    reload,
  });
  return { boxes, reload, prompt };
}

describe("makeUnresponsivePrompt", () => {
  it("shows one box per hang and another after it closes", async () => {
    const { boxes, reload, prompt } = harness();
    prompt.unresponsive();
    prompt.unresponsive();
    expect(boxes).toHaveLength(1);

    boxes[0]!.answer(WAIT);
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();

    prompt.unresponsive();
    expect(boxes).toHaveLength(2);
    boxes[1]!.answer(RELOAD);
    await Promise.resolve();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("closes the box as Wait when the window responds again", async () => {
    const { boxes, reload, prompt } = harness();
    prompt.unresponsive();
    prompt.dismiss();
    expect(boxes[0]!.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();

    // The next hang opens a fresh box rather than reusing the dismissed one.
    prompt.unresponsive();
    expect(boxes).toHaveLength(2);
    expect(boxes[1]!.signal.aborted).toBe(false);
  });
});
