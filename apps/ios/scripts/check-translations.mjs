#!/usr/bin/env node
// Fails when a key lacks a locale, a translation's placeholders differ from its key's, or no Swift
// literal uses a key. With --build, that build's extracted strings decide which keys are used, and
// extracted keys missing from the catalog fail too.
//   node apps/ios/scripts/check-translations.mjs [--catalog <path>] [--build <derived-data>]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  catalogPath,
  iosRoot,
  locales,
  placeholders,
  readCatalog,
  stringsExtractedBy,
  swiftFiles,
  swiftUses,
} from "./catalog.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : NodePath.resolve(args[at + 1]);
};
const catalog = readCatalog(option("--catalog") ?? catalogPath);
const build = option("--build");
const problems = [];

// Debug copy, the product name and keys without words ("%lld.", "%@ · %@") stay as they are.
const exempt = (key, entry) =>
  entry.shouldTranslate === false ||
  !/\p{L}/u.test(key.replace(/%(?:\d+\$)?(?:@|ll[du]|l[du]|[duf]|\.\d+f)/g, ""));
const signature = (text) =>
  placeholders(text)
    .map(({ position, type }) => `${position}:${type}`)
    .sort()
    .join(" ");

for (const [key, entry] of Object.entries(catalog.strings)) {
  if (exempt(key, entry)) continue;
  const inflect = key.match(/^\^\[(.*)\]\(inflect: true\)$/s);
  const expected = signature(inflect ? inflect[1] : key);
  for (const locale of locales) {
    const unit = entry.localizations?.[locale];
    if (!unit || (unit.stringUnit && unit.stringUnit.state === "new")) {
      problems.push(`missing ${locale}: ${JSON.stringify(key)}`);
      continue;
    }
    const plural = unit.variations?.plural;
    if (plural) {
      if (!plural.other) problems.push(`no "other" plural in ${locale}: ${JSON.stringify(key)}`);
      // A plural branch may leave out its number ("a thread"), never add one.
      const allowed = new Set(expected.split(" "));
      for (const [category, branch] of Object.entries(plural)) {
        const found = signature(branch.stringUnit?.value ?? "");
        if (found && !found.split(" ").every((spec) => allowed.has(spec))) {
          problems.push(
            `placeholders in ${locale} (${category}) ${JSON.stringify(found)} vs ${JSON.stringify(expected)}: ${JSON.stringify(key)}`,
          );
        }
      }
      continue;
    }
    const found = signature(unit.stringUnit?.value ?? "");
    if (found !== expected) {
      problems.push(
        `placeholders in ${locale} ${JSON.stringify(found)} vs ${JSON.stringify(expected)}: ${JSON.stringify(key)}`,
      );
    }
  }
}

// `Text(verbatim:)` skips the catalog, so a verbatim literal must not be copy: only names,
// addresses and paths (debug-only files are exempt).
const verbatimAllowed = new Set(["Ankiel Code", "Cloudflare Relay"]);
for (const file of ["AnkielCode", "AnkielWidgets"].flatMap((dir) =>
  swiftFiles(NodePath.join(iosRoot, dir)),
)) {
  const source = NodeFS.readFileSync(file, "utf8");
  if (/Debug\.swift$/.test(file) || source.trimStart().startsWith("#if DEBUG")) continue;
  for (const match of source.matchAll(/verbatim:\s*"((?:[^"\\]|\\.)*)"/g)) {
    const text = match[1];
    // A quote inside an interpolation ends this simple match early; such literals are not copy.
    if ((text.match(/\(/g) ?? []).length !== (text.match(/\)/g) ?? []).length) continue;
    const words = text.replace(/\\\((?:[^()]|\([^()]*\))*\)/g, " ");
    if (!/\p{L}{2,}/u.test(words) || /[/:]/.test(words) || verbatimAllowed.has(text)) continue;
    const line = source.slice(0, match.index).split("\n").length;
    problems.push(
      `copy in Text(verbatim:), not in the catalog: ${NodePath.relative(iosRoot, file)}:${line} ${JSON.stringify(text)}`,
    );
  }
}

let used;
if (build) {
  used = new Set(stringsExtractedBy(build).keys());
  for (const key of used) {
    if (!(key in catalog.strings)) problems.push(`not in the catalog: ${JSON.stringify(key)}`);
  }
} else {
  used = swiftUses();
}
for (const [key, entry] of Object.entries(catalog.strings)) {
  if (entry.extractionState === "manual") continue;
  if (!used.has(key)) problems.push(`stale (no Swift string uses it): ${JSON.stringify(key)}`);
}

if (problems.length > 0) {
  console.log(problems.join("\n"));
  console.log(`\n${problems.length} translation problems in Localizable.xcstrings.`);
  process.exitCode = 1;
} else {
  console.log(
    `Localizable.xcstrings: ${Object.keys(catalog.strings).length} keys, ${locales.length} locales, no problems.`,
  );
}
