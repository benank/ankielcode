import Foundation

/// Review order shared by every client (`packages/client-runtime/src/diffFileOrder.ts`):
/// dependencies before dependents, tests after their source, generated files last, then regrouped
/// so each directory stays contiguous.
public enum DiffFileOrder {
  public static func order(_ files: [DiffFile]) -> [DiffFile] {
    orderLikeTree(orderByImportsAndTier(files))
  }

  enum Tier { case source, test, generated }

  /// Lock files, build output, snapshots and minified files (the review order's last tier).
  public static func isGenerated(_ path: String) -> Bool { tier(path) == .generated }

  /// Test files (the review order's middle tier, and RN's "Hide test files").
  public static func isTest(_ path: String) -> Bool { tier(path) == .test }

  static let generatedNames: Set<String> = [
    "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lockb", "Cargo.lock", "go.sum", "composer.lock",
    "Gemfile.lock",
  ]
  static let generatedDirectories: Set<String> = ["__snapshots__", "__generated__", "dist", "build", "vendor"]
  static let testDirectories: Set<String> = ["__tests__", "tests", "test"]
  /// `.mts` also ends in `.ts`, so longer extensions come first.
  static let moduleExtensions = [".mts", ".cts", ".mjs", ".cjs", ".tsx", ".jsx", ".ts", ".js"]

  static func tier(_ path: String) -> Tier {
    let segments = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    let name = segments.last ?? ""
    let directories = segments.dropLast()
    if generatedNames.contains(name) || name.hasSuffix(".snap") || name.hasSuffix(".min.js") || name.hasSuffix(".min.css")
      || name.contains(".generated.") || directories.contains(where: generatedDirectories.contains)
    {
      return .generated
    }
    if name.contains(".test.") || name.contains(".spec.") || directories.contains(where: testDirectories.contains) {
      return .test
    }
    return .source
  }

  /// JavaScript's `localeCompare` (ICU root collation), close enough for paths.
  static func localeLess(_ left: String, _ right: String) -> Bool {
    left.compare(right, locale: Locale(identifier: "en_US")) == .orderedAscending
  }

  static func stripExtension(_ path: String) -> String {
    guard let dot = path.lastIndex(of: ".") else { return path }
    if let slash = path.lastIndex(of: "/"), slash > dot { return path }
    return String(path[..<dot])
  }

  static func baseName(_ path: String) -> String {
    stripExtension(String(path.split(separator: "/", omittingEmptySubsequences: false).last ?? ""))
  }

  static func stripModuleExtension(_ path: String) -> String {
    guard let ext = moduleExtensions.first(where: { path.hasSuffix($0) }) else { return path }
    return String(path.dropLast(ext.count))
  }

  static func moduleName(_ path: String) -> String {
    stripModuleExtension(String(path.split(separator: "/", omittingEmptySubsequences: false).last ?? ""))
  }

  static func resolveRelative(_ from: String, _ specifier: String) -> String {
    var segments = from.split(separator: "/", omittingEmptySubsequences: false).dropLast().map(String.init)
    for part in specifier.split(separator: "/", omittingEmptySubsequences: false) {
      if part == "." || part.isEmpty { continue }
      if part == ".." {
        if !segments.isEmpty { segments.removeLast() }
      } else {
        segments.append(String(part))
      }
    }
    return segments.joined(separator: "/")
  }

