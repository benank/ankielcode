import AnkielGhostty
import AnkielKit
import Foundation
import QuartzCore
import UIKit

/// libghostty is initialized once per process.
private enum GhosttyRuntime {
  nonisolated(unsafe) private static var initialized: Bool?

  static func ensureInitialized() -> Bool {
    if let initialized { return initialized }
    let ok = ghostty_init(0, nil) == GHOSTTY_SUCCESS
    initialized = ok
    return ok
  }
}

/// Ghostty calls back from its io thread and can do so during and after `deinit`, so callbacks
/// hold this weak box, not the view. Only the main queue reads `view`.
private final class SurfaceRef: @unchecked Sendable {
  weak var view: TerminalSurfaceView?
}

/// A Ghostty surface drawing a remote PTY (the RN module's `AnkielTerminalView`, without Expo):
/// output is fed in, input and resizes go out through closures. Ghostty draws with Metal into an
/// IOSurface layer on `viewport`; a hidden text field owns the software and hardware keyboards.
final class TerminalSurfaceView: UIView, UITextFieldDelegate, UIEditMenuInteractionDelegate {
  var onInput: ((String) -> Void)?
  var onResize: ((TerminalGrid) -> Void)?
  var onBell: (() -> Void)?
  var onOpenURL: ((URL) -> Void)?
  var onFocusChange: ((Bool) -> Void)?
  var onSelectText: ((String) -> Void)?

  private let viewport = TerminalViewport()
  private let inputField = TerminalInputField()
  private lazy var editMenu = UIEditMenuInteraction(delegate: self)
  private let callbackRef = SurfaceRef()
  private var app: ghostty_app_t?
  private var surface: ghostty_surface_t?
  private var creationFailed = false
  private var lastViewportSize = CGSize.zero
  private var lastScale: CGFloat = 0
  private var lastReportedGrid: TerminalGrid?
  private var pendingScroll: CGFloat = 0
  private var menuText: String?
  private var sentInput = ""
  /// Replies Ghostty writes while replaying history answer queries nobody is asking now.
  private var suppressRepliesUntil = Date.distantPast
  private var replay = TerminalReplay()

  var config = Config() {
    didSet {
      guard config != oldValue else { return }
      inputField.font = Typography.uiFont(size: max(config.fontSize, 13), mono: true)
      backgroundColor = config.palette.backgroundColor
      viewport.backgroundColor = config.palette.backgroundColor
      applyConfigInPlace()
    }
  }

  /// The grid shared by every viewer of the PTY. The surface draws that grid so wrapping and the
  /// cursor match the shell; this view's own fit still goes out through `onResize`.
  var sharedGrid: TerminalGrid? {
    didSet { if sharedGrid != oldValue { resizeSurface() } }
  }

  var readOnly = false {
    didSet { if readOnly { inputField.resignFirstResponder() } }
  }

  struct Config: Equatable {
    var palette = TerminalPalette(dark: true)
    var fontSize: Double = 10.5
    var blink = true
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    callbackRef.view = self
    clipsToBounds = true
    backgroundColor = config.palette.backgroundColor
    viewport.backgroundColor = config.palette.backgroundColor
    viewport.clipsToBounds = true
    viewport.translatesAutoresizingMaskIntoConstraints = false
    viewport.surface = self

