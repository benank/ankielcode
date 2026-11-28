import Foundation

/// The parts of `ServerSettings` (`packages/contracts/src/settings.ts`) this client reads. Every
/// field decodes loosely with the server's decoding default, so a settings event never fails.
public struct ServerSettings: Sendable, Hashable, Decodable {
  public var defaultModelSelection: ModelSelection?
  public var fallbackModelSelection: ModelSelection?
  public var defaultRuntimeMode: RuntimeMode?
  /// Hidden models per instance (`providerModelPreferences[instanceId].hiddenModels`).
  public var hiddenModels: [String: Set<String>]
  public var modelOrder: [String: [String]]
  /// `sidebarAutoSettleOnMerge` (default on).
  public var autoSettleOnMerge = true
  /// `sidebarAutoSettleAfterDays`: nil turns inactivity settling off (the server default is 7).
  public var autoSettleAfterDays: Int? = ServerSettings.defaultAutoSettleDays
  public var autoResumeLimitedThreads = false
  public var snoozeLimitedThreads = false
  public var snoozePresets: [SnoozePresetSetting] = SnoozePresetSetting.defaults
  /// `responseStreamingMode`: how the computer streams replies (server default `paragraph`).
  public var responseStreaming: ResponseStreamingMode = .paragraph
  /// `enablePreviewTunnel` (default on): whether device previews may reach the computer's localhost.
  public var enablePreviewTunnel = true
  /// `defaultThreadEnvMode`: where new threads work by default (nil inherits, then the checkout).
  public var defaultThreadEnvMode: ProjectShell.ThreadEnvMode?
  /// `newWorktreesStartFromOrigin` (default on): new worktrees start from the remote branch.
  public var newWorktreesStartFromOrigin = true

  public static let defaultAutoSettleDays = 7
  /// `MIN_`/`MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS`; the server refuses a patch outside them.
  public static let autoSettleDays: ClosedRange<Int> = 1...90

  public init() {
    hiddenModels = [:]
    modelOrder = [:]
  }

  enum CodingKeys: String, CodingKey {
    case defaultModelSelection, fallbackModelSelection, defaultRuntimeMode, providerModelPreferences
    case sidebarAutoSettleOnMerge, sidebarAutoSettleAfterDays, autoResumeLimitedThreads, snoozeLimitedThreads, snoozePresets
    case responseStreamingMode
    case enablePreviewTunnel
    case defaultThreadEnvMode, newWorktreesStartFromOrigin
  }

  struct Preferences: Decodable {
    var hiddenModels: [String]?
    var modelOrder: [String]?
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    defaultModelSelection = c.loose(ModelSelection.self, .defaultModelSelection)
    fallbackModelSelection = c.loose(ModelSelection.self, .fallbackModelSelection)
    defaultRuntimeMode = c.loose(String.self, .defaultRuntimeMode).flatMap(RuntimeMode.init(rawValue:))
    let preferences = c.loose([String: Preferences].self, .providerModelPreferences) ?? [:]
    hiddenModels = preferences.mapValues { Set($0.hiddenModels ?? []) }
    modelOrder = preferences.compactMapValues(\.modelOrder)
    autoSettleOnMerge = c.loose(Bool.self, .sidebarAutoSettleOnMerge) ?? true
    // Absent is the server default; an explicit null is "off".
    if c.contains(.sidebarAutoSettleAfterDays), (try? c.decodeNil(forKey: .sidebarAutoSettleAfterDays)) == true {
      autoSettleAfterDays = nil
    } else {
      autoSettleAfterDays = c.loose(Double.self, .sidebarAutoSettleAfterDays).map { Int($0) } ?? Self.defaultAutoSettleDays
    }
    autoResumeLimitedThreads = c.loose(Bool.self, .autoResumeLimitedThreads) ?? false
    responseStreaming = c.loose(String.self, .responseStreamingMode).flatMap(ResponseStreamingMode.init(rawValue:)) ?? .paragraph
    snoozeLimitedThreads = c.loose(Bool.self, .snoozeLimitedThreads) ?? false
    enablePreviewTunnel = c.loose(Bool.self, .enablePreviewTunnel) ?? true
    defaultThreadEnvMode = c.loose(String.self, .defaultThreadEnvMode).flatMap(ProjectShell.ThreadEnvMode.init(rawValue:))
    newWorktreesStartFromOrigin = c.loose(Bool.self, .newWorktreesStartFromOrigin) ?? true
    let presets = c.loose(LossyArray<WirePreset>.self, .snoozePresets)?.elements.compactMap(\.setting)
    snoozePresets = presets.map { $0.isEmpty ? SnoozePresetSetting.defaults : $0 } ?? SnoozePresetSetting.defaults
  }

