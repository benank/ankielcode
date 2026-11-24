#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Argument, Command, Flag } from "effect/cli";

import { mergeUpdateManifestFiles, type UpdateManifestPlatform } from "./merge-update-manifests.ts";

interface ReleaseUpdateManifestMerge {
  readonly kind: "merge";
  readonly platform: UpdateManifestPlatform;
  readonly primary: string;
  readonly secondary: string;
  readonly output: string;
}

interface ReleaseUpdateManifestRename {
  readonly kind: "rename";
  readonly source: string;
  readonly output: string;
}

type ReleaseUpdateManifestAction = ReleaseUpdateManifestMerge | ReleaseUpdateManifestRename;

export interface MergeReleaseUpdateManifestOptions {
  readonly allowSingleArch?: boolean | undefined;
}

function pairArchitectures(
  platformLabel: string,
  arm64: ReadonlyMap<string, string>,
  x64: ReadonlyMap<string, string>,
  allowSingleArch: boolean,
): ReadonlyArray<{
  readonly channel: string;
  readonly arm64: string | undefined;
  readonly x64: string | undefined;
}> {
  const channels = new Set([...arm64.keys(), ...x64.keys()]);
  if (channels.size === 0) {
    if (allowSingleArch) return [];
    throw new Error(
      `Incomplete ${platformLabel} updater manifests: no architecture manifests found.`,
    );
  }
  return [...channels].toSorted().map((channel) => {
    const arm64Manifest = arm64.get(channel);
    const x64Manifest = x64.get(channel);
    if (!allowSingleArch && (arm64Manifest === undefined || x64Manifest === undefined)) {
      const missing = arm64Manifest === undefined ? "arm64" : "x64";
      throw new Error(
        `Incomplete ${platformLabel} updater manifests: ${channel} is missing its ${missing} manifest.`,
      );
    }
    return { channel, arm64: arm64Manifest, x64: x64Manifest };
  });
}

function planReleaseUpdateManifestActions(
  fileNames: ReadonlyArray<string>,
  allowSingleArch: boolean,
): ReadonlyArray<ReleaseUpdateManifestAction> {
  const macArm64 = new Map<string, string>();
  const macX64 = new Map<string, string>();
  const winArm64 = new Map<string, string>();
  const winX64 = new Map<string, string>();

  for (const fileName of fileNames) {
    if (fileName.startsWith("builder-debug")) continue;

    const macArm64Match = /^(.+)-mac\.yml$/u.exec(fileName);
    if (macArm64Match?.[1] !== undefined) {
      macArm64.set(macArm64Match[1], fileName);
      continue;
    }
    const macX64Match = /^(.+)-mac-x64\.yml$/u.exec(fileName);
    if (macX64Match?.[1] !== undefined) {
      macX64.set(macX64Match[1], fileName);
      continue;
    }
    const winMatch = /^(.+)-win-(arm64|x64)\.yml$/u.exec(fileName);
    if (winMatch?.[1] !== undefined) {
      (winMatch[2] === "arm64" ? winArm64 : winX64).set(winMatch[1], fileName);
    }
  }

  const actions: ReleaseUpdateManifestAction[] = [];

  // electron-builder names the macOS arm64 manifest without an arch suffix,
  // so the merged macOS feed keeps that name; Windows gets `<channel>.yml`.
  for (const { channel, arm64, x64 } of pairArchitectures(
    "macOS",
    macArm64,
    macX64,
    allowSingleArch,
  )) {
    const output = `${channel}-mac.yml`;
    if (arm64 !== undefined && x64 !== undefined) {
      actions.push({ kind: "merge", platform: "mac", primary: arm64, secondary: x64, output });
    } else if (x64 !== undefined) {
      actions.push({ kind: "rename", source: x64, output });
    }
  }

  for (const { channel, arm64, x64 } of pairArchitectures(
    "Windows",
    winArm64,
    winX64,
    allowSingleArch,
  )) {
    const output = `${channel}.yml`;
    if (arm64 !== undefined && x64 !== undefined) {
      actions.push({ kind: "merge", platform: "win", primary: x64, secondary: arm64, output });
    } else {
      const single = x64 ?? arm64;
      if (single !== undefined) {
        actions.push({ kind: "rename", source: single, output });
      }
    }
  }

  return actions;
}

export const mergeReleaseUpdateManifestFiles = Effect.fn("mergeReleaseUpdateManifestFiles")(
  function* (releaseAssetsDirArg: string, options: MergeReleaseUpdateManifestOptions = {}) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const releaseAssetsDir = path.resolve(releaseAssetsDirArg);
    const actions = planReleaseUpdateManifestActions(
      yield* fs.readDirectory(releaseAssetsDir),
      options.allowSingleArch ?? false,
    );

    yield* Effect.forEach(
      actions,
      (action) => {
        if (action.kind === "rename") {
          const source = path.join(releaseAssetsDir, action.source);
          const output = path.join(releaseAssetsDir, action.output);
          return source === output ? Effect.void : fs.rename(source, output);
        }
        const primary = path.join(releaseAssetsDir, action.primary);
        const secondary = path.join(releaseAssetsDir, action.secondary);
        const output = path.join(releaseAssetsDir, action.output);
        return mergeUpdateManifestFiles(action.platform, primary, secondary, output).pipe(
          Effect.andThen(
            Effect.forEach(
              [primary, secondary].filter((source) => source !== output),
              (source) => fs.remove(source),
              { discard: true },
            ),
          ),
        );
      },
      { discard: true },
    );
  },
);

export const mergeReleaseUpdateManifestsCommand = Command.make(
  "merge-release-update-manifests",
  {
    releaseAssetsDir: Argument.String("release-assets-dir").pipe(
      Argument.withDescription("Directory containing every desktop release artifact."),
    ),
    allowSingleArch: Flag.Boolean("allow-single-arch").pipe(
      Flag.withDescription(
        "Allow single-architecture platforms without requiring an arm64/x64 pair.",
      ),
      Flag.withDefault(false),
    ),
  },
  ({ releaseAssetsDir, allowSingleArch }) =>
    mergeReleaseUpdateManifestFiles(releaseAssetsDir, { allowSingleArch }),
).pipe(Command.withDescription("Merge or normalize desktop updater manifests for a release."));

if (import.meta.main) {
  Command.run(mergeReleaseUpdateManifestsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
