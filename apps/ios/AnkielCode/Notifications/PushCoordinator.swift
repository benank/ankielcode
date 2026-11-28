import AnkielKit
import Foundation
import Observation
import OSLog
import UIKit
import UserNotifications

/// Push notifications end to end: the preference, permission and APNs token, registering with
/// every connected computer, the categories and their buttons, foreground presentation, taps,
/// answers sent from a button, the app icon badge and clearing alerts that are out of date.
@MainActor @Observable
final class PushCoordinator {
  enum Permission: Equatable { case unknown, undetermined, denied, granted }
  /// "unavailable" means this build can't get an APNs token (no push entitlement, no network).
  enum DeviceStatus: Equatable { case unknown, reading, ready, unavailable }

  private(set) var preference: PushPreference
  private(set) var permission = Permission.unknown
  private(set) var deviceStatus = DeviceStatus.unknown
  private(set) var device: PushDevice?
  /// Each connected computer's last status read (Settings → Notifications).
  private(set) var statuses: [String: Result<PushStatus, EnvironmentRequestError>] = [:]
  /// The one-time offer after the first new thread.
  var offerVisible = false

  @ObservationIgnored private let model: AppModel
  @ObservationIgnored private let defaults: UserDefaults
  @ObservationIgnored private let center = UNUserNotificationCenter.current()
  @ObservationIgnored private var sync = PushSyncState()
  @ObservationIgnored private var tasks: [Task<Void, Never>] = []
  @ObservationIgnored private var tokenWaiters: [CheckedContinuation<Void, Never>] = []
  @ObservationIgnored private var started = false
  #if DEBUG
    /// `ANKIEL_DEBUG_PUSH`: a canned permission, token and per-computer rows (nothing registers).
    @ObservationIgnored private(set) var debugMode: PushDebug.Mode?
  #endif

  static let storageKey = "ankiel.push.v1"
  private static let log = Logger(subsystem: "com.ankiel.ankielcode.native", category: "push")

  init(model: AppModel) {
    self.model = model
    var defaults = UserDefaults.standard
    #if DEBUG
      debugMode = PushDebug.Mode(ProcessInfo.processInfo.environment["ANKIEL_DEBUG_PUSH"])
      if debugMode != nil { defaults = PushDebug.defaults }
    #endif
    self.defaults = defaults
    preference = defaults.data(forKey: Self.storageKey).flatMap { try? JSONDecoder().decode(PushPreference.self, from: $0) } ?? PushPreference()
    #if DEBUG
      if let debugMode { PushDebug.apply(debugMode, to: self) }
    #endif
  }

  // MARK: Lifecycle

  /// From `didFinishLaunching`: the categories, the current permission and token, then follows
  /// the computers, the preference and the shell for registration, the badge and clearing.
  func start() {
    guard !started else { return }
    started = true
    registerCategories()
    tasks = [
      Task { [weak self] in
        guard let self else { return }
        await refreshPermission()
        if preference.enabled == true, permission == .granted { requestToken() }
      },
      Task { [weak self] in
        guard let self else { return }
        for await _ in Observations({ self.syncInputs }) { self.syncRegistrations() }
      },
      Task { [weak self] in
        guard let self else { return }
        for await count in Observations({ self.waitingCount }) { await self.setBadge(count) }
      },
      Task { [weak self] in
        guard let self else { return }
        for await visible in Observations({ self.model.navigator.stack }) { await self.clearDelivered(for: visible) }
      },
      Task { [weak self] in
        guard let self else { return }
        for await waiting in Observations({ self.liveWaiting }) { await self.clearAnswered(waiting) }
      },
      Task { [weak self] in
        for await _ in NotificationCenter.default.notifications(named: UIApplication.didBecomeActiveNotification) {
          guard let self else { return }
          await refreshPermission()
          await clearDelivered(for: model.navigator.stack)
        }
      },
      Task { [weak self] in
        for await _ in NotificationCenter.default.notifications(named: NSLocale.currentLocaleDidChangeNotification) {
          guard let self else { return }
          registerCategories()
          syncRegistrations()
        }
      },
    ]
  }

  // MARK: Preference

  var isEnabled: Bool { preference.enabled == true }

  private func save(_ next: PushPreference) {
    preference = next
    if let data = try? JSONEncoder().encode(next) { defaults.set(data, forKey: Self.storageKey) }
  }

