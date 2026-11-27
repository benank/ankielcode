import Foundation

/// Sorting and fractional order keys, ported from `state/threadSort.ts` and `shared/pinOrderKey.ts`.
public enum ThreadOrder {
  /// Settled: newest settle first, then plain id order (as the server pages ties).
  static func sortSettled(_ threads: [ThreadFacts]) -> [ThreadFacts] {
    threads.sorted { left, right in
      let l = left.settledSortAt ?? .distantPast
      let r = right.settledSortAt ?? .distantPast
      if l != r { return l > r }
      return left.thread.id < right.thread.id
    }
  }

  /// Pinned: keyed rows by key, then keyless newest first.
  static func sortPinned(_ threads: [ThreadFacts]) -> [ThreadFacts] {
    func tiebreak(_ l: ThreadFacts, _ r: ThreadFacts) -> Bool {
      l.thread.id != r.thread.id ? l.thread.id < r.thread.id : l.ref.environmentId < r.ref.environmentId
    }
    let keyed = threads.filter { $0.thread.pinOrderKey != nil }.sorted { l, r in
      let lk = l.thread.pinOrderKey!, rk = r.thread.pinOrderKey!
      return lk != rk ? lk < rk : tiebreak(l, r)
    }
    let keyless = threads.filter { $0.thread.pinOrderKey == nil }.sorted { l, r in
      l.createdAt != r.createdAt ? l.createdAt > r.createdAt : tiebreak(l, r)
    }
    return keyed + keyless
  }

  /// `getThreadSortTimestamp(…, "updated_at")`: what the user last wrote, else creation.
  static func userActivityAt(_ facts: ThreadFacts) -> Date {
    let thread = facts.thread
    return thread.latestUserAuthoredMessageAt?.date ?? thread.createdAt.date ?? thread.updatedAt.date ?? .distantPast
  }

  // MARK: Order keys

  static let digits = Array("abcdefghijklmnopqrstuvwxyz")
  static let leadingTier = "0"

  static func isValidKey(_ key: String) -> Bool {
    var key = Substring(key)
    if key.hasPrefix(leadingTier) { key = key.dropFirst(leadingTier.count) }
    guard !key.isEmpty, key.allSatisfy({ digits.contains($0) }) else { return false }
    return key.last != digits[0]
  }

  static func midpoint(_ a: String, _ b: String) -> String {
    let a = Array(a), b = Array(b)
    if !b.isEmpty {
      var n = 0
      while (n < a.count ? a[n] : digits[0]) == (n < b.count ? b[n] : nil) { n += 1 }
      if n > 0 { return String(b[..<n]) + midpoint(String(a.dropFirst(n)), String(b.dropFirst(n))) }
    }
    let digitA = a.isEmpty ? 0 : digits.firstIndex(of: a[0])!
    let digitB = b.isEmpty ? digits.count : digits.firstIndex(of: b[0])!
    if digitB - digitA > 1 { return String(digits[Int((Double(digitA + digitB) / 2).rounded())]) }
    if b.count > 1 { return String(b[0]) }
    return String(digits[digitA]) + midpoint(String(a.dropFirst()), "")
  }

  /// A key strictly between two neighbors; nil when a neighbor is corrupt or out of order.
  public static func keyBetween(_ before: String?, _ after: String?) -> String? {
    let a = before ?? "", b = after ?? ""
    if !a.isEmpty, !isValidKey(a) { return nil }
    if !b.isEmpty, !isValidKey(b) { return nil }
    if !b.isEmpty, a >= b { return nil }
    if b.hasPrefix(leadingTier) {
      return leadingTier + midpoint(String(a.dropFirst(leadingTier.count)), String(b.dropFirst(leadingTier.count)))
    }
    if a.hasPrefix(leadingTier) { return leadingTier + midpoint(String(a.dropFirst(leadingTier.count)), "") }
    return midpoint(a, b)
  }

  /// The key for a newly pinned thread: above every pinned thread.
  public static func topOfPinned(_ keys: some Sequence<String?>) -> String? {
    keyBetween(nil, keys.compactMap(\.self).min())
  }
}

/// Subagent and side-chat rows nest under their listed ancestor (`buildThreadNavigationTree`).
struct ThreadTree: Sendable {
  struct Child: Sendable {
    var facts: ThreadFacts
    var parentKey: String
    var depth: Int
  }

  var rowsByRoot: [String: [Child]] = [:]
  var rootByChild: [String: String] = [:]

  init(_ threads: [ThreadFacts]) {
    var byKey: [String: ThreadFacts] = [:]
    for facts in threads where facts.thread.archivedAt == nil { byKey[facts.key] = facts }
    var children: [String: [ThreadFacts]] = [:]
    var roots: [String] = []
    for (key, facts) in byKey {
      let lineage = facts.thread.lineage
      let parentKey =
        lineage.isListed ? nil : lineage.parentThreadId.map { "\(facts.ref.environmentId):\($0)" }
      if let parentKey, byKey[parentKey] != nil {
        children[parentKey, default: []].append(facts)
      } else if lineage.isListed {
        roots.append(key)
      }
    }
    for root in roots where children[root] != nil {
      var rows: [Child] = []
      func visit(_ parent: String, _ depth: Int) {
        let sorted = (children[parent] ?? []).sorted { l, r in
          l.thread.createdAt.rawValue != r.thread.createdAt.rawValue
            ? l.thread.createdAt.rawValue < r.thread.createdAt.rawValue : l.key < r.key
        }
        for child in sorted {
          rootByChild[child.key] = root
          rows.append(Child(facts: child, parentKey: parent, depth: depth))
          visit(child.key, min(depth + 1, 4))
        }
      }
      visit(root, 1)
      rowsByRoot[root] = rows
    }
  }
}
