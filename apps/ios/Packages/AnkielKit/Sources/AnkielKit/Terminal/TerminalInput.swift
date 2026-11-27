import Foundation

/// A modifier the accessory bar holds for the next key (RN `PendingModifier`).
public enum TerminalModifier: String, Sendable, Hashable {
  case ctrl
  /// Alt on Linux and Windows, Command on a Mac host: sends ESC before the key.
  case meta
}

/// The computer's OS, for its paste chord and the accessory bar's modifier keys.
public enum TerminalHostPlatform: Sendable, Hashable {
  case mac, linux, windows, unknown

  /// From `config.environment.platform.os`.
  public init(os: String?) {
    switch os {
    case "darwin": self = .mac
    case "linux": self = .linux
    case "windows", "win32": self = .windows
    default: self = .unknown
    }
  }
}

/// Keys and their bytes (RN `terminalInput.ts`, the native module's hardware key encoder).
public enum TerminalInput {
  /// Longest `data` one `terminal.write` carries, in UTF-16 code units (`TERMINAL_WRITE_MAX_LENGTH`).
  public static let maxWriteLength = 65_536

  /// Enter is carriage return: line feed is Ctrl+J, which raw-mode programs read as a key.
  public static let enter = "\r"
  public static let escape = "\u{1B}"
  public static let tab = "\t"
  public static let backTab = "\u{1B}[Z"
  public static let backspace = "\u{7F}"
  public static let up = "\u{1B}[A"
  public static let down = "\u{1B}[B"
  public static let right = "\u{1B}[C"
  public static let left = "\u{1B}[D"

  /// What a key with a held modifier does.
  public enum Resolved: Sendable, Hashable {
    case write(String)
    /// The host's paste chord: paste the phone's clipboard instead.
    case paste
  }

  /// RN `resolveModifiedTerminalInput`.
  public static func resolve(_ data: String, modifier: TerminalModifier, host: TerminalHostPlatform) -> Resolved {
    let pasteModifier: TerminalModifier = host == .mac ? .meta : .ctrl
    if modifier == pasteModifier, data.lowercased() == "v" { return .paste }
    let scalars = Array(data.unicodeScalars)
    if scalars.count == 3, data.hasPrefix("\u{1B}["), "ABCD".unicodeScalars.contains(scalars[2]) {
      return .write("\u{1B}[1;\(modifier == .ctrl ? 5 : 3)\(Character(scalars[2]))")
    }
    return .write(modifier == .ctrl ? control(data) : escape + data)
  }

  /// Ctrl applied to the first character, or the input unchanged when Ctrl has no meaning for it.
  static func control(_ input: String) -> String {
    guard let first = input.unicodeScalars.first else { return input }
    return controlByte(Character(first)).map { String($0) } ?? input
  }

  static func controlByte(_ character: Character) -> Character? {
    let lower = character.lowercased()
    guard let scalar = lower.unicodeScalars.first, lower.unicodeScalars.count == 1 else { return nil }
    switch scalar {
    case "a"..."z": return Character(Unicode.Scalar(scalar.value - 96)!)
    case " ", "@": return "\u{00}"
    case "[": return "\u{1B}"
    case "\\": return "\u{1C}"
    case "]": return "\u{1D}"
    case "^": return "\u{1E}"
    case "_", "-": return "\u{1F}"
    case "?": return "\u{7F}"
    default: return nil
    }
  }

  /// A hardware key command's bytes: escape, arrows, tab and Ctrl chords (`TerminalHardwareKeyEncoder`).
  public static func hardwareKey(input: String, control: Bool, shift: Bool, option: Bool) -> String? {
    switch input {
    case "UIKeyInputEscape": return escape
    case "UIKeyInputUpArrow": return option ? "\u{1B}[1;3A" : up
    case "UIKeyInputDownArrow": return option ? "\u{1B}[1;3B" : down
    case "UIKeyInputRightArrow": return option ? "\u{1B}[1;3C" : right
    case "UIKeyInputLeftArrow": return option ? "\u{1B}[1;3D" : left
    case "\t": return shift ? backTab : tab
    default: break
    }
    guard control, let first = input.first else { return nil }
    return controlByte(first).map { String($0) }
  }

  /// A system paste with no bracketed-paste support: unsafe controls become spaces and newlines
  /// carriage returns (RN `encodeTerminalPaste`). Ghostty's own paste path is preferred.
  public static func plainPaste(_ text: String) -> String {
    var out = String.UnicodeScalarView()
    var scalars = text.unicodeScalars.makeIterator()
    var pending = scalars.next()
    while let scalar = pending {
      pending = scalars.next()
      switch scalar.value {
      case 0x0D where pending?.value == 0x0A:
        out.append("\r")
        pending = scalars.next()
      case 0x0A: out.append("\r")
      case 0x00...0x08, 0x0B, 0x0C, 0x0E...0x1F, 0x7F: out.append(" ")
      default: out.append(scalar)
      }
    }
    return String(out)
  }

  /// Splits input into writes of at most `limit` UTF-16 units, never inside a surrogate pair.
  public static func chunks(_ data: String, limit: Int = maxWriteLength) -> [String] {
    let units = Array(data.utf16)
    var chunks: [String] = []
    var start = 0
    while start < units.count {
      var end = min(start + limit, units.count)
      if end < units.count, UTF16.isLeadSurrogate(units[end - 1]), end - 1 > start { end -= 1 }
      chunks.append(String(decoding: units[start..<end], as: UTF16.self))
      start = end
    }
    return chunks
  }

  /// Keystrokes from a software keyboard field that rewrites what it sent (Korean composes a
  /// syllable by replacing the character before the cursor): DELs for what changed, then the new
  /// suffix. Scalars, not Characters, so a combining mark never resends its base.
  public static func fieldEdit(sent: String, field: String) -> String {
    let common = zip(field.unicodeScalars, sent.unicodeScalars).prefix { $0.0 == $0.1 }.count
    let removed = sent.unicodeScalars.count - common
    var added = String(String.UnicodeScalarView(field.unicodeScalars.dropFirst(common)))
    if added == "\n" || added == "\r\n" { added = enter }
    return String(repeating: backspace, count: removed) + added
  }
}
