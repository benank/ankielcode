import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ANKIEL_PROJECT_FILE_NAME, type AnkielProjectFile } from "@ankielcode/contracts";
import { AnkielProjectFileFromJson } from "@ankielcode/shared/ankielProjectFile";

const decodeAnkielProjectFileJson = Schema.decodeEffect(AnkielProjectFileFromJson);

export class AnkielProjectFileLoadError extends Schema.TaggedError<AnkielProjectFileLoadError>()(
  "AnkielProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${ANKIEL_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

export class AnkielProjectFileLoader extends Context.Service<
  AnkielProjectFileLoader,
  {
    /** Never fails; missing/unreadable/invalid files return none, with warnings for invalid files. */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<AnkielProjectFile>>;
  }
>()("@ankielcode/server/project/AnkielProjectFileLoader") {}

const logAnkielProjectFileLoadError = (error: AnkielProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: AnkielProjectFileLoader["Service"]["load"] = Effect.fn(
    "AnkielProjectFileLoader.load",
  )(function* (workspaceRoot) {
    const filePath = path.join(workspaceRoot, ANKIEL_PROJECT_FILE_NAME);
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : logAnkielProjectFileLoadError(
                new AnkielProjectFileLoadError({
                  operation: "read",
                  workspaceRoot,
                  filePath,
                  cause: error,
                }),
              ).pipe(Effect.as(Option.none<string>())),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<AnkielProjectFile>();
    }
    return yield* decodeAnkielProjectFileJson(raw.value).pipe(
      Effect.asSome,
      Effect.catchTags({
        SchemaError: (error) =>
          logAnkielProjectFileLoadError(
            new AnkielProjectFileLoadError({
              operation: "decode",
              workspaceRoot,
              filePath,
              cause: error,
            }),
          ).pipe(Effect.as(Option.none<AnkielProjectFile>())),
      }),
    );
  });

  return AnkielProjectFileLoader.of({ load });
});

export const layer = Layer.effect(AnkielProjectFileLoader, make);
