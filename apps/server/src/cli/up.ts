import * as HostProcess from "@ankielcode/shared/HostProcess";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { compareExactServiceVersions } from "../cloud/serviceProtocol.ts";
import * as ServerConfig from "../config.ts";
import { resolveStoredRelayPublicUrl } from "../relay/relayProtocol.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { resolveHostCliCommand } from "./invocation.ts";
import * as CliService from "./service.ts";

type Routes = Readonly<{ lan: boolean }>;

/** How other devices reach this machine now. */
interface Setup {
  readonly service: BootService.BootServiceStatus;
  readonly lan: boolean;
  /** An installed service with no ANKIEL_LAN or ANKIEL_HOST keeps the old default: on. */
  readonly lanFromOldDefault: boolean;
  readonly host: string | undefined;
  readonly relay: {
    readonly relayOrigin: string;
    readonly publicBaseUrl: string | null;
    readonly source: "env" | "file";
  } | null;
}

const readSetup = Effect.fn("cli.up.read_setup")(function* () {
  const { baseDir, stateDir } = yield* ServerConfig.ServerConfig;
  const service = yield* (yield* BootService.BootService).status;
  const { entries } = yield* CliService.readServiceEnv(baseDir);
  // Parsed as the server parses it.
  const lan = yield* Config.Boolean("ANKIEL_LAN")
    .pipe(Config.option)
    .parse(ConfigProvider.fromEnv({ env: entries }));
  // Another home's service doesn't read this home's service.env.
  const servesThisHome = service.installed && service.otherBaseDir === undefined;
  const relay = resolveStoredRelayPublicUrl(stateDir, { ...process.env, ...entries });
  return {
    service,
    lan: Option.getOrElse(lan, () => servesThisHome),
    lanFromOldDefault: Option.isNone(lan) && servesThisHome && entries.ANKIEL_HOST === undefined,
    host: entries.ANKIEL_HOST,
    relay,
  } satisfies Setup;
});

/** Whether `ankiel up` asks about local network access: only when no flag names it. */
const planRoutes = (
  setup: { readonly lan: boolean },
  flags: { readonly lan: Option.Option<boolean> },
) => ({
  routes: { lan: Option.getOrElse(flags.lan, () => setup.lan) } satisfies Routes,
  ask: Option.isNone(flags.lan),
});

/** A running service reads ANKIEL_LAN only when it starts. */
const needsRestart = (before: Routes, after: Routes) => after.lan !== before.lan;

/** The commands hints name, run with the caller's --base-dir and launcher. */
const resolveHints = Effect.fn("cli.up.resolve_hints")(function* (baseDir: Option.Option<string>) {
  const baseDirArgs = Option.match(baseDir, {
    onNone: () => [],
    onSome: (dir) => ["--base-dir", dir],
  });
  const command = (subcommand: string, args: ReadonlyArray<string> = []) =>
    Effect.map(resolveHostCliCommand(subcommand, [...baseDirArgs, ...args]), (r) => r.command);
  return {
    run: yield* command(""),
    pair: yield* command("pair"),
    up: yield* command("up"),
    upNoLan: yield* command("up", ["--no-lan"]),
  };
});
type Hints = Effect.Success<ReturnType<typeof resolveHints>>;