  /// The master switch. Turning on asks for permission (only then), reads the token, and saves
  /// the choice only once iOS allows alerts.
  func setEnabled(_ on: Bool) async {
    guard on else {
      var next = preference
      next.enabled = false
      save(next)
      return
    }
    let allowed = await requestPermission()
    guard allowed else { return }
    var next = preference
    next.enabled = true
    next.offered = true
    save(next)
    requestToken()
  }

  func setKind(_ kind: PushAlertKind, _ on: Bool) {
    save(preference.setting(kind, on))
  }

  // MARK: Permission and token

  func refreshPermission() async {
    #if DEBUG
      if debugMode != nil { return }
    #endif
    let settings = await center.notificationSettings()
    permission =
      switch settings.authorizationStatus {
      case .authorized, .provisional, .ephemeral: .granted
      case .denied: .denied
      case .notDetermined: .undetermined
      @unknown default: .undetermined
      }
  }

  private func requestPermission() async -> Bool {
    #if DEBUG
      if debugMode != nil { return permission == .granted }
    #endif
    await refreshPermission()
    if permission == .undetermined {
      let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
      permission = granted ? .granted : .denied
    }
    return permission == .granted
  }

  /// Asks UIKit for the token (again on each launch, as Apple recommends); the answer arrives in
  /// the app delegate. A token that never comes in 20 s marks this build unavailable.
  private func requestToken() {
    #if DEBUG
      if debugMode != nil { return }
    #endif
    if device == nil { deviceStatus = .reading }
    UIApplication.shared.registerForRemoteNotifications()
    let pending = device
    Task { [weak self] in
      try? await Task.sleep(for: .seconds(20))
      guard let self, self.device == pending, self.deviceStatus == .reading else { return }
      self.deviceStatus = .unavailable
    }
  }

  func didRegister(token: Data) {
    let appId = Bundle.main.bundleIdentifier ?? "com.ankiel.ankielcode.native"
    let environment = ProvisioningProfile.resolve(
      Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision").flatMap { try? Data(contentsOf: $0) },
      isSimulator: Self.isSimulator)
    device = PushDevice(token: PushDevice.hex(token), appId: appId, apnsEnvironment: environment)
    deviceStatus = .ready
  }

  func didFailToRegister() {
    if device == nil { deviceStatus = .unavailable }
  }

  private static var isSimulator: Bool {
    #if targetEnvironment(simulator)
      true
    #else
      false
    #endif
  }

  // MARK: Registration

  private struct SyncInputs: Equatable {
    var preference: PushPreference
    var device: PushDevice?
    var connected: Set<String>
  }

  /// Connected means a live session: the RPC needs one.
  private var connectedIds: Set<String> {
    Set(model.registry.environments.filter { $0.activeRoute != nil }.map(\.id))
  }

  private var syncInputs: SyncInputs { SyncInputs(preference: preference, device: device, connected: connectedIds) }

  private static var locale: String { Bundle.main.preferredLocalizations.first ?? Locale.current.identifier }

  /// Brings every connected computer in line with the preference: once per connection, token,
  /// kinds and locale (RN `installPushRegistration`).
  private func syncRegistrations() {
    #if DEBUG
      if debugMode != nil || model.isSettingsFixture { return }
    #endif
    let target = PushTarget.make(preference, device: device, locale: Self.locale)
    let connected = connectedIds
    for id in statuses.keys where !connected.contains(id) { statuses[id] = nil }
    let due = sync.take(connected: connected, target: target)
    guard let target else { return }
    for id in due {
      Task {
        let result: Result<PushStatus, EnvironmentRequestError>
        do throws(EnvironmentRequestError) {
          if let registration = target.registration {
            result = .success(try await model.registry.registerPush(registration, in: id))
          } else {
            result = .success(try await model.registry.unregisterPush(in: id))
          }
        } catch {
          result = .failure(error)
        }
        if connectedIds.contains(id) { statuses[id] = result }
        sync.settle(id, key: target.key)
        syncRegistrations()
      }
    }
  }

  /// Reads each connected computer's status for the Notifications page.
  func refreshStatuses() {
    #if DEBUG
      if debugMode != nil || model.isSettingsFixture { return }
    #endif
    // One read each, so a slow computer doesn't hold back the others' rows.
    for id in connectedIds {
      Task {
        let result: Result<PushStatus, EnvironmentRequestError>
        do throws(EnvironmentRequestError) {
          result = .success(try await model.registry.pushStatus(in: id))
        } catch {
          result = .failure(error)
        }
        if connectedIds.contains(id) { statuses[id] = result }
      }
    }
  }

