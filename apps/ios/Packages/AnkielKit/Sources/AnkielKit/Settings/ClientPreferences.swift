import Foundation
import Observation

/// Light, dark, or follow the system (RN `themeMode`).
public enum ThemeMode: String, Sendable, Codable, CaseIterable {
  case system, light, dark
}

/// What a message sent while the agent works does by default (RN `followUpBehavior`).
public enum FollowUpBehavior: String, Sendable, Codable, CaseIterable {
  case steer, queue
}

/// How projects that share a repository combine in the project filter (`SidebarProjectGroupingMode`).
public enum ProjectGroupingMode: String, Sendable, Codable, CaseIterable {
  case repository
  case repositoryPath = "repository_path"
  case separate
}

/// The phone's own preferences, persisted as one JSON value in `UserDefaults` (settings ownership:
/// client preferences live on the device, environment defaults on their server). Every field
/// decodes on its own, so one unreadable value never resets the rest.
public struct ClientPreferenceValues: Sendable, Hashable, Codable {
  public var themeMode: ThemeMode = .system
  /// Code block and inline code size in points; nil follows Dynamic Type.
  public var codeFontSize: Double?
  /// Wrap long code lines instead of scrolling them sideways.
  public var codeWordBreak = false
  public var followUpBehavior: FollowUpBehavior = .steer
  public var projectGroupingMode: ProjectGroupingMode = .repository

  // Thread list options.
  public var threadListEnvironmentId: String?
  public var threadListProjectKey: String?
  public var snoozedShelfExpanded = false
  public var settledShelfExpanded = false
  public var collapsedProjectGroups: [String] = []

  public init() {}

  enum CodingKeys: String, CodingKey {
    case themeMode, codeFontSize, codeWordBreak, followUpBehavior, projectGroupingMode
    case threadListEnvironmentId, threadListProjectKey, snoozedShelfExpanded, settledShelfExpanded, collapsedProjectGroups
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    themeMode = c.loose(ThemeMode.self, .themeMode) ?? .system
    codeFontSize = c.loose(Double.self, .codeFontSize).map(Self.clampCodeFontSize)
    codeWordBreak = c.loose(Bool.self, .codeWordBreak) ?? false
    followUpBehavior = c.loose(FollowUpBehavior.self, .followUpBehavior) ?? .steer
    projectGroupingMode = c.loose(ProjectGroupingMode.self, .projectGroupingMode) ?? .repository
    threadListEnvironmentId = c.loose(String.self, .threadListEnvironmentId)
    threadListProjectKey = c.loose(String.self, .threadListProjectKey)
    snoozedShelfExpanded = c.loose(Bool.self, .snoozedShelfExpanded) ?? false
    settledShelfExpanded = c.loose(Bool.self, .settledShelfExpanded) ?? false
    collapsedProjectGroups = c.loose([String].self, .collapsedProjectGroups) ?? []
  }

  /// RN `MIN_CODE_FONT_SIZE`…`MAX_CODE_FONT_SIZE`.
  public static let codeFontSizes: ClosedRange<Double> = 8...18
  public static let defaultCodeFontSize: Double = 13

  static func clampCodeFontSize(_ size: Double) -> Double {
    min(max(size.rounded(), codeFontSizes.lowerBound), codeFontSizes.upperBound)
  }
}

/// The one place the app reads and writes device preferences. Setting `values` saves at once.
@MainActor @Observable
public final class ClientPreferences {
  public var values: ClientPreferenceValues {
    didSet { if values != oldValue { save() } }
  }

  @ObservationIgnored private let defaults: UserDefaults

  static let storageKey = "ankiel.preferences.v1"

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    values = Self.load(defaults)
  }

  /// Every preference back to its default (Remove all computers keeps them; nothing calls this but tests).
  public func reset() {
    values = ClientPreferenceValues()
  }

  static func load(_ defaults: UserDefaults) -> ClientPreferenceValues {
    defaults.data(forKey: storageKey).flatMap { try? JSONDecoder().decode(ClientPreferenceValues.self, from: $0) }
      ?? ClientPreferenceValues()
  }

  private func save() {
    guard let data = try? JSONEncoder().encode(values) else { return }
    defaults.set(data, forKey: Self.storageKey)
  }
}
