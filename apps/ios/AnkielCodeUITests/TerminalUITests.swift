import XCTest

/// A real shell on the dev server, in a thread of its `ankiel-probe live` project (a folder under
/// `/tmp`); skipped while the server is down. Opens a new terminal from the thread menu, runs
/// `echo`, rotates, and closes it with its history. `ANKIEL_TEST_TERMINAL_THREAD_LINK` overrides
/// the thread.
final class TerminalUITests: HomeUITestCase {
  static var threadLink: String {
    ProcessInfo.processInfo.environment["ANKIEL_TEST_TERMINAL_THREAD_LINK"]
      ?? "ankielcode-native://thread/2cef27d0-20c8-470a-a573-aaf4e7ff84af/a7de1ab3-632e-4553-822f-d86dba49e1c5"
  }

  override func setUp() async throws {
    let url = URL(string: "http://127.0.0.1:14527/.well-known/ankiel/environment")!
    guard (try? await URLSession.shared.data(from: url)) != nil else {
      throw XCTSkip("The dev server is not running.")
    }
  }

  @MainActor
  override func tearDown() async throws {
    XCUIDevice.shared.orientation = .portrait
  }

  func testOpenTypeEchoAndClose() {
    // History files go to /tmp, not the user's home.
    launch(["ANKIEL_OPEN_URL": Self.threadLink, "ANKIEL_DEBUG_TERMINAL_HISTORY": "/tmp/ankiel-term-agent/hist",
      "ANKIEL_DEBUG_TERMINAL_INPUT": "1",
    ])
    let menu = app.buttons["thread.menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 20))
    // Terminal shows once the session's permissions and the thread's project arrive.
    // A submenu's label carries no identifier, so match the title too.
    let terminal = app.buttons.matching(NSPredicate(format: "identifier == 'thread.terminal' OR label == 'Terminal'")).firstMatch
    for _ in 0..<6 {
      menu.tap()
      if terminal.waitForExistence(timeout: 3) { break }
      shot("terminal-thread-menu-missing")
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9)).tap()
    }
    XCTAssertTrue(terminal.exists, "Terminal is in the thread's menu")
    terminal.tap()
    // With live terminals it is a submenu; a new one keeps the test off the user's shells.
    let new = app.buttons.matching(NSPredicate(format: "identifier == 'thread.terminal.new' OR label BEGINSWITH 'Open new terminal'")).firstMatch
    if new.waitForExistence(timeout: 8) {
      shot("terminal-thread-menu")
      new.tap()
    }

    let surface = app.descendants(matching: .any)["terminal.surface"]
    XCTAssertTrue(surface.waitForExistence(timeout: 20))
    let prompt = NSPredicate(format: "value CONTAINS '%'")
    expectation(for: prompt, evaluatedWith: surface)
    waitForExpectations(timeout: 30)

    surface.tap()
    XCTAssertTrue(app.buttons["terminal.key.esc"].waitForExistence(timeout: 5), "the accessory bar shows with the keyboard")
    app.textFields["terminal.input"].typeText(" echo ui-$((6*7))\n")
    expectation(for: NSPredicate(format: "value CONTAINS 'ui-42'"), evaluatedWith: surface)
    waitForExpectations(timeout: 15)
    shot("terminal-echo")

    XCUIDevice.shared.orientation = .landscapeLeft
    app.textFields["terminal.input"].typeText(" stty size\n")
    // Landscape is wider than portrait's 40-odd columns.
    expectation(for: NSPredicate(format: "value MATCHES '(?s).*\\\\b[0-9]+ ([6-9][0-9]|1[0-9][0-9])\\\\b.*'"), evaluatedWith: surface)
    waitForExpectations(timeout: 15)
    shot("terminal-landscape")
    XCUIDevice.shared.orientation = .portrait

    app.buttons["terminal.dismissKeyboard"].tap()
    XCTAssertTrue(app.buttons["terminal.showKeyboard"].waitForExistence(timeout: 5))
    app.buttons["terminal.menu"].tap()
    shot("terminal-options")
    let close = app.buttons.matching(NSPredicate(format: "identifier == 'terminal.close' OR label == 'Close terminal'")).firstMatch
    XCTAssertTrue(close.waitForExistence(timeout: 5))
    close.tap()
    let confirm = app.buttons["Close terminal"].firstMatch
    XCTAssertTrue(confirm.waitForExistence(timeout: 5))
    confirm.tap()
    // Closing leaves for the thread's next live terminal, or the thread when none is left.
    XCTAssertTrue(confirm.waitForNonExistence(timeout: 5))
    XCTAssertFalse(app.alerts["Couldn't close terminal"].waitForExistence(timeout: 3), "the server closed it")
    shot("terminal-after-close")
  }

  /// Scrolls back through `cat` output, then `exit` leaves the screen (no other shell is live).
  func testScrollbackAndExit() {
    launch([
      "ANKIEL_OPEN_URL": Self.threadLink,
      "ANKIEL_DEBUG_TERMINAL": "new",
      "ANKIEL_DEBUG_TERMINAL_HISTORY": "/tmp/ankiel-term-agent/hist",
      "ANKIEL_DEBUG_TERMINAL_INPUT": "1",
      "ANKIEL_DEBUG_TERMINAL_SEND": " for i in $(seq 1 200); do echo row-$i; done\\r",
    ])
    let surface = app.descendants(matching: .any)["terminal.surface"]
    XCTAssertTrue(surface.waitForExistence(timeout: 30))
    expectation(for: NSPredicate(format: "value CONTAINS 'row-200'"), evaluatedWith: surface)
    waitForExpectations(timeout: 20)
    XCTAssertNil((surface.value as? String ?? "").firstMatch(of: /row-100\D/), "the start is above the screen")

    for _ in 0..<6 { surface.swipeDown(velocity: .fast) }
    expectation(for: NSPredicate(format: "NOT (value CONTAINS 'row-200')"), evaluatedWith: surface)
    waitForExpectations(timeout: 10)
    shot("terminal-scrolled-back")

    surface.tap()
    app.textFields["terminal.input"].typeText(" exit\n")
    XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 15), "an exited shell leaves for the thread")
  }
}
