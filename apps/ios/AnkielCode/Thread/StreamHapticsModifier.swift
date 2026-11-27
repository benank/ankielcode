import AnkielKit
import SwiftUI

/// A light tick while the open thread's reply streams in (Settings → Chat → Haptics), throttled
/// by `StreamHaptics`. Off under the setting; nothing runs when no reply is streaming.
private struct StreamHapticsModifier: ViewModifier {
  @Environment(AppModel.self) private var model
  let detail: ThreadDetailModel
  @State private var last: StreamHaptics.Mark?
  @State private var lastTick = Date.distantPast

  func body(content: Content) -> some View {
    content.onChange(of: model.preferences.values.streamHapticsEnabled ? StreamHaptics.mark(detail.state.timeline) : nil) { _, latest in
      let now = Date.now
      if StreamHaptics.shouldTick(previous: last, latest: latest, lastTick: lastTick, now: now) {
        lastTick = now
        Haptics.tap(.soft)
      }
      last = latest
    }
  }
}

extension View {
  func streamHaptics(_ detail: ThreadDetailModel) -> some View {
    modifier(StreamHapticsModifier(detail: detail))
  }
}
