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
