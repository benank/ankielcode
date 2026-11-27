import SwiftUI

struct RootView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ZStack {
      CanvasBackground()
      switch model.phase {
      case .launching:
        Color.clear
      case .onboarding:
        PairingView()
          .transition(.opacity)
      case .connecting, .connected, .disconnected:
        ThreadListView()
          .transition(.opacity)
      }
    }
    .animation(Motion.resolve(Motion.transition, reduceMotion: reduceMotion), value: model.phase == .onboarding)
  }
}
