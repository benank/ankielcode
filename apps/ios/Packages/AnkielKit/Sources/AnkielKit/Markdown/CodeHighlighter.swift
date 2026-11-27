import Foundation

/// One highlighted span.
public struct CodeToken: Sendable, Hashable {
  public enum Kind: String, Sendable, Hashable, CaseIterable {
    case keyword, string, comment, number, type, property, punctuation, tag, attribute
    case added, removed, hunk, meta
  }

  public var kind: Kind
  public var range: Range<Int>
}

/// A small single-pass tokenizer for common languages: Swift, TypeScript/JavaScript, JSON, Python,
/// shell, diff, Rust, Go, HTML/XML and CSS. Unknown languages render plain. It colors keywords,
/// strings, comments, numbers and capitalized type names; it does not parse.
public struct CodeHighlighter: Sendable {
  let style: [CodeToken.Kind: AttributeContainer]

  public init(style: [CodeToken.Kind: AttributeContainer] = [:]) {
    self.style = style
  }

  public func highlight(_ code: String, language: String?) -> AttributedString {
    var attributed = AttributedString(code)
    guard !style.isEmpty, let grammar = Grammar.named(language) else { return attributed }
    let tokens = Self.tokens(code, grammar: grammar)
    guard !tokens.isEmpty else { return attributed }
    // Offsets are in Characters; walk the attributed string's character view once.
    var index = attributed.startIndex
    var offset = 0
    for token in tokens {
      guard let container = style[token.kind] else { continue }
      index = attributed.characters.index(index, offsetBy: token.range.lowerBound - offset)
      offset = token.range.lowerBound
      let end = attributed.characters.index(index, offsetBy: token.range.count)
      attributed[index..<end].mergeAttributes(container)
    }
    return attributed
  }

  /// The tokens of `code`, in order, as Character offsets.
  public static func tokens(_ code: String, language: String?) -> [CodeToken] {
    guard let grammar = Grammar.named(language) else { return [] }
    return tokens(code, grammar: grammar)
  }

  static func tokens(_ code: String, grammar: Grammar) -> [CodeToken] {
    let characters = Array(code)
    if grammar.isDiff { return diffTokens(characters) }
    var tokens: [CodeToken] = []
    var index = 0
    var lineStart = true
    func emit(_ kind: CodeToken.Kind, _ start: Int, _ end: Int) {
      if end > start { tokens.append(CodeToken(kind: kind, range: start..<end)) }
    }
    func matches(_ text: String, at position: Int) -> Bool {
      var cursor = position
      for character in text {
        guard cursor < characters.count, characters[cursor] == character else { return false }
        cursor += 1
      }
      return true
    }
    while index < characters.count {
      let character = characters[index]
      if character == "\n" {
        lineStart = true
        index += 1
        continue
      }
      if character == " " || character == "\t" {
        index += 1
        continue
      }
      defer { lineStart = false }
      // Comments.
      if let prefix = grammar.lineComments.first(where: { matches($0, at: index) }),
        !(prefix == "#" && grammar.hashNeedsLineStart && !lineStart && index > 0 && characters[index - 1] != " ")
      {
        let start = index
        while index < characters.count, characters[index] != "\n" { index += 1 }
        emit(.comment, start, index)
        continue
      }
      if let block = grammar.blockComment, matches(block.open, at: index) {
        let start = index
        index += block.open.count
        while index < characters.count, !matches(block.close, at: index) { index += 1 }
        index = min(characters.count, index + block.close.count)
        emit(.comment, start, index)
        continue
      }
      // Strings.
      if grammar.quotes.contains(character) {
        let start = index
        let triple = matches(String(repeating: character, count: 3), at: index) && grammar.tripleQuotes
        index += triple ? 3 : 1
        while index < characters.count {
          if characters[index] == "\\" {
            index += 2
            continue
          }
          if triple {
            if matches(String(repeating: character, count: 3), at: index) {
              index += 3
              break
            }
          } else if characters[index] == character {
            index += 1
            break
          } else if characters[index] == "\n", character != "`" {
            break
          }
          index += 1
        }
        index = min(index, characters.count)
        var kind = CodeToken.Kind.string
        if grammar.isJSON {
          var look = index
          while look < characters.count, characters[look] == " " { look += 1 }
          if look < characters.count, characters[look] == ":" { kind = .property }
        }
        emit(kind, start, index)
        continue
      }
      // Markup.
      if grammar.isMarkup, character == "<" {
        let start = index
        index += 1
        if index < characters.count, characters[index] == "/" || characters[index] == "!" || characters[index] == "?" { index += 1 }
        while index < characters.count, characters[index].isLetter || characters[index].isNumber || characters[index] == "-" || characters[index] == ":" {
          index += 1
        }
        emit(.tag, start, index)
        while index < characters.count, characters[index] != ">", characters[index] != "<" {
          if characters[index] == "\"" || characters[index] == "'" {
            let quote = characters[index]
            let stringStart = index
            index += 1
            while index < characters.count, characters[index] != quote { index += 1 }
            index = min(characters.count, index + 1)
            emit(.string, stringStart, index)
          } else if characters[index].isLetter {
            let attributeStart = index
            while index < characters.count, characters[index].isLetter || characters[index] == "-" || characters[index] == ":" { index += 1 }
            emit(.attribute, attributeStart, index)
          } else {
            index += 1
          }
        }
        if index < characters.count, characters[index] == ">" {
          emit(.tag, index, index + 1)
          index += 1
        }
        continue
      }
      // Numbers.
      if character.isNumber, index == 0 || !(characters[index - 1].isLetter || characters[index - 1] == "_") {
        let start = index
        while index < characters.count, characters[index].isHexDigit || characters[index] == "." || characters[index] == "_" || characters[index] == "x" {
          index += 1
        }
        emit(.number, start, index)
        continue
      }
      // Words.
      if character.isLetter || character == "_" || character == "$" || (character == "@" && grammar.atWords) || (character == "#" && grammar.hashWords) {
        let start = index
        index += 1
        while index < characters.count, characters[index].isLetter || characters[index].isNumber || characters[index] == "_" || (grammar.dashWords && characters[index] == "-") {
          index += 1
        }
        let word = String(characters[start..<index])
        if grammar.keywords.contains(word) {
          emit(.keyword, start, index)
        } else if grammar.isCSS {
          var look = index
          while look < characters.count, characters[look] == " " { look += 1 }
          if look < characters.count, characters[look] == ":" { emit(.property, start, index) }
        } else if grammar.capitalizedTypes, let first = word.first, first.isUppercase {
          emit(.type, start, index)
        }
        continue
      }
      index += 1
    }
    return tokens
  }

