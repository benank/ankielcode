// Writes the debug thread fixtures (`AnkielCode/Thread/Fixtures/thread-<name>.json`) and
// `thread-reducer-golden.json`. Every conversation here is invented: a small SwiftUI tide-chart
// app called Tidewise. Each stream item is decoded with the server's `OrchestrationV2ThreadStreamItem`
// schema before it is written, and the golden is the TypeScript reducer's output over the decoded
// stream. The app shifts fixture timestamps to "just now" when it loads them; the files stay fixed.
// Run from the repo's `packages/contracts`:
//   node ../../apps/ios/Packages/AnkielKit/Tests/AnkielKitTests/Fixtures/threads/make-thread-fixtures.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ThreadBuilder } from "./thread-builder.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../../../../../AnkielCode/Thread/Fixtures");
const goldenPath = join(here, "../thread-reducer-golden.json");
const contracts = await import(pathToFileURL(join(process.cwd(), "src/index.ts")).href);
const S = await import(pathToFileURL(join(process.cwd(), "node_modules/effect/dist/Schema.js")).href);
const reducer = await import(pathToFileURL(join(process.cwd(), "../client-runtime/src/state/orchestrationV2Projection.ts")).href);

const day = (d, h, m = 0) => new Date(Date.UTC(2026, 10, d, h, m, 0));

// MARK: - Shared opening: two short turns about the predictor

function opening(b) {
  b.run({
    user: "Where does Tidewise compute the predicted tide height? I want to understand the harmonic model before I touch it.",
    items: [
      { cmd: "Preparing workspace", title: "Workspace ready", exit: 0, s: 0.2 },
      {
        think: "**Finding the predictor**\n\nThe package is `TideKit`, so the model is probably in `Sources/TideKit`. I'll list it and read the predictor.",
        s: 1.5,
      },
      { cmd: "ls Sources/TideKit", out: "HarmonicPredictor.swift\nStation.swift\nStationStore.swift\nTideTable.swift\nUnits.swift", exit: 0, s: 0.6 },
      { tool: "Read", input: { file_path: "Sources/TideKit/HarmonicPredictor.swift" }, s: 0.8 },
      {
        say: [
          "The prediction lives in `HarmonicPredictor.height(at:)` in `Sources/TideKit/HarmonicPredictor.swift`. It sums the station's tidal constituents:",
          "",
          "```swift",
          "func height(at date: Date) -> Double {",
          "  let hours = date.timeIntervalSince(epoch) / 3600",
          "  return datumOffset + constituents.reduce(0) { sum, c in",
          "    sum + c.amplitude * cos((c.speed * hours + c.phase) * .pi / 180)",
          "  }",
          "}",
          "```",
          "",
          "Each constituent (M2, S2, K1, O1, …) comes from the station's entry in `config/stations.json`. `TideTable` calls this every six minutes to build a day of heights, and `TideChartView` draws that table.",
        ].join("\n"),
        s: 4.9,
      },
    ],
  });
  b.run({
    user: "Run the predictor tests so we know where we're starting from.",
    items: [
      { think: "**Running the tests**\n\nOnly the TideKit tests matter here; the app target needs a simulator.", s: 1.2 },
      {
        cmd: "swift test --filter TideKitTests",
        out: [
          "Building for debugging...",
          "[42/42] Linking TideKitPackageTests",
          "Test Suite 'TideKitTests' started.",
          "Test Case 'HarmonicPredictorTests.testHighWaterAtPortHollis' passed (0.012 seconds).",
          "Test Case 'HarmonicPredictorTests.testDatumOffset' passed (0.001 seconds).",
          "Test Case 'TideTableTests.testSixMinuteSpacing' passed (0.004 seconds).",
          "Test Case 'TideTableTests.testExtremaAreSorted' passed (0.003 seconds).",
          "Executed 4 tests, with 0 failures (0 unexpected) in 0.020 seconds",
        ].join("\n"),
        exit: 0,
        s: 6.1,
      },
      {
        say: [
          "All 4 TideKit tests pass:",
          "",
          "```bash",
          "swift test --filter TideKitTests",
          "```",
          "",
          "That covers high water at Port Hollis, the datum offset, the six-minute table spacing and extrema ordering. Nothing tests the low-water times yet, which is where the drift you mentioned would show up.",
        ].join("\n"),
        s: 2.4,
      },
    ],
  });
}

// MARK: - Conversations

