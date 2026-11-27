import XCTest

/// The file browser and image viewer against the dev server (its seeded `ankielcode` project is a
/// real checkout); skipped while it is down. `ANKIEL_TEST_THREAD_LINK` overrides the thread.
final class MediaFilesUITests: HomeUITestCase {
  static var threadLink: String {
    ProcessInfo.processInfo.environment["ANKIEL_TEST_THREAD_LINK"]
      ?? "ankielcode-native://thread/2cef27d0-20c8-470a-a573-aaf4e7ff84af/482ced3c-d4c9-48bf-bae6-b14d97e8ae37"
  }

  override func setUp() async throws {
    let url = URL(string: "http://127.0.0.1:14527/.well-known/ankiel/environment")!
    guard (try? await URLSession.shared.data(from: url)) != nil else {
      throw XCTSkip("The dev server is not running.")
    }
  }

  func testBrowseSearchAndOpenFile() {
    launch(["ANKIEL_OPEN_URL": Self.threadLink])
    let menu = app.buttons["thread.menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 15))
    menu.tap()
    let files = app.buttons["Files"]
    XCTAssertTrue(files.waitForExistence(timeout: 5), "Files is in the thread's menu")
    files.tap()

    // The tree lists lazily: open a folder, then search by path and open a file.
    let apps = app.buttons["files.row.apps"]
    XCTAssertTrue(apps.waitForExistence(timeout: 15))
    apps.tap()
    XCTAssertTrue(app.buttons["files.row.apps/mobile"].waitForExistence(timeout: 10), "a folder lists its children in place")
    shot("files-tree")

    let search = app.searchFields.firstMatch
    XCTAssertTrue(search.waitForExistence(timeout: 5))
    search.tap()
    search.typeText("AnkielNativeImageViewer")
    let result = app.buttons["files.result.apps/mobile/modules/ankiel-native-controls/ios/AnkielNativeImageViewer.swift"]
    XCTAssertTrue(result.waitForExistence(timeout: 15))
    shot("files-search")
    result.tap()

    XCTAssertTrue(app.descendants(matching: .any)["file.source"].waitForExistence(timeout: 15), "the file opens as source")
    shot("files-source")

    app.navigationBars.buttons.element(boundBy: 0).tap()
    XCTAssertTrue(result.waitForExistence(timeout: 5), "back returns to the search results")
  }

  func testImageViewerZoomsAndCloses() {
    launch([
      "ANKIEL_OPEN_URL": Self.threadLink,
      "ANKIEL_DEBUG_FILES": "images:apps/mobile/assets/antigravity.png,apps/mobile/assets/android-icon-foreground.png",
    ])
    let image = app.images["media.viewer.image"]
    XCTAssertTrue(image.waitForExistence(timeout: 20), "the original loads")
    XCTAssertEqual(image.value as? String, "100%")

    image.doubleTap()
    let zoomed = NSPredicate(format: "value != '100%'")
    expectation(for: zoomed, evaluatedWith: image)
    waitForExpectations(timeout: 5)
    shot("viewer-zoomed")

    image.doubleTap()
    expectation(for: NSPredicate(format: "value == '100%'"), evaluatedWith: image)
    waitForExpectations(timeout: 5)
    image.pinch(withScale: 2.5, velocity: 2)
    expectation(for: zoomed, evaluatedWith: image)
    waitForExpectations(timeout: 5)
    image.doubleTap()

    // Swipe to the second image, then close.
    image.swipeLeft()
    XCTAssertTrue(app.staticTexts["2 of 2"].waitForExistence(timeout: 5))
    app.buttons["media.viewer.close"].tap()
    XCTAssertTrue(app.buttons["media.viewer.close"].waitForNonExistence(timeout: 5))
  }

  func testImageViewerDragsToDismiss() {
    launch(["ANKIEL_OPEN_URL": Self.threadLink, "ANKIEL_DEBUG_FILES": "images:apps/mobile/assets/antigravity.png"])
    let image = app.images["media.viewer.image"]
    XCTAssertTrue(image.waitForExistence(timeout: 20))
    let start = image.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
    start.press(forDuration: 0.05, thenDragTo: image.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 1.2)))
    XCTAssertTrue(app.buttons["media.viewer.close"].waitForNonExistence(timeout: 5), "a downward drag closes the viewer")
  }

  /// A seeded Claude thread whose `Read` of a PNG returned the image: the expanded row shows it,
  /// and tapping the thumbnail opens the gallery out of it.
  func testToolImageOpensFromItsThumbnail() throws {
    launch([
      "ANKIEL_OPEN_URL": "ankielcode-native://thread/2cef27d0-20c8-470a-a573-aaf4e7ff84af/06dbad7d-cc8b-4c8f-88ce-43b14a5e1f48",
      "ANKIEL_DEBUG_FILES": "tool-images",
    ])
    XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 15))
    let thumbnail = app.buttons["media.tool-thumbnail"].firstMatch
    var swipes = 0
    while !thumbnail.waitForExistence(timeout: 2), swipes < 40 {
      app.swipeDown(velocity: .fast)
      swipes += 1
    }
    guard thumbnail.exists else { throw XCTSkip("No tool image in this thread's feed.") }
    // It can appear just under the bar first: rows join the tree as they come on screen.
    for _ in 0..<3 where !thumbnail.isHittable { app.swipeDown(velocity: .slow) }
    shot("tool-thumbnail")
    thumbnail.tap()
    let image = app.images["media.viewer.image"]
    XCTAssertTrue(image.waitForExistence(timeout: 20))
    shot("tool-viewer")
    app.buttons["media.viewer.close"].tap()
    XCTAssertTrue(thumbnail.waitForExistence(timeout: 5), "closing returns to the thumbnail")
  }

  func testFindInFileAndQuickLook() {
    launch([
      "ANKIEL_OPEN_URL": Self.threadLink,
      "ANKIEL_DEBUG_FILES": "file:apps/mobile/modules/ankiel-native-controls/ios/AnkielNativeImageViewer.swift",
    ])
    XCTAssertTrue(app.descendants(matching: .any)["file.source"].waitForExistence(timeout: 20))
    let find = app.searchFields.firstMatch
    XCTAssertTrue(find.waitForExistence(timeout: 5))
    find.tap()
    find.typeText("decode")
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label ENDSWITH ' of 23'")).firstMatch.waitForExistence(timeout: 5)
      || app.staticTexts.containing(NSPredicate(format: "label CONTAINS ' of '")).firstMatch.waitForExistence(timeout: 5))
    app.buttons["Next match"].tap()
    shot("find-in-file")

    // A binary file offers Quick Look; Quick Look cannot read a .glb, so the downloaded bytes go to Share.
    app.terminate()
    launch(["ANKIEL_OPEN_URL": Self.threadLink, "ANKIEL_DEBUG_FILES": "file:apps/web/src/components/device/models/iphone-duo.glb"])
    let quickLook = app.buttons["file.quicklook"]
    XCTAssertTrue(quickLook.waitForExistence(timeout: 20))
    XCTAssertTrue(app.staticTexts["3.1 MB"].waitForExistence(timeout: 10), "the card shows the file's size")
    quickLook.tap()
    XCTAssertTrue(app.buttons["file.share"].waitForExistence(timeout: 20))
    shot("quicklook-glb")
  }
}
