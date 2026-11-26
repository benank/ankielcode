import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";

/** Features still settling in. */
export function LabsSettingsPanel() {
  const gt = useGT();
  return (
    <SettingsPageContainer>
      <SettingsSection id="beta" title={gt("Labs")} hideTitle>
        <WorkflowsRow />
        <PromptSuggestionsRow />
        <SimlockHostsRow />
        <FastWorktreeCheckoutRow />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function WorkflowsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("workflows-beta")}
      settingKeys={["workflowsEnabled"]}
      description={gt(
        "Run multi-step workflows from files in the workflows folder of this server's Ankiel home. Open them from the command palette. While off, nothing in that folder runs; runs wait until it is on again.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["workflowsEnabled"]}
          checked={settings.workflowsEnabled}
          onCheckedChange={(checked) => updateSettings({ workflowsEnabled: Boolean(checked) })}
          aria-label={gt("Workflows")}
        />
      }
    />
  );
}

function PromptSuggestionsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("prompt-suggestions-beta")}
      settingKeys={["promptSuggestionsEnabled"]}
      description={gt(
        "Show a predicted next message in the empty composer after a Claude or Codex turn. Tab uses it. Each is an extra cached request on your plan. Needs Codex 0.165+. Claude threads update on restart.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["promptSuggestionsEnabled"]}
          checked={settings.promptSuggestionsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ promptSuggestionsEnabled: Boolean(checked) })
          }
          aria-label={gt("Suggest next prompt")}
        />
      }
    />
  );
}

function SimlockHostsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("simlock-hosts")}
      settingKeys={["simlockDeviceHostsEnabled"]}
      description={
        <T>
          Let the Device panel lease simulators and emulators from your own{" "}
          <a
            href="https://incubator.callstack.com/simlock/"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            Simlock
          </a>{" "}
          pool, added in{" "}
          <Link to="/settings/devices" className="underline underline-offset-2">
            Devices
          </Link>
          . An alpha that may change or break. Ankiel Code never installs Simlock.
        </T>
      }
      control={
        <ScopedSwitch
          settingKeys={["simlockDeviceHostsEnabled"]}
          checked={settings.simlockDeviceHostsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ simlockDeviceHostsEnabled: Boolean(checked) })
          }
          aria-label={gt("Simlock device hosts")}
        />
      }
    />
  );
}

/** Shows only when every machine in scope is a Mac, since only macOS servers honor it. */
function FastWorktreeCheckoutRow() {
  const searchableSetting = useSearchableSetting();
  const { scope, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  if (
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    connectedEnvironments.length === 0 ||
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.fastWorktreeCheckout !== true,
    )
  )
    return null;
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("worktree-fast-checkout")}
      settingKeys={["fastWorktreeCheckout"]}
      description={gt(
        "On a Mac, clone new worktrees from a checkout cached in the Ankiel home folder instead of writing every file. Uses Git’s normal checkout when it can’t. Turning it off deletes the cache.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["fastWorktreeCheckout"]}
          checked={settings.fastWorktreeCheckout}
          onCheckedChange={(checked) => updateSettings({ fastWorktreeCheckout: Boolean(checked) })}
          aria-label={gt("Fast worktree checkout")}
        />
      }
    />
  );
}