  /// `SnoozePresetSetting` on the wire: `{kind:"after",minutes}` or `{kind:"at",day,time:"HH:MM"}`.
  struct WirePreset: Decodable {
    var kind: String
    var minutes: Int?
    var day: String?
    var time: String?

    var setting: SnoozePresetSetting? {
      switch kind {
      case "after": return minutes.map { .after(minutes: $0) }
      case "at":
        guard let day = day.flatMap(SnoozePresetSetting.Day.init(rawValue:)), let time else { return nil }
        let parts = time.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2, (0...23).contains(parts[0]), (0...59).contains(parts[1]) else { return nil }
        return .at(day: day, hour: parts[0], minute: parts[1])
      default: return nil
      }
    }
  }

  /// These settings with a pending patch applied, for optimistic UI. Keys this client does not
  /// read are left to the server's answer.
  public func applying(_ patch: ServerSettingsPatch) -> ServerSettings {
    var next = self
    for (key, value) in patch.fields {
      switch key {
      case "sidebarAutoSettleOnMerge": if let value = value.boolValue { next.autoSettleOnMerge = value }
      case "sidebarAutoSettleAfterDays": next.autoSettleAfterDays = value.intValue
      case "autoResumeLimitedThreads": if let value = value.boolValue { next.autoResumeLimitedThreads = value }
      case "snoozeLimitedThreads": if let value = value.boolValue { next.snoozeLimitedThreads = value }
      case "defaultRuntimeMode": if let mode = value.stringValue.flatMap(RuntimeMode.init(rawValue:)) { next.defaultRuntimeMode = mode }
      case "responseStreamingMode":
        if let mode = value.stringValue.flatMap(ResponseStreamingMode.init(rawValue:)) { next.responseStreaming = mode }
      default: break
      }
    }
    return next
  }
}

/// A `ServerSettingsPatch` (`server.updateSettings {patch}`). Keys hold JSON so an explicit `null`
/// ("turn off") survives encoding, unlike an absent optional. Built only from the typed helpers,
/// each one a key `requiredScopesForServerSettingsPatch` files under `settings:write`.
public struct ServerSettingsPatch: Sendable, Hashable, Encodable {
  public private(set) var fields: [String: JSONValue]

  init(_ fields: [String: JSONValue]) {
    self.fields = fields
  }

  public static func autoSettleOnMerge(_ on: Bool) -> Self { Self(["sidebarAutoSettleOnMerge": .bool(on)]) }

  /// nil turns inactivity settling off.
  public static func autoSettleAfterDays(_ days: Int?) -> Self {
    let range = ServerSettings.autoSettleDays
    return Self(["sidebarAutoSettleAfterDays": days.map { .number(Double(min(max($0, range.lowerBound), range.upperBound))) } ?? .null])
  }

  public static func autoResumeLimitedThreads(_ on: Bool) -> Self { Self(["autoResumeLimitedThreads": .bool(on)]) }
  public static func snoozeLimitedThreads(_ on: Bool) -> Self { Self(["snoozeLimitedThreads": .bool(on)]) }
  public static func defaultRuntimeMode(_ mode: RuntimeMode) -> Self { Self(["defaultRuntimeMode": .string(mode.rawValue)]) }
  public static func responseStreaming(_ mode: ResponseStreamingMode) -> Self { Self(["responseStreamingMode": .string(mode.rawValue)]) }

  /// The auto-settle and usage-limit values of `settings` as one patch, to make other computers
  /// match it (RN "Apply auto-settle defaults").
  public static func autoSettle(matching settings: ServerSettings) -> Self {
    var fields = autoSettleAfterDays(settings.autoSettleAfterDays).fields
    fields["sidebarAutoSettleOnMerge"] = .bool(settings.autoSettleOnMerge)
    return Self(fields)
  }

  public var keys: Set<String> { Set(fields.keys) }

  public func encode(to encoder: any Encoder) throws {
    try fields.encode(to: encoder)
  }
}

/// `server.updateSettings` payload.
public struct UpdateSettingsRequest: Sendable, Encodable {
  public var patch: ServerSettingsPatch

  public init(patch: ServerSettingsPatch) {
    self.patch = patch
  }

  public static let rpcTag = "server.updateSettings"
}

/// `ResponseStreamingMode`: when replies appear while the agent writes.
public enum ResponseStreamingMode: String, Sendable, Hashable, CaseIterable {
  /// The whole answer when the turn ends.
  case turn
  /// Each finished paragraph or code block.
  case paragraph
}
