import AnkielKit
import SwiftUI

/// A secret the agent asks for (RN `SecretRequestCard`). The values live only in this view's
/// state and the one call that sends them: never logged, never persisted, emptied before the
/// call (so the system does not offer to save a password) and put back if the call fails.
struct SecretCardView: View {
  let secret: PendingSecret
  let header: RequestQueueHeader
  let controller: PendingRequestController
  let canAnswer: Bool
  let environmentId: String

  @State private var values: [String: String] = [:]
  @State private var revealed: Set<String> = []
  @FocusState private var focused: String?
  @Environment(\.openURL) private var openURL

  private var inputs: [SecretRequestForm.Input] { SecretRequestForm.inputs(secret) }
  private var sending: String? {
    if case .sending(let choice) = controller.phase(secret.itemId) { choice } else { nil }
  }

  private var error: EnvironmentRequestError? {
    if case .failed(let error) = controller.phase(secret.itemId) { error } else { nil }
  }

  var body: some View {
    RequestCardChrome(title: secret.label, symbol: "key", header: header) {
      if !secret.reason.trimmingCharacters(in: .whitespaces).isEmpty {
        Text(secret.reason)
          .font(Typography.subheadline)
          .foregroundStyle(Palette.textSecondary)
          .textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let link = SecretRequestForm.link(secret), let host = link.host() {
        Button {
          openURL(link)
        } label: {
          Label(String(localized: "Open \(host)"), systemImage: "arrow.up.right.square")
            .font(Typography.subheadline.weight(.medium))
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .tint(Palette.textPrimary)
      }
      ForEach(Array(inputs.enumerated()), id: \.element.key) { index, input in
        VStack(alignment: .leading, spacing: Spacing.xs) {
          if secret.fields != nil {
            Text(input.label).font(Typography.footnote.weight(.medium)).foregroundStyle(Palette.textSecondary)
          }
          field(input, last: index == inputs.count - 1, next: index + 1 < inputs.count ? inputs[index + 1].key : nil)
        }
      }
    } actions: {
      VStack(alignment: .leading, spacing: Spacing.sm) {
        if let error {
          RequestFootnote(text: Self.failure(error), isError: true)
        }
        RequestButton(
          title: String(localized: "Save securely"), role: .primary, sending: sending == "save",
          disabled: !canAnswer || sending != nil || SecretRequestForm.answer(secret, values: values) == nil, identifier: "secret.save"
        ) {
          save()
        }
        HStack(alignment: .center, spacing: Spacing.sm) {
          Label(privacyNote, systemImage: "checkmark.shield")
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 0)
          RequestButton(
            title: String(localized: "Decline", comment: "verb, refuses the secret request"), role: .quiet, sending: sending == "decline",
            disabled: !canAnswer || sending != nil, identifier: "secret.decline"
          ) {
            Task { await controller.answer(SecretRequestForm.decline(secret), environmentId: environmentId) }
          }
          .fixedSize()
        }
        if !canAnswer {
          RequestFootnote(text: String(localized: "This connection cannot answer secret requests."))
        }
      }
    }
    .accessibilityIdentifier("request.secret")
  }

  @ViewBuilder
  private func field(_ input: SecretRequestForm.Input, last: Bool, next: String?) -> some View {
    let binding = Binding(get: { values[input.key] ?? "" }, set: { values[input.key] = $0 })
    let placeholder = input.placeholder ?? String(localized: "Paste the secret")
    HStack(spacing: Spacing.xs) {
      Group {
        if input.secret && !revealed.contains(input.key) {
          SecureField(placeholder, text: binding)
        } else {
          TextField(placeholder, text: binding)
        }
      }
      .font(input.secret ? Typography.mono : Typography.body)
      .textInputAutocapitalization(.never)
      .autocorrectionDisabled()
      .textContentType(.oneTimeCode)
      .privacySensitive()
      .focused($focused, equals: input.key)
      .submitLabel(last ? .done : .next)
      .onSubmit {
        if let next { focused = next } else if SecretRequestForm.answer(secret, values: values) != nil { save() }
      }
      .disabled(!canAnswer || sending != nil)
      .accessibilityLabel(Text(secret.fields == nil ? secret.label : input.label))
      .accessibilityIdentifier("secret.field.\(input.key)")
      if input.secret {
        Button {
          if revealed.contains(input.key) { revealed.remove(input.key) } else { revealed.insert(input.key) }
        } label: {
          Image(systemName: revealed.contains(input.key) ? "eye.slash" : "eye")
            .foregroundStyle(Palette.textTertiary)
            .frame(width: 44, height: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(revealed.contains(input.key) ? Text("Hide") : Text("Show"))
      }
    }
    .padding(.leading, Spacing.md)
    .padding(.trailing, input.secret ? 0 : Spacing.md)
    .frame(minHeight: 48)
    .background(Palette.surface, in: .rect(cornerRadius: Radius.field, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: Radius.field, style: .continuous)
        .strokeBorder(focused == input.key ? Palette.textTertiary : Palette.separator, lineWidth: focused == input.key ? 1 : 0.5)
    }
  }

  private var privacyNote: String {
    switch SecretRequestForm.privacy(secret) {
    case .neverShown: String(localized: "Stored securely, never shown to the agent")
    case .fileOne: String(localized: "Kept out of chat, in a private file this agent's commands can read for 24 hours")
    case .fileMany: String(localized: "Kept out of chat, in private files this agent's commands can read for 24 hours")
    }
  }

  private func save() {
    guard let answer = SecretRequestForm.answer(secret, values: values) else { return }
    let typed = values
    values = [:]
    focused = nil
    Task {
      if await !controller.answer(answer, environmentId: environmentId) { values = typed }
    }
  }

  /// Only the server's own refusal passes through; anything else gets the generic copy, so a
  /// typed value can never surface in the UI (RN `secretRequestFailureMessage`).
  static func failure(_ error: EnvironmentRequestError) -> String {
    switch error {
    case .notConnected: String(localized: "Not connected to the computer. Try again when it is back.")
    case .rejected(let message?) where !message.isEmpty: message
    default: String(localized: "Could not answer the request. Try again.")
    }
  }
}
