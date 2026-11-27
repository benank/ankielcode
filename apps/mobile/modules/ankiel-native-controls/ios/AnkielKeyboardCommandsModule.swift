import ExpoModulesCore
import UIKit

public final class AnkielKeyboardCommandsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AnkielKeyboardCommands")

    View(AnkielKeyboardCommandsView.self) {
      Prop("enabledCommands") { (view: AnkielKeyboardCommandsView, commands: [String]) in
        view.setEnabledCommands(commands)
      }
      Prop("commandTitles") { (_: AnkielKeyboardCommandsView, titles: [String: String]) in
        AnkielKeyboardCommandCatalog.setTitles(titles)
      }
      Events("onCommand")
    }
  }
}

public final class AnkielKeyboardCommandsView: ExpoView, AnkielKeyboardCommandPerforming {
  private static let paletteCommands: Set<String> = ["commandPalette", "paletteNext", "palettePrevious", "paletteDismiss"]
  let onCommand = EventDispatcher()
  private var enabledCommands = Set<String>()
  private let shortcutInputView = UIView(frame: .zero)

  public override var canBecomeFirstResponder: Bool { true }

  // This responder handles hardware shortcuts, so reclaiming it must not show a software keyboard.
  public override var inputView: UIView? { shortcutInputView }

  public override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    guard action == AnkielKeyboardCommandCatalog.action else {
      return super.canPerformAction(action, withSender: sender)
    }
    // The menu bar sends every command through the responder chain; an instance without the
    // command enabled passes it on, so the palette's instance never swallows a workspace command.
    guard let id = AnkielKeyboardCommandCatalog.commandId(of: sender) else {
      return super.canPerformAction(action, withSender: sender)
    }
    guard enabledCommands.contains(id) else { return false }
    if Self.paletteCommands.contains(id),
       let input = window?.ankielFirstResponder as? UITextInput,
       input.markedTextRange != nil {
      return false
    }
    return true
  }

  public override var keyCommands: [UIKeyCommand]? {
    AnkielKeyboardCommandCatalog.entries(isPad: UIDevice.current.userInterfaceIdiom == .pad)
      .filter { enabledCommands.contains($0.id) }
      .map(AnkielKeyboardCommandCatalog.keyCommand(for:))
  }

  func setEnabledCommands(_ commands: [String]) {
    enabledCommands = Set(commands)
    if isFirstResponder {
      resignFirstResponder()
    }
    reclaimFirstResponderIfAvailable()
    AnkielKeyboardCommandCatalog.revalidateMainMenu()
  }

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    inputAssistantItem.leadingBarButtonGroups = []
    inputAssistantItem.trailingBarButtonGroups = []
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(reclaimFirstResponderIfAvailable),
      name: UITextView.textDidEndEditingNotification,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(reclaimFirstResponderIfAvailable),
      name: UITextField.textDidEndEditingNotification,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(reclaimFirstResponderIfAvailable),
      name: UIApplication.didBecomeActiveNotification,
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    reclaimFirstResponderIfAvailable()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    reclaimFirstResponderIfAvailable()
  }

  @objc func performAnkielKeyboardCommand(_ sender: UICommand) {
    guard let id = AnkielKeyboardCommandCatalog.commandId(of: sender), enabledCommands.contains(id) else { return }
    emit(id)
  }

  private func emit(_ command: String) {
    onCommand(["command": command])
  }

  @objc private func reclaimFirstResponderIfAvailable() {
    DispatchQueue.main.async { [weak self] in
      guard let self, self.window?.ankielFirstResponder == nil else { return }
      self.becomeFirstResponder()
    }
  }
}

private extension UIView {
  var ankielFirstResponder: UIResponder? {
    if isFirstResponder { return self }
    for subview in subviews {
      if let responder = subview.ankielFirstResponder { return responder }
    }
    return nil
  }
}
