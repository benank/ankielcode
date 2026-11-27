import AnkielKit
import SwiftUI

/// A pending question set, one question per step (RN `PendingUserInputCard`): the question in
/// markdown, its options as radio or check rows (description and preview under each), a free-text
/// answer when the provider takes one, and Previous / Next / Submit, or Dismiss when the answer
/// would only arrive as a message. Collapses to a bar so the feed can be read.
struct QuestionCardView: View {
  let input: PendingUserInput
  let header: RequestQueueHeader
  let controller: PendingRequestController
  let canAnswer: Bool
  let thread: ThreadRef

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var collapsed = false
  @FocusState private var typing: Bool

  private var index: Int { controller.page(input) }
  private var question: UserInputQuestion? { input.questions.indices.contains(index) ? input.questions[index] : nil }
  private var isLast: Bool { index >= input.questions.count - 1 }
  private var drafts: [String: UserInputDraft] { controller.drafts(for: input) }
  private var sending: Bool { controller.isSending(input.requestId) }
  private var disabled: Bool { !input.canRespond || !canAnswer || sending }

  private var answered: Bool {
    guard let question else { return false }
    return UserInputAnswers.answer(question, drafts[question.id]) != nil
  }

  private var complete: Bool { UserInputAnswers.answers(input.questions, drafts) != nil }

  private var error: EnvironmentRequestError? {
    if case .failed(let error) = controller.phase(input.requestId) { error } else { nil }
  }

  var body: some View {
    Group {
      if collapsed {
        collapsedBar
      } else {
        card
      }
    }
    .motion(Motion.snappy, value: collapsed)
    .accessibilityIdentifier("request.question")
  }

  private var title: String {
    if let header = question?.header, !header.isEmpty { return header }
    return String(localized: "User input needed")
  }

  private var card: some View {
    RequestCardChrome(
      title: title, symbol: "questionmark.bubble", subtitle: stepLabel, header: header,
      accessory: AnyView(collapseButton(expanded: true))
    ) {
      if input.questions.count > 1 { StepDots(count: input.questions.count, current: index) }
      if let question {
        QuestionBody(
          question: question, draft: drafts[question.id], disabled: disabled, typing: $typing, isLast: isLast,
          toggle: { value in
            controller.toggle(value, question: question, in: input)
            Haptics.selection()
          },
          setText: { controller.setText($0, question: question, in: input) },
          submit: advance)
        .id("\(input.requestId):\(question.id)")
      }
    } actions: {
      VStack(alignment: .leading, spacing: Spacing.sm) {
        HStack(spacing: Spacing.md) {
          if index > 0 {
            RequestButton(title: String(localized: "Previous", comment: "goes to the previous question"), role: .quiet, disabled: sending, identifier: "question.previous") {
              go(index - 1)
            }
            .fixedSize()
          } else if input.dismissible {
            RequestButton(title: String(localized: "Dismiss"), role: .quiet, sending: controller.phase(input.requestId) == .sending(choice: "dismiss"), disabled: disabled, identifier: "question.dismiss") {
              Task { await controller.dismiss(input, thread: thread) }
            }
            .fixedSize()
            .accessibilityLabel(Text("Dismiss without answering"))
          }
          Spacer(minLength: 0)
          if isLast {
            RequestButton(
              title: String(localized: "Submit", comment: "verb, submits answers"), role: .primary,
              sending: controller.phase(input.requestId) == .sending(choice: "answers"), disabled: disabled || !complete,
              identifier: "question.submit"
            ) {
              submit()
            }
            .frame(maxWidth: 200)
            .accessibilityLabel(Text("Submit answers"))
          } else {
            RequestButton(title: String(localized: "Next", comment: "goes to the next question"), role: .primary, disabled: disabled || !answered, identifier: "question.next") {
              go(index + 1)
            }
            .frame(maxWidth: 200)
          }
        }
        if !input.canRespond {
          RequestFootnote(text: RequestCopy.notResumable)
        } else if !canAnswer {
          RequestFootnote(text: String(localized: "This connection cannot submit answers."))
        }
        if let error {
          RequestFootnote(text: RequestCopy.failure(error, fallback: String(localized: "Could not send your answers. Try again.")), isError: true)
        }
      }
    }
  }