const conversations = {
  short() {
    const b = new ThreadBuilder({ slug: "short", title: "Explain the harmonic predictor", start: day(26, 9) });
    opening(b);
    return b.document();
  },

  markdown() {
    const b = new ThreadBuilder({ slug: "markdown", title: "Low water times drift by twelve minutes", start: day(25, 14) });
    b.run({
      user: "Low water at Port Hollis is about 12 minutes late compared with the harbor office's printed table. High water is fine. Can you find out why?",
      items: [
        { cmd: "Preparing workspace", title: "Workspace ready", exit: 0, s: 0.2 },
        { think: "**Narrowing it down**\n\nHigh water matches and low water doesn't, so the sum is right near peaks and wrong near troughs. That points at shallow-water constituents or at how extrema are found, not at the epoch.", s: 3 },
        { cmd: "rg -n \"extrema|minimum|lowWater\" Sources/TideKit", out: "Sources/TideKit/TideTable.swift:48:  func extrema() -> [Extremum] {\nSources/TideKit/TideTable.swift:61:      if h < previous && h < next { result.append(.low(time, h)) }", exit: 0, s: 0.4 },
        { tool: "Read", input: { file_path: "Sources/TideKit/TideTable.swift", offset: 40, limit: 40 }, s: 0.6 },
        { think: "**Six-minute sampling**\n\nExtrema are picked from the six-minute samples, so the error can be at most three minutes. Twelve minutes means the curve itself is off near low water.", s: 2.2 },
        { cmd: "jq '.stations[] | select(.id == \"port-hollis\") | .constituents | map(.name)' config/stations.json", out: "[\n  \"M2\",\n  \"S2\",\n  \"N2\",\n  \"K1\",\n  \"O1\"\n]", exit: 0, s: 0.5 },
        { think: "**Missing shallow-water terms**\n\nOnly five constituents. Port Hollis sits at the head of a long, shallow inlet; harbor offices there usually publish M4 and MS4 too. Those distort the trough far more than the crest.", s: 2.8 },
        { tool: "WebFetch", input: { url: "https://tides.example.test/stations/port-hollis/harmonics", prompt: "List the constituents with amplitude and phase." }, s: 3.4 },
        { think: "**Harbor office harmonics**\n\nThe published set has M4 (0.11 m, 231°) and MS4 (0.05 m, 284°). Adding them should pull the trough earlier.", s: 1.6 },
        { cmd: "git log --oneline -5 -- config/stations.json", out: "9c1e0f2 Trim constituents to the big five for the first release\n41aa7d3 Add Port Hollis and Kettle Point\nd08b2c9 Seed station list", exit: 0, s: 0.3 },
        { cmd: "swift run tidewise-cli predict port-hollis --date 2026-11-24 --extrema", out: "2026-11-24 03:12  high  3.41 m\n2026-11-24 09:47  low   0.38 m\n2026-11-24 15:31  high  3.29 m\n2026-11-24 22:05  low   0.52 m", exit: 0, s: 4.2 },
        { think: "**Comparing**\n\nThe printed table says 09:35 and 21:53. Both lows are 12 minutes late, both highs agree. Consistent with the missing quarter-diurnal terms.", s: 2 },
        {
          say: [
            "Found it. Low water is late because the station config dropped the shallow-water constituents.",
            "",
            "## What's happening",
            "",
            "Commit `9c1e0f2` trimmed every station to the five largest constituents (M2, S2, N2, K1, O1). That's fine on the open coast, but Port Hollis is at the head of a shallow inlet, where **M4** and **MS4** are large enough to skew the curve. They barely move the crest and pull the trough earlier, which matches what you saw:",
            "",
            "| Event | Tidewise | Harbor office | Difference |",
            "| :--- | :---: | :---: | ---: |",
            "| High | 03:12 | 03:12 | 0 min |",
            "| Low | 09:47 | 09:35 | +12 min |",
            "| High | 15:31 | 15:30 | +1 min |",
            "| Low | 22:05 | 21:53 | +12 min |",
            "",
            "## Fix",
            "",
            "1. Restore M4 and MS4 for Port Hollis from the harbor office's harmonics.",
            "2. Add a test that checks a low-water time against the printed table.",
            "3. Check whether Kettle Point needs the same (it's also inside the inlet).",
            "",
            "Want me to go ahead?",
          ].join("\n"),
          s: 6,
        },
      ],
    });
    b.run({
      user: "Yes, do all three.",
      items: [
        { think: "**Restoring the constituents**\n\nAdd M4 and MS4 to Port Hollis, then write a failing test first so the fix is proven.", s: 1.8 },
        { tool: "Read", input: { file_path: "Tests/TideKitTests/HarmonicPredictorTests.swift" }, s: 0.5 },
        { edit: "Tests/TideKitTests/HarmonicPredictorTests.swift", add: 14, del: 0, s: 1.2 },
        { cmd: "swift test --filter HarmonicPredictorTests/testLowWaterAtPortHollis", out: "Test Case 'HarmonicPredictorTests.testLowWaterAtPortHollis' started.\nHarmonicPredictorTests.swift:41: error: XCTAssertEqual failed: (\"09:47\") is not equal to (\"09:35\")\nTest Case 'HarmonicPredictorTests.testLowWaterAtPortHollis' failed (0.014 seconds).\nExecuted 1 test, with 1 failure (0 unexpected) in 0.014 seconds", exit: 1, s: 5.3 },
        { think: "**Red as expected**\n\nNow the config change.", s: 0.9 },
        { edit: "config/stations.json", add: 2, del: 0, s: 0.8 },
        { cmd: "swift test --filter TideKitTests", out: "Executed 5 tests, with 0 failures (0 unexpected) in 0.023 seconds", exit: 0, s: 5.8 },
        { think: "**Kettle Point**\n\nSame inlet. Compare its predicted lows with the printed table for the same day.", s: 1.4 },
        { cmd: "swift run tidewise-cli predict kettle-point --date 2026-11-24 --extrema", out: "2026-11-24 03:20  high  3.18 m\n2026-11-24 09:58  low   0.44 m\n2026-11-24 15:39  high  3.07 m\n2026-11-24 22:16  low   0.57 m", exit: 0, s: 4 },
        { tool: "WebFetch", input: { url: "https://tides.example.test/stations/kettle-point/harmonics", prompt: "List the constituents with amplitude and phase." }, s: 2.9 },
        { edit: "config/stations.json", add: 2, del: 0, s: 0.6 },
        { cmd: "swift run tidewise-cli predict kettle-point --date 2026-11-24 --extrema", out: "2026-11-24 03:19  high  3.19 m\n2026-11-24 09:49  low   0.41 m\n2026-11-24 15:38  high  3.08 m\n2026-11-24 22:07  low   0.55 m", exit: 0, s: 4.1 },
        { cmd: "swift test", out: "Executed 9 tests, with 0 failures (0 unexpected) in 0.061 seconds", exit: 0, s: 9.5 },
        { cmd: "git diff --stat", out: " Tests/TideKitTests/HarmonicPredictorTests.swift | 14 ++++++++++++++\n config/stations.json                            |  4 ++++\n 2 files changed, 18 insertions(+)", exit: 0, s: 0.3 },
        {
          say: [
            "Done. Both inlet stations now match the harbor office's printed lows.",
            "",
            "### Changes",
            "",
            "- `config/stations.json`: added **M4** and **MS4** to Port Hollis and Kettle Point.",
            "- `HarmonicPredictorTests.testLowWaterAtPortHollis`: checks the 24 November lows (09:35 and 21:53) to the minute. It failed before the config change and passes now.",
            "",
            "### Kettle Point",
            "",
            "It was 9 minutes late, less than Port Hollis because it's nearer the inlet mouth. After the change its lows are within a minute of the table:",
            "",
            "```text",
            "09:49  low   0.41 m   (table: 09:49)",
            "22:07  low   0.55 m   (table: 22:06)",
            "```",
            "",
            "The full suite passes (9 tests). I didn't touch the other stations; they're all on the open coast, where the shallow-water terms are tiny.",
            "",
            "> If more inlet stations get added later, it may be worth a lint in `StationStore` that warns when a station marked `shallow: true` has no M4.",
          ].join("\n"),
          s: 7,
        },
      ],
    });
    return b.document();
  },

  "rich-markdown"() {
    const b = new ThreadBuilder({ slug: "rich", title: "Plan the offline station cache", start: day(26, 11) });
    opening(b);
    b.run({
      user: "Write up a plan for caching station data offline. Use whatever formatting makes it easy to scan.",
      items: [
        { think: "**Shaping the plan**\n\nKeep it short: the moving parts, the file format, the code shape, and a migration note.", s: 2 },
        { cmd: "wc -c config/stations.json", out: "  48213 config/stations.json", exit: 0, s: 0.3 },
        {
          say: [
            "Here's a plan for keeping station data available offline.",
            "",
            "## Cache layout",
            "",
            "1. **Stations**: one JSON file per region under `Caches/stations/`.",
            "   - Written after every successful refresh.",
            "   - Read at launch before the network answers.",
            "   - [x] Already decodable with `Station.Codable`",
            "   - [ ] Needs a version field",
            "2. *Predictions* are cheap to recompute, so `TideTable` is never cached; ~~store a week of tables~~ was the first idea.",
            "3. Constituent updates come from https://tides.example.test/harmonics and the [station feed](https://tides.example.test/feed).",
            "",
            "> The cache is a convenience, not a source of truth: if it fails to decode, delete it and refetch.",
            "",
            "| File | Size | Refresh |",
            "| :--- | :---: | ---: |",
            "| `north.json` | 18 KB | weekly |",
            "| `inlet.json` | 9 KB | weekly |",
            "| `south.json` | 21 KB | monthly |",
            "",
            "```swift",
            "struct StationCache: Sendable {",
            "  let directory: URL",
            "  var version = 2 // bump when Station's shape changes",
            "  func load(region: Region) throws -> [Station] { … }",
            "}",
            "```",
            "",
            "```bash",
            "# Inspect what a device has cached",
            "xcrun simctl get_app_container booted com.example.tidewise data && ls Library/Caches/stations",
            "```",
            "",
            "```json",
            "{\"version\": 2, \"region\": \"inlet\", \"stations\": [\"port-hollis\", \"kettle-point\"]}",
            "```",
            "",
            "---",
            "",
            "That's everything. Say the word and I'll start with the version field.",
          ].join("\n"),
          s: 8,
        },
      ],
    });
    return b.document();
  },

  subagents() {
    const b = new ThreadBuilder({ slug: "subagents", title: "Audit every station's data", start: day(24, 16) });
    const tasks = [
      { key: "a41c9e07d2b35f18", title: "Check north coast stations", prompt: "Compare every north coast station in config/stations.json with the harbor office tables for November. Report stations whose highs or lows differ by more than 5 minutes.", result: "All 7 north coast stations are within 3 minutes of the printed tables. Largest difference: Gull Rock low water, +3 min." },
      { key: "b7e20f4c91a6d853", title: "Check inlet stations", prompt: "Compare the inlet stations (Port Hollis, Kettle Point, Mill Reach) with the harbor office tables for November.", result: "Port Hollis and Kettle Point match after the M4/MS4 fix. Mill Reach lows are 8 minutes late; it has no shallow-water constituents either." },
      { key: "c3d58a1e6f0b9274", title: "Validate station coordinates", prompt: "Check that every station's latitude and longitude is inside its region's bounding box and not on land.", result: "One problem: South Pier's longitude has the wrong sign (-3.712 should be 3.712), which puts it in the wrong hemisphere." },
      { key: "d9f61b3c08e4a527", title: "Find unused constituents", prompt: "List constituents defined in Constituents.swift that no station uses.", result: "2N2, L2 and T2 are defined but unused. Safe to keep; they cost nothing at runtime." },
    ];
    b.run({
      user: "Audit all the station data: times against the harbor office tables, coordinates, and anything unused. Split it up so it goes faster.",
      items: [
        { cmd: "Preparing workspace", title: "Workspace ready", exit: 0, s: 0.2 },
        { think: "**Splitting the audit**\n\nFour independent checks: north coast times, inlet times, coordinates, unused constituents. Each can run as its own task.", s: 2.1 },
        { cmd: "jq '.stations | length' config/stations.json", out: "23", exit: 0, s: 0.3 },
        { think: "**23 stations**\n\nGroup them by region first so each task gets a clear list.", s: 1 },
        { cmd: "jq -r '.stations[] | \"\\(.region)\\t\\(.id)\"' config/stations.json | sort | cut -f1 | uniq -c", out: "      3 inlet\n      7 north\n     13 south", exit: 0, s: 0.4 },
        { think: "**South coast**\n\nThe south coast has 13 stations, but they were checked last month; skip times there and only validate coordinates.", s: 1.3 },
        { cmd: "ls Sources/TideKit/Constituents.swift", out: "Sources/TideKit/Constituents.swift", exit: 0, s: 0.2 },
        { think: "**Starting the tasks**", s: 0.5 },
        ...tasks.map((task, index) => ({ subagent: task, s: 30 + index * 11 })),
        { think: "**Collecting results**\n\nTwo real problems: Mill Reach lows and the South Pier longitude.", s: 1.5 },
        { cmd: "jq '.stations[] | select(.id == \"south-pier\") | .longitude' config/stations.json", out: "-3.712", exit: 0, s: 0.3 },
        { think: "**Background wait**", s: 0.4 },
        { tool: "mcp__harbor-charts__fetch_station", input: { id: "mill-reach" }, status: "failed", s: 1.1 },
        { think: "**Feed is down**\n\nThe harbor chart tool failed; the harmonics page still works.", s: 0.6 },
        { tool: "WebFetch", input: { url: "https://tides.example.test/stations/mill-reach/harmonics", prompt: "M4 and MS4 amplitude and phase." }, s: 2.6 },
        { think: "**Summary**", s: 0.7 },
        {
          say: [
            "The audit found two real problems and one harmless leftover.",
            "",
            "- **Mill Reach** lows are 8 minutes late: same cause as Port Hollis, no M4/MS4. The harbor office publishes both.",
            "- **South Pier** has a flipped longitude (`-3.712` should be `3.712`).",
            "- 2N2, L2 and T2 are defined but unused. I'd leave them.",
            "",
            "The north coast stations are all within 3 minutes. Shall I fix Mill Reach and South Pier?",
          ].join("\n"),
          s: 5,
        },
      ],
    });
    for (const [index, task] of tasks.entries()) {
      const n = index + 2;
      const done = n % 2 === 0;
      b.run({
        user: null,
        items: [
          {
            notify: done
              ? { source: { kind: "background_task", work: "subagent", childThreadId: `thread:subagent:${task.key}` }, outcome: "completed", summary: `Finished "${task.title}"` }
              : { source: { kind: "background_task" }, outcome: "updated", summary: "Background tasks updated" },
            s: 0.2,
          },
          ...(n === 2 ? [{ think: "**Noted**\n\nThe north coast result is already in the summary.", s: 0.6 }] : []),
          ...(done ? [{ say: `Noted: ${task.result}`, s: 1.2 }] : []),
        ],
        gap: 20,
      });
    }
    b.run({
      user: null,
      items: [{ notify: { source: { kind: "background_task" }, outcome: "updated", summary: "Background tasks updated" }, s: 0.2 }],
      gap: 15,
    });
    b.run({
      user: null,
      items: [
        { notify: { source: { kind: "background_task", work: "subagent", childThreadId: `thread:subagent:${tasks[2].key}` }, outcome: "completed", summary: `Finished "${tasks[2].title}"` }, s: 0.2 },
        { think: "**Double-checking South Pier**", s: 0.8 },
        { cmd: "swift run tidewise-cli locate south-pier", out: "south-pier  lat 50.214  lon -3.712  region south  (outside region bounds)", exit: 0, s: 2.4 },
        { cmd: "swift run tidewise-cli locate --all --check-bounds", out: "23 stations checked, 1 outside its region: south-pier", exit: 0, s: 3.1 },
        { think: "**Confirmed**\n\nOnly South Pier is out of bounds.", s: 0.5 },
        { tool: "Grep", input: { pattern: "south-pier", path: "Tests" }, s: 0.4 },
        { cmd: "rg -n south-pier Sources App", out: "App/Fixtures/Preview.swift:12:    Station.preview(id: \"south-pier\")", exit: 0, s: 0.3 },
        { cmd: "git status --short", out: "", exit: 0, s: 0.2 },
        { think: "**Ready to fix**", s: 0.4 },
        { cmd: "swift test --filter StationStoreTests", out: "Executed 3 tests, with 0 failures (0 unexpected) in 0.009 seconds", exit: 0, s: 4 },
        { think: "**Report back**", s: 0.3 },
        { say: "Confirmed: South Pier is the only station outside its region. Nothing else references its coordinates, so the fix is a one-character change in `config/stations.json`.", s: 2 },
      ],
      gap: 25,
    });
    b.run({
      user: "Fix both, please.",
      items: [
        { think: "**Fixing Mill Reach and South Pier**", s: 1 },
        { say: "On it: adding M4/MS4 to Mill Reach and flipping South Pier's longitude, then rerunning the audit checks.", s: 1.5 },
      ],
      gap: 60,
    });
    return b.document();
  },

  kinds() {
    const b = new ThreadBuilder({ slug: "kinds", title: "Every item kind", start: day(26, 8) });
    opening(b);
    const thread = b.threadId;
    const ctx = b.run({
      user: "Show every item kind.",
      items: [
        { type: "proposed_plan", planId: "plan:kinds", markdown: "## Plan\n\n1. Add the station cache\n2. Read it at launch\n3. Refresh weekly", streaming: false, s: 1 },
        { type: "todo_list", planId: "plan:kinds:todo", steps: [{ id: "s1", text: "Decode the cache", status: "completed" }, { id: "s2", text: "Draw the chart from it", status: "running" }], s: 1 },
        { type: "compaction", driver: "claudeAgent", beforeTokenCount: 549000, afterTokenCount: 16800, s: 1 },
        { type: "handoff", contextHandoffId: "handoff:kinds", fromProviderThreadIds: [], toProviderThreadId: "provider-thread:kinds:2", fromProviderInstanceIds: ["codex"], toProviderInstanceId: "claudeAgent", strategy: "full_thread_summary", s: 1 },
        { type: "fork", source: { type: "run", threadId: thread, runId: "run:kinds:3" }, targetThreadId: "thread-kinds-fork", s: 1 },
        { type: "thread_created", targetThreadId: "thread-kinds-child", targetRunId: null, targetProviderInstanceId: "codex", targetModel: "gpt-5.4", s: 1 },
        { type: "secret_request", status: "waiting", label: "Harbor feed token", reason: "The live buoy feed needs a token.", secretStatus: "pending", s: 1 },
        { type: "link_request", status: "waiting", reason: "Link a computer to fetch the survey files.", linkStatus: "pending", s: 1 },
        { type: "run_interrupt_request", message: "Stop requested from the phone.", s: 1 },
        { type: "run_interrupt_result", message: "Stopped by the user.", s: 1 },
        { notify: { source: { kind: "command" }, outcome: "completed", summary: "Background task finished", detail: "Indexed 412 files." }, s: 1 },
        { type: "file_search", pattern: "Station*.swift", results: [{ fileName: "StationStore.swift" }, { fileName: "Station.swift" }], s: 1 },
        { type: "web_search", patterns: ["NOAA harmonic constituents shallow water M4"], results: [{ title: "Harmonic constituents", url: "https://tides.example.test/help/constituents" }], s: 1 },
      ],
    });
    // A kind this client has never heard of, from a newer server.
    b.item(ctx, { type: "hologram_projection", title: "Projected a hologram", beam: "unknown kind from a newer server", s: 1 });
    return b.document();
  },

  failed() {
    const b = new ThreadBuilder({ slug: "failed", title: "Deploy the chart tiles", start: day(26, 10) });
    opening(b);
    b.run({
      user: "Upload the new chart tiles to the staging bucket.",
      status: "failed",
      items: [
        { cmd: "./scripts/upload-tiles.sh staging", out: "Uploading 214 tiles to staging…\nerror: the bucket refused the upload (403 Forbidden)", exit: 1, status: "failed", s: 3.2 },
        { type: "error", status: "failed", failure: { class: "provider_error", message: "The provider stopped responding after 3 retries.", code: "overloaded", retryable: true }, retry: { attempt: 3, maxAttempts: 3, retryDelayMs: 4000 }, s: 0.1 },
        { type: "system_notice", message: "Switched to a fresh session after the provider error.", level: "warning", s: 0.1 },
      ],
    });
    return b.document();
  },

  replay() {
    const b = new ThreadBuilder({ slug: "replay", title: "Add the low water overlay", start: day(26, 12) });
    opening(b);
    const ctx = b.run({ user: "Add a shaded overlay on the chart for the hours around low water.", status: "running" });
    const snapshot = structuredClone(b.projection());
    const t = (seconds) => b.at(b.clock + seconds);
    const base = (id, ordinal, type, status, start, end, extra) => ({
      id,
      threadId: b.threadId,
      runId: ctx.runId,
      nodeId: ctx.rootNodeId,
      providerThreadId: b.providerThreadId,
      providerTurnId: ctx.turnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status,
      title: null,
      startedAt: start,
      completedAt: end,
      updatedAt: end ?? start,
      type,
      ...extra,
    });
    let clock = 0.5;
    const thought = "**Planning the overlay**\n\nThe chart already knows the extrema, so the overlay can be a rectangle per low water: an hour either side, drawn under the curve so the line stays readable.";
    const thoughtSteps = [24, 70, 120, thought.length];
    const reasoningId = `turn-item:${b.slug}:reasoning:3`;
    for (const [index, end] of thoughtSteps.entries()) {
      const last = index === thoughtSteps.length - 1;
      b.event("turn-item.updated", base(reasoningId, ctx.ordinal + 1, "reasoning", last ? "completed" : "running", t(0.5), last ? t(clock) : null, { title: "Thinking", text: thought.slice(0, end), streaming: !last }), t(clock));
      clock += 0.6;
    }
    const commandId = `turn-item:${b.slug}:command:3`;
    const command = "rg -n \"struct TideChartView\" App";
    b.event("turn-item.updated", base(commandId, ctx.ordinal + 2, "command_execution", "running", t(clock), null, { input: command }), t(clock));
    clock += 0.8;
    b.event("turn-item.updated", base(commandId, ctx.ordinal + 2, "command_execution", "completed", t(clock - 0.8), t(clock), { input: command, output: "App/Views/TideChartView.swift:7:struct TideChartView: View {", exitCode: 0 }), t(clock));
    clock += 0.5;
    const editId = `turn-item:${b.slug}:edit:3`;
    b.event("turn-item.updated", base(editId, ctx.ordinal + 3, "file_change", "completed", t(clock), t(clock + 1), { fileName: "TideChartView.swift", additions: 38, deletions: 4, changes: [{ operation: "update", path: "App/Views/TideChartView.swift" }] }), t(clock + 1));
    clock += 1.5;
    const answer = [
      "Added a low water overlay to `TideChartView`.",
      "",
      "## How it works",
      "",
      "- For each low water in the day's `TideTable.extrema()`, the chart draws a soft band from one hour before to one hour after.",
      "- The band sits under the tide curve, so the line and its labels stay readable.",
      "- It uses `Color.blue.opacity(0.12)` in light mode and `0.2` in dark mode.",
      "",
      "```swift",
      "ForEach(table.extrema().filter(\\.isLow)) { low in",
      "  RectangleMark(",
      "    xStart: .value(\"Start\", low.time.addingTimeInterval(-3600)),",
      "    xEnd: .value(\"End\", low.time.addingTimeInterval(3600))",
      "  )",
      "  .foregroundStyle(.blue.opacity(colorScheme == .dark ? 0.2 : 0.12))",
      "}",
      "```",
      "",
      "## Checked",
      "",
      "1. Port Hollis on 24 November shows two bands, at 09:35 and 21:53.",
      "2. A day with a single low (Kettle Point, 30 November) shows one band.",
      "3. The VoiceOver summary now ends with \"Low water around 09:35 and 21:53.\"",
      "",
      "The overlay has no setting yet; tell me if you'd like a toggle in the chart menu.",
    ].join("\n");
    const messageId = `message:${b.slug}:assistant:3`;
    const answerId = `turn-item:${b.slug}:assistant:3`;
    const chunks = 28;
    const answerStart = t(clock);
    for (let index = 1; index <= chunks; index += 1) {
      const last = index === chunks;
      const text = answer.slice(0, Math.round((answer.length * index) / chunks));
      const now = t(clock);
      b.event("message.updated", b.message({ id: messageId, role: "assistant", text, runId: ctx.runId, nodeId: ctx.rootNodeId, at: answerStart, streaming: !last }), now);
      b.event("turn-item.updated", base(answerId, ctx.ordinal + 4, "assistant_message", last ? "completed" : "running", answerStart, last ? now : null, { phase: "final_answer", messageId, text, streaming: !last }), now);
      clock += 0.4;
    }
    const end = t(clock);
    b.event("turn-item.updated", base(`turn-item:checkpoint:${b.slug}:3`, ctx.ordinal + 5, "checkpoint", "completed", end, end, { checkpointId: `checkpoint:${b.slug}:3`, scopeId: `checkpoint-scope:${b.slug}:root`, files: [] }), end);
    const run = snapshot.runs.find((entry) => entry.id === ctx.runId);
    b.event("run.updated", { ...run, status: "completed", completedAt: end, checkpointId: `checkpoint:${b.slug}:3` }, end);
    return {
      synthetic: true,
      note: "The last turn streams: reasoning, a command, an edit, then the answer in chunks.",
      items: [{ kind: "snapshot", snapshotSequence: 100, projection: snapshot }, { kind: "synchronized" }, ...b.events],
    };
  },
};