const formatSetup = (setup: Setup, hints: Hints) => {
  const { service } = setup;
  // This home's access settings reach no service, so only the service is shown.
  if (service.otherBaseDir !== undefined) {
    return [
      `  ${"Service".padEnd(15)}installed for another Ankiel home · ${service.otherBaseDir}`,
      "",
      `Pass \`${BootService.formatBootServiceBaseDirOption(service.otherBaseDir)}\` to manage it.`,
    ].join("\n");
  }
  const rows: ReadonlyArray<readonly [string, string]> = [
    [
      "Service",
      !service.supported
        ? "unavailable"
        : service.installed
          ? `installed · Ankiel Code v${service.installedVersion ?? packageJson.version}`
          : "not installed",
    ],
    [
      "Local network",
      setup.host !== undefined
        ? `overridden · ANKIEL_HOST=${setup.host}`
        : setup.lanFromOldDefault
          ? "on · kept from an older install"
          : setup.lan
            ? "on · pairing code only"
            : "off",
    ],
    [
      "Cloudflare",
      setup.relay
        ? `configured · ${setup.relay.publicBaseUrl ?? setup.relay.relayOrigin}`
        : "not configured",
    ],
  ];
  const notes = [
    ...(setup.host === undefined && setup.lan
      ? ["Anyone on your local network can reach the port. A pairing code is the only lock."]
      : []),
    ...(setup.lanFromOldDefault
      ? [`Older installs keep LAN access on. Turn it off: \`${hints.upNoLan}\`.`]
      : []),
  ];
  return [
    ...rows.map(([label, value]) => `  ${label.padEnd(15)}${value}`),
    ...(notes.length === 0 ? [] : ["", ...notes]),
  ].join("\n");
};

const formatNextSteps = (routes: Routes, serviceInstalled: boolean, hints: Hints) =>
  [
    ...(routes.lan ? [`Run \`${hints.pair}\`. Use the code on your other device.`] : []),
    ...(routes.lan
      ? []
      : [
          serviceInstalled
            ? "Remote access is off. Ankiel Code still runs here in the background."
            : `Remote access is off. Run \`${hints.run}\` to use Ankiel Code here.`,
        ]),
  ].join("\n");

const interactiveTerminal = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

