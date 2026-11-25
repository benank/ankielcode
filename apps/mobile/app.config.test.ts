import { afterEach, expect, it, vi } from "vite-plus/test";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () =>
    Object.fromEntries(
      ["APP_VARIANT", "ANKIEL_EAS_PROJECT_ID", "ANKIEL_EAS_OWNER", "ANKIEL_APPLE_TEAM_ID"].flatMap(
        (key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]]),
      ),
    ),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.ankiel.ankielcode"],
  ["development", "com.ankiel.ankielcode.dev"],
  ["preview", "com.ankiel.ankielcode.preview"],
  ["production", "com.ankiel.ankielcode"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  expect(config.ios?.associatedDomains).toBeUndefined();
  expect(config.android?.intentFilters).toBeUndefined();
});

it("carries no Expo or Apple account identifiers unless the environment sets them", async () => {
  const config = await loadConfig(undefined);
  expect(config.owner).toBeUndefined();
  expect(config.extra?.eas).toBeUndefined();
  expect(config.ios?.appleTeamId).toBeUndefined();
  expect(config.updates?.enabled).toBe(false);
  expect(config.updates?.url).toBeUndefined();
});

it("derives updates and account identifiers from the environment", async () => {
  vi.stubEnv("ANKIEL_EAS_PROJECT_ID", "00000000-0000-4000-8000-000000000000");
  vi.stubEnv("ANKIEL_EAS_OWNER", "example-owner");
  vi.stubEnv("ANKIEL_APPLE_TEAM_ID", "TEAM123456");
  const config = await loadConfig(undefined);
  expect(config.owner).toBe("example-owner");
  expect(config.extra?.eas).toEqual({ projectId: "00000000-0000-4000-8000-000000000000" });
  expect(config.ios?.appleTeamId).toBe("TEAM123456");
  expect(config.updates).toMatchObject({
    enabled: true,
    url: "https://u.expo.dev/00000000-0000-4000-8000-000000000000",
  });
});
