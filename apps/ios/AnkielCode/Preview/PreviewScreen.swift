import AnkielKit
import SwiftUI

/// A computer's localhost page on this device (RN `LocalPreviewScreen`): the page under the
/// navigation bar, an address bar with back, forward and reload floating at the bottom, and a
/// clear state when the tunnel cannot carry it.
struct PreviewScreen: View {
  let presenter: PreviewPresenter
  let initial: URL?
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @State private var browser: PreviewBrowser?
  @State private var draft = ""
  @State private var invalidAddress = false
  @FocusState private var editing: Bool

  var body: some View {
    NavigationStack {
      Group {
        if let browser {
          content(browser)
        } else {
          Palette.canvas
        }
      }
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { toolbar }
    }
    .onAppear {
      guard browser == nil else { return }
      let created = PreviewBrowser(environmentId: presenter.ref.environmentId, registry: presenter.registry, initial: initial)
      browser = created
      PreviewDebug.apply(to: created)
    }
    .alert("Could not open this address", isPresented: $invalidAddress) {
      Button("OK", role: .cancel) {}
    } message: {
      Text("Enter an http or https URL.")
    }
  }

  private var title: String {
    guard let browser, browser.address != nil else { return String(localized: "Browser", comment: "screen title") }
    if !browser.title.isEmpty { return browser.title }
    return browser.address.map(PreviewURLs.hostAndPort) ?? ""
  }

  @ViewBuilder
  private func content(_ browser: PreviewBrowser) -> some View {
    ZStack {
      Palette.canvas.ignoresSafeArea()
      if browser.isReady {
        PreviewWebView(browser: browser)
          .ignoresSafeArea(edges: .bottom)
          .opacity(browser.address == nil ? 0 : 1)
      }
      if let state = overlay(browser) {
        PreviewStateView(state: state, environment: presenter.environmentLabel, diagnostics: browser.diagnostics) {
          browser.reload()
        }
        .transition(.opacity)
      } else if browser.address == nil {
        PreviewStartPage(tabs: presenter.serverTabs) { tab in
          if let url = PreviewURLs.localPreviewURLForDevice(tab.url) { browser.navigate(url) }
        }
      }
    }
    .overlay(alignment: .top) {
      if browser.isLoading, browser.failure == nil {
        ProgressView(value: browser.progress)
          .progressViewStyle(.linear)
          .tint(Palette.accent)
          .accessibilityLabel(Text("Loading page"))
      }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) { addressBar(browser) }
    .motion(Motion.micro, value: overlay(browser))
    .sensoryFeedback(.error, trigger: browser.failure) { _, new in new != nil }
    .onChange(of: browser.address, initial: true) { _, address in
      if !editing { draft = address?.absoluteString ?? "" }
    }
  }

  private func overlay(_ browser: PreviewBrowser) -> PreviewStateView.State? {
    if presenter.tunnelOff { return .tunnelOff }
    if presenter.permissionMissing { return .failure(.tunnel(.permission), address: browser.address) }
    return browser.failure.map { .failure($0, address: browser.address) }
  }

  // MARK: Address bar

