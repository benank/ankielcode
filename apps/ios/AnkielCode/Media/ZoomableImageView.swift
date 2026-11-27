import SwiftUI
import UIKit

/// One zoomable image (ported from RN's `AnkielImageViewerPage`): pinch, double-tap to zoom into
/// the tapped spot and back, single tap for the caller (chrome). At the fitted zoom the content
/// never exceeds the bounds, so vertical drags reach the dismiss gesture and side swipes the pager.
struct ZoomableImageView: UIViewRepresentable {
  let image: UIImage
  var title: String
  var onSingleTap: () -> Void = {}
  var onZoomChange: (Bool) -> Void = { _ in }

  func makeUIView(context: Context) -> ZoomPage {
    let page = ZoomPage()
    page.onSingleTap = onSingleTap
    page.onZoomChange = onZoomChange
    page.setImage(image)
    page.imageView.accessibilityLabel = title
    return page
  }

  func updateUIView(_ page: ZoomPage, context: Context) {
    page.onSingleTap = onSingleTap
    page.onZoomChange = onZoomChange
    page.imageView.accessibilityLabel = title
    if page.imageView.image !== image { page.setImage(image) }
  }
}

final class ZoomPage: UIScrollView, UIScrollViewDelegate {
  let imageView = UIImageView()
  var onSingleTap: () -> Void = {}
  var onZoomChange: (Bool) -> Void = { _ in }
  private var laidOutSize = CGSize.zero
  private var wasZoomed = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    delegate = self
    showsVerticalScrollIndicator = false
    showsHorizontalScrollIndicator = false
    contentInsetAdjustmentBehavior = .never
    decelerationRate = .fast
    bouncesZoom = true
    imageView.contentMode = .scaleAspectFill
    imageView.clipsToBounds = true
    imageView.isAccessibilityElement = true
    imageView.accessibilityTraits = .image
    imageView.accessibilityIdentifier = "media.viewer.image"
    addSubview(imageView)
    let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
    doubleTap.numberOfTapsRequired = 2
    addGestureRecognizer(doubleTap)
    let singleTap = UITapGestureRecognizer(target: self, action: #selector(handleSingleTap))
    singleTap.require(toFail: doubleTap)
    addGestureRecognizer(singleTap)
    updateAccessibility()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { nil }

  func setImage(_ image: UIImage) {
    let ratio = { (size: CGSize) in size.width / max(size.height, 1) }
    let previous = imageView.image?.size
    imageView.image = image
    // A sharper copy of the same picture keeps the zoom; a different shape starts over.
    if previous == nil || abs(ratio(previous ?? .zero) - ratio(image.size)) > 0.01 { laidOutSize = .zero }
    setNeedsLayout()
  }

  var isZoomed: Bool { zoomScale > minimumZoomScale + 0.01 }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard bounds.size != laidOutSize, let size = imageView.image?.size, size.width > 0, size.height > 0,
      bounds.width > 0, bounds.height > 0
    else { return }
    laidOutSize = bounds.size
    let fit = min(bounds.width / size.width, bounds.height / size.height)
    minimumZoomScale = 1
    zoomScale = 1
    imageView.transform = .identity
    imageView.frame = CGRect(x: 0, y: 0, width: size.width * fit, height: size.height * fit)
    contentSize = imageView.frame.size
    // Enough to fill the screen and then some, or to see the original's pixels.
    let fill = max(bounds.width / imageView.frame.width, bounds.height / imageView.frame.height)
    let pixels = 1 / fit / (window?.screen.scale ?? 3)
    maximumZoomScale = max(3, fill * 1.5, pixels)
    centerImage()
  }

  func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

  func scrollViewDidZoom(_ scrollView: UIScrollView) {
    centerImage()
    if isZoomed != wasZoomed {
      wasZoomed = isZoomed
      onZoomChange(wasZoomed)
    }
    updateAccessibility()
  }

  private func centerImage() {
    imageView.center = CGPoint(x: max(contentSize.width, bounds.width) / 2, y: max(contentSize.height, bounds.height) / 2)
  }

  private func updateAccessibility() {
    imageView.accessibilityValue = "\(Int((zoomScale * 100).rounded()))%"
  }

  @objc private func handleDoubleTap(_ gesture: UITapGestureRecognizer) {
    if isZoomed {
      setZoomScale(minimumZoomScale, animated: !UIAccessibility.isReduceMotionEnabled)
      return
    }
    guard imageView.image != nil else { return }
    let location = gesture.location(in: imageView)
    let fill = max(bounds.width / imageView.bounds.width, bounds.height / imageView.bounds.height)
    let scale = min(maximumZoomScale, fill > 1.2 ? fill : 2.5)
    let width = bounds.width / scale
    let height = bounds.height / scale
    zoom(to: CGRect(x: location.x - width / 2, y: location.y - height / 2, width: width, height: height), animated: !UIAccessibility.isReduceMotionEnabled)
  }

  @objc private func handleSingleTap() { onSingleTap() }
}
