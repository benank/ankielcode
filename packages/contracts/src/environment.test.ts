import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("decodes old, recognized and future manual installation descriptors", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverInstallation).toBeUndefined();
    const launcher = {
      kind: "ankiel-launcher",
      launcher: "/opt/bin/ankiel",
      baseDir: "/data/ankiel",
    };
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, serverInstallation: launcher },
      }).capabilities.serverInstallation,
    ).toEqual(launcher);
    const spaced = {
      kind: "ankiel-launcher",
      launcher: "/opt/bin/ankiel ",
      baseDir: " /data/ankiel ",
    };
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, serverInstallation: spaced },
      }).capabilities.serverInstallation,
    ).toEqual(spaced);
    // Older servers reported npm installs, which clients now treat as unknown.
    for (const installation of [
      { kind: "future-manager" },
      { kind: "npx" },
      { kind: "npm-global", prefix: "/opt/node" },
      { kind: "ankiel-launcher", launcher: "ankiel" },
    ]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toBeUndefined();
    }
  });
});
