import AnkielKit
import SwiftUI
import UIKit

/// What the open thread offers the keyboard: its composer publishes these while it is on screen.
struct ThreadKeyCommands {
  var focusComposer: () -> Void
  /// Nil while nothing runs.
  var stop: (() -> Void)?
  var files: (() -> Void)?
  var review: (() -> Void)?
  var copyLink: () -> Void
}

extension FocusedValues {
  @Entry var threadKeyCommands: ThreadKeyCommands?
}

/// Hardware keyboard shortcuts and the iPadOS menu bar (RN `AnkielKeyboardCommandCatalog`, with
/// thread navigation added). Titles are sentence case like the rest of the app. List commands act
/// only with nothing presented over home; thread commands need a thread on screen. Search is
/// Command-K: the system's Find keeps Command-F, and on iPhone only `replacing:` groups and
/// command menus reach the app (an `after:` group's shortcuts never arrived).
struct AppCommands: Commands {
  let model: AppModel
  @FocusedValue(\.threadKeyCommands) private var thread

  /// Home with no sheet over it (thread screens included).
  private var free: Bool { model.route == .home && model.sheet == nil && model.navigator.sheet == nil }

  var body: some Commands {
    CommandGroup(replacing: .newItem) {
      Button("New thread") { if free { model.navigator.newThread() } }
        .keyboardShortcut("n", modifiers: .command)
        .disabled(!free)
      Button("Focus search") { search() }
        .keyboardShortcut("k", modifiers: .command)
        .disabled(!free)
    }
    CommandGroup(replacing: .sidebar) {
      Button("Toggle sidebar") { model.navigator.toggleSidebar() }
        .keyboardShortcut("\\", modifiers: .command)
        .disabled(!free)
    }
    CommandMenu("Thread") {
      Button("Focus composer") { thread?.focusComposer() }
        .keyboardShortcut("l", modifiers: .command)
        .disabled(thread == nil)
      Button("Stop agent") { thread?.stop?() }
        .keyboardShortcut(".", modifiers: .command)
        .disabled(thread?.stop == nil)
      Divider()
      Button("Open files") { thread?.files?() }
        .keyboardShortcut("f", modifiers: [.command, .shift])
        .disabled(thread?.files == nil)
      Button("Open review") { thread?.review?() }
        .keyboardShortcut("r", modifiers: [.command, .shift])
        .disabled(thread?.review == nil)
      Button("Copy thread link") { thread?.copyLink() }
        .keyboardShortcut("c", modifiers: [.command, .shift])
        .disabled(thread == nil)
    }
    CommandMenu("Go") {
      Button("Back") { model.navigator.back() }
        .keyboardShortcut("[", modifiers: .command)
        .disabled(!free || model.navigator.stack.isEmpty)
      Button("Threads") { model.navigator.stack = [] }
        .keyboardShortcut("0", modifiers: .command)
        .disabled(!free)
      Divider()
      Button("Next thread") { step(1) }
        .keyboardShortcut(.downArrow, modifiers: [.command, .option])
        .disabled(!free)
      Button("Previous thread") { step(-1) }
        .keyboardShortcut(.upArrow, modifiers: [.command, .option])
        .disabled(!free)
      Button("Next computer") { nextComputer() }
        .keyboardShortcut("h", modifiers: [.command, .shift])
        .disabled(!free || model.home.environmentChoices.count < 2)
      Divider()
      ForEach(1...9, id: \.self) { index in
        Button("Go to thread \(index)") { jump(index) }
          .keyboardShortcut(KeyEquivalent(Character("\(index)")), modifiers: .command)
          .disabled(!free)
      }
    }
  }

  /// The listed threads, in list order.
  private var rows: [ThreadRef] {
    model.home.layout.items.compactMap { if case .thread(let row) = $0 { row.ref } else { nil } }
  }

  private func search() {
    guard free else { return }
    model.open(.search())
  }

  private func step(_ offset: Int) {
    let rows = rows
    guard free, !rows.isEmpty else { return }
    guard let current = model.navigator.selection, let index = rows.firstIndex(of: current) else {
      model.navigator.open(offset > 0 ? rows[0] : rows[rows.count - 1])
      return
    }
    let next = index + offset
    guard rows.indices.contains(next) else { return }
    model.navigator.open(rows[next])
  }

  private func jump(_ index: Int) {
    let rows = rows
    guard free, rows.indices.contains(index - 1) else { return }
    model.navigator.open(rows[index - 1])
  }

  private func nextComputer() {
    let ids = model.home.environmentChoices.map(\.id)
    guard free, ids.count > 1 else { return }
    let current = model.home.environmentFilterResolved.flatMap { ids.firstIndex(of: $0) }
    // All computers, then each in turn, then all again.
    let next: String? = current.map { $0 + 1 < ids.count ? ids[$0 + 1] : nil } ?? ids.first
    model.home.setEnvironmentFilter(next)
  }
}

extension Navigator {
  func back() {
    guard !stack.isEmpty else { return }
    stack.removeLast()
  }
}
