import Foundation

/// The `/` and `$` lists (RN `buildComposerSlashCommandItems` and the skill branches of
/// `useComposerCommandMenu`).
public enum ComposerSlashMenu {
  /// The name the server gives the usage limits command (`USAGE_LIMITS_COMMAND`).
  public static let usageLimitsCommand = "usage-limits"

  public struct Context: Sendable {
    public var hasThread: Bool
    public var hasCompactableConversation: Bool
    /// The app opens usage limits itself instead of sending `/usage-limits`.
    public var offersUsageLimits: Bool
    /// Ankiel's `/clear` (a fresh session) replaces the provider's.
    public var offersFreshSession: Bool
    public var offersSideChat: Bool

    public init(
      hasThread: Bool, hasCompactableConversation: Bool = false, offersUsageLimits: Bool = false, offersFreshSession: Bool = false,
      offersSideChat: Bool = false
    ) {
      self.hasThread = hasThread
      self.hasCompactableConversation = hasCompactableConversation
      self.offersUsageLimits = offersUsageLimits
      self.offersFreshSession = offersFreshSession
      self.offersSideChat = offersSideChat
    }
  }

  public struct Labels: Sendable {
    public var model = "Switch model"
    public var side = "Ask a side question in a new side chat"
    public var btw = "Same as /side"
    public var clear = "Start a fresh session"
    public init() {}
  }

  /// `/` at the caret: Ankiel's commands, the provider's commands, then its skills.
  public static func slashItems(
    query rawQuery: String, atMessageStart: Bool, context: Context, provider: ServerProvider?, cwd: String?,
    labels: Labels = Labels()
  ) -> [ComposerMenuItem] {
    let query = rawQuery.lowercased()
    var items: [ComposerMenuItem] = []
    if "model".contains(query) || query.isEmpty {
      items.append(ComposerMenuItem(id: "cmd:model", label: "/model", detail: labels.model, action: .command("model")))
    }
    // Providers expand commands only at the start of a message.
    guard atMessageStart else { return items }
    if context.offersSideChat {
      for (command, detail) in [("side", labels.side), ("btw", labels.btw)] where query.isEmpty || command.contains(query) {
        items.append(ComposerMenuItem(id: "cmd:\(command)", label: "/\(command)", detail: detail, action: .command(command)))
      }
    }
    if context.offersFreshSession, query.isEmpty || "clear".contains(query) {
      items.append(ComposerMenuItem(id: "cmd:clear", label: "/clear", detail: labels.clear, action: .command("clear")))
    }
    let skills = visibleSkills(provider?.skills(forCwd: cwd) ?? [])
    let skillNames = Set(skills.map { $0.name.trimmingCharacters(in: .whitespaces).lowercased() })
    for command in provider?.slashCommands(forCwd: cwd) ?? [] {
      let name = command.name
      guard !skillNames.contains(name.trimmingCharacters(in: .whitespaces).lowercased()) else { continue }
      guard query.isEmpty || name.lowercased().contains(query) else { continue }
      if name == "clear", context.offersFreshSession { continue }
      if name == "compact", !context.hasCompactableConversation { continue }
      if name == usageLimitsCommand, context.offersUsageLimits, !context.hasThread { continue }
      if !context.hasThread, provider?.driver == "codex", name == "feedback" { continue }
      items.append(ComposerMenuItem(id: "pcmd:\(name)", label: "/\(name)", detail: command.description ?? "", action: .providerCommand(name)))
    }
    for skill in skills where matchesSlashSkill(skill, query: query) {
      items.append(ComposerMenuItem(
        id: "skill:\(skill.name)", label: "skill:\(skill.name)", detail: skill.shortDescription ?? skill.description ?? "",
        action: .skill(skill.name)))
    }
    return items
  }

