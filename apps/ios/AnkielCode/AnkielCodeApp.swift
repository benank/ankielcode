import SwiftUI

@main
struct AnkielCodeApp: App {
  @State private var model = AppModel()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .task {
          await model.restore()
          #if DEBUG
          // Lets `simctl launch` pair without the system "Open in app?" prompt.
          if let link = ProcessInfo.processInfo.environment["ANKIEL_OPEN_URL"].flatMap(URL.init(string:)) {
            model.open(link)
          }
          #endif
        }
        .onOpenURL { model.open($0) }
    }
  }
}