    inputField.delegate = self
    inputField.backgroundColor = .clear
    inputField.textColor = .clear
    inputField.tintColor = .clear
    inputField.font = Typography.uiFont(size: 13, mono: true)
    inputField.autocorrectionType = .no
    inputField.autocapitalizationType = .none
    inputField.spellCheckingType = .no
    inputField.smartDashesType = .no
    inputField.smartQuotesType = .no
    inputField.smartInsertDeleteType = .no
    inputField.inlinePredictionType = .no
    inputField.returnKeyType = .default
    inputField.keyboardType = .asciiCapable
    inputField.enablesReturnKeyAutomatically = false
    inputField.translatesAutoresizingMaskIntoConstraints = false
    inputField.alpha = 0.02
    // UI tests type into the field, which needs it in the accessibility tree; VoiceOver users
    // reach the terminal through the viewport's text.
    #if DEBUG
      let exposeInput = ProcessInfo.processInfo.environment["ANKIEL_DEBUG_TERMINAL_INPUT"] == "1"
    #else
      let exposeInput = false
    #endif
    inputField.isAccessibilityElement = exposeInput
    inputField.accessibilityElementsHidden = !exposeInput
    inputField.accessibilityIdentifier = "terminal.input"
    inputField.addTarget(self, action: #selector(editingDidBegin), for: .editingDidBegin)
    inputField.addTarget(self, action: #selector(editingDidEnd), for: .editingDidEnd)
    inputField.addTarget(self, action: #selector(editingChanged), for: .editingChanged)
    inputField.onDeleteBackward = { [weak self] in self?.emit(TerminalInput.backspace) }
    inputField.onInsert = { [weak self] data in
      self?.emit(data)
      self?.resetInputField()
    }
    inputField.onPaste = { [weak self] in self?.paste(UIPasteboard.general.string) }

    let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
    let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
    pan.maximumNumberOfTouches = 1
    pan.cancelsTouchesInView = false
    let press = UILongPressGestureRecognizer(target: self, action: #selector(longPressed(_:)))
    tap.require(toFail: press)
    viewport.addGestureRecognizer(tap)
    viewport.addGestureRecognizer(pan)
    viewport.addGestureRecognizer(press)
    viewport.addInteraction(editMenu)

    addSubview(viewport)
    addSubview(inputField)
    NSLayoutConstraint.activate([
      viewport.leadingAnchor.constraint(equalTo: leadingAnchor),
      viewport.trailingAnchor.constraint(equalTo: trailingAnchor),
      viewport.topAnchor.constraint(equalTo: topAnchor),
      viewport.bottomAnchor.constraint(equalTo: bottomAnchor),
      inputField.trailingAnchor.constraint(equalTo: trailingAnchor),
      inputField.topAnchor.constraint(equalTo: bottomAnchor, constant: 8),
      inputField.widthAnchor.constraint(equalToConstant: 1),
      inputField.heightAnchor.constraint(equalToConstant: 1),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { nil }

  isolated deinit {
    destroySurface()
  }

  // MARK: Output

  /// Feeds the model's output. A reset starts a new surface from the replay, as RN does: Ghostty
  /// has no "replace everything" call that keeps the modes the new history sets.
  func apply(_ output: TerminalOutput) {
    switch output {
    case .reset(let history):
      replay.reset(history)
      suppressRepliesUntil = .now.addingTimeInterval(0.4)
      resetSurface()
    case .append(let data):
      replay.append(data)
      if surface == nil { createSurfaceIfPossible() } else { feed(Data(data.utf8)) }
    }
  }

  /// The text on screen, for VoiceOver, UI tests and "Select text".
  var viewportText: String? {
    guard let surface else { return nil }
    let selection = ghostty_selection_s(
      top_left: ghostty_point_s(tag: GHOSTTY_POINT_VIEWPORT, coord: GHOSTTY_POINT_COORD_TOP_LEFT, x: 0, y: 0),
      bottom_right: ghostty_point_s(tag: GHOSTTY_POINT_VIEWPORT, coord: GHOSTTY_POINT_COORD_BOTTOM_RIGHT, x: 0, y: 0),
      rectangle: false)
    var text = ghostty_text_s()
    guard ghostty_surface_read_text(surface, selection, &text) else { return nil }
    defer { ghostty_surface_free_text(surface, &text) }
    guard let pointer = text.text else { return nil }
    return String(decoding: UnsafeRawBufferPointer(start: pointer, count: Int(text.text_len)), as: UTF8.self)
  }


  // MARK: Input

  func focus() {
    guard window != nil, !readOnly else { return }
    inputField.becomeFirstResponder()
  }

  func resignFocus() {
    inputField.resignFirstResponder()
  }

  var hasKeyboardFocus: Bool { inputField.isFirstResponder }

  /// Accessory keys bypass the field, so a syllable it holds must not be recomposed later.
  func resetInputField() {
    inputField.text = ""
    sentInput = ""
  }

  /// Pastes through Ghostty, which wraps the text in bracketed-paste markers when the program
  /// asked for them (and strips unsafe controls), then writes it back through `onInput`.
  func paste(_ text: String?) {
    guard let text, !text.isEmpty, !readOnly else { return }
    resetInputField()
    guard let surface else {
      emit(TerminalInput.plainPaste(text))
      return
    }
    text.withCString { ghostty_surface_text(surface, $0, UInt(strlen($0))) }
  }

  private func emit(_ data: String) {
    guard !readOnly, !data.isEmpty else { return }
    onInput?(data)
  }

  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    // Return during a composition commits it; that is not Enter.
    guard textField.markedTextRange == nil else { return false }
    emit(TerminalInput.enter)
    resetInputField()
    return false
  }

  @objc private func editingChanged() {
    guard inputField.markedTextRange == nil else { return }
    let text = inputField.text ?? ""
    emit(TerminalInput.fieldEdit(sent: sentInput, field: text))
    sentInput = text
    // A Hangul syllable never spans whitespace; past the cap, keep the last character to compose onto.
    if text.last?.isWhitespace == true {
      resetInputField()
    } else if text.count > 64 {
      let last = String(text.suffix(1))
      inputField.text = last
      sentInput = last
    }
  }

  @objc private func editingDidBegin() {
    // A composition abandoned when focus left must not reach the PTY with the next keystroke.
    resetInputField()
    if let app { ghostty_app_keyboard_changed(app) }
    if let surface { ghostty_surface_set_focus(surface, true) }
    onFocusChange?(true)
  }

  @objc private func editingDidEnd() {
    if let surface { ghostty_surface_set_focus(surface, false) }
    onFocusChange?(false)
  }

  // MARK: Gestures

  @objc private func tapped(_ gesture: UITapGestureRecognizer) {
    if let url = link(at: gesture.location(in: viewport)) {
      onOpenURL?(url)
      return
    }
    focus()
  }

  /// A URL in the tapped row, under the finger. Cells are found from Ghostty's grid size, with
  /// its padding split evenly (the surface centers the grid).
  private func link(at point: CGPoint) -> URL? {
    guard let surface, let text = viewportText else { return nil }
    let size = ghostty_surface_size(surface)
    guard size.cell_width_px > 0, size.cell_height_px > 0 else { return nil }
    let scale = contentScaleFactor
    let padX = (CGFloat(size.width_px) - CGFloat(size.columns) * CGFloat(size.cell_width_px)) / 2
    let padY = (CGFloat(size.height_px) - CGFloat(size.rows) * CGFloat(size.cell_height_px)) / 2
    let row = Int((point.y * scale - padY) / CGFloat(size.cell_height_px))
    let column = Int((point.x * scale - padX) / CGFloat(size.cell_width_px))
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
    guard lines.indices.contains(row) else { return nil }
    let line = String(lines[row])
    guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
    for match in detector.matches(in: line, range: NSRange(line.startIndex..., in: line)) {
      guard let url = match.url, url.scheme == "http" || url.scheme == "https",
        let range = Range(match.range, in: line)
      else { continue }
      let start = line[..<range.lowerBound].count
      let end = start + line[range].count
      if column >= start, column < end + 1 { return url }
    }
    return nil
  }

  @objc private func panned(_ gesture: UIPanGestureRecognizer) {
    guard let surface else { return }
    let location = gesture.location(in: viewport)
    ghostty_surface_mouse_pos(
      surface, Double(location.x * contentScaleFactor), Double(location.y * contentScaleFactor), GHOSTTY_MODS_NONE)
    switch gesture.state {
    case .began:
      pendingScroll = 0
    case .changed:
      let step = max(config.fontSize * 1.15, 18)
      let total = pendingScroll + gesture.translation(in: viewport).y
      let steps = Int(total / step)
      pendingScroll = total - CGFloat(steps) * step
      if steps != 0 {
        ghostty_surface_mouse_scroll(surface, 0, Double(steps), 0)
        redraw()
      }
    default:
      pendingScroll = 0
    }
    gesture.setTranslation(.zero, in: viewport)
  }

  @objc private func longPressed(_ gesture: UILongPressGestureRecognizer) {
    guard gesture.state == .began else { return }
    // Freeze the text pressed on; output keeps streaming while the menu is open.
    menuText = viewportText.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
    guard menuText != nil || canPaste else { return }
    editMenu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: gesture.location(in: viewport)))
  }

  func editMenuInteraction(
    _ interaction: UIEditMenuInteraction, menuFor configuration: UIEditMenuConfiguration,
    suggestedActions: [UIMenuElement]
  ) -> UIMenu? {
    var children: [UIMenuElement] = []
    if canPaste {
      children.append(
        UIAction(title: String(localized: "Paste", comment: "verb"), image: UIImage(systemName: "doc.on.clipboard")) {
          [weak self] _ in self?.paste(UIPasteboard.general.string)
        })
    }
    if let text = menuText {
      children.append(
        UIAction(title: String(localized: "Select text"), image: UIImage(systemName: "text.cursor")) { [weak self] _ in
          self?.inputField.resignFirstResponder()
          self?.onSelectText?(text)
        })
    }
    return children.isEmpty ? nil : UIMenu(children: children)
  }

  private var canPaste: Bool { !readOnly && UIPasteboard.general.hasStrings }

  // MARK: Layout

  override func layoutSubviews() {
    super.layoutSubviews()
    let scale = traitCollection.displayScale
    if contentScaleFactor != scale { contentScaleFactor = scale }
    if surface == nil { createSurfaceIfPossible() }
    guard viewport.bounds.size != lastViewportSize || contentScaleFactor != lastScale else { return }
    lastViewportSize = viewport.bounds.size
    lastScale = contentScaleFactor
    resizeSurface()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if let surface { ghostty_surface_set_occlusion(surface, window != nil) }
  }

  // MARK: Surface

  private func createSurfaceIfPossible() {
    guard surface == nil, app == nil, !creationFailed else { return }
    guard viewport.bounds.width > 0, viewport.bounds.height > 0 else { return }
    guard GhosttyRuntime.ensureInitialized() else {
      creationFailed = true
      return
    }
    var runtime = ghostty_runtime_config_s(
      userdata: Unmanaged.passUnretained(callbackRef).toOpaque(),
      supports_selection_clipboard: false,
      // The io thread queues app messages in a bounded mailbox; unless main drains it, the io
      // thread blocks and the next feed or free hangs.
      wakeup_cb: { userdata in
        guard let userdata else { return }
        let ref = Unmanaged<SurfaceRef>.fromOpaque(userdata).takeUnretainedValue()
        DispatchQueue.main.async { MainActor.assumeIsolated { ref.view?.tick() } }
      },
      action_cb: { app, _, action in
        guard let app, let userdata = ghostty_app_userdata(app) else { return false }
        let ref = Unmanaged<SurfaceRef>.fromOpaque(userdata).takeUnretainedValue()
        switch action.tag {
        case GHOSTTY_ACTION_RING_BELL:
          DispatchQueue.main.async { MainActor.assumeIsolated { ref.view?.onBell?() } }
          return true
        case GHOSTTY_ACTION_OPEN_URL:
          let value = action.action.open_url
          guard let pointer = value.url else { return false }
          let string = String(decoding: UnsafeRawBufferPointer(start: pointer, count: Int(value.len)), as: UTF8.self)
          DispatchQueue.main.async {
            MainActor.assumeIsolated {
              if let url = URL(string: string) { ref.view?.onOpenURL?(url) }
            }
          }
          return true
        default:
          return false
        }
      },
      read_clipboard_cb: { _, _, _, _, _, _ in GHOSTTY_CLIPBOARD_READ_UNSUPPORTED },
      confirm_read_clipboard_cb: { _, _, _, _ in },
      write_clipboard_cb: { _, _, _, _, _ in },
      close_surface_cb: { _, _ in }
    )
    guard let configuration = makeConfig() else {
      creationFailed = true
      return
    }
    defer { ghostty_config_free(configuration) }
    guard let app = ghostty_app_new(&runtime, configuration) else {
      creationFailed = true
      return
    }
    var surfaceConfig = ghostty_surface_config_new()
    surfaceConfig.platform_tag = GHOSTTY_PLATFORM_IOS
    surfaceConfig.platform.ios.uiview = Unmanaged.passUnretained(viewport).toOpaque()
    surfaceConfig.userdata = Unmanaged.passUnretained(callbackRef).toOpaque()
    surfaceConfig.scale_factor = Double(contentScaleFactor)
    surfaceConfig.font_size = Float(config.fontSize)
    surfaceConfig.context = GHOSTTY_SURFACE_CONTEXT_WINDOW
    surfaceConfig.use_custom_io = true
    guard let surface = ghostty_surface_new(app, &surfaceConfig) else {
      ghostty_app_free(app)
      creationFailed = true
      return
    }
    self.app = app
    self.surface = surface
    let scheme = config.palette.dark ? GHOSTTY_COLOR_SCHEME_DARK : GHOSTTY_COLOR_SCHEME_LIGHT
    ghostty_app_set_color_scheme(app, scheme)
    ghostty_surface_set_color_scheme(surface, scheme)
    ghostty_surface_set_write_callback(surface, { userdata, data, length in
      guard let userdata, let data, length > 0 else { return }
      let ref = Unmanaged<SurfaceRef>.fromOpaque(userdata).takeUnretainedValue()
      let bytes = Data(bytes: data, count: length)
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let view = ref.view, Date.now >= view.suppressRepliesUntil else { return }
          view.emit(String(decoding: bytes, as: UTF8.self))
        }
      }
    }, Unmanaged.passUnretained(callbackRef).toOpaque())
    resizeSurface()
    feed(replay.data)
  }

  private func makeConfig() -> ghostty_config_t? {
    guard let configuration = ghostty_config_new() else { return nil }
    let url = URL.temporaryDirectory.appending(path: "ankiel-terminal-\(config.palette.theme.rawValue)-\(config.palette.dark ? "dark" : "light").ghostty")
    let contents = config.palette.ghosttyConfig(fontSize: config.fontSize, blink: config.blink)
    if (try? String(contentsOf: url, encoding: .utf8)) != contents {
      try? contents.write(to: url, atomically: true, encoding: .utf8)
    }
    url.path.withCString { ghostty_config_load_file(configuration, $0) }
    ghostty_config_finalize(configuration)
    return configuration
  }

  private func resetSurface() {
    destroySurface()
    lastViewportSize = .zero
    lastScale = 0
    lastReportedGrid = nil
    creationFailed = false
    setNeedsLayout()
    layoutIfNeeded()
  }

  /// Font and colors change in place: a new surface would replay output and answer its queries again.
  private func applyConfigInPlace() {
    guard let app, let surface, let configuration = makeConfig() else { return }
    defer { ghostty_config_free(configuration) }
    let scheme = config.palette.dark ? GHOSTTY_COLOR_SCHEME_DARK : GHOSTTY_COLOR_SCHEME_LIGHT
    ghostty_app_set_color_scheme(app, scheme)
    ghostty_surface_set_color_scheme(surface, scheme)
    tick()
    ghostty_surface_update_config(surface, configuration)
    resizeSurface()
  }

  private func destroySurface() {
    tick()
    if let surface {
      ghostty_surface_set_write_callback(surface, nil, nil)
      ghostty_surface_free(surface)
    }
    if let app { ghostty_app_free(app) }
    surface = nil
    app = nil
    // Ghostty adds its IOSurface layer to the viewport but never removes it on free, which would
    // leave the last frame under the next surface. The viewport has no subviews of its own.
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    viewport.layer.sublayers?.forEach { $0.removeFromSuperlayer() }
    CATransaction.commit()
  }

  private func tick() {
    if let app { ghostty_app_tick(app) }
  }

  private func feed(_ data: Data) {
    guard let surface, !data.isEmpty else { return }
    tick()
    data.withUnsafeBytes { buffer in
      guard let pointer = buffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
      ghostty_surface_feed_data(surface, pointer, buffer.count)
    }
    redraw()
  }

  private func resizeSurface() {
    guard let surface else { return }
    let scale = contentScaleFactor
    let width = UInt32(max(floor(viewport.bounds.width * scale), 1))
    let height = UInt32(max(floor(viewport.bounds.height * scale), 1))
    viewport.contentScaleFactor = scale
    ghostty_surface_set_content_scale(surface, Double(scale), Double(scale))
    ghostty_surface_set_size(surface, width, height)
    let fitted = ghostty_surface_size(surface)
    let fit = TerminalGrid(cols: max(1, Int(fitted.columns)), rows: max(1, Int(fitted.rows)))
    // Trimming whole cells keeps Ghostty's padding; the surface only shrinks inside the view, so
    // a stale larger shared grid falls back to the fitted one.
    var drawnWidth = width
    var drawnHeight = height
    if let sharedGrid {
      drawnWidth -= UInt32(max(fit.cols - sharedGrid.cols, 0)) * fitted.cell_width_px
      drawnHeight -= UInt32(max(fit.rows - sharedGrid.rows, 0)) * fitted.cell_height_px
      if drawnWidth != width || drawnHeight != height { ghostty_surface_set_size(surface, drawnWidth, drawnHeight) }
    }
    ghostty_surface_set_occlusion(surface, window != nil)
    let bounds = CGRect(x: 0, y: 0, width: CGFloat(drawnWidth) / scale, height: CGFloat(drawnHeight) / scale)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    viewport.layer.sublayers?.forEach {
      $0.frame = bounds
      $0.contentsScale = scale
    }
    CATransaction.commit()
    redraw()
    if fit != lastReportedGrid {
      lastReportedGrid = fit
      onResize?(fit)
    }
  }

  private func redraw() {
    guard let surface else { return }
    ghostty_surface_refresh(surface)
    ghostty_surface_draw(surface)
    viewport.layer.sublayers?.forEach { $0.setNeedsDisplay() }
  }
}

/// The hidden field that holds keyboard focus: hardware key commands for keys a text field would
/// swallow, Backspace on an empty field, and system Paste.
private final class TerminalInputField: UITextField {
  var onDeleteBackward: (() -> Void)?
  var onInsert: ((String) -> Void)?
  var onPaste: (() -> Void)?

