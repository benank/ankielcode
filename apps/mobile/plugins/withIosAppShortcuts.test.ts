import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { PushAlertKind } from "@ankielcode/contracts";
import { compileModsAsync, IOSConfig } from "expo/config-plugins";
import { afterEach, describe, expect, it } from "vite-plus/test";

import gtConfig from "../gt.config.json";
import withIosAppShortcuts from "./withIosAppShortcuts.cjs";

/** The app's locales as Xcode names them. */
const IOS_REGIONS = gtConfig.locales.map((locale) => (locale === "zh" ? "zh-Hans" : locale));

const require = NodeModule.createRequire(import.meta.url);
const projectRoots: string[] = [];

afterEach(() => {
  for (const root of projectRoots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function templateProject() {
  const projectRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "app-shortcuts-"));
  projectRoots.push(projectRoot);
  const template = NodePath.join(
    NodePath.dirname(require.resolve("expo/package.json")),
    "template.tgz",
  );
  NodeChildProcess.execFileSync("tar", [
    "-xzf",
    template,
    "-C",
    projectRoot,
    "--strip-components=1",
    "package/ios",
  ]);
  // Stands in for the widget extension expo-widgets adds, which must not compile the intents.
  const project = IOSConfig.XcodeUtils.getPbxproj(projectRoot);
  const widget = project.addTarget("ExpoWidgetsTarget", "app_extension", "ExpoWidgetsTarget");
  project.addBuildPhase([], "PBXSourcesBuildPhase", "Sources", widget.uuid);
  project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", widget.uuid);
  NodeFS.writeFileSync(
    NodePath.join(projectRoot, "ios/HelloWorld.xcodeproj/project.pbxproj"),
    project.writeSync(),
  );
  return projectRoot;
}

async function prebuildIos(projectRoot: string) {
  const config = withIosAppShortcuts({ name: "HelloWorld", slug: "hello-world" });
  await compileModsAsync(config, { projectRoot, platforms: ["ios"] });
  return IOSConfig.XcodeUtils.getPbxproj(projectRoot);
}

function buildPhaseFiles(project: ReturnType<typeof IOSConfig.XcodeUtils.getPbxproj>, isa: string) {
  const objects = project.hash.project.objects;
  const phases = objects[isa] as Record<string, { files?: Array<{ comment: string }> }>;
  const byTarget = new Map<string, string[]>();
  for (const [uuid, target] of Object.entries(objects.PBXNativeTarget)) {
    if (uuid.endsWith("_comment")) continue;
    const { name, buildPhases } = target as {
      name: string;
      buildPhases: Array<{ value: string }>;
    };
    const files = buildPhases.flatMap(
      (phase) => phases[phase.value]?.files?.map((file) => file.comment) ?? [],
    );
    byTarget.set(name.replace(/"/g, ""), files);
  }
  return byTarget;
}

describe("withIosAppShortcuts", () => {
  it("compiles the App Shortcuts and their string catalogs into the app target", async () => {
    const projectRoot = templateProject();
    const project = await prebuildIos(projectRoot);

    const sources = buildPhaseFiles(project, "PBXSourcesBuildPhase");
    const resources = buildPhaseFiles(project, "PBXResourcesBuildPhase");
    expect(sources.get("HelloWorld")).toContain("AnkielAppShortcuts.swift in Sources");
    expect(resources.get("HelloWorld")).toEqual(
      expect.arrayContaining([
        "AppShortcuts.xcstrings in Resources",
        "Localizable.xcstrings in Resources",
      ]),
    );
    expect(sources.get("ExpoWidgetsTarget")).toEqual([]);
    expect(resources.get("ExpoWidgetsTarget")).toEqual([]);
    const references = Object.values(project.pbxFileReferenceSection()) as Array<
      { readonly path?: string; readonly lastKnownFileType?: string } | string
    >;
    const catalogTypes = references.flatMap((reference) =>
      typeof reference === "object" && reference.path?.includes(".xcstrings")
        ? [reference.lastKnownFileType]
        : [],
    );
    expect(catalogTypes).toEqual(["text.json.xcstrings", "text.json.xcstrings"]);
    for (const region of IOS_REGIONS) {
      expect(project.hasKnownRegion(region.includes("-") ? `"${region}"` : region)).toBe(true);
    }
    for (const file of [
      "AnkielAppShortcuts.swift",
      "AppShortcuts.xcstrings",
      "Localizable.xcstrings",
    ]) {
      expect(NodeFS.existsSync(NodePath.join(projectRoot, "ios/HelloWorld", file))).toBe(true);
    }
  });

  // iOS shows a missing APNs `loc-key` as the raw key, so the server's keys need every language.
  it("defines every push alert loc-key in every app language", () => {
    const catalog = JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(__dirname, "../modules/ankiel-app-intents/app-target/Localizable.xcstrings"),
        "utf8",
      ),
    ) as {
      strings: Record<
        string,
        { localizations?: Record<string, { stringUnit?: { value?: string } }> }
      >;
    };
    for (const kind of PushAlertKind.literals) {
      const localizations = catalog.strings[`ANKIEL_PUSH_${kind.toUpperCase()}`]?.localizations;
      for (const region of ["en", ...IOS_REGIONS]) {
        expect(localizations?.[region]?.stringUnit?.value, `${kind} in ${region}`).toBeTruthy();
      }
    }
  });

  it("does not add the files twice on a repeated prebuild", async () => {
    const projectRoot = templateProject();
    const once = (await prebuildIos(projectRoot)).writeSync();
    expect((await prebuildIos(projectRoot)).writeSync()).toBe(once);
  });
});
