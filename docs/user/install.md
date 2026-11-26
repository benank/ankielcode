# Install Ankiel Code

Ankiel Code runs coding agents on your computer and lets you control them from its
desktop or mobile app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch Ankiel Code and configure providers afterwards.

## Command line

```bash
curl -fsSL https://code.ankiel.com/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://code.ankiel.com/install.ps1 | iex
```

This installs the `ankiel` command to `~/.local/bin`. If that folder is not on your
`PATH` yet, the installer says so and, for zsh, bash on Linux, and fish, prints
a command to add it. On Windows, `ankiel` works in the same PowerShell window right
away; add the folder to your `PATH` for new windows. If a `ankiel` that the
installer or an earlier desktop app did not create is already there, it leaves
that one alone and stops. Set `ANKIEL_CHANNEL=nightly` to install the nightly train, or
`ANKIEL_VERSION` to pin an exact version.

| Task                              | Command                                                                     |
| --------------------------------- | --------------------------------------------------------------------------- |
| Start the server in the terminal  | `ankiel serve`                                                              |
| Use it from your other devices    | `ankiel up` ([details](./remote-access.md))                                 |
| Keep it running in the background | `ankiel service install` ([details](./background-service.md))               |
| Move to the newest release        | `ankiel update`                                                             |
| Reclaim database space            | `ankiel doctor` ([details](./background-service.md#reclaim-database-space)) |
| Remove it again                   | `ankiel uninstall`                                                          |

Run `ankiel help` or `ankiel --help` for the full reference. `ankiel` on its own runs
the server like `ankiel serve` and also adds the current directory as a project; it
never opens a browser. To start in a new working directory, use an explicit path such
as `ankiel ./my-project`. A bare directory name is accepted only if it already exists.

If `ankiel` or `ankiel start` reports an already running server, run the `ankiel pair`
command it names and paste the pairing URL into **Add environment** in the desktop or mobile
app to connect to that server. Stop it
before starting a replacement, or use a different `--base-dir` for an
independent server.

Ankiel Code is no longer published to npm. If you installed it with
`npm install -g @ankielcode/cli`, that install keeps running the version it has but no
longer updates. Run `npm uninstall -g @ankielcode/cli`, then the install command above.

### Intel Macs

There is no `ankiel` executable for Intel Macs (the desktop app is available). To
run a server there, build it from source with `vp`, which provides the Node version it needs
([Install vp](../operations/00_development.md#first-checkout)):

```bash
git clone https://github.com/benank/ankielcode
cd ankielcode && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

`ankiel update` and the background service do not apply to a server run this way;
update it with `git pull` and a rebuild.

## Desktop app

Download a release from [GitHub Releases](https://github.com/benank/ankielcode/releases)
or [code.ankiel.com/download](https://code.ankiel.com/download). On Debian and Ubuntu,
install the `.deb` with `sudo apt install ./Ankiel-Code-*.deb`.

### Linux

AppImage and `.deb` downloads are available for x86_64 and ARM64. Check your
architecture with `uname -m`: for `x86_64`, choose a file ending in
`x86_64.AppImage` or `amd64.deb`; for `aarch64`, choose `arm64.AppImage` or
`arm64.deb`.

To launch an AppImage, open a terminal in its download folder. Replace
`Ankiel-Code.AppImage` below with the exact filename you downloaded:

```bash
chmod +x ./Ankiel-Code.AppImage
./Ankiel-Code.AppImage
```

The `.deb` updates itself like the other desktop builds. It asks for your
password to install each update. If your desktop has no password prompt, the
update fails. Download the new `.deb` and install it the same way.

### The `ankiel` command

The desktop app does not need the `ankiel` command. For commands such as
`ankiel triage` or `ankiel doctor` on the same machine, install it with the
[command line](#command-line) installer.

Earlier desktop releases installed their own `ankiel`: a launcher in
`~/.ankiel/bin`, linked from `~/.local/bin` or `~/bin` on macOS and Linux, or added
to your `PATH` on Windows. The app no longer updates it, so it stops working once
the app moves or an AppImage update changes its file name. On macOS and Linux the
installer replaces the link in `~/.local/bin`. On Windows, remove
`%USERPROFILE%\.ankiel\bin` from your `PATH` if the installer says another `ankiel`
runs first.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Sharing & access** to run agents and projects
there. Install the provider CLIs inside that distro. Ankiel Code installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Drop a folder on the sidebar

Drag one or more folders from Finder, Explorer, or your file manager onto the
sidebar. Each one opens as a project on this computer. Files dropped on a thread still attach to that thread.

## Mobile app

There are no App Store or Google Play listings yet. Build the app from source with the
steps in [apps/mobile/README.md](../../apps/mobile/README.md), or install a build you
produced yourself.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider            | Install and authenticate                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex               | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude              | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor              | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build          | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| Kiro                | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                |
| OpenCode            | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity         | Install and sign in with Google from Ankiel Code's provider settings.                                                                                     |
| Pi                  | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code           | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx                  | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |
| ACP Registry agents | Add GitHub Copilot and other [ACP agents](./providers-acp.md#add-an-agent) from **Settings → Providers → Add provider → Show more**.                      |

Provider CLIs must be on the server's `PATH`. If Ankiel Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

Ankiel Code warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, mise, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or
the CLI's own update command when Ankiel Code cannot tell. Claude, Codex, and
OpenCode installs Ankiel Code cannot identify stay manual: update them through the
installer you used. Ankiel Code runs `mise upgrade`
only for a tool your mise config requests as `latest` when the provider's binary
path is a mise shim or under the tool's `installs/<tool>/latest` link; update a
pinned version, or a path into one version's directory, through mise yourself.
Update a CLI installed with Nix through Nix.
Cursor and Antigravity update with Ankiel Code. Homebrew and Chocolatey installs
compare against the version their package manager offers, which can trail the
npm release; update Claude installed with Chocolatey through Chocolatey.

The managed runtimes for Antigravity and for Codex connected through ChatGPT
first install the release Ankiel Code tested. When Ankiel Code finds a newer compatible
release, their setup in **Settings → Providers** offers an update.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Ankiel Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Kiro](./providers-kiro.md),
[Pi](./providers-pi.md), [Muse Code](./providers-muse.md), [fx](./providers-fx.md), and
[ACP Registry agents](./providers-acp.md).

### Provider check timeouts

If a provider works in its CLI but Ankiel Code reports a timeout while checking it,
allow more time in the Ankiel server's environment. For example, give Codex and
Claude readiness checks 60 seconds:

```bash
ANKIEL_CODEX_PROBE_TIMEOUT_MS=60000 ANKIEL_CLAUDE_PROBE_TIMEOUT_MS=60000 ankiel serve
```

For a remote environment, set these on the machine running the Ankiel server.
Keep them in your launcher or service configuration to retain them across
updates, then restart the server. For systemd, add
`Environment=ANKIEL_CODEX_PROBE_TIMEOUT_MS=60000` under `[Service]` in a service
override, reload systemd, and restart the service. Provider instances can also
set their own overrides in Settings → Providers.

Each variable extends that provider's readiness-probe deadlines; a phase whose
default is already longer keeps its default. Providers with several phases can
take longer than one deadline in total. Values must be whole milliseconds no
greater than 2147483647; unset or invalid values keep the defaults.

| Provider            | Environment variable                   |
| ------------------- | -------------------------------------- |
| Codex               | `ANKIEL_CODEX_PROBE_TIMEOUT_MS`        |
| Claude              | `ANKIEL_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor              | `ANKIEL_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity         | `ANKIEL_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok                | `ANKIEL_GROK_PROBE_TIMEOUT_MS`         |
| Kiro                | `ANKIEL_KIRO_PROBE_TIMEOUT_MS`         |
| fx                  | `ANKIEL_FX_PROBE_TIMEOUT_MS`           |
| Pi                  | `ANKIEL_PI_PROBE_TIMEOUT_MS`           |
| Muse Code           | `ANKIEL_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode            | `ANKIEL_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry agents | `ANKIEL_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

Longer deadlines also take longer to report a stalled check. These overrides
cover readiness and discovery, including OpenCode server startup. Usage and
config enrichment retain their own shorter limits. Turn execution, package
installation, update checks, and shutdown limits keep their existing behavior.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a host available.
- [Updating Ankiel Code](./updating.md): update the app and connected servers.
