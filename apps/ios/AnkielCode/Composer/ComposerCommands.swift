import AnkielKit
import SwiftUI

extension ComposerSlashMenu.Labels {
  static var localized: ComposerSlashMenu.Labels {
    var labels = ComposerSlashMenu.Labels()
    labels.model = String(localized: "Switch model")
    labels.side = String(localized: "Ask a side question in a new side chat")
    labels.btw = String(localized: "Same as /side")
    labels.clear = String(localized: "Start a fresh session")
    return labels
  }
}

/// Shown while `/clear` is armed; dismissing it keeps the current session (RN `FreshSessionNotice`).
struct FreshSessionNotice: View {
  let keep: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: Spacing.sm) {
      Image(systemName: "arrow.clockwise")
        .foregroundStyle(Palette.textSecondary)
        .accessibilityHidden(true)
      Text("Your next message starts a fresh session. The agent won't see earlier messages in this thread.")
        .foregroundStyle(Palette.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)
      Button(action: keep) {
        Image(systemName: "xmark")
          .font(Typography.footnote.weight(.semibold))
          .foregroundStyle(Palette.textSecondary)
          .frame(width: 44, height: 44)
          .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .padding(-Spacing.sm)
      .accessibilityLabel(Text("Keep the current session"))
      .accessibilityIdentifier("composer.freshSession.keep")
    }
    .font(Typography.footnote)
    .padding(.horizontal, Spacing.md)
    .padding(.vertical, Spacing.sm + 2)
    .glassEffect(.regular, in: .rect(cornerRadius: Radius.field + 4, style: .continuous))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("composer.freshSession")
  }
}
