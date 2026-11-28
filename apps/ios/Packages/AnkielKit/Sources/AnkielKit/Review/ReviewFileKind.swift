import Foundation

/// What a changed file's path says about it. Review shows files in the server's order, as every
/// client on main does.
public enum ReviewFileKind {
  /// Tests and their support files (mocks, fixtures, snapshots), which "Hide test files" hides
  /// (`isTestChangedFile` in `packages/shared/src/changedFileKind.ts`).
  public static func isTest(_ path: String) -> Bool {
    var segments = path.replacingOccurrences(of: "\\", with: "/").split(separator: "/", omittingEmptySubsequences: false)
      .map(String.init)
    let name = segments.popLast() ?? ""
    let directories = segments.map { $0.lowercased() }
    func inDirectory(_ set: Set<String>) -> Bool { directories.contains(where: set.contains) }
    if generatedNames.contains(name.lowercased()) || name.contains(generatedName) || inDirectory(generatedDirectories) {
      return false
    }
    if name.contains(mockName) || name.contains(mockPrefix) || inDirectory(mockDirectories) { return true }
    return name.contains(testName) || name.contains(classTestName) || inDirectory(testDirectories)
  }

  /// Lock files, build output, snapshots and minified files, which the diff folds until tapped.
  /// iOS only: no other client folds them.
  public static func isFolded(_ path: String) -> Bool {
    let segments = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    let name = segments.last ?? ""
    return foldedNames.contains(name) || name.hasSuffix(".snap") || name.hasSuffix(".min.js") || name.hasSuffix(".min.css")
      || name.contains(".generated.") || segments.dropLast().contains(where: foldedDirectories.contains)
  }

  static let foldedNames: Set<String> = [
    "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lockb", "Cargo.lock", "go.sum", "composer.lock",
    "Gemfile.lock",
  ]
  static let foldedDirectories: Set<String> = ["__snapshots__", "__generated__", "dist", "build", "vendor"]

  static let generatedNames: Set<String> = [
    "bun.lock", "bun.lockb", "cargo.lock", "composer.lock", "deno.lock", "flake.lock", "gemfile.lock", "go.sum",
    "gradle.lockfile", "mix.lock", "npm-shrinkwrap.json", "package-lock.json", "packages.lock.json", "pipfile.lock",
    "pnpm-lock.yaml", "podfile.lock", "poetry.lock", "pubspec.lock", "uv.lock", "yarn.lock",
  ]
  static let generatedDirectories: Set<String> = ["__generated__", "_generated", "generated"]
  static let mockDirectories: Set<String> = [
    "__fixtures__", "__mocks__", "__snapshots__", "fakes", "fixture", "fixtures", "mock", "mocks", "stubs", "testdata",
  ]
  static let testDirectories: Set<String> = ["__tests__", "__test__", "cypress", "e2e", "evals", "spec", "specs", "test", "tests"]

  nonisolated(unsafe) static let generatedName =
    /(\.generated\.|\.gen\.|\.g\.dart$|\.pb\.go$|_pb2(_grpc)?\.py$|\.pb\.(cc|h)$|\.min\.(js|css)$|\.(js|css)\.map$)/
  nonisolated(unsafe) static let mockName = /(\.snap$|\.(mocks?|fixtures?|stubs?|fakes?)\.[^.]+$)/.ignoresCase()
  /// Case-sensitive after the prefix: `MockClock.ts` is a mock, `Mockup.ts` is not.
  nonisolated(unsafe) static let mockPrefix = /^([Mm]ocks?|[Ff]ixtures?|[Ss]tubs?|[Ff]akes?)([-_.A-Z]|$)/
  nonisolated(unsafe) static let testName =
    /(\.(test|spec|e2e|eval|stories)\.[^.]+$|_(test|spec)\.[^.]+$|^test_.+\.py$|^conftest\.py$|^(vitest|jest)\.setup\.[^.]+$)/
    .ignoresCase()
  /// Case-sensitive: `FooTest.java` is a test class, `Latest.java` is not.
  nonisolated(unsafe) static let classTestName = /(Tests?|Spec)\.(java|kt|kts|scala|groovy|cs|php|swift|m)$/
}
