import AnkielKit
import SwiftUI

/// The trailing paragraph of a streaming reply. Text that arrives fades in over ~300 ms in five
/// discrete opacity steps (`.plans/05-spectral-minimalism.md` §D), one range per update, at most
/// 48 at once. Text present when the view appears (opening a thread) shows at once, and Reduce
/// Motion turns the fade off. The timeline only ticks while a range is still fading.
struct StreamingParagraph: View {
  let text: InlineText
  @State private var ranges: [Reveal] = []
  @State private var known: Int?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  struct Reveal: Equatable {
    var start: Int
    var end: Int
    var born: Date
  }

  static let duration: TimeInterval = 0.3
  static let steps = 5.0

  var body: some View {
    TimelineView(.animation(minimumInterval: 1 / 20, paused: ranges.isEmpty)) { context in
      Text(styled(at: context.date))
        .font(Typography.body)
        .lineSpacing(3)
        .foregroundStyle(Palette.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .onAppear { known = text.attributed.characters.count }
    .onChange(of: text.attributed.characters.count) { old, new in
      let from = known ?? old
      known = new
      guard !reduceMotion, new > from else { return }
      ranges.append(Reveal(start: from, end: new, born: .now))
      if ranges.count > 48 { ranges.removeFirst(ranges.count - 48) }
    }
    .task(id: ranges.last?.born) {
      try? await Task.sleep(for: .seconds(Self.duration + 0.05))
      let now = Date.now
      ranges.removeAll { now.timeIntervalSince($0.born) >= Self.duration }
    }
  }

  private func styled(at date: Date) -> AttributedString {
    guard !ranges.isEmpty else { return text.attributed }
    var attributed = text.attributed
    let count = attributed.characters.count
    for range in ranges where range.start < count {
      let progress = min(1, date.timeIntervalSince(range.born) / Self.duration)
      guard progress < 1 else { continue }
      let opacity = max(0.15, (progress * Self.steps).rounded(.up) / Self.steps)
      let lower = attributed.characters.index(attributed.startIndex, offsetBy: range.start)
      let upper = attributed.characters.index(attributed.startIndex, offsetBy: min(range.end, count))
      attributed[lower..<upper].swiftUI.foregroundColor = Palette.textPrimary.opacity(opacity)
    }
    return attributed
  }
}
