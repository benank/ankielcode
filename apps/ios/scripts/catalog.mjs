// Reads and writes Localizable.xcstrings in Xcode's own JSON style, so a script edit and an Xcode
// edit produce the same bytes: `" : "` separators, two-space indent, sorted object keys.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const iosRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
export const catalogPath = NodePath.join(iosRoot, "AnkielCode", "Localizable.xcstrings");

// The 9 locales the React Native app ships, as Apple names them.
export const locales = ["de", "es", "fr", "ja", "ko", "pt-BR", "ru", "sv", "zh-Hans"];
export const rnLocale = (locale) => (locale === "zh-Hans" ? "zh" : locale);

export const readCatalog = (path = catalogPath) => JSON.parse(NodeFS.readFileSync(path, "utf8"));

// Xcode orders keys by UTF-16 code unit, as JavaScript compares strings.
const compareKeys = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const quote = (value) => JSON.stringify(value);

const serialize = (value, indent) => {
  const pad = "  ".repeat(indent + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[\n\n" + "  ".repeat(indent) + "]";
    return `[\n${value.map((item) => pad + serialize(item, indent + 1)).join(",\n")}\n${"  ".repeat(indent)}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort(compareKeys);
    if (keys.length === 0) return "{\n\n" + "  ".repeat(indent) + "}";
    const body = keys.map((key) => `${pad}${quote(key)} : ${serialize(value[key], indent + 1)}`);
    return `{\n${body.join(",\n")}\n${"  ".repeat(indent)}}`;
  }
  return typeof value === "string" ? quote(value) : JSON.stringify(value);
};

// Xcode writes no newline after the closing brace.
export const formatCatalog = (catalog) => serialize(catalog, 0);

// Write through a temp file so Xcode or another script never reads half a catalog.
export const writeCatalog = (catalog, path = catalogPath) => {
  const temp = `${path}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temp, formatCatalog(catalog));
  NodeFS.renameSync(temp, path);
};

// `%@`, `%lld`, `%1$@`… in a catalog key or value, in order. `%%` is a literal percent sign.
const specifier = /%(?:(\d+)\$)?(@|ll[du]|l[du]|[duf]|\.\d+f)|%%/g;
export const placeholders = (text) => {
  const found = [];
  let next = 1;
  for (const match of text.matchAll(specifier)) {
    if (match[0] === "%%") continue;
    const position = match[1] ? Number(match[1]) : next++;
    found.push({ position, type: match[2] === "@" ? "@" : match[2].replace(/^\.\d+/, "") });
  }
  return found;
};

export const swiftFiles = (dir) =>
  NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) return swiftFiles(path);
    return entry.name.endsWith(".swift") ? [path] : [];
  });

// Every string literal's text, with each `\(…)` interpolation replaced by \u0000.
const literals = (source) => {
  const found = new Set();
  let index = 0;
  const readLiteral = (multiline) => {
    let text = "";
    const close = multiline ? '"""' : '"';
    while (index < source.length && !source.startsWith(close, index)) {
      const char = source[index];
      if (!multiline && char === "\n") return null;
      if (char !== "\\") {
        text += char;
        index += 1;
        continue;
      }
      const next = source[index + 1];
      if (next === "(") {
        index += 2;
        let depth = 1;
        while (depth > 0 && index < source.length) {
          if (source[index] === '"') {
            // A literal inside the interpolation, such as a default value.
            const nested = source.startsWith('"""', index);
            index += nested ? 3 : 1;
            const inner = readLiteral(nested);
            if (inner !== null) found.add(inner);
            continue;
          }
          if (source[index] === "(") depth += 1;
          else if (source[index] === ")") depth -= 1;
          index += 1;
        }
        text += "\u0000";
        continue;
      }
      const escapes = { n: "\n", t: "\t", r: "\r", 0: "\0", '"': '"', "'": "'", "\\": "\\" };
      if (next === "u") {
        const end = source.indexOf("}", index);
        text += String.fromCodePoint(parseInt(source.slice(index + 3, end), 16));
        index = end + 1;
      } else if (multiline && next === "\n") {
        index += 2;
      } else {
        text += escapes[next] ?? next;
        index += 2;
      }
    }
    index += close.length;
    // A multiline literal drops its first newline and the closing line's indentation.
    if (multiline) {
      const lines = text.replace(/^\n/, "").split("\n");
      const indent = lines.at(-1).match(/^\s*/)[0].length;
      text = lines
        .slice(0, -1)
        .map((line) => line.slice(indent))
        .join("\n");
    }
    return text;
  };
  while (index < source.length) {
    if (source.startsWith("//", index) && !source.startsWith("///", index - 1)) {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index);
      index = end === -1 ? source.length : end + 2;
    } else if (source.startsWith('"""', index)) {
      index += 3;
      const text = readLiteral(true);
      if (text !== null) found.add(text);
    } else if (source[index] === '"') {
      index += 1;
      const text = readLiteral(false);
      if (text !== null) found.add(text);
    } else index += 1;
  }
  return found;
};

const asLiteral = (key) =>
  key
    .replace(/%%/g, "\u0001")
    .replace(/%(?:\d+\$)?(?:@|ll[du]|l[du]|[duf]|\.\d+f)/g, "\u0000")
    .replace(/\u0001/g, "%");

// Keys some Swift string literal in the app could produce: `\(…)` matches any specifier.
export const swiftUses = () => {
  const sources = new Set();
  // The widget's views are compiled into the app too and read its catalog.
  for (const file of ["AnkielCode", "AnkielWidgets"].flatMap((dir) =>
    swiftFiles(NodePath.join(iosRoot, dir)),
  )) {
    for (const text of literals(NodeFS.readFileSync(file, "utf8"))) sources.add(text);
  }
  return { has: (key) => key === "" || sources.has(asLiteral(key)) };
};

// The keys (and comments) the compiler extracted for the app in an Xcode build's derived data.
// xcodebuild extracts them but, unlike the Xcode editor, never writes them to the catalog.
export const stringsExtractedBy = (derivedData) => {
  const appBuild = NodePath.join(derivedData, "Build", "Intermediates.noindex", "AnkielCode.build");
  if (!NodeFS.existsSync(appBuild)) throw new Error(`no app build in ${derivedData}`);
  const files = (dir) =>
    NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) return files(path);
      return entry.name.endsWith(".stringsdata") ? [path] : [];
    });
  const keys = new Map();
  for (const file of files(appBuild)) {
    const tables = JSON.parse(NodeFS.readFileSync(file, "utf8")).tables ?? {};
    for (const { key, comment } of tables.Localizable ?? []) {
      const comments = keys.get(key) ?? new Set();
      if (comment) comments.add(comment);
      keys.set(key, comments);
    }
  }
  return keys;
};
