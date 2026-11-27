// Writes review-golden.json: the TypeScript review order (`orderDiffFilesForReview`) and git
// action rules (`buildMenuItems`, `resolveQuickAction`, `getGitActionDisabledReason`) for sample
// inputs, which the Swift ports must match. Run from the repo's `packages/client-runtime`:
//   node ../../apps/ios/Packages/AnkielKit/Tests/AnkielKitTests/Fixtures/review/make-review-golden.mjs [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const order = await import(pathToFileURL(join(process.cwd(), "src/diffFileOrder.ts")).href);
const git = await import(pathToFileURL(join(process.cwd(), "src/state/gitActions.ts")).href);

// Synthetic paths and import lines (no real project).
const orderCases = [
  [
    { path: "src/app/main.ts", lines: ['import { tide } from "../tide/tide";', 'import "./styles.css";'] },
    { path: "src/tide/tide.ts", lines: ['import { moon } from "./moon.js";'] },
    { path: "src/tide/moon.ts", lines: ["export const moon = 1;"] },
    { path: "src/tide/tide.test.ts", lines: ['import { tide } from "./tide";'] },
    { path: "src/tide/moon.logic.test.ts", lines: [] },
    { path: "pnpm-lock.yaml", lines: [] },
    { path: "README.md", lines: [] },
    { path: "dist/bundle.min.js", lines: [] },
    { path: "src/app/styles.css", lines: [] },
    { path: "Docs/Guide.md", lines: [] },
    { path: "docs/api.md", lines: [] },
    { path: "src/Tide/Upper.ts", lines: [] },
    { path: "src/__tests__/harbor.ts", lines: [] },
    { path: "src/harbor.ts", lines: ['const x = require("./tide/moon")'] },
  ],
  [
    { path: "b/z.swift", lines: [] },
    { path: "a/y.swift", lines: [] },
    { path: "a/b/c.swift", lines: [] },
    { path: "a/b/a.swift", lines: [] },
    { path: "z.swift", lines: [] },
    { path: "a_b.swift", lines: [] },
    { path: "a-b.swift", lines: [] },
    { path: "a.b.swift", lines: [] },
    { path: "A.swift", lines: [] },
    { path: "a10.swift", lines: [] },
    { path: "a2.swift", lines: [] },
  ],
];
const orderGolden = orderCases.map((files) => ({
  input: files.map((file) => file.path),
  lines: Object.fromEntries(files.map((file) => [file.path, file.lines])),
  output: order
    .orderDiffFilesForReview(
      files.map((file) => ({ path: file.path, additionLines: file.lines, deletionLines: [] })),
      (file) => file.path,
    )
    .map((file) => file.path),
}));

const base = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/tides",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};
const dirty = { files: [{ path: "a.ts", insertions: 1, deletions: 0 }], insertions: 1, deletions: 0 };
const pr = { number: 7, title: "Tides", url: "https://example.com/pr/7", baseRef: "main", headRef: "feature/tides", state: "open" };
const statuses = {
  clean: base,
  dirty: { ...base, hasWorkingTreeChanges: true, workingTree: dirty },
  dirtyBehind: { ...base, hasWorkingTreeChanges: true, workingTree: dirty, behindCount: 2 },
  dirtyDefault: { ...base, hasWorkingTreeChanges: true, workingTree: dirty, isDefaultRef: true, refName: "main" },
  dirtyOpenPr: { ...base, hasWorkingTreeChanges: true, workingTree: dirty, pr },
  dirtyNoRemote: { ...base, hasWorkingTreeChanges: true, workingTree: dirty, hasUpstream: false, hasPrimaryRemote: false },
  ahead: { ...base, aheadCount: 3 },
  aheadDefault: { ...base, aheadCount: 3, isDefaultRef: true, refName: "main" },
  aheadOpenPr: { ...base, aheadCount: 1, pr },
  behind: { ...base, behindCount: 2 },
  diverged: { ...base, aheadCount: 1, behindCount: 1 },
  noUpstreamAhead: { ...base, hasUpstream: false, aheadCount: 2 },
  noUpstreamClean: { ...base, hasUpstream: false },
  noUpstreamOpenPr: { ...base, hasUpstream: false, pr },
  noRemote: { ...base, hasUpstream: false, hasPrimaryRemote: false, aheadCount: 1 },
  noRemotePr: { ...base, hasUpstream: false, hasPrimaryRemote: false, pr },
  detached: { ...base, refName: null },
  openPr: { ...base, pr },
  defaultDelta: { ...base, aheadOfDefaultCount: 4 },
  defaultDeltaOnDefault: { ...base, aheadOfDefaultCount: 4, isDefaultRef: true, refName: "main" },
  aheadZeroDefaultDelta: { ...base, aheadCount: 2, aheadOfDefaultCount: 0 },
};
const gitGolden = Object.fromEntries(
  Object.entries(statuses).flatMap(([name, status]) =>
    [false, true].map((busy) => {
      const items = git.buildMenuItems(status, busy, status.hasPrimaryRemote);
      return [
        `${name}${busy ? ":busy" : ""}`,
        {
          status,
          busy,
          quick: git.resolveQuickAction(status, busy, status.isDefaultRef, status.hasPrimaryRemote),
          items: items.map((item) => ({
            id: item.id,
            kind: item.kind,
            disabled: item.disabled,
            reason: git.getGitActionDisabledReason({ item, gitStatus: status, isBusy: busy, hasOriginRemote: status.hasPrimaryRemote }),
          })),
          confirm: ["commit", "push", "create_pr", "commit_push", "commit_push_pr"].filter((action) =>
            git.requiresDefaultBranchConfirmation(action, status.isDefaultRef),
          ),
        },
      ];
    }),
  ),
);
gitGolden["nil"] = { status: null, busy: false, quick: git.resolveQuickAction(null, false), items: [], confirm: [] };

const json = `${JSON.stringify({ synthetic: true, order: orderGolden, git: gitGolden }, null, 2)}\n`;
const target = join(here, "review-golden.json");
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== json) {
    console.log("review-golden.json is stale; run without --check");
    process.exit(1);
  }
  console.log("review-golden.json is current");
} else {
  writeFileSync(target, json);
  console.log(`wrote ${target}`);
}