  func state(_ environment: EnvironmentModel) -> PushComputerState {
    #if DEBUG
      if let debugMode, let index = model.registry.environments.firstIndex(where: { $0.id == environment.id }) {
        return PushDebug.state(debugMode, index: index)
      }
    #endif
    let connected = environment.activeRoute != nil
    switch statuses[environment.id] {
    case .success(let status)?: return .derive(connected: connected, status: status, error: nil)
    case .failure(let error)?: return .derive(connected: connected, status: nil, error: error)
    case nil: return .derive(connected: connected, status: nil, error: nil)
    }
  }

  /// Drops this phone's registration before a computer is forgotten. An offline one keeps it
  /// until this device's session is revoked there, which deletes the registration.
  func unregisterBeforeRemoval(_ environmentId: String) async {
    guard isEnabled, model.registry.environment(environmentId)?.activeRoute != nil else { return }
    _ = await NotificationAnswer.first(within: .seconds(3)) { @MainActor in
      try? await self.model.registry.unregisterPush(in: environmentId)
    }
  }

  // MARK: The first-thread offer

  /// After the first new thread: offers alerts once, unless push was already chosen or iOS
  /// already answered.
  func newThreadStarted() {
    guard preference.enabled == nil, !preference.offered, permission != .denied else { return }
    var next = preference
    next.offered = true
    save(next)
    // After the new-thread sheet has gone: an alert can't present over a dismissing sheet.
    Task {
      try? await Task.sleep(for: .milliseconds(700))
      offerVisible = true
    }
  }

  // MARK: Categories

  private func registerCategories() {
    let options: UNNotificationActionOptions = [.authenticationRequired]
    let approve = UNNotificationAction(
      identifier: AgentAlertIDs.approve, title: String(localized: "Approve", comment: "verb, notification button"), options: options)
    let deny = UNNotificationAction(
      identifier: AgentAlertIDs.deny, title: String(localized: "Deny", comment: "verb, notification button"),
      options: options.union(.destructive))
    let reply = UNTextInputNotificationAction(
      identifier: AgentAlertIDs.reply, title: String(localized: "Reply", comment: "verb, notification button"), options: options,
      textInputButtonTitle: String(localized: "Send", comment: "verb, sends a reply"),
      textInputPlaceholder: String(localized: "Type your answer"))
    center.setNotificationCategories([
      UNNotificationCategory(identifier: AgentAlertIDs.approvalCategory, actions: [approve, deny], intentIdentifiers: []),
      UNNotificationCategory(identifier: AgentAlertIDs.replyCategory, actions: [reply], intentIdentifiers: []),
    ])
  }

  // MARK: Receiving

  /// Agent alerts for the thread on screen stay quiet; everything else shows as usual.
  func presentation(for alert: AgentAlert?) -> UNNotificationPresentationOptions {
    guard let alert, UIApplication.shared.applicationState == .active else { return [.banner, .list, .sound] }
    let onScreen = model.navigator.stack.last
    return onScreen == alert.thread || onScreen == alert.requestThread ? [] : [.banner, .list, .sound]
  }

  /// A tap (cold or warm) opens the thread through the same path as a thread link.
  func open(_ alert: AgentAlert) {
    var components = URLComponents()
    components.scheme = "ankielcode-native"
    components.host = "thread"
    components.path = "/\(alert.thread.environmentId)/\(alert.thread.threadId)"
    if let url = components.url { model.open(url) }
  }

