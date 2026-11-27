import AnkielKit
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
    // A computer connecting delivers what waited for it.
    .onChange(of: model.registry.environments.map { $0.activeRoute?.id }) { _, _ in model.composer.wake() }
    .sheet(item: sheet) { sheet in
      switch sheet {
      case .settings: SettingsView()
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
    .environment(\.codeAppearance, CodeAppearance(fontSize: model.preferences.values.codeFontSize, wraps: model.preferences.values.codeWordBreak))
    .onChange(of: model.preferences.values.themeMode, initial: true) { _, mode in
      Appearance.apply(mode)
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
      set: {
        if !$0, model.sheet == .scanner {
          model.sheet = nil
          model.pairingInputClosed()
        }
      })
  }

  /// The pairing sheet follows the flow; dismissing it ends the flow.
  private var pairingPresented: Binding<Bool> {
    Binding(
      get: { model.pairing.isActive && model.sheet == nil },
      set: { presented in if !presented { model.finishPairing() } })
  }
}