  private var stepLabel: String? {
    input.questions.count > 1 ? String(localized: "Question \(index + 1) of \(input.questions.count)") : nil
  }

  private var collapsedBar: some View {
    Button {
      collapsed = false
    } label: {
      HStack(spacing: Spacing.sm) {
        Image(systemName: "questionmark.bubble").foregroundStyle(Palette.attention)
        Text("User input needed").font(Typography.subheadline.weight(.semibold)).foregroundStyle(Palette.textPrimary)
        Text("^[\(input.questions.count) question](inflect: true)").font(Typography.footnote).foregroundStyle(Palette.textSecondary)
        Spacer(minLength: 0)
        Image(systemName: "chevron.up").font(Typography.footnote.weight(.semibold)).foregroundStyle(Palette.textTertiary)
      }
      .padding(.horizontal, Spacing.lg)
      .frame(minHeight: 52)
      .frame(maxWidth: Layout.readingWidth)
      .contentShape(.capsule)
    }
    .buttonStyle(.plain)
    .chromeGlass(interactive: true)
    .accessibilityLabel(Text("Expand user input, ^[\(input.questions.count) question](inflect: true)"))
    .accessibilityIdentifier("question.expand")
  }

  private func collapseButton(expanded: Bool) -> some View {
    Button {
      typing = false
      collapsed = true
    } label: {
      Image(systemName: "chevron.down")
        .font(Typography.footnote.weight(.semibold))
        .foregroundStyle(Palette.textTertiary)
        .frame(width: 44, height: 44)
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .padding(.vertical, -Spacing.md)
    .accessibilityLabel(Text("Collapse user input"))
  }

  private func go(_ page: Int) {
    withMotion(Motion.snappy, reduceMotion: reduceMotion) { controller.pages[input.requestId] = page }
  }

  /// Return in a single-line answer moves on: to the next question, or submits on the last.
  private func advance() {
    if isLast {
      if complete { submit() }
    } else if answered {
      go(index + 1)
    }
  }

  private func submit() {
    typing = false
    Task { await controller.submit(input, thread: thread) }
  }
}

/// One question's text, options and free-text answer.
private struct QuestionBody: View {
  let question: UserInputQuestion
  let draft: UserInputDraft?
  let disabled: Bool
  var typing: FocusState<Bool>.Binding
  let isLast: Bool
  let toggle: (String) -> Void
  let setText: @MainActor @Sendable (String) -> Void
  let submit: () -> Void

  @Environment(AppModel.self) private var model

  private var multiline: Bool { question.initialAnswer != nil }

  var body: some View {
    VStack(alignment: .leading, spacing: Spacing.md) {
      MarkdownView(document: QuestionMarkdown.parse(question.question, style: model.registry.markdownStyle))
        .accessibilityIdentifier("question.text")
      let options = question.options.elements
      if !options.isEmpty {
        VStack(spacing: 0) {
          ForEach(Array(options.enumerated()), id: \.offset) { index, option in
            if index > 0 { Divider().padding(.leading, 44) }
            OptionRow(
              option: option, multiSelect: question.multiSelect == true,
              selected: UserInputAnswers.isSelected(question, draft, UserInputAnswers.optionValue(option)), disabled: disabled
            ) {
              typing.wrappedValue = false
              toggle(UserInputAnswers.optionValue(option))
            }
          }
        }
        .background(Palette.surface, in: .rect(cornerRadius: Radius.medium, style: .continuous))
        .overlay {
          RoundedRectangle(cornerRadius: Radius.medium, style: .continuous).strokeBorder(Palette.separator, lineWidth: 0.5)
        }
      }
      if question.allowCustomAnswer != false {
        TextField(
          options.isEmpty ? String(localized: "Type your answer") : String(localized: "Or type a custom answer"),
          text: Binding(get: { draft?.customAnswer ?? "" }, set: setText),
          axis: multiline ? .vertical : .horizontal
        )
        .lineLimit(multiline ? 2...8 : 1...1)
        .font(Typography.body)
        .focused(typing)
        .submitLabel(isLast ? .send : .next)
        // A suggested answer (a commit message, say) is multi-line: Return adds a line there.
        .onSubmit { if !multiline { submit() } }
        .disabled(disabled)
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, Spacing.md)
        .frame(minHeight: 48)
        .background(Palette.surface, in: .rect(cornerRadius: Radius.field, style: .continuous))
        .overlay {
          RoundedRectangle(cornerRadius: Radius.field, style: .continuous)
            .strokeBorder(typing.wrappedValue ? Palette.textTertiary : Palette.separator, lineWidth: typing.wrappedValue ? 1 : 0.5)
        }
        .accessibilityIdentifier("question.field")
      }
    }
  }
}

