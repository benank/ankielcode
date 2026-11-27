import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { selectRenderedContentOnSelectAll } from "./selectAllWithin";
import { isMacPlatform } from "./utils";

const selectAll = () =>
  userEvent.keyboard(
    isMacPlatform(navigator.platform) ? "{Meta>}a{/Meta}" : "{Control>}a{/Control}",
  );

describe("selectRenderedContentOnSelectAll", () => {
  it("selects the surface's text, and a field inside it keeps its own Select All", async () => {
    await using screen = await render(
      <>
        <p>Sidebar text outside the feed.</p>
        <div tabIndex={-1} onKeyDown={selectRenderedContentOnSelectAll}>
          <p>Message text in the feed.</p>
          <input aria-label="Reply" defaultValue="Draft reply" />
        </div>
      </>,
    );

    await userEvent.click(screen.getByText("Message text in the feed."));
    await selectAll();
    const selection = window.getSelection()?.toString() ?? "";
    expect(selection).toContain("Message text in the feed.");
    expect(selection).not.toContain("Sidebar text outside the feed.");

    const field = screen.getByRole("textbox", { name: "Reply" });
    await userEvent.click(field);
    await selectAll();
    const input = field.element() as HTMLInputElement;
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "Draft reply".length]);
  });
});
