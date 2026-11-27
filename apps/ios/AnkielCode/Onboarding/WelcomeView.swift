import SwiftUI

/// First run: the brand, one line on what the app is, and the two ways to pair.
struct WelcomeView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var appeared = false

  var body: some View {
    VStack(spacing: 0) {
      Spacer(minLength: Spacing.xxxl)

      VStack(spacing: Spacing.xl) {
        BrandMark(size: 92)
          .scaleEffect(appeared || reduceMotion ? 1 : 0.86)
          .opacity(appeared ? 1 : 0)

        VStack(spacing: Spacing.md) {
          Text("Ankiel Code")
            .font(Typography.largeTitle)
            .foregroundStyle(Palette.textPrimary)
          Text("Follow and steer the coding agents on your own computers, from anywhere.")
            .font(Typography.body)
            .foregroundStyle(Palette.textSecondary)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
        }
        .entrance(appeared, delay: 0.08, reduceMotion: reduceMotion)
      }
      .padding(.horizontal, Spacing.xxl)

      Spacer(minLength: Spacing.xxxl)

      VStack(spacing: Spacing.lg) {
        GlassEffectContainer(spacing: Spacing.md) {
          VStack(spacing: Spacing.md) {
            Button {
              model.sheet = .scanner
            } label: {
              Label("Scan QR code", systemImage: "qrcode.viewfinder")
                .font(Typography.headline)
                .foregroundStyle(Palette.onAccent)
                .frame(maxWidth: .infinity, minHeight: 30)
            }
            .buttonStyle(.glassProminent)
            .controlSize(.large)

            Button {
              model.sheet = .pairingLink
            } label: {
              Label("Paste link", systemImage: "link")
                .font(Typography.headline)
                .frame(maxWidth: .infinity, minHeight: 30)
            }
            .buttonStyle(.glass)
            .controlSize(.large)
          }
        }

        Button("How do I get a pairing link?") {
          model.sheet = .help
        }
        .font(Typography.subheadline)
        .foregroundStyle(Palette.textSecondary)
        .frame(minHeight: 44)
      }
      .padding(.horizontal, Spacing.xl)
      .padding(.bottom, Spacing.lg)
      .entrance(appeared, delay: 0.16, reduceMotion: reduceMotion)
    }
    .frame(maxWidth: 520)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background { WelcomeBackground() }
    .onAppear {
      withAnimation(Motion.resolve(Motion.gentle, reduceMotion: reduceMotion)) { appeared = true }
    }
  }
}

/// A static soft light behind the mark. Drawn once; nothing animates.
private struct WelcomeBackground: View {
  var body: some View {
    ZStack {
      Palette.canvas
      RadialGradient(
        colors: [Palette.welcomeGlow, Palette.welcomeGlow.opacity(0)],
        center: UnitPoint(x: 0.5, y: 0.3), startRadius: 0, endRadius: 360)
    }
    .ignoresSafeArea()
  }
}

extension View {
  /// One-shot rise-and-fade on first appearance; a plain fade under Reduce Motion.
  func entrance(_ appeared: Bool, delay: Double, reduceMotion: Bool) -> some View {
    opacity(appeared ? 1 : 0)
      .offset(y: appeared || reduceMotion ? 0 : 14)
      .animation(Motion.resolve(Motion.gentle, reduceMotion: reduceMotion).delay(delay), value: appeared)
  }
}

/// "How do I get a pairing link?", with the RN app's guidance.
struct PairingHelpView: View {
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: Spacing.xl) {
          HelpStep(
            number: 1, systemImage: "desktopcomputer",
            title: "Open Ankiel Code on your computer",
            detail: "In the desktop app, open Settings, then Connections. Or run `ankiel pair` in a terminal.")
          HelpStep(
            number: 2, systemImage: "qrcode",
            title: "Scan the code it shows",
            detail: "Or copy the pairing link and paste it here.")
          HelpStep(
            number: 3, systemImage: "clock",
            title: "Use it right away",
            detail: "A pairing link works once and expires after a few minutes. Make a new one if it stops working.")
          Text(
            "For machines on your local network or tailnet, or anywhere through your own relay. The machine keeps its own provider credentials."
          )
          .font(Typography.footnote)
          .foregroundStyle(Palette.textSecondary)
        }
        .padding(Spacing.xl)
      }
      .navigationTitle("Pairing a computer")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    .presentationDetents([.medium, .large])
  }
}

private struct HelpStep: View {
  let number: Int
  let systemImage: String
  let title: LocalizedStringKey
  let detail: LocalizedStringKey

  var body: some View {
    HStack(alignment: .top, spacing: Spacing.lg) {
      Image(systemName: systemImage)
        .font(.system(.title3, weight: .medium))
        .foregroundStyle(Palette.textPrimary)
        .frame(width: 44, height: 44)
        .background(Palette.fill, in: .rect(cornerRadius: Radius.medium, style: .continuous))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Spacing.xs) {
        Text(title)
          .font(Typography.headline)
          .foregroundStyle(Palette.textPrimary)
        Text(detail)
          .font(Typography.subheadline)
          .foregroundStyle(Palette.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityElement(children: .combine)
  }
}
