import Foundation

/// The state a pull request shows: drafts are open pull requests that read as their own state.
public enum PullRequestDisplayState: String, Sendable, Hashable {
  case open, draft, merged, closed

  public init(state: WireEnum<PullRequestState>?, isDraft: Bool) {
    switch state?.known {
    case .open?, nil: self = isDraft ? .draft : .open
    case .merged?: self = .merged
    case .closed?: self = .closed
    }
  }
}

/// RN `pullRequestStatus.ts`, `pullRequestActions.ts` and `usePullRequestPermissions.ts`: the
/// rules, without copy. The app turns the values into words and colors.
public enum PullRequestStatus {
  // MARK: Checks

  public enum ChecksTone: Sendable, Hashable { case failing, attention, pending, passed, completed, none }

  public struct ChecksSummary: Sendable, Hashable {
    public var state: ChecksTone
    public var failed: Int
    public var actionRequired: Int
    public var pending: Int
    public var passed: Int
    public var total: Int
  }

  public static func isFailing(_ check: PullRequestCheck) -> Bool {
    check.status == .failure || check.status == .cancelled
  }

  public static func checksSummary(_ checks: [PullRequestCheck]) -> ChecksSummary {
    let failed = checks.filter(isFailing).count
    let required = checks.filter { $0.status == .actionRequired }.count
    let pending = checks.filter { $0.status == .pending }.count
    let passed = checks.filter { $0.status == .success }.count
    let state: ChecksTone =
      failed > 0 ? .failing : required > 0 ? .attention : pending > 0 ? .pending : passed > 0 ? .passed
      : checks.isEmpty ? .none : .completed
    return ChecksSummary(state: state, failed: failed, actionRequired: required, pending: pending, passed: passed, total: checks.count)
  }

  /// Failing first, then attention, running, the rest; by name within each.
  public static func orderedChecks(_ checks: [PullRequestCheck]) -> [PullRequestCheck] {
    func rank(_ check: PullRequestCheck) -> Int {
      if isFailing(check) { return 0 }
      switch check.status.known {
      case .actionRequired?: return 1
      case .pending?: return 2
      case .success?: return 4
      default: return 3
      }
    }
    return checks.sorted { rank($0) != rank($1) ? rank($0) < rank($1) : $0.name.localizedStandardCompare($1.name) == .orderedAscending }
  }

  // MARK: Reviews

  public enum ReviewTone: Sendable, Hashable {
    case changesRequested(count: Int)
    case approved(count: Int, by: String?)
    case commented(count: Int)
    case awaiting(requested: Int)
    case none
  }

  public struct ReviewEntry: Sendable, Hashable {
    public var comment: PullRequestComment
    public var state: String
    /// An approval older than the newest commit.
    public var outdated: Bool
  }

  /// GitHub and Forgejo send uppercase review states; Bitbucket and GitCafe lowercase.
  public static func normalizedReviewState(_ state: String?) -> String? {
    state?.uppercased().replacingOccurrences(of: "-", with: "_")
  }