  /// `$` at the caret: the provider's skills, best match first (at most 20).
  public static func skillItems(query rawQuery: String, provider: ServerProvider?, cwd: String?) -> [ComposerMenuItem] {
    let skills = visibleSkills(provider?.skills(forCwd: cwd) ?? [])
    var query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    while let first = query.unicodeScalars.first, first.properties.generalCategory == .currencySymbol {
      query = String(query.unicodeScalars.dropFirst())
    }
    query = query.lowercased()
    func item(_ skill: ProviderSkill) -> ComposerMenuItem {
      ComposerMenuItem(
        id: "skill:\(skill.name)", label: skill.displayName ?? skill.name, detail: skill.shortDescription ?? skill.description ?? "",
        action: .skill(skill.name))
    }
    guard !query.isEmpty else { return skills.prefix(20).map(item) }
    var ranked: [(skill: ProviderSkill, score: Int, tie: String)] = []
    for skill in skills {
      let display = (skill.displayName ?? skill.name).lowercased()
      let scores = [
        SearchRanking.score(skill.name.lowercased(), query, exact: 0, prefix: 2, boundary: 4, includes: 6, fuzzy: 100, markers: ["-", "_", "/"]),
        SearchRanking.score(display, query, exact: 1, prefix: 3, boundary: 5, includes: 7, fuzzy: 110),
        SearchRanking.score(skill.shortDescription?.lowercased() ?? "", query, exact: 20, prefix: 22, boundary: 24, includes: 26),
        SearchRanking.score(skill.description?.lowercased() ?? "", query, exact: 30, prefix: 32, boundary: 34, includes: 36),
      ].compactMap { $0 }
      if let best = scores.min() { ranked.append((skill, best, "\(display)\u{0}\(skill.name)")) }
    }
    ranked.sort { $0.score != $1.score ? $0.score < $1.score : $0.tie.localizedCompare($1.tie) == .orderedAscending }
    return ranked.prefix(20).map { item($0.skill) }
  }

  /// RN `getProviderSkillsForSlashMenu`: invocable, one per name.
  static func visibleSkills(_ skills: [ProviderSkill]) -> [ProviderSkill] {
    var seen = Set<String>()
    return skills.filter { skill in
      guard skill.isUserInvocable else { return false }
      return seen.insert(skill.name.trimmingCharacters(in: .whitespaces).lowercased()).inserted
    }
  }

  /// RN `matchesSlashSkillQuery`: `skill` and `skill:` prefixes narrow to skills.
  static func matchesSlashSkill(_ skill: ProviderSkill, query: String) -> Bool {
    guard skill.enabled else { return false }
    let needle = query == "skill" ? "" : (query.hasPrefix("skill:") ? String(query.dropFirst(6)) : query)
    if needle.isEmpty { return true }
    return [skill.name, skill.displayName, skill.shortDescription, skill.description].contains { $0?.lowercased().contains(needle) == true }
  }
}

/// `shared/searchRanking.ts`: lower scores rank first; nil is no match. Inputs are lowercased.
public enum SearchRanking {
  public static func score(
    _ value: String, _ query: String, exact: Int, prefix: Int? = nil, boundary: Int? = nil, includes: Int? = nil, fuzzy: Int? = nil,
    markers: [String] = [" ", "-", "_", "/"]
  ) -> Int? {
    let value = Array(value.utf16)
    let query = Array(query.utf16)
    guard !value.isEmpty, !query.isEmpty else { return nil }
    let penalty = min(64, max(0, value.count - query.count))
    if value == query { return exact }
    if let prefix, value.starts(with: query) { return prefix + penalty }
    if let boundary {
      var best: Int?
      for marker in markers {
        if let index = firstIndex(of: Array(marker.utf16) + query, in: value) {
          let match = index + marker.utf16.count
          best = min(best ?? match, match)
        }
      }
      if let best { return boundary + best * 2 + penalty }
    }
    if let includes, let index = firstIndex(of: query, in: value) { return includes + index * 2 + penalty }
    if let fuzzy, let score = subsequence(value, query) { return fuzzy + score }
    return nil
  }

  static func firstIndex(of needle: [UInt16], in haystack: [UInt16]) -> Int? {
    guard needle.count <= haystack.count else { return nil }
    for start in 0...(haystack.count - needle.count) where haystack[start..<(start + needle.count)].elementsEqual(needle) {
      return start
    }
    return nil
  }

  static func subsequence(_ value: [UInt16], _ query: [UInt16]) -> Int? {
    var queryIndex = 0
    var first = -1
    var previous = -1
    var gaps = 0
    for (index, unit) in value.enumerated() where queryIndex < query.count && unit == query[queryIndex] {
      if first == -1 { first = index }
      if previous != -1 { gaps += index - previous - 1 }
      previous = index
      queryIndex += 1
      if queryIndex == query.count {
        let span = index - first + 1 - query.count
        return first * 2 + gaps * 3 + span + min(64, value.count - query.count)
      }
    }
    return nil
  }
}
