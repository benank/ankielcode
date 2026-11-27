import XCTest

/// The iPad split view: the composer stays inside the detail pane in both orientations, and the
/// sidebar's New thread button sits in its top bar. Skipped on iPhone.
final class SplitLayoutUITests: HomeUITestCase {
  override func setUp() async throws {
    let isPad = await MainActor.run { UIDevice.current.userInterfaceIdiom == .pad }
    guard isPad else { throw XCTSkip("The split view is iPad only.") }
  }

  override func tearDown() async throws {
    await MainActor.run { XCUIDevice.shared.orientation = .portrait }
  }

  func testComposerFitsTheDetailPaneInBothOrientations() {
    launch([
      "ANKIEL_DEBUG_SETTINGS": "fixture", "ANKIEL_DEBUG_HOME": "sample", "ANKIEL_DEBUG_THREAD": "rich-markdown",
      "ANKIEL_DEBUG_COMPOSER": "fake",
    ])
    let send = app.buttons["composer.send"]
    XCTAssertTrue(send.waitForExistence(timeout: 8))
    XCTAssertTrue(app.buttons["home.newThread"].isHittable, "New thread is in the sidebar's top bar")
    for orientation in [UIDeviceOrientation.portrait, .landscapeLeft] {
      XCUIDevice.shared.orientation = orientation
      sleep(1)
      let window = app.windows.firstMatch.frame
      XCTAssertLessThanOrEqual(send.frame.maxX, window.maxX - 8, "the composer keeps a margin from the window edge")
      XCTAssertLessThanOrEqual(app.buttons["home.newThread"].frame.maxY, window.midY, "New thread is at the top")
      shot("ipad-split-\(orientation == .portrait ? "portrait" : "landscape")")
    }
  }
}
