import SwiftUI

@main
struct AnkielCodeApp: App {
  @State private var model = AppModel()
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .task { await model.launch() }
        .onOpenURL { model.open($0) }
    }
    .onChange(of: scenePhase) { _, phase in
      model.scenePhaseChanged(phase)
    }
  }
}
