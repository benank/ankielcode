# Remote access

Connect a phone, browser, or another desktop app to Ankiel Code running on a different
machine. That machine must stay running and reachable while you work.

## Set up a host

For a command-line host, run:

```bash
ankiel up
```

It asks whether other devices on your local network may reach the machine, then
runs Ankiel Code as a [background service](./background-service.md). Run `ankiel up`
again to change your choice, and `ankiel status` to see it.

Instead of the background service, you can keep the desktop app running with
its local environment enabled. Closing the desktop app's last window stops its
local server.

`ankiel up` asks nothing when you name a choice: `--lan` or `--no-lan`. Choices you
do not name keep their settings, and `--yes` takes the defaults. Without a
terminal, a needed restart runs without asking, and stops running agent turns.
`ankiel status --json` prints the settings. `ankiel up --help` lists every flag with
examples.

## Cloudflare Relay

Connect from anywhere — on cellular, away from home, or from [app.code.ankiel.com](https://app.code.ankiel.com) — through a self-hosted relay running on your own Cloudflare account. There is no Ankiel account or hosted backend: your traffic only passes through your own Cloudflare Worker.

### 1. Deploy your relay

In the `relay/` directory of the Ankiel Code repository, run:

```bash
cd relay
npm install
npm run setup
```

The setup script logs into Cloudflare with `wrangler`, deploys the Worker and Durable Object (eligible on Cloudflare's Workers Free plan), generates a 256-bit `RELAY_SECRET`, and copies a setup string to your clipboard in the form:

```text
ankiel-relay://<your-relay-host>#<secret>
```

It works with a free `*.workers.dev` URL (path-prefix routing at `https://<worker>/h/<hostId>/`) or your own wildcard custom domain (`https://<hostId>.<domain>/`). See [Self-Hosting Ankiel Relay on Cloudflare](../../relay/SETUP_CLOUDFLARE.md) for automated GitHub Actions deploys and custom domain details.

### 2. Connect your host to the relay

- **Desktop app:** Open **Settings → Sharing & access → Remote relay**, click **Connect**, and paste your `ankiel-relay://<host>#<secret>` setup string.
- **Command-line or background service:** Pass `ANKIEL_RELAY_SETUP="ankiel-relay://<host>#<secret>"` in the server environment (for a background service, add it to [`service.env`](./background-service.md#configure-the-service-environment) and run `ankiel service restart`).

You can reuse the same setup string on every computer you want to reach; each computer derives its own persistent host ID automatically.

### 3. Pair your phone or another device

In **Settings → Sharing & access**, choose the **Cloudflare Relay** endpoint and generate a pairing link or QR code.

Scan the QR code on your phone or paste the pairing URL into **Add environment** in **Settings → Environments** on web, desktop, or mobile. On a computer with the desktop app, you can also open the `ankielcode://pair` app link.

Pairing authorizes that device for future connections. Use a fresh one-time link for each new device; you do not need the original token to reconnect. A device stays signed in while you keep using it, until you revoke it in **Settings → Sharing & access** on the host. One unused for 30 days, or paired with a host older than this release, has to pair again. Links created in Settings can only be copied from the client that created them while its Sharing & access page stays open. If you leave or reload that page, create another link to share.

## Same-network (LAN) access

When your phone, browser, or another computer is on the same Wi-Fi or local network as the host, Ankiel Code can connect directly over your LAN for lower latency without sending traffic through Cloudflare.

- **Desktop app:** Open **Settings → Sharing & access** and enable **Network access**. Changing network access restarts the desktop app. You can turn it off in the same place.
- **Command-line host:** Choose local network access in `ankiel up`, or run:

```bash
ankiel up --lan
```

- **Server in a terminal:** Run `ankiel serve --lan`.

If a server is already running, generate a fresh pairing link without restarting it:

```bash
ankiel pair
```

When network access is enabled, Ankiel Code accepts connections from your local network, so a pairing code is what keeps other devices on that network out. A loopback address such as `127.0.0.1` reaches only the device opening the link.

If your HTTPS endpoint uses a certificate from your own certificate authority, install that CA on Android as a **CA certificate** in its security settings; the Android app then trusts it.

### Automatic switching between LAN and Cloudflare Relay

A machine can have both a **same-network (LAN)** route and a **Cloudflare Relay** route. You only need to pair once:

- While connected to a host, Ankiel Code learns the host's available routes (its current LAN address when network access is on, and its Cloudflare Relay URL when the relay is connected).
- When the host's LAN address changes — for example after joining another Wi-Fi network — the learned route follows it.
- On the same network, Ankiel Code prefers the direct LAN route. Away from home, a LAN address that does not answer is checked briefly and skipped, and Ankiel Code seamlessly uses the Cloudflare Relay instead.
- While connected over the Cloudflare Relay, Ankiel Code checks the LAN route when your network changes, when you return to the app, and periodically in the background, moving back to LAN as soon as it answers.
- Sessions and thread sync stay intact across route switches so you can move between home Wi-Fi and cellular without losing your place.

A pairing link for a saved machine is refused when it comes from an address that machine does not have yet; add that address with **Add route** instead. Pairing again over an address the machine already has still works. A route whose machine refused this device's sign-in is marked **Sign-in refused**; pair that address again with **Add route** to use it.

On web and desktop, select the route count under the machine's name in **Settings → Environments** to see its routes, drag to reorder them, or remove a saved route. On mobile, open the machine under **Settings → Environments** and choose **Edit**. Learned routes cannot be removed individually; they go away when the host stops reporting that address or when the paired route they were learned through is removed.

Open **Permissions** next to **Routes** in web or desktop, or **Your permissions** in the mobile route details, to see what your current connection can do on that environment. Permissions shown there apply only to the route marked **In use**; other routes are not checked.

### Balance new threads across machines

Auto balance is off by default. On web and desktop, enable it in
**Settings → Environments → Load balancing** to automatically choose a machine for
new threads in projects grouped across connected environments. The section
appears once two or more machines are switched on.
Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and
memory available, **Less often** to reduce its share, or **Manual only** to exclude
it from automatic selection. These are preferences, not fixed traffic percentages.
Preferences are saved separately in each client.

The composer checks eligible machines when choosing a draft's environment, then keeps
that choice stable. Choose **Auto balance** again to check current resources, or choose
a specific machine to override it. Choosing a branch or worktree also keeps the draft
on that machine. Existing threads stay where they started. If resource checks are
unavailable or all eligible machines are full, choose a machine manually to continue.
Mobile keeps its manual environment selection.

### Hosted web app

[app.code.ankiel.com](https://app.code.ankiel.com) needs an HTTPS endpoint, such as your
Cloudflare Relay. It connects directly to your server; a hosted pairing link does not
make an unreachable backend reachable or convert HTTP to HTTPS. Opening a hosted pairing
link shows the server address and asks you to confirm before adding it.

For a plain HTTP LAN endpoint, use the direct pairing URL in a browser that can
open it, or pair from the desktop or mobile app. On mobile, an IP address entered without a
scheme uses HTTP, so include `https://` when your server uses HTTPS.

## Browser on a remote environment

Browser tabs belong to the environment, so you and your agents see the same
tabs from any device. The desktop app shows its own environment's tabs
directly. Every other device, and the desktop app for other environments,
streams them from the host. Agents keep using them while no device is
connected, and `localhost` addresses reach servers on the host.

A tab you open yourself in the desktop app for another environment loads on
your computer instead, so the element picker, screenshots, and annotations work
as they do locally. Its `localhost` addresses still reach servers on the host,
over the connection the app already has, whichever way you connected. If the
host cannot be reached, the tab shows a connection error; a `localhost`,
`127.0.0.1`, or `[::1]` address never opens a server on your own computer.
Other names that point at your computer, such as `/etc/hosts` entries, still
do. These tabs ignore your system proxy settings, so they can't reach a host
you connect to only through a proxy or over HTTPS with a privately issued
certificate. The web app keeps streaming.

The desktop app can also forward a port on the host to your computer, so any
app there, such as your own browser, `curl`, or a database client, reaches it
at `localhost`. Use the forward button on a server in the thread's **Servers**
list, or **Forwarded ports** in the command palette, where you can also type
any port number and stop forwards. A forward keeps the host's port number
unless that port is taken on your computer, in which case it uses a free one
and shows it. Forwards end when you stop them or quit the app. ⌘-click
(Ctrl-click on Windows and Linux) on a remote server forwards it and opens it
in your browser.

A forwarded port behaves like a server running on your computer: anything on
your computer can reach it, including web pages open in your browser, so a
forwarded service is exposed the same way a local dev server is. Forwards
listen only on your computer's loopback, never on your network. On Linux they
accept only apps running as your user; on macOS and Windows, other users signed
in to the same computer can reach them too.

On iPhone, iPad, and Android, a tab showing one of the host's `localhost` pages
has **Open on this device** in its menu. So does a long press on a `localhost`
link in a chat. It opens the page in the phone's own browser view, at the same
`localhost` address, so it scrolls and responds to touch natively. Like the
desktop app, it never opens a server on the phone itself. The streamed tab
stays where it was, and agents keep using it. Each host keeps its own cookies
and site data on the phone. On iPhone and iPad the page runs under a stand-in
address while the address bar shows `localhost`, so browser features that need
a secure page, such as the clipboard or service workers, aren't available there.

All of this rides the host's preview tunnel. Turn off **Settings → Sharing &
access → Preview tunnel** on the host to stop other devices from loading its
`localhost` pages themselves: port forwarding and **Open on this device** go
away, and open tunnels close. Tabs keep working by streaming from the host, so
anyone who can use the host's browser tabs can still view its `localhost` pages
there. An administrator can also turn it off with a
[managed policy](./managed-policy.md#other-capabilities).

The first tab downloads a headless Chrome, about 120 MB, into the Ankiel home. It
is the same browser [HTML renders](html-renders.md) use, so a host downloads it
only once. Some Linux hosts need [setup](#browser-host-setup) before it can
start.

Agent tabs have separate storage and share a Chromium process. Take control before
typing into an agent's tab, then release control when you want the agent to
continue. Read-only connections can watch without changing the page.

While you have control, the tab works with your device: text the page copies or
cuts goes to your clipboard, a file picker on the page opens your device's
picker, and a finished download is offered for you to save. Popups such as
sign-in windows open as their own tabs. Downloads stay on the host until the
tab closes. Audio does not play on your device.

On a phone, tap the floating preview's corner dot to show its controls, then
**Pop into separate window** to keep watching in picture-in-picture over other
apps.

### Local servers

The browser lists ports held by processes your terminals and agents started.
Ankiel Code reads which process holds each port and never connects to it, so a
listed port opens as `http://localhost:<port>` and might not be a web page. For
an HTTPS server or a specific path, set the **Preview URL** on the project
script that starts it; Ankiel Code checks that address and opens it as written.

To stop listing ports, set `ANKIEL_PORT_DISCOVERY=0` in the environment that
starts the Ankiel Code server, such as
[`service.env`](./background-service.md#configure-the-service-environment) for
the background service, and restart it. Script preview URLs still appear.

### Browser host setup

macOS, Windows, and Linux desktops run the browser as is. Some Linux hosts need
one-time setup: Ubuntu 23.10 and later block the sandbox the browser runs in,
and minimal images and containers lack libraries it loads. When that happens,
the server says so at startup, and browser tabs and HTML previews show the
command to run on the host:

```sh
sudo ankiel browser setup
```

The server shows the exact line for how you started it, and keeps your `PATH`
when you started it with `npx` and Node is installed only for your user. Where `ankiel` is not on your `PATH`, such as with only the
desktop app installed, it names the full path of the app's own `ankiel` instead. It allows Chrome's sandbox with an AppArmor profile and installs
any missing libraries and system fonts with apt; pages that load without text
can mean the host has no fonts. It is safe to run again, and each run reloads
the AppArmor profile: run it again if the browser reports a blocked sandbox on a
host restored from an image or snapshot, where the profile can be on disk
without being loaded. Without `sudo`, it only reports what it would change.

The browser runs in Chrome's sandbox by default. Chrome cannot start that sandbox
as root. If your Ankiel server runs as root, run it as a nonroot user to keep
sandboxing enabled. `ankiel browser setup` does not fix this root restriction.

If you need to run as root, or cannot enable the sandbox on your host, set
`ANKIEL_SERVER_BROWSER_SANDBOX=0` in the **Ankiel server's environment** and restart
the server. This disables Chrome's sandbox. For a manual launch:

```sh
ANKIEL_SERVER_BROWSER_SANDBOX=0 ankiel serve
```

For a systemd service, add `Environment=ANKIEL_SERVER_BROWSER_SANDBOX=0` under
`[Service]` in its configuration, run `sudo systemctl daemon-reload`, then restart
your Ankiel service. Setting the variable in an agent's terminal does not change the
environment of an already running Ankiel server.

## Connect an outside agent

Claude Code, Codex, ChatGPT and other agents Ankiel Code did not start can drive
threads on an environment through its MCP server. See
[outside agents](./outside-agents.md) for setup.

## Link another environment

Link two machines, such as your laptop and a VPS, and agents on one can work on
the other: launch, message, wait on and stop its threads, answer their
questions, and manage its queues, projects and scheduled tasks.

Linked environments is a beta. Turn it on for both machines in **Settings →
Labs**; on mobile, **Settings → Labs** lists each connected machine. On a
headless server, open its address in a browser and pair to reach its **Settings
→ Labs**, or add `"linkedEnvironmentsEnabled": true` to `settings.json` in its
`userdata` directory, such as `~/.ankiel/userdata/settings.json`; a running server
picks it up. While it is
off on either machine, agents start nothing over a link between them. A task
already running on the other machine still finishes, and if that machine has it
off, its result arrives once it is back on.

On the machine you will work from, open **Settings → Environments → Linked environments**,
choose **Link**, and pick the other machine or enter its address. The list
holds the machines this app knows. If this
app has an address for that machine and is connected to it with a session that
manages access there, it makes the pairing code itself; otherwise paste one
from that machine's **Settings → Sharing & access**. An address you type always
needs a pasted code. From a terminal, use
`ankiel environment link <address> --pairing-code <code> --access <mode>`.

To link many machines at once, choose **Link several…** (it appears once this
app has two other machines saved). Tick the machines, pick one access level for
all of them, and confirm once. A machine can be ticked when this app is
connected to it with a session that manages access there and has an address
another machine can reach; the list says why when it cannot. Each machine
reports its own result, and the ones that failed stay ticked so you can try
only those again. Machines already linked are left as they are.

For machines no app is connected to, put one `<address> <pairing-code>` per
line in a file (make each code with `ankiel pair` on that machine) and run
`ankiel environment link --from <file> --access <mode>`, or `--from -` to read
standard input. It prints a result per line, leaves machines already linked as
they are, and exits non-zero if any line failed, so the same file can be run
again with fresh codes for the failures.

You can also ask an agent to link a machine by name, such as "delegate this to
my vps". It shows a card in the thread where you pick the machine the same way
and the access, then approve. An address the agent gives that this app does
not know for one of your machines also needs a pasted code. Paste one only for
an address you trust: the code is sent there.

- The access you pick is the most agents from this machine may do there. An
  agent also never gets more there than its own mode here.
- Threads a link starts are marked **From** and this machine's name there.
- A full-access link works there like that machine's own agents. Below full
  access, the link's agents can change only threads it started, not that
  machine's own threads, projects or settings, and they skip its project setup
  scripts.
- The link shows up in that machine's **Settings → Sharing & access** like any
  outside agent, and can be revoked there. **Forget** on this machine also ends
  it there when that machine confirms it. If it can't, such as when it is
  offline or on an older Ankiel Code, Forget says so; revoke it in that machine's
  Sharing & access.
- A link stays valid while agents use it. One unused for 30 days expires, as
  does one to a machine on an older Ankiel Code after 30 days; link again with a
  new pairing code.

On web and desktop, **Settings → Environments** opens as a map of your machines:
this app, each environment with one line per route (the one in use is
highlighted), and the machines an environment links to. Select a machine to
manage it, or switch to **List** for the same controls as rows. To link from
the map, drag the plus on an environment onto another machine, or press it and
pick one. If this app is connected to both machines, knows an address the first
can reach the other at, and its session on the other one manages access there,
it needs no pairing code.

A machine this app is not connected to, shown only because another environment
links to it, can still be linked without a code when that link has full access:
drop the plus on it and the environment holding the link gets the pairing code
from it. Your session on that environment must manage access there and already
have the access you pick. The result
is a separate link with the access you pick, listed and revocable on the linked
machine like any other. Links still do not chain.

A link goes one way. To let the other machine's agents work back, tick **Also
link … back** when you create the link, or select a one-way link and use
**Link back…**. It is offered when this app is connected to both machines and
may manage access on each. Two machines linked to each other at the same access
are drawn as one line with an arrowhead at each end; they are still two links,
and each is forgotten on its own.

To link one environment to several machines at once, Shift-click the machines
(or Shift-drag a box around them, or press Space on a focused machine), then
drag the environment's plus onto any of them, or use **Link several…** above
the map. Dropping the plus on a stack offers the stack's machines. The dialog
ticks the machines it can link without a pairing code and says why for the
rest. When this app is connected to none of them, each needs a pairing code,
so the map says so and offers to link one at a time instead.

Large setups fold: machines known only through links that share the same
linking environments and access levels become one stack, and once this app
knows more than 12 environments, the ones that are not connected and have no
links fold by state. Select a stack to list and filter every machine in it.
Opening a stack on the map draws its first 24 below its card: the rest of the
map stays where it is and the map grows taller, so pan or press the fit button
to see all of it. **Find a machine** above the map searches by name, and Enter
goes to the first match. The **?** button above the map lists these gestures.

The map draws the links of the machines this app is connected to; a machine it
is not connected to may hold links the map cannot show. A link reaches one
machine and does not carry on through that machine's own links.

An agent can also hand a task to a linked machine with `delegate_task`: it runs
there as an ordinary thread, in the project with the same repository (or the
one `target.projectId` names), and this thread wakes with its result when it
ends, as for any delegated task. It keeps following the task across restarts.
If the other machine revokes the link, or the link is removed here, the task
fails with that reason.

### Read a linked machine's threads

You can read a thread on a linked machine without connecting this app to it. Open
a task that was delegated there from the thread's agents, or a thread link that
points there, and the thread opens read-only, streamed through the machine you
are connected to over its link. It follows the thread live. On web and desktop
it opens as a tab in the right panel, beside the thread you are in, or in the
main view with ⌘/Ctrl-click, like
[subagents and side chats](thread-sidebar.md#open-a-thread-beside-the-one-you-are-in).
On mobile it opens in the inspector on layouts that have one, where Maximize
fills the screen, and as its own screen elsewhere. It shows the same timeline as
any other thread on web and desktop, and a shorter read-only list on mobile.

- The view is marked **Read-only** with both machines' names. To reply, approve
  or stop the thread, choose **Connect to interact**. When the link has full
  access, this app pairs with that machine in one step and opens the thread
  there; you need permission to manage access on the machine you are connected
  to. Otherwise the add-environment form opens for that machine and asks for a
  pairing code you create on it.
- This app connects to that machine directly, so it must be able to reach one of
  the addresses the link uses. If it cannot, the view says so and stays
  read-only. The new connection appears in that machine's **Settings → Sharing &
  access**, named after this device and the machine it came through, and is
  revoked there like any other.
- Files, images and published visuals stay on that machine and do not load
  here. A command's output shows as of when you open its row.
- If this app is already connected to that machine, the thread opens there as
  usual instead.
- You need permission to read threads on the machine you are connected to, and
  Linked environments must be on there. Both machines need a version of Ankiel Code
  that has this view.

## Manage or revoke access

On the host, **Settings → Sharing & access** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `ankiel auth --help`.

When the app connects to more than one environment, choose one at the top of the
page. A desktop app with **Local environment** off can manage a background
service on the same machine this way.

A session with an open connection stays listed after its access credential
expires.

To choose a token's permissions, pass `--scope` once for each scope you want:

```sh
ankiel pair --scope orchestration:read --scope filesystem:read
```

The selected scopes replace the default permissions. The same option works with
`ankiel auth pairing create` and `ankiel auth session issue`; each command's
`--help` lists the available scopes. Without `--scope`, pairing tokens and issued
bearer sessions get the standard client permissions, including managing access.
A terminal or a full-access agent on the host can reach those as well, so a
client that should not manage access also needs to go without `terminal:operate`
and `orchestration:operate`.

To change an existing client's permissions, create a fresh pairing link with the
scopes it needs. In a browser opened directly on the environment, open that link
to replace the browser's current grant. For mobile or a saved remote environment
in web or desktop, use **Add Environment** with the fresh link or code; pairing
the same environment replaces its saved grant. Reconnecting alone does not change
permissions.

Grouping checkouts does not combine their permissions. Shared project settings
require `orchestration:operate` on every member environment; actions on one
checkout use that checkout's permissions.

`source-control:write` covers direct Git and pull request changes made from the
client: pushing, switching or creating branches, cloning, and removing
worktrees. It does not restrict what a task does. Starting a task in a new
worktree still creates that branch and worktree with `orchestration:operate`,
and the agent it runs can use Git however the environment allows. A project
that [lays out its worktrees with its own command](multi-repo-projects.md#lay-the-folder-out-yourself)
runs that command on the host, so creating a worktree there from the client also
needs `orchestration:operate` or `terminal:operate`; without one of them,
removing a worktree skips the project's `remove` command.

Settings changes, provider management, environment maintenance, access
management can each be granted separately.
New pairings without `--scope` include the standard client permissions. Existing clients keep the
permissions they paired with and can stay connected after an update, but newly
separated features may require pairing again with the permissions they need.
Older clients may show controls that the server denies. Create a fresh pairing
link to change a client's permissions.

`filesystem:read` allows browsing host files, opening workspace files, and viewing
local changes. Add `filesystem:write` to allow editing files or saving plans to
the workspace. These scopes control direct file access from the client.

Some permissions also give a client indirect access. With `terminal:operate`,
a client can run commands that read or change any files the server’s OS account
can access, even when the pairing link omits file permissions. Grant this permission
only to clients you trust with that capability.

Removing an environment from a device's connection settings only forgets it on
that device. Background-service [removal](./background-service.md#manage-the-service) is separate.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local environment. In the
desktop app, open **Settings → Environments** and switch off **Local
environment**. Ankiel Code restarts without a local server: no local agents or terminals run, WSL
backends stay off, and other devices can no longer connect to this computer. Your projects,
history, and saved connections are kept, and you keep working through your saved remote connections.
If a [background service](./background-service.md) on this computer uses the same Ankiel home, the
app still treats it as this computer: **Open in** and file reveal for its projects run here,
whichever connection you reach it through.

Switch **Local environment** back on in the same place to restart with your previous local
settings.
