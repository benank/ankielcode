import Foundation
import Testing

@testable import AnkielKit

/// Ported from `shared/composerTrigger.test.ts` and `composerInlineTokens.test.ts`.
struct ComposerTriggerTests {
  private func utf16(_ text: String) -> Int { (text as NSString).length }

  @Test(arguments: [
    ("Run /tmp/build.sh", "Run /tmp/build.sh".utf16.count),
    ("/etc/hosts", "/etc/hosts".utf16.count),
    ("Use /etc/hosts now", "Use /et".utf16.count),
    ("cmd /foo\\bar", "cmd /foo\\bar".utf16.count),
  ])
  func pathsStayOutOfTheSlashMenu(text: String, cursor: Int) {
    #expect(ComposerTrigger.detect(text, cursor: cursor) == nil)
  }

  @Test func slashCommandsAtTheStartOrALine() {
    #expect(ComposerTrigger.detect("/model", cursor: 6) == ComposerTrigger(kind: .slashCommand, query: "model", rangeStart: 0, rangeEnd: 6))
    let text = "Question\n/MODEL"
    #expect(ComposerTrigger.detect(text, cursor: utf16(text)) == ComposerTrigger(kind: .slashCommand, query: "MODEL", rangeStart: 9, rangeEnd: 15))
    #expect(ComposerTrigger.detect("/Model opus", cursor: 11) == nil)
    #expect(ComposerTrigger.detect("Use /review", cursor: 11) == ComposerTrigger(kind: .slashCommand, query: "review", rangeStart: 4, rangeEnd: 11))
  }

  @Test(arguments: ["Use/review", "https://example.com/review", "Use /review "])
  func noTrigger(text: String) {
    #expect(ComposerTrigger.detect(text, cursor: utf16(text)) == nil)
  }

  @Test func pullRequestsKeepBracketsOutside() {
    #expect(ComposerTrigger.detect("Compare (#)", cursor: 10) == ComposerTrigger(kind: .pullRequest, query: "", rangeStart: 9, rangeEnd: 10))
    #expect(ComposerTrigger.detect("【#修正】", cursor: 4) == ComposerTrigger(kind: .pullRequest, query: "修正", rangeStart: 1, rangeEnd: 4))
    for text in ["# Heading", "issue#123", "(#123)", "]#123"] {
      #expect(ComposerTrigger.detect(text, cursor: utf16(text)) == nil, "\(text)")
    }
  }

  @Test func mentionsAndSkills() {
    #expect(ComposerTrigger.detect("Use @src/(#1", cursor: 12) == ComposerTrigger(kind: .path, query: "src/(#1", rangeStart: 4, rangeEnd: 12))
    #expect(ComposerTrigger.detect("@", cursor: 1) == ComposerTrigger(kind: .path, query: "", rangeStart: 0, rangeEnd: 1))
    #expect(ComposerTrigger.detect("Use €review", cursor: 11) == ComposerTrigger(kind: .skill, query: "review", rangeStart: 4, rangeEnd: 11))
    // A non-BMP currency sign is two UTF-16 units.
    let wide = "Use 𑿝review"
    #expect(ComposerTrigger.detect(wide, cursor: utf16(wide)) == ComposerTrigger(kind: .skill, query: "review", rangeStart: 4, rangeEnd: utf16(wide)))
    for text in ["budget $9.99", "only $.99", "about €20", "raise $10k", "$1,000", "£2e6", "raise $10k."] {
      #expect(ComposerTrigger.detect(text, cursor: utf16(text)) == nil, "\(text)")
    }
    #expect(ComposerTrigger.detect("$2fa", cursor: 4)?.kind == .skill)
  }

  @Test func caretInsideEmojiText() {
    let text = "😀 look @sr"
    let trigger = ComposerTrigger.detect(text, cursor: utf16(text))
    #expect(trigger == ComposerTrigger(kind: .path, query: "sr", rangeStart: 8, rangeEnd: 11))
    let replaced = ComposerTrigger.replace(text, start: 8, end: 11, with: "[a.ts](src/a.ts) ")
    #expect(replaced.text == "😀 look [a.ts](src/a.ts) ")
    #expect(replaced.cursor == utf16(replaced.text))
  }

