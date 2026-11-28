import AnkielKit
import SwiftUI
import UIKit

/// A thread's terminal (RN `ThreadTerminalRouteScreen`): picks the terminal (the one asked for,
/// else the thread's running one, else `term-1`), waits for the list so an existing shell keeps
/// its folder, then shows it. Switching terminals swaps the whole session.
struct TerminalScreen: View {
  let presenter: TerminalPresenter
  let requested: String?
  @State private var chosen: String?
  @Environment(\.dismiss) private var dismiss

  private var terminalId: String? {
    if let chosen { return chosen }
    if let requested { return requested }
    guard let terminals = presenter.directory.terminals else {
      // Without `terminal:read` there is no list to wait for.
      return presenter.canOperate && !presenter.readable ? defaultTerminalId : nil
    }
    return TerminalMenu.bootstrap(terminals, threadId: presenter.ref.threadId) ?? defaultTerminalId
  }

  var body: some View {
    Group {
      if !presenter.canOperate {
        TerminalNotice(
          title: "Terminal access unavailable",
          detail: "This connection does not have permission to view terminals.")
      } else if presenter.workspace == nil {
        TerminalNotice(
          title: "Terminal unavailable",
          detail: "This thread does not have a workspace root yet, so there is nowhere to open a shell.")
      } else if let terminalId, let location = presenter.location(for: terminalId) {
        TerminalSessionView(
          presenter: presenter, terminalId: terminalId, location: location,
          select: { chosen = $0 }, leave: { dismiss() }
        )
        .id(terminalId)
      } else if !presenter.isConnected {
        TerminalNotice(title: "Not connected", detail: "The terminal opens when this computer reconnects.")
      } else {
        TerminalNotice(title: "Loading terminals", detail: "Reading existing terminal sessions.", loading: true)
      }
    }
    // The first terminal chosen stays: a list that changes must not swap the shell on screen.
    .onChange(of: terminalId, initial: true) { _, id in
      if chosen == nil, let id { chosen = id }
    }
    .navigationTitle(Text("Terminal", comment: "screen title"))
    .navigationBarTitleDisplayMode(.inline)
    .onAppear { presenter.directory.start() }
  }
}

