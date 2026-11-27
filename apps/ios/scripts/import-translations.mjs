#!/usr/bin/env node
// Fills missing catalog units from the RN app's translations (matched by English), then from
// manual-translations.json as needs_review. --sync <derived-data> first adds the keys that build
// extracted and drops unused ones, which xcodebuild (unlike the Xcode editor) never does.
//   node apps/ios/scripts/import-translations.mjs [--sync <derived-data>] [--catalog <path>] [--dry-run]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  catalogPath,
  iosRoot,
  locales,
  placeholders,
  readCatalog,
  rnLocale,
  stringsExtractedBy,
  swiftUses,
  writeCatalog,
} from "./catalog.mjs";

const rnTranslations = NodePath.join(iosRoot, "..", "mobile", "src", "i18n", "translations");
const manualPath = NodePath.join(iosRoot, "scripts", "manual-translations.json");

const parseIcu = (source) => {
  let index = 0;
  const parseParts = (nested) => {
    const parts = [];
    let text = "";
    const flush = () => {
      if (text) parts.push({ text });
      text = "";
    };
    while (index < source.length) {
      const char = source[index];
      if (char === "'") {
        const next = source[index + 1];
        if (next === "'") {
          text += "'";
          index += 2;
        } else if (next === "{" || next === "}") {
          const end = source.indexOf("'", index + 1);
          text += source.slice(index + 1, end === -1 ? source.length : end);
          index = end === -1 ? source.length : end + 1;
        } else {
          text += char;
          index += 1;
        }
      } else if (char === "{") {
        flush();
        index += 1;
        parts.push(parseArgument());
      } else if (char === "}") {
        if (!nested) throw new Error(`unbalanced } in ${source}`);
        break;
      } else {
        text += char;
        index += 1;
      }
    }
    flush();
    return parts;
  };
  const parseArgument = () => {
    const close = source.slice(index).search(/[,}]/);
    if (close === -1) throw new Error(`unclosed argument in ${source}`);
    const name = source.slice(index, index + close).trim();
    index += close;
    if (source[index] === "}") {
      index += 1;
      return { variable: name };
    }
    index += 1;
    const kindEnd = source.indexOf(",", index);
    if (kindEnd === -1) throw new Error(`argument without a kind in ${source}`);
    const kind = source.slice(index, kindEnd).trim();
    index = kindEnd + 1;
    const branches = {};
    for (;;) {
      while (/\s/.test(source[index])) index += 1;
      if (source[index] === "}") {
        index += 1;
        break;
      }
      const open = source.indexOf("{", index);
      if (open === -1 || index >= source.length) throw new Error(`unclosed branch in ${source}`);
      const branch = source.slice(index, open).trim();
      index = open + 1;
      branches[branch] = parseParts(true);
      index += 1;
    }
    return { [kind]: name, branches };
  };
  return parseParts(false);
};

// GT stores JSX messages as arrays of text and {k: "_gt_value_1"} variables. Plural JSX objects
// have no plain-text form, so they are skipped.
const toParts = (value) => {
  try {
    return toPartsOrThrow(value);
  } catch {
    return null;
  }
};
const toPartsOrThrow = (value) => {
  if (typeof value === "string") return parseIcu(value);
  if (!Array.isArray(value)) return null;
  const parts = [];
  for (const item of value) {
    if (typeof item === "string") parts.push(...parseIcu(item));
    else if (item && typeof item.k === "string" && item.v === "v") parts.push({ variable: item.k });
    else return null;
  }
  return parts;
};

// A form is text with \u0000 where an argument goes, plus the argument names in order.
const flatten = (parts, pluralVariable) => {
  let text = "";
  const args = [];
  for (const part of parts) {
    if ("text" in part) text += part.text;
    else if ("variable" in part) {
      text += "\u0000";
      args.push(part.variable);
    } else return null;
  }
  return { text, args, pluralVariable };
};