  /// Each reviewer's latest decisive review (or their latest comment), as RN
  /// `pullRequestReviewSummary`.
  public static func reviewSummary(reviewers: [PullRequestActor], activity: PullRequestActivity?) -> (tone: ReviewTone, reviews: [ReviewEntry]) {
    var latest: [String: (PullRequestComment, String)] = [:]
    var comments: [String: (PullRequestComment, String)] = [:]
    var order: [String] = []
    for review in activity?.comments ?? [] {
      guard review.kind == .review, let state = normalizedReviewState(review.reviewState) else { continue }
      let key = review.author?.login ?? review.id
      if !order.contains(key) { order.append(key) }
      if state == "COMMENTED" {
        if let previous = comments[key], review.createdAt < previous.0.createdAt { continue }
        comments[key] = (review, state)
        continue
      }
      guard ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].contains(state) else { continue }
      if let previous = latest[key], review.createdAt < previous.0.createdAt { continue }
      latest[key] = (review, state)
    }
    let newestCommit = activity?.commits.compactMap(\.committedDate.date).max() ?? .distantPast
    var reviews: [ReviewEntry] = []
    for key in order {
      if let (review, state) = latest[key], state != "DISMISSED" {
        reviews.append(ReviewEntry(comment: review, state: state, outdated: state == "APPROVED" && (review.createdAt.date ?? .distantPast) < newestCommit))
      }
    }
    for key in order where latest[key] == nil {
      if let (review, state) = comments[key] { reviews.append(ReviewEntry(comment: review, state: state, outdated: false)) }
    }
    let requested = reviews.filter { $0.state == "CHANGES_REQUESTED" }
    let approved = reviews.filter { $0.state == "APPROVED" && !$0.outdated }
    let commented = reviews.filter { $0.state == "COMMENTED" }
    let tone: ReviewTone =
      if !requested.isEmpty { .changesRequested(count: requested.count) }
      else if !approved.isEmpty { .approved(count: approved.count, by: approved.count == 1 ? approved[0].comment.author?.login : nil) }
      else if !commented.isEmpty && reviewers.isEmpty { .commented(count: commented.count) }
      else if !reviewers.isEmpty { .awaiting(requested: reviewers.count) }
      else { .none }
    return (tone, reviews)
  }

  // MARK: Branch

  public enum BranchTone: Sendable, Hashable {
    case conflicts
    case behind(count: Int?)
    case upToDate
    case noConflicts
    case unknown
  }

  public static func branch(_ detail: PullRequestDetail) -> BranchTone {
    if detail.mergeability == .conflicting { return .conflicts }
    if detail.baseComparison == "behind" { return .behind(count: detail.behindBy) }
    if detail.baseComparison == "up-to-date" { return .upToDate }
    return detail.mergeability == .mergeable ? .noConflicts : .unknown
  }

  /// An open, ready pull request whose branch conflicts with its base.
  public static func hasConflict(state: WireEnum<PullRequestState>, isDraft: Bool, mergeability: WireEnum<PullRequestMergeability>?) -> Bool {
    state == .open && !isDraft && mergeability == .conflicting
  }

  // MARK: Actions

  public static func allowedMergeMethods(_ detail: PullRequestDetail) -> [PullRequestMergeMethod] {
    detail.capabilities.mergeMethods.compactMap(\.known).filter { detail.mergeCapabilities.allows($0) }
  }

  /// The picked method, else the project's default, else the last used, else squash, else the first.
  public static func resolveMergeMethod(
    _ detail: PullRequestDetail, selected: PullRequestMergeMethod?, projectDefault: PullRequestMergeMethod?,
    lastUsed: PullRequestMergeMethod?
  ) -> PullRequestMergeMethod? {
    let methods = allowedMergeMethods(detail)
    return [selected, projectDefault, lastUsed, .squash].compactMap(\.self).first(where: methods.contains) ?? methods.first
  }

  public static func allowedUpdateMethods(_ detail: PullRequestDetail) -> [PullRequestUpdateMethod] {
    let offered = detail.capabilities.updateMethods?.compactMap(\.known) ?? []
    let allowed = Set(detail.viewerPermissions.updateMethods?.compactMap(\.known) ?? [])
    return offered.filter(allowed.contains)
  }

  public static func canPerform(_ action: PullRequestAction, on detail: PullRequestDetail) -> Bool {
    guard detail.capabilities.actions.contains(.known(action)), detail.viewerPermissions.actions.contains(.known(action)) else {
      return false
    }
    switch action {
    case .reopen: return detail.state == .closed
    case .revert: return detail.state == .merged
    case .deleteBranch: return detail.state != .open && detail.capabilities.deleteBranch == true
    default: break
    }
    guard detail.state == .open else { return false }
    switch action {
    case .updateBranch: return !allowedUpdateMethods(detail).isEmpty
    case .approveWorkflows: return (detail.workflowApprovalsRequired ?? 0) > 0
    case .ready: return detail.isDraft
    case .draft: return !detail.isDraft
    case .merge: return !detail.isDraft && detail.mergeability != .conflicting && !allowedMergeMethods(detail).isEmpty
    case .enableAutoMerge: return !detail.isDraft && detail.autoMergeEnabled == false && !allowedMergeMethods(detail).isEmpty
    case .disableAutoMerge: return detail.autoMergeEnabled == true
    default: return true
    }
  }

  public enum MergeBlock: Sendable, Hashable {
    case merged, closed, readOnly, unsupported, notAllowed, draft, conflicts, noMethods
  }

  /// Why merge is not offered, in RN's order; nil when it is.
  public static func mergeBlock(_ detail: PullRequestDetail, canWrite: Bool) -> MergeBlock? {
    if detail.state == .merged { return .merged }
    if detail.state == .closed { return .closed }
    if !canWrite { return .readOnly }
    if !detail.capabilities.actions.contains(.known(.merge)) { return .unsupported }
    if !detail.viewerPermissions.actions.contains(.known(.merge)) { return .notAllowed }
    if detail.isDraft { return .draft }
    if detail.mergeability == .conflicting { return .conflicts }
    if allowedMergeMethods(detail).isEmpty { return .noMethods }
    return nil
  }
}

/// What this session may do on one pull request: the session's scopes, the host's capabilities
/// and the viewer's permissions on the host, all three (RN `usePullRequestPermissions`).
public struct PullRequestPermissions: Sendable, Hashable {
  public var canWrite = false
  public var canComment = false
  public var canReply = false
  public var canResolve = false
  public var canReact = false
  public var canInlineComment = false
  public var canEditChangeRequest = false
  public var canRequestReviewers = false
  public var verdicts: [PullRequestReviewVerdict] = []

  public init() {}

  /// `sourceControlWrite`: the session holds `source-control:write` (writes are guarded by it).
  public init(detail: PullRequestDetail?, connected: Bool, sourceControlWrite: Bool) {
    guard let detail, connected, sourceControlWrite else { return }
    let capabilities = detail.capabilities
    let viewer = detail.viewerPermissions
    canWrite = true
    let allowedVerdicts = Set(viewer.verdicts.compactMap(\.known))
    verdicts = detail.state == .open ? capabilities.review.verdicts.compactMap(\.known).filter(allowedVerdicts.contains) : []
    canComment = capabilities.comment && viewer.comment
    canReply = capabilities.review.reply && viewer.comment
    canResolve = capabilities.review.resolve && viewer.resolve
    canReact = capabilities.reactions == true
    canInlineComment = detail.state == .open && capabilities.review.inlineComment && viewer.comment && !verdicts.isEmpty
    canEditChangeRequest = capabilities.edit?.changeRequest == true && viewer.editChangeRequest != false
    canRequestReviewers = capabilities.reviewers.request && viewer.requestReviewers
  }
}
