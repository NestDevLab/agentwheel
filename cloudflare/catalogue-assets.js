// Shared by the asset builder and Worker; no catalogue-sized work at request time.
export const SHARD_COUNT = 1024;
export const MAX_SHARD_BYTES = 64 * 1024;
export const MAX_TEMPLATE_BYTES = 256 * 1024;
// A text asset avoids Static Assets' automatic .html canonical redirects.
export const TEMPLATE_PATH = "/__catalogue/template.txt";

export function metadataAssetPath(resourceId) {
  let hash = 2166136261;
  for (let i = 0; i < resourceId.length; i += 1) {
    hash = Math.imul(hash ^ resourceId.charCodeAt(i), 16777619);
  }
  return `/__catalogue/metadata/${((hash >>> 0) % SHARD_COUNT).toString(16).padStart(3, "0")}.json`;
}
