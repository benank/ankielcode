import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentThemeFile,
  ServerSettingsError,
} from "@ankielcode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ServerConfig from "./config.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import { symlinksSupported } from "@ankielcode/shared/testing/symlinks";

const encodeThemeFile = Schema.encodeSync(Schema.fromJsonString(EnvironmentThemeFile));

const NIGHTFALL_THEME: EnvironmentThemeFile = {
  name: "Nightfall",
  appearance: "dark",
  canvas: "#1a1b26",
  accent: "#7aa2f7",
};

/** The settings mock fails to make this theme the default. */
const REFUSED_THEME_ID = "refused";

const withEnvironmentThemes = <A, E>(
  seeds: Readonly<Record<string, string>>,
  body: Effect.Effect<
    A,
    E,
    | EnvironmentTheme.EnvironmentThemeService
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >,
  options: {
    /** Receives each theme and appearance the service makes the environment default. */
    selected?: Array<{ readonly theme?: string; readonly appearance?: string }>;
    wrapFileSystem?: (fs: FileSystem.FileSystem) => FileSystem.FileSystem;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "ankielcode-environment-theme-" });
    const themesDir = path.join(baseDir, "userdata", "themes");
    yield* fs.makeDirectory(themesDir, { recursive: true });
    for (const [filename, contents] of Object.entries(seeds)) {
      yield* fs.writeFileString(path.join(themesDir, filename), contents);
    }

    return yield* body.pipe(
      Effect.provide(
        EnvironmentTheme.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(
            Layer.mock(ServerSettingsService)({
              updateSettings: (patch) =>
                patch.defaultTheme === REFUSED_THEME_ID
                  ? Effect.fail(
                      new ServerSettingsError({
                        settingsPath: "settings.json",
                        operation: "write-file",
                      }),
                    )
                  : Effect.sync(() => {
                      options.selected?.push({
                        ...(patch.defaultTheme === undefined ? {} : { theme: patch.defaultTheme }),
                        ...(patch.defaultAppearance === undefined
                          ? {}
                          : { appearance: patch.defaultAppearance }),
                      });
                      return DEFAULT_SERVER_SETTINGS;
                    }),
            }),
          ),
          Layer.provide(Layer.succeed(FileSystem.FileSystem, options.wrapFileSystem?.(fs) ?? fs)),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const currentThemes = Effect.gen(function* () {
  const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
  return yield* environmentTheme.current;
});

describe("environment theme", () => {
  it.effect.skipIf(!symlinksSupported)("does not write through a symlink at its staging path", () =>
    withEnvironmentThemes(
      {},
      Effect.gen(function* () {
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const themes = yield* EnvironmentTheme.EnvironmentThemeService;
        const outside = path.join(environmentThemesDir, "..", "outside.txt");
        yield* fs.writeFileString(outside, "keep");
        yield* fs.symlink(
          outside,
          path.join(environmentThemesDir, `look.json.staging-${process.pid}`),
        );

        yield* themes.apply({ themeId: "look", theme: NIGHTFALL_THEME });
        assert.strictEqual(yield* fs.readFileString(outside), "keep");
        assert.deepEqual(yield* themes.current, [{ id: "look", ...NIGHTFALL_THEME }]);
      }),
    ),
  );

  it.effect.skipIf(!symlinksSupported)("ignores a symlinked theme file", () =>
    withEnvironmentThemes(
      {},
      Effect.gen(function* () {
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = path.join(environmentThemesDir, "..", "outside.json");
        yield* fs.writeFileString(outside, encodeThemeFile(NIGHTFALL_THEME));
        yield* fs.symlink(outside, path.join(environmentThemesDir, "nightfall.json"));
        assert.deepEqual(yield* currentThemes, []);
      }),
    ),
  );

  it.effect("publishes and selects a theme, and refuses unsafe CSS and unknown ids", () => {
    const selected: Array<{ readonly theme?: string; readonly appearance?: string }> = [];
    return withEnvironmentThemes(
      {},
      Effect.gen(function* () {
        const themes = yield* EnvironmentTheme.EnvironmentThemeService;
        // A comment may name an address. Only a rule that loads one is refused.
        const css =
          "/* from url(https://example.com/guide) */ [data-chat-header] { border-bottom: 1px solid red; }";
        yield* themes.apply({ themeId: "agent-look", theme: { ...NIGHTFALL_THEME, css } });
        assert.deepEqual(yield* themes.current, [{ id: "agent-look", ...NIGHTFALL_THEME, css }]);

        const leaky = yield* themes
          .apply({
            themeId: "leaky",
            theme: {
              ...NIGHTFALL_THEME,
              css: 'input[value^="a"] { background: url(https://example.com/a); }',
            },
          })
          .pipe(Effect.flip);
        assert.match(leaky.message, /loads files/);
        const reserved = yield* themes
          .apply({ themeId: "dark", theme: NIGHTFALL_THEME })
          .pipe(Effect.flip);
        assert.match(reserved.message, /not a valid theme id/);
        const unknown = yield* themes.apply({ themeId: "missing" }).pipe(Effect.flip);
        assert.match(unknown.message, /not a built-in or published theme/);
        yield* themes.apply({ themeId: "grove" });
        yield* themes.apply({ themeId: "grove", appearance: "dark" });
        yield* themes.apply({ appearance: "light" });

        assert.deepEqual(
          (yield* themes.current).map((theme) => theme.id),
          ["agent-look"],
        );
        // Only a theme that was published or already exists becomes the environment theme.
        assert.deepEqual(selected, [
          { theme: "agent-look" },
          { theme: "grove" },
          { theme: "grove", appearance: "dark" },
          { appearance: "light" },
        ]);
      }),
      { selected },
    );
  });
});
