#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@ankielcode/shared/HostProcess";
import { resolveWorktreeAnkielHome } from "@ankielcode/shared/devHome";
import * as NodeSqliteClient from "@ankielcode/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Command, Flag } from "effect/cli";

const RUNTIME_SKIP_ENTRIES = new Set([
  "server-owner.sqlite",
  "server-owner.sqlite-wal",
  "server-owner.sqlite-shm",
  "server-runtime.json",
  "server-runtime.lock",
  "statev2.sqlite-wal",
  "statev2.sqlite-shm",
  "logs",
  "browser-artifacts",
]);

const CONNECTION_CATALOG_FILE = "connection-catalog.json";

export class MigrateDevToProdSourceMissingError extends Schema.TaggedError<MigrateDevToProdSourceMissingError>()(
  "MigrateDevToProdSourceMissingError",
  {
    sourceDir: Schema.String,
    reason: Schema.Literals(["dir-missing", "db-missing"]),
  },
) {
  override get message(): string {
    return this.reason === "dir-missing"
      ? `Source dev directory does not exist at '${this.sourceDir}'. Pass --source <dir> if your dev state lives elsewhere.`
      : `Source dev directory '${this.sourceDir}' does not contain statev2.sqlite. Pass --source <dir> if your dev state lives elsewhere.`;
  }
}

export class MigrateDevToProdSameDirError extends Schema.TaggedError<MigrateDevToProdSameDirError>()(
  "MigrateDevToProdSameDirError",
  {
    dir: Schema.String,
  },
) {
  override get message(): string {
    return `Source and target both resolve to '${this.dir}'. Pick a different --source or --target.`;
  }
}

export class MigrateDevToProdServerRunningError extends Schema.TaggedError<MigrateDevToProdServerRunningError>()(
  "MigrateDevToProdServerRunningError",
  {
    role: Schema.Literals(["source", "target"]),
    stateDir: Schema.String,
    pid: Schema.Number,
  },
) {
  override get message(): string {
    return `Cannot migrate while an Ankiel Code server is running against the ${this.role} directory '${this.stateDir}' (pid ${this.pid} per server-runtime.json). Quit that app/server first and retry.`;
  }
}

export class MigrateDevToProdDatabaseBusyError extends Schema.TaggedError<MigrateDevToProdDatabaseBusyError>()(
  "MigrateDevToProdDatabaseBusyError",
  {
    role: Schema.Literals(["source", "target"]),
    databasePath: Schema.String,
    reason: Schema.Literals(["write-locked", "wal-held"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail =
      this.reason === "write-locked"
        ? "the database is write-locked"
        : "another connection is holding its WAL";
    return `Database in ${this.role} directory '${this.databasePath}' looks in use (${detail}). Quit the running app/server first and retry.`;
  }
}

export interface RunMigrateDevToProdInput {
  readonly source?: string | undefined;
  readonly target?: string | undefined;
  readonly dryRun?: boolean | undefined;
  readonly noBackup?: boolean | undefined;
  readonly includeConnections?: boolean | undefined;
}

export interface RunMigrateDevToProdResult {
  readonly sourceDir: string;
  readonly targetDir: string;
  readonly dryRun: boolean;
  readonly backupDir: string | undefined;
  readonly copiedEntries: ReadonlyArray<string>;
  readonly skippedEntries: ReadonlyArray<string>;
  readonly skippedConnections: boolean;
}

const ServerRuntimeState = Schema.fromJsonString(Schema.Struct({ pid: Schema.Number }));
const decodeServerRuntimeState = Schema.decodeEffect(ServerRuntimeState);

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const ensureNoRunningServer = Effect.fn("migrateDevToProd.ensureNoRunningServer")(function* (
  role: "source" | "target",
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeStatePath = path.join(stateDir, "server-runtime.json");
  const runtimeState = yield* fs
    .readFileString(runtimeStatePath)
    .pipe(Effect.flatMap(decodeServerRuntimeState), Effect.option);
  if (Option.isSome(runtimeState) && isProcessAlive(runtimeState.value.pid)) {
    return yield* new MigrateDevToProdServerRunningError({
      role,
      stateDir,
      pid: runtimeState.value.pid,
    });
  }
});

const checkpointDatabase = Effect.fn("migrateDevToProd.checkpointDatabase")(function* (
  role: "source" | "target",
  databasePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(databasePath))) {
    return;
  }
  const checkpoint = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA busy_timeout = 0").unprepared;
    yield* sql.unsafe("BEGIN IMMEDIATE").unprepared;
    yield* sql.unsafe("ROLLBACK").unprepared;
    return yield* sql.unsafe<{ busy: number }>("PRAGMA wal_checkpoint(TRUNCATE)").unprepared;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
    Effect.mapError(
      (cause) =>
        new MigrateDevToProdDatabaseBusyError({
          role,
          databasePath,
          reason: "write-locked",
          cause,
        }),
    ),
  );
  if (checkpoint[0] !== undefined && Number(checkpoint[0].busy) !== 0) {
    return yield* new MigrateDevToProdDatabaseBusyError({
      role,
      databasePath,
      reason: "wal-held",
    });
  }
});

