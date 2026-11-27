import Foundation

/// GitHub-style search syntax for the pull request list (client-runtime `pullRequestQuery.ts`):
/// `label:bug`, `-label:wip`, `label:"a b",c`, `author:me`, `draft:true`, `review:approved`,
/// `checks:failing` (or `status:`), and other `name:value` qualifiers read as scoped labels.
/// GitHub's own scope qualifiers (`is:`, `repo:`, `sort:`…) are dropped, since the list sets
/// those itself. Whatever is left is the text query.
public enum PullRequestQuery {
  public struct Parsed: Sendable, Hashable {
    public var text: String
    public var filters: PullRequestListFilters
  }

  static let maxValues = 10
  static let maxLength = 200

  static func tokens(_ raw: String) -> [Substring] {
    raw.matches(of: /(?:[^\s"]|"[^"]*")+/).map { raw[$0.range] }
  }

  static func value(_ raw: Substring) -> String {
    raw.replacingOccurrences(of: "\"", with: "").trimmingCharacters(in: .whitespaces)
  }

  static func list(_ raw: Substring) -> [String] {
    raw.matches(of: /(?:[^,"]|"[^"]*")+/).map { value(raw[$0.range]) }.filter { !$0.isEmpty }
  }

  static func bounded(_ names: [String]) -> [String] {
    names.prefix(maxValues).map { String($0.prefix(maxLength)).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
  }

  /// `me` and `@me` both name the viewer; logins are case-insensitive.
  static func authorKey(_ login: String) -> String {
    let lower = login.lowercased()
    return lower == "@me" ? "me" : lower
  }

  public static func parse(_ raw: String) -> Parsed {
    var text: [Substring] = []
    var labels: [[String]] = []
    var excluded: [String] = []
    // `.some(nil)` once two different logins are named: GitHub ORs them, the contract carries one.
    var author: String??
    var draft: PullRequestListFilters.Draft?
    var review: PullRequestListFilters.Review?
    var checks: PullRequestListFilters.Checks?
    for token in tokens(raw) {
      guard let match = token.wholeMatch(of: /(-?)([A-Za-z][A-Za-z0-9_-]*):(.*)/) else {
        text.append(token)
        continue
      }
      let negated = match.1 == "-"
      let name = match.2.lowercased()
      let rawValue = match.3
      let value = value(rawValue)
      if value.isEmpty {
        text.append(token)
        continue
      }
      switch name {
      case "label":
        let names = bounded(list(rawValue))
        if names.isEmpty { break }
        if negated { excluded += names } else { labels.append(names) }
        continue
      case "author":
        if negated { break }
        let login = String(value.prefix(maxLength)).trimmingCharacters(in: .whitespaces)
        switch author {
        case nil: author = .some(login)
        case .some(let held?) where authorKey(held) == authorKey(login): break
        default: author = .some(nil)
        }
        continue
      case "draft":
        let lower = value.lowercased()
        guard lower == "true" || lower == "false" else { break }
        draft = (lower == "true") != negated ? .only : .hide
        continue
      case "review":
        let decision: PullRequestListFilters.Review? =
          switch value.lowercased() {
          case "approved": .approved
          case "changes_requested", "changes-requested": .changesRequested
          case "required", "review-required": .reviewRequired
          case "none": PullRequestListFilters.Review.none
          default: nil
          }
        guard !negated, let decision else { break }
        review = decision
        continue
      case "status", "checks":
        let state: PullRequestListFilters.Checks? =
          switch value.lowercased() {
          case "success", "passing": .passing
          case "failure", "failing": .failing
          default: nil
          }
        guard !negated, let state else { break }
        checks = state
        continue
      case "is", "archived", "state", "repo", "org", "user", "sort":
        continue
      default:
        if !value.hasPrefix("/") {
          let names = bounded(list(rawValue).map { $0.contains(":") ? $0 : "\(match.2):\($0)" })
          if names.isEmpty { break }
          if negated { excluded += names } else { labels.append(names) }
          continue
        }
      }
      text.append(token)
    }
    let joined = text.joined(separator: " ")
    return Parsed(
      text: String(joined.prefix(maxLength)).trimmingCharacters(in: .whitespaces),
      filters: PullRequestListFilters(
        draft: draft, review: review, checks: checks,
        labels: labels.isEmpty ? nil : Array(labels.prefix(maxValues)),
        excludedLabels: excluded.isEmpty ? nil : Array(excluded.prefix(maxValues)),
        author: author.flatMap(\.self)))
  }

  /// The Draft menu shows a typed `draft:` qualifier, so picking another value takes the
  /// qualifier out of the query (left in, it would outrank the menu).
  public static func applyDraftChange(
    query: String, menu: PullRequestListFilters, next: PullRequestListFilters
  ) -> (query: String, filters: PullRequestListFilters) {
    let typed = parse(query).filters.draft
    if next.draft == (typed ?? menu.draft) {
      var kept = next
      kept.draft = menu.draft
      return (query, kept)
    }
    guard typed != nil else { return (query, next) }
    let stripped = tokens(query).filter { parse(String($0)).filters.draft == nil }.joined(separator: " ")
    return (stripped, next)
  }

  /// `author:me` names whoever is signed in to the host (`resolvePullRequestAuthorFilter`).
  public static func resolveAuthor(_ author: String, viewer: String?) -> String {
    let trimmed = author.trimmingCharacters(in: .whitespaces)
    guard trimmed.lowercased() == "me" || trimmed.lowercased() == "@me" else { return trimmed }
    guard let viewer, !viewer.trimmingCharacters(in: .whitespaces).isEmpty else { return trimmed }
    return viewer
  }
}
