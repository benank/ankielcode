import AnkielKit
import Observation
import SwiftUI

/// Where the app can go from home.
enum AppRoute: Hashable {
  case thread(ThreadRef)
}

/// The one navigation model for both layouts: the open thread. The compact stack's path and the
/// split view's detail column both read it, so a size-class change keeps the open thread.
@Observable
final class Navigator {
  /// The open thread, nil on the list.
  var selection: ThreadRef?
  /// A sheet over home.
  var sheet: HomeSheet?

  enum HomeSheet: String, Identifiable {
    case settings, newThread
    var id: String { rawValue }
  }

  func open(_ ref: ThreadRef) {
    sheet = nil
    selection = ref
  }

  /// The compact stack's path, derived from `selection`.
  var path: [AppRoute] {
    get { selection.map { [.thread($0)] } ?? [] }
    set {
      if case .thread(let ref)? = newValue.last { selection = ref } else { selection = nil }
    }
  }
}
