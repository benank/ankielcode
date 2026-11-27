import AnkielKit
import SwiftUI
import UIKit

/// Version, links, legal, storage and diagnostics, and removing every computer (RN
/// `SettingsAboutRouteScreen`, `SettingsLegalRouteScreen`).
struct AboutSettingsPage: View {
  @Environment(AppModel.self) private var model
  @State private var confirmingRemoveAll = false

  static let website = URL(string: "https://code.ankiel.com/")!
  static let legal = URL(string: "https://code.ankiel.com/legal")!
  static let source = URL(string: "https://github.com/benank/ankielcode")!
  static let license = URL(string: "https://github.com/benank/ankielcode/blob/main/LICENSE")!

  var body: some View {
    List {
      Section {
        LabeledContent("Version", value: AppInfo.versionLabel)
          .accessibilityIdentifier("about.version")
        NavigationLink(value: SettingsRoute.storage) { Label("Client storage", systemImage: "internaldrive") }
          .accessibilityIdentifier("settings.storage")
        NavigationLink(value: SettingsRoute.diagnostics) { Label("Diagnostics", systemImage: "stethoscope") }
          .accessibilityIdentifier("settings.diagnostics")
      } header: {
        Text("App", comment: "settings section about this mobile app")
      }

      Section {
        Link(destination: Self.website) { Label("Website", systemImage: "globe") }
        Link(destination: Self.source) { Label("Source code", systemImage: "chevron.left.forwardslash.chevron.right") }
        Link(destination: Self.legal) { Label("Legal", systemImage: "doc.text") }
        Link(destination: Self.license) { Label("License (MIT)", systemImage: "checkmark.seal") }
      } footer: {
        Text("Ankiel Code is open source under the MIT license. This app includes no third-party code.")
      }

      Section {
        Button("Remove all computers", systemImage: "trash", role: .destructive) { confirmingRemoveAll = true }
          .disabled(model.registry.environments.isEmpty)
          .accessibilityIdentifier("about.removeAll")
      } footer: {
        Text("Forgets every computer's sign-in and cached threads on this device. Your preferences stay. The computers keep listing this device until you revoke it there.")
      }
    }
    .navigationTitle("About")
    .navigationBarTitleDisplayMode(.inline)
    .confirmationDialog("Remove all computers?", isPresented: $confirmingRemoveAll, titleVisibility: .visible) {
      Button("Remove all", role: .destructive) {
        Task {
          await model.registry.removeAll()
          model.sheet = nil
        }
      }
    } message: {
      Text("You'll need a new pairing link to add each one again.")
    }
  }
}

enum AppInfo {
  static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }
  static var build: String? { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String }

  static var versionLabel: String {
    var label = build.map { "\(version) (\($0))" } ?? version
    #if DEBUG
      label += " · " + String(localized: "Development", comment: "build variant")
    #endif
    return label
  }
}

/// What this device stores: each computer's cached thread list, drafts and unsent messages
/// (RN `SettingsClientStorageRouteScreen`).
struct ClientStoragePage: View {
  @Environment(AppModel.self) private var model
  @State private var shellSizes: [String: Int64] = [:]
  @State private var attachmentBytes: Int64 = 0
  @State private var clearing: ClearTarget?

  enum ClearTarget: Identifiable, Hashable {
    case computer(String), all, drafts
    var id: Self { self }
  }

  var body: some View {
    List {
      Section {
        ForEach(model.registry.environments) { environment in
          LabeledContent(environment.label) {
            Text(size(shellSizes[environment.id] ?? 0))
              .contentTransition(.numericText())
          }
          .swipeActions {
            if (shellSizes[environment.id] ?? 0) > 0 {
              Button("Clear cache", role: .destructive) { clearing = .computer(environment.id) }
            }
          }
        }
        Button("Clear caches", role: .destructive) { clearing = .all }
          .disabled(shellSizes.values.reduce(0, +) == 0)
          .accessibilityIdentifier("storage.clearAll")
      } header: {
        Text("Environment caches")
      } footer: {
        Text("Cached thread lists show threads before a computer connects. They download again on the next connection.")
      }

      Section {
        LabeledContent("Drafts", value: model.composer.draftCount.formatted())
        LabeledContent("Unsent messages", value: model.composer.outbox.filter { !$0.state.isSent }.count.formatted())
        LabeledContent("Attachment copies", value: size(attachmentBytes))
        Button("Clear drafts", role: .destructive) { clearing = .drafts }
          .disabled(model.composer.draftCount == 0)
      } header: {
        Text("Composer")
      } footer: {
        Text("Unsent messages are delivered when their computer connects; delete one from its thread. Clearing drafts keeps them.")
      }
    }
    .navigationTitle("Client storage")
    .navigationBarTitleDisplayMode(.inline)
    .task(id: model.registry.environments.map(\.id)) { await measure() }
    .confirmationDialog(title, isPresented: Binding(get: { clearing != nil }, set: { if !$0 { clearing = nil } }), titleVisibility: .visible, presenting: clearing) { target in
      Button(confirmLabel(target), role: .destructive) { Task { await clear(target) } }
    } message: { target in
      Text(message(target))
    }
  }

