import AnkielKit
import Foundation

/// `--pull-requests`: read-only. Lists pull requests (open, everyone's), reads diff stats for the
/// first page, then one pull request's detail, activity, checks, viewed files, linked threads and
/// every page of its diff (parsed with the review parser), and the typed error for a number that
/// does not exist. Prints counts and shapes, never titles or bodies. Nothing is written.
func probePullRequests(
  _ session: EnvironmentSession, environment: SavedEnvironment, connector: EnvironmentConnector, number: Int?
) async throws {
  let rpc = session.rpc
  let started = ContinuousClock.now
  let list: PullRequestListResult
  do {
    list = try await PullRequestCalls.list(PullRequestListRequest(state: argument("--pr-state").flatMap(PullRequestListState.init(rawValue:)) ?? .open, involvement: .all, limit: 30), via: rpc)
  } catch {
    print("list failed:       \(PullRequestError(error))")
    return
  }
  print("list:              \(list.entries.count) entries in \(ContinuousClock.now - started), truncated=\(list.truncated) cursors=\(list.nextCursors.count)")
  print("providers:         \(list.providers.map { "\($0.kind)@\($0.host) configured=\($0.configured) searchesOnHost=\($0.searchesOnHost) projects=\($0.projectCount)" })")
  print("viewers:           \(list.viewers.count) host(s)")
  print("errors:            \(list.errors.count)")
  let byRepository = Dictionary(grouping: list.entries, by: \.repository)
  for (repository, entries) in byRepository.sorted(by: { $0.value.count > $1.value.count }).prefix(5) {
    let drafts = entries.filter(\.isDraft).count
    print("  repo #\(repository.hashValue & 0xFFFF): \(entries.count) open, \(drafts) draft, checks \(Dictionary(grouping: entries, by: { $0.checksState?.rawValue ?? "-" }).mapValues(\.count))")
  }

  let refs = list.entries.prefix(5).map { PullRequestRef(projectId: $0.projectId, host: $0.host, repository: $0.repository, number: $0.number) }
  if !refs.isEmpty {
    do {
      let stats = try await PullRequestCalls.stats(Array(refs), via: rpc)
      print("listStats:         \(stats.count) of \(refs.count) answered, sum +\(stats.reduce(0) { $0 + $1.additions }) −\(stats.reduce(0) { $0 + $1.deletions })")
    } catch {
      print("listStats failed:  \(PullRequestError(error))")
    }
  }

  let entry = number.flatMap { n in list.entries.first { $0.number == n } } ?? list.entries.first
  let ref: PullRequestRef
  if let entry {
    ref = PullRequestRef(projectId: entry.projectId, host: entry.host, repository: entry.repository, number: entry.number)
    print("\nreading one pull request (state \(entry.state.rawValue), draft \(entry.isDraft))")
  } else if let spec = argument("--pr-ref")?.split(separator: ":"), spec.count == 3, let n = Int(spec[2]) {
    // `--pr-ref <projectId>:<owner/repo>:<number>`: read a given number when the list is empty.
    ref = PullRequestRef(projectId: String(spec[0]), host: "github.com", repository: String(spec[1]), number: n)
    print("\nno listed pull request; reading the given reference")
  } else {
    print("no pull request to read in detail")
    return
  }
  do {
    let detail = try await PullRequestCalls.read(.detail, ref, as: PullRequestDetail.self, via: rpc)
    print("detail:            provider \(detail.provider), body \(detail.body.utf8.count) B, labels \(detail.labels.count), reviewers \(detail.reviewers.count), checks \(detail.checks.count)")
    print("  counts:          +\(detail.additions) −\(detail.deletions) files \(detail.changedFiles), mergeability \(detail.mergeability.rawValue)")
    print("  capabilities:    diff=\(detail.capabilities.diff) comment=\(detail.capabilities.comment) actions=\(detail.capabilities.actions.map(\.rawValue)) merge=\(detail.capabilities.mergeMethods.map(\.rawValue)) reactions=\(detail.capabilities.reactions ?? false) verdicts=\(detail.capabilities.review.verdicts.map(\.rawValue)) viewedFiles=\(detail.capabilities.viewedFiles ?? "-")")
    print("  viewer may:      actions=\(detail.viewerPermissions.actions.map(\.rawValue)) comment=\(detail.viewerPermissions.comment) verdicts=\(detail.viewerPermissions.verdicts.map(\.rawValue)) requestReviewers=\(detail.viewerPermissions.requestReviewers)")
    print("  merge allowed:   merge=\(detail.mergeCapabilities.merge) squash=\(detail.mergeCapabilities.squash) rebase=\(detail.mergeCapabilities.rebase) headSha=\(detail.headSha != nil)")
    let segments = PullRequestMarkdown.segments(detail.body)
    print("  body segments:   \(segments.map(\.kindName))")
  } catch {
    print("detail failed:     \(PullRequestError(error))")
  }
  do {
    let activity = try await PullRequestCalls.read(.activity, ref, as: PullRequestActivity.self, via: rpc)
    let kinds = Dictionary(grouping: activity.comments, by: { $0.kind.rawValue }).mapValues(\.count)
    print("activity:          comments \(activity.comments.count)/\(activity.commentCount) \(kinds), threads \(activity.reviewThreads.count) (+\(activity.overviewThreads.count) overview), commits \(activity.commits.count), reactions \(activity.reactions.count)")
  } catch {
    print("activity failed:   \(PullRequestError(error))")
  }
  do {
    let checks = try await PullRequestCalls.read(.checks, ref, as: PullRequestChecks.self, via: rpc)
    print("checks:            \(checks.checks.count) \(Dictionary(grouping: checks.checks, by: { $0.status.rawValue }).mapValues(\.count)) → \(PullRequestStatus.checksSummary(checks.checks).state)")
  } catch {
    print("checks failed:     \(PullRequestError(error))")
  }
  do {
    let viewed = try await PullRequestCalls.read(.filesViewed, ref, as: PullRequestFilesViewedResult.self, via: rpc)
    print("filesViewed:       \(viewed.files.count) reported, truncated=\(viewed.truncated)")
  } catch {
    print("filesViewed:       \(PullRequestError(error))")
  }
  do {
    let linked = try await PullRequestCalls.read(.linkedThreads, ref, as: PullRequestLinkedThreadsResult.self, via: rpc)
    print("linkedThreads:     \(linked.threads.count)")
  } catch {
    print("linkedThreads:     \(PullRequestError(error))")
  }

  // The diff is an HTTP route, paged by cursor.
  let vault = CredentialVault(environmentId: environment.environmentId, connector: connector)
  var cursor: String?
  var page = 0
  var files = 0
  var additions = 0
  var deletions = 0
  repeat {
    let diffStarted = ContinuousClock.now
    do {
      let result = try await connector.postJSON(
        PullRequestDiffRequest.path, body: PullRequestDiffRequest(ref: ref, cursor: cursor), endpoint: environment.endpoint,
        vault: vault, as: PullRequestDiffResult.self)
      let parsed = UnifiedDiff.parse(result.patch)
      page += 1
      files += parsed.files.count
      additions += parsed.additions
      deletions += parsed.deletions
      print("diff page \(page):       \(result.patch.utf8.count) B, \(parsed.files.count) files +\(parsed.additions) −\(parsed.deletions), truncated=\(result.truncated) omitted=\(result.omittedFileStats.count) next=\(result.nextCursor != nil) (\(ContinuousClock.now - diffStarted))")
      cursor = result.nextCursor
    } catch {
      print("diff failed:       \(PullRequestError(error))")
      cursor = nil
    }
  } while cursor != nil && page < 10
  if page > 0 { print("diff total:        \(files) files +\(additions) −\(deletions)") }

  var missing = ref
  missing.number = 999_999_999
  do {
    _ = try await PullRequestCalls.read(.detail, missing, as: PullRequestDetail.self, via: rpc)
    print("missing number:    answered?")
  } catch {
    print("missing number:    \(PullRequestError(error))")
  }
  var noProject = ref
  noProject.projectId = "probe-no-such-project"
  do {
    _ = try await PullRequestCalls.read(.detail, noProject, as: PullRequestDetail.self, via: rpc)
    print("unknown project:   answered?")
  } catch {
    print("unknown project:   \(PullRequestError(error))")
  }
}