  @Test func wholeMessageCommands() {
    #expect(ComposerCommandText.sideChatPrompt("/side") == "")
    #expect(ComposerCommandText.sideChatPrompt("  /SIDE  why does this fail?\nline two ") == "why does this fail?\nline two")
    #expect(ComposerCommandText.sideChatPrompt("/btw check @src/a.ts") == "check @src/a.ts")
    #expect(ComposerCommandText.sideChatPrompt("/sidebar") == nil)
    #expect(ComposerCommandText.sideChatPrompt("ask /side later") == nil)
    #expect(ComposerCommandText.isClear(" /CLEAR "))
    #expect(!ComposerCommandText.isClear("/clear now"))
    #expect(ComposerCommandText.isSlashCommand("/context all", attachmentCount: 0))
    #expect(!ComposerCommandText.isSlashCommand("/context all", attachmentCount: 1))
    #expect(!ComposerCommandText.isSlashCommand("/src/a.ts", attachmentCount: 0))
  }
}

struct ComposerFileLinkTests {
  @Test func encodesMarkdownSensitiveCharacters() {
    #expect(ComposerFileLink.serialize("docs/My File (draft).md") == "[My File (draft).md](docs/My%20File%20%28draft%29.md)")
    #expect(ComposerFileLink.serialize("C:\\repo\\src\\index.ts") == "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)")
    #expect(ComposerFileLink.serialize("@scope/package.json") == "[package.json](@scope/package.json)")
    #expect(ComposerFileLink.serialize("pkg/__init__.py") == #"[\_\_init\_\_.py](pkg/__init__.py)"#)
    #expect(ComposerFileLink.serialize("README") == "[README](README)")
    #expect(ComposerFileLink.serialize("src/線性代數/考試.pdf") == "[考試.pdf](src/%E7%B7%9A%E6%80%A7%E4%BB%A3%E6%95%B8/%E8%80%83%E8%A9%A6.pdf)")
  }

  @Test func addsDotSlashWhereTheParserWouldRejectIt() {
    #expect(ComposerFileLink.serialize("C#/Program.cs") == "[Program.cs](./C%23/Program.cs)")
    // A bare folder name is not file-shaped.
    #expect(ComposerFileLink.serialize("src") == "[src](./src)")
  }

  @Test(arguments: [
    "C#/Program.cs", "docs/R&D/notes.md", "docs/Bob's notes.md", "docs/a,b.ts", "docs/100%.md", "docs/why?.md", "icon@2x.png",
    "app/routes/posts.$postId.tsx", "pages/posts/[id].tsx", "src", "src/線性代數/考試.pdf",
  ])
  func linksReadBackAsTheirPath(path: String) {
    let link = ComposerFileLink.serialize(path)
    let tokens = ComposerInlineTokens.collect("fix \(link) please")
    #expect(tokens == [ComposerInlineToken(kind: .mention, value: path, source: link, start: 4, end: 4 + (link as NSString).length)])
  }
}

