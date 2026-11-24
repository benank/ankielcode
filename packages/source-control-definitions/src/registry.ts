import { makeSourceControlDefinitionRegistry } from "@ankielcode/source-control-core/shared/definition";
import * as GitHub from "@ankielcode/source-control-github/shared/definition";

export const builtInSourceControlDefinitions = makeSourceControlDefinitionRegistry(
  [GitHub.definition],
  {
    claimChangeRequestUrlsFirst: [],
    recognizeRemotesIn: [GitHub.definition.kind],
  },
);
