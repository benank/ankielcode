import SwiftUI

@main
struct AnkielCodeApp: App {
  @State private var model = AppModel()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .task { await model.restore() }
        .onOpenURL { model.open($0) }
    }
  }
}
