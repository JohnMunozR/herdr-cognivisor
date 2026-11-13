// Pure folder-tree cascade, sorting, and filtering helpers for files-search (no runtime imports).

export const MAX_CASCADE_DEPTH = 32;
export const PER_FOLDER_LIMIT = 500;
export const TOTAL_TREE_LIMIT = 5000;

const NAME_COLLATOR =
  typeof Intl !== "undefined" && typeof Intl.Collator === "function"
    ? new Intl.Collator()
    : null;

/** One-shot POSIX shell cascade script listing single-subfolder chains in one process spawn. */
export const POSIX_CASCADE_SCRIPT = [
  'base=$1; max=${2:-32}; rel=""; cur="$base"; depth=0',
  'test -d "$cur" || exit 1',
  'while [ "$depth" -le "$max" ]; do',
  '  printf "L\\0%s\\0" "$rel"',
  '  n=0; dcount=0; only_dir=""',
  '  for p in "$cur"/* "$cur"/.[!.]* "$cur"/..?*; do',
  '    [ -e "$p" ] || [ -L "$p" ] || continue',
  '    name=${p##*/}',
  '    [ "$name" = .git ] && continue',
  '    if [ -d "$p" ]; then',
  '      kind=d; only_dir=$name; dcount=$((dcount+1))',
  '    else',
  '      kind=f',
  '    fi',
  '    printf "%s\\0%s\\0" "$kind" "$name"',
  '    n=$((n+1))',
  '    [ "$n" -gt 500 ] && break',
  '  done',
  '  [ "$n" -eq 1 ] && [ "$dcount" -eq 1 ] || break',
  '  [ "$depth" -ge "$max" ] && break',
  '  if [ -z "$rel" ]; then rel=$only_dir; else rel="$rel/$only_dir"; fi',
  '  cur="$cur/$only_dir"',
  '  test -d "$cur" || break',
  '  depth=$((depth+1))',
  'done',
].join("\n");

/** Compare two tree entries directories-first, then by name using a cached collator. */
export function compareTreeEntries(a, b) {
  const dirDiff = Number(Boolean(b?.dir)) - Number(Boolean(a?.dir));
  if (dirDiff !== 0) return dirDiff;
  const na = String(a?.name || "");
  const nb = String(b?.name || "");
  return NAME_COLLATOR ? NAME_COLLATOR.compare(na, nb) : na.localeCompare(nb);
}

/** Return a sorted shallow copy of directory entries (fast path when length <= 1). */
export function sortDirectoryEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  if (entries.length === 1) return [entries[0]];
  return [...entries].sort(compareTreeEntries);
}

/** Return true when `relPath` is visible under an active `filterRel` service subtree. */
export function matchesServiceFilter(relPath, filterRel) {
  if (!filterRel) return true;
  if (!relPath) return false;
  return relPath === filterRel || relPath.startsWith(filterRel + "/") || filterRel.startsWith(relPath + "/");
}

/**
 * If `entries` inside `parentPath` contain strictly one visible item and it is a directory,
 * return that child folder's relative path; otherwise return `null` to stop cascading.
 */
export function getCascadeChildPath(parentPath, entries, filterRel = null) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  let singleEntry = null;
  let singlePath = null;

  for (const entry of entries) {
    if (!entry || !entry.name || entry.name === "." || entry.name === "..") continue;
    const childPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
    if (filterRel && !matchesServiceFilter(childPath, filterRel)) continue;
    if (singleEntry) return null;
    singleEntry = entry;
    singlePath = childPath;
  }

  return singleEntry && singleEntry.dir === true ? singlePath : null;
}

/** Collect `rootPath` and all descendant paths (`rootPath/...`) from an iterable of path strings. */
export function collectSubtreePaths(paths, rootPath) {
  if (!rootPath || !paths) return [];
  const prefix = rootPath + "/";
  const matched = [];
  for (const path of paths) {
    if (path === rootPath || path.startsWith(prefix)) matched.push(path);
  }
  return matched;
}

/** Parse NUL-delimited output produced by `POSIX_CASCADE_SCRIPT` into `Map<relPath, entries[]>`. */
export function parseCascadeStdout(stdout, startPath) {
  const levels = new Map();
  if (!stdout) return levels;
  const fields = stdout.split("\0");
  let currentList = null;

  for (let i = 0; i + 1 < fields.length; i += 2) {
    const tag = fields[i];
    const value = fields[i + 1];
    if (tag === "L") {
      const fullRel = value
        ? (startPath ? `${startPath}/${value}` : value)
        : startPath;
      currentList = [];
      levels.set(fullRel, currentList);
    } else if (currentList && (tag === "d" || tag === "f") && value) {
      currentList.push({ name: value, dir: tag === "d" });
    }
  }

  return levels;
}

/**
 * Resolve a cascading single-folder chain completely in memory before committing UI state,
 * so all nested single folders visually expand together once loaded.
 */
export async function runStagedCascade({
  startPath,
  maxDepth = MAX_CASCADE_DEPTH,
  getFilterRel,
  isCancelled,
  getCachedEntries,
  fetchCascadeBatch,
  fetchSingleEntries,
}) {
  if (!startPath || isCancelled?.()) return null;

  const stagedEntries = new Map();
  const stagedFolders = [];
  const visited = new Set([startPath]);
  let curPath = startPath;

  for (let depth = 0; depth <= maxDepth; depth++) {
    if (isCancelled?.()) return null;

    let entries = stagedEntries.has(curPath)
      ? stagedEntries.get(curPath)
      : getCachedEntries?.(curPath);

    if (!entries && fetchCascadeBatch) {
      const remainingDepth = Math.max(0, maxDepth - depth);
      const batch = await fetchCascadeBatch(curPath, remainingDepth);
      if (isCancelled?.()) return null;
      if (batch && batch.size > 0) {
        for (const [relPath, list] of batch) {
          if (!stagedEntries.has(relPath) && !getCachedEntries?.(relPath)) {
            stagedEntries.set(relPath, list);
          }
        }
        entries = stagedEntries.get(curPath);
      }
    }

    if (!entries) {
      entries = await fetchSingleEntries(curPath);
      if (isCancelled?.()) return null;
      stagedEntries.set(curPath, entries);
    }

    stagedFolders.push(curPath);

    if (depth >= maxDepth) break;

    const filterRel = getFilterRel ? getFilterRel() : null;
    const nextChild = getCascadeChildPath(curPath, entries, filterRel);
    if (!nextChild || visited.has(nextChild)) break;

    visited.add(nextChild);
    curPath = nextChild;
  }

  return { stagedEntries, stagedFolders };
}
