import AnkielKit
import SwiftUI
import UIKit

/// Keys the editor routes to the open suggestion list instead of the text.
struct ComposerSuggestionKeys {
  var move: (Int) -> Void
  var accept: () -> Void
  var dismiss: () -> Void
}

/// A caret the composer asks the editor to place, in UTF-16 source offsets. `id` changes for every
/// request so the same offset can be asked for twice.
struct ComposerCaretRequest: Equatable {
  var offset: Int
  var id = UUID()
}

/// The composer's text field: a `UITextView` that draws mentions and skills as chips (RN
/// `AnkielComposerEditorView`). The draft stays plain text; each chip is one attachment character
/// that stands for its source text, so it deletes as a unit and copies as its source.
struct ComposerTextEditor: UIViewRepresentable {
  var text: String
  var placeholder: String
  /// `<instance>/<slug>` → model name, for `model:` chips.
  var modelLabels: [String: String] = [:]
  var editable: Bool
  var maxLines: Int
  @Binding var focused: Bool
  var caretRequest: ComposerCaretRequest?
  var suggestionKeys: ComposerSuggestionKeys?
  var onChange: (String) -> Void
  /// The caret in source offsets (start, end) whenever it moves.
  var onSelection: (Int, Int) -> Void
  var onSubmit: () -> Void

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> ComposerUITextView {
    let view = ComposerUITextView()
    view.delegate = context.coordinator
    view.backgroundColor = .clear
    view.font = Typography.uiFont(.body)
    view.adjustsFontForContentSizeCategory = true
    view.textColor = UIColor(Palette.textPrimary)
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.isScrollEnabled = false
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    view.accessibilityIdentifier = "composer.field"
    context.coordinator.view = view
    context.coordinator.parent = self
    context.coordinator.apply(text, force: true)
    return view
  }

  func updateUIView(_ view: ComposerUITextView, context: Context) {
    let coordinator = context.coordinator
    coordinator.parent = self
    view.placeholder = placeholder
    view.modelLabels = modelLabels
    view.isEditable = editable
    view.onSubmit = onSubmit
    view.suggestionKeys = suggestionKeys
    coordinator.apply(text, force: false)
    if let caretRequest, caretRequest != coordinator.appliedCaret {
      coordinator.appliedCaret = caretRequest
      view.selectedRange = view.displayRange(source: caretRequest.offset)
      // Never write the parent's state while SwiftUI is updating this view.
      coordinator.reportSelection()
    }
    view.wantsFocus = focused
    if focused, !view.isFirstResponder, view.window != nil {
      DispatchQueue.main.async { view.becomeFirstResponder() }
    } else if !focused, view.isFirstResponder {
      DispatchQueue.main.async { view.resignFirstResponder() }
    }
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView view: ComposerUITextView, context: Context) -> CGSize? {
    let width = proposal.width ?? view.bounds.width
    guard width > 0, width.isFinite else { return nil }
    let fitted = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
    let lineHeight = (view.font ?? Typography.uiFont(.body)).lineHeight
    let cap = ceil(lineHeight * CGFloat(maxLines))
    let scrolls = fitted > cap + 1
    if view.isScrollEnabled != scrolls {
      DispatchQueue.main.async { view.isScrollEnabled = scrolls }
    }
    return CGSize(width: width, height: max(ceil(lineHeight), min(fitted, cap)))
  }

  @MainActor
  final class Coordinator: NSObject, UITextViewDelegate {
    weak var view: ComposerUITextView?
    var parent: ComposerTextEditor?
    var tokens: [ComposerInlineToken] = []
    var appliedCaret: ComposerCaretRequest?
    private var applying = false

    /// Rebuilds the document when the source or its chips changed (never during IME composition).
    func apply(_ source: String, force: Bool) {
      guard let view else { return }
      if view.markedTextRange != nil { return }
      let next = ComposerInlineTokens.editorTokens(source, preserveTrailing: tokens, knownModels: Set(view.modelLabels.keys))
      let current = view.serializedText()
      tokens = next
      // Positions shift as text is typed before a chip; only which chips show matters here.
      let sameChips = view.renderedTokens().map { [$0.kind.rawValue, $0.source] } == next.map { [$0.kind.rawValue, $0.source] }
      guard force || current != source || !sameChips else {
        view.updatePlaceholder()
        return
      }
      let selection = view.sourceSelection()
      applying = true
      view.render(source, tokens: next)
      view.selectedRange = view.displayRange(start: min(selection.start, (source as NSString).length), end: min(selection.end, (source as NSString).length))
      applying = false
      view.updatePlaceholder()
      view.invalidateIntrinsicContentSize()
    }