  private static let commands = makeCommands()

  private static func makeCommands() -> [UIKeyCommand] {
    let special = [
      UIKeyCommand.inputEscape, UIKeyCommand.inputUpArrow, UIKeyCommand.inputDownArrow,
      UIKeyCommand.inputLeftArrow, UIKeyCommand.inputRightArrow,
    ]
    var keys: [(String, UIKeyModifierFlags)] = (special + ["\t"]).map { ($0, []) }
    keys += special.dropFirst().map { ($0, .alternate) }
    keys.append(("\t", .shift))
    for character in "abcdefghijklmnopqrstuvwxyz@[\\]^_-? " {
      keys.append((String(character), .control))
      keys.append((String(character), [.control, .shift]))
    }
    return keys.map { input, flags in
      let command = UIKeyCommand(input: input, modifierFlags: flags, action: #selector(hardwareKey(_:)))
      command.wantsPriorityOverSystemBehavior = true
      return command
    }
  }

  // While an IME composes, arrows, Tab and Escape pick or cancel candidates instead.
  override var keyCommands: [UIKeyCommand]? { markedTextRange == nil ? Self.commands : nil }

  override func deleteBackward() {
    // Backspace edits marked or typed field text first; the field diff sends that DEL.
    if markedTextRange == nil, !hasText { onDeleteBackward?() }
    super.deleteBackward()
  }

  // A system paste bypasses typed input so it keeps its encoding and chunking.
  override func paste(_ sender: Any?) {
    if markedTextRange != nil {
      unmarkText()
      sendActions(for: .editingChanged)
    }
    onPaste?()
  }

  @objc private func hardwareKey(_ command: UIKeyCommand) {
    guard let input = command.input else { return }
    let flags = command.modifierFlags
    guard
      let sequence = TerminalInput.hardwareKey(
        input: input, control: flags.contains(.control), shift: flags.contains(.shift), option: flags.contains(.alternate))
    else { return }
    onInsert?(sequence)
  }
}

/// The surface's drawing view, and its accessibility element: the text on screen as its value.
private final class TerminalViewport: UIView {
  weak var surface: TerminalSurfaceView?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isAccessibilityElement = true
    accessibilityTraits = [.allowsDirectInteraction]
    accessibilityLabel = String(localized: "Terminal output")
    accessibilityIdentifier = "terminal.surface"
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { nil }

  override var accessibilityValue: String? {
    get { surface?.viewportText?.trimmingCharacters(in: .whitespacesAndNewlines) }
    set {}
  }
}
