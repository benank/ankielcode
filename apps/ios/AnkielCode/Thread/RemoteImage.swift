import AnkielKit
import ImageIO
import SwiftUI
import UIKit

/// An image the thread shows: a message attachment or a markdown image source.
enum ImageSource: Hashable, Sendable {
  case attachment(ChatAttachment)
  case markdown(String)
}

/// Turns image sources into fetchable URLs for one thread: web URLs pass through; attachments and
/// workspace paths get a signed asset URL from the thread's server (spec §8.4).
struct ThreadImages: Equatable {
  let id: String
  let resolve: (@MainActor (ImageSource) async -> URL?)?

  static let none = ThreadImages(id: "none", resolve: nil)

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }

  static func live(_ ref: ThreadRef, registry: EnvironmentRegistry) -> ThreadImages {
    ThreadImages(id: ref.key) { source in
      switch source {
      case .attachment(let attachment):
        return try? await registry.assetURL(
          .attachment(id: attachment.id, fileName: attachment.name, mimeType: attachment.mimeType),
          in: ref.environmentId)
      case .markdown(let text):
        if let url = URL(string: text), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" {
          return url
        }
        guard !text.hasPrefix("data:"), URL(string: text)?.scheme == nil || text.hasPrefix("file:") else { return nil }
        let path = text.hasPrefix("file://") ? (URL(string: text)?.path ?? text) : text
        return try? await registry.assetURL(.workspaceFile(threadId: ref.threadId, path: path), in: ref.environmentId)
      }
    }
  }
}

/// Loads, downsamples (ImageIO thumbnails at the size shown) and caches images off the main actor.
actor ImageLoader {
  static let shared = ImageLoader()
  private let cache = NSCache<NSString, UIImage>()
  private var inFlight: [String: Task<UIImage?, Never>] = [:]

  init() {
    cache.totalCostLimit = 64 * 1024 * 1024
  }

  func image(_ url: URL, maxPixel: CGFloat) async -> UIImage? {
    let key = "\(url.absoluteString)#\(Int(maxPixel))" as NSString
    if let cached = cache.object(forKey: key) { return cached }
    if let task = inFlight[key as String] { return await task.value }
    let task = Task.detached(priority: .utility) { () -> UIImage? in
      guard let (data, response) = try? await URLSession.shared.data(from: url),
        (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true
      else { return nil }
      return Self.downsample(data, maxPixel: maxPixel)
    }
    inFlight[key as String] = task
    let image = await task.value
    inFlight[key as String] = nil
    if let image {
      cache.setObject(image, forKey: key, cost: Int(image.size.width * image.size.height * image.scale * image.scale * 4))
    }
    return image
  }

  nonisolated static func downsample(_ data: Data, maxPixel: CGFloat) -> UIImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary)
    else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixel,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
    return UIImage(cgImage: image)
  }
}

/// An image from the thread's server or the web, with a placeholder while it loads or when it
/// cannot.
struct RemoteImage<Placeholder: View>: View {
  let source: ImageSource
  let images: ThreadImages
  var maxPixel: CGFloat = 1200
  var contentMode: ContentMode = .fit
  @ViewBuilder var placeholder: () -> Placeholder
  @State private var image: UIImage?

  var body: some View {
    Group {
      if let image {
        Image(uiImage: image)
          .resizable()
          .aspectRatio(contentMode: contentMode)
          .transition(.opacity)
      } else {
        placeholder()
      }
    }
    .task(id: source) {
      guard image == nil, let resolve = images.resolve, let url = await resolve(source) else { return }
      let loaded = await ImageLoader.shared.image(url, maxPixel: maxPixel)
      withAnimation(Motion.micro) { image = loaded }
    }
  }
}