private struct OptionRow: View {
  let option: UserInputQuestion.Option
  let multiSelect: Bool
  let selected: Bool
  let disabled: Bool
  let action: () -> Void

  @Environment(AppModel.self) private var model

  var body: some View {
    Button(action: action) {
      HStack(alignment: .top, spacing: Spacing.md) {
        indicator
          .frame(width: 22, height: 22)
          .padding(.top, 1)
        VStack(alignment: .leading, spacing: Spacing.xxs) {
          Text(option.label)
            .font(Typography.body.weight(.medium))
            .foregroundStyle(Palette.textPrimary)
          if !option.description.isEmpty, option.description != option.label {
            Text(option.description)
              .font(Typography.subheadline)
              .foregroundStyle(Palette.textSecondary)
          }
          if let preview = option.preview, !preview.isEmpty {
            MarkdownView(document: QuestionMarkdown.parse(preview, style: model.registry.markdownStyle))
              .padding(.top, Spacing.xxs)
          }
        }
        .multilineTextAlignment(.leading)
        .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, Spacing.md)
      .padding(.vertical, Spacing.md)
      .frame(minHeight: 48)
      .background(selected ? Palette.fill : .clear)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .accessibilityAddTraits(selected ? [.isSelected] : [])
    .accessibilityHint(multiSelect ? Text("Checkbox") : Text("Option"))
    .accessibilityIdentifier("question.option.\(option.label)")
  }

  @ViewBuilder
  private var indicator: some View {
    if multiSelect {
      Image(systemName: selected ? "checkmark.square.fill" : "square")
        .font(.title3)
        .foregroundStyle(selected ? Palette.textPrimary : Palette.textTertiary)
        .contentTransition(.symbolEffect(.replace))
    } else {
      Image(systemName: selected ? "largecircle.fill.circle" : "circle")
        .font(.title3)
        .foregroundStyle(selected ? Palette.textPrimary : Palette.textTertiary)
        .contentTransition(.symbolEffect(.replace))
    }
  }
}

/// Progress through a multi-question form.
private struct StepDots: View {
  let count: Int
  let current: Int

  var body: some View {
    HStack(spacing: Spacing.xs) {
      ForEach(0..<count, id: \.self) { index in
        Capsule()
          .fill(index <= current ? Palette.textPrimary : Palette.separator)
          .frame(height: 3)
      }
    }
    .accessibilityHidden(true)
    .motion(Motion.micro, value: current)
  }
}

/// Question text and previews are short; parse them on demand with one shared parser.
@MainActor
enum QuestionMarkdown {
  private static var parsers: [String: MarkdownParser] = [:]

  static func parse(_ text: String, style: MarkdownStyle) -> MarkdownDocument {
    let parser = parsers["default"] ?? MarkdownParser(style: style, cacheLimit: 200)
    parsers["default"] = parser
    return parser.parse(text)
  }
}
