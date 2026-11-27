import AnkielKit
import SwiftUI

/// A device preview to show; `url` nil opens the start page.
struct PreviewRoute: Identifiable, Hashable {
  let id = UUID()
  var url: URL?
}

/// A thread's device previews: its browser tabs on the computer (`preview.list` plus
/// `subscribePreviewEvents`, RN `useThreadServerBrowserTabs`) while the thread shows, and the
/// presented preview. Loopback links open here instead of Safari, which would load the phone's
/// own localhost.
@MainActor @Observable
final class PreviewPresenter {
  let ref: ThreadRef
  var route: PreviewRoute?
  private(set) var tabs = PreviewTabsState()
  @ObservationIgnored let registry: EnvironmentRegistry
  @ObservationIgnored private let host: EnvironmentTerminalHost
  @ObservationIgnored private var run: Task<Void, Never>?

  init(ref: ThreadRef, registry: EnvironmentRegistry) {
    self.ref = ref
    self.registry = registry
    host = EnvironmentTerminalHost(registry: registry, environmentId: ref.environmentId)
  }

  var environment: EnvironmentModel? { registry.environment(ref.environmentId) }
  var environmentLabel: String { environment?.label ?? String(localized: "the computer") }

  /// The computer turned its tunnel off; false until its config arrives (RN).
  var tunnelOff: Bool {
    PreviewDebug.tunnelOff || (environment.map { $0.hasConfig && !$0.settings.enablePreviewTunnel } ?? false)
  }

  /// The tunnel needs `terminal:operate`; only a known answer without it hides the preview.
  var permissionMissing: Bool {
    PreviewDebug.permissionMissing || (environment?.grantedScopes.map { !$0.contains(TerminalScope.operate) } ?? false)
  }

  /// The thread's headless tabs on the computer, newest last.
  var serverTabs: [PreviewTab] { PreviewDebug.tabs ?? tabs.serverTabs }

  /// The address a link opens on this device, nil when it should leave the app.
  func deviceURL(for link: URL) -> URL? {
    tunnelOff ? nil : PreviewURLs.loopbackURLForDevice(link.absoluteString)
  }

  func open(_ url: URL?) {
    route = PreviewRoute(url: url)
  }

  /// A tab's page on this device (RN "Open on this device"): its loopback address through the
  /// tunnel, or any other web address directly.
  func open(_ tab: PreviewTab) {
    open(PreviewURLs.localPreviewURLForDevice(tab.url))
  }

  func start() {
    guard run == nil, environment?.capabilities["serverBrowser"]?.boolValue == true else { return }
    run = Task { [weak self] in await self?.follow() }
  }

  func stop() {
    run?.cancel()
    run = nil
  }

  private func follow() async {
    var previous: ObjectIdentifier?
    while !Task.isCancelled {
      guard let next = await host.channel(after: previous) else { return }
      previous = next.id
      do {
        // Subscribe first, so an event between the list and the stream is not lost.
        let events = try await next.channel.stream(PreviewEventsRequest.rpcTag, payload: PreviewEventsRequest(), of: PreviewEvent.self)
        await relist(next.channel)
        for try await event in events where event.threadId == ref.threadId {
          if tabs.apply(event: event) { await relist(next.channel) }
        }
      } catch is CancellationError {
        return
      } catch {
        // Keep the last tabs while the computer reconnects.
      }
    }
  }

  private func relist(_ channel: any TerminalChannel) async {
    guard
      let list = try? await channel.call(
        PreviewListRequest.rpcTag, payload: PreviewListRequest(threadId: ref.threadId), as: PreviewList.self)
    else { return }
    tabs.apply(list: list)
  }
}

extension EnvironmentValues {
  @Entry var previewPresenter: PreviewPresenter?
}

extension View {
  /// Gives a thread screen its device previews: loopback links open them, the thread menu lists
  /// its browser tabs, and the preview covers the screen.
  func threadPreview(_ ref: ThreadRef) -> some View {
    modifier(ThreadPreviewHost(ref: ref))
  }
}

private struct ThreadPreviewHost: ViewModifier {
  let ref: ThreadRef
  @Environment(AppModel.self) private var model
  @Environment(\.openURL) private var outerOpenURL
  @State private var presenter: PreviewPresenter?

  func body(content: Content) -> some View {
    if ThreadDebug.isFixture(ref), !PreviewDebug.isEnabled {
      content
    } else {
      let presenter = presenter ?? PreviewPresenter(ref: ref, registry: model.registry)
      let outer = outerOpenURL
      content
        .environment(\.previewPresenter, presenter)
        .environment(
          \.openURL,
          OpenURLAction { url in
            if let device = presenter.deviceURL(for: url) {
              presenter.open(device)
            } else {
              outer(url)
            }
            return .handled
          }
        )
        .fullScreenCover(item: Bindable(presenter).route) { route in
          PreviewScreen(presenter: presenter, initial: route.url)
        }
        .onAppear {
          if self.presenter == nil { self.presenter = presenter }
          presenter.start()
          PreviewDebug.apply(to: presenter)
        }
        .onChange(of: model.registry.environment(ref.environmentId)?.capabilities["serverBrowser"]) { _, _ in
          presenter.start()
        }
        .onDisappear {
          // The cover keeps the thread in the stack, so this is the thread leaving.
          if presenter.route == nil { presenter.stop() }
        }
    }
  }
}

/// "Browser" in a thread's menu: the thread's browser tabs on this device, or a blank preview.
struct PreviewMenuSection: View {
  @Environment(\.previewPresenter) private var presenter

  var body: some View {
    if let presenter, !presenter.tunnelOff {
      let tabs = presenter.serverTabs
      Section {
        if tabs.isEmpty {
          Button("Browser", systemImage: "globe") { presenter.open(nil) }
            .accessibilityIdentifier("thread.preview")
        } else {
          Menu {
            ForEach(tabs) { tab in
              Button {
                presenter.open(tab)
              } label: {
                Label(tab.displayTitle ?? String(localized: "New tab"), systemImage: "globe")
                Text(tab.url)
              }
            }
            Button("New tab", systemImage: "plus") { presenter.open(nil) }
              .accessibilityIdentifier("thread.preview.new")
          } label: {
            Label("Browser", systemImage: "globe")
          }
          .accessibilityIdentifier("thread.preview")
        }
      }
    }
  }
}
