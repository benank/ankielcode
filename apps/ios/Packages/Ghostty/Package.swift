// swift-tools-version: 6.2
import PackageDescription

// The prebuilt libghostty the RN app vendors (see README.md here). Only the app links it: the widget
// links AnkielKit, and a binary target there would pull Ghostty into the widget too.
let package = Package(
  name: "Ghostty",
  platforms: [.iOS(.v26)],
  products: [.library(name: "AnkielGhostty", targets: ["AnkielGhostty"])],
  targets: [
    .binaryTarget(name: "GhosttyKit", path: "GhosttyKit.xcframework"),
    .target(
      name: "AnkielGhostty",
      dependencies: ["GhosttyKit"],
      linkerSettings: [
        .linkedLibrary("c++"), .linkedLibrary("z"),
        .linkedFramework("Metal"), .linkedFramework("MetalKit"),
        .linkedFramework("IOSurface"), .linkedFramework("QuartzCore"),
      ]
    ),
  ]
)