// MARK: - Pending requests: a shared conversation, then one scenario at the tail

const live = (supportsFeedback) => ({ type: "live", providerSessionId: "provider-session:requests", ...(supportsFeedback ? { supportsFeedback } : {}) });

function requestThread(slug, title) {
  const b = new ThreadBuilder({ slug, title, start: day(26, 13) });
  opening(b);
  const ctx = b.run({
    user: "Get the release build ready: clean the old tiles, build, and publish the branch.",
    status: "waiting",
    items: [
      { think: "**Release prep**\n\nClean stale tiles, run the release build, then push. Some of this needs approval.", s: 1.4 },
      { cmd: "git status --short", out: " M config/stations.json", exit: 0, s: 0.3 },
    ],
  });
  return { b, ctx };
}

function request(b, ctx, id, kind, capability = live()) {
  b.runtimeRequests.push({
    id,
    nodeId: ctx.rootNodeId,
    providerTurnId: null,
    nativeRequestRef: null,
    kind,
    status: "pending",
    responseCapability: capability,
    createdAt: b.at(b.clock),
    resolvedAt: null,
  });
}

function approval(b, ctx, n, requestKind, fields, capability) {
  const id = `runtime-request:requests:approval:${n}`;
  b.item(ctx, { type: "approval_request", status: "waiting", requestId: id, requestKind, ...fields, s: 0.5 });
  request(b, ctx, id, requestKind, capability);
}

