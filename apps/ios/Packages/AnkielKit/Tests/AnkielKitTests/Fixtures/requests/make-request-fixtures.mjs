// Writes the debug thread fixtures for pending requests (`AnkielCode/Thread/Fixtures/thread-<name>.json`)
// from `thread-pending.json`: its conversation, then one scenario of approvals, questions or secrets
// at the tail. Every stream item is decoded with the server's own `OrchestrationV2ThreadStreamItem`
// schema before it is written. Synthetic text only. Run from the repo's `packages/contracts`:
//   node ../../apps/ios/Packages/AnkielKit/Tests/AnkielKitTests/Fixtures/requests/make-request-fixtures.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../../../../../AnkielCode/Thread/Fixtures");
const m = await import(pathToFileURL(join(process.cwd(), "src/index.ts")).href);
const S = await import(pathToFileURL(join(process.cwd(), "node_modules/effect/dist/Schema.js")).href);

const base = JSON.parse(readFileSync(join(fixtures, "thread-pending.json"), "utf8"));
const snapshot = base.items[0];
const TAIL = 2001008;
const runId = "run:synthetic:2";
const nodeId = "node:run:synthetic:2:root";
const threadId = snapshot.projection.thread.id;
const session = "provider-session:synthetic";

const at = (seconds) => new Date(Date.UTC(2026, 5, 27, 3, 43, 4 + seconds)).toISOString();
let ordinal = TAIL;

function item(type, fields) {
  ordinal += 1;
  return {
    id: `turn-item:synthetic:${type}:${ordinal}`,
    threadId,
    runId,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "waiting",
    title: null,
    startedAt: at(ordinal - TAIL),
    completedAt: null,
    updatedAt: at(ordinal - TAIL),
    type,
    ...fields,
  };
}

const live = (supportsFeedback) => ({ type: "live", providerSessionId: session, ...(supportsFeedback ? { supportsFeedback } : {}) });

function request(id, kind, capability = live()) {
  return {
    id,
    nodeId,
    providerTurnId: null,
    nativeRequestRef: null,
    kind,
    status: "pending",
    responseCapability: capability,
    createdAt: at(ordinal - TAIL),
    resolvedAt: null,
  };
}

/** One approval: the runtime request and its item. */
function approval(n, requestKind, fields, capability) {
  const id = `runtime-request:synthetic:approval:${n}`;
  return { items: [item("approval_request", { requestId: id, requestKind, ...fields })], requests: [request(id, requestKind, capability)] };
}

function question(n, questions, { capability, responseMode } = {}) {
  const id = `runtime-request:synthetic:question:${n}`;
  return {
    items: [item("user_input_request", { requestId: id, questions, ...(responseMode ? { responseMode } : {}) })],
    requests: [request(id, "user_input", capability)],
  };
}

function secret(fields) {
  return { items: [item("secret_request", { secretStatus: "pending", ...fields })], requests: [] };
}

