import AnkielKit
import SwiftUI

/// Home: the thread list as a sidebar with the thread beside it on regular width (iPad), and a
/// stack that pushes the thread on compact width (iPhone). One `Navigator` drives both.
struct HomeView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.horizontalSizeClass) private var sizeClass
  @Namespace private var zoom

  var body: some View {
    @Bindable var navigator = model.navigator
    Group {
      if sizeClass == .regular {
        NavigationSplitView {
          ThreadListScreen(zoom: nil)
            .navigationSplitViewColumnWidth(min: 320, ideal: 380, max: 460)
        } detail: {
          NavigationStack {
            if let ref = navigator.selection {
              ThreadDetailView(threadRef: ref)
                .id(ref)
            } else {
              ThreadPlaceholderDetail()
            }
          }
        }
      } else {
        NavigationStack(path: $navigator.path) {
          ThreadListScreen(zoom: zoom)
            .navigationDestination(for: AppRoute.self) { route in
              switch route {
              case .thread(let ref):
                ThreadDetailView(threadRef: ref)
                  .navigationTransition(.zoom(sourceID: ref.key, in: zoom))
              }
            }
        }
      }
    }
    .sheet(item: $navigator.sheet) { sheet in
      switch sheet {
      case .settings: SettingsPlaceholderView()
      case .newThread: NewThreadView()
      }
    }
    .onChange(of: navigator.selection, initial: true) { _, ref in
      model.home.selectedKey = sizeClass == .regular ? ref?.key : nil
    }
  }
}

/// The detail column before a thread is chosen (iPad).
private struct ThreadPlaceholderDetail: View {
  var body: some View {
    ContentUnavailableView {
      Label("No thread selected", systemImage: "bubble.left.and.text.bubble.right")
    } description: {
      Text("Choose a thread from the list, or start a new one.")
    }
    .background(Palette.canvas)
  }
}
