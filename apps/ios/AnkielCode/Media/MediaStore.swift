import AnkielKit
import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// Original bytes of images and files the viewers open, on disk in Caches. Keyed by what the
/// bytes are (environment, resource, the server's file revision), never by the signed URL, which
/// is re-minted. Downloads are shared while in flight; the folder is trimmed oldest-first.
actor MediaStore {
  static let shared = MediaStore()

  private let directory: URL
  private var inFlight: [String: Task<URL, any Error>] = [:]
  /// Bytes kept on disk before the oldest files go.
  private let budget: Int64 = 256 * 1024 * 1024

  init(directory: URL? = nil) {
    self.directory =
      directory
      ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appending(path: "AnkielCode/media", directoryHint: .isDirectory)
  }

  /// The cached file for `key`, downloading `url` when it is not on disk. `name` keeps the file's
  /// extension, so Quick Look, PDFKit and Share see the right type.
  func file(key: String, url: URL, name: String) async throws -> URL {
    let destination = location(key: key, name: name)
    // Any name in the key's folder is the same bytes (a thumbnail and the viewer name it differently).
    let folder = destination.deletingLastPathComponent()
    if let existing = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil).first {
      try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: existing.path)
      return existing
    }
    if let task = inFlight[key] { return try await task.value }
    let task = Task.detached(priority: .userInitiated) { () throws -> URL in
      let (temporary, response) = try await URLSession.shared.download(from: url)
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
        try? FileManager.default.removeItem(at: temporary)
        throw URLError(.badServerResponse)
      }
      try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? FileManager.default.removeItem(at: destination)
      try FileManager.default.moveItem(at: temporary, to: destination)
      return destination
    }
    inFlight[key] = task
    defer { inFlight[key] = nil }
    let file = try await task.value
    trim()
    return file
  }

  /// One folder per key (hashed), holding the file under its own name.
  private func location(key: String, name: String) -> URL {
    let digest = key.utf8.reduce(into: UInt64(1_469_598_103_934_665_603)) { hash, byte in
      hash = (hash ^ UInt64(byte)) &* 1_099_511_628_211
    }
    let safe = name.isEmpty ? "file" : String(name.map { "/:\\".contains($0) ? "_" : $0 }.prefix(120))
    return directory.appending(path: String(digest, radix: 36), directoryHint: .isDirectory).appending(path: safe)
  }

  private func trim() {
    let keys: [URLResourceKey] = [.totalFileAllocatedSizeKey, .contentModificationDateKey, .isRegularFileKey]
    guard let enumerator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: keys) else { return }
    var files: [(url: URL, size: Int64, date: Date)] = []
    for case let url as URL in enumerator {
      guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { continue }
      files.append((url, Int64(values.totalFileAllocatedSize ?? 0), values.contentModificationDate ?? .distantPast))
    }
    var total = files.reduce(0) { $0 + $1.size }
    guard total > budget else { return }
    for file in files.sorted(by: { $0.date < $1.date }) where total > budget {
      try? FileManager.default.removeItem(at: file.url.deletingLastPathComponent())
      total -= file.size
    }
  }

  /// Bytes on disk (Settings › Storage could show it later).
  func size() -> Int64 {
    let keys: [URLResourceKey] = [.totalFileAllocatedSizeKey]
    guard let enumerator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: keys) else { return 0 }
    var total: Int64 = 0
    for case let url as URL in enumerator {
      total += Int64((try? url.resourceValues(forKeys: Set(keys)))?.totalFileAllocatedSize ?? 0)
    }
    return total
  }
}

/// Decodes images from disk off the main actor, at no more pixels than the screen can zoom to.
nonisolated enum ImageDecoding {
  /// Long-edge pixel cap for a full-screen original: enough for 3× zoom on a phone, bounded memory
  /// (a 4096² image is 64 MB decoded).
  static let viewerMaxPixel: CGFloat = 4096

  @concurrent
  static func decode(_ file: URL, maxPixel: CGFloat = viewerMaxPixel) async -> UIImage? {
    guard let source = CGImageSourceCreateWithURL(file as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
      CGImageSourceGetCount(source) > 0
    else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixel,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
  }

  /// Whether ImageIO can read it (SVG cannot; those go to Quick Look).
  static func isDecodable(_ file: URL) -> Bool {
    guard let source = CGImageSourceCreateWithURL(file as CFURL, nil) else { return false }
    return CGImageSourceGetCount(source) > 0
  }
}
