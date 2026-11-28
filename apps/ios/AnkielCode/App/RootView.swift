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
          .onAppear { LaunchSignposts.mark("firstFrame") }
      case .onboarding:
        WelcomeView()
          .transition(.opacity)
      case .home:
        HomeView()
          .transition(.opacity)
          .onAppear { LaunchSignposts.mark("homeAppeared") }
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
    .modifier(PushOfferModifier())
    .modifier(CustomSnoozeHost())
    .modifier(ShortcutSync())
    .fullScreenCover(isPresented: scanner) {
      QRScannerView()
    }
    .sheet(isPresented: pairingPresented) {
      PairingProgressView()
    }
    .font(Typography.body)
    .tint(Palette.accent)
    .environment(\.codeAppearance, CodeAppearance(fontSize: model.preferences.values.codeFontSize, wraps: model.preferences.values.codeWordBreak))
    .onChange(of: appearance, initial: true) { _, next in
      Appearance.apply(next.mode, theme: next.theme)
    }
    #if DEBUG
      .task { await Appearance.debugTheme(model.preferences) }
    #endif
  }

  private var appearance: AppearanceState {
    let values = model.preferences.values
    return AppearanceState(mode: values.themeMode, theme: ThemeSelection(lightId: values.lightThemeId, darkId: values.darkThemeId))
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
