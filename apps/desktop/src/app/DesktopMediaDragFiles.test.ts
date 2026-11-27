import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import { makeMediaDragFiles, mediaDragFileName } from "./DesktopMediaDragFiles.ts";

describe("mediaDragFileName", () => {
  it("keeps a plain name and adds an extension from the media type when it has none", () => {
    assert.strictEqual(mediaDragFileName("screenshot.png", "image/png"), "screenshot.png");
    assert.strictEqual(mediaDragFileName("Screenshot", "image/jpeg; q=1"), "Screenshot.jpg");
    assert.strictEqual(mediaDragFileName("diagram", "application/octet-stream"), "diagram");
  });

  it("never yields a path, a reserved name or an empty name", () => {
    assert.strictEqual(mediaDragFileName("../../etc/passwd", ""), "passwd");
    assert.strictEqual(mediaDragFileName("a/b.png", ""), "b.png");
    assert.strictEqual(mediaDragFileName("C:\\Users\\x.gif", ""), "x.gif");
    assert.strictEqual(mediaDragFileName("..", "image/png"), "image.png");
    assert.strictEqual(mediaDragFileName("", "image/webp"), "image.webp");
    assert.strictEqual(mediaDragFileName("   ", ""), "image");
    assert.strictEqual(mediaDragFileName("con.png", ""), "_con.png");
    assert.strictEqual(mediaDragFileName("LPT1", "image/png"), "_LPT1.png");
    assert.strictEqual(mediaDragFileName('a<b>:"c|?*\n.png', ""), "a_b___c____.png");
    assert.strictEqual(mediaDragFileName("trailing. . ", "image/png"), "trailing.png");
  });

  it("caps long names and keeps the extension", () => {
    const name = mediaDragFileName(`${"x".repeat(300)}.png`, "");
    assert.strictEqual(name.length, 120);
    assert.isTrue(name.endsWith("x.png"));
  });
});

describe("makeMediaDragFiles", () => {
  it.effect(
    "writes each file in its own directory under one root, removed when the scope closes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const scope = yield* Scope.make();
        const files = yield* makeMediaDragFiles.pipe(Scope.provide(scope));
        const data = new Uint8Array([1, 2, 3]);

        const first = yield* files.write("../photo.png", "image/png", data);
        const second = yield* files.write("photo.png", "image/png", data);
        const root = path.dirname(path.dirname(first));
        assert.strictEqual(path.basename(first), "photo.png");
        assert.strictEqual(path.dirname(path.dirname(second)), root);
        assert.notStrictEqual(path.dirname(first), path.dirname(second));
        assert.isTrue(path.basename(root).startsWith("ankiel-drag-"));
        assert.deepEqual(yield* fs.readFile(second), data);

        yield* Scope.close(scope, Exit.void);
        assert.isFalse(yield* fs.exists(root));
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto))),
  );
});
