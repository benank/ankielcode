// swift-tools-version: 6.2
import PackageDescription

let approachableConcurrency: [SwiftSetting] = [
  .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
  .enableUpcomingFeature("InferIsolatedConformances"),
]

let package = Package(
  name: "AnkielKit",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "AnkielKit", targets: ["AnkielKit"]),
    .executable(name: "ankiel-probe", targets: ["ankiel-probe"]),
  ],
  targets: [
    .target(name: "AnkielKit", swiftSettings: approachableConcurrency),
    .executableTarget(
      name: "ankiel-probe",
      dependencies: ["AnkielKit"],
      swiftSettings: approachableConcurrency
    ),
    .testTarget(
      name: "AnkielKitTests",
      dependencies: ["AnkielKit"],
      resources: [.copy("Fixtures")],
      swiftSettings: approachableConcurrency
    ),
  ]
)
