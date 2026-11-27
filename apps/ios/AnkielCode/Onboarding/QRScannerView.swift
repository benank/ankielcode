import AVFoundation
import AnkielKit
import SwiftUI
import Vision
import VisionKit

/// Full-screen QR scanning with VisionKit. Handles a denied camera and devices without one (the
/// simulator) by pointing at the paste form instead.
struct QRScannerView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @State private var access = CameraAccess.current
  @State private var rejectedCode = false

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      switch access {
      case .unavailable:
        ScannerMessage(
          systemImage: "camera.metering.unknown",
          title: "No camera here",
          message: "This device can't scan codes. Paste the pairing link instead.",
          action: ("Paste link", { switchToLink() }))
      case .denied:
        ScannerMessage(
          systemImage: "camera.fill",
          title: "Camera access needed",
          message: "Camera access was denied for this app. Open Settings to enable it, or paste the link instead.",
          action: ("Open Settings", {
            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
          }),
          secondary: ("Paste link", { switchToLink() }))
      case .undetermined:
        ProgressView().tint(.white)
      case .granted:
        DataScanner(onScan: handle)
          .ignoresSafeArea()
        ScannerOverlay(rejected: rejectedCode)
      }
    }
    .overlay(alignment: .topTrailing) {
      Button("Close", systemImage: "xmark") { dismiss() }
        .labelStyle(.iconOnly)
        .font(.title3.weight(.semibold))
        .frame(width: 44, height: 44)
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .padding(Spacing.lg)
    }
    .environment(\.colorScheme, .dark)
    .task {
      if access == .undetermined {
        let granted = await AVCaptureDevice.requestAccess(for: .video)
        access = granted ? .granted : .denied
      }
    }
    .sensoryFeedback(.error, trigger: rejectedCode) { _, new in new }
  }

  private func handle(_ payload: String) {
    let unwrapped = PairingFlow.unwrapScanned(payload)
    guard (try? PairingInput.resolve(pairingURL: unwrapped)) != nil else {
      rejectedCode = true
      Task {
        try? await Task.sleep(for: .seconds(1.6))
        rejectedCode = false
      }
      return
    }
    model.pair(unwrapped)
  }

  private func switchToLink() {
    model.showPairingLink()
  }
}

enum CameraAccess: Equatable {
  case unavailable, denied, undetermined, granted

  static var current: CameraAccess {
    guard DataScannerViewController.isSupported else { return .unavailable }
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: return DataScannerViewController.isAvailable ? .granted : .denied
    case .notDetermined: return .undetermined
    default: return .denied
    }
  }
}

private struct ScannerOverlay: View {
  let rejected: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(spacing: Spacing.xl) {
      Spacer()
      RoundedRectangle(cornerRadius: 28, style: .continuous)
        .strokeBorder(rejected ? Palette.danger : .white.opacity(0.85), lineWidth: 3)
        .frame(width: 240, height: 240)
        .accessibilityHidden(true)
      Text(rejected ? "That code isn't a pairing link." : "Scan the code from `ankiel pair` or desktop Connections settings")
        .font(Typography.subheadline.weight(.medium))
        .foregroundStyle(.white)
        .multilineTextAlignment(.center)
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.md)
        .glassEffect(.regular, in: .capsule)
        .padding(.horizontal, Spacing.xl)
        .contentTransition(.opacity)
      Spacer()
      Spacer()
    }
    .animation(Motion.resolve(Motion.micro, reduceMotion: reduceMotion), value: rejected)
    .allowsHitTesting(false)
  }
}

private struct ScannerMessage: View {
  let systemImage: String
  let title: LocalizedStringKey
  let message: LocalizedStringKey
  let action: (LocalizedStringKey, () -> Void)
  var secondary: (LocalizedStringKey, () -> Void)?

  var body: some View {
    VStack(spacing: Spacing.lg) {
      Image(systemName: systemImage)
        .font(.system(size: 40))
        .foregroundStyle(.white.opacity(0.8))
        .accessibilityHidden(true)
      Text(title)
        .font(Typography.title)
        .foregroundStyle(.white)
      Text(message)
        .font(Typography.subheadline)
        .foregroundStyle(.white.opacity(0.7))
        .multilineTextAlignment(.center)
      GlassEffectContainer(spacing: Spacing.md) {
        VStack(spacing: Spacing.sm) {
          Button(action: action.1) {
            Text(action.0).font(Typography.headline).foregroundStyle(.black)
              .frame(maxWidth: .infinity, minHeight: 30)
          }
          .buttonStyle(.glassProminent)
          .tint(.white)
          .controlSize(.large)
          if let secondary {
            Button(action: secondary.1) {
              Text(secondary.0).font(Typography.headline).frame(maxWidth: .infinity, minHeight: 30)
            }
            .buttonStyle(.glass)
            .controlSize(.large)
          }
        }
      }
      .padding(.top, Spacing.sm)
    }
    .padding(Spacing.xxl)
    .frame(maxWidth: 420)
  }
}

/// `DataScannerViewController` reading QR codes; reports each new payload once.
private struct DataScanner: UIViewControllerRepresentable {
  let onScan: (String) -> Void

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let scanner = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])],
      qualityLevel: .balanced,
      recognizesMultipleItems: false,
      isHighFrameRateTrackingEnabled: false,
      isHighlightingEnabled: true)
    scanner.delegate = context.coordinator
    try? scanner.startScanning()
    return scanner
  }

  func updateUIViewController(_: DataScannerViewController, context: Context) {
    context.coordinator.onScan = onScan
  }

  static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator _: Coordinator) {
    scanner.stopScanning()
  }

  func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    var onScan: (String) -> Void
    private var lastPayload: String?

    init(onScan: @escaping (String) -> Void) {
      self.onScan = onScan
    }

    func dataScanner(_: DataScannerViewController, didAdd items: [RecognizedItem], allItems _: [RecognizedItem]) {
      for case .barcode(let barcode) in items {
        guard let payload = barcode.payloadStringValue, payload != lastPayload else { continue }
        lastPayload = payload
        onScan(payload)
        return
      }
    }
  }
}
