import AnkielKit
import SwiftUI
import UIKit

/// Lets SwiftUI reach the surface for what is not state: paste and the field reset.
@MainActor
final class TerminalSurfaceController {
  fileprivate weak var view: TerminalSurfaceView?

  func paste(_ text: String?) { view?.paste(text) }
  func resetInput() { view?.resetInputField() }
  var viewportText: String? { view?.viewportText }
}

/// The Ghostty surface, fed by a session: its output in, keys and the measured grid out.
struct TerminalSurface: UIViewRepresentable {
  let session: TerminalSessionModel
  let controller: TerminalSurfaceController
  let config: TerminalSurfaceView.Config
  @Binding var focused: Bool
  let onInput: (String) -> Void
  let onBell: () -> Void
  let onOpenURL: (URL) -> Void
  let onSelectText: (String) -> Void

  func makeUIView(context: Context) -> TerminalSurfaceView {
    let view = TerminalSurfaceView(frame: .zero)
    view.config = config
    controller.view = view
    context.coordinator.parent = self
    let coordinator = context.coordinator
    view.onInput = { coordinator.parent.onInput($0) }
    view.onBell = { coordinator.parent.onBell() }
    view.onOpenURL = { coordinator.parent.onOpenURL($0) }
    view.onSelectText = { coordinator.parent.onSelectText($0) }
    view.onResize = { [session] in session.reportGrid($0) }
    view.onFocusChange = { focused in
      if coordinator.parent.focused != focused { coordinator.parent.focused = focused }
    }
    // Setting the sink replays what already arrived.
    session.output = { [weak view] in view?.apply($0) }
    return view
  }

  func updateUIView(_ view: TerminalSurfaceView, context: Context) {
    context.coordinator.parent = self
    view.config = config
    view.sharedGrid = session.sharedGrid
    view.readOnly = !session.isLive
    if focused != view.hasKeyboardFocus {
      if focused { view.focus() } else { view.resignFocus() }
    }
  }

  static func dismantleUIView(_ view: TerminalSurfaceView, coordinator: Coordinator) {
    coordinator.parent?.session.output = nil
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  final class Coordinator {
    var parent: TerminalSurface!
  }
}

/// The keys a phone keyboard lacks, on glass above it (RN's terminal toolbar): arrows, Escape,
/// the host's two modifiers (held for the next key), Tab, common symbols, Paste and Dismiss.
struct TerminalAccessoryBar: View {
  let platform: TerminalHostPlatform
  @Binding var modifier: TerminalModifier?
  let palette: TerminalPalette
  let send: (String) -> Void
  let paste: () -> Void
  let dismissKeyboard: () -> Void

  private enum Key {
    case send(label: String, data: String, accessibility: LocalizedStringKey?)
    case modifier(label: String, TerminalModifier)

    var id: String {
      switch self {
      case .send(let label, _, _): "send:\(label)"
      case .modifier(let label, _): "mod:\(label)"
      }
    }
  }

  private var keys: [Key] {
    let modifiers: [Key] =
      platform == .mac
      ? [.modifier(label: "cmd", .meta), .modifier(label: "ctrl", .ctrl)]
      : [.modifier(label: "ctrl", .ctrl), .modifier(label: "alt", .meta)]
    return [.send(label: "esc", data: TerminalInput.escape, accessibility: "Escape")] + modifiers + [
      .send(label: "tab", data: TerminalInput.tab, accessibility: "Tab"),
      .send(label: "↑", data: TerminalInput.up, accessibility: "Up arrow"),
      .send(label: "↓", data: TerminalInput.down, accessibility: "Down arrow"),
      .send(label: "←", data: TerminalInput.left, accessibility: "Left arrow"),
      .send(label: "→", data: TerminalInput.right, accessibility: "Right arrow"),
      .send(label: "~", data: "~", accessibility: nil),
      .send(label: "|", data: "|", accessibility: nil),
      .send(label: "/", data: "/", accessibility: nil),
      .send(label: "-", data: "-", accessibility: nil),
    ]
  }

