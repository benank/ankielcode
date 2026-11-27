import AnkielKit
import SwiftUI

/// Pair by typing or pasting: an address and a code (the RN form), filled in one go when a whole
/// pairing link is pasted.
struct PairingLinkView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var address = ""
  @State private var code = ""
  @FocusState private var focus: Field?

  private enum Field { case address, code }

  private var canConnect: Bool {
    !address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          PasteButton(payloadType: String.self) { strings in
            guard let first = strings.first else { return }
            fill(from: first)
          }
          .buttonBorderShape(.capsule)
          .labelStyle(.titleAndIcon)
          .frame(maxWidth: .infinity, alignment: .center)
          .listRowBackground(Color.clear)
          .listRowInsets(EdgeInsets())
        } footer: {
          Text("Copy the pairing link on your computer, then paste it here.")
            .frame(maxWidth: .infinity, alignment: .center)
            .multilineTextAlignment(.center)
        }

        Section {
          LabeledContent("Address") {
            TextField(text: $address, prompt: Text(verbatim: "192.168.1.100:3773")) { Text("Address") }
              .keyboardType(.URL)
              .textContentType(.URL)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .submitLabel(.next)
              .focused($focus, equals: .address)
              .onSubmit { focus = .code }
              .onChange(of: address) { _, value in splitIfLink(value) }
          }
          LabeledContent("Code") {
            TextField(text: $code, prompt: Text("Pairing code")) { Text("Code") }
              .font(Typography.mono)
              .textInputAutocapitalization(.characters)
              .autocorrectionDisabled()
              .submitLabel(.go)
              .focused($focus, equals: .code)
              .onSubmit(connect)
          }
        } header: {
          Text("Or enter it")
        } footer: {
          Text("For machines on your local network or tailnet. The machine keeps its own provider credentials.")
        }
      }
      .scrollContentBackground(.hidden)
      .background(Palette.canvas)
      .navigationTitle("Add a computer")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", systemImage: "xmark") { dismiss() }
            .keyboardShortcut(.cancelAction)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Connect", systemImage: "checkmark", action: connect)
            .disabled(!canConnect)
        }
      }
    }
  }

  /// A pasted pairing link fills both fields.
  private func fill(from text: String) {
    let unwrapped = PairingFlow.unwrapScanned(text)
    if let target = try? PairingInput.resolve(pairingURL: unwrapped) {
      address = Self.displayAddress(target.endpoint)
      code = target.credential
      focus = nil
    } else {
      address = unwrapped.trimmingCharacters(in: .whitespacesAndNewlines)
    }
  }

  private func splitIfLink(_ value: String) {
    guard value.contains("token="), let target = try? PairingInput.resolve(pairingURL: PairingFlow.unwrapScanned(value))
    else { return }
    address = Self.displayAddress(target.endpoint)
    code = target.credential
  }

  private func connect() {
    guard canConnect else { return }
    model.pair(host: address, code: code)
  }

  /// The base URL without a trailing slash, keeping the scheme so http/https survives.
  static func displayAddress(_ endpoint: EnvironmentEndpoint) -> String {
    let text = endpoint.httpBaseURL.absoluteString
    return text.hasSuffix("/") ? String(text.dropLast()) : text
  }
}
