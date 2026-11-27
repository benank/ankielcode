import Foundation

/// The last output of a terminal, bounded, so a renderer created mid-session (or recreated) can
/// replay it. Trimming the front can cut through a control sequence; the replay skips the rest of
/// that sequence instead of printing it (the contracts' `terminalSequenceStateAfter`, on bytes).
public struct TerminalReplay: Sendable {
  public let limit: Int
  private var storage = Data()
  private var start = 0
  /// The parser state at `start`.
  private var state = TerminalSequence.ground

  public init(limit: Int = terminalHistoryBytes) {
    self.limit = limit
  }

  /// Everything a fresh emulator replays: retained bytes from the first point outside a sequence.
  public var data: Data {
    let retained = storage[(storage.startIndex + start)...]
    var index = TerminalSequence.end(state, retained)
    while index < retained.endIndex, retained[index] & 0xC0 == 0x80 { index += 1 }
    return Data(retained[index...])
  }

  public var text: String { String(decoding: data, as: UTF8.self) }

  public var byteCount: Int { storage.count - start }

  /// Replaces the history (a snapshot, a restart).
  public mutating func reset(_ history: String) {
    storage = Data()
    start = 0
    state = TerminalSequence.ground
    append(Data(history.utf8))
  }

  public mutating func append(_ text: String) { append(Data(text.utf8)) }

  public mutating func append(_ bytes: Data) {
    storage.append(bytes)
    let excess = storage.count - start - limit
    guard excess > 0 else { return }
    var cut = start + excess
    while cut < storage.count, storage[storage.startIndex + cut] & 0xC0 == 0x80 { cut += 1 }
    state = TerminalSequence.state(after: storage[(storage.startIndex + start)..<(storage.startIndex + cut)], from: state)
    start = cut
    // Compact once per window instead of copying on every append.
    if start >= limit {
      storage = Data(storage[(storage.startIndex + start)...])
      start = 0
    }
  }
}

/// libghostty-vt's parser states, merged where the same input takes them back to ground
/// (`packages/contracts/src/terminal.ts`), stepped one UTF-8 byte at a time.
enum TerminalSequence {
  static let ground = 0
  static let escape = 1
  static let escapeIntermediate = 2
  static let csi = 3
  static let dcs = 4
  static let sosPmApc = 5
  static let osc = 6

  static func next(_ state: Int, _ byte: UInt8) -> Int {
    if byte == 0x1B { return escape }
    if state == ground || byte == 0x18 || byte == 0x1A { return ground }
    if byte < 0x80 {
      switch state {
      case escape:
        if byte < 0x20 || byte == 0x7F { return state }
        if byte < 0x30 { return escapeIntermediate }
        switch byte {
        case 0x5B: return csi
        case 0x5D: return osc
        case 0x50: return dcs
        case 0x58, 0x5E, 0x5F: return sosPmApc
        default: return ground
        }
      case escapeIntermediate: return byte >= 0x30 && byte != 0x7F ? ground : state
      case csi: return byte >= 0x40 && byte != 0x7F ? ground : state
      case osc: return byte == 0x07 ? ground : state
      default: return state
      }
    }
    // Outside ground and OSC the parser reads UTF-8 bytes one at a time, so a continuation byte
    // in 0x80-0x9F acts as a C1 control: most end the sequence, five start another.
    if state == osc || byte >= 0xA0 { return state }
    switch byte {
    case 0x9D: return osc
    case 0x90: return dcs
    case 0x9B: return csi
    case 0x98, 0x9E, 0x9F: return sosPmApc
    default: return ground
    }
  }

  static func state(after bytes: Data.SubSequence, from state: Int) -> Int {
    var state = state
    // ESC enters the escape state from every state, so only what follows the last one matters.
    var slice = bytes
    if let escapeIndex = bytes.lastIndex(of: 0x1B) {
      state = escape
      slice = bytes[(escapeIndex + 1)...]
    }
    for byte in slice where state != ground { state = next(state, byte) }
    return state
  }

  /// The index in `bytes` where a parser that entered it in `state` is back in ground.
  static func end(_ state: Int, _ bytes: Data.SubSequence) -> Data.Index {
    var state = state
    var index = bytes.startIndex
    while state != ground, index < bytes.endIndex {
      state = next(state, bytes[index])
      index += 1
    }
    return index
  }
}
