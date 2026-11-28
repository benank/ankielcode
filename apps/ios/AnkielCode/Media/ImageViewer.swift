import AnkielKit
import SwiftUI
import UIKit

/// The full-screen gallery: every image in the thread, swiped between, zoomed by pinch or
/// double-tap, closed by dragging down or Close, zooming back into its thumbnail. Floating glass
/// chrome with Share, Save to Photos and Copy; a tap hides it.
struct ImageViewer: View {
  let gallery: Gallery
  let presenter: FilePresenter
  @State private var index: Int
  @State private var chromeHidden = false
  @State private var zoomed = false
  /// The drag-to-dismiss offset (Photos style: the page follows the finger and shrinks).
  @State private var drag: CGSize = .zero
  @State private var loaded: [String: LoadedImage] = [:]
  @State private var saveMessage: SaveAlert?
  @State private var savedCount = 0
  @State private var copiedCount = 0
  @Environment(\.dismiss) private var dismiss
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(gallery: Gallery, presenter: FilePresenter) {
    self.gallery = gallery
    self.presenter = presenter
    _index = State(initialValue: gallery.index)
  }

  private var current: ThreadImage? { gallery.images[safe: index] }
  private var currentLoaded: LoadedImage? { current.flatMap { loaded[$0.id] } }

  var body: some View {
    ZStack {
      Color.black.opacity(1 - dragProgress).ignoresSafeArea()
      TabView(selection: $index) {
        ForEach(Array(gallery.images.enumerated()), id: \.element.id) { offset, image in
          ViewerPage(image: image, presenter: presenter, loaded: $loaded[image.id]) {
            withMotion(Motion.micro, reduceMotion: reduceMotion) { chromeHidden.toggle() }
          } onZoomChange: { zoomed = $0 }
          .tag(offset)
        }
      }
      .tabViewStyle(.page(indexDisplayMode: .never))
      .ignoresSafeArea()
      .scaleEffect(1 - 0.3 * dragProgress)
      .offset(drag)
      .simultaneousGesture(dismissDrag, isEnabled: !zoomed)
    }
    .overlay(alignment: .top) { if !chromeHidden { topBar.transition(.opacity) } }
    .overlay(alignment: .bottom) { if !chromeHidden { bottomBar.transition(.opacity) } }
    .statusBarHidden(chromeHidden)
    .persistentSystemOverlays(chromeHidden ? .hidden : .automatic)
    .environment(\.colorScheme, .dark)
    .onChange(of: index) { _, new in
      zoomed = false
      presenter.galleryImageId = gallery.images[safe: new]?.id
      // Decoded originals cost far more than their files: keep only the page and its neighbours.
      let near = Set(gallery.images[max(0, new - 1)...min(gallery.images.count - 1, new + 1)].map(\.id))
      loaded = loaded.filter { near.contains($0.key) }
    }
    .sensoryFeedback(.success, trigger: savedCount)
    .sensoryFeedback(.success, trigger: copiedCount)
    .alert(item: $saveMessage) { alert in
      Alert(title: Text("Could not save image"), message: Text(alert.message))
    }
    .accessibilityAction(.escape) { dismiss() }
  }

  private var dragProgress: CGFloat { min(1, abs(drag.height) / 400) }

  /// A mostly vertical drag closes the viewer past 120 pt or on a fling; a shorter one springs back.
  private var dismissDrag: some Gesture {
    DragGesture(minimumDistance: 16)
      .onChanged { value in
        guard drag != .zero || abs(value.translation.height) > abs(value.translation.width) * 1.5 else { return }
        if drag == .zero, !chromeHidden { withAnimation(Motion.micro) { chromeHidden = true } }
        drag = value.translation
      }
      .onEnded { value in
        guard drag != .zero else { return }
        if abs(value.translation.height) > 120 || abs(value.predictedEndTranslation.height) > 400 {
          dismiss()
        } else {
          withMotion(Motion.gentle, reduceMotion: reduceMotion) {
            drag = .zero
            chromeHidden = false
          }
        }
      }
  }

  private var topBar: some View {
    HStack(spacing: Spacing.md) {
      ViewerButton(title: "Close", systemImage: "xmark") { dismiss() }
        .accessibilityIdentifier("media.viewer.close")
        .keyboardShortcut(.cancelAction)
      Spacer(minLength: 0)
      VStack(spacing: 0) {
        Text(current?.title ?? "")
          .font(Typography.subheadline.weight(.semibold))
          .lineLimit(1)
          .truncationMode(.middle)
        if gallery.images.count > 1 {
          Text("\(index + 1) of \(gallery.images.count)")
            .font(Typography.caption.monospacedDigit())
            .foregroundStyle(.secondary)
            .contentTransition(.numericText())
        }
      }
      .foregroundStyle(.white)
      .padding(.horizontal, Spacing.lg)
      .padding(.vertical, Spacing.sm)
      .chromeGlass()
      .accessibilityElement(children: .combine)
      Spacer(minLength: 0)
      // Balances Close so the title stays centered.
      Color.clear.frame(width: 48, height: 48)
    }
    .padding(.horizontal, Spacing.lg)
  }