const setUp = Effect.fn("cli.up")(function* (flags: {
  readonly baseDir: Option.Option<string>;
  readonly lan: Option.Option<boolean>;
  readonly yes: boolean;
}) {
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const service = yield* BootService.BootService;
  const baseDirArgs = Option.match(flags.baseDir, {
    onNone: () => [],
    onSome: (dir) => ["--base-dir", dir],
  });
  const hints = yield* resolveHints(flags.baseDir);
  const before = yield* readSetup();
  // Before any question or write: install would refuse only after both.
  if (before.service.otherBaseDir !== undefined) {
    return yield* new BootService.BootServiceOtherBaseDirError({
      installedBaseDir: before.service.otherBaseDir,
      baseDir,
    });
  }

  const current = { lan: before.lan };
  const plan = planRoutes(before, flags);
  const interactive = !flags.yes && interactiveTerminal();
  let routes = plan.routes;
  if (plan.ask && interactive) {
    if (before.service.installed)
      yield* Console.log(`Current setup\n${formatSetup(before, hints)}\n`);
    const allowed = yield* Prompt.run(
      Prompt.Confirm({
        message: "Allow connections from your local network? Anyone there can reach the port.",
        initial: plan.routes.lan,
      }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(null) }));
    if (allowed === null) return yield* Console.log("Nothing changed.");
    routes = { lan: allowed };
  } else if (plan.ask && !flags.yes && !before.service.installed) {
    return yield* new CliError.UserError({
      cause: "routes",
      userMessage:
        "No terminal. Choose access with --lan or --no-lan, or use --yes for the default. See `ankiel up --help`.",
    });
  }
  // Nothing to run in the background, but a route left on still gets turned off.
  if (!before.service.installed && !routes.lan) {
    if (current.lan) yield* CliService.writeServiceEnv(baseDir, { ANKIEL_LAN: "false" });
    return yield* Console.log(formatNextSteps(routes, false, hints));
  }
  const { installedVersion } = before.service;
  const newer =
    installedVersion !== undefined &&
    compareExactServiceVersions(installedVersion, packageJson.version) > 0;
  // Asked before anything changes, so a declined restart leaves service.env
  // matching what the running service read when it started.
  // A stopped service of this version is not current, so reconcile starts it;
  // a newer one is left alone and needs this restart to start.
  const stopped = before.service.problems?.includes("service-stopped") === true;
  const restart =
    before.service.installed &&
    (before.service.current || newer) &&
    (needsRestart(current, routes) || stopped);
  // An older or broken service is reinstalled, which restarts it too.
  const update = before.service.installed && !before.service.current && !newer && !stopped;
  if ((restart || update) && interactive && !stopped) {
    const confirmed = yield* Prompt.run(
      Prompt.Confirm({
        message: update
          ? "Update and restart Ankiel Code? Running agent turns will stop."
          : "Apply changes and restart? Running agent turns will stop.",
        initial: true,
      }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    if (!confirmed) return yield* Console.log("Nothing changed.");
  }

  const previousLan = (yield* CliService.readServiceEnv(baseDir)).entries.ANKIEL_LAN;
  // Also with no service manager: the file records the choice that `ankiel status` shows.
  yield* CliService.writeServiceEnv(baseDir, { ANKIEL_LAN: String(routes.lan) });
  // When the service step fails, an installed service still runs with the old
  // value, so the file goes back to match it.
  const restoreServiceEnv = before.service.installed
    ? CliService.writeServiceEnv(baseDir, { ANKIEL_LAN: previousLan })
    : Effect.void;
  // A failed update or restart may still have started the service with the new
  // settings, so restart it once more on the old ones.
  const rollBack = before.service.installed
    ? restoreServiceEnv.pipe(Effect.andThen(service.restart.pipe(Effect.ignore)))
    : Effect.void;
  if (before.host !== undefined) {
    yield* Console.warn(
      `ANKIEL_HOST=${before.host} in service.env overrides the network choice. Remove it to apply it.`,
    );
  }

  const printServeCommand = Effect.fn(function* (reason: string) {
    const { command } = yield* resolveHostCliCommand("serve", [
      ...baseDirArgs,
      // Explicit either way, so a ANKIEL_LAN in the shell cannot override the choice.
      routes.lan ? "--lan" : "--no-lan",
    ]);
    yield* Console.log(`${reason} Keep this command running:\n  ${command}`);
    // A host wins over --lan and --no-lan, as it does in service.env.
    const shellHost = (yield* HostProcess.Environment).ANKIEL_HOST;
    if (shellHost !== undefined) {
      yield* Console.warn(
        `ANKIEL_HOST=${shellHost} in this shell overrides that choice. Unset it before you run the command.`,
      );
    }
  });
  if (!before.service.supported) {
    yield* printServeCommand("Background service unavailable.");
  } else {
    if (newer) {
      yield* Console.log(`Keeping installed service version Ankiel Code v${installedVersion}.`);
    }
    if (update && !interactive) {
      yield* Console.log("Updating Ankiel Code. Running agent turns will stop.");
    }
    const result = newer
      ? ({ changed: false } as const)
      : yield* CliService.reconcileService().pipe(
          Effect.catchTags({
            BootServicePrerequisiteError: (error) => Effect.succeed({ failed: error.message }),
            BootServiceUnsupportedError: (error) => Effect.succeed({ failed: error.message }),
          }),
          Effect.tapError(() => rollBack),
        );
    if ("failed" in result && before.service.installed) {
      // The old service still runs, so a foreground server would clash with it.
      yield* restoreServiceEnv;
      yield* Console.log(
        `Service setup failed: ${result.failed} Fix that, then run \`${hints.up}\` again.`,
      );
    } else if ("failed" in result) {
      yield* printServeCommand(`Service setup failed: ${result.failed}`);
    } else if (result.changed) {
      yield* Console.log(CliService.formatServiceChange(result));
    } else if (restart) {
      if (!interactive && !stopped) {
        yield* Console.log("Restarting Ankiel Code. Running agent turns will stop.");
      }
      const outcome = yield* service.restart.pipe(Effect.tapError(() => rollBack));
      if (outcome === "queued") {
        yield* Console.log("Restart queued. This session will disconnect.");
      }
      if (outcome === "skipped") {
        yield* Console.log(
          "The installed service was not restarted. Run `ankiel service status` to see why.",
        );
      }
    }
  }

  const after = yield* readSetup();
  yield* Console.log(
    // From what took effect: a failed service step can undo a choice.
    `\nThis machine\n${formatSetup(after, hints)}\n\n${formatNextSteps(
      { lan: after.lan },
      after.service.installed,
      hints,
    )}`,
  );
});

/** Runs `ankiel up` with only what it reads: the service manager. */
const runUpCommand = Effect.fn("cli.up.run")(function* <A, E>(
  flags: { readonly baseDir: Option.Option<string> },
  run: Effect.Effect<
    A,
    E,
    | BootService.BootService
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | Prompt.Environment
  >,
) {
  const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
    quietLogs: true,
  });
  const layerRuntime = CliService.layer(config).pipe(
    Layer.provideMerge(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
  );
  return yield* run.pipe(Effect.provide(layerRuntime));
});

