import { describe, expect, it } from "vite-plus/test";

import { presentationDragProps } from "./presentationDrag";

describe("presentationDragProps", () => {
  it.each([
    [
      "keeps a named remote attachment and drops the fragment",
      {
        uri: "https://host.example/api/assets/a1?sig=x#page=2",
        name: "photo.png",
        mimeType: "image/png",
      },
      {
        dragUri: "https://host.example/api/assets/a1?sig=x",
        dragName: "photo.png",
        dragMimeType: "image/png",
      },
    ],
    [
      "adds the extension the MIME type implies",
      { uri: "file:///tmp/abc", name: "Diagram", mimeType: "image/jpeg; q=1" },
      { dragUri: "file:///tmp/abc", dragName: "Diagram.jpg", dragMimeType: "image/jpeg" },
    ],
    [
      "falls back to the URL's file name and extension",
      { uri: "https://example.com/img/chart%201.webp", name: null },
      {
        dragUri: "https://example.com/img/chart%201.webp",
        dragName: "chart 1.webp",
        dragMimeType: "",
      },
    ],
    [
      "borrows the URL extension for alt text",
      { uri: "https://example.com/a/b.gif?x=1", name: "A spinning cat" },
      {
        dragUri: "https://example.com/a/b.gif?x=1",
        dragName: "A spinning cat.gif",
        dragMimeType: "",
      },
    ],
    [
      "never writes path separators into the dropped file name",
      { uri: "file:///x/y.png", name: "../../etc/passwd.png", mimeType: "image/png" },
      { dragUri: "file:///x/y.png", dragName: "passwd.png", dragMimeType: "image/png" },
    ],
  ])("%s", (_label, input, expected) => {
    expect(presentationDragProps(input)).toEqual(expected);
  });

  it("shortens a long name but keeps its extension", () => {
    const props = presentationDragProps({
      uri: "file:///x",
      name: `${"a".repeat(300)}.png`,
      mimeType: "image/png",
    });
    expect(props?.dragName).toHaveLength(120);
    expect(props?.dragName.endsWith("a.png")).toBe(true);
  });

  it.each([null, "", "data:image/png;base64,AAAA", "content://media/1", "blob:abc"])(
    "offers no drag for %j",
    (uri) => {
      expect(presentationDragProps({ uri, name: "x.png", mimeType: "image/png" })).toBeUndefined();
    },
  );
});
