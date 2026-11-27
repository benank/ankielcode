#if DEBUG
  import AnkielKit
  import Foundation

  /// `ANKIEL_DEBUG_INTENT` runs an intent's own `perform()` at launch, before the saved computers
  /// load (as Siri does at a cold launch): `new`, `new:<prompt>`, `open` (the newest recent
  /// thread), `search:<query>`. `ANKIEL_DEBUG_RECENTS=1` prints the saved recent threads.
  enum ShortcutDebug {
    @MainActor static func run() async {
      let environment = ProcessInfo.processInfo.environment
      if environment["ANKIEL_DEBUG_RECENTS"] == "1" {
        for entry in ShortcutStore().recents.entries { print("recent: \(entry.title) (\(entry.id))") }
      }
      guard let value = environment["ANKIEL_DEBUG_INTENT"] else { return }
      let (name, argument) = value.split(separator: ":", maxSplits: 1).map(String.init).splitFirst
      switch name {
      case "new":
        let intent = NewThreadIntent()
        intent.prompt = argument
        intent.project = nil
        _ = try? await intent.perform()
      case "open":
        guard let entry = ShortcutStore().recents.donated.first else { return }
        let intent = OpenThreadIntent()
        intent.thread = ThreadEntity(entry)
        _ = try? await intent.perform()
      case "search":
        let intent = SearchThreadsIntent()
        intent.query = argument
        _ = try? await intent.perform()
      default:
        break
      }
    }
  }

  extension Array where Element == String {
    fileprivate var splitFirst: (String, String?) { (first ?? "", count > 1 ? self[1] : nil) }
  }
#endif
