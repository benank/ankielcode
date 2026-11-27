# Source control

Ankiel Code integrates with GitHub, GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps, GitCafe, and Cursor
Origin to clone and publish repositories, create pull requests, and review changes.

## Review turn changes

A turn's changed files and diff show only the turn's own work. When a turn pulls, merges, or
rebases, the files Git brought in are left out. A file stays in the list when the turn edited it,
committed it, or fixed a conflict in it. Use the branch comparison to review everything that changed
against your base branch. Restore still returns the complete saved workspace.

In a [project with several repositories](multi-repo-projects.md),
the Diff pane shows every repository the turn changed. Use the repository picker next to the source picker to narrow the diff to one of
them. Paths in the diff start at the thread's folder, so the same file name in two repositories
stays apart. This works when the project folder itself is not a Git repository; the branch
comparison and uncommitted changes read one repository at a time, chosen from the same picker.

The thread details panel lists each repository the thread has changed, most recent first, with its
branch and uncommitted changes. Expand one to commit, push, or open a pull request in that
repository; a pull request opened there, or already open for its branch when a turn ends, is linked
to the thread. **Other repositories...** adds any other repository of the project to the list until you
reload. In a worktree thread of a project with several repositories it adds a worktree of that
repository to the thread instead; see [Worktree threads](multi-repo-projects.md#worktree-threads). A
worktree thread of a single repository does not offer it.

On desktop, open the Diff pane source picker and choose **Commits** to review one local
commit at a time. The list shows the newest 100 commits in the branch comparison. A merge commit
shows its changes against its first parent.

A commit link from a supported code host opens in the Diff pane when the thread's repository has
that commit locally, on any branch. Otherwise a pull request commit link opens the pull request. Other
commit links follow your **Open links in** setting; on web, when that opens a new tab, Ankiel Code first
shows an **Open link** button. Command/Ctrl+Click always opens the link in your browser. Commit links follow the **Open pull requests in Ankiel Code**
setting in **Settings → Diffs**.

## Connect an account

Install Git and configure authentication on the machine running your Ankiel Code server. For a remote
environment, do this on the remote machine. After signing in, open **Settings → Source control & issues**
and choose **Rescan**.

### GitHub

GitHub integration is off by default. To enable issue and pull request features, turn on
**GitHub integration** in **Settings → Source control & issues** for the environment you want to
connect. Turning it off pauses automatic pull request discovery and watches.

Ankiel Code talks to GitHub's API directly and only needs a token. Any of these works, in this
order of precedence:

1. A token saved in **Settings → Source control & issues → GitHub**. It is kept in the server's secret
   store, and works without the GitHub CLI.
2. `GH_TOKEN` (`GH_ENTERPRISE_TOKEN` with `GH_HOST` for GitHub Enterprise Server) in the
   server's environment.
3. [GitHub CLI](https://cli.github.com/) 2.81.0 or newer, signed in with `gh auth login`.

If `gh` is signed in to several accounts or hosts, expand **GitHub** in the same place to pick
the account each host uses or turn a host off. A saved token or `GH_TOKEN` takes precedence
over that choice; a host turned off stays off either way.

For GitHub Enterprise, sign in with `gh auth login --hostname YOUR_HOST`. Ankiel Code treats a
custom server name as GitHub once it has a credential for that host.

### Forgejo and Gitea

Install [Forgejo CLI (`fj`)](https://codeberg.org/forgejo-contrib/forgejo-cli) or
[Gitea CLI (`tea`)](https://gitea.com/gitea/tea) 0.16 or later on your Ankiel Code server.
Sign in with `fj --host https://your-server auth add-token` or `tea login add`.
Repeat for each server you use, including Codeberg.

Ankiel Code prefers a matching `fj` login and falls back to `tea` when `fj` is unavailable
or has no login for that server. Once an account is selected, failed actions stay on that
account. Settings shows the detected CLI. Forgejo and Gitea share one integration entry.
Servers hosted under a URL subpath, such as `https://example.com/forgejo`, use `tea` because
fj does not preserve the subpath when checking its account.

When cloning or publishing, use a full repository URL to select a specific server.
You can use `owner/repo` when only one fj server is configured, or with your default `tea`
login when fj is unavailable or unconfigured. With multiple fj servers, use the full URL.
If you have multiple `tea` accounts on one server, select one with
`tea login default <login-name>`. Git push and clone also need Git credentials or an SSH key
for that server.

### GitLab

Install [GitLab CLI](https://gitlab.com/gitlab-org/cli), then sign in:

```bash
glab auth login
```

### Bitbucket

Open **Settings → Source control & issues**, expand **Bitbucket**, and enter one of:

- **Access token**: a token created for one repository, project, or workspace. It can only reach
  what it was created for.
- **Atlassian account email** and **API token**: an Atlassian API token for your account. It can
  reach every repository you can. Give it read/write access to repositories and pull requests, plus
  user read access (`read:user:bitbucket`) and workspace read access (`read:workspace:bitbucket`).

A field saves when you leave it, and applies right away. The access token wins when both are saved.
Credentials are saved on the environment's server, so select a remote environment to configure
it. Saved tokens can't be viewed again; enter a new one to replace it, or choose **Remove** to clear
everything saved for Bitbucket.

If no credentials are saved, Ankiel Code falls back to these variables in the server's environment.
Restart the server after changing them:

```bash
export ANKIEL_BITBUCKET_ACCESS_TOKEN="your-access-token"
# or
export ANKIEL_BITBUCKET_EMAIL="you@example.com"
export ANKIEL_BITBUCKET_API_TOKEN="your-token"
```

For a background service, put these `KEY=VALUE` entries in
[`service.env`](./background-service.md#configure-the-service-environment)
under Ankiel home, then run `ankiel service restart`. Service installation and updates
preserve that file.

### Azure DevOps

Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), add the DevOps extension, and sign in:

```bash
az extension add --name azure-devops
az login
```

### GitCafe

Install the GitCafe CLI and sign in:

```bash
bun install -g @gitcafe/cli
cafe auth login --host https://git.cafe/api
```

Alternatively, open **Settings → Source control & issues**, expand **GitCafe**, and enter a token. It is
kept in the server's secret store, applies right away, and is used before `CAFE_TOKEN` and the
`cafe` login. Or set `CAFE_TOKEN` in the server's environment and restart it. Both tokens are only
sent to `git.cafe`; `CAFE_TOKEN` follows `CAFE_HOST` if you set it. Repositories on
`staging.git.cafe` need their own login with `--host https://staging.git.cafe/api`.

Line comments are not available for GitCafe pull requests yet.
Merging a stack lands it through GitCafe, and updating a branch restacks the layers above it.

### TanStack Source

TanStack Source is in private beta, so the server shows it only when its environment turns the flag
on: `export ANKIEL_FEATURE_FLAGS=tanstack_source` in your shell profile, then restart Ankiel Code. Separate
several flags with commas. A value already set in the server's own environment, such as a service
definition, is used instead of the profile. Install its CLI and sign in:

```sh
curl -fsSL https://source.tanstack.com/install | sh
src auth login --web
```

Alternatively, open **Settings → Source control & issues**, expand **TanStack Source**, and enter a token
from `https://source.tanstack.com/settings/tokens`. A saved token is used before `SRC_TOKEN`, which is
used before the `src` login. With several `src` logins, pick the account there too.

Issues can be listed, filed, edited, commented on and closed. Reactions and picking reviewers or assignees
from a list are not available yet.

### Cursor Origin

Install the [Origin CLI](https://cursor.com/docs/origin/cli) and sign in. Signing in also sets up Git
credentials for `origin.cursor.com`:

```bash
curl -fsSL https://downloads.cursor.com/origin/install.sh | sh
origin auth login
```

If cloning or pushing asks for a username, run `origin auth setup-git` to point Git at the CLI's
credentials again. Origin repositories use HTTPS and are published privately. Repositories mirrored
from GitHub keep their pull requests on GitHub; open those from the GitHub remote.

## Start, clone, or publish a project

To start from nothing, choose **New project** in the command palette (`Cmd/Ctrl+K`), or
**New project** under **Add Project** on any client, and type a name. Ankiel Code makes a Git
repository in `~/.ankiel/projects` (the `projects` folder of your Ankiel data directory) with a README,
an icon, and a first commit, then opens a new thread in it. Until the project has a thread, new
threads work in its folder, even when your default is a new worktree. The folder is named after the project,
like `pinball-stats` for "Pinball Stats". Turn on **Create private repository on GitHub** to also
publish it. If Git has no name or email on that machine, the project is created without the
first commit.

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Choose a hosting
provider or paste a Git URL, then choose where to save it. Only GitHub is listed at first. To list
another provider here and in **Publish Repository**, turn on its switch under
**Settings → Source control & issues**. A branch or file page copied from GitHub,
GitLab, GitCafe, Codeberg or Bitbucket also works: Ankiel Code clones that repository's default branch.
On other hosts, paste the repository's clone URL. The project opens right away while the
clone runs in the background: you can write your first prompt, and sending waits until the files
are in place. A toast tracks progress and lets you cancel; if the clone fails, retry it from the
toast or from the banner above the composer. When the host refuses the machine's SSH key, Ankiel Code
clones over HTTPS with Git's credentials for that host instead, and the project's remote uses the
HTTPS URL.

To lay clones out like [ghq](https://github.com/x-motemen/ghq), turn on **Clone into host folders**
under **Settings → Threads** (or **Source control** on mobile). Clones then default to
`<host>/<owner>/<repo>` under **Add project starts in**, so set that to `~/ghq` to share ghq's
folders. You can still change the destination before cloning.

For a local Git repository without a remote, **Publish Repository** creates a hosted repository,
adds it as `origin`, and pushes your commits. If there are no commits yet, it creates the remote;
make your first commit before pushing.

## Create a pull request

Use a thread's Git actions to commit, push, and create a pull request. Ankiel Code can generate commit
messages, review titles, and descriptions from your changes. Descriptions also draw on the work in
the thread, including the checks it ran.

An existing fork PR can appear beside the branch even if you pushed without setting an upstream.
If its badge is missing because several remotes hold that branch, set the branch's upstream to
the intended remote with `git branch --set-upstream-to=<remote>/<branch>`.

Choose how commit messages and pull request titles and descriptions are written in
**Settings → Source control & issues → Commits & pull requests**. **Repository conventions** uses the
project's instructions and recent commit subjects. **Custom instructions** applies your own
instructions to commits and pull requests.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket,
  check the credentials saved in Settings → Source control & issues, or confirm the running server received
  the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0, or save a token in Settings → Source control & issues.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the hosting provider's API access.

## Issues

The Issues page lists the issues of every project whose remote is on GitHub, GitLab, Azure
DevOps or Forgejo, grouped per tracker account. Open it from the sidebar's utility row or with
**Open issues** in the command palette. Filter by open or closed, by your involvement
(assigned, opened by you, mentioning you), and by tracker. Under **Projects**, uncheck the
projects you do not want to see; the list remembers them, and a project you add later shows.
The search box asks the tracker itself where it can search. Press **Load more** at the end of a group to read further back.
The **Views** menu saves and restores a search, filter, and sort setup.

Select an issue to open it beside the list: description, comments, state changes, linked pull
requests, labels, assignees, and reactions. Linked pull requests open on the host. You can
comment, edit the title and description, change labels and assignees, react, and move it to
another state when the tracker and your account allow it. Where a GitHub repository has issue
statuses (Backlog, Todo, In progress, and so on), those are the states you move between;
elsewhere you close or reopen, with a close reason where the
tracker records one. An issue read through a project that does not own its repository is shown read-only.

An issue can be kept with a thread: open it beside the thread (issue links in the conversation
open there) and use **Link to this thread** in its header; **Unlink** undoes it. Click the issue
badge in the thread sidebar to see its issues in **Linked items**. Select an issue there to open it beside the thread.

Writing to a tracker over a remote connection requires the `source-control:write` scope.