const formatBackupTimestamp = (now: DateTime.Utc): string => {
  const parts = DateTime.toPartsUtc(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}${pad(parts.month)}${pad(parts.day)}-${pad(parts.hour)}${pad(parts.minute)}${pad(parts.second)}Z`;
};

const resolveUniqueBackupDir = Effect.fn("migrateDevToProd.resolveUniqueBackupDir")(function* (
  targetDir: string,
  now: DateTime.Utc,
) {
  const fs = yield* FileSystem.FileSystem;
  const base = `${targetDir}.backup-${formatBackupTimestamp(now)}`;
  if (!(yield* fs.exists(base))) {
    return base;
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!(yield* fs.exists(candidate))) {
      return candidate;
    }
  }
  const nowMs = yield* Clock.currentTimeMillis;
  return `${base}-${nowMs}`;
});

const resolveDefaultSourceDir = Effect.fn("migrateDevToProd.resolveDefaultSourceDir")(function* () {
  const path = yield* Path.Path;
  const cwd = yield* HostProcess.WorkingDirectory;
  const home = yield* HostProcess.HomeDirectory;
  const worktreeHome = yield* resolveWorktreeAnkielHome(cwd);
  if (worktreeHome !== undefined) {
    return path.join(worktreeHome, "userdata");
  }
  return path.join(home, ".ankiel", "dev");
});

export const runMigrateDevToProd = Effect.fn("migrateDevToProd.run")(function* (
  input: RunMigrateDevToProdInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;

  const sourceDir = path.resolve(
    input.source?.trim() ? input.source.trim() : yield* resolveDefaultSourceDir(),
  );
  const targetDir = path.resolve(
    input.target?.trim() ? input.target.trim() : path.join(home, ".ankiel", "userdata"),
  );

  if (sourceDir === targetDir) {
    return yield* new MigrateDevToProdSameDirError({ dir: sourceDir });
  }

  if (!(yield* fs.exists(sourceDir))) {
    return yield* new MigrateDevToProdSourceMissingError({
      sourceDir,
      reason: "dir-missing",
    });
  }

  const sourceDbPath = path.join(sourceDir, "statev2.sqlite");
  if (!(yield* fs.exists(sourceDbPath))) {
    return yield* new MigrateDevToProdSourceMissingError({
      sourceDir,
      reason: "db-missing",
    });
  }

  yield* ensureNoRunningServer("source", sourceDir);
  yield* ensureNoRunningServer("target", targetDir);

  const dryRun = input.dryRun === true;
  const noBackup = input.noBackup === true;
  const includeConnections = input.includeConnections === true;

  const entries = (yield* fs.readDirectory(sourceDir)).toSorted();
  const copiedEntries: Array<string> = [];
  const skippedEntries: Array<string> = [];
  let skippedConnections = false;

  for (const entry of entries) {
    if (RUNTIME_SKIP_ENTRIES.has(entry) || entry.endsWith(".lock")) {
      skippedEntries.push(entry);
      continue;
    }
    if (entry === CONNECTION_CATALOG_FILE && !includeConnections) {
      skippedEntries.push(entry);
      skippedConnections = true;
      continue;
    }
    copiedEntries.push(entry);
  }

  const targetExists = yield* fs.exists(targetDir);
  const targetHasEntries = targetExists && (yield* fs.readDirectory(targetDir)).length > 0;
  const backupDir =
    targetHasEntries && !noBackup
      ? yield* resolveUniqueBackupDir(targetDir, yield* DateTime.now)
      : undefined;

  if (dryRun) {
    return {
      sourceDir,
      targetDir,
      dryRun: true,
      backupDir,
      copiedEntries,
      skippedEntries,
      skippedConnections,
    } satisfies RunMigrateDevToProdResult;
  }

  const targetDbPath = path.join(targetDir, "statev2.sqlite");
  yield* checkpointDatabase("source", sourceDbPath);
  yield* checkpointDatabase("target", targetDbPath);

  if (backupDir !== undefined) {
    yield* fs.copy(targetDir, backupDir);
  }

  yield* fs.makeDirectory(targetDir, { recursive: true });

  for (const suffix of ["-wal", "-shm"]) {
    yield* fs.remove(`${targetDbPath}${suffix}`).pipe(Effect.orElseSucceed(() => undefined));
  }

  for (const entry of copiedEntries) {
    const srcPath = path.join(sourceDir, entry);
    const destPath = path.join(targetDir, entry);
    if (yield* fs.exists(destPath)) {
      yield* fs.remove(destPath, { recursive: true });
    }
    yield* fs.copy(srcPath, destPath);
  }

  yield* fs.chmod(targetDbPath, 0o600);

  return {
    sourceDir,
    targetDir,
    dryRun: false,
    backupDir,
    copiedEntries,
    skippedEntries,
    skippedConnections,
  } satisfies RunMigrateDevToProdResult;
});

export const migrateDevToProdCommand = Command.make(
  "migrate-dev-to-prod",
  {
    source: Flag.String("source").pipe(
      Flag.optional,
      Flag.withDescription(
        "Source dev state directory. Defaults to <worktree>/.ankiel/userdata in a linked worktree, or ~/.ankiel/dev.",
      ),
    ),
    target: Flag.String("target").pipe(
      Flag.optional,
      Flag.withDescription("Target prod state directory. Defaults to ~/.ankiel/userdata."),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Preview what would be backed up, copied, and skipped without writing."),
    ),
    noBackup: Flag.Boolean("no-backup").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Skip creating a timestamped backup of the existing target directory."),
    ),
    includeConnections: Flag.Boolean("include-connections").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Also copy connection-catalog.json (skipped by default because it is encrypted per-app in OS keychain).",
      ),
    ),
  },
  ({ source, target, dryRun, noBackup, includeConnections }) =>
    Effect.gen(function* () {
      const result = yield* runMigrateDevToProd({
        source: Option.getOrUndefined(source),
        target: Option.getOrUndefined(target),
        dryRun,
        noBackup,
        includeConnections,
      });

      const heading = result.dryRun
        ? "Dry run (no files modified):"
        : "Migrated dev state to prod:";
      yield* Console.log(heading);
      yield* Console.log(`  Source: ${result.sourceDir}`);
      yield* Console.log(`  Target: ${result.targetDir}`);
      if (result.backupDir !== undefined) {
        yield* Console.log(
          result.dryRun
            ? `  Backup (would create): ${result.backupDir}`
            : `  Backup created: ${result.backupDir}`,
        );
      }
      yield* Console.log(
        `  ${result.dryRun ? "Would copy" : "Copied"} (${result.copiedEntries.length}): ${result.copiedEntries.join(", ")}`,
      );
      if (result.skippedEntries.length > 0) {
        yield* Console.log(`  Skipped: ${result.skippedEntries.join(", ")}`);
      }
      if (result.skippedConnections) {
        yield* Console.log(
          "  Note: connection-catalog.json was kept untouched because it is encrypted per-app in the OS keychain (pass --include-connections to copy it anyway).",
        );
      }
    }),
).pipe(
  Command.withDescription(
    "Copy local dev state (chats, settings, attachments) into the installed prod ~/.ankiel/userdata directory with an automatic backup.",
  ),
);

if (import.meta.main) {
  Command.run(migrateDevToProdCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
