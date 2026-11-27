import Foundation
import Testing

@testable import AnkielKit

@Suite("Markdown parser")
struct MarkdownParserTests {
  private func parse(_ text: String) -> [MarkdownBlock] {
    MarkdownParser().parse(text).blocks
  }

  private func shape(_ blocks: [MarkdownBlock]) -> [String] {
    blocks.map { block in
      switch block.kind {
      case .heading(let level, let text): "h\(level):\(text.plain)"
      case .paragraph(let text): "p:\(text.plain)"
      case .list(let list):
        "\(list.start.map { "ol\($0)" } ?? "ul")[" + list.items.map { item in
          (item.checked.map { $0 ? "x " : "o " } ?? "") + shape(item.blocks).joined(separator: "|")
        }.joined(separator: ";") + "]"
      case .quote(let blocks): "q[" + shape(blocks).joined(separator: "|") + "]"
      case .code(let code): "code(\(code.language ?? "-"),\(code.closed)):\(code.code)"
      case .table(let table): "table\(table.header.count)x\(table.rows.count)"
      case .image(let alt, let source): "img:\(alt)@\(source)"
      case .thematicBreak: "hr"
      }
    }
  }

  @Test("headings, paragraphs and breaks")
  func basics() {
    #expect(shape(parse("# Title\n\nSome *text*\nnext line\n\n---\n\n### Sub ###")) == [
      "h1:Title", "p:Some text\nnext line", "hr", "h3:Sub",
    ])
    #expect(shape(parse("#not a heading")) == ["p:#not a heading"])
  }

  @Test("inline styles come from Foundation and keep plain text")
  func inline() throws {
    let blocks = parse("A **bold** and `code` and ~~gone~~ with [a link](https://example.com).")
    guard case .paragraph(let text) = blocks.first?.kind else { throw Expectation.failed }
    #expect(text.plain == "A bold and code and gone with a link.")
    let intents = text.attributed.runs.compactMap(\.inlinePresentationIntent)
    #expect(intents.contains(.stronglyEmphasized))
    #expect(intents.contains(.code))
    #expect(intents.contains(.strikethrough))
    #expect(text.attributed.runs.contains { $0.link == URL(string: "https://example.com") })
  }

  @Test("bare URLs become links, but not inside code")
  func autolinks() throws {
    guard case .paragraph(let text) = parse("See https://example.com/docs and `https://not.a/link`").first?.kind else {
      throw Expectation.failed
    }
    let links = text.attributed.runs.compactMap(\.link)
    #expect(links == [URL(string: "https://example.com/docs")!])
  }

  @Test("bullet, ordered, nested and task lists")
  func lists() {
    #expect(shape(parse("- one\n- two\n  - nested\n- three")) == ["ul[p:one;p:two|ul[p:nested];p:three]"])
    #expect(shape(parse("3. three\n4. four")) == ["ol3[p:three;p:four]"])
    #expect(shape(parse("- [x] done\n- [ ] todo")) == ["ul[x p:done;o p:todo]"])
    #expect(shape(parse("1. Parser\n   - Headings\n   - Lists\n2. Inline")) == ["ol1[p:Parser|ul[p:Headings;p:Lists];p:Inline]"])
    // An ordered list not starting at 1 does not interrupt a paragraph.
    #expect(shape(parse("The year\n2024. was long")) == ["p:The year\n2024. was long"])
  }

  @Test("loose lists and lazy continuation stay in their item")
  func looseLists() {
    #expect(shape(parse("- one\n\n  more of one\n- two")) == ["ul[p:one|p:more of one;p:two]"])
    #expect(shape(parse("- one\ncontinued")) == ["ul[p:one\ncontinued]"])
  }

  @Test("block quotes parse their content")
  func quotes() {
    #expect(shape(parse("> quoted **text**\n> - item\n\nafter")) == ["q[p:quoted text|ul[p:item]]", "p:after"])
  }

  @Test("fenced code, closed and still streaming")
  func fences() {
    #expect(shape(parse("```swift\nlet a = 1\n```\ntext")) == ["code(swift,true):let a = 1", "p:text"])
    #expect(shape(parse("~~~\nraw\n~~~")) == ["code(-,true):raw"])
    #expect(shape(parse("```ts\nconst x = 1\nconst y")) == ["code(ts,false):const x = 1\nconst y"])
    #expect(shape(parse("````\n```\ninner\n```\n````")) == ["code(-,true):```\ninner\n```"])
  }

  @Test("pipe tables with alignment and escaped pipes")
  func tables() throws {
    let blocks = parse("| A | B | C |\n| :--- | :---: | ---: |\n| 1 | `a|b` | x \\| y |\n| 2 |\n\nafter")
    #expect(shape(blocks) == ["table3x2", "p:after"])
    guard case .table(let table) = blocks.first?.kind else { throw Expectation.failed }
    #expect(table.alignments == [.leading, .center, .trailing])
    #expect(table.rows[0].map(\.plain) == ["1", "a|b", "x | y"])
    #expect(table.rows[1].map(\.plain) == ["2", "", ""])
  }

  @Test("an image alone in a paragraph is an image block")
  func images() {
    #expect(shape(parse("![Screen](assets/shot.png)")) == ["img:Screen@assets/shot.png"])
    #expect(shape(parse("Text ![x](y.png) inline")).first?.hasPrefix("p:") == true)
  }

  @Test("block ids are positional and stable as a message grows")
  func stableIds() {
    let parser = MarkdownParser()
    let short = parser.parse("# A\n\nfirst para\n\nsecond")
    let long = parser.parse("# A\n\nfirst para\n\nsecond para grows")
    #expect(short.blocks.map(\.id) == ["0", "1", "2"])
    #expect(long.blocks.map(\.id) == ["0", "1", "2"])
    #expect(short.blocks[0] == long.blocks[0])
    #expect(short.blocks[1] == long.blocks[1])
  }

  @Test("every streaming prefix of a long document parses, and finished blocks never change")
  func streamingPrefixes() throws {
    let projection = try ThreadFixtures.projection("thread-rich-markdown")
    let document = try #require(projection.turnItems.compactMap { item -> String? in
      if case .assistantMessage(let message) = item.body, message.text.contains("|") { message.text } else { nil }
    }.max { $0.count < $1.count })
    let parser = MarkdownParser()
    let final = parser.parse(document)
    #expect(final.blocks.count >= 9)
    var previous: [MarkdownBlock] = []
    let characters = Array(document)
    for end in stride(from: 1, through: characters.count, by: 7) {
      let blocks = parser.parse(String(characters[..<end])).blocks
      // All but the last block of the previous prefix are finished: they stay identical unless
      // the new text turned the last one into something else (a paragraph becoming a table).
      for (old, new) in zip(previous.dropLast(2), blocks) {
        #expect(old == new, "block \(old.id) changed at \(end)")
      }
      previous = blocks
    }
    #expect(parser.parse(document) == final)
  }

  @Test("plain text for copying")
  func plainText() {
    let document = MarkdownParser().parse("# T\n\n- a\n- b\n\n```\ncode\n```")
    #expect(document.plainText == "T\n\n• a\n• b\n\ncode")
  }
}