    /// Deferred: UIKit can move the selection while SwiftUI lays the field out, and the parent's
    /// state must not change during a view update.
    func reportSelection() {
      DispatchQueue.main.async { [weak self] in
        guard let self, let view = self.view else { return }
        let selection = view.sourceSelection()
        self.parent?.onSelection(selection.start, selection.end)
      }
    }

    func textViewDidChange(_ textView: UITextView) {
      guard !applying, let view else { return }
      let source = view.serializedText()
      // A space after `@README.md` turns it into a chip right away.
      apply(source, force: false)
      parent?.onChange(source)
      reportSelection()
      view.updatePlaceholder()
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
      guard !applying else { return }
      view?.resetTypingAttributes()
      reportSelection()
    }

    /// Return or Tab typed as text (software keyboards, dictated input) picks the highlighted
    /// suggestion while the list shows.
    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
      guard text == "\n" || text == "\t", range.length == 0, textView.markedTextRange == nil,
        let keys = parent?.suggestionKeys
      else { return true }
      keys.accept()
      return false
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
      if parent?.focused == false { parent?.focused = true }
    }

    func textViewDidEndEditing(_ textView: UITextView) {
      if parent?.focused == true { parent?.focused = false }
    }

    func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? { nil }
  }
}

/// One chip: the attachment remembers the source text it replaced.
nonisolated final class ComposerChipAttachment: NSTextAttachment {
  let token: ComposerInlineToken

  init(token: ComposerInlineToken, image: UIImage, baselineOffset: CGFloat) {
    self.token = token
    super.init(data: nil, ofType: nil)
    self.image = image
    bounds = CGRect(x: 0, y: baselineOffset, width: image.size.width, height: image.size.height)
  }

  required init?(coder: NSCoder) { nil }
}

final class ComposerUITextView: UITextView {
  var onSubmit: (() -> Void)?
  var suggestionKeys: ComposerSuggestionKeys?
  var modelLabels: [String: String] = [:]
  /// Focus asked for before the view had a window (a sheet's field focused on appear).
  var wantsFocus = false
  var placeholder = "" {
    didSet { placeholderLabel.text = placeholder }
  }

  private let placeholderLabel = UILabel()

