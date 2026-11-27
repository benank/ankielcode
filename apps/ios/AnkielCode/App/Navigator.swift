import AnkielKit
import Observation
import SwiftUI

/// Where the app can go from home.
enum AppRoute: Hashable {
  case thread(ThreadRef)

  var ref: ThreadRef {
    switch self {
    case .thread(let ref): ref
    }
  }
}

/// The one navigation model for both layouts: a stack of open threads. The first is the thread
/// chosen from the list; a subagent's child pushes on top, so Back returns to its parent. The
/// compact stack's path and the split view's detail stack both read it, so a size-class change
/// keeps the open threads.
@Observable
final class Navigator {
  /// Open threads, root first; empty on the list.
  var stack: [ThreadRef] = []
  /// A sheet over home.
  var sheet: HomeSheet?
  /// A full-screen screen over home (Issues, Workflows). Pull requests keep their own flag.
  var cover: HomeCover? = HomeCover.atLaunch
  /// Set to focus home's search field (the Search quick action and keyboard command); the list
  /// clears it once focused, so a request made before the list appears still lands.
  var searchRequested = false

  enum HomeSheet: String, Identifiable {
    case newThread
    var id: String { rawValue }
  }

  enum HomeCover: String, Identifiable {
    case issues, workflows
    var id: String { rawValue }

    /// A debug launch that asked for one open.
    @MainActor static var atLaunch: HomeCover? {
      if IssuesDebug.opensAtLaunch { return .issues }
      if WorkflowsDebug.opensAtLaunch { return .workflows }
      return nil
    }
  }

  /// The split view's columns (the keyboard's Toggle sidebar).
  var sidebarVisibility = NavigationSplitViewVisibility.automatic

  func toggleSidebar() {
    sidebarVisibility = sidebarVisibility == .detailOnly ? .all : .detailOnly
  }

  /// The thread chosen from the list (the split view's selection).
  var selection: ThreadRef? { stack.first }

  /// Opens a thread from the list or a link, replacing the stack.
  func open(_ ref: ThreadRef) {
    sheet = nil
    stack = [ref]
  }

  /// Opens a thread on top of the current one (a subagent's child).
  func push(_ ref: ThreadRef) {
    guard stack.last != ref else { return }
    stack.append(ref)
  }

  /// Leaves `ref` and anything opened from it.
  func close(_ ref: ThreadRef) {
    if let index = stack.firstIndex(of: ref) { stack.removeSubrange(index...) }
  }

  /// Opens the new-thread sheet (its draft lives in the composer store).
  func newThread() {
    sheet = .newThread
  }

  /// The compact stack's path.
  var path: [AppRoute] {
    get { stack.map(AppRoute.thread) }
    set { stack = newValue.map(\.ref) }
  }

  /// The split view's detail path: the threads above the selected one.
  var detailPath: [AppRoute] {
    get { stack.dropFirst().map(AppRoute.thread) }
    set {
      guard let root = stack.first else { return }
      stack = [root] + newValue.map(\.ref)
    }
  }
}
