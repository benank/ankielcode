import Foundation
import Observation

/// Where review reads diffs from: a live session, or fixtures in debug builds.
@MainActor
public protocol ReviewSource: AnyObject {
  func turnDiff(threadId: String, turn: Int) async throws -> ThreadTurnDiff
  func preview(cwd: String, kind: ReviewGitKind, partial: @escaping @Sendable (DiffPreviewResult) async -> Void) async throws -> DiffPreviewResult
  func filePatch(cwd: String, source: DiffPreviewSource, file: DiffPreviewSource.FileStat) async throws -> DiffPreviewSource?
  func fileContents(cwd: String, source: DiffPreviewSource, file: DiffFile) async throws -> DiffFileContents?
}

/// A changed file as review lists it. A truncated git comparison lists every file from its stats
/// and reads each patch when the file opens.
public struct ReviewFile: Sendable, Hashable, Identifiable {
  public var id: String
  public var path: String
  public var previousPath: String?
  public var status: DiffFile.Status
  public var additions: Int
  public var deletions: Int
  /// The parsed patch; nil until a lazy file's patch is read.
  public var diff: DiffFile?
  /// Stats of a lazy file, for reading its patch.
  public var stat: DiffPreviewSource.FileStat?

  public var name: String { path.split(separator: "/").last.map(String.init) ?? path }
  public var directory: String? {
    guard let slash = path.lastIndex(of: "/") else { return nil }
    return String(path[..<slash])
  }
}

/// A section's diff, parsed.
public struct ReviewDiff: Sendable, Hashable {
  public var files: [ReviewFile]
  /// The patch hit the server's size cap (the excerpt shows) or the comparison left patches out.
  public var truncated: Bool
  /// Patch text that held no file this client could read, shown raw.
  public var raw: String?

  public var additions: Int { files.reduce(0) { $0 + $1.additions } }
  public var deletions: Int { files.reduce(0) { $0 + $1.deletions } }

  public static let empty = ReviewDiff(files: [], truncated: false, raw: nil)
}

public enum ReviewLoad<Value: Sendable & Hashable>: Sendable, Hashable {
  case loading
  case loaded(Value)
  case failed(ReviewFailure)

  public var value: Value? { if case .loaded(let value) = self { value } else { nil } }
}

public enum ReviewFailure: Error, Sendable, Hashable {
  case offline
  /// The server would not send this file's patch even on its own.
  case tooLarge
  /// The file's contents no longer reproduce the patch.
  case changedSince
  case server(String)

  init(_ error: any Error) {
    switch EnvironmentRequestError(error) {
    case .notConnected: self = .offline
    case .rejected(let message, _): self = .server(message ?? String(describing: error))
    case .failed(let message): self = .server(message)
    }
  }
}

/// Review for one thread: its sections (turns, uncommitted, branch changes), the selected
/// section's files, and per-file state (viewed, expanded context, lazily read patches).
@MainActor @Observable
public final class ReviewModel {
  public let ref: ThreadRef
  /// The checkout git sections read; nil when the thread has none or the session cannot read files.
  public private(set) var cwd: String?
  public private(set) var turns: [TurnChange] = []
  public private(set) var gitSources: [ReviewGitKind: DiffPreviewSource] = [:]
  public private(set) var gitStates: [ReviewGitKind: ReviewSection.State] = [:]
  public private(set) var gitErrors: [ReviewGitKind: ReviewFailure] = [:]
  public private(set) var turnDiffs: [Int: ReviewLoad<String>] = [:]
  /// The user's pick; the default shows while it is missing (`resolve`).
  public var picked: ReviewSectionID?
  /// Parsed diffs by section and content.
  public private(set) var diffs: [String: ReviewLoad<ReviewDiff>] = [:]
  public private(set) var patches: [String: ReviewLoad<DiffFile>] = [:]
  public private(set) var contents: [String: ReviewLoad<[String]>] = [:]
  public private(set) var expanded: [String: Set<Int>] = [:]
  /// Viewed file paths by section (in memory for the app's run, like RN's review cache).
  public private(set) var viewed: [String: Set<String>] = [:]

  @ObservationIgnored private let source: ReviewSource
  @ObservationIgnored private var parsing: Set<String> = []

  public init(ref: ThreadRef, source: ReviewSource) {
    self.ref = ref
    self.source = source
  }

  public var sections: [ReviewSection] {
    ReviewSection.build(turns: turns, sources: gitSources, states: gitStates)
  }

  public var selectedId: ReviewSectionID? { ReviewSection.resolve(sections, picked: picked) }

  public var selected: ReviewSection? { sections.first { $0.id == selectedId } }

  // MARK: Inputs

  /// The thread's turns with changes (from its projection) and the checkout to compare.
  public func update(turns: [TurnChange], cwd: String?) {
    if self.turns != turns { self.turns = turns }
    if self.cwd != cwd {
      self.cwd = cwd
      gitSources = [:]
      gitStates = [:]
      gitErrors = [:]
    }
  }