/// One terminal, attached while shown.
private struct TerminalSessionView: View {
  let presenter: TerminalPresenter
  let terminalId: String
  let select: (String) -> Void
  let leave: () -> Void
  @State private var session: TerminalSessionModel
  @State private var modifier: TerminalModifier?
  @State private var focused = false
  @State private var selection: SelectedText?
  @State private var confirmingClose = false
  @State private var closeFailed = false
  @State private var bell = 0
  @State private var surface = TerminalSurfaceController()
  @Environment(AppModel.self) private var model
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.themeSelection) private var theme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.openURL) private var openURL

  init(
    presenter: TerminalPresenter, terminalId: String, location: TerminalLocation, select: @escaping (String) -> Void,
    leave: @escaping () -> Void
  ) {
    self.presenter = presenter
    self.terminalId = terminalId
    self.select = select
    self.leave = leave
    let target = TerminalTarget(
      environmentId: presenter.ref.environmentId, threadId: presenter.ref.threadId, terminalId: terminalId)
    _session = State(initialValue: TerminalSessionModel(target: target, location: location, host: presenter.host))
  }

  private var palette: TerminalPalette { TerminalPalette(dark: colorScheme == .dark, theme: theme) }

  private var config: TerminalSurfaceView.Config {
    TerminalSurfaceView.Config(palette: palette, fontSize: TerminalText.size(model.preferences), blink: !reduceMotion)
  }

  var body: some View {
    ZStack(alignment: .bottomTrailing) {
      Color(uiColor: palette.backgroundColor).ignoresSafeArea()
      VStack(spacing: 0) {
        TerminalSurface(
          session: session, controller: surface, config: config, focused: $focused,
          onInput: input, onBell: { bell += 1 }, onOpenURL: { openURL($0) },
          onSelectText: { selection = SelectedText(text: $0) }
        )
        .overlay { overlay }
        if focused {
          TerminalAccessoryBar(
            platform: presenter.host.platform, modifier: $modifier, palette: palette,
            send: accessoryKey, paste: { surface.paste(UIPasteboard.general.string) },
            dismissKeyboard: { focused = false })
          .transition(.move(edge: .bottom).combined(with: .opacity))
        }
      }
      if !focused, session.isLive {
        Button {
          focused = true
        } label: {
          Image(systemName: "keyboard")
            .font(Typography.title)
            .frame(width: 48, height: 48)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .accessibilityLabel(Text("Show keyboard"))
        .accessibilityIdentifier("terminal.showKeyboard")
        .padding(Spacing.lg)
        .transition(.scale(scale: 0.8).combined(with: .opacity))
      }
    }
    .motion(Motion.micro, value: focused)
    .sensoryFeedback(.impact(weight: .light), trigger: bell)
    .toolbar { toolbar }
    .navigationSubtitle(subtitle)
    .sheet(item: $selection) { selected in
      TerminalTextSelection(text: selected.text, fontSize: config.fontSize)
    }
    .confirmationDialog(
      Text("Close terminal \"\(TerminalCopy.name(name))\"?"), isPresented: $confirmingClose, titleVisibility: .visible
    ) {
      Button("Close terminal", role: .destructive) { Task { await close() } }
    } message: {
      Text("This stops the running process and clears its history.")
    }
    .alert(Text("Couldn't close terminal"), isPresented: $closeFailed) {
      Button("OK", role: .cancel) {}
    } message: {
      Text("Check the connection and try again.")
    }
    .onAppear {
      session.onExit = { exited() }
      session.start()
      TerminalDebug.applyToSession(session, focus: { focused = true }, paste: { surface.paste($0) }, select: { selection = SelectedText(text: surface.viewportText ?? "") })
    }
    .onDisappear { session.stop() }
  }

  private var name: TerminalName {
    TerminalMenu.name(terminalId, label: session.label, hasRunningSubprocess: session.hasRunningSubprocess)
  }

  private var subtitle: String {
    [presenter.workspace?.title, session.version > 0 ? TerminalCopy.status(session.status, running: session.hasRunningSubprocess) : nil]
      .compactMap(\.self).joined(separator: " · ")
  }

  @ViewBuilder private var overlay: some View {
    switch session.phase {
    case .waiting where session.version == 0:
      TerminalNotice(
        title: presenter.isConnected ? "Opening terminal…" : "Not connected",
        detail: presenter.isConnected ? nil : "The terminal opens when this computer reconnects.",
        loading: presenter.isConnected)
    case .attaching where session.version == 0:
      TerminalNotice(title: "Opening terminal…", detail: nil, loading: true)
    case .failed(let message):
      TerminalNotice(title: "Terminal unavailable", message: message) {
        Button("Try again") { session.restart() }
          .buttonStyle(.glass)
      }
    default:
      if session.status == .error, let error = session.error {
        TerminalNotice(title: "Terminal unavailable", message: error)
      }
    }
  }

  @ToolbarContentBuilder private var toolbar: some ToolbarContent {
    ToolbarItem(placement: .topBarTrailing) {
      Menu {
        Section {
          Button {
            TerminalText.step(model.preferences, by: -1)
          } label: {
            Text("A- \(TerminalText.label(TerminalText.size(model.preferences) - 1)) pt")
          }
          .disabled(TerminalText.size(model.preferences) <= TerminalText.range.lowerBound)
          Button {
            TerminalText.step(model.preferences, by: 1)
          } label: {
            Text("A+ \(TerminalText.label(TerminalText.size(model.preferences) + 1)) pt")
          }
          .disabled(TerminalText.size(model.preferences) >= TerminalText.range.upperBound)
        } header: {
          Text("Text size")
        }
        Section {
          ForEach(entries) { entry in
            Button {
              select(entry.terminalId)
            } label: {
              Label(TerminalCopy.name(entry.name), systemImage: entry.terminalId == terminalId ? "checkmark" : "apple.terminal")
              Text(TerminalCopy.subtitle(entry))
            }
          }
          Button {
            select(presenter.newTerminalId(active: terminalId))
          } label: {
            Label("Open new terminal", systemImage: "plus")
            if let folder = TerminalMenu.basename(presenter.workspace?.root) {
              Text("Start another shell in \(folder)")
            } else {
              Text("Start another shell in this workspace")
            }
          }
          .accessibilityIdentifier("terminal.new")
        }
        Section {
          Button("Clear", systemImage: "eraser") {
            modifier = nil
            session.clear()
          }
          .disabled(!session.isLive)
          Button("Close terminal", systemImage: "xmark.circle", role: .destructive) { confirmingClose = true }
            .accessibilityIdentifier("terminal.close")
        }
      } label: {
        Label {
          Text("Terminal options")
        } icon: {
          Image(systemName: "ellipsis")
        }
      }
      .accessibilityIdentifier("terminal.menu")
    }
  }

  private var entries: [TerminalMenuEntry] {
    let current = TerminalMenuEntry(
      terminalId: terminalId, cwd: session.cwd, status: session.version > 0 ? session.status : .starting,
      hasRunningSubprocess: session.hasRunningSubprocess, name: name)
    return presenter.directory.entries(threadId: presenter.ref.threadId, current: current)
  }

  // MARK: Input

  private func input(_ data: String) {
    guard let held = modifier else {
      session.write(data)
      return
    }
    modifier = nil
    switch TerminalInput.resolve(data, modifier: held, host: presenter.host.platform) {
    case .paste: surface.paste(UIPasteboard.general.string)
    case .write(let resolved): session.write(resolved)
    }
  }

  private func accessoryKey(_ data: String) {
    surface.resetInput()
    input(data)
  }

  private func exited() {
    let live = presenter.directory.entries(threadId: presenter.ref.threadId)
    if let next = TerminalMenu.previousLive(live, exited: terminalId) {
      select(next)
    } else {
      leave()
    }
  }

  private func close() async {
    do {
      try await session.close()
    } catch {
      closeFailed = true
    }
  }
}

