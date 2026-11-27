import Foundation
import Testing

@testable import AnkielKit

@Suite("Shortcuts")
struct ShortcutTests {
  @Test("entry links round-trip, and only allowlisted destinations parse")
  func entries() throws {
    let entries: [AppEntry] = [
      .newThread(), .newThread(prompt: "Fix the flaky test & ship", environmentId: "env-1", projectId: "p-2"),
      .thread(ThreadRef(environmentId: "env-1", threadId: "t-9")), .search(), .search("tide chart"),
    ]
    for entry in entries {
      #expect(AppEntry.parse(entry.url()) == entry)
    }
    #expect(AppEntry.parse(URL(string: "ankielcode-native://new?prompt=%20%20")!) == .newThread())
    #expect(AppEntry.parse(URL(string: "ankielcode-dev://search")!) == .search())
    #expect(AppEntry.parse(URL(string: "ankielcode-native://settings")!) == nil)
    #expect(AppEntry.parse(URL(string: "https://example.com/new")!) == nil)
    let long = String(repeating: "a", count: AppEntry.maxPromptLength + 5)
    guard case .newThread(let prompt?, _, _) = AppEntry.parse(AppEntry.newThread(prompt: long).url()) else {
      Issue.record("no prompt")
      return
    }
    #expect(prompt.count == AppEntry.maxPromptLength)
  }

  func entry(_ id: String, _ title: String, env: String = "mac") -> RecentThreads.Entry {
    .init(ref: ThreadRef(environmentId: env, threadId: id), title: title, environmentLabel: env == "mac" ? "Studio Mac" : nil)
  }

  @Test("opening moves a thread to the front, keeps a known title over an empty one, and caps the list")
  func recording() {
    var recents = RecentThreads()
    for index in 0..<12 { recents = recents.recording(entry("t\(index)", "Thread \(index)")) }
    #expect(recents.entries.count == RecentThreads.limit)
    #expect(recents.entries.first?.threadId == "t11")
    recents = recents.recording(entry("t5", ""))
    #expect(recents.entries.first?.threadId == "t5")
    #expect(recents.entries.first?.title == "Thread 5")
    #expect(recents.entries.count(where: { $0.threadId == "t5" }) == 1)
  }

  @Test("a removed computer's threads leave; the shell renames and removes")
  func pruning() {
    let recents = RecentThreads(entries: [entry("a", "Alpha"), entry("b", "Beta", env: "box"), entry("c", "")])
    #expect(recents.retaining(environments: ["mac"]).entries.map(\.threadId) == ["a", "c"])
    let refreshed = recents.refreshing(titles: ["mac:a": "Alpha 2", "mac:c": ""], removed: ["box:b"])
    #expect(refreshed.entries.map(\.title) == ["Alpha 2", ""])
    #expect(refreshed.donated.map(\.threadId) == ["a"])
    #expect(recents.removing(ThreadRef(environmentId: "mac", threadId: "a")).entries.map(\.threadId) == ["b", "c"])
  }

  @Test("intent search matches every word against title and computer")
  func matching() {
    let entries = [entry("a", "Fix the buoy parser"), entry("b", "Chart colors", env: "box")]
    #expect(RecentThreads.matching("BUOY fix", in: entries).map(\.threadId) == ["a"])
    #expect(RecentThreads.matching("studio", in: entries).map(\.threadId) == ["a"])
    #expect(RecentThreads.matching("", in: entries).count == 2)
  }

  @Test("the store survives a relaunch")
  func store() throws {
    let defaults = try #require(UserDefaults(suiteName: "ankiel.shortcut-tests"))
    defaults.removePersistentDomain(forName: "ankiel.shortcut-tests")
    let store = ShortcutStore(defaults: defaults)
    store.recents = RecentThreads(entries: [entry("a", "Alpha")])
    store.projects = [.init(environmentId: "mac", projectId: "p", title: "harbor", environmentLabel: "Studio Mac")]
    let again = ShortcutStore(defaults: defaults)
    #expect(again.recents.entries.map(\.title) == ["Alpha"])
    #expect(again.projects.map(\.title) == ["harbor"])
  }
}
