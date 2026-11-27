import AnkielKit
import SwiftUI

/// The usage control in a top bar: the thread's context meter when it reports one, else RN's ring
/// of the highest provider spend. Both open the usage sheet.
struct UsageToolbarButton: View {
  /// In a thread: its context window (nil until reported).
  var threadContext: ContextWindowSnapshot??
  @Environment(AppModel.self) private var model
  @State private var presented = false
  @State private var gallery = false

  private var context: ContextWindowSnapshot? {
    guard let threadContext else { return nil }
    #if DEBUG
      if let debug = UsageDebug.context() { return debug }
    #endif
    return threadContext
  }

  var body: some View {
    Button {
      presented = true
    } label: {
      if let context {
        ContextMeter(window: context)
      } else {
        UsageRing(percent: model.usage.highestUsedPercent)
      }
    }
    .accessibilityLabel(label)
    .accessibilityIdentifier(context == nil ? "usage.ring" : "usage.context-meter")
    .sheet(isPresented: $presented) {
      UsageSheet(context: context)
    }
    #if DEBUG
      .sheet(isPresented: $gallery) {
        UsageWidgetGallery(sources: model.usage.sources, stale: UsageDebug.environment["ANKIEL_DEBUG_WIDGET_STALE"] == "1")
      }
    #endif
    #if DEBUG
      .task {
        // `ANKIEL_DEBUG_USAGE_OPEN=thread|home` opens the sheet once where this button shows.
        let open = UsageDebug.environment["ANKIEL_DEBUG_USAGE_OPEN"]
        if open == "widgets", threadContext == nil {
          try? await Task.sleep(for: .seconds(1))
          gallery = true
          return
        }
        guard open == (threadContext == nil ? "home" : "thread") else { return }
        // After the push transition, which drops a sheet presented mid-flight.
        try? await Task.sleep(for: .seconds(1.5))
        presented = true
      }
    #endif
  }

  private var label: String {
    if let context, let percent = context.shownPercent {
      return String(localized: "Context window · \(percent)% used")
    }
    if let highest = model.usage.highestUsedPercent {
      return String(localized: "Provider usage limits · highest usage \(Int(highest.rounded()))%")
    }
    return String(localized: "Provider usage limits")
  }
}
