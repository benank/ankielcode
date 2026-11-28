import { builtInSourceControlDefinitions } from "@ankielcode/source-control-definitions/registry";
import * as GitHubDriver from "@ankielcode/source-control-github/server/driver";

export const BUILT_IN_SOURCE_CONTROL_DRIVER_LIST = [GitHubDriver.driver];

export const sourceControlDefinitions = builtInSourceControlDefinitions;
