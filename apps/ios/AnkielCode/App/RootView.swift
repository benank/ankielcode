import SwiftUI

struct RootView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ZStack {
      CanvasBackground()
      switch model.route {
      case .launching:
        Color.clear
      case .onboarding:
        WelcomeView()
          .transition(.opacity)
      case .home:
        HomeView()
          .transition(.opacity)
      }
    }
    .animation(Motion.resolve(Motion.transition, reduceMotion: reduceMotion), value: model.route)
    .sheet(item: sheet) { sheet in
      switch sheet {
      case .computers: ComputersView()
      case .pairingLink: PairingLinkView()
      case .help: PairingHelpView()
      case .scanner: EmptyView()
      }
    }
    .fullScreenCover(isPresented: scanner) {
      QRScannerView()
    }
    .sheet(isPresented: pairingPresented) {
      PairingProgressView()
    }
  }

  private var sheet: Binding<AppModel.Sheet?> {
    Binding(
      get: { model.sheet == .scanner ? nil : model.sheet },
      set: { next in if next != nil || model.sheet != .scanner { model.sheet = next } })
  }

  private var scanner: Binding<Bool> {
    Binding(
      get: { model.sheet == .scanner },
      set: { if !$0, model.sheet == .scanner { model.sheet = nil } })
  }

  /// The pairing sheet follows the flow; dismissing it ends the flow.
  private var pairingPresented: Binding<Bool> {
    Binding(
      get: { model.pairing.isActive && model.sheet == nil },
      set: { presented in if !presented { model.finishPairing() } })
  }
}
