import SwiftUI

@main
struct AnkielCodeApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @Environment(\.scenePhase) private var scenePhase

  private var model: AppModel { delegate.model }

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .environment(delegate.push)
        .task { await model.launch() }
        .onOpenURL { model.open($0) }
    }
    .onChange(of: scenePhase) { _, phase in
      model.scenePhaseChanged(phase)
    }
    .commands { AppCommands(model: model) }
  }
}

/// Hardware keyboard shortcuts (and the iPad menu bar). They act only on the thread list with
/// nothing presented over it. No search or Settings shortcut: the system's Find and Settings items
/// own Command-F and Command-, (SwiftUI commands and priority UIKit key commands both lost them),
/// and Command-Option-F never arrived either.
struct AppCommands: Commands {
  let model: AppModel

  private var onHome: Bool { model.isOnHome }

  var body: some Commands {
    CommandGroup(replacing: .newItem) {
      Button("New thread") { if onHome { model.navigator.newThread() } }
        .keyboardShortcut("n", modifiers: .command)
    }
  }
}