// Every English form a message can match: the whole text, or, for one plural, each branch with
// the text around it ("other" is what a "%lld threads" key matches).
const formsOf = (parts) => {
  const plurals = parts.filter((part) => "plural" in part);
  if (plurals.length === 0) {
    const form = flatten(parts);
    return form ? [{ ...form, branch: null }] : [];
  }
  if (plurals.length > 1 || parts.some((part) => "select" in part)) return [];
  const plural = plurals[0];
  const at = parts.indexOf(plural);
  const around = (inner) => [...parts.slice(0, at), ...inner, ...parts.slice(at + 1)];
  return Object.entries(plural.branches).flatMap(([branch, inner]) => {
    const form = flatten(around(inner), plural.plural);
    const forms = form ? [{ ...form, branch }] : [];
    // "Ran 1 command" is its own key in Swift: the singular branch with the count written out.
    if (branch === "one" || branch === "=1") {
      const literal = flatten(around(withOne(inner, plural.plural)), plural.plural);
      if (literal) forms.push({ ...literal, branch: "literal-one" });
    }
    return forms;
  });
};

const withOne = (parts, variable) =>
  parts.map((part) => (part.variable === variable ? { text: "1" } : part));

const trailing = /(?:\.\.\.|[.…:!?。：！？])+$/;
const normalize = (text) =>
  text
    .replace(/\.\.\./g, "…")
    .replace(trailing, "")
    .trim();

// A catalog key as a form: specifiers become \u0000. `^[…](inflect: true)` is matched by its
// inner text.
const keyForm = (key) => {
  const inflect = key.match(/^\^\[(.*)\]\(inflect: true\)$/s);
  const body = inflect ? inflect[1] : key;
  const text = body
    .replace(/%%/g, "\u0001")
    .replace(/%(?:\d+\$)?(?:@|ll[du]|l[du]|[duf]|\.\d+f)/g, "\u0000")
    .replace(/\u0001/g, "%");
  return { text, inflect: Boolean(inflect), body };
};

const CJK = new Set(["ja", "zh-Hans"]);
const fullWidth = { ".": "。", "?": "？", "!": "！", ":": "：" };

// Renders translated parts with the key's specifiers. `positions` maps an English argument name to
// its specifiers in the key, in order: a name used twice ("{host} … {host}") fills two of them.
const render = (parts, positions, positional) => {
  let out = "";
  const seen = new Map();
  for (const part of parts) {
    if ("text" in part) out += part.text.replace(/%/g, "%%");
    else if ("variable" in part) {
      const specs = positions.get(part.variable);
      if (!specs) throw new Error(`unknown argument ${part.variable}`);
      const index = seen.get(part.variable) ?? 0;
      seen.set(part.variable, index + 1);
      const spec = specs[Math.min(index, specs.length - 1)];
      out += positional ? `%${spec.position}$${spec.type}` : `%${spec.type}`;
    } else throw new Error("nested plural");
  }
  return out;
};

const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];

// One locale's unit for a key matched to an RN message.
const unitFor = ({ match, keySpecs, locale, message, keyEnding, state }) => {
  const positional = keySpecs.length > 1;
  const positions = new Map();
  match.args.forEach((name, i) =>
    positions.set(name, [...(positions.get(name) ?? []), keySpecs[i]]),
  );
  const finish = (value) => {
    if (!match.punctuationNormalized) return value;
    let ending = keyEnding;
    if (CJK.has(locale)) ending = [...ending].map((char) => fullWidth[char] ?? char).join("");
    return value.replace(trailing, "").trimEnd() + ending;
  };
  const plural = message.find((part) => "plural" in part);
  const at = message.indexOf(plural);
  const around = (inner) => [...message.slice(0, at), ...inner, ...message.slice(at + 1)];
  if (match.branch === "literal-one") {
    const inner = plural.branches["=1"] ?? plural.branches.one ?? plural.branches.other;
    const value = render(around(withOne(inner, plural.plural)), positions, positional);
    return { stringUnit: { state, value: finish(value) } };
  }
  if (match.branch !== null && match.branch !== "other") {
    // A key that is one branch of a plural: use that branch's translation as plain text.
    const inner = plural.branches[match.branch] ?? plural.branches.one ?? plural.branches.other;
    return { stringUnit: { state, value: finish(render(around(inner), positions, positional)) } };
  }
  if (match.branch === "other") {
    if (!positions.has(plural.plural)) return null;
    const variations = {};
    for (const [branch, inner] of Object.entries(plural.branches)) {
      const category = branch === "=0" ? "zero" : branch === "=1" ? "one" : branch;
      if (!PLURAL_CATEGORIES.includes(category)) return null;
      if (variations[category] && !branch.startsWith("=")) continue;
      variations[category] = {
        stringUnit: { state, value: finish(render(around(inner), positions, positional)) },
      };
    }
    if (!variations.other) return null;
    return { variations: { plural: variations } };
  }
  return { stringUnit: { state, value: finish(render(message, positions, positional)) } };
};