struct ComposerInlineTokenTests {
  @Test func collectsLinksMentionsAndSkills() {
    let text = "Use $ui and inspect [Chat.tsx](src/Chat.tsx) with @AGENTS.md please"
    #expect(ComposerInlineTokens.collect(text) == [
      ComposerInlineToken(kind: .skill, value: "ui", source: "$ui", start: 4, end: 7),
      ComposerInlineToken(kind: .mention, value: "src/Chat.tsx", source: "[Chat.tsx](src/Chat.tsx)", start: 20, end: 44),
      ComposerInlineToken(kind: .mention, value: "AGENTS.md", source: "@AGENTS.md", start: 50, end: 60),
    ])
  }

  @Test func moneyIsNotASkill() {
    for text in ["I'll pay $20 tomorrow", "Budget is $1_000 total", "Budget is $20k tomorrow", "Cost is $100M total", "Limit is $1e6 here"] {
      #expect(ComposerInlineTokens.collect(text).isEmpty, "\(text)")
    }
    #expect(ComposerInlineTokens.collect("Use 𑿝2spec next").first?.source == "𑿝2spec")
  }

  @Test func trailingTokensWaitForWhitespace() {
    #expect(ComposerInlineTokens.collect("Use $ui").isEmpty)
    #expect(ComposerInlineTokens.collect("Inspect @AGENTS.md").isEmpty)
  }

  @Test func aConfirmedChipSurvivesLosingItsTrailingSpace() {
    let confirmed = ComposerInlineTokens.collect("[package.json](package.json) ")
    #expect(ComposerInlineTokens.collect("[package.json](package.json)", preserveTrailing: confirmed) == [
      ComposerInlineToken(kind: .mention, value: "package.json", source: "[package.json](package.json)", start: 0, end: 28),
    ])
    #expect(ComposerInlineTokens.collect("[package.json](package-json)", preserveTrailing: confirmed).isEmpty)
  }

  @Test(arguments: ["@expo/ui", "@jane/foo.js", "@scope/pkg/sub/path"])
  func scopedPackagesStayText(reference: String) {
    #expect(ComposerInlineTokens.collect("Install \(reference) next").isEmpty)
  }

  @Test(arguments: ["@namespace.foo(bar)", "@écrire(option)"])
  func decoratorsStayText(reference: String) {
    #expect(ComposerInlineTokens.collect("\(reference)\nclass Example {}").isEmpty)
  }

  @Test func quotedAndExplicitMentions() {
    #expect(ComposerInlineTokens.collect("@\"foo(bar)\" ").first?.value == "foo(bar)")
    #expect(ComposerInlineTokens.collect("Inspect @\"expo/ui\" next").first?.value == "expo/ui")
    #expect(ComposerInlineTokens.collect("Inspect [sub](@scope/pkg/sub) next").first?.value == "@scope/pkg/sub")
    #expect(ComposerInlineTokens.collect("Inspect @README.md (notes)").first?.source == "@README.md")
  }

  @Test func labelCapAndContextLinks() {
    let atCap = String(repeating: "a", count: 508) + ".tsx"
    #expect(ComposerInlineTokens.collect("see [\(atCap)](src/\(atCap)) ok").count == 1)
    let past = String(repeating: "a", count: 509) + ".tsx"
    #expect(ComposerInlineTokens.collect("see [\(past)](src/\(past)) ok").isEmpty)
    #expect(ComposerInlineTokens.collect("see [checkout.png](ankiel-context://v1/image/ctx_abc) ok").isEmpty)
  }

  @Test func authoredDotSlashKeepsItsMeaning() {
    #expect(ComposerInlineTokens.collect("fix [a.ts](./src/a.ts) please").first?.value == "./src/a.ts")
    #expect(ComposerInlineTokens.collect("fix [draft:notes.md](./draft:notes.md) please").first?.value == "./draft:notes.md")
  }

  @Test func offsetsAreUTF16() {
    let link = ComposerFileLink.serialize("src/a.ts")
    let text = "👩‍💻 \(link) ok"
    let token = ComposerInlineTokens.collect(text).first
    #expect(token?.start == ("👩‍💻 " as NSString).length)
    #expect((text as NSString).substring(with: NSRange(location: token!.start, length: token!.end - token!.start)) == link)
  }

  @Test func previewsShowFileNames() {
    let text = "fix \(ComposerFileLink.serialize("src/app/Chat.tsx"))"
    #expect(ComposerInlineTokens.plainText(text) == "fix Chat.tsx")
    #expect(ComposerInlineTokens.plainText("no links") == "no links")
    let runs = ComposerInlineTokens.runs("see \(ComposerFileLink.serialize("src/a b.ts")) and @README.md")
    #expect(runs.map(\.text) == ["see ", "a b.ts", " and ", "README.md"])
    #expect(runs.map(\.path) == [nil, "src/a b.ts", nil, "README.md"])
  }
}
