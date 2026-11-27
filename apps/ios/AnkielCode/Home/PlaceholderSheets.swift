import SwiftUI

/// Settings. Phase 8 builds it.
struct SettingsPlaceholderView: View {
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ContentUnavailableView {
        Label("Settings", systemImage: "gearshape")
      } description: {
        Text("Settings arrive in a later phase.")
      }
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done", systemImage: "xmark") { dismiss() }
        }
      }
    }
  }
}
