import AnkielKit
import SwiftUI

/// Images a tool returned (screenshots, image reads), as thumbnails under its expanded row.
/// Tapping one opens them in the gallery.
struct ToolImageStrip: View {
  let itemId: String
  let count: Int
  @Environment(\.filePresenter) private var presenter

  private var images: [ThreadImage] {
    (0..<count).map { index in
      ThreadImage(source: .toolOutput(itemId: itemId, index: index), itemId: itemId, title: String(localized: "Tool image \(index + 1)"))
    }
  }

  var body: some View {
    if let presenter {
      ScrollView(.horizontal) {
        HStack(spacing: Spacing.sm) {
          ForEach(Array(images.enumerated()), id: \.element.id) { index, image in
            Button {
              presenter.openImages(images, at: index)
            } label: {
              MediaThumbnailImage(image: image, presenter: presenter)
                .frame(width: 120, height: 90)
                .clipShape(.rect(cornerRadius: Radius.small, style: .continuous))
            }
            .buttonStyle(.plain)
            .matchedTransitionSource(id: image.id, in: presenter.namespace ?? fallback)
            .accessibilityLabel(Text(image.title))
            .accessibilityHint(Text("Opens the image"))
            .accessibilityIdentifier("media.tool-thumbnail")
          }
        }
      }
      .scrollIndicators(.hidden)
    }
  }

  @Namespace private var fallback
}

/// A small thumbnail loaded through the media cache (the same bytes the viewer then opens).
struct MediaThumbnailImage: View {
  let image: ThreadImage
  let presenter: FilePresenter
  @State private var loaded: UIImage?
  @State private var failed = false

  var body: some View {
    ZStack {
      Palette.fill
      if let loaded {
        Image(uiImage: loaded).resizable().aspectRatio(contentMode: .fill).transition(.opacity)
      } else {
        Image(systemName: failed ? "photo.badge.exclamationmark" : "photo")
          .foregroundStyle(Palette.textTertiary)
      }
    }
    .task(id: image.id) {
      guard loaded == nil else { return }
      guard let signed = await presenter.signed(image.source),
        let file = try? await MediaStore.shared.file(key: signed.key, url: signed.url, name: "image"),
        let decoded = await ImageDecoding.decode(file, maxPixel: 480)
      else {
        failed = true
        return
      }
      withAnimation(Motion.micro) { loaded = decoded }
    }
  }
}
