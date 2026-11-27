import AnkielKit
import Foundation

/// Debug launch hooks for the viewers (README, "Files and media"). In the thread a launch opens
/// (`ANKIEL_DEBUG_ROUTE=thread` or an `ANKIEL_OPEN_URL` thread link), `ANKIEL_DEBUG_FILES` opens,
/// once per launch: `browser`, `search:<query>`, `file:<path>[:line]`, `gallery` (the thread's
/// first image), or `images:<path>,<path>` (a gallery of workspace images, loaded live).
@MainActor
enum FilesDebug {
  #if DEBUG
    private static var applied = false
    static var environment: [String: String] { ProcessInfo.processInfo.environment }
    static var searchQuery: String? {
      environment["ANKIEL_DEBUG_FILES"].flatMap { $0.hasPrefix("search:") ? String($0.dropFirst(7)) : nil }
    }
  #endif

  static func apply(to presenter: FilePresenter) {
    #if DEBUG
      guard !applied, let value = environment["ANKIEL_DEBUG_FILES"] else { return }
      Task {
        // The thread's root arrives with the shell; its rows with the stream.
        for _ in 0..<100 where presenter.context == nil { try? await Task.sleep(for: .milliseconds(100)) }
        guard !applied, presenter.context != nil else { return }
        applied = true
        if value == "browser" || value.hasPrefix("search:") {
          presenter.openBrowser()
        } else if value.hasPrefix("file:") {
          let position = FilePosition(splitting: String(value.dropFirst(5)))
          presenter.open(path: position.path, line: position.line)
        } else if value.hasPrefix("images:") {
          let paths = value.dropFirst(7).split(separator: ",").map(String.init)
          let images = paths.map { ThreadImage(source: .markdown($0), itemId: "debug", title: WorkspacePath.basename($0)) }
          presenter.openImages(images, at: 0)
        } else if value == "gallery" {
          for _ in 0..<100 {
            if let first = ThreadImage.collect(presenter.rows()).first {
              presenter.openImage(id: first.id)
              return
            }
            try? await Task.sleep(for: .milliseconds(100))
          }
        }
      }
    #endif
  }
}
