import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

const openDatabaseAsync = vi.hoisted(() => vi.fn());

vi.mock("expo-sqlite", () => ({ openDatabaseAsync }));

import * as MobileDatabase from "./mobile-database";

describe("offline client cache", () => {
  const environmentId = "cached-environment" as import("@ankielcode/contracts").EnvironmentId;
  const otherEnvironment = "other-environment" as import("@ankielcode/contracts").EnvironmentId;

  async function sqliteDatabase() {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA user_version = 1");
    const database = {
      execAsync: async (sql: string) => {
        sqlite.exec(sql);
      },
      runAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).run(...args),
      getFirstAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).get(...args),
      getAllAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).all(...args),
      withExclusiveTransactionAsync: async (run: (transaction: unknown) => Promise<void>) => {
        await run(database);
      },
      closeAsync: async () => {
        sqlite.close();
      },
    };
    openDatabaseAsync.mockResolvedValueOnce(database);
    return sqlite;
  }

  it.effect("restores saved records and clears them with the environment", () =>
    Effect.gen(function* () {
      yield* Effect.promise(sqliteDatabase);
      const database = yield* MobileDatabase.make;
      yield* database.saveCache(environmentId, "thread", "v1:list", 1, '{"entries":[]}');
      yield* database.saveCache(otherEnvironment, "thread", "v1:list", 1, "other");
      expect(yield* database.loadCache(environmentId, "thread", "v1:list")).toEqual(
        Option.some('{"entries":[]}'),
      );
      yield* database.clearEnvironmentCache(environmentId);
      expect((yield* database.loadCache(environmentId, "thread", "v1:list"))._tag).toBe("None");
      expect((yield* database.loadCache(otherEnvironment, "thread", "v1:list"))._tag).toBe("Some");
    }),
  );

  it.effect("drops pull request rows an older build cached", () =>
    Effect.gen(function* () {
      const sqlite = yield* Effect.promise(sqliteDatabase);
      sqlite.exec(`
        CREATE TABLE client_cache (
          environment_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          cache_key TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          payload TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (environment_id, kind, cache_key)
        ) WITHOUT ROWID;
        INSERT INTO client_cache VALUES ('${environmentId}', 'pull-request', 'v1:list', 1, '{}', 1);
        INSERT INTO client_cache VALUES ('${environmentId}', 'thread', 'v1:list', 1, '{}', 1);
      `);
      const database = yield* MobileDatabase.make;
      const summary = yield* database.inspectCaches;
      expect(summary.map((row) => row.kind)).toEqual(["thread"]);
    }),
  );
});
