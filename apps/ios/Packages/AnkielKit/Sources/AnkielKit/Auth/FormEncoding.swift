import Foundation

/// `application/x-www-form-urlencoded`, strict: everything but unreserved characters is escaped,
/// so `+`, `&` and `'` in labels survive (URLComponents leaves `+` alone).
enum FormEncoding {
  private static let unreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

  static func encode(_ fields: [(String, String)]) -> String {
    fields.map { "\(escape($0.0))=\(escape($0.1))" }.joined(separator: "&")
  }

  static func escape(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
  }

  /// Parses `a=1&b=two+words` like `URLSearchParams` (`+` is a space).
  static func decode(_ text: String) -> [(String, String)] {
    text.split(separator: "&", omittingEmptySubsequences: true).map { pair in
      let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      func unescape(_ part: Substring?) -> String {
        guard let part else { return "" }
        let spaced = part.replacing("+", with: " ")
        return spaced.removingPercentEncoding ?? String(spaced)
      }
      return (unescape(parts.first), unescape(parts.count > 1 ? parts[1] : nil))
    }
  }
}
