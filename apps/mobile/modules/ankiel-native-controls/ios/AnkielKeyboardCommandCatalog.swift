import UIKit

@MainActor @objc protocol AnkielKeyboardCommandPerforming {
  func performAnkielKeyboardCommand(_ sender: UICommand)
}

/// One table for hardware shortcuts and the iPadOS menu bar. Every command shares one action and
/// carries its id as the property list, so responders gate commands by id in `canPerformAction`.
@MainActor
enum AnkielKeyboardCommandCatalog {
  enum Menu {
    case file
    case edit
    case view
    case go
  }

  struct Entry {
    let id: String
    let input: String
    let modifiers: UIKeyModifierFlags
    let defaultTitle: String
    let menu: Menu?
    var titleKey: String?
  }

  static let action = #selector(AnkielKeyboardCommandPerforming.performAnkielKeyboardCommand(_:))
  private static let goMenuIdentifier = UIMenu.Identifier("com.ankiel.ankielcode.menu.go")
  private static let goMenuTitleKey = "menu.go"
  private static var titles: [String: String] = [:]
  private static var installedMainMenu = false

  static func entries(isPad: Bool) -> [Entry] {
    var entries = [
      Entry(id: "newTask", input: "n", modifiers: .command, defaultTitle: "New Task", menu: .file),
      Entry(id: "focusSearch", input: "f", modifiers: .command, defaultTitle: "Find", menu: .edit),
      isPad
        ? Entry(id: "commandPalette", input: "k", modifiers: .command, defaultTitle: "Command Palette", menu: .view)
        : Entry(id: "focusSearch", input: "k", modifiers: .command, defaultTitle: "Focus Search", menu: nil, titleKey: "focusSearchAlternate"),
      Entry(id: "paletteNext", input: UIKeyCommand.inputDownArrow, modifiers: [], defaultTitle: "Next Result", menu: nil),
      Entry(id: "palettePrevious", input: UIKeyCommand.inputUpArrow, modifiers: [], defaultTitle: "Previous Result", menu: nil),
      Entry(id: "paletteDismiss", input: UIKeyCommand.inputEscape, modifiers: [], defaultTitle: "Close Command Palette", menu: nil),
      Entry(id: "back", input: "[", modifiers: .command, defaultTitle: "Back", menu: .go),
      Entry(id: "files", input: "f", modifiers: [.command, .shift], defaultTitle: "Open Files", menu: .go),
      Entry(id: "terminal", input: "t", modifiers: [.command, .shift], defaultTitle: "Open Terminal", menu: .go),
      Entry(id: "review", input: "r", modifiers: [.command, .shift], defaultTitle: "Open Review", menu: .go),
      Entry(id: "copyThreadReference", input: "c", modifiers: [.command, .shift], defaultTitle: "Copy PR Link or Thread", menu: .edit),
      Entry(id: "toggleSidebar", input: "\\", modifiers: .command, defaultTitle: "Toggle Sidebar", menu: .view),
      Entry(id: "cycleHost", input: "h", modifiers: [.command, .shift], defaultTitle: "Next Machine", menu: .go),
    ]
    if isPad {
      entries += (1...9).map { index in
        Entry(id: "thread.jump.\(index)", input: String(index), modifiers: .command, defaultTitle: "Go to Thread \(index)", menu: .go)
      }
    }
    return entries
  }

  static func commandId(of sender: Any?) -> String? {
    (sender as? UICommand)?.propertyList as? String
  }

  static func keyCommand(for entry: Entry) -> UIKeyCommand {
    let command = UIKeyCommand(
      title: title(for: entry),
      action: action,
      input: entry.input,
      modifierFlags: entry.modifiers,
      propertyList: entry.id
    )
    command.discoverabilityTitle = title(for: entry)
    command.wantsPriorityOverSystemBehavior = true
    return command
  }

  /// JS sends titles in the app language; English defaults cover the moments before it does.
  static func setTitles(_ newTitles: [String: String]) {
    guard !newTitles.isEmpty, newTitles != titles else { return }
    titles = newTitles
    guard installedMainMenu, #available(iOS 26.0, *) else { return }
    UIMainMenuSystem.shared.setNeedsRebuild()
  }

  static func revalidateMainMenu() {
    guard installedMainMenu, #available(iOS 26.0, *) else { return }
    UIMainMenuSystem.shared.setNeedsRevalidate()
  }

  static func installMainMenu() {
    guard UIDevice.current.userInterfaceIdiom == .pad, #available(iOS 26.0, *) else { return }
    installedMainMenu = true
    let configuration = UIMainMenuSystem.Configuration()
    // One window, a plain-text composer, and these commands replace the system Find and sidebar items.
    configuration.newScenePreference = .removed
    configuration.documentPreference = .removed
    configuration.printingPreference = .removed
    configuration.findingPreference = .removed
    configuration.sidebarPreference = .removed
    configuration.toolbarPreference = .removed
    configuration.inspectorPreference = .removed
    configuration.textFormattingPreference = .removed
    UIMainMenuSystem.shared.setBuildConfiguration(configuration) { builder in
      buildMainMenu(with: builder)
    }
  }

  private static func buildMainMenu(with builder: UIMenuBuilder) {
    let entries = entries(isPad: true)
    func commands(in menu: Menu) -> [UIKeyCommand] {
      entries.filter { $0.menu == menu }.map(keyCommand(for:))
    }
    // A command whose system menu is missing moves to Go, so every command stays reachable.
    var unplaced: [UIMenuElement] = []
    for (menu, identifier, atStart) in [(Menu.file, UIMenu.Identifier.file, true), (.edit, .edit, false), (.view, .view, true)] {
      let section = UIMenu(options: .displayInline, children: commands(in: menu))
      if builder.menu(for: identifier) == nil {
        unplaced.append(section)
      } else if atStart {
        builder.insertChild(section, atStartOfMenu: identifier)
      } else {
        builder.insertChild(section, atEndOfMenu: identifier)
      }
    }
    let goEntries = entries.filter { $0.menu == .go }
    let threadJumps = goEntries.filter { $0.id.hasPrefix("thread.jump.") }
    let goMenu = UIMenu(
      title: titles[goMenuTitleKey] ?? "Go",
      identifier: goMenuIdentifier,
      children: goEntries.filter { !$0.id.hasPrefix("thread.jump.") }.map(keyCommand(for:))
        + [UIMenu(options: .displayInline, children: threadJumps.map(keyCommand(for:)))]
        + unplaced
    )
    if builder.menu(for: .view) != nil {
      builder.insertSibling(goMenu, afterMenu: .view)
    } else if builder.menu(for: .window) != nil {
      builder.insertSibling(goMenu, beforeMenu: .window)
    } else {
      builder.insertChild(goMenu, atEndOfMenu: .root)
    }
  }

  private static func title(for entry: Entry) -> String {
    titles[entry.titleKey ?? entry.id] ?? entry.defaultTitle
  }
}