  var body: some View {
    GlassEffectContainer(spacing: Spacing.sm) {
      HStack(spacing: Spacing.sm) {
        ScrollView(.horizontal) {
          HStack(spacing: Spacing.xs) {
            ForEach(keys, id: \.id) { key in button(key) }
          }
          .padding(.horizontal, Spacing.sm)
        }
        .scrollIndicators(.hidden)
        .frame(minHeight: 44)
        .glassEffect(.regular, in: .capsule)
        Button(action: paste) {
          Image(systemName: "doc.on.clipboard")
            .frame(width: 44, height: 44)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .accessibilityLabel(Text("Paste", comment: "verb"))
        .accessibilityIdentifier("terminal.paste")
        Button(action: dismissKeyboard) {
          Image(systemName: "keyboard.chevron.compact.down")
            .frame(width: 44, height: 44)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .accessibilityLabel(Text("Dismiss keyboard"))
        .accessibilityIdentifier("terminal.dismissKeyboard")
      }
    }
    .padding(.horizontal, Spacing.sm)
    .padding(.vertical, Spacing.xs)
    .background(Color(uiColor: palette.backgroundColor))
    .sensoryFeedback(.selection, trigger: modifier)
  }

  @ViewBuilder private func button(_ key: Key) -> some View {
    switch key {
    case .send(let label, let data, let accessibility):
      Button {
        send(data)
      } label: {
        keyLabel(label, active: false)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(accessibility.map { Text($0) } ?? Text(verbatim: label))
      .accessibilityIdentifier("terminal.key.\(label)")
    case .modifier(let label, let held):
      let active = modifier == held
      Button {
        modifier = active ? nil : held
      } label: {
        keyLabel(label, active: active)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(Text(verbatim: label))
      .accessibilityAddTraits(active ? .isSelected : [])
      .accessibilityIdentifier("terminal.key.\(label)")
    }
  }

  private func keyLabel(_ label: String, active: Bool) -> some View {
    Text(verbatim: label)
      .font(Typography.mono.weight(active ? .semibold : .regular))
      .textCase(label.count > 1 ? .uppercase : nil)
      .foregroundStyle(active ? Palette.onAccent : Palette.textPrimary)
      .frame(minWidth: label.count > 1 ? 48 : 36, minHeight: 36)
      .background(active ? Palette.accent : Color.clear, in: .capsule)
      .contentShape(.rect)
      .frame(minHeight: 44)
  }
}

/// The visible text, selectable, with links that open (the RN module's
/// `TerminalTextSelectionViewController`).
struct TerminalTextSelection: View {
  let text: String
  let fontSize: Double
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      SelectableText(text: text, fontSize: max(fontSize, 14))
        .ignoresSafeArea(edges: .bottom)
        .navigationTitle(Text("Terminal text"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Copy all") {
              UIPasteboard.general.string = text
              Haptics.success()
              dismiss()
            }
            .accessibilityIdentifier("terminal.copyAll")
          }
          ToolbarItem(placement: .confirmationAction) {
            Button("Done") { dismiss() }
              .accessibilityIdentifier("terminal.selection.done")
          }
        }
    }
    .presentationDragIndicator(.visible)
  }
}

private struct SelectableText: UIViewRepresentable {
  let text: String
  let fontSize: Double

  func makeUIView(context: Context) -> UITextView {
    let view = UITextView()
    view.isEditable = false
    view.isSelectable = true
    // Login flows print auth URLs; tapping one opens it.
    view.dataDetectorTypes = .link
    view.backgroundColor = UIColor(\.terminalBackground)
    view.textColor = UIColor(\.terminalForeground)
    view.textContainerInset = UIEdgeInsets(top: 16, left: 12, bottom: 16, right: 12)
    view.accessibilityLabel = String(localized: "Terminal output")
    view.accessibilityIdentifier = "terminal.selection"
    return view
  }

  func updateUIView(_ view: UITextView, context: Context) {
    if view.text != text { view.text = text }
    view.font = Typography.uiFont(size: fontSize, mono: true)
  }
}