@Suite("Code highlighter")
struct CodeHighlighterTests {
  private func kinds(_ code: String, _ language: String) -> [String] {
    let characters = Array(code)
    return CodeHighlighter.tokens(code, language: language).map {
      "\($0.kind.rawValue):\(String(characters[$0.range]))"
    }
  }

  @Test("swift")
  func swift() {
    #expect(kinds("let a: Int = 42 // note\nlet s = \"hi\"", "swift") == [
      "keyword:let", "type:Int", "number:42", "comment:// note", "keyword:let", "string:\"hi\"",
    ])
  }

  @Test("json keys and values")
  func json() {
    #expect(kinds("{\"ok\": true, \"n\": 1.5, \"s\": \"x\"}", "json") == [
      "property:\"ok\"", "keyword:true", "property:\"n\"", "number:1.5", "property:\"s\"", "string:\"x\"",
    ])
  }

  @Test("diff lines")
  func diff() {
    #expect(kinds("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n same", "diff") == [
      "meta:--- a", "meta:+++ b", "hunk:@@ -1 +1 @@", "removed:-old", "added:+new",
    ])
  }

  @Test("shell comments only start a word")
  func shell() {
    #expect(kinds("echo a#b # real", "bash") == ["keyword:echo", "comment:# real"])
  }

  @Test("unknown languages stay plain")
  func unknown() {
    #expect(CodeHighlighter.tokens("anything", language: "cobol").isEmpty)
    #expect(CodeHighlighter.tokens("anything", language: nil).isEmpty)
  }

  @Test("highlighting applies the style to token ranges")
  func applies() {
    var keyword = AttributeContainer()
    keyword.inlinePresentationIntent = .stronglyEmphasized
    let highlighted = CodeHighlighter(style: [.keyword: keyword]).highlight("let x = 1", language: "swift")
    let styled = highlighted.runs.filter { $0.inlinePresentationIntent == .stronglyEmphasized }
    #expect(styled.map { String(highlighted[$0.range].characters) } == ["let"])
  }
}
