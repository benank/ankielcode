import SwiftUI

/// What feed rows read from the thread screen's environment. Cells are hosted outside SwiftUI's
/// tree, so they see only what is copied in here (copying all of `EnvironmentValues` hid the rows
/// from accessibility). A row that reads a new environment value needs a field here, or the value
/// is silently missing in the feed.
struct FeedRowEnvironment {
  var app: AppModel?
  var files: FilePresenter?
  var review: ReviewPresenter?
  var gitQuickAction: GitQuickActionRunner?
  var preview: PreviewPresenter?
  var terminal: TerminalPresenter?
  var codeAppearance = CodeAppearance()
  var openURL: OpenURLAction?

  init() {}

  init(_ environment: EnvironmentValues, app: AppModel) {
    self.app = app
    files = environment.filePresenter
    review = environment.reviewPresenter
    gitQuickAction = environment.runGitQuickAction
    preview = environment.previewPresenter
    terminal = environment.terminalPresenter
    codeAppearance = environment.codeAppearance
    openURL = environment.openURL
  }

  /// Whether built cells must be rebuilt: a presenter appeared, was replaced, or the code style
  /// changed. (`openURL` is rebuilt on every render and follows the presenters it wraps.)
  func needsReconfigure(from old: Self) -> Bool {
    old.app !== app || old.files !== files || old.review !== review || old.preview !== preview
      || old.terminal !== terminal || (old.gitQuickAction == nil) != (gitQuickAction == nil)
      || old.codeAppearance != codeAppearance
  }
}

extension View {
  /// Gives a feed cell's row the thread screen's environment.
  func feedRowEnvironment(_ values: FeedRowEnvironment) -> some View {
    modifier(FeedRowEnvironmentModifier(values: values))
  }
}

private struct FeedRowEnvironmentModifier: ViewModifier {
  let values: FeedRowEnvironment

  func body(content: Content) -> some View {
    let base =
      content
      .environment(\.filePresenter, values.files)
      .environment(\.reviewPresenter, values.review)
      .environment(\.runGitQuickAction, values.gitQuickAction)
      .environment(\.previewPresenter, values.preview)
      .environment(\.terminalPresenter, values.terminal)
      .environment(\.codeAppearance, values.codeAppearance)
    if let openURL = values.openURL {
      base.environment(\.openURL, openURL).environment(values.app)
    } else {
      base.environment(values.app)
    }
  }
}