  private var bottomBar: some View {
    GlassEffectContainer(spacing: Spacing.md) {
      HStack(spacing: Spacing.md) {
        if let file = currentLoaded?.file {
          ShareLink(item: file) {
            Label("Share", systemImage: "square.and.arrow.up")
              .labelStyle(.iconOnly)
              .font(Typography.body.weight(.medium))
              .frame(width: 30, height: 30)
          }
          .buttonStyle(.glass)
          .buttonBorderShape(.circle)
          .accessibilityIdentifier("media.viewer.share")
        }
        ViewerButton(title: "Save to Photos", systemImage: savedCount > 0 ? "checkmark" : "square.and.arrow.down") {
          save()
        }
        .disabled(currentLoaded == nil)
        .accessibilityIdentifier("media.viewer.save")
        ViewerButton(title: "Copy", systemImage: copiedCount > 0 ? "checkmark" : "doc.on.doc") {
          MediaActions.copy(file: currentLoaded?.file, image: currentLoaded?.image)
          copiedCount += 1
        }
        .disabled(currentLoaded == nil)
        .accessibilityIdentifier("media.viewer.copy")
      }
      .contentTransition(.symbolEffect(.replace))
    }
    .padding(.bottom, Spacing.sm)
  }

  private func save() {
    let loaded = currentLoaded
    Task {
      do throws(MediaActions.SaveError) {
        try await MediaActions.saveToPhotos(file: loaded?.file, image: loaded?.image)
        savedCount += 1
        UIAccessibility.post(notification: .announcement, argument: String(localized: "Saved to Photos"))
      } catch {
        saveMessage = SaveAlert(message: MediaActions.message(error))
      }
    }
  }
}

struct SaveAlert: Identifiable {
  let id = UUID()
  let message: String
}

/// A decoded original and its file on disk (for Share, Save and Copy).
struct LoadedImage: Equatable {
  var image: UIImage
  var file: URL?
}

/// One page: the original downloaded to the media cache and decoded at viewer size; a spinner
/// while it loads, a retry when it cannot.
private struct ViewerPage: View {
  let image: ThreadImage
  let presenter: FilePresenter
  @Binding var loaded: LoadedImage?
  let onTap: () -> Void
  let onZoomChange: (Bool) -> Void
  @State private var failed = false
  @State private var attempt = 0

  var body: some View {
    Group {
      if let loaded {
        ZoomableImageView(image: loaded.image, title: image.title, onSingleTap: onTap, onZoomChange: onZoomChange)
      } else if failed {
        ContentUnavailableView {
          Label("This image could not be loaded.", systemImage: "exclamationmark.triangle")
        } actions: {
          Button("Try again") {
            failed = false
            attempt += 1
          }
          .buttonStyle(.glass)
        }
        .foregroundStyle(.white)
      } else {
        ProgressView()
          .controlSize(.large)
          .tint(.white)
          .accessibilityLabel(Text("Loading image"))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .contentShape(.rect)
    .task(id: [attempt, presenter.isConnected ? 1 : 0]) { await load() }
  }

  private func load() async {
    guard loaded == nil else { return }
    // Web images load without the computer; the rest wait for it (the task reruns on connect).
    if case .markdown(let source) = image.source, source.hasPrefix("http") {} else if presenter.registry != nil, !presenter.isConnected {
      return
    }
    guard let signed = await presenter.signed(image.source),
      let file = try? await MediaStore.shared.file(key: signed.key, url: signed.url, name: image.title.isEmpty ? "image" : name)
    else {
      failed = true
      return
    }
    guard let decoded = await ImageDecoding.decode(file) else {
      failed = true
      return
    }
    loaded = LoadedImage(image: decoded, file: file)
  }

  /// A file name with the image's extension, for Share.
  private var name: String {
    switch image.source {
    case .attachment(let attachment): attachment.name
    case .markdown(let source): WorkspacePath.basename(URL(string: source)?.path(percentEncoded: false) ?? source)
    case .toolOutput(_, let index): "image-\(index + 1).png"
    }
  }
}