export const upCommand = Command.make("up", {
  ...projectLocationFlags,
  lan: Flag.Boolean("lan").pipe(
    Flag.withDescription(
      "Allow local network connections. Anyone on the same network can reach the port; a pairing code is the only lock. Turn off with --no-lan.",
    ),
    Flag.optional,
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription(
      "Ask nothing. Keep the access settings. A restart stops running agent turns.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withShortDescription("Set up remote access and the Ankiel Code background service."),
  Command.withDescription(
    "Set up remote access and the Ankiel Code background service. Access flags skip the question, and routes not named keep their settings. Without a terminal, a needed restart runs without asking and stops running agent turns.",
  ),
  Command.withExamples([
    { command: "ankiel up", description: "Choose remote access." },
    { command: "ankiel up --lan", description: "Allow LAN access with pairing codes." },
    { command: "ankiel up --no-lan", description: "Stop LAN access." },
    { command: "ankiel up --yes", description: "Take the defaults with no questions." },
    { command: "ankiel status --json", description: "Read the settings from a script." },
  ]),
  Command.withHandler((flags) => runUpCommand(flags, setUp(flags))),
);

/** `ankiel status --json`, for scripts and agents. */
const setupJson = (setup: Setup) =>
  JSON.stringify(
    {
      service: {
        supported: setup.service.supported,
        installed: setup.service.installed,
        installedVersion: setup.service.installedVersion ?? null,
        otherBaseDir: setup.service.otherBaseDir ?? null,
      },
      lan: {
        enabled: setup.lan,
        inheritedDefault: setup.lanFromOldDefault,
        hostOverride: setup.host ?? null,
      },
      relay: {
        configured: setup.relay !== null,
        relayOrigin: setup.relay?.relayOrigin ?? null,
        publicBaseUrl: setup.relay?.publicBaseUrl ?? null,
        source: setup.relay?.source ?? null,
      },
    },
    null,
    2,
  );

export const statusCommand = Command.make("status", {
  ...projectLocationFlags,
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the settings as JSON. Does not test connections."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Show service setup and remote access settings."),
  Command.withExamples([
    { command: "ankiel status", description: "Show the settings." },
    { command: "ankiel status --json", description: "Print them for scripts and agents." },
  ]),
  Command.withHandler(
    Effect.fn("cli.status")(function* (flags) {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
        quietLogs: flags.json,
      });
      // Only what readSetup reads: no database.
      const setup = yield* readSetup().pipe(
        Effect.provide(
          CliService.layer(config).pipe(Layer.provideMerge(ServerConfig.layer(config))),
        ),
      );
      if (flags.json) return yield* Console.log(setupJson(setup));
      const hints = yield* resolveHints(flags.baseDir);
      yield* Console.log(
        setup.service.otherBaseDir !== undefined
          ? `This machine\n${formatSetup(setup, hints)}`
          : `This machine\n${formatSetup(setup, hints)}\n\nChange access: \`${hints.up}\`.`,
      );
    }),
  ),
);
