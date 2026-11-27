import SwiftUI

/// Placeholder onboarding: paste a pairing link and connect. QR scanning comes later.
struct PairingView: View {
  @Environment(AppModel.self) private var model
  @State private var link = ""
  @FocusState private var focused: Bool

  private var trimmed: String { link.trimmingCharacters(in: .whitespacesAndNewlines) }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: Spacing.xl) {
        VStack(alignment: .leading, spacing: Spacing.sm) {
          Image(systemName: "terminal")
            .font(.system(size: 34, weight: .medium))
            .foregroundStyle(Palette.textPrimary)
            .padding(.bottom, Spacing.sm)
          Text("Connect to Ankiel Code")
            .font(Typography.largeTitle)
            .foregroundStyle(Palette.textPrimary)
          Text("Paste the pairing link from `ankiel pair` or from the desktop app's Connections settings.")
            .font(Typography.callout)
            .foregroundStyle(Palette.textSecondary)
        }

        VStack(alignment: .leading, spacing: Spacing.sm) {
          TextField("https://host/pair#token=…", text: $link, axis: .vertical)
            .font(Typography.mono)
            .lineLimit(1...4)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)
            .submitLabel(.go)
            .focused($focused)
            .onSubmit(connect)
            .padding(Spacing.md)
            .background(Palette.surface, in: .rect(cornerRadius: Radius.field, style: .continuous))
            .overlay {
              RoundedRectangle(cornerRadius: Radius.field, style: .continuous)
                .strokeBorder(Palette.separator)
            }
            .accessibilityLabel("Pairing link")

          if let error = model.pairingError {
            Text(error)
              .font(Typography.footnote)
              .foregroundStyle(Palette.danger)
              .transition(.opacity)
          }
        }
        .motion(Motion.micro, value: model.pairingError)

        HStack(spacing: Spacing.md) {
          PasteButton(payloadType: String.self) { strings in
            if let first = strings.first { link = first }
          }
          .buttonBorderShape(.capsule)
          .labelStyle(.titleAndIcon)

          Spacer()

          Button(action: connect) {
            if model.isPairing {
              ProgressView()
                .padding(.horizontal, Spacing.md)
            } else {
              Text("Connect")
                .padding(.horizontal, Spacing.sm)
            }
          }
          .buttonStyle(.glassProminent)
          .controlSize(.large)
          .disabled(trimmed.isEmpty || model.isPairing)
        }
      }
      .padding(.horizontal, Spacing.xl)
      .padding(.top, Spacing.xxxl)
      .frame(maxWidth: 560, alignment: .leading)
      .frame(maxWidth: .infinity)
    }
    .scrollDismissesKeyboard(.interactively)
    .sensoryFeedback(.selection, trigger: model.isPairing)
  }

  private func connect() {
    guard !trimmed.isEmpty else { return }
    focused = false
    Task { await model.pair(trimmed) }
  }
}