  private func addressBar(_ browser: PreviewBrowser) -> some View {
    GlassEffectContainer(spacing: Spacing.sm) {
      HStack(spacing: Spacing.sm) {
        if !editing {
          HStack(spacing: 0) {
            barButton("Back", systemImage: "chevron.backward", id: "preview.back") { browser.goBack() }
              .disabled(!browser.canGoBack)
            barButton("Forward", systemImage: "chevron.forward", id: "preview.forward") { browser.goForward() }
              .disabled(!browser.canGoForward)
          }
          .glassEffect(.regular.interactive(), in: .capsule)
          .transition(.opacity)
        }
        HStack(spacing: Spacing.xs) {
          Image(systemName: browser.address.map(PreviewLoopback.standIn).map(PreviewLoopback.isTunnelled) == true ? "desktopcomputer" : "globe")
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
            .accessibilityHidden(true)
          TextField("Enter a localhost address", text: $draft)
            .keyboardType(.URL)
            .textContentType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.go)
            .focused($editing)
            .font(Typography.callout)
            .onSubmit { submit(browser) }
            .accessibilityLabel(Text("Address"))
            .accessibilityIdentifier("preview.address")
          if editing, !draft.isEmpty {
            Button("Clear", systemImage: "xmark.circle.fill") { draft = "" }
              .labelStyle(.iconOnly)
              .foregroundStyle(Palette.textTertiary)
              .frame(minWidth: 44, minHeight: 44)
          } else if !editing, browser.address != nil {
            if browser.isLoading {
              barButton("Stop loading", systemImage: "xmark", id: "preview.stop") { browser.stop() }
            } else {
              barButton("Reload", systemImage: "arrow.clockwise", id: "preview.reload") { browser.reload() }
            }
          }
        }
        .padding(.leading, Spacing.md)
        .frame(minHeight: 44)
        .glassEffect(.regular.interactive(), in: .capsule)
      }
      .padding(.horizontal, Spacing.md)
      .padding(.bottom, Spacing.sm)
      .padding(.top, Spacing.xs)
    }
    .motion(Motion.snappy, value: editing)
    .onChange(of: editing) { _, editing in
      if !editing { draft = browser.address?.absoluteString ?? "" }
    }
  }

  private func barButton(_ title: LocalizedStringKey, systemImage: String, id: String, action: @escaping () -> Void) -> some View {
    Button(title, systemImage: systemImage, action: action)
      .labelStyle(.iconOnly)
      .font(Typography.body.weight(.medium))
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(.rect)
      .accessibilityIdentifier(id)
  }

  private func submit(_ browser: PreviewBrowser) {
    guard let url = try? PreviewURLs.normalize(draft) else {
      invalidAddress = true
      return
    }
    editing = false
    browser.navigate(PreviewURLs.loopbackURLForDevice(url.absoluteString) ?? url)
  }

  // MARK: Toolbar

  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    ToolbarItem(placement: .cancellationAction) {
      Button("Close browser", systemImage: "xmark") { dismiss() }
        .accessibilityIdentifier("preview.close")
    }
    if let browser, let address = browser.address {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          ShareLink(item: address) { Label("Share", systemImage: "square.and.arrow.up") }
          Button("Copy link", systemImage: "link") {
            UIPasteboard.general.url = address
            Haptics.success()
          }
          // Safari would open this phone's own localhost, so only other pages leave the app.
          if PreviewURLs.loopbackURLForDevice(address.absoluteString) == nil {
            Button("Open in Safari", systemImage: "safari") { openURL(address) }
          }
          if !presenter.serverTabs.isEmpty {
            Section("Browser tabs in this thread") {
              ForEach(presenter.serverTabs) { tab in
                Button {
                  if let url = PreviewURLs.localPreviewURLForDevice(tab.url) { browser.navigate(url) }
                } label: {
                  Label(tab.displayTitle ?? String(localized: "New tab"), systemImage: "globe")
                  Text(tab.url)
                }
              }
            }
          }
        } label: {
          Label("Browser options", systemImage: "ellipsis")
        }
        .accessibilityIdentifier("preview.menu")
      }
    }
  }
}

/// What the page area shows instead of a page.
struct PreviewStateView: View {
  enum State: Equatable {
    case tunnelOff
    case failure(PreviewFailure, address: URL?)
  }

  let state: State
  let environment: String
  let diagnostics: String?
  let retry: () -> Void

  var body: some View {
    ScrollView {
      VStack(spacing: Spacing.lg) {
        ContentUnavailableView {
          Label {
            Text(title)
          } icon: {
            Image(systemName: symbol)
          }
        } description: {
          Text(detail)
        } actions: {
          if showsRetry {
            Button("Try again", action: retry)
              .buttonStyle(.glass)
              .accessibilityIdentifier("preview.retry")
          }
        }
        if let diagnostics, showsRetry {
          Text(diagnostics)
            .font(Typography.monoCaption)
            .foregroundStyle(Palette.textTertiary)
            .multilineTextAlignment(.center)
            .textSelection(.enabled)
            .padding(.horizontal, Spacing.xl)
        }
      }
      .frame(maxWidth: Layout.readingWidth)
      .frame(maxWidth: .infinity)
      .padding(.vertical, Spacing.xxl)
    }
    .scrollBounceBehavior(.basedOnSize)
    .background(Palette.canvas)
    .accessibilityIdentifier("preview.state")
  }

  private var showsRetry: Bool {
    switch state {
    case .tunnelOff, .failure(.tunnel(.permission), _), .failure(.tunnel(.disabled), _), .failure(.setup, _): false
    default: true
    }
  }