private struct SelectedText: Identifiable {
  let id = UUID()
  let text: String
}

/// The terminal's text size: the code font size setting, a little smaller (RN's terminal default
/// is 10.5 pt next to 13 pt code), in RN's 6–14 pt range.
@MainActor
enum TerminalText {
  static let range: ClosedRange<Double> = 6...14

  static func size(_ preferences: ClientPreferences) -> Double {
    min(max((preferences.values.codeFontSize ?? ClientPreferenceValues.defaultCodeFontSize) - 2.5, range.lowerBound), range.upperBound)
  }

  static func step(_ preferences: ClientPreferences, by delta: Double) {
    let code = preferences.values.codeFontSize ?? ClientPreferenceValues.defaultCodeFontSize
    let next = min(max(code + delta, ClientPreferenceValues.codeFontSizes.lowerBound), ClientPreferenceValues.codeFontSizes.upperBound)
    preferences.values.codeFontSize = next
  }

  static func label(_ size: Double) -> String {
    min(max(size, range.lowerBound), range.upperBound).formatted(.number.precision(.fractionLength(1)))
  }
}

/// A centered state over the terminal's background.
struct TerminalNotice<Actions: View>: View {
  let title: Text
  let detail: Text?
  var loading = false
  let actions: Actions

  var body: some View {
    VStack(spacing: Spacing.md) {
      if loading { ProgressView() }
      title
        .font(Typography.headline)
        .foregroundStyle(Palette.textPrimary)
      if let detail {
        detail
          .font(Typography.subheadline)
          .foregroundStyle(Palette.textSecondary)
          .multilineTextAlignment(.center)
      }
      actions
    }
    .padding(Spacing.xl)
    .frame(maxWidth: 420)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

extension TerminalNotice where Actions == EmptyView {
  init(title: LocalizedStringKey, detail: LocalizedStringKey?, loading: Bool = false) {
    self.title = Text(title)
    self.detail = detail.map { Text($0) }
    self.loading = loading
    actions = EmptyView()
  }

  /// A refusal in the server's own words.
  init(title: LocalizedStringKey, message: String) {
    self.init(title: title, message: message) { EmptyView() }
  }
}

extension TerminalNotice {
  init(title: LocalizedStringKey, message: String, @ViewBuilder actions: () -> Actions) {
    self.title = Text(title)
    detail = message.isEmpty ? nil : Text(verbatim: message)
    self.actions = actions()
  }
}