  /// Loads what the selected section needs, and the git comparisons once.
  public func load() {
    if let cwd {
      for kind in ReviewGitKind.allCases where gitStates[kind] == nil { loadPreview(kind, cwd: cwd) }
    }
    guard let selected else { return }
    if case .turn(let count) = selected.id, turnDiffs[count] == nil { loadTurn(count) }
    parseSelected()
  }

  /// Reads the selected section again (pull to refresh).
  public func refresh() async {
    guard let selected else { return }
    switch selected.id {
    case .turn(let count):
      turnDiffs[count] = nil
      await readTurn(count)
    case .git(let kind):
      guard let cwd else { return }
      await readPreview(kind, cwd: cwd)
    }
    parseSelected()
  }

  public func select(_ id: ReviewSectionID) {
    picked = id
    load()
  }

  // MARK: Reads

  private func loadTurn(_ count: Int) {
    turnDiffs[count] = .loading
    Task { await readTurn(count) }
  }

  private func readTurn(_ count: Int) async {
    if turnDiffs[count] == nil { turnDiffs[count] = .loading }
    do {
      let diff = try await source.turnDiff(threadId: ref.threadId, turn: count)
      turnDiffs[count] = .loaded(diff.reviewText)
    } catch {
      // A read that fails after one answered keeps the answer.
      if turnDiffs[count]?.value == nil { turnDiffs[count] = .failed(ReviewFailure(error)) }
    }
    parseSelected()
  }

  private func loadPreview(_ kind: ReviewGitKind, cwd: String) {
    gitStates[kind] = .loading
    Task { await readPreview(kind, cwd: cwd) }
  }

  private func readPreview(_ kind: ReviewGitKind, cwd: String) async {
    if gitSources[kind] == nil { gitStates[kind] = .loading }
    do {
      let result = try await source.preview(cwd: cwd, kind: kind) { [weak self] partial in
        await self?.applyPreview(partial, kind: kind, cwd: cwd, final: false)
      }
      applyPreview(result, kind: kind, cwd: cwd, final: true)
    } catch {
      guard self.cwd == cwd else { return }
      gitErrors[kind] = ReviewFailure(error)
      if gitSources[kind] == nil { gitStates[kind] = .failed }
    }
  }

  private func applyPreview(_ result: DiffPreviewResult, kind: ReviewGitKind, cwd: String, final: Bool) {
    guard self.cwd == cwd else { return }
    // An incomplete (tracked-only) read never replaces a complete one.
    if !final, gitSources[kind] != nil { return }
    if let source = result.sources.first(where: { $0.kind == kind.rawValue }) {
      gitSources[kind] = source
      gitStates[kind] = .ready
    } else if final {
      gitSources[kind] = nil
      // Answered with nothing to compare: the section leaves the menu (RN).
      gitStates[kind] = .ready
    }
    gitErrors[kind] = nil
    parseSelected()
  }

  // MARK: Parsing

  /// The key of a section's current content, so a refresh with a new diff parses again.
  public func contentKey(_ section: ReviewSection) -> String? {
    switch section.id {
    case .turn(let count):
      guard case .loaded(let text)? = turnDiffs[count] else { return nil }
      return "\(section.id.rawValue)|\(text.utf8.count)|\(text.hashValue)"
    case .git:
      guard let source = section.source else { return nil }
      return "\(section.id.rawValue)|\(source.diffHash)"
    }
  }

  /// The selected section's diff state.
  public var selectedDiff: ReviewLoad<ReviewDiff>? {
    guard let selected else { return nil }
    if case .turn(let count) = selected.id, case .failed(let message)? = turnDiffs[count] { return .failed(message) }
    if case .git(let kind) = selected.id, selected.source == nil {
      return gitErrors[kind].map { .failed($0) } ?? .loading
    }
    guard let key = contentKey(selected) else { return .loading }
    return diffs[key] ?? .loading
  }

  private func parseSelected() {
    guard let selected, let key = contentKey(selected), diffs[key] == nil, !parsing.contains(key) else { return }
    parsing.insert(key)
    let text: String
    var lazyStats: [DiffPreviewSource.FileStat]?
    switch selected.id {
    case .turn(let count):
      text = turnDiffs[count]?.value ?? ""
    case .git:
      text = selected.source?.diff ?? ""
      if selected.source?.truncated == true, let files = selected.source?.files { lazyStats = files }
    }
    Task {
      let diff = await Self.parse(text, lazyStats: lazyStats, section: selected.id.rawValue)
      parsing.remove(key)
      diffs[key] = .loaded(diff)
    }
  }

