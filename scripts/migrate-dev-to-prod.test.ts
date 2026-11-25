import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@ankielcode/shared/nodeSqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import {
  MigrateDevToProdSameDirError,
  MigrateDevToProdServerRunningError,
  MigrateDevToProdSourceMissingError,
  runMigrateDevToProd,
} from "./migrate-dev-to-prod.ts";

const createTestDb = Effect.fn("test.createTestDb")(function* (dbPath: string, marker: string) {
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA journal_mode = WAL").unprepared;
    yield* sql.unsafe("CREATE TABLE IF NOT EXISTS markers (value TEXT NOT NULL)").unprepared;
    yield* sql`INSERT INTO markers (value) VALUES (${marker})`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
});

const readMarkers = Effect.fn("test.readMarkers")(function* (dbPath: string) {
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ value: string }>`SELECT value FROM markers ORDER BY value`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
});

describe("migrate-dev-to-prod", () => {
  it.effect(
    "copies dev state to prod, backs up existing prod, and skips runtime/connection files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-migrate-d2p-" });
        const sourceDir = path.join(tempDir, "dev");
        const targetDir = path.join(tempDir, "userdata");

        yield* fs.makeDirectory(path.join(sourceDir, "attachments"), { recursive: true });
        yield* fs.makeDirectory(path.join(sourceDir, "logs"), { recursive: true });
        yield* fs.makeDirectory(targetDir, { recursive: true });

        yield* createTestDb(path.join(sourceDir, "statev2.sqlite"), "from-dev");
        yield* fs.writeFileString(path.join(sourceDir, "settings.json"), '{"theme":"dark"}');
        yield* fs.writeFileString(path.join(sourceDir, "desktop-settings.json"), '{"zoom":1}');
        yield* fs.writeFileString(path.join(sourceDir, "connection-catalog.json"), "dev-encrypted");
        yield* fs.writeFileString(path.join(sourceDir, "server-runtime.json"), '{"pid":99999999}');
        yield* fs.writeFileString(path.join(sourceDir, "server-owner.sqlite"), "lock");
        yield* fs.writeFileString(path.join(sourceDir, "logs", "dev.log"), "noise");
        yield* fs.writeFileString(path.join(sourceDir, "attachments", "img.txt"), "hello");

        yield* createTestDb(path.join(targetDir, "statev2.sqlite"), "old-prod");
        yield* fs.writeFileString(
          path.join(targetDir, "connection-catalog.json"),
          "prod-encrypted",
        );

        const result = yield* runMigrateDevToProd({
          source: sourceDir,
          target: targetDir,
        });

        assert.isFalse(result.dryRun);
        assert.isDefined(result.backupDir);
        assert.isTrue(result.skippedConnections);
        assert.include(result.copiedEntries, "statev2.sqlite");
        assert.include(result.copiedEntries, "settings.json");
        assert.include(result.copiedEntries, "attachments");
        assert.include(result.skippedEntries, "connection-catalog.json");
        assert.include(result.skippedEntries, "server-runtime.json");
        assert.include(result.skippedEntries, "server-owner.sqlite");
        assert.include(result.skippedEntries, "logs");

        const targetMarkers = yield* readMarkers(path.join(targetDir, "statev2.sqlite"));
        assert.deepStrictEqual(targetMarkers, [{ value: "from-dev" }]);

        assert.strictEqual(
          yield* fs.readFileString(path.join(targetDir, "settings.json")),
          '{"theme":"dark"}',
        );
        assert.strictEqual(
          yield* fs.readFileString(path.join(targetDir, "attachments", "img.txt")),
          "hello",
        );
        assert.strictEqual(
          yield* fs.readFileString(path.join(targetDir, "connection-catalog.json")),
          "prod-encrypted",
        );
        assert.isFalse(yield* fs.exists(path.join(targetDir, "server-owner.sqlite")));
        assert.isFalse(yield* fs.exists(path.join(targetDir, "logs")));

        const backupMarkers = yield* readMarkers(path.join(result.backupDir!, "statev2.sqlite"));
        assert.deepStrictEqual(backupMarkers, [{ value: "old-prod" }]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("supports --dry-run without modifying target or creating a backup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-migrate-d2p-dry-" });
      const sourceDir = path.join(tempDir, "dev");
      const targetDir = path.join(tempDir, "userdata");

      yield* fs.makeDirectory(sourceDir, { recursive: true });
      yield* fs.makeDirectory(targetDir, { recursive: true });
      yield* createTestDb(path.join(sourceDir, "statev2.sqlite"), "from-dev");
      yield* createTestDb(path.join(targetDir, "statev2.sqlite"), "old-prod");

      const result = yield* runMigrateDevToProd({
        source: sourceDir,
        target: targetDir,
        dryRun: true,
      });

      assert.isTrue(result.dryRun);
      assert.isDefined(result.backupDir);
      assert.isFalse(yield* fs.exists(result.backupDir!));
      const targetMarkers = yield* readMarkers(path.join(targetDir, "statev2.sqlite"));
      assert.deepStrictEqual(targetMarkers, [{ value: "old-prod" }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to migrate when a live server PID is recorded in server-runtime.json", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-migrate-d2p-live-" });
      const sourceDir = path.join(tempDir, "dev");
      const targetDir = path.join(tempDir, "userdata");

      yield* fs.makeDirectory(sourceDir, { recursive: true });
      yield* fs.makeDirectory(targetDir, { recursive: true });
      yield* createTestDb(path.join(sourceDir, "statev2.sqlite"), "from-dev");
      yield* fs.writeFileString(
        path.join(targetDir, "server-runtime.json"),
        JSON.stringify({ pid: process.pid }),
      );

      const error = yield* Effect.flip(
        runMigrateDevToProd({
          source: sourceDir,
          target: targetDir,
        }),
      );
      assert.instanceOf(error, MigrateDevToProdServerRunningError);
      assert.strictEqual(error.role, "target");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails when source is missing or matches target", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-migrate-d2p-err-" });
      const missingDir = path.join(tempDir, "nope");
      const targetDir = path.join(tempDir, "userdata");

      const missingErr = yield* Effect.flip(
        runMigrateDevToProd({ source: missingDir, target: targetDir }),
      );
      assert.instanceOf(missingErr, MigrateDevToProdSourceMissingError);

      const sameErr = yield* Effect.flip(
        runMigrateDevToProd({ source: targetDir, target: targetDir }),
      );
      assert.instanceOf(sameErr, MigrateDevToProdSameDirError);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
