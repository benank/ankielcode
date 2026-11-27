import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Prepares a picked or pasted image the way RN does (`imageAttachmentSize.ts`, `composerImageFit.ts`,
/// `convertPastedImagesToAttachments`): types the server takes stay as they are when they fit;
/// anything else (HEIC, …) becomes JPEG at 0.85; PNG and JPEG larger than 2000 px on a side are
/// scaled down (providers reject larger images once a request holds many); and an image over
/// 10 MiB shrinks until it fits, at most three times.
public enum ImageFitting {
  public static let maxEdge = 2000
  static let jpegQuality = 0.85
  static let maxShrinks = 3

  public struct Fitted: Sendable, Hashable {
    public var data: Data
    public var mimeType: String
    public var pixelSize: CGSize
  }

  public enum Failure: Error, Sendable { case unreadable, tooLarge }

  /// Runs off the caller's actor (decoding and encoding are heavy).
  @concurrent
  public static func fit(_ data: Data, mimeType: String?) async throws(Failure) -> Fitted {
    try fitNow(data, mimeType: mimeType)
  }

  static func fitNow(_ data: Data, mimeType: String?) throws(Failure) -> Fitted {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0 else {
      throw .unreadable
    }
    let detected = (CGImageSourceGetType(source) as String?).flatMap { UTType($0)?.preferredMIMEType }
    let sourceType = (detected ?? mimeType ?? "").lowercased().replacingOccurrences(of: "image/jpg", with: "image/jpeg")
    let size = pixelSize(source)
    let longest = Int(max(size.width, size.height))
    let downscalable = sourceType == "image/png" || sourceType == "image/jpeg"
    let supported = AttachmentLimits.imageMimeTypes.contains(sourceType)

    if supported, longest <= maxEdge || !downscalable, data.count <= AttachmentLimits.maxImageBytes {
      return Fitted(data: data, mimeType: sourceType, pixelSize: size)
    }
    let format = sourceType == "image/png" ? UTType.png : UTType.jpeg
    var edge = min(longest, maxEdge)
    var encoded = try render(source, maxEdge: edge, as: format)
    for _ in 0..<maxShrinks where encoded.data.count > AttachmentLimits.maxImageBytes {
      // Encoded size tracks pixel count, so scale each edge by the square root, with headroom.
      let scale = (Double(AttachmentLimits.maxImageBytes) / Double(encoded.data.count)).squareRoot() * 0.9
      edge = max(1, Int(Double(edge) * scale))
      // PNG ignores quality, so a stubborn PNG becomes JPEG.
      encoded = try render(source, maxEdge: edge, as: .jpeg)
    }
    guard encoded.data.count <= AttachmentLimits.maxImageBytes else { throw .tooLarge }
    return encoded
  }

  static func pixelSize(_ source: CGImageSource) -> CGSize {
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    let width = (properties?[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue ?? 0
    let height = (properties?[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue ?? 0
    let orientation = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
    // Orientations 5–8 swap the axes.
    return orientation >= 5 ? CGSize(width: height, height: width) : CGSize(width: width, height: height)
  }

  private static func render(_ source: CGImageSource, maxEdge: Int, as type: UTType) throws(Failure) -> Fitted {
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxEdge,
      kCGImageSourceShouldCacheImmediately: true,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { throw .unreadable }
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(output, type.identifier as CFString, 1, nil) else {
      throw .unreadable
    }
    let properties: [CFString: Any] = type == .jpeg ? [kCGImageDestinationLossyCompressionQuality: jpegQuality] : [:]
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { throw .unreadable }
    return Fitted(
      data: output as Data, mimeType: type == .png ? "image/png" : "image/jpeg",
      pixelSize: CGSize(width: image.width, height: image.height))
  }
}