function question(b, ctx, n, questions, { capability, responseMode } = {}) {
  const id = `runtime-request:requests:question:${n}`;
  b.item(ctx, { type: "user_input_request", status: "waiting", requestId: id, questions, ...(responseMode ? { responseMode } : {}), s: 0.5 });
  request(b, ctx, id, "user_input", capability);
  return id;
}

function secret(b, ctx, fields) {
  b.item(ctx, { type: "secret_request", status: "waiting", secretStatus: "pending", ...fields, s: 0.5 });
}

const scenarios = {
  pending(b, ctx) {
    approval(b, ctx, 1, "command", {
      prompt: "rm -rf ./build/tiles",
      reason: "Removes last week's chart tiles before the release build.",
      options: [
        { decision: "accept", label: "Allow once" },
        { decision: "acceptForSession", label: "Allow for this session" },
        { decision: "decline", label: "Decline" },
      ],
    });
    question(b, ctx, 1, [{
      id: "sim",
      header: "Simulator",
      question: "Which simulator should the UI tests run on?",
      multiSelect: false,
      allowCustomAnswer: true,
      options: [
        { label: "iPhone 18 Pro", description: "The booted simulator." },
        { label: "iPad Pro 13-inch", description: "Checks the split layout." },
      ],
    }]);
  },
  "approval-command": (b, ctx) =>
    approval(b, ctx, 1, "command", {
      prompt: "find ./charts -name '*.tmp' -delete && rm -rf ./build/tiles ./build/cache && git push --force-with-lease origin main",
      reason: "Clears stale tide tiles before the release build, then publishes the branch.",
    }, live(true)),
  "approval-file-change": (b, ctx) =>
    approval(b, ctx, 2, "file-change", {
      prompt: "App/Views/TideChartView.swift\nApp/Views/LowWaterOverlay.swift",
      reason: "Adds the low water overlay and wires it into the chart.",
      options: [
        { decision: "accept", label: "Yes" },
        { decision: "acceptForSession", label: "Yes, and allow these files for the session" },
        { decision: "decline", label: "No, keep planning" },
      ],
    }),
  "approval-file-read": (b, ctx) =>
    approval(b, ctx, 3, "file-read", { prompt: "config/stations.json", reason: "Reads the station list to pick a default station." }),
  "approval-permission": (b, ctx) =>
    approval(b, ctx, 4, "permission", {
      prompt: "Network access to tides.example.test",
      reason: "Downloads this week's tide tables.",
      fullAccessOverride: "provider_check",
      options: [
        { decision: "accept", label: "Allow once" },
        { decision: "acceptAlways", label: "Always allow this host", warning: "Every thread in this project will reach this host without asking." },
        { decision: "decline", label: "Deny" },
      ],
    }),
  "approval-mcp": (b, ctx) =>
    approval(b, ctx, 5, "mcp-elicitation", {
      appName: "Harbor Charts",
      prompt: "Read the saved station list and chart bookmarks",
      options: [
        { decision: "accept", label: "Allow" },
        { decision: "cancel", label: "Cancel" },
      ],
    }),
  "approval-stale": (b, ctx) =>
    approval(b, ctx, 6, "command", { prompt: "swift test --filter TideTableTests" }, { type: "not_resumable", reason: "The agent process exited." }),
  "approvals-queued"(b, ctx) {
    approval(b, ctx, 7, "command", { prompt: "rm -rf ./build/tiles", reason: "Removes stale tiles." });
    approval(b, ctx, 8, "file-change", { prompt: "App/Views/Legend.swift" });
    approval(b, ctx, 9, "permission", { prompt: "Network access to tides.example.test" });
  },
  "question-single": (b, ctx) =>
    question(b, ctx, 1, [{
      id: "datum",
      header: "Datum",
      question: "Which **tide datum** should the chart use?",
      multiSelect: false,
      options: [
        { label: "Mean lower low water (Recommended)", description: "Matches the harbor's printed charts." },
        { label: "Mean sea level", description: "Simpler, but drifts from local gauges." },
        { label: "Lowest astronomical tide", description: "Most conservative for shallow berths." },
      ],
    }]),
  "question-multi": (b, ctx) =>
    question(b, ctx, 2, [{
      id: "layers",
      header: "Layers",
      question: "Which layers should ship in the first release?",
      multiSelect: true,
      required: true,
      options: [
        { label: "Tide heights", description: "Hourly heights for each station." },
        { label: "Currents", description: "Arrows for flood and ebb." },
        { label: "Buoys", description: "Live positions from the harbor feed." },
        { label: "Depth soundings", description: "Static depths from the survey." },
      ],
    }]),
  "question-text": (b, ctx) =>
    question(b, ctx, 3, [{ id: "name", header: "Name", question: "What should the new station be called?", options: [] }]),
  "question-other": (b, ctx) =>
    question(b, ctx, 4, [{
      id: "units",
      header: "Units",
      question: "How should heights be shown?",
      allowCustomAnswer: true,
      options: [
        { label: "Meters", description: "Metric, one decimal.", value: "m", preview: "`2.4 m` at high water" },
        { label: "Feet", description: "Imperial, whole feet.", value: "ft", preview: "`8 ft` at high water" },
      ],
    }]),
  "question-steps": (b, ctx) =>
    question(b, ctx, 5, [
      {
        id: "region",
        header: "Region",
        question: "Which region comes first?",
        options: [
          { label: "North coast", description: "Busiest stations." },
          { label: "Inlet", description: "Smallest data set." },
        ],
      },
      {
        id: "extras",
        header: "Extras",
        question: "Anything else to include?",
        multiSelect: true,
        required: false,
        options: [
          { label: "Sunrise times", description: "From the almanac." },
          { label: "Moon phase", description: "Drives spring tides." },
        ],
      },
      {
        id: "commit",
        header: "Commit message",
        question: "Edit the commit message if needed.",
        options: [],
        initialAnswer: "Add the north coast tide chart",
      },
    ]),
  "question-message": (b, ctx) =>
    question(b, ctx, 6, [{
      id: "next",
      header: "Next step",
      question: "The first chart is done. What next?",
      allowCustomAnswer: false,
      options: [
        { label: "Continue", description: "Start the inlet stations.", value: "continue" },
        { label: "Stop here", description: "Wrap up this thread.", value: "stop" },
      ],
    }], { capability: { type: "message" }, responseMode: "message" }),
  secret: (b, ctx) =>
    secret(b, ctx, {
      label: "Harbor feed token",
      reason: "The buoy feed needs an API token to fetch live positions.",
      url: "https://feeds.example.test/tokens",
      placeholder: "hf_…",
    }),
  "secret-fields": (b, ctx) =>
    secret(b, ctx, {
      label: "Survey server login",
      reason: "The deploy script signs in to upload the depth survey.",
      delivery: "file",
      fields: [
        { name: "user", label: "User name", secret: false, placeholder: "harbor-bot" },
        { name: "password", label: "Password" },
      ],
    }),
  // The server resolving a question after it was answered: the stream event, not a debug edit.
  "question-resolved"(b, ctx) {
    const id = question(b, ctx, 8, [{ id: "sim", header: "Simulator", question: "Which simulator?", options: [{ label: "iPhone 18 Pro", description: "The booted one." }] }]);
    const pending = b.runtimeRequests.find((entry) => entry.id === id);
    const at = b.at(b.clock + 30);
    b.sequence = 3000;
    b.event("runtime-request.updated", { ...pending, status: "resolved", resolvedAt: at, answers: { sim: "iPhone 18 Pro" } }, at);
  },
  "requests-mixed"(b, ctx) {
    approval(b, ctx, 10, "command", { prompt: "swift build -c release", reason: "Builds the release." });
    question(b, ctx, 7, [{ id: "ok", header: "Ship", question: "Ship it after the build?", options: [{ label: "Yes", description: "Tag and push." }, { label: "No", description: "Hold." }] }]);
    secret(b, ctx, { label: "App Store token", reason: "Uploading the build needs a store token." });
  },
};