  /// A button's answer, sent without opening the app: connects just long enough to send it with a
  /// fixed command id, and posts a local alert when it could not be sent.
  func answer(_ action: AgentNotificationAction, from alert: AgentAlert) async {
    let application = UIApplication.shared
    let assertion = application.beginBackgroundTask(withName: "Answer from notification")
    Self.log.notice("notification \(action.kind.rawValue, privacy: .public) pressed")
    defer { application.endBackgroundTask(assertion) }
    // A cold background launch has no scene, so nothing else loaded the saved computers.
    await model.registry.load()
    // A warm resume may hold a socket that died while suspended.
    model.registry.wake(.foreground)
    let registry = model.registry
    let thread = registry.openThread(action.thread)
    defer { registry.closeThread(thread) }
    let environmentId = action.thread.environmentId
    let outcome = await NotificationAnswer.perform(
      action,
      states: Self.states(of: thread),
      canOperate: { @MainActor in registry.environment(environmentId)?.allows(AuthScope.orchestrationOperate) ?? false },
      send: { @MainActor command in _ = try await registry.respond(command, in: environmentId) },
      stillPending: { @MainActor in
        let request = await thread.sync.projection?.runtimeRequests.first { $0.id == action.requestId }
        return request.map { $0.status == .pending } ?? true
      })
    Self.log.notice("notification \(action.kind.rawValue, privacy: .public) answer: \(String(describing: outcome), privacy: .public)")
    if outcome == .unsent { await reportUnsent(alert) }
  }

  /// The opened thread's state each time its phase changes, with the projection behind it.
  private static func states(of thread: ThreadDetailModel) -> AsyncStream<NotificationAnswer.ThreadState> {
    AsyncStream { continuation in
      let task = Task { @MainActor in
        // Every publish, not just phase changes: a warm resume stays `.live` while the request arrives.
        for await state in Observations({ thread.state }) {
          switch state.phase {
          case .deleted: continuation.yield(.deleted)
          case .live: continuation.yield(.live(await thread.sync.projection))
          default: continuation.yield(.catchingUp)
          }
        }
        continuation.finish()
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  private func reportUnsent(_ alert: AgentAlert) async {
    let content = UNMutableNotificationContent()
    content.title = String(localized: "Couldn't send your answer")
    content.body = String(localized: "Try again from the thread.")
    content.threadIdentifier = alert.groupIdentifier
    content.categoryIdentifier = AgentAlertIDs.unsentCategory
    content.sound = .default
    content.userInfo = ["body": ["environmentId": alert.thread.environmentId, "threadId": alert.thread.threadId]]
    try? await center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
  }

  // MARK: Badge and clearing

  private func setBadge(_ count: Int) async {
    #if DEBUG
      if debugMode != nil { return }
    #endif
    do {
      try await center.setBadgeCount(count)
    } catch {
      Self.log.error("badge \(count) refused: \(error.localizedDescription, privacy: .public)")
    }
  }

  /// Listed threads waiting on the user across computers (`HomeModel.waitingCount`, read from the
  /// registry's observable shells; the home model's sources are not observed).
  private var waitingCount: Int {
    AttentionCount.waiting(model.registry.environments.flatMap { environment in
      environment.shell.threads.lazy.filter(\.isListed).map { ThreadFacts(environmentId: environment.id, thread: $0) }
    })
  }

  /// Opening a thread clears its alerts.
  private func clearDelivered(for visible: [ThreadRef]) async {
    guard !visible.isEmpty, UIApplication.shared.applicationState == .active else { return }
    let groups = Set(visible.map(AgentAlert.groupIdentifier))
    let delivered = await center.deliveredNotifications()
    let ids = delivered.filter { groups.contains($0.request.content.threadIdentifier) }.map(\.request.identifier)
    if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
  }

  /// Threads that wait on the user, per computer whose list is live (a cached list can't say a
  /// request was answered).
  private var liveWaiting: [String: Set<ThreadRef>] {
    var waiting: [String: Set<ThreadRef>] = [:]
    for environment in model.registry.environments where environment.isShellLive {
      waiting[environment.id] = AlertClearing.waitingThreads(environmentId: environment.id, threads: environment.shell.threads)
    }
    return waiting
  }

  /// An approval or question answered elsewhere clears its alert.
  private func clearAnswered(_ waiting: [String: Set<ThreadRef>]) async {
    guard !waiting.isEmpty else { return }
    let delivered = await center.deliveredNotifications()
    let stale = delivered.compactMap { notification -> String? in
      guard let alert = AgentAlert(userInfo: notification.request.content.userInfo),
        let live = waiting[alert.thread.environmentId], AlertClearing.isStale(alert, waiting: live)
      else { return nil }
      return notification.request.identifier
    }
    if !stale.isEmpty { center.removeDeliveredNotifications(withIdentifiers: stale) }
  }

  #if DEBUG
    func debugSet(permission: Permission, device: PushDevice?, preference: PushPreference) {
      self.permission = permission
      self.device = device
      deviceStatus = device == nil ? .unavailable : .ready
      self.preference = preference
    }
  #endif
}
