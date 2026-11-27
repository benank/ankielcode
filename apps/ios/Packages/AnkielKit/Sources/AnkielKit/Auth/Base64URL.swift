import Foundation

extension Data {
  /// Base64url without padding (RFC 7515 §2).
  public var base64URLEncoded: String {
    base64EncodedString()
      .replacing("+", with: "-")
      .replacing("/", with: "_")
      .replacing("=", with: "")
  }

  public init?(base64URLEncoded text: String) {
    var base64 = text.replacing("-", with: "+").replacing("_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    self.init(base64Encoded: base64)
  }
}
