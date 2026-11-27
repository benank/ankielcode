import Foundation
import Observation

public enum PullRequestLoad<Value: Sendable & Hashable>: Sendable, Hashable {
  case idle
  case loading
  case loaded(Value)
  case failed(PullRequestError)

  public var value: Value? {
    if case .loaded(let value) = self { value } else { nil }
  }

  public var error: PullRequestError? {
    if case .failed(let error) = self { error } else { nil }
  }
}

/// Last answers per pull request, so reopening one shows at once and refreshes behind it.
@MainActor
public final class PullRequestDetailCache {
  struct Entry {
    var detail: PullRequestDetail?
    var activity: PullRequestActivity?
    var checks: PullRequestChecks?
  }
  private var entries: [String: Entry] = [:]
  private var order: [String] = []

  public init() {}

  func get(_ key: String) -> Entry? { entries[key] }

  func update(_ key: String, _ change: (inout Entry) -> Void) {
    var entry = entries[key] ?? Entry()
    change(&entry)
    entries[key] = entry
    order.removeAll { $0 == key }
    order.append(key)
    while order.count > 50 { entries[order.removeFirst()] = nil }
  }
}

/// One open pull request: its detail, conversation, checks, diff and what the reader is doing
/// with it (viewed marks, pending review comments, a write in flight).
@MainActor
@Observable
public final class PullRequestDetailModel {
  public let environmentId: String
  public let ref: PullRequestRef
  /// What the list or a thread already knew, shown until the detail answers.
  public let preview: PullRequestListEntry?

  public private(set) var detail: PullRequestLoad<PullRequestDetail> = .idle
  public private(set) var activity: PullRequestLoad<PullRequestActivity> = .idle
  public private(set) var checks: PullRequestLoad<PullRequestChecks> = .idle
  public private(set) var linkedThreads: [PullRequestLinkedThreadsResult.Thread] = []
  public private(set) var diff: PullRequestLoad<[DiffFile]> = .idle
  public private(set) var diffMore = false
  public private(set) var diffTruncated = false
  public private(set) var viewedHost: PullRequestFilesViewedResult?
  public private(set) var viewedPresses: [String: Bool] = [:]
  public private(set) var pendingReactions: [String: [PullRequestReactionContent: Bool]] = [:]
  /// Inline comments waiting for the review to be submitted.
  public private(set) var reviewDrafts: [PullRequestReviewCommentDraft] = []
  /// The write in flight (its label key), if any.
  public private(set) var busy: String?
  public private(set) var refreshing = false
  public var folds = PullRequestDiffs.Folds()
  /// Hides test files in the file list (the user's choice).
  public var hideTests = false

  @ObservationIgnored let source: any PullRequestSource
  @ObservationIgnored let sink: any PullRequestSink
  @ObservationIgnored let cache: PullRequestDetailCache?
  @ObservationIgnored private var diffPages: [PullRequestDiffResult] = []
  @ObservationIgnored private var diffCursor: String?

  public init(
    environmentId: String, ref: PullRequestRef, preview: PullRequestListEntry? = nil, source: any PullRequestSource,
    sink: any PullRequestSink, cache: PullRequestDetailCache? = nil
  ) {
    self.environmentId = environmentId
    self.ref = ref
    self.preview = preview
    self.source = source
    self.sink = sink
    self.cache = cache
    if let held = cache?.get(ref.key) {
      if let detail = held.detail { self.detail = .loaded(detail) }
      if let activity = held.activity { self.activity = .loaded(activity) }
      if let checks = held.checks { self.checks = .loaded(checks) }
    }
  }

  public var value: PullRequestDetail? { detail.value }

  public var viewed: Set<String> { PullRequestDiffs.viewed(host: viewedHost, presses: viewedPresses) }

  /// The checks shown: the separate read when it answered (it refreshes faster), else the detail's.
  public var shownChecks: [PullRequestCheck] { checks.value?.checks ?? value?.checks ?? [] }

  public var threads: [PullRequestReviewThread] { activity.value?.conversationThreads ?? [] }

  // MARK: Reads