const scenarios = {
  "approval-command": () =>
    approval(1, "command", {
      prompt:
        "find ./charts -name '*.tmp' -delete && rm -rf ./build/tiles ./build/cache && git push --force-with-lease origin main",
      reason: "Clears stale tide tiles before the release build, then publishes the branch.",
    }, live(true)),
  "approval-file-change": () =>
    approval(2, "file-change", {
      prompt: "Sources/TideChart/HarborLayer.swift\nSources/TideChart/LowWaterOverlay.swift",
      reason: "Adds the low-water overlay and wires it into the harbor layer.",
      options: [
        { decision: "accept", label: "Yes" },
        { decision: "acceptForSession", label: "Yes, and allow these files for the session" },
        { decision: "decline", label: "No, keep planning" },
      ],
    }),
  "approval-file-read": () =>
    approval(3, "file-read", { prompt: "config/stations.json", reason: "Reads the station list to pick a default buoy." }),
  "approval-permission": () =>
    approval(4, "permission", {
      prompt: "Network access to tides.example.test",
      reason: "Downloads this week's tide tables.",
      fullAccessOverride: "provider_check",
      options: [
        { decision: "accept", label: "Allow once" },
        { decision: "acceptAlways", label: "Always allow this host", warning: "Every thread in this project will reach this host without asking." },
        { decision: "decline", label: "Deny" },
      ],
    }),
  "approval-mcp": () =>
    approval(5, "mcp-elicitation", {
      appName: "Harbor Charts",
      prompt: "Read the saved buoy list and chart bookmarks",
      options: [
        { decision: "accept", label: "Allow" },
        { decision: "cancel", label: "Cancel" },
      ],
    }),
  "approval-stale": () =>
    approval(6, "command", { prompt: "swift test --filter TideTableTests" }, { type: "not_resumable", reason: "The agent process exited." }),
  "approvals-queued": () => merge(
    approval(7, "command", { prompt: "rm -rf ./build/tiles", reason: "Removes stale tiles." }),
    approval(8, "file-change", { prompt: "Sources/TideChart/Legend.swift" }),
    approval(9, "permission", { prompt: "Network access to tides.example.test" }),
  ),
  "question-single": () =>
    question(1, [{
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
  "question-multi": () =>
    question(2, [{
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
  "question-text": () =>
    question(3, [{ id: "name", header: "Name", question: "What should the new station be called?", options: [] }]),
  "question-other": () =>
    question(4, [{
      id: "units",
      header: "Units",
      question: "How should heights be shown?",
      allowCustomAnswer: true,
      options: [
        { label: "Meters", description: "Metric, one decimal.", value: "m", preview: "`2.4 m` at high water" },
        { label: "Feet", description: "Imperial, whole feet.", value: "ft", preview: "`8 ft` at high water" },
      ],
    }]),
  "question-steps": () =>
    question(5, [
      {
        id: "region",
        header: "Region",
        question: "Which region comes first?",
        options: [
          { label: "North harbor", description: "Busiest berths." },
          { label: "South inlet", description: "Smallest data set." },
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
        initialAnswer: "Add the north harbor tide chart",
      },
    ]),
  "question-message": () =>
    question(6, [{
      id: "next",
      header: "Next step",
      question: "The first chart is done. What next?",
      allowCustomAnswer: false,
      options: [
        { label: "Continue", description: "Start the south inlet.", value: "continue" },
        { label: "Stop here", description: "Wrap up this thread.", value: "stop" },
      ],
    }], { capability: { type: "message" }, responseMode: "message" }),
  "secret": () =>
    secret({
      label: "Harbor feed token",
      reason: "The buoy feed needs an API token to fetch live positions.",
      url: "https://feeds.example.test/tokens",
      placeholder: "hf_…",
    }),
  "secret-fields": () =>
    secret({
      label: "Survey server login",
      reason: "The deploy script signs in to upload the depth survey.",
      delivery: "file",
      fields: [
        { name: "user", label: "User name", secret: false, placeholder: "harbor-bot" },
        { name: "password", label: "Password" },
      ],
    }),
  // The server resolving a question after it was answered: the stream event, not a debug edit.
  "question-resolved": () => {
    const part = question(8, [{ id: "sim", header: "Simulator", question: "Which simulator?", options: [{ label: "iPhone 18 Pro", description: "The booted one." }] }]);
    const [pending] = part.requests;
    part.events = [{
      kind: "event",
      sequence: 3001,
      event: {
        id: "event:synthetic:3001",
        type: "runtime-request.updated",
        threadId,
        occurredAt: at(30),
        payload: { ...pending, status: "resolved", resolvedAt: at(30), answers: { sim: "iPhone 18 Pro" } },
      },
    }];
    return part;
  },
  "requests-mixed": () => merge(
    approval(10, "command", { prompt: "swift build -c release", reason: "Builds the release." }),
    question(7, [{ id: "ok", header: "Ship", question: "Ship it after the build?", options: [{ label: "Yes", description: "Tag and push." }, { label: "No", description: "Hold." }] }]),
    secret({ label: "Store token", reason: "Uploading needs a store token." }),
  ),
};

function merge(...parts) {
  return { items: parts.flatMap((part) => part.items), requests: parts.flatMap((part) => part.requests) };
}

const decode = S.decodeUnknownExit(m.OrchestrationV2ThreadStreamItem);
let failures = 0;
for (const [name, make] of Object.entries(scenarios)) {
  ordinal = TAIL;
  const { items, requests, events = [] } = make();
  const projection = structuredClone(snapshot.projection);
  const keep = (entry) => entry.ordinal < TAIL;
  projection.turnItems = projection.turnItems.filter(keep).concat(items);
  const visible = projection.visibleTurnItems.filter((row) => keep(row.item));
  projection.visibleTurnItems = visible.concat(
    items.map((entry, index) => ({ position: visible.length + index, visibility: "local", sourceThreadId: threadId, sourceItemId: entry.id, item: entry })),
  );
  projection.runtimeRequests = requests;
  const document = { synthetic: true, items: [{ ...snapshot, projection }, { kind: "synchronized" }, ...events] };
  for (const streamItem of document.items) {
    const exit = decode(streamItem);
    if (exit._tag !== "Success") {
      failures += 1;
      console.log(`FAIL ${name}: ${String(exit.cause).slice(0, 2000)}`);
    }
  }
  writeFileSync(join(fixtures, `thread-${name}.json`), JSON.stringify(document));
  console.log(`ok   thread-${name}.json`);
}
process.exit(failures === 0 ? 0 : 1);