  private var symbol: String {
    switch state {
    case .tunnelOff, .failure(.tunnel(.disabled), _): "network.slash"
    case .failure(.tunnel(.permission), _): "lock"
    case .failure(.tunnel(.outdated), _): "arrow.down.circle"
    case .failure(.tunnel(.environment), _): "wifi.slash"
    case .failure(.tunnel(.port), _): "powerplug"
    case .failure(.setup, _): "exclamationmark.triangle"
    case .failure(.page, _): "exclamationmark.magnifyingglass"
    }
  }

  private var title: String {
    switch state {
    case .tunnelOff, .failure(.tunnel(.disabled), _):
      String(localized: "\(environment) doesn't share its localhost")
    case .failure(.tunnel(.permission), _):
      String(localized: "This device can't open \(environment)'s local servers")
    case .failure(.tunnel(.outdated), _):
      String(localized: "Update Ankiel Code on \(environment)")
    case .failure(.tunnel(.environment), _):
      String(localized: "Not connected to \(environment)")
    case .failure(.tunnel(.port), let address):
      String(localized: "Can't reach \(address.map(PreviewURLs.hostAndPort) ?? "localhost")")
    case .failure(.setup, _):
      String(localized: "This device can't open localhost pages")
    case .failure(.page, _):
      String(localized: "Can't open this page")
    }
  }

  private var detail: String {
    switch state {
    case .tunnelOff, .failure(.tunnel(.disabled), _):
      String(localized: "The preview tunnel is off there. Turn it on in that computer's settings to open its local servers here.")
    case .failure(.tunnel(.permission), _):
      String(localized: "This device's access doesn't include terminals and previews. Pair it again with full access to open local servers here.")
    case .failure(.tunnel(.outdated), _):
      String(localized: "\(environment) runs a version of Ankiel Code that can't open its localhost pages on this device. Update it there, then try again.")
    case .failure(.tunnel(.environment), _):
      String(localized: "Pages on \(environment)’s localhost load through its connection. Try again once it reconnects.")
    case .failure(.tunnel(.port), let address):
      String(localized: "Nothing is listening on port \(String(address.map(PreviewURLs.port) ?? 80)) on \(environment). Start the server there, then try again.")
    case .failure(.setup, _):
      String(localized: "The preview could not start its connection on this device. Close the browser and open it again.")
    case .failure(.page(let description), _):
      description
    }
  }
}

/// The empty browser: the thread's tabs on the computer, ready to open here.
private struct PreviewStartPage: View {
  let tabs: [PreviewTab]
  let open: (PreviewTab) -> Void

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: Spacing.lg) {
        VStack(alignment: .leading, spacing: Spacing.xs) {
          Text("Open a local server")
            .font(Typography.title)
          Text("Type an address like localhost:5173 below. Pages load from the computer through its connection.")
            .font(Typography.subheadline)
            .foregroundStyle(Palette.textSecondary)
        }
        if !tabs.isEmpty {
          VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Browser tabs in this thread")
              .font(Typography.footnote.weight(.semibold))
              .foregroundStyle(Palette.textSecondary)
            VStack(spacing: 0) {
              ForEach(tabs) { tab in
                Button {
                  open(tab)
                } label: {
                  HStack(spacing: Spacing.md) {
                    Image(systemName: "globe")
                      .foregroundStyle(Palette.textSecondary)
                      .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                      Text(tab.displayTitle ?? String(localized: "New tab"))
                        .font(Typography.callout.weight(.medium))
                        .foregroundStyle(Palette.textPrimary)
                        .lineLimit(1)
                      Text(tab.url)
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "arrow.up.forward")
                      .font(Typography.footnote)
                      .foregroundStyle(Palette.textTertiary)
                      .accessibilityHidden(true)
                  }
                  .padding(.horizontal, Spacing.lg)
                  .padding(.vertical, Spacing.md)
                  .frame(minHeight: 44)
                  .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("preview.tab")
                if tab.id != tabs.last?.id {
                  Divider().padding(.leading, Spacing.lg)
                }
              }
            }
            .background(Palette.surface, in: .rect(cornerRadius: Radius.large, style: .continuous))
          }
        }
      }
      .frame(maxWidth: Layout.readingWidth, alignment: .leading)
      .frame(maxWidth: .infinity)
      .padding(Spacing.lg)
    }
    .background(Palette.canvas)
    .accessibilityIdentifier("preview.start")
  }
}