  override init(frame: CGRect, textContainer: NSTextContainer?) {
    super.init(frame: frame, textContainer: textContainer)
    placeholderLabel.font = Typography.uiFont(.body)
    placeholderLabel.adjustsFontForContentSizeCategory = true
    placeholderLabel.textColor = UIColor(Palette.textTertiary)
    placeholderLabel.isAccessibilityElement = false
    placeholderLabel.numberOfLines = 1
    addSubview(placeholderLabel)
    registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitPreferredContentSizeCategory.self, ThemeTrait.self]) {
      (view: ComposerUITextView, _: UITraitCollection) in
      view.rerenderChips()
    }
  }

  required init?(coder: NSCoder) { nil }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if wantsFocus, window != nil, !isFirstResponder { DispatchQueue.main.async { self.becomeFirstResponder() } }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    placeholderLabel.frame = CGRect(x: textContainerInset.left, y: textContainerInset.top, width: bounds.width, height: placeholderLabel.font.lineHeight)
  }

  func updatePlaceholder() {
    placeholderLabel.isHidden = attributedText.length > 0
  }

  // MARK: Accessibility (UI tests read the draft, not attachment characters)

  override var accessibilityValue: String? {
    get {
      let source = serializedText()
      return source.isEmpty ? placeholder : source
    }
    set { super.accessibilityValue = newValue }
  }

  // MARK: Keys

  override var keyCommands: [UIKeyCommand]? {
    var commands = super.keyCommands ?? []
    guard markedTextRange == nil else { return commands }
    let send = UIKeyCommand(input: "\r", modifierFlags: .command, action: #selector(submit))
    send.wantsPriorityOverSystemBehavior = true
    commands.append(send)
    // Plain Return and Tab never reach `pressesBegan` from a hardware keyboard, and key commands
    // are cached, so these are always listed; `canPerformAction` claims them only while the list
    // shows and nothing is being composed, otherwise the key types as usual.
    for (input, action) in [("\r", #selector(returnKey)), ("\t", #selector(tabKey)), (UIKeyCommand.inputEscape, #selector(escapeKey))] {
      let command = UIKeyCommand(input: input, modifierFlags: [], action: action)
      command.wantsPriorityOverSystemBehavior = true
      commands.append(command)
    }
    return commands
  }

  @objc private func submit() { onSubmit?() }

  @objc private func returnKey() { suggestionKeys?.accept() }

  @objc private func escapeKey() { suggestionKeys?.dismiss() }

  /// Return, Tab and Escape belong to the list only while it shows rows; otherwise they type, move
  /// focus or close a sheet as usual.
  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(escapeKey) || action == #selector(returnKey) || action == #selector(tabKey) {
      return suggestionKeys != nil && markedTextRange == nil
    }
    return super.canPerformAction(action, withSender: sender)
  }

  @objc private func tabKey() { suggestionKeys?.accept() }

  /// While suggestions show, arrows move through them, Return and Tab pick, Escape closes. Key
  /// commands are cached per responder, so these are read from the presses instead.
  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    guard let keys = suggestionKeys, markedTextRange == nil, presses.count == 1, let key = presses.first?.key,
      key.modifierFlags.intersection([.command, .alternate, .control, .shift]).isEmpty
    else { return super.pressesBegan(presses, with: event) }
    switch key.keyCode {
    case .keyboardUpArrow: keys.move(-1)
    case .keyboardDownArrow: keys.move(1)
    case .keyboardReturnOrEnter, .keyboardReturn, .keyboardTab: keys.accept()
    case .keyboardEscape: keys.dismiss()
    default: return super.pressesBegan(presses, with: event)
    }
  }

  // MARK: Chips delete, copy and cut as their source

  override func deleteBackward() {
    let range = selectedRange
    if range.length == 0, range.location > 0,
      textStorage.attribute(.attachment, at: range.location - 1, effectiveRange: nil) is ComposerChipAttachment
    {
      replace(display: NSRange(location: range.location - 1, length: 1))
      return
    }
    super.deleteBackward()
  }

  override func copy(_ sender: Any?) {
    guard selectedRange.length > 0 else { return super.copy(sender) }
    UIPasteboard.general.string = serializedText(in: selectedRange)
  }

  override func cut(_ sender: Any?) {
    guard isEditable, selectedRange.length > 0 else { return super.cut(sender) }
    copy(sender)
    replace(display: selectedRange)
  }

  private func replace(display range: NSRange) {
    guard let start = position(from: beginningOfDocument, offset: range.location),
      let end = position(from: start, offset: range.length), let textRange = textRange(from: start, to: end)
    else { return }
    replace(textRange, withText: "")
  }

  // MARK: Source and display offsets

  func serializedText() -> String { serializedText(in: NSRange(location: 0, length: attributedText.length)) }

  func serializedText(in range: NSRange) -> String {
    guard range.length > 0 else { return "" }
    let result = NSMutableString()
    let string = attributedText.string as NSString
    attributedText.enumerateAttribute(.attachment, in: range) { value, run, _ in
      if let chip = value as? ComposerChipAttachment {
        // An attachment run holds one character per chip.
        for _ in 0..<run.length { result.append(chip.token.source) }
      } else {
        result.append(string.substring(with: run))
      }
    }
    return result as String
  }

  func renderedTokens() -> [ComposerInlineToken] {
    var result: [ComposerInlineToken] = []
    attributedText.enumerateAttribute(.attachment, in: NSRange(location: 0, length: attributedText.length)) { value, _, _ in
      if let chip = value as? ComposerChipAttachment { result.append(chip.token) }
    }
    return result
  }

  func sourceOffset(display: Int) -> Int {
    let bounded = max(0, min(attributedText.length, display))
    var offset = 0
    attributedText.enumerateAttribute(.attachment, in: NSRange(location: 0, length: bounded)) { value, run, _ in
      if let chip = value as? ComposerChipAttachment {
        offset += (chip.token.source as NSString).length * run.length
      } else {
        offset += run.length
      }
    }
    return offset
  }

  /// The display offset for a source offset; one inside a chip snaps to the chip's end.
  func displayOffset(source: Int) -> Int {
    var display = 0
    var consumed = 0
    var found: Int?
    attributedText.enumerateAttribute(.attachment, in: NSRange(location: 0, length: attributedText.length)) { value, run, stop in
      if let chip = value as? ComposerChipAttachment {
        let length = (chip.token.source as NSString).length
        for index in 0..<run.length {
          if source <= consumed { found = display + index; stop.pointee = true; return }
          consumed += length
          if source < consumed { found = display + index + 1; stop.pointee = true; return }
        }
        display += run.length
      } else {
        if source <= consumed + run.length { found = display + (source - consumed); stop.pointee = true; return }
        consumed += run.length
        display += run.length
      }
    }
    return found ?? attributedText.length
  }

  func sourceSelection() -> (start: Int, end: Int) {
    (sourceOffset(display: selectedRange.location), sourceOffset(display: NSMaxRange(selectedRange)))
  }

  func displayRange(source: Int) -> NSRange { NSRange(location: displayOffset(source: source), length: 0) }

  func displayRange(start: Int, end: Int) -> NSRange {
    let lower = displayOffset(source: start)
    return NSRange(location: lower, length: max(0, displayOffset(source: end) - lower))
  }

  // MARK: Rendering

  private var baseAttributes: [NSAttributedString.Key: Any] {
    [.font: font ?? Typography.uiFont(.body), .foregroundColor: UIColor(Palette.textPrimary)]
  }

  func resetTypingAttributes() { typingAttributes = baseAttributes }

  func render(_ source: String, tokens: [ComposerInlineToken]) {
    let ns = source as NSString
    let result = NSMutableAttributedString()
    var cursor = 0
    for token in tokens where token.start >= cursor && token.end <= ns.length && token.end > token.start {
      guard ns.substring(with: NSRange(location: token.start, length: token.end - token.start)) == token.source else { continue }
      if token.start > cursor {
        result.append(NSAttributedString(string: ns.substring(with: NSRange(location: cursor, length: token.start - cursor)), attributes: baseAttributes))
      }
      result.append(chip(token))
      cursor = token.end
    }
    if cursor < ns.length {
      result.append(NSAttributedString(string: ns.substring(from: cursor), attributes: baseAttributes))
    }
    attributedText = result
    resetTypingAttributes()
  }

  private func rerenderChips() {
    let tokens = renderedTokens()
    guard !tokens.isEmpty, markedTextRange == nil else { return }
    let selection = sourceSelection()
    render(serializedText(), tokens: ComposerInlineTokens.editorTokens(serializedText(), preserveTrailing: tokens, knownModels: Set(modelLabels.keys)))
    selectedRange = displayRange(start: selection.start, end: selection.end)
  }

  private func chip(_ token: ComposerInlineToken) -> NSAttributedString {
    let font = Typography.uiFont(.body, traits: traitCollection)
    let chipFont = Typography.uiFont(size: font.pointSize, weight: .medium)
    let label: String
    let symbol: String
    switch token.kind {
    case .skill: (label, symbol) = (token.value, "sparkles")
    case .model: (label, symbol) = (modelLabels[token.value] ?? token.value, "cpu")
    case .mention: (label, symbol) = (ComposerInlineTokens.displayName(token.value), token.value.hasSuffix("/") ? "folder" : "doc.text")
    }
    let image = Self.renderChip(label: label, symbol: symbol, font: chipFont, traits: traitCollection, maxWidth: max(120, bounds.width - 8))
    let attachment = ComposerChipAttachment(token: token, image: image, baselineOffset: chipFont.descender - 1)
    attachment.accessibilityLabel = label
    let string = NSMutableAttributedString(attachment: attachment)
    string.addAttributes(baseAttributes, range: NSRange(location: 0, length: string.length))
    return string
  }

  static func renderChip(label: String, symbol: String, font: UIFont, traits: UITraitCollection, maxWidth: CGFloat) -> UIImage {
    let text = UIColor(Palette.textPrimary).resolvedColor(with: traits)
    let fill = UIColor(Palette.fill).resolvedColor(with: traits)
    let iconColor = UIColor(Palette.textSecondary).resolvedColor(with: traits)
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byTruncatingMiddle
    let attributed = NSAttributedString(string: label, attributes: [.font: font, .foregroundColor: text, .paragraphStyle: paragraph])
    let iconSide = font.pointSize * 0.85
    let horizontal: CGFloat = 6
    let gap: CGFloat = 4
    let height = ceil(font.lineHeight + 2)
    let labelWidth = min(ceil(attributed.size().width), maxWidth - horizontal * 2 - iconSide - gap)
    let size = CGSize(width: ceil(horizontal * 2 + iconSide + gap + labelWidth), height: height)
    let format = UIGraphicsImageRendererFormat.preferred()
    format.opaque = false
    let icon = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: iconSide, weight: .medium))?
      .withTintColor(iconColor, renderingMode: .alwaysOriginal)
    return UIGraphicsImageRenderer(size: size, format: format).image { _ in
      fill.setFill()
      UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: 7).fill()
      if let icon {
        let iconSize = icon.size
        icon.draw(in: CGRect(x: horizontal + (iconSide - iconSize.width) / 2, y: (height - iconSize.height) / 2, width: iconSize.width, height: iconSize.height))
      }
      attributed.draw(in: CGRect(x: horizontal + iconSide + gap, y: (height - font.lineHeight) / 2, width: labelWidth, height: font.lineHeight))
    }
  }
}
