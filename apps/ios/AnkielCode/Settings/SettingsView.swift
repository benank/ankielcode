import AnkielKit
import SwiftUI

/// A page in Settings.
enum SettingsRoute: Hashable {
  case computers
  case computer(String)
  /// A computer's pairing links and signed-in devices.
  case access(String)
  case general, appearance, chat, notifications
  case providers, threads
  case about, storage, diagnostics
  case voice, archive
  /// Every computer's scheduled tasks.
  case scheduledTasks
  /// Provider usage limits, and one account's page.
  case usage
  case usageAccount(String)
  /// One provider on one computer (environment id, instance id).
  case provider(String, String)
  /// An archived thread, read from the Archive page.
  case archivedThread(ThreadRef)
}

/// Settings: the saved computers first, then device preferences, then what each computer's
/// server stores (RN `SettingsRouteScreen`). Client preferences save on this device; server
/// settings save to the computer they belong to.
struct SettingsView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""

  var body: some View {
    @Bindable var model = model
    NavigationStack(path: $model.settingsPath) {
      List {
        if SettingsSearch.normalized(query).isEmpty {
          rootSections
        } else {
          searchResults
        }
      }
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: Text("Search settings"))
      .navigationDestination(for: SettingsRoute.self) { route in
        destination(route)
      }
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done", systemImage: "xmark") { dismiss() }
            .keyboardShortcut(.cancelAction)
            .accessibilityIdentifier("settings.done")
        }
      }
    }
    .sheet(item: pairingSheet) { sheet in
      switch sheet {
      case .pairingLink: PairingLinkView()
      case .help: PairingHelpView()
      default: PairingProgressView()
      }
    }
    .fullScreenCover(isPresented: scanner) {
      QRScannerView()
    }
  }

  // MARK: Root

  @ViewBuilder private var rootSections: some View {
    Section {
      ComputerRows()
      Button {
        model.showPairingLink()
      } label: {
        Label("Add a computer", systemImage: "plus")
      }
      .accessibilityIdentifier("settings.addComputer")
    } header: {
      Text("Computers")
    } footer: {
      if !model.registry.environments.isEmpty {
        Text("Ankiel Code keeps every saved computer connected and reconnects on its own.")
      }
    }

    Section {
      SettingsLink(.general)
      SettingsLink(.appearance)
      SettingsLink(.chat)
      SettingsLink(.notifications)
      SettingsLink(.voice)
    }

    Section("Agents") {
      SettingsLink(.providers)
      SettingsLink(.usage)
      SettingsLink(.threads)
      SettingsLink(.scheduledTasks)
    }

    Section {
      SettingsLink(.about)
      SettingsLink(.archive)
    }
  }

  // MARK: Search

  @ViewBuilder private var searchResults: some View {
    let hits = SettingsSearch.results(query, computers: model.registry.environments.map { ($0.id, $0.label) })
    if hits.isEmpty {
      ContentUnavailableView.search(text: query)
        .listRowBackground(Color.clear)
    } else {
      Section {
        ForEach(hits) { hit in
          NavigationLink(value: hit.route) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
              Text(hit.title).foregroundStyle(Palette.textPrimary)
              if let detail = hit.detail {
                Text(detail)
                  .font(Typography.footnote)
                  .foregroundStyle(Palette.textSecondary)
              }
            }
          }
        }
      }
    }
  }

  // MARK: Pages

  @ViewBuilder private func destination(_ route: SettingsRoute) -> some View {
    switch route {
    case .computers: ComputersPage()
    case .computer(let id):
      if let environment = model.registry.environment(id) {
        ComputerDetailView(environment: environment)
      } else {
        ContentUnavailableView("This computer is no longer saved on this device.", systemImage: "desktopcomputer")
      }
    case .access(let id):
      if let environment = model.registry.environment(id) {
        SharingAccessPage(environment: environment, service: SharingAccessPage.service(for: environment, model: model))
      } else {
        ContentUnavailableView("This computer is no longer saved on this device.", systemImage: "desktopcomputer")
      }
    case .general: GeneralSettingsPage()
    case .appearance: AppearanceSettingsPage()
    case .chat: ChatSettingsPage()
    case .notifications: NotificationsSettingsPage()
    case .providers: ProvidersSettingsPage()
    case .threads: ThreadSettingsPage()
    case .about: AboutSettingsPage()
    case .storage: ClientStoragePage()
    case .diagnostics: DiagnosticsPage()
    case .voice: VoiceSettingsPage()
    case .archive: ArchivedThreadsScreen(registry: model.registry)
    case .scheduledTasks: ScheduledTasksPage()
    case .usage: UsageLimitsPage()
    case .usageAccount(let key): UsageAccountPage(key: key)
    case .provider(let id, let instanceId):
      if let environment = model.registry.environment(id) {
        ProviderDetailPage(environment: environment, instanceId: instanceId)
      } else {
        ContentUnavailableView("This computer is no longer saved on this device.", systemImage: "desktopcomputer")
      }
    case .archivedThread(let ref): ThreadDetailView(threadRef: ref)
    }
  }

  // MARK: Pairing inside Settings

  /// Pairing progress wins over the form that started it, so one sheet replaces the other.
  private var pairingSheet: Binding<AppModel.Sheet?> {
    Binding(
      get: {
        if model.pairing.isActive { return .settings }
        return model.settingsPairing == .scanner ? nil : model.settingsPairing
      },
      set: { next in
        guard next == nil else { return }
        if model.pairing.isActive { model.finishPairing() } else if model.settingsPairing != .scanner { model.settingsPairing = nil }
      })
  }

  private var scanner: Binding<Bool> {
    Binding(
      get: { model.settingsPairing == .scanner && !model.pairing.isActive },
      set: {
        if !$0, model.settingsPairing == .scanner {
          model.settingsPairing = nil
          model.pairingInputClosed()
        }
      })
  }
}

