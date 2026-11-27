#if DEBUG
  import AnkielKit
  import Foundation

  /// The fake composer's `@` search (`ANKIEL_DEBUG_COMPOSER`): a made-up workspace, filtered by
  /// the query, so UI tests can pick a mention without a computer.
  enum MentionDebug {
    static let workspace: [WorkspaceEntry] = [
      WorkspaceEntry(path: "README.md", kind: .file),
      WorkspaceEntry(path: "src", kind: .directory),
      WorkspaceEntry(path: "src/tides/TideChart.swift", kind: .file),
      WorkspaceEntry(path: "src/tides/TideTable.swift", kind: .file),
      WorkspaceEntry(path: "src/harbor/Buoy readings.md", kind: .file),
      WorkspaceEntry(path: "docs/北海岸/潮汐.md", kind: .file),
    ]

    static func entries(_ query: String) -> [WorkspaceEntry] {
      let needle = query.lowercased()
      guard !needle.isEmpty else { return workspace }
      return workspace.filter { $0.path.lowercased().contains(needle) }
    }
  }
#endif