  private var title: String {
    switch clearing {
    case .computer(let id)?:
      String(localized: "Clear cache for \(model.registry.environment(id)?.label ?? id)?")
    case .drafts?: String(localized: "Clear all drafts?")
    default: String(localized: "Clear all client caches?")
    }
  }

  private func confirmLabel(_ target: ClearTarget) -> String {
    switch target {
    case .computer: String(localized: "Clear cache")
    case .all: String(localized: "Clear all caches")
    case .drafts: String(localized: "Clear drafts")
    }
  }

  private func message(_ target: ClearTarget) -> String {
    switch target {
    case .computer:
      String(localized: "This removes the saved thread list for this computer. Its connection and sign-in stay.")
    case .all:
      String(localized: "This removes offline data for every environment. Connections, credentials and app preferences stay intact.")
    case .drafts:
      String(localized: "This empties every composer and removes its attachments. Unsent messages stay.")
    }
  }

  private func clear(_ target: ClearTarget) async {
    switch target {
    case .computer(let id): await model.registry.clearShellCache(id)
    case .all: for environment in model.registry.environments { await model.registry.clearShellCache(environment.id) }
    case .drafts: model.composer.clearDrafts()
    }
    Haptics.success()
    await measure()
  }

  private func measure() async {
    var sizes: [String: Int64] = [:]
    for environment in model.registry.environments {
      sizes[environment.id] = await model.registry.shellCacheSize(environment.id)
    }
    shellSizes = sizes
    attachmentBytes = await model.composer.attachmentBytes()
  }

  private func size(_ bytes: Int64) -> String {
    bytes.formatted(.byteCount(style: .file))
  }
}

/// A copyable report of this app and every computer's connection (RN `diagnostics`), for bug
/// reports. Holds no credentials, tokens or thread content.
struct DiagnosticsPage: View {
  @Environment(AppModel.self) private var model
  @State private var copied = false

  var body: some View {
    List {
      Section {
        Text(report)
          .font(Typography.monoSmall)
          .foregroundStyle(Palette.textSecondary)
          .textSelection(.enabled)
      } footer: {
        Text("No sign-in details or thread content are included.")
      }
      Section {
        Button(copied ? "Copied" : "Copy diagnostics", systemImage: copied ? "checkmark" : "doc.on.doc") {
          UIPasteboard.general.string = report
          copied = true
        }
        .contentTransition(.symbolEffect(.replace))
        .sensoryFeedback(.success, trigger: copied) { _, new in new }
        .accessibilityIdentifier("diagnostics.copy")
      }
    }
    .navigationTitle("Diagnostics")
    .navigationBarTitleDisplayMode(.inline)
  }

  private var report: String {
    let os = ProcessInfo.processInfo.operatingSystemVersion
    var lines = [
      "Ankiel Code \(AppInfo.versionLabel)",
      "iOS \(os.majorVersion).\(os.minorVersion).\(os.patchVersion) · \(UIDevice.current.model)",
      "Computers: \(model.registry.environments.count)",
    ]
    for environment in model.registry.environments {
      lines.append("")
      lines.append("\(environment.label) (\(environment.id))")
      lines.append("  status: \(ConnectionPresentation.statusText(environment.status, host: environment.label))")
      lines.append("  server: \(environment.record.serverVersion)")
      if let route = environment.displayRoute {
        lines.append("  route: \(ConnectionPresentation.routeName(route.kind)) \(route.learned ? "learned" : "paired")")
      }
      lines.append("  routes: \(environment.record.routes.count)")
      lines.append("  shell: \(String(describing: environment.shell.status))")
      if let failure = environment.status.lastFailure {
        lines.append("  last failure: \(String(describing: failure.cause))\(failure.httpStatus.map { " HTTP \($0)" } ?? "")")
      }
      if let connected = environment.record.lastConnectedAt {
        lines.append("  last connected: \(connected.formatted(.iso8601))")
      }
    }
    return lines.joined(separator: "\n")
  }
}