  /// Parses and orders off the main actor.
  @concurrent
  nonisolated static func parse(_ text: String, lazyStats: [DiffPreviewSource.FileStat]?, section: String) async -> ReviewDiff {
    if let lazyStats {
      // Every file from the stats; patches come one by one (RN keeps the stats' order here).
      let files = lazyStats.enumerated().map { index, stat in
        ReviewFile(
          id: "\(index):\(stat.path)", path: stat.path, previousPath: stat.previousPath,
          status: Self.status(stat.changeType, previousPath: stat.previousPath), additions: stat.additions,
          deletions: stat.deletions, diff: nil, stat: stat)
      }
      return ReviewDiff(files: files, truncated: true, raw: nil)
    }
    let parsed = UnifiedDiff.parse(text)
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if parsed.files.isEmpty {
      return ReviewDiff(files: [], truncated: parsed.truncated, raw: trimmed.isEmpty || trimmed == "[truncated]" ? nil : text)
    }
    let files = DiffFileOrder.order(parsed.files).map { file in
      ReviewFile(
        id: file.id, path: file.path, previousPath: file.previousPath, status: file.status, additions: file.additions,
        deletions: file.deletions, diff: file, stat: nil)
    }
    return ReviewDiff(files: files, truncated: parsed.truncated, raw: nil)
  }

  nonisolated static func status(_ changeType: String?, previousPath: String?) -> DiffFile.Status {
    switch changeType {
    case "new": .added
    case "deleted": .deleted
    case "rename-pure", "rename-changed": .renamed
    default: previousPath == nil ? .modified : .renamed
    }
  }

  // MARK: Files

  /// Per-file state belongs to one version of the section: a refresh with a new diff starts over,
  /// so an old patch or contents are never spliced into the new one.
  private func fileKey(_ file: ReviewFile) -> String {
    "\(selected.flatMap(contentKey) ?? selectedId?.rawValue ?? "")|\(file.id)"
  }

  /// The file's patch: parsed with its section, or read on its own for a lazy file.
  public func patch(_ file: ReviewFile) -> ReviewLoad<DiffFile> {
    if let diff = file.diff { return .loaded(diff) }
    return patches[fileKey(file)] ?? .loading
  }

  /// Reads a lazy file's patch (again, after a failure).
  public func loadPatch(_ file: ReviewFile) {
    guard file.diff == nil, let stat = file.stat, let cwd, let source = selected?.source else { return }
    let key = fileKey(file)
    if case .loaded? = patches[key] { return }
    if case .loading? = patches[key] { return }
    patches[key] = .loading
    Task {
      do {
        let result = try await self.source.filePatch(cwd: cwd, source: source, file: stat)
        let parsed = result.map { UnifiedDiff.parse($0.diff).files } ?? []
        if let diff = parsed.first(where: { $0.path == stat.path }) ?? (parsed.count == 1 ? parsed.first : nil) {
          patches[key] = .loaded(diff)
        } else if result?.truncated == true {
          patches[key] = .failed(.tooLarge)
        } else {
          patches[key] = .loaded(DiffFile(id: file.id, path: file.path, previousPath: file.previousPath, status: file.status))
        }
      } catch {
        patches[key] = .failed(ReviewFailure(error))
      }
    }
  }

  /// Only git sections can show unchanged lines: there is no contents read for a turn.
  public var canExpand: Bool {
    if case .git? = selectedId, selected?.source != nil { return true }
    return false
  }

  public func expandedGaps(_ file: ReviewFile) -> Set<Int> { expanded[fileKey(file)] ?? [] }

  public func fileContents(_ file: ReviewFile) -> ReviewLoad<[String]>? { contents[fileKey(file)] }

  /// Shows a gap's unchanged lines, reading the file's contents the first time.
  public func expand(_ gap: Int, in file: ReviewFile) {
    let key = fileKey(file)
    expanded[key, default: []].insert(gap)
    if case .loaded? = contents[key] { return }
    if case .loading? = contents[key] { return }
    guard let cwd, let source = selected?.source, case .loaded(let diff) = patch(file) else { return }
    contents[key] = .loading
    Task {
      do {
        guard let result = try await self.source.fileContents(cwd: cwd, source: source, file: diff),
          let lines = DiffRows.verifiedLines(diff, contents: result)
        else {
          contents[key] = .failed(.changedSince)
          return
        }
        contents[key] = .loaded(lines)
      } catch {
        contents[key] = .failed(ReviewFailure(error))
      }
    }
  }

  public func isViewed(_ file: ReviewFile) -> Bool {
    viewed[selectedId?.rawValue ?? "", default: []].contains(file.path)
  }

  public func toggleViewed(_ file: ReviewFile) {
    let section = selectedId?.rawValue ?? ""
    if viewed[section, default: []].contains(file.path) {
      viewed[section]?.remove(file.path)
    } else {
      viewed[section, default: []].insert(file.path)
    }
  }
}
