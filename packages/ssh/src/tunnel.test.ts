// @effect-diagnostics nodeBuiltinImport:off - Runs the generated runner in a real shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@ankielcode/shared/HostProcess";
import * as NetService from "@ankielcode/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import { remoteStateKey } from "./command.ts";
import { SshCommandError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";

const isSshCommandError = Schema.is(SshCommandError);

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(true),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args.map(String) : [];
}

const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;

// The launch's POSIX bootstrap without the account login shell around it, so the
// test machine's login profile cannot move HOME.
const launchStateKey = (command: ChildProcess.Command) =>
  /exec sh -s -- ([^"]+)"/u.exec(commandArgs(command).join(" "))?.[1];

describe("ssh tunnel scripts", () => {
  it.live("distinguishes an incompatible remote Node from a missing executable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-ssh-node-" });
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      for (const missing of [false, true]) {
        const nodeFixture = missing
          ? "command() { return 1; }; "
          : 'node() { cat >/dev/null; printf "Remote node 18.20.8 does not satisfy required range >=999.0.0.\\n" >&2; return 1; }; ';
        const remoteShell = ChildProcessSpawner.make((command) => {
          if (command._tag !== "StandardCommand") return spawner.spawn(command);
          return spawner.spawn(
            ChildProcess.make(
              "sh",
              ["-c", `${nodeFixture}eval "$(cat)"`, "sh", ...commandArgs(command).slice(-1)],
              {
                ...command.options,
                env: {
                  ...command.options.env,
                  HOME: home,
                  NVM_DIR: NodePath.join(home, ".nvm"),
                  FNM_DIR: NodePath.join(home, ".fnm"),
                  VOLTA_HOME: NodePath.join(home, ".volta"),
                },
              },
            ),
          );
        });
        const result = yield* SshTunnel.launchOrReuseRemoteServer(
          { alias: "devbox", hostname: "devbox", username: null, port: null },
          undefined,
          { nodeScriptPath: "/unused/server.ts", nodeEngineRange: ">=999.0.0" },
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, remoteShell),
          Effect.result,
        );
        assert.isTrue(Result.isFailure(result));
        if (!Result.isFailure(result)) return;
        assert.isTrue(isSshCommandError(result.failure));
        if (!isSshCommandError(result.failure)) return;
        assert.equal(result.failure.exitCode, 1);
        assert.equal(result.failure.stderr.includes("missing node on PATH"), missing);
        assert.equal(
          result.failure.stderr.includes("does not satisfy required range >=999.0.0"),
          !missing,
        );
      }
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live("reports only the failed launch's own output, not an earlier launch's log", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-ssh-launch-log-" });
      const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
      const stateDir = NodePath.join(home, ".ankiel", "ssh-launch", yield* remoteStateKey(target));
      const bin = NodePath.join(home, "bin");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.makeDirectory(bin);
      yield* fs.writeFileString(NodePath.join(stateDir, "server.log"), "EARLIER_LAUNCH\n");
      // The new server exits without output. Readiness then fails after a process from the
      // earlier launch writes through the log descriptor it still holds (fd 3).
      yield* fs.writeFileString(
        NodePath.join(bin, "node"),
        '#!/bin/sh\n[ "$1" = - ] || exit 0\ncat >/dev/null\ncase "$2" in\n  */port) echo 37731 ;;\n  37731) { printf "EARLIER_PROCESS\\n" >&3; } 2>/dev/null; exit 1 ;;\n  *) exit 1 ;;\nesac\n',
        { mode: 0o755 },
      );
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const remoteShell = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") return spawner.spawn(command);
        return spawner.spawn(
          ChildProcess.make(
            "sh",
            [
              "-c",
              'exec 3>>"$1/server.log"; exec sh -s -- "$2"',
              "sh",
              stateDir,
              launchStateKey(command) ?? "",
            ],
            {
              ...command.options,
              env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` },
              extendEnv: false,
            },
          ),
        );
      });
      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, {
        nodeScriptPath: "/unused/server.ts",
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, remoteShell),
        Effect.result,
      );
      assert.isTrue(Result.isFailure(result));
      if (!Result.isFailure(result)) return;
      assert.isTrue(isSshCommandError(result.failure));
      if (!isSshCommandError(result.failure)) return;
      assert.include(result.failure.stderr, "It wrote nothing to");
      assert.notInclude(result.failure.stderr, "EARLIER_LAUNCH");
      assert.notInclude(result.failure.stderr, "EARLIER_PROCESS");
      for (const [path, mode] of [
        [stateDir, 0o700],
        [NodePath.join(stateDir, "server.log"), 0o600],
      ] as const) {
        assert.equal((yield* fs.stat(path)).mode & 0o777, mode, path);
      }
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it("rejects archive versions that are not a single exact version segment", () => {
    for (const archiveVersion of [
      "../other",
      "1.2.3/evil",
      "1.2.3\\evil",
      "1.2.3-preview.1 x",
      "1.2.3-preview.1\nrm -rf /",
      "v1.2.3",
    ]) {
      assert.throws(
        () => SshTunnel.buildRemoteAnkielRunnerScript({ archiveVersion }),
        SshTunnel.SshInvalidArchiveVersionError,
        undefined,
        archiveVersion,
      );
    }
    assert.include(
      SshTunnel.buildRemoteAnkielRunnerScript(ARCHIVE),
      "ANKIEL_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
  });

  it.each([
    { host: "Darwin x86_64", system: "Darwin", machine: "x86_64", downloads: false },
    { host: "Darwin arm64", system: "Darwin", machine: "arm64", downloads: true },
  ])(
    "only downloads a release archive the host can run: $host",
    ({ system, machine, downloads }) => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ankiel-ssh-runner-"));
      try {
        const bin = NodePath.join(root, "bin");
        NodeFS.mkdirSync(bin);
        NodeFS.mkdirSync(NodePath.join(root, "home"));
        NodeFS.writeFileSync(
          NodePath.join(bin, "uname"),
          `#!/bin/sh\ncase "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; esac\n`,
          { mode: 0o755 },
        );
        NodeFS.writeFileSync(
          NodePath.join(bin, "curl"),
          "#!/bin/sh\necho 'download attempt' >&2\necho 'curl: (6) Could not resolve host: github.com' >&2\nexit 6\n",
          { mode: 0o755 },
        );
        const runner = NodePath.join(root, "run-ankiel.test");
        NodeFS.writeFileSync(runner, SshTunnel.buildRemoteAnkielRunnerScript(ARCHIVE));
        const result = NodeChildProcess.spawnSync("sh", [runner, "--version"], {
          encoding: "utf8",
          env: { HOME: NodePath.join(root, "home"), PATH: `${bin}:${process.env.PATH ?? ""}` },
        });
        assert.notEqual(result.status, 0);
        if (downloads) {
          assert.include(result.stderr, "download attempt");
          // A bare curl error does not tell the user that ankiel itself could not be downloaded.
          assert.include(result.stderr, ARCHIVE.archiveVersion);
          assert.include(result.stderr, "https://github.com/benank/ankielcode/releases/download");
        } else {
          assert.notInclude(result.stderr, "download attempt");
          assert.include(result.stderr, "has no ankiel release archive.");
        }
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { installed: ARCHIVE.archiveVersion, status: 0, reuses: true },
    { installed: ARCHIVE.archiveVersion, status: 1, reuses: false },
    { installed: "9.9.9", status: 0, reuses: false },
  ])(
    "reuses a host ankiel only at exactly the requested version: installed $installed, status $status",
    ({ installed, status, reuses }) => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ankiel-ssh-runner-"));
      try {
        const bin = NodePath.join(root, "bin");
        NodeFS.mkdirSync(bin);
        NodeFS.mkdirSync(NodePath.join(root, "home"));
        // A host the release archive cannot run on, so only reuse can succeed.
        NodeFS.writeFileSync(
          NodePath.join(bin, "uname"),
          `#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo x86_64 ;; esac\n`,
          { mode: 0o755 },
        );
        NodeFS.writeFileSync(
          NodePath.join(bin, "ankiel"),
          `#!/bin/sh\ncase "$1" in --version) echo "ankiel v${installed}"; exit ${status} ;; *) echo "host ankiel $*" ;; esac\n`,
          { mode: 0o755 },
        );
        const runner = NodePath.join(root, "run-ankiel.test");
        NodeFS.writeFileSync(runner, SshTunnel.buildRemoteAnkielRunnerScript(ARCHIVE));
        const result = NodeChildProcess.spawnSync("sh", [runner, "serve"], {
          encoding: "utf8",
          env: { HOME: NodePath.join(root, "home"), PATH: `${bin}:${process.env.PATH ?? ""}` },
        });
        if (reuses) {
          assert.equal(result.status, 0);
          assert.equal(result.stdout, "host ankiel serve\n");
        } else {
          assert.notEqual(result.status, 0);
          assert.include(result.stderr, "has no ankiel release archive.");
        }
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("names missing tar before downloading the release archive", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ankiel-ssh-runner-"));
    try {
      const bin = NodePath.join(root, "bin");
      const home = NodePath.join(root, "home");
      NodeFS.mkdirSync(bin);
      NodeFS.mkdirSync(home);
      for (const tool of ["sh", "mkdir", "mktemp", "cat", "rm"]) {
        NodeFS.symlinkSync(
          NodeChildProcess.execFileSync("sh", ["-c", `command -v ${tool}`], {
            encoding: "utf8",
          }).trim(),
          NodePath.join(bin, tool),
        );
      }
      NodeFS.writeFileSync(
        NodePath.join(bin, "uname"),
        '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n',
        { mode: 0o755 },
      );
      NodeFS.writeFileSync(
        NodePath.join(bin, "curl"),
        '#!/bin/sh\necho "download attempt" >&2\nexit 1\n',
        { mode: 0o755 },
      );
      const runner = NodePath.join(root, "run-ankiel.test");
      NodeFS.writeFileSync(runner, SshTunnel.buildRemoteAnkielRunnerScript(ARCHIVE));
      const result = NodeChildProcess.spawnSync(NodePath.join(bin, "sh"), [runner, "--version"], {
        encoding: "utf8",
        env: { HOME: home, PATH: bin },
      });
      assert.notEqual(result.status, 0);
      assert.include(result.stderr, "needs tar");
      assert.notInclude(result.stderr, "download attempt");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "alex",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n')),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
      layerSpawner,
    );

    return Effect.gen(function* () {
      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "loads login settings without changing the POSIX bootstrap or its state key",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-ssh-login-" });
        const startupFile = `${directory}/bash-env`;
        const bash = `${directory}/bash`;
        // System profiles can reset HOME. Suppress profile reads while BASH_ENV
        // checks that the launcher still requests Bash login mode.
        yield* fs.writeFileString(bash, '#!/bin/sh\nexec /bin/bash --noprofile "$@"\n');
        yield* fs.chmod(bash, 0o755);
        yield* fs.writeFileString(
          startupFile,
          "if shopt -q login_shell; then export ANKIEL_SSH_LOGIN_ENV=loaded; fi\n",
        );
        const target = { alias: "login-test", hostname: "login-test", username: null, port: null };
        const remoteCommands: string[] = [];
        const capture = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            const args = commandArgs(command);
            remoteCommands.push(args.slice(args.indexOf(target.alias) + 1).join(" "));
            return makeSuccessfulProcess('{"remotePort":3774,"credential":"test"}\n');
          }),
        );
        yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, capture),
        );
        yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, capture),
        );
        yield* fs.writeFileString(
          `${directory}/.zprofile`,
          "if [[ -o login ]]; then export ANKIEL_SSH_LOGIN_ENV=loaded; fi\n",
        );
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const cases = [
          { shell: bash, outerShell: "/bin/sh", expected: "loaded" },
          { shell: "/bin/sh", outerShell: "/bin/sh", expected: "missing" },
          { shell: "", outerShell: "/bin/sh", expected: "missing" },
          { shell: "/unavailable/csh", outerShell: "/bin/sh", expected: "missing" },
          { shell: "/unavailable/tcsh", outerShell: "/bin/sh", expected: "missing" },
          { shell: "/unavailable/pwsh", outerShell: "/bin/sh", expected: "missing" },
        ];
        if (yield* fs.exists("/bin/zsh")) {
          cases.push({ shell: "/bin/zsh", outerShell: "/bin/zsh", expected: "loaded" });
        }
        if (yield* fs.exists("/bin/tcsh")) {
          cases.push({ shell: "/bin/tcsh", outerShell: "/bin/tcsh", expected: "missing" });
        }
        const environment = yield* HostProcess.Environment;
        for (const folder of (environment.PATH ?? "").split(":")) {
          const nu = `${folder}/nu`;
          if (folder && (yield* fs.exists(nu))) {
            cases.push({ shell: nu, outerShell: nu, expected: "missing" });
            break;
          }
        }
        for (const { shell, outerShell, expected, index, remoteCommand } of cases.flatMap((entry) =>
          remoteCommands.map((remoteCommand, index) => ({ ...entry, remoteCommand, index })),
        )) {
          const child = yield* spawner.spawn(
            ChildProcess.make(outerShell, ["-c", remoteCommand], {
              env: {
                PATH: environment.PATH ?? "/usr/bin:/bin",
                HOME: directory,
                XDG_CONFIG_HOME: directory,
                SHELL: shell,
                BASH_ENV: startupFile,
                ZDOTDIR: directory,
                ANKIEL_SSH_LOGIN_ENV: "",
              },
              stdin: {
                stream: Stream.make(
                  new TextEncoder().encode(
                    'printf "%s:%s" "${ANKIEL_SSH_LOGIN_ENV:-missing}" "$1"',
                  ),
                ),
                endOnDone: true,
              },
            }),
          );
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              child.stdout.pipe(
                Stream.decodeText(),
                Stream.runFold(
                  () => "",
                  (a, b) => a + b,
                ),
              ),
              child.stderr.pipe(
                Stream.decodeText(),
                Stream.runFold(
                  () => "",
                  (a, b) => a + b,
                ),
              ),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          assert.equal(Number(exitCode), 0, stderr);
          // First-run shell messages can precede the bootstrap response.
          const response = stdout.trim().split(/\r?\n/u).at(-1) ?? "";
          assert.match(
            response,
            new RegExp(index === 0 ? `^${expected}:[a-f0-9]{16}$` : `^${expected}:$`),
            shell || "unset SHELL",
          );
        }
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "alex",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
      layerSpawner,
    );
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("retains a bounded diagnostic tail when the tunnel exits before readiness", () =>
    Effect.gen(function* () {
      const diagnostic = "Connection refused: café";
      const output = new TextEncoder().encode(
        "old diagnostics\n" + "x".repeat(32_768) + "\n" + diagnostic,
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(output.subarray(0, output.length - 1), output.subarray(-1)),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (isSshCommandError(result.failure)) {
            assert.equal(result.failure.exitCode, 1);
            assert.equal(result.failure.stderr.length, 16_384);
            assert.isTrue(result.failure.stderr.endsWith(diagnostic));
            assert.equal(result.failure.message, result.failure.stderr.trim());
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );
});