  /// The detail, conversation, checks and linked threads, each on its own.
  public func load() async {
    if detail.value == nil { detail = .loading }
    if activity.value == nil { activity = .loading }
    async let detail: Void = loadDetail()
    async let activity: Void = loadActivity()
    async let checks: Void = loadChecks()
    async let linked: Void = loadLinkedThreads()
    _ = await (detail, activity, checks, linked)
  }

  /// Pull to refresh: drops the computer's cache for this pull request, then reads again.
  public func refresh() async {
    refreshing = true
    await source.invalidate(ref, in: environmentId)
    await load()
    if diff.value != nil { await loadDiff(reset: true) }
    refreshing = false
  }

  func loadDetail() async {
    do throws(PullRequestError) {
      let value = try await source.detail(ref, in: environmentId)
      detail = .loaded(value)
      cache?.update(ref.key) { $0.detail = value }
    } catch {
      if detail.value == nil { detail = .failed(error) }
    }
  }

  func loadActivity() async {
    do throws(PullRequestError) {
      let value = try await source.activity(ref, in: environmentId)
      activity = .loaded(value)
      pendingReactions = [:]
      cache?.update(ref.key) { $0.activity = value }
    } catch {
      if activity.value == nil { activity = .failed(error) }
    }
  }

  public func loadChecks() async {
    do throws(PullRequestError) {
      let value = try await source.checks(ref, in: environmentId)
      checks = .loaded(value)
      cache?.update(ref.key) { $0.checks = value }
    } catch {
      if checks.value == nil { checks = .failed(error) }
    }
  }

  func loadLinkedThreads() async {
    linkedThreads = (try? await source.linkedThreads(ref, in: environmentId).threads) ?? linkedThreads
  }

  /// The first page of the diff (or every page again), and the viewed marks.
  public func loadDiff(reset: Bool = false) async {
    if reset || diff.value == nil {
      diffPages = []
      diffCursor = nil
      if diff.value == nil { diff = .loading }
    }
    async let viewed: Void = loadViewed()
    do throws(PullRequestError) {
      let page = try await source.diff(PullRequestDiffRequest(ref: ref), in: environmentId)
      diffPages = [page]
      diffCursor = page.nextCursor
      diffMore = page.nextCursor != nil
      diffTruncated = page.truncated
      diff = .loaded(PullRequestDiffs.files(diffPages))
    } catch {
      if diff.value == nil { diff = .failed(error) }
    }
    await viewed
  }

  /// The next page of a large diff.
  public func loadMoreDiff() async {
    guard let cursor = diffCursor, busy != "diff" else { return }
    busy = "diff"
    defer { busy = nil }
    do throws(PullRequestError) {
      let page = try await source.diff(PullRequestDiffRequest(ref: ref, cursor: cursor), in: environmentId)
      diffPages.append(page)
      diffCursor = page.nextCursor
      diffMore = page.nextCursor != nil
      diffTruncated = diffTruncated || page.truncated
      diff = .loaded(PullRequestDiffs.files(diffPages))
    } catch {
      diffMore = true
    }
  }

  func loadViewed() async {
    guard value?.capabilities.viewedFiles != nil || viewedHost == nil else { return }
    if let result = try? await source.filesViewed(ref, in: environmentId) {
      viewedHost = result
      viewedPresses = [:]
    }
  }

  // MARK: Writes (every one through the sink)

  /// Sends one write and reads back what it changed. Returns the error to show, if any.
  @discardableResult
  public func send(_ write: PullRequestWrite, label: String, reload: Reload = .all) async -> PullRequestError? {
    guard busy == nil || label == "reaction" || label == "viewed" else { return .failed("Another change is still being sent.") }
    if label != "reaction", label != "viewed" { busy = label }
    defer { if busy == label { busy = nil } }
    do throws(PullRequestError) {
      _ = try await sink.send(write, in: environmentId)
    } catch {
      return error
    }
    switch reload {
    case .none: break
    case .activity: await loadActivity()
    case .all:
      await loadDetail()
      await loadActivity()
    }
    return nil
  }

  public enum Reload: Sendable { case none, activity, all }

  public func comment(_ body: String) async -> PullRequestError? {
    await send(.comment(ref, body: body), label: "comment", reload: .activity)
  }

