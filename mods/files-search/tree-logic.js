// Pure folder-tree cascade and filtering helpers for files-search (no runtime imports).

export const MAX_CASCADE_DEPTH = 32;

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

/**
 * Expand a single-directory chain starting at `startPath` until a loaded folder is empty,
 * contains a file, contains multiple visible entries, reaches `maxDepth`, or is collapsed/cancelled.
 */
export async function runFolderCascade({
  startPath,
  maxDepth = MAX_CASCADE_DEPTH,
  getFilterRel,
  isActive,
  hasEntries,
  getEntries,
  acquirePending,
  clearPending,
  expandFolder,
  loadFolder,
  onError,
  onStep,
}) {
  if (!startPath || !isActive(startPath)) return false;
  const visited = new Set([startPath]);
  let curPath = startPath;

  for (let depth = 0; depth <= maxDepth; depth++) {
    if (!isActive(curPath)) return false;

    if (!hasEntries(curPath)) {
      if (!acquirePending(curPath)) return false;
      onStep?.(curPath);
      let loaded = false;
      try {
        loaded = (await loadFolder(curPath)) !== false;
      } catch (err) {
        if (isActive(curPath)) onError?.(err);
        loaded = false;
      } finally {
        clearPending(curPath);
      }
      if (!loaded || !isActive(curPath)) {
        onStep?.(curPath);
        return false;
      }
    }

    if (depth >= maxDepth) {
      onStep?.(curPath);
      return true;
    }

    const filterRel = getFilterRel ? getFilterRel() : null;
    const nextChild = getCascadeChildPath(curPath, getEntries(curPath), filterRel);
    if (!nextChild || visited.has(nextChild)) {
      onStep?.(curPath);
      return true;
    }

    visited.add(nextChild);
    expandFolder(nextChild);
    if (!hasEntries(nextChild) && !acquirePending(nextChild)) {
      onStep?.(nextChild);
      return true;
    }
    onStep?.(nextChild);
    curPath = nextChild;
  }

  return true;
}