const titles = {
  pending: "Prepare the release build",
  "question-single": "Pick the chart datum",
  "question-multi": "Choose the first release layers",
  "question-steps": "Plan the north coast chart",
};

// MARK: - Write, checking each stream item with the server's schema

const decode = S.decodeUnknownExit(contracts.OrchestrationV2ThreadStreamItem);
const documents = {};
for (const [name, make] of Object.entries(conversations)) documents[name] = make();
for (const [name, add] of Object.entries(scenarios)) {
  const { b, ctx } = requestThread(name === "pending" ? "pending" : `requests-${name}`, titles[name] ?? "Prepare the release build");
  add(b, ctx);
  documents[name] = b.document();
}

let failures = 0;
const golden = {};
for (const [name, document] of Object.entries(documents)) {
  const decoded = [];
  for (const streamItem of document.items) {
    const exit = decode(streamItem);
    if (exit._tag !== "Success") {
      failures += 1;
      console.log(`FAIL ${name}: ${String(exit.cause).slice(0, 3000)}`);
    } else {
      decoded.push(exit.value);
    }
  }
  if (decoded.length === document.items.length && ["replay", "subagents", "kinds"].includes(name)) {
    let projection = null;
    for (const item of decoded) {
      if (item.kind === "snapshot") projection = item.projection;
      else if (item.kind === "event") projection = reducer.applyOrchestrationV2ProjectionEvent(projection, item.event);
    }
    golden[`thread-${name}.json`] = projection.visibleTurnItems.map((row) => `${row.position}:${row.item.type}:${row.item.status}:${row.sourceItemId}`);
  }
  writeFileSync(join(fixtures, `thread-${name}.json`), JSON.stringify(document));
  console.log(`ok   thread-${name}.json`);
}
writeFileSync(goldenPath, `${JSON.stringify(golden, null, 1)}\n`);
console.log("ok   thread-reducer-golden.json");
process.exit(failures === 0 ? 0 : 1);
