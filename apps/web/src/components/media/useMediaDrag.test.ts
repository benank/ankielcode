import { EnvironmentId, ThreadId } from "@ankielcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mediaDragKind } from "./useMediaDrag";

const asset = {
  environmentId: EnvironmentId.make("env"),
  resource: { _tag: "attachment" as const, attachmentId: "a", fileName: "shot.png" },
};
const signed = "https://host.example/api/assets/token/shot.png";

describe("mediaDragKind", () => {
  it("uses the browser drag for blob, data and external web images", () => {
    expect(mediaDragKind({ src: "blob:app/123" }, false)).toBe("html");
    expect(mediaDragKind({ src: "data:image/png;base64,AA==" }, true)).toBe("html");
    const external = "https://example.com/cat.png";
    expect(mediaDragKind({ src: external, reference: { kind: "url", url: external } }, true)).toBe(
      "html",
    );
    expect(
      mediaDragKind(
        {
          src: "https://example.com/cat.png",
          reference: { kind: "url", url: "//example.com/cat.png" },
        },
        true,
      ),
    ).toBe("html");
  });

  it("never hands a possibly signed URL to the browser drag", () => {
    expect(mediaDragKind({ src: signed, asset }, true)).toBe("native");
    expect(mediaDragKind({ src: signed, asset }, false)).toBe("none");
    // Sent attachments and lightbox items carry no source details.
    expect(mediaDragKind({ src: signed }, true)).toBe("native");
    expect(mediaDragKind({ src: signed }, false)).toBe("none");
    // A proxied image shows the environment's copy, not the original it links to.
    expect(
      mediaDragKind(
        { src: signed, reference: { kind: "url", url: "https://github.com/a.png" } },
        false,
      ),
    ).toBe("none");
    expect(
      mediaDragKind(
        {
          src: signed,
          asset: {
            environmentId: asset.environmentId,
            resource: { _tag: "media-file", threadId: ThreadId.make("t"), path: "/a.png" },
          },
          reference: { kind: "url", url: signed },
        },
        false,
      ),
    ).toBe("none");
  });

  it("does not drag missing or unsupported sources", () => {
    expect(mediaDragKind({ src: null }, true)).toBe("none");
    expect(mediaDragKind({ src: "ankielcode://app/x.png" }, true)).toBe("none");
  });
});