/// A root row: a tinted symbol, the page name, and a value when it says something.
private struct SettingsLink: View {
  let route: SettingsRoute

  init(_ route: SettingsRoute) {
    self.route = route
  }

  var body: some View {
    NavigationLink(value: route) {
      Label {
        Text(SettingsCopy.title(route))
      } icon: {
        SettingsIcon(symbol: SettingsCopy.symbol(route), tint: SettingsCopy.tint(route))
      }
    }
    .accessibilityIdentifier("settings.\(SettingsCopy.identifier(route))")
  }
}

/// An SF Symbol in a tinted rounded square, the iOS Settings idiom.
struct SettingsIcon: View {
  let symbol: String
  let tint: Color
  @ScaledMetric(relativeTo: .body) private var size: CGFloat = 29

  var body: some View {
    Image(systemName: symbol)
      .font(.system(size: size * 0.55, weight: .medium))
      .foregroundStyle(.white)
      .frame(width: size, height: size)
      .background(tint.gradient, in: .rect(cornerRadius: size * 0.24, style: .continuous))
      .accessibilityHidden(true)
  }
}

/// Page names, symbols and tints in one place, for rows, titles and search.
enum SettingsCopy {
  static func title(_ route: SettingsRoute) -> String {
    switch route {
    case .computers: String(localized: "Computers")
    case .computer: String(localized: "Computer")
    case .access: String(localized: "Sharing & access")
    case .general: String(localized: "General")
    case .appearance: String(localized: "Appearance")
    case .chat: String(localized: "Chat")
    case .notifications: String(localized: "Notifications")
    case .providers: String(localized: "Providers")
    case .threads: String(localized: "Threads", comment: "settings page title")
    case .about: String(localized: "About")
    case .storage: String(localized: "Client storage")
    case .diagnostics: String(localized: "Diagnostics")
    case .voice: String(localized: "Voice")
    case .archive: String(localized: "Archive", comment: "noun, settings page of archived threads")
    case .scheduledTasks: String(localized: "Scheduled tasks")
    case .usage: String(localized: "Usage", comment: "screen title")
    case .usageAccount: String(localized: "Account", comment: "screen title")
    case .provider: String(localized: "Provider")
    case .archivedThread: String(localized: "Thread", comment: "fallback name for an untitled thread")
    }
  }

  static func symbol(_ route: SettingsRoute) -> String {
    switch route {
    case .computers, .computer: "desktopcomputer"
    case .access: "person.2.badge.key"
    case .general: "gearshape"
    case .appearance: "paintbrush"
    case .chat: "bubble.left.and.bubble.right"
    case .notifications: "bell.badge"
    case .providers: "person.crop.circle"
    case .threads: "text.bubble"
    case .about: "info.circle"
    case .storage: "internaldrive"
    case .diagnostics: "stethoscope"
    case .voice: "mic"
    case .archive, .archivedThread: "archivebox"
    case .scheduledTasks: "calendar.badge.clock"
    case .usage, .usageAccount: "gauge.with.dots.needle.33percent"
    case .provider: "person.crop.circle"
    }
  }

