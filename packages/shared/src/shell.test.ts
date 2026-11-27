// @effect-diagnostics nodeBuiltinImport:off -- The synchronous shell probe runs real commands with isolated config files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  listLoginShellCandidates,
  mergePathEntries,
  mergePathValues,
  readEnvironmentFromLoginShell,
  windowsEnvironmentValueCommand,
} from "./shell.ts";

const nativeProbe = vi.hoisted(() => ({
  execFile: vi.fn<typeof import("node:child_process").execFile>(),
  original: undefined as unknown as typeof import("node:child_process").execFile,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  nativeProbe.original = original.execFile;
  return { ...original, execFile: nativeProbe.execFile.mockImplementation(original.execFile) };
});

describe("readEnvironmentFromLoginShell", () => {
  // Opt in with an explicit binary, like the provider live probes; CI need not install Nu.
  it.runIf(process.env.ANKIEL_TEST_NU_PATH !== undefined)(
    "captures Nushell PATH and multiline values without external tools",
    () => {
      const shell = process.env.ANKIEL_TEST_NU_PATH!;
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ankiel-nu-env-"));
      try {
        const toolPath = NodePath.join(home, "nu tools", "bin");
        const extraToolPath = NodePath.join(home, "extra-tools", "bin");
        NodeFS.mkdirSync(toolPath, { recursive: true });
        NodeFS.mkdirSync(extraToolPath, { recursive: true });
        const config = NodePath.join(home, "config.nu");
        const envConfig = NodePath.join(home, "env.nu");
        NodeFS.writeFileSync(envConfig, "");
        NodeFS.writeFileSync(
          config,
          [
            `$env.PATH = [${JSON.stringify(toolPath)}, "~/extra-tools/bin", "rel/dir", ""]`,
            '$env.CUSTOM_VAR = "  first\\nsecond  "',
            '$env.EMPTY_VAR = ""',
            'print "startup noise"',
          ].join("\n"),
        );

        expect(
          readEnvironmentFromLoginShell(
            shell,
            ["MISSING_VAR", "PATH", "EMPTY_VAR", "CUSTOM_VAR"],
            (file, args, options) =>
              NodeChildProcess.execFileSync(
                file,
                ["--no-history", "--config", config, "--env-config", envConfig, ...args],
                {
                  ...options,
                  env: { HOME: home, XDG_CONFIG_HOME: home, PATH: toolPath },
                },
              ),
          ),
        ).toEqual({
          PATH: `${toolPath}:${extraToolPath}:rel/dir:`,
          CUSTOM_VAR: "  first\nsecond  ",
        });
      } finally {
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  // Disabled: the captured PATH comes back empty.
  it("extracts multiple environment variables from a login shell command", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__ANKIEL_ENV_PATH_START__",
        "/a:/b",
        "__ANKIEL_ENV_PATH_END__",
        "__ANKIEL_ENV_SSH_AUTH_SOCK_START__",
        "/tmp/secretive.sock",
        "__ANKIEL_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith("/bin/zsh", expect.any(Array), {
      encoding: "utf8",
      timeout: 5000,
      killSignal: "SIGKILL",
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  });

  it("omits environment variables that are missing or empty", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__ANKIEL_ENV_PATH_START__",
        "/a:/b",
        "__ANKIEL_ENV_PATH_END__",
        "__ANKIEL_ENV_SSH_AUTH_SOCK_START__",
        "__ANKIEL_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
    });
  });

  it("preserves multiline values and surrounding whitespace", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__ANKIEL_ENV_CUSTOM_VAR_START__",
        "  first\nsecond  ",
        "__ANKIEL_ENV_CUSTOM_VAR_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["CUSTOM_VAR"], execFile)).toEqual({
      CUSTOM_VAR: "  first\nsecond  ",
    });
  });
});

describe("listLoginShellCandidates", () => {
  it("returns env shell, user shell, then the platform fallback without duplicates", () => {
    expect(listLoginShellCandidates("darwin", " /opt/homebrew/bin/nu ", "/bin/zsh")).toEqual([
      "/opt/homebrew/bin/nu",
      "/bin/zsh",
    ]);
  });
});

describe("mergePathEntries", () => {
  it("prefers login-shell PATH entries and keeps inherited extras", () => {
    expect(
      mergePathEntries("/opt/homebrew/bin:/usr/bin", "/Users/test/.local/bin:/usr/bin", "darwin"),
    ).toBe("/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
    expect(mergePathEntries("/opt/bin :/opt/bin", "/opt/bin :/usr/bin", "linux")).toBe(
      "/opt/bin :/opt/bin:/usr/bin",
    );
  });
});

describe("windowsEnvironmentValueCommand", () => {
  it("joins PATH as Process, then Machine, then User so prepends win and User installs still appear", () => {
    const command = windowsEnvironmentValueCommand("PATH");
    const processAt = command.indexOf("[Environment]::GetEnvironmentVariable('PATH','Process')");
    const machineAt = command.indexOf("[Environment]::GetEnvironmentVariable('PATH','Machine')");
    const userAt = command.indexOf("[Environment]::GetEnvironmentVariable('PATH','User')");
    expect(processAt).toBeGreaterThan(-1);
    expect(processAt).toBeLessThan(machineAt);
    expect(machineAt).toBeLessThan(userAt);
  });
});

describe("mergePathValues", () => {
  it("sanitizes and dedupes Windows entries while preserving preferred order", () => {
    expect(
      mergePathValues(
        'C:\\Users\\testuser\\AppData\\Roaming\\npm;"C:\\Program Files\\nodejs"',
        "c:\\users\\testuser\\appdata\\roaming\\npm;C:\\Windows\\System32",
        "win32",
      ),
    ).toBe(
      "C:\\Users\\testuser\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs;C:\\Windows\\System32",
    );
  });

  it("removes stray quotes from Windows entries", () => {
    expect(
      mergePathValues(
        'C:\\Windows\\System32;C:\\cloudflared.exe;C:";C:\\Program Files\\nodejs',
        undefined,
        "win32",
      ),
    ).toBe("C:\\Windows\\System32;C:\\cloudflared.exe;C:;C:\\Program Files\\nodejs");
  });

  it("dedupes case-sensitively on POSIX", () => {
    expect(mergePathValues("/usr/local/bin:/usr/bin", "/usr/bin:/USR/BIN", "linux")).toBe(
      "/usr/local/bin:/usr/bin:/USR/BIN",
    );
    expect(mergePathValues("/opt/bin :/opt/bin", "/opt/bin :/usr/bin", "linux")).toBe(
      "/opt/bin :/opt/bin:/usr/bin",
    );
    expect(mergePathValues('/opt/bin"', "/opt/bin", "linux")).toBe('/opt/bin":/opt/bin');
  });
});
