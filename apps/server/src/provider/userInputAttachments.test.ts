// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as DocumentText from "./DocumentText.ts";
import { appendUserInputAttachmentPaths } from "./userInputAttachments.ts";

vi.mock("node:child_process", { spy: true });

const layer = Layer.merge(
  ServerConfig.layerTest(process.cwd(), { prefix: "ankiel-answer-paths-" }),
  DocumentText.layer,
).pipe(Layer.provideMerge(NodeServices.layer));
const attachment = {
  type: "file" as const,
  id: "thread-1-00000000-0000-4000-8000-0000000000aa-txt",
  name: 'spec "final".txt',
  mimeType: "text/plain",
  sizeBytes: 4,
};
describe("question answer paths", () => {
  it.effect.each([false, true])(
    "keeps unrelated files available during extraction (failure: %s)",
    (failure) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = NodePath.join(config.attachmentsDir, "blocked.rtf");
        const cached = NodePath.join(config.attachmentsDir, "cached.rtf");
        NodeFS.writeFileSync(path, failure ? "invalid document" : String.raw`{\rtf1 Available}`);
        NodeFS.writeFileSync(cached + ".txt", "Cached text");
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let reads = 0;
        yield* Effect.gen(function* () {
          const documents = yield* DocumentText.DocumentText;
          const extraction = yield* documents.ensure(path).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          const duplicate = yield* documents.ensure(path).pipe(Effect.forkChild);
          expect(yield* documents.ensure(path + ".png")).toBeUndefined();
          expect(yield* documents.ensure(path + ".pdf")).toBeUndefined();
          expect(yield* documents.ensure(cached)).toBe(cached + ".txt");
          expect(NodeFS.readFileSync(cached + ".txt", "utf8")).toBe("Cached text");
          yield* Deferred.succeed(release, undefined);
          const expected = failure ? undefined : path + ".txt";
          expect(yield* Fiber.join(extraction)).toBe(expected);
          expect(yield* Fiber.join(duplicate)).toBe(expected);
          expect(yield* documents.ensure(path)).toBe(expected);
          expect(reads).toBe(1);
          if (failure) {
            NodeFS.writeFileSync(path + ".txt", "Recovered text");
            expect(yield* documents.ensure(path)).toBe(path + ".txt");
            expect(NodeFS.readFileSync(path + ".txt", "utf8")).toBe("Recovered text");
          } else expect(NodeFS.readFileSync(path + ".txt", "utf8")).toBe("Available");
        }).pipe(
          Effect.provide(Layer.fresh(DocumentText.layer)),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            stat: (file) =>
              file === path
                ? Effect.gen(function* () {
                    reads++;
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(release);
                    return yield* fs.stat(file);
                  })
                : fs.stat(file),
          }),
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "preserves corrupt documents, PDFs and unknown binaries without an extracted path",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        for (const extension of ["docx", "ipynb", "zip", "pdf"]) {
          const file = {
            ...attachment,
            id: attachment.id.replace(/txt$/, extension),
            name: `broken.${extension}`,
          };
          const path = NodePath.join(config.attachmentsDir, `${file.id}.${extension}`);
          NodeFS.writeFileSync(path, "invalid document");
          const answers = yield* appendUserInputAttachmentPaths({
            answers: {},
            attachmentsDir: config.attachmentsDir,
            attachmentsByQuestionId: { q: [file] },
          });
          expect(answers.q).toContain(JSON.stringify(path));
          expect(answers.q).not.toContain("text extracted");
          expect(NodeFS.existsSync(`${path}.txt`)).toBe(false);
          expect(NodeFS.readFileSync(path, "utf8")).toBe("invalid document");
        }
      }).pipe(Effect.provide(layer)),
  );
  it.effect("keeps selected values intact and appends an actual readable server path", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = NodePath.join(config.attachmentsDir, `${attachment.id}.txt`);
      NodeFS.writeFileSync(path, "spec");
      const original = { q: ["First", "Second"], other: "No file" };
      const answers = yield* appendUserInputAttachmentPaths({
        answers: original,
        attachmentsDir: config.attachmentsDir,
        attachmentsByQuestionId: { q: [attachment] },
      });
      expect(answers.q).toEqual([
        "First",
        "Second",
        `Attached file "spec \\"final\\".txt": ${JSON.stringify(path)}`,
      ]);
      expect(answers.other).toBe("No file");
      expect(original.q).toEqual(["First", "Second"]);
      expect(NodeFS.readFileSync(path, "utf8")).toBe("spec");
      const specialKey = yield* appendUserInputAttachmentPaths({
        answers: {},
        attachmentsDir: config.attachmentsDir,
        attachmentsByQuestionId: { ["__proto__"]: [attachment] },
      });
      expect(Object.keys(specialKey)).toEqual(["__proto__"]);
      expect(specialKey["__proto__"]).toContain(JSON.stringify(path));
    }).pipe(Effect.provide(layer)),
  );
  it.effect("does not send an unavailable attachment path", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const result = yield* appendUserInputAttachmentPaths({
        answers: { q: "" },
        attachmentsDir: config.attachmentsDir,
        attachmentsByQuestionId: { q: [attachment] },
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(layer)),
  );
});