  public func reply(to thread: PullRequestReviewThread, body: String) async -> PullRequestError? {
    await send(.reply(ref, threadId: thread.id, body: body), label: "reply", reload: .activity)
  }

  public func resolve(_ thread: PullRequestReviewThread, resolved: Bool) async -> PullRequestError? {
    await send(.resolveThread(ref, threadId: thread.id, resolved: resolved), label: "resolve", reload: .activity)
  }

  /// Toggles a reaction at once; the host's next read replaces the guess. `subjectId` nil reacts
  /// to the pull request itself.
  public func react(_ content: PullRequestReactionContent, on subjectId: String?, current: [PullRequestReaction]) async -> PullRequestError? {
    let key = subjectId ?? ""
    let shown = PullRequestReactions.applying(pendingReactions[key] ?? [:], to: current)
    let reacted = !(shown.first { $0.content == .known(content) }?.viewerHasReacted ?? false)
    pendingReactions[key, default: [:]][content] = reacted
    let error = await send(.react(ref, subjectId: subjectId, content: content, reacted: reacted), label: "reaction", reload: .none)
    if error != nil { pendingReactions[key]?[content] = nil }
    return error
  }

  public func reactions(_ reactions: [PullRequestReaction], subjectId: String?) -> [PullRequestReaction] {
    PullRequestReactions.applying(pendingReactions[subjectId ?? ""] ?? [:], to: reactions)
  }

  public func setViewed(_ path: String, _ viewed: Bool) async -> PullRequestError? {
    viewedPresses[path] = viewed
    if viewed { folds.set(path, collapsed: nil) }
    let error = await send(.setFilesViewed(ref, files: [PullRequestViewedMark(path: path, viewed: viewed)]), label: "viewed", reload: .none)
    if error != nil { viewedPresses[path] = nil }
    return error
  }

  public func addDraft(_ draft: PullRequestReviewCommentDraft) {
    reviewDrafts.removeAll { $0.id == draft.id }
    reviewDrafts.append(draft)
  }

  public func removeDraft(_ draft: PullRequestReviewCommentDraft) {
    reviewDrafts.removeAll { $0.id == draft.id }
  }

  /// Submits the review with its pending inline comments; they clear once it lands.
  public func submitReview(_ verdict: PullRequestReviewVerdict, body: String) async -> PullRequestError? {
    let submission = PullRequestReviewSubmission(expectedHeadSha: value?.headSha, verdict: verdict, body: body, comments: reviewDrafts)
    let error = await send(.review(ref, submission), label: "review")
    if error == nil { reviewDrafts = [] }
    return error
  }

  public func run(_ action: PullRequestAction, mergeMethod: PullRequestMergeMethod? = nil) async -> PullRequestError? {
    let expected = action == .merge ? value?.headSha : nil
    let update = action == .updateBranch ? value.flatMap { PullRequestStatus.allowedUpdateMethods($0).first } : nil
    let request = PullRequestActionRequest(action: action, mergeMethod: mergeMethod, expectedHeadSha: expected, updateMethod: update)
    return await send(.action(ref, request), label: "action:\(action.rawValue)")
  }

  public func update(title: String?, body: String?) async -> PullRequestError? {
    await send(.update(ref, title: title, body: body), label: "update", reload: .all)
  }

  /// Sends the reviewer picks that still differ from the host, in batches.
  public func requestReviewers(add: [PullRequestReviewerChoice], remove: [PullRequestReviewerChoice]) async -> PullRequestError? {
    for batch in PullRequestSelection<PullRequestReviewerChoice>.batches(add) {
      if let error = await send(.requestReviewers(ref, reviewers: batch, requested: true), label: "reviewers", reload: .none) { return error }
    }
    for batch in PullRequestSelection<PullRequestReviewerChoice>.batches(remove) {
      if let error = await send(.requestReviewers(ref, reviewers: batch, requested: false), label: "reviewers", reload: .none) { return error }
    }
    await loadDetail()
    return nil
  }

  public func reviewerCandidates(query: String?) async throws(PullRequestError) -> PullRequestReviewerCandidateList {
    try await source.reviewerCandidates(ref, query: query, in: environmentId)
  }
}