  static func diffTokens(_ characters: [Character]) -> [CodeToken] {
    var tokens: [CodeToken] = []
    var start = 0
    while start < characters.count {
      var end = start
      while end < characters.count, characters[end] != "\n" { end += 1 }
      let line = characters[start..<end]
      let kind: CodeToken.Kind? =
        if line.starts(with: "+++") || line.starts(with: "---") || line.starts(with: "diff ") || line.starts(with: "index ") {
          .meta
        } else if line.first == "+" {
          .added
        } else if line.first == "-" {
          .removed
        } else if line.starts(with: "@@") {
          .hunk
        } else {
          nil
        }
      if let kind, end > start { tokens.append(CodeToken(kind: kind, range: start..<end)) }
      start = end + 1
    }
    return tokens
  }
}

struct Grammar: Sendable {
  var keywords: Set<String> = []
  var lineComments: [String] = []
  var blockComment: (open: String, close: String)?
  var quotes: Set<Character> = ["\"", "'"]
  var tripleQuotes = false
  var capitalizedTypes = false
  var atWords = false
  var hashWords = false
  var dashWords = false
  var hashNeedsLineStart = false
  var isJSON = false
  var isMarkup = false
  var isCSS = false
  var isDiff = false

  static func named(_ language: String?) -> Grammar? {
    switch language?.lowercased() {
    case "swift": swift
    case "ts", "typescript", "tsx", "js", "javascript", "jsx", "mjs", "cjs": typescript
    case "json", "jsonc", "json5": json
    case "py", "python": python
    case "sh", "bash", "zsh", "shell", "console", "shellscript", "fish": shell
    case "diff", "patch": Grammar(isDiff: true)
    case "rs", "rust": rust
    case "go", "golang": go
    case "html", "xml", "svg", "plist", "vue": Grammar(blockComment: ("<!--", "-->"), isMarkup: true)
    case "css", "scss", "less": css
    default: nil
    }
  }

  static let swift = Grammar(
    keywords: [
      "actor", "any", "as", "associatedtype", "async", "await", "break", "case", "catch", "class", "continue",
      "default", "defer", "deinit", "do", "else", "enum", "extension", "fallthrough", "false", "fileprivate",
      "final", "for", "func", "guard", "if", "import", "in", "init", "inout", "internal", "is", "let", "mutating",
      "nil", "nonisolated", "open", "operator", "override", "private", "protocol", "public", "repeat", "rethrows",
      "return", "self", "Self", "some", "static", "struct", "subscript", "super", "switch", "throw", "throws",
      "true", "try", "typealias", "var", "where", "while", "consuming", "borrowing", "sending",
    ],
    lineComments: ["//"], blockComment: ("/*", "*/"), quotes: ["\""], tripleQuotes: true, capitalizedTypes: true,
    atWords: true, hashWords: true)

  static let typescript = Grammar(
    keywords: [
      "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger",
      "declare", "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "from",
      "function", "get", "if", "implements", "import", "in", "instanceof", "interface", "keyof", "let", "new",
      "null", "of", "private", "protected", "public", "readonly", "return", "satisfies", "set", "static", "super",
      "switch", "this", "throw", "true", "try", "type", "typeof", "undefined", "var", "void", "while", "yield",
    ],
    lineComments: ["//"], blockComment: ("/*", "*/"), quotes: ["\"", "'", "`"], capitalizedTypes: true, atWords: true)

  static let json = Grammar(keywords: ["true", "false", "null"], quotes: ["\""], isJSON: true)

  static let python = Grammar(
    keywords: [
      "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except",
      "False", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "None", "nonlocal", "not",
      "or", "pass", "raise", "return", "self", "True", "try", "while", "with", "yield", "match", "case",
    ],
    lineComments: ["#"], tripleQuotes: true, capitalizedTypes: true, atWords: true)

  static let shell = Grammar(
    keywords: [
      "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "until", "case", "esac", "function",
      "return", "export", "local", "readonly", "set", "unset", "source", "cd", "echo", "exit", "sudo",
    ],
    lineComments: ["#"], hashNeedsLineStart: true)

  static let rust = Grammar(
    keywords: [
      "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "false", "fn",
      "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self",
      "Self", "static", "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while",
    ],
    lineComments: ["//"], blockComment: ("/*", "*/"), quotes: ["\""], capitalizedTypes: true, hashWords: true)

  static let go = Grammar(
    keywords: [
      "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go",
      "goto", "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch",
      "type", "var", "true", "false", "nil",
    ],
    lineComments: ["//"], blockComment: ("/*", "*/"), quotes: ["\"", "'", "`"], capitalizedTypes: true)

  static let css = Grammar(
    keywords: ["important", "inherit", "initial", "none", "auto"], blockComment: ("/*", "*/"), atWords: true,
    dashWords: true, isCSS: true)
}
