import Foundation

/// Links that name a thread.
///
/// - App links: `ankielcode[-channel]://thread/<environmentId>/<threadId>` and the RN app's route
///   `…://threads/<environmentId>/<threadId>` (`Stack.tsx` `threads/:environmentId/:threadId`).
/// - Thread references: `ankiel-thread://v2/<environmentId>/<threadId>` (`shared/threadLinks.ts`).
///   v1 links name no environment and are not opened.
public enum ThreadLink {
  public static func parse(_ url: URL) -> ThreadRef? {
    guard let scheme = url.scheme?.lowercased() else { return nil }
    let raw = url.absoluteString
    guard let separator = raw.range(of: "://") else { return nil }
    var path = String(raw[separator.upperBound...])
    if let query = path.firstIndex(where: { $0 == "?" || $0 == "#" }) { path = String(path[..<query]) }
    let parts = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    let ids: ArraySlice<String>
    if scheme == "ankiel-thread" {
      guard parts.first == "v2" else { return nil }
      ids = parts.dropFirst()
    } else if scheme.wholeMatch(of: /ankielcode(?:-[a-z]+)?/) != nil, let route = parts.first,
      route == "thread" || route == "threads"
    {
      ids = parts.dropFirst()
    } else {
      return nil
    }
    guard ids.count == 2, let environmentId = ids.first?.removingPercentEncoding,
      let threadId = ids.last?.removingPercentEncoding, !environmentId.isEmpty, !threadId.isEmpty
    else { return nil }
    return ThreadRef(environmentId: environmentId, threadId: threadId)
  }

  /// `formatThreadLink` without a label: an autolink that pastes into a composer as a thread chip.
  public static func reference(_ ref: ThreadRef) -> String {
    "<ankiel-thread://v2/\(ref.environmentId)/\(ref.threadId)>"
  }

  /// The app link that opens the thread in this app.
  public static func appURL(_ ref: ThreadRef, scheme: String = "ankielcode-native") -> URL? {
    let allowed = CharacterSet.urlPathAllowed.subtracting(["/"])
    guard let environment = ref.environmentId.addingPercentEncoding(withAllowedCharacters: allowed),
      let thread = ref.threadId.addingPercentEncoding(withAllowedCharacters: allowed)
    else { return nil }
    return URL(string: "\(scheme)://thread/\(environment)/\(thread)")
  }
}
