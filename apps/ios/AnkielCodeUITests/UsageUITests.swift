import XCTest

/// Usage limits on fixtures (`ANKIEL_DEBUG_USAGE`, `ANKIEL_DEBUG_CONTEXT`): opened from home's ring,
/// from a thread's context meter, and from Settings down to one account.
final class UsageUITests: HomeUITestCase {
  func testOpensFromHome() {
    launch(["ANKIEL_DEBUG_HOME": "sample", "ANKIEL_DEBUG_USAGE": "fresh"])
    let ring = app.buttons["usage.ring"]
    XCTAssertTrue(ring.waitForExistence(timeout: 10))
    XCTAssertTrue(ring.label.contains("52%"), "the ring reads the highest spend: \(ring.label)")
    ring.tap()
    XCTAssertTrue(app.staticTexts["Weekly · Opus"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.otherElements["usage.context"].exists, "home has no thread context")
    shot("usage-home-sheet")
    app.buttons["usage.done"].tap()
    XCTAssertTrue(ring.waitForExistence(timeout: 5))
  }

  func testOpensFromThreadWithContext() {
    launch(["ANKIEL_DEBUG_THREAD": "short", "ANKIEL_DEBUG_CONTEXT": "high", "ANKIEL_DEBUG_USAGE": "near"])
    let meter = app.buttons["usage.context-meter"]
    XCTAssertTrue(meter.waitForExistence(timeout: 10))
    XCTAssertTrue(meter.label.contains("93%"), "the meter reads the context window: \(meter.label)")
    meter.tap()
    XCTAssertTrue(app.staticTexts["Context window"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Nearly full. The agent compacts older context automatically."].exists)
    shot("usage-thread-sheet")
  }

  func testSettingsAccountPage() throws {
    launch(["ANKIEL_DEBUG_ROUTE": "settings-usage", "ANKIEL_DEBUG_USAGE": "fresh"])
    let account = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'usage.account.'")).firstMatch
    XCTAssertTrue(account.waitForExistence(timeout: 10))
    account.tap()
    XCTAssertTrue(app.staticTexts["Signed in"].waitForExistence(timeout: 5))
    shot("usage-account")
    app.navigationBars.buttons.element(boundBy: 0).tap()
    XCTAssertTrue(account.waitForExistence(timeout: 5))
    try audit()
  }

  /// As `AccessibilityAuditUITests`: contrast and clipping report false positives over glass.
  private func audit() throws {
    try app.performAccessibilityAudit(for: .all.subtracting(.dynamicType)) { issue in
      let label = issue.element?.label ?? ""
      switch issue.auditType {
      case .contrast, .textClipped: return true
      case .sufficientElementDescription where !label.isEmpty && !label.contains(" "): return true
      default:
        print("AUDIT \(issue.compactDescription) — \(issue.element?.debugDescription.prefix(160) ?? "no element")")
        return false
      }
    }
  }
}
