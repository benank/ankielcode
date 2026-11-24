import { remoteCacheUrl } from "./remoteCache.ts";

export default function start({ root }: { readonly root: string }) {
  if (!remoteCacheUrl(root)) return;
  // The patched runner awaits this when the run ends and reads `remoteCache` before it starts.
  return Object.assign(async () => {}, {
    remoteCache: process.env.VP_REMOTE_CACHE || process.env.VP_AC_TASK_CACHE_MODE || "read-write",
  });
}
