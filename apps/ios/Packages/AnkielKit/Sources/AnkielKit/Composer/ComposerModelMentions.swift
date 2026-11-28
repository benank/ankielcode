import Foundation

/// Models in the `@` list (`client-runtime/composerModelMentions.ts` and `modelSearch.ts`). Picking
/// one writes `model:<instance>/<slug>` into the prompt, which the agent reads as a model to use.
public enum ComposerModelMentions {
  static let limit = 8

  /// The models matching an `@` query, best first; a bare `@` (or one letter) matches none.
  public static func items(_ groups: [ProviderGroup], providers: [ServerProvider], query: String) -> [ComposerMenuItem] {
    // RN offers only providers that are ready; the picker keeps unusable saved picks, this list does not.
    let ready = Set(providers.filter { $0.isSelectable && ($0.state == nil || $0.state == "ready") }.map(\.instanceId))
    let candidates = groups.flatMap(\.models).filter { ready.contains($0.instanceId) && !$0.isUnavailable }
    let driver = Dictionary(providers.map { ($0.instanceId, $0.driver) }, uniquingKeysWith: { first, _ in first })
    return rank(candidates, query: query) { option in
      Searchable(
        name: option.model.name, shortName: option.model.shortName, subProvider: option.model.subProvider,
        driverKind: driver[option.instanceId] ?? "", providerDisplayName: option.providerLabel, slug: option.model.slug)
    }.map { option in
      ComposerMenuItem(
        id: "model:\(option.instanceId)/\(option.model.slug)", label: option.model.name,
        detail: option.model.subProvider.map { "\(option.providerLabel) · \($0)" } ?? option.providerLabel,
        action: .model(instanceId: option.instanceId, model: option.model.slug))
    }
  }

  public struct Searchable: Sendable {
    public var name: String
    public var shortName: String?
    public var subProvider: String?
    public var driverKind: String
    public var providerDisplayName: String
    public var slug: String?
    public var isFavorite = false
  }

  /// `rankComposerModelMentions`: every word must start a word of the model's names, then the
  /// picker's ranking orders them.
  public static func rank<T>(_ candidates: [T], query: String, _ searchable: (T) -> Searchable) -> [T] {
    for words in searchQueries(query) {
      let tokens = words.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
      let literal = candidates.filter { candidate in
        let model = searchable(candidate)
        let haystack = [model.name, model.shortName ?? "", model.subProvider ?? "", model.driverKind, model.providerDisplayName]
          .joined(separator: " ").lowercased()
        return tokens.allSatisfy { startsAWord($0, in: haystack) }
      }
      let ranked = literal.enumerated()
        .compactMap { order, item in score(searchable(item), query: words).map { (item, $0, order) } }
        .sorted { $0.1 != $1.1 ? $0.1 < $1.1 : $0.2 < $1.2 }
        .map(\.0)
      if !ranked.isEmpty { return Array(ranked.prefix(limit)) }
    }
    return []
  }

  /// Mentions can't contain spaces, so `:`, `/` and `-` split words, as in `@gpt:traex`.
  static func searchQueries(_ query: String) -> [String] {
    func collapse(_ text: String, _ pattern: String) -> String {
      text.replacingOccurrences(of: pattern, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    }
    let spaced = collapse(query, "[:/]+")
    let unhyphenated = collapse(spaced, "-+")
    // One letter would fill the menu with models and push files out of it.
    if unhyphenated.filter({ !$0.isWhitespace }).count < 2 { return [] }
    return unhyphenated == spaced ? [spaced] : [spaced, unhyphenated]
  }

  static func startsAWord(_ token: String, in haystack: String) -> Bool {
    var search = haystack.startIndex..<haystack.endIndex
    while let found = haystack.range(of: token, range: search) {
      if found.lowerBound == haystack.startIndex { return true }
      let before = haystack[haystack.index(before: found.lowerBound)]
      if !(before.isLetter || before.isNumber) { return true }
      search = haystack.index(after: found.lowerBound)..<haystack.endIndex
    }
    return false
  }

  /// `scoreModelPickerSearch`: lower is better; nil is no match.
  public static func score(_ model: Searchable, query: String) -> Int? {
    func normalize(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    let tokens = normalize(query).split(whereSeparator: \.isWhitespace).map(String.init)
    if tokens.isEmpty { return 0 }
    let joined = tokens.joined(separator: " ")
    func collapsed(_ text: String) -> String { normalize(text).replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression) }
    if joined == collapsed(model.name) || joined == collapsed(model.shortName ?? "") { return -1000 }
    let searchText = normalize(
      [model.name, model.shortName, model.subProvider, model.driverKind, model.providerDisplayName].compactMap { $0 }
        .filter { !$0.isEmpty }.joined(separator: " "))
    var fields = [normalize(model.name)]
    if let shortName = model.shortName { fields.append(normalize(shortName)) }
    if let subProvider = model.subProvider { fields.append(normalize(subProvider)) }
    fields += [normalize(model.driverKind), normalize(model.providerDisplayName), searchText]
    if let slug = model.slug { fields.append(normalize(slug)) }
    var total = 0
    for token in tokens {
      let scores = fields.enumerated().compactMap { index, field in
        let base = index * 10
        return SearchRanking.score(
          field, token, exact: base, prefix: base + 2, boundary: base + 4, includes: base + 6, fuzzy: token.count >= 3 ? base + 100 : nil,
          ignorePosition: true)
      }
      guard let best = scores.min() else { return nil }
      total += best
    }
    return model.isFavorite ? total - 24 : total
  }

  /// A `model:<instance>/<slug>` reference in text (`collectComposerModelMentions`), UTF-16 offsets.
  public struct Occurrence: Sendable, Hashable {
    public var instanceId: String
    public var model: String
    public var source: String
    public var start: Int
    public var end: Int
  }

  public static func collect(_ text: String) -> [Occurrence] {
    guard text.contains("model:") else { return [] }
    let ns = text as NSString
    var result: [Occurrence] = []
    for match in pattern.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
      let instanceId = ns.substring(with: match.range(at: 1))
      let model = trimSlug(ns.substring(with: match.range(at: 2)))
      guard !model.isEmpty else { continue }
      let start = match.range.location
      let end = start + 6 + (instanceId as NSString).length + 1 + (model as NSString).length
      result.append(Occurrence(instanceId: instanceId, model: model, source: ns.substring(with: NSRange(location: start, length: end - start)), start: start, end: end))
    }
    return result
  }

  private static let pattern = try! NSRegularExpression(pattern: #"(?<![^\s,(\["'])model:([a-zA-Z][a-zA-Z0-9_-]*)/([^\s,"']+)"#)

  /// Slugs like `foo(bar)` keep balanced brackets; prose wrapping them and sentence punctuation do not.
  static func trimSlug(_ slug: String) -> String {
    let original = Array(slug)
    var characters = original
    var unmatched: [Character: Int] = [:]
    let closing: [Character: Character] = [")": "(", "]": "["]
    while let last = characters.last {
      if ".;:!?".contains(last) {
        characters.removeLast()
        continue
      }
      guard let opening = closing[last] else { break }
      let excess = unmatched[last] ?? (original.filter { $0 == last }.count - original.filter { $0 == opening }.count)
      if excess <= 0 { break }
      unmatched[last] = excess - 1
      characters.removeLast()
    }
    return String(characters)
  }
}
