import Foundation

/// The file browser's lazily listed tree: each folder is listed the first time it opens
/// (`projects.listEntries`), and the visible rows are the open folders flattened in order.
public struct FileTree: Sendable, Hashable {
  public enum Listing: Sendable, Hashable {
    case loading
    case loaded([WorkspaceEntry], truncated: Bool)
    case failed(EnvironmentRequestError)
  }

  public struct Row: Sendable, Hashable, Identifiable {
    public var entry: WorkspaceEntry
    public var depth: Int
    public var expanded: Bool
    /// The folder's listing state, for an open folder.
    public var listing: Listing?
    public var id: String { entry.path }
  }

  public private(set) var listings: [String: Listing] = [:]
  public private(set) var expanded: Set<String> = []

  public init() {}

  /// The root's listing ("").
  public var root: Listing? { listings[""] }

  /// Folders that still need a listing to show what is open.
  public var pending: [String] {
    ([""] + expanded.sorted()).filter { listings[$0] == nil }
  }

  /// Opens or closes a folder; returns whether it now needs listing.
  @discardableResult
  public mutating func toggle(_ path: String) -> Bool {
    if expanded.remove(path) != nil { return false }
    expanded.insert(path)
    return needsListing(path)
  }

  public func needsListing(_ path: String) -> Bool {
    switch listings[path] {
    case nil, .failed?: true
    default: false
    }
  }

  public mutating func begin(_ path: String) {
    listings[path] = .loading
  }

  public mutating func finish(_ path: String, _ result: Result<WorkspaceEntries, EnvironmentRequestError>) {
    switch result {
    case .success(let entries): listings[path] = .loaded(Self.sorted(entries.entries), truncated: entries.truncated)
    case .failure(let error): listings[path] = .failed(error)
    }
  }

  /// Forgets every listing (pull to refresh) but keeps what is open.
  public mutating func invalidate() {
    listings = [:]
  }

  public var rows: [Row] {
    var rows: [Row] = []
    func visit(_ directory: String, depth: Int) {
      guard case .loaded(let entries, _)? = listings[directory] else { return }
      for entry in entries {
        let open = entry.isDirectory && expanded.contains(entry.path)
        rows.append(Row(entry: entry, depth: depth, expanded: open, listing: open ? listings[entry.path] ?? .loading : nil))
        if open { visit(entry.path, depth: depth + 1) }
      }
    }
    visit("", depth: 0)
    return rows
  }

  /// Folders first, then names in Finder order (RN `compareNodes`).
  static func sorted(_ entries: [WorkspaceEntry]) -> [WorkspaceEntry] {
    entries.sorted { left, right in
      if left.isDirectory != right.isDirectory { return left.isDirectory }
      return left.name.localizedStandardCompare(right.name) == .orderedAscending
    }
  }
}