  /// `(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*["']([^"']+)["']`
  static let importPattern = try! NSRegularExpression(
    pattern: #"(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*["']([^"']+)["']"#)

  static func importedPaths(
    _ path: String, lines: [String], byModulePath: [String: String], byModuleName: [String: String]
  ) -> Set<String> {
    var imported = Set<String>()
    for line in lines {
      let ns = line as NSString
      for match in importPattern.matches(in: line, range: NSRange(location: 0, length: ns.length)) {
        var specifier = ns.substring(with: match.range(at: 1))
        // Bundler queries such as `?worker` name the same file.
        if let query = specifier.firstIndex(of: "?") { specifier = String(specifier[..<query]) }
        let resolved = stripModuleExtension(specifier.hasPrefix(".") ? resolveRelative(path, specifier) : specifier)
        let target = byModulePath[resolved] ?? byModulePath["\(resolved)/index"] ?? byModuleName[moduleName(resolved)]
        if let target, target != path { imported.insert(target) }
      }
    }
    return imported
  }

  static func orderByImports(_ paths: [String], imports: [String: Set<String>]) -> [String] {
    var remaining = Set(paths)
    var ordered: [String] = []
    let sorted = paths.sorted(by: localeLess)
    while !remaining.isEmpty {
      let candidates = sorted.filter { remaining.contains($0) }
      let next = candidates.first { candidate in
        (imports[candidate] ?? []).allSatisfy { !remaining.contains($0) }
      } ?? candidates[0]
      remaining.remove(next)
      ordered.append(next)
    }
    return ordered
  }

  /// `a.logic.test.ts` covers `a.logic.ts`: the longest dotted prefix that names a source wins.
  static func testedSourcePosition(_ path: String, _ positions: [String: Int]) -> Int {
    var name = String(path.split(separator: "/", omittingEmptySubsequences: false).last ?? "")
    if let range = name.range(of: #"\.(?:test|spec)\..*$"#, options: .regularExpression) {
      name = String(name[..<range.lowerBound])
    }
    while true {
      if let position = positions[name] { return position }
      guard let dot = name.lastIndex(of: "."), dot > name.startIndex else { return Int.max }
      name = String(name[..<dot])
    }
  }

  static func orderByImportsAndTier(_ files: [DiffFile]) -> [DiffFile] {
    var byPath: [String: [DiffFile]] = [:]
    var pathOrder: [String] = []
    for file in files {
      if byPath[file.path] == nil { pathOrder.append(file.path) }
      byPath[file.path, default: []].append(file)
    }
    let tiers = Dictionary(uniqueKeysWithValues: pathOrder.map { ($0, tier($0)) })
    let sourcePaths = pathOrder.filter { tiers[$0] == .source }
    var byModulePath: [String: String] = [:]
    var byModuleName: [String: String] = [:]
    var ambiguous = Set<String>()
    for path in sourcePaths {
      byModulePath[stripModuleExtension(path)] = path
      let name = moduleName(path)
      if byModuleName[name] != nil { ambiguous.insert(name) }
      byModuleName[name] = path
    }
    for name in ambiguous { byModuleName[name] = nil }
    var imports: [String: Set<String>] = [:]
    for path in sourcePaths {
      // Both sides of each hunk, context included (Pierre's `additionLines` + `deletionLines`).
      let lines = byPath[path]!.flatMap { file in file.hunks.flatMap { $0.lines.map(\.text) } }
      imports[path] = importedPaths(path, lines: lines, byModulePath: byModulePath, byModuleName: byModuleName)
    }
    let orderedSource = orderByImports(sourcePaths, imports: imports)
    var sourcePositions: [String: Int] = [:]
    for (index, path) in orderedSource.enumerated() where sourcePositions[baseName(path)] == nil {
      sourcePositions[baseName(path)] = index
    }
    let tests = pathOrder.filter { tiers[$0] == .test }.sorted { left, right in
      let l = testedSourcePosition(left, sourcePositions)
      let r = testedSourcePosition(right, sourcePositions)
      return l != r ? l < r : localeLess(left, right)
    }
    let generated = pathOrder.filter { tiers[$0] == .generated }.sorted(by: localeLess)
    return (orderedSource + tests + generated).flatMap { byPath[$0]! }
  }

  static func orderLikeTree(_ files: [DiffFile]) -> [DiffFile] {
    var positions: [String: Int] = [:]
    for (index, file) in files.enumerated() {
      positions[file.path] = index
      var directory = ""
      for segment in file.path.split(separator: "/", omittingEmptySubsequences: false).dropLast() {
        directory += "\(segment)/"
        if positions[directory] == nil { positions[directory] = index }
      }
    }
    let keyed = files.enumerated().map { index, file -> (DiffFile, [Int], Int) in
      var key: [Int] = []
      var directory = ""
      for segment in file.path.split(separator: "/", omittingEmptySubsequences: false).dropLast() {
        directory += "\(segment)/"
        key.append(positions[directory]!)
      }
      key.append(positions[file.path]!)
      return (file, key, index)
    }
    return keyed.sorted { left, right in
      for (l, r) in zip(left.1, right.1) where l != r { return l < r }
      if left.1.count != right.1.count { return left.1.count < right.1.count }
      return left.2 < right.2
    }.map(\.0)
  }
}
