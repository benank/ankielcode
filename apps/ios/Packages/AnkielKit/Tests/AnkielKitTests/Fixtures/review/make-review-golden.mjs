// Writes review-golden.json: which paths "Hide test files" hides (`isTestChangedFile`) and the
// git action rules (`buildMenuItems`, `resolveQuickAction`, `getGitActionDisabledReason`,
// `requiresDefaultBranchConfirmation`) for sample inputs, which the Swift ports must match. Run
// from the repo's `packages/client-runtime`:
//   node ../../apps/ios/Packages/AnkielKit/Tests/AnkielKitTests/Fixtures/review/make-review-golden.mjs [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const kind = await import(pathToFileURL(join(process.cwd(), "../shared/src/changedFileKind.ts")).href);
const git = await import(pathToFileURL(join(process.cwd(), "src/state/gitActions.ts")).href);

// Synthetic paths (no real project).
const testPaths = [
  "src/tide/tide.ts",
  "src/tide/tide.test.ts",
  "src/tide/moon.logic.spec.tsx",
  "src/__tests__/harbor.ts",
  "Tests/AnkielKitTests/TideTests.swift",
  "src/Latest.java",
  "src/TideTest.java",
  "tide_test.go",
  "test_tide.py",
  "conftest.py",
  "vitest.setup.ts",
  "src/tide.stories.tsx",
  "src/__snapshots__/tide.test.ts.snap",
  "src/__mocks__/moon.ts",
  "src/MockClock.ts",
  "src/Mockup.ts",
  "src/tide.fixture.json",
  "fixtures/tide.json",
  "testdata/tide.bin",
  "src/tide.generated.test.ts",
  "generated/tests/tide.ts",
  "pnpm-lock.yaml",
  "dist/bundle.min.js",
  "Docs/Guide.md",
  "e2e\\tide.ts",
  "README.md",
];
const tests = Object.fromEntries(testPaths.map((path) => [path, kind.isTestChangedFile(path)]));

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
// An older server still reports the branch's pull request; main's client ignores it.
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
          quick: git.resolveQuickAction(status, busy, status.hasPrimaryRemote),
          items: items.map((item) => ({
            id: item.id,
            kind: item.kind,
            disabled: item.disabled,
            reason: git.getGitActionDisabledReason({ item, gitStatus: status, isBusy: busy, hasOriginRemote: status.hasPrimaryRemote }),
          })),
          confirm: ["commit", "push", "commit_push"].filter((action) =>
            git.requiresDefaultBranchConfirmation(action, status.isDefaultRef),
          ),
        },
      ];
    }),
  ),
);
gitGolden["nil"] = { status: null, busy: false, quick: git.resolveQuickAction(null, false), items: [], confirm: [] };

const json = `${JSON.stringify({ synthetic: true, tests, git: gitGolden }, null, 2)}\n`;
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
