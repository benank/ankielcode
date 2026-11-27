import AVKit
import PDFKit
import QuickLook
import SwiftUI

/// A PDF with PDFKit: continuous pages, pinch to zoom, system find.
struct PDFDocumentView: UIViewRepresentable {
  let url: URL

  func makeUIView(context: Context) -> PDFView {
    let view = PDFView()
    view.autoScales = true
    view.displayMode = .singlePageContinuous
    view.displayDirection = .vertical
    view.backgroundColor = .clear
    view.isFindInteractionEnabled = true
    view.document = PDFDocument(url: url)
    view.accessibilityIdentifier = "file.pdf"
    return view
  }

  func updateUIView(_ view: PDFView, context: Context) {
    if view.document?.documentURL != url { view.document = PDFDocument(url: url) }
  }
}

/// A video or audio file with AVKit's own controls, streamed from its signed URL (RN plays the
/// URL directly too). Playback pauses when the view goes away.
struct MediaPlayerView: UIViewControllerRepresentable {
  let url: URL
  let title: String

  func makeUIViewController(context: Context) -> AVPlayerViewController {
    let controller = AVPlayerViewController()
    let item = AVPlayerItem(url: url)
    let metadata = AVMutableMetadataItem()
    metadata.identifier = .commonIdentifierTitle
    metadata.value = title as NSString
    item.externalMetadata = [metadata]
    controller.player = AVPlayer(playerItem: item)
    controller.allowsPictureInPicturePlayback = false
    controller.videoGravity = .resizeAspect
    controller.view.accessibilityIdentifier = "file.player"
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
    return controller
  }

  func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {}

  static func dismantleUIViewController(_ controller: AVPlayerViewController, coordinator: ()) {
    controller.player?.pause()
  }
}

/// Quick Look over a downloaded file (documents, archives, fonts, anything else it can read).
struct QuickLookView: UIViewControllerRepresentable {
  let url: URL

  func makeCoordinator() -> Coordinator { Coordinator(url: url) }

  func makeUIViewController(context: Context) -> QLPreviewController {
    let controller = QLPreviewController()
    controller.dataSource = context.coordinator
    return controller
  }

  func updateUIViewController(_ controller: QLPreviewController, context: Context) {
    if context.coordinator.url != url {
      context.coordinator.url = url
      controller.reloadData()
    }
  }

  final class Coordinator: NSObject, QLPreviewControllerDataSource {
    var url: URL
    init(url: URL) { self.url = url }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem {
      url as NSURL
    }
  }

  static func canPreview(_ url: URL) -> Bool { QLPreviewController.canPreview(url as NSURL) }
}