// "%lld." or "%@ · %@" has nothing to translate.
const hasWords = (text) => /\p{L}/u.test(text.replace(/\u0000/g, ""));

const isEmptyUnit = (unit) =>
  !unit || (unit.stringUnit?.state === "new" && !unit.variations) || Object.keys(unit).length === 0;

const args = process.argv.slice(2);
const flag = (name) => args.indexOf(name);
const target =
  flag("--catalog") === -1 ? catalogPath : NodePath.resolve(args[flag("--catalog") + 1]);
const dryRun = flag("--dry-run") !== -1;
const sync = flag("--sync") === -1 ? undefined : NodePath.resolve(args[flag("--sync") + 1]);

const readJson = (file) => JSON.parse(NodeFS.readFileSync(file, "utf8"));
const english = readJson(NodePath.join(rnTranslations, "en.json"));
const translated = Object.fromEntries(
  locales.map((locale) => [
    locale,
    readJson(NodePath.join(rnTranslations, `${rnLocale(locale)}.json`)),
  ]),
);

// English form text (exact and normalized) -> candidate messages.
const exactIndex = new Map();
const normalizedIndex = new Map();
for (const [hash, value] of Object.entries(english)) {
  const parts = toParts(value);
  if (!parts) continue;
  for (const form of formsOf(parts)) {
    const entry = { hash, ...form };
    for (const [index, text] of [
      [exactIndex, form.text],
      [normalizedIndex, normalize(form.text)],
    ]) {
      if (!index.has(text)) index.set(text, []);
      index.get(text).push(entry);
    }
  }
}

const manual = NodeFS.existsSync(manualPath) ? readJson(manualPath) : {};

// Read, change and write in one synchronous pass, so a key another session adds in the meantime
// is never overwritten by a stale copy.
const catalog = readCatalog(target);
const added = [];
const removed = [];
if (sync) {
  const extracted = stringsExtractedBy(sync);
  const literal = swiftUses();
  for (const [key, comments] of extracted) {
    if (key in catalog.strings) continue;
    catalog.strings[key] = comments.size > 0 ? { comment: [...comments].sort().join("\n") } : {};
    added.push(key);
  }
  for (const [key, entry] of Object.entries(catalog.strings)) {
    if (extracted.has(key) || literal.has(key) || entry.extractionState === "manual") continue;
    delete catalog.strings[key];
    removed.push(key);
  }
}
// Debug-only copy (commented "debug: …") and the product name are never translated.
for (const [key, entry] of Object.entries(catalog.strings)) {
  if (key === "Ankiel Code" || /^debug\b/.test(entry.comment ?? "")) entry.shouldTranslate = false;
}
const before = Object.keys(catalog.strings).length;
const report = {
  copied: 0,
  manual: 0,
  conflicts: [],
  unmatched: new Map(locales.map((l) => [l, []])),
};