  static func tint(_ route: SettingsRoute) -> Color {
    switch route {
    case .notifications, .voice: Palette.settingsRed
    case .appearance, .threads: Palette.settingsBlue
    case .chat, .providers, .usage: Palette.settingsGreen
    case .scheduledTasks: Palette.settingsBlue
    default: Palette.settingsGray
    }
  }

  static func identifier(_ route: SettingsRoute) -> String {
    switch route {
    case .computers: "computers"
    case .computer(let id): "computer.\(id)"
    case .access(let id): "access.\(id)"
    case .general: "general"
    case .appearance: "appearance"
    case .chat: "chat"
    case .notifications: "notifications"
    case .providers: "providers"
    case .threads: "threads"
    case .about: "about"
    case .storage: "storage"
    case .diagnostics: "diagnostics"
    case .voice: "voice"
    case .archive: "archive"
    case .scheduledTasks: "scheduledTasks"
    case .archivedThread(let ref): "archivedThread.\(ref.threadId)"
    case .usage: "usage"
    case .usageAccount(let key): "usageAccount.\(key)"
    case .provider(let id, let instanceId): "provider.\(id).\(instanceId)"
    }
  }
}

/// Settings search (RN `settings-search.ts` in spirit): page names and the settings on them,
/// matched by every word of the query.
enum SettingsSearch {
  struct Hit: Identifiable {
    var id: String { "\(SettingsCopy.identifier(route))|\(detail ?? "")" }
    let route: SettingsRoute
    let title: String
    let detail: String?
  }

  static func normalized(_ query: String) -> String {
    query.trimmingCharacters(in: .whitespacesAndNewlines).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
  }

  /// The settings each page holds, as the user reads them.
  static func entries() -> [(SettingsRoute, [String])] {
    [
      (.general, [String(localized: "Language"), String(localized: "Project grouping"), String(localized: "Group by repository")]),
      (.appearance, [String(localized: "Theme"), String(localized: "Dark"), String(localized: "Light"), String(localized: "Code and diffs"), String(localized: "Font size"), String(localized: "Word break"), String(localized: "Text size")]),
      (.chat, [String(localized: "While the agent is running"), String(localized: "Steer", comment: "verb, follow-up behavior"), String(localized: "Queue", comment: "verb, follow-up behavior"), String(localized: "Haptics")]),
      (.notifications, [String(localized: "Push notifications")]),
      (.providers, [String(localized: "Signed in"), String(localized: "Models")]),
      (.threads, [String(localized: "Default permissions"), String(localized: "Usage limits"), String(localized: "Auto-settle"), String(localized: "Response streaming"), String(localized: "Use last project")]),
      (.about, [String(localized: "Version"), String(localized: "Legal"), String(localized: "Source code"), String(localized: "Remove all computers")]),
      (.storage, [String(localized: "Clear caches"), String(localized: "Drafts")]),
      (.diagnostics, [String(localized: "Copy diagnostics")]),
      (.voice, [String(localized: "Dictation"), String(localized: "Microphone access"), String(localized: "Language")]),
      (.archive, [String(localized: "Archived threads"), String(localized: "Unarchive", comment: "verb, swipe action")]),
      (.usage, [String(localized: "Provider usage limits"), String(localized: "Reset credits"), String(localized: "Context window")]),
    ]
  }

  static func results(_ query: String, computers: [(id: String, label: String)]) -> [Hit] {
    let words = normalized(query).split(separator: " ").map(String.init)
    guard !words.isEmpty else { return [] }
    func matches(_ text: String) -> Bool {
      let haystack = normalized(text)
      return words.allSatisfy { haystack.contains($0) }
    }
    var hits: [Hit] = computers.filter { matches($0.label) }.map {
      Hit(route: .computer($0.id), title: $0.label, detail: String(localized: "Computers"))
    }
    for (route, terms) in entries() {
      let title = SettingsCopy.title(route)
      if matches(title) {
        hits.append(Hit(route: route, title: title, detail: nil))
      } else if let term = terms.first(where: matches) {
        hits.append(Hit(route: route, title: term, detail: title))
      }
    }
    return hits
  }
}
