import Photos
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Save to Photos and Copy for a downloaded original (RN `useMediaActions`); Share is a `ShareLink`.
enum MediaActions {
  enum SaveError: Error {
    case denied
    case failed(String)
  }

  /// Adds the original bytes to Photos (keeping format and metadata), or the decoded image when the
  /// file is not one Photos reads. Asks only for add access.
  static func saveToPhotos(file: URL?, image: UIImage?) async throws(SaveError) {
    let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
    guard status == .authorized || status == .limited else { throw .denied }
    let original = file.flatMap { ImageDecoding.isDecodable($0) && $0.pathExtension.lowercased() != "svg" ? $0 : nil }
    guard original != nil || image != nil else { throw .failed(String(localized: "This image is not loaded yet.")) }
    do {
      try await PHPhotoLibrary.shared().performChanges {
        if let original {
          PHAssetCreationRequest.forAsset().addResource(with: .photo, fileURL: original, options: nil)
        } else if let image {
          PHAssetChangeRequest.creationRequestForAsset(from: image)
        }
      }
    } catch {
      throw .failed(error.localizedDescription)
    }
  }

  static func message(_ error: SaveError) -> String {
    switch error {
    case .denied: String(localized: "Allow Ankiel Code to add photos in Settings.")
    case .failed(let message): message
    }
  }

  /// Copies the image's own bytes (so a PNG stays a PNG), else the decoded image.
  static func copy(file: URL?, image: UIImage?) {
    if let file, let type = UTType(filenameExtension: file.pathExtension), type.conforms(to: .image),
      let data = try? Data(contentsOf: file)
    {
      UIPasteboard.general.setData(data, forPasteboardType: type.identifier)
    } else if let image {
      UIPasteboard.general.image = image
    }
  }
}

/// A glass button in the viewers' floating toolbar.
struct ViewerButton: View {
  let title: LocalizedStringKey
  let systemImage: String
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      Label(title, systemImage: systemImage)
        .labelStyle(.iconOnly)
        .font(Typography.body.weight(.medium))
        .frame(width: 30, height: 30)
        .contentShape(.circle)
    }
    .buttonStyle(.glass)
    .buttonBorderShape(.circle)
  }
}
