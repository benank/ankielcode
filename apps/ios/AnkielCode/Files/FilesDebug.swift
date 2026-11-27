import AnkielKit
import Foundation

/// Debug launch hooks for the viewers (README, "Files and media"). In the thread a launch opens
/// (`ANKIEL_DEBUG_ROUTE=thread` or an `ANKIEL_OPEN_URL` thread link), `ANKIEL_DEBUG_FILES` opens,
/// once per launch: `browser`, `search:<query>`, `file:<path>[:line]`, `gallery` (the thread's
/// first image), `images:<path>,<path>` (a gallery of workspace images, loaded live), or
/// `tool-images` (opens the fold, group and row of the thread's first tool call that returned
/// images, so its thumbnails show).
@MainActor
enum FilesDebug {
  #if DEBUG
    private static var applied = false

    private static func expandToolImages(_ presenter: FilePresenter, detail: ThreadDetailModel) async {
      for _ in 0..<100 where !detail.state.isLoaded { try? await Task.sleep(for: .milliseconds(100)) }
      guard let registry = presenter.registry, let threadId = presenter.context?.threadId else { return }
      let ref = ThreadRef(environmentId: presenter.environmentId, threadId: threadId)
      for row in detail.state.timeline.rows {
        guard case .work(let work) = row.content, work.activity.type == "dynamic_tool",
          let item = try? await registry.turnItem(work.activity.itemId, in: ref),
          case .dynamicTool(let tool) = item.body, ToolOutputImages.count(tool.output) > 0
        else { continue }
        if let fold = row.foldId { detail.expanded.insert(fold) }
        if let group = row.groupId { detail.expanded.insert(group) }
        detail.expanded.insert(row.id)
        return
      }
    }
    static var environment: [String: String] { ProcessInfo.processInfo.environment }
    static var searchQuery: String? {
      environment["ANKIEL_DEBUG_FILES"].flatMap { $0.hasPrefix("search:") ? String($0.dropFirst(7)) : nil }
    }
  #endif

  static func apply(to presenter: FilePresenter, detail: ThreadDetailModel) {
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
        } else if value == "tool-images" {
          await expandToolImages(presenter, detail: detail)
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