for (const [key, entry] of Object.entries(catalog.strings)) {
  const form = keyForm(key);
  if (entry.shouldTranslate === false || !hasWords(form.text)) continue;
  const keySpecs = placeholders(form.body).sort((a, b) => a.position - b.position);

  let candidates = exactIndex.get(form.text) ?? [];
  let punctuationNormalized = false;
  if (candidates.length === 0) {
    candidates = normalizedIndex.get(normalize(form.text)) ?? [];
    punctuationNormalized = candidates.length > 0;
  }
  // A plural key ("%lld threads") prefers the plural's "other" branch over a fixed branch. An
  // inflect key is written in the singular ("^[%lld attachment](inflect: true)"), so its "one"
  // branch stands for the whole plural: other languages get plural variations instead.
  candidates = candidates.filter((c) => c.args.length === keySpecs.length);
  if (form.inflect) {
    candidates = candidates.map((c) =>
      c.branch === "one" || c.branch === "=1" ? { ...c, branch: "other" } : c,
    );
  }
  const preferred = candidates.filter((c) => c.branch === "other");
  if (preferred.length > 0) candidates = preferred;
  const keyEnding = form.body.match(trailing)?.[0]?.replace(/\.\.\./g, "…") ?? "";

  entry.localizations ??= {};
  for (const locale of locales) {
    if (!isEmptyUnit(entry.localizations[locale])) continue;
    // Duplicate English strings (RN keys hash their context too) may translate differently.
    const units = new Map();
    const votes = new Map();
    for (const candidate of candidates) {
      const message = toParts(translated[locale][candidate.hash] ?? "");
      if (!message || message.length === 0) continue;
      const match = { ...candidate, punctuationNormalized };
      try {
        const unit = unitFor({ match, keySpecs, locale, message, keyEnding, state: "translated" });
        if (unit) {
          const id = JSON.stringify(unit);
          units.set(id, unit);
          votes.set(id, (votes.get(id) ?? 0) + 1);
        }
      } catch {
        // A translation that names an argument the English lacks is not usable.
      }
    }
    // The most common translation wins; a disagreement is still flagged for review.
    const winner = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
    let unit = winner ? units.get(winner) : null;
    if (units.size > 1) {
      report.conflicts.push(`${locale}: ${key}`);
      unit = JSON.parse(JSON.stringify(unit).replaceAll('"translated"', '"needs_review"'));
    }
    if (!unit && manual[key]?.[locale] !== undefined) {
      const value = manual[key][locale];
      unit =
        typeof value === "string"
          ? { stringUnit: { state: "needs_review", value } }
          : {
              variations: {
                plural: Object.fromEntries(
                  Object.entries(value).map(([category, text]) => [
                    category,
                    { stringUnit: { state: "needs_review", value: text } },
                  ]),
                ),
              },
            };
      report.manual += 1;
    } else if (unit) report.copied += 1;
    if (unit) entry.localizations[locale] = unit;
    else report.unmatched.get(locale).push(key);
  }

  // English plural forms from RN, so "%lld threads" reads "1 thread" (inflect keys inflect alone).
  if (
    !form.inflect &&
    candidates.some((c) => c.branch === "other") &&
    isEmptyUnit(entry.localizations.en)
  ) {
    const candidate = candidates.find((c) => c.branch === "other");
    const unit = unitFor({
      match: { ...candidate, punctuationNormalized },
      keySpecs,
      locale: "en",
      message: toParts(english[candidate.hash]),
      keyEnding,
      state: "translated",
    });
    if (unit?.variations?.plural.one) entry.localizations.en = unit;
  }
  if (Object.keys(entry.localizations).length === 0) delete entry.localizations;
}

if (Object.keys(catalog.strings).length !== before) throw new Error("the catalog lost keys");
const unused = Object.keys(manual).filter((key) => !(key in catalog.strings));

if (sync)
  console.log(
    `Synced with the build: added ${added.length} keys, removed ${removed.length} (${removed.map((key) => JSON.stringify(key)).join(", ") || "none"}).`,
  );
console.log(
  `Copied ${report.copied} units from the React Native catalogs; ${report.manual} from manual-translations.json (needs_review).`,
);
if (report.conflicts.length > 0) {
  console.log(
    `\n${report.conflicts.length} units had differing RN translations (marked needs_review):`,
  );
  for (const line of report.conflicts) console.log(`  ${line}`);
}
const missing = [...report.unmatched].filter(([, keys]) => keys.length > 0);
if (missing.length > 0) {
  console.log("\nStill untranslated:");
  for (const [locale, keys] of missing) console.log(`  ${locale}: ${keys.length}`);
  const keys = [...new Set(missing.flatMap(([, list]) => list))].sort();
  for (const key of keys) console.log(`    ${JSON.stringify(key)}`);
}
if (unused.length > 0)
  console.log(`\nmanual-translations.json keys no longer in the catalog: ${unused.length}`);

if (!dryRun) {
  writeCatalog(catalog, target);
  console.log(`\nWrote ${NodePath.relative(process.cwd(), target)}.`);
}
