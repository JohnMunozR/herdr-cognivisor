// Pure folder-tree cascade, sorting, filtering, and row-building helpers for files-search (no runtime imports).

export const MAX_CASCADE_DEPTH = 32;
export const PER_FOLDER_LIMIT = 500;
export const TOTAL_TREE_LIMIT = 5000;

const NAME_COLLATOR =
  typeof Intl !== "undefined" && typeof Intl.Collator === "function"
    ? new Intl.Collator()
    : null;

/** Fast bounded POSIX single-directory listing script (avoids full-dir shell globbing/sorting). */
export const POSIX_LIST_SCRIPT = [
  'cur=$1',
  '[ -d "$cur" ] && [ -r "$cur" ] && [ -x "$cur" ] || exit 1',
  'set -f',
  "NL='\n'",
  'IFS="$NL"',
  'n=0',
  'for name in $(ls -1 -f -- "$cur" 2>/dev/null | head -n 520); do',
  '  [ -n "$name" ] || continue',
  '  [ "$name" = "." ] || [ "$name" = ".." ] || [ "$name" = ".git" ] && continue',
  '  p="$cur/$name"',
  '  [ -e "$p" ] || [ -L "$p" ] || continue',
  '  if [ -d "$p" ]; then kind=d; else kind=f; fi',
  '  printf "%s\\0%s\\0" "$kind" "$name"',
  '  n=$((n+1))',
  '  [ "$n" -gt 500 ] && break',
  'done',
].join("\n");

/** One-shot bounded POSIX shell cascade script listing single-subfolder chains without full-dir glob sorting. */
export const POSIX_CASCADE_SCRIPT = [
  'base=$1; max=${2:-32}; rel=""; cur="$base"; depth=0',
  '[ -d "$cur" ] && [ -r "$cur" ] && [ -x "$cur" ] || exit 1',
  'set -f',
  "NL='\n'",
  'IFS="$NL"',
  'while [ "$depth" -le "$max" ]; do',
  '  printf "L\\0%s\\0" "$rel"',
  '  n=0; dcount=0; only_dir=""',
  '  for name in $(ls -1 -f -- "$cur" 2>/dev/null | head -n 520); do',
  '    [ -n "$name" ] || continue',
  '    [ "$name" = "." ] || [ "$name" = ".." ] || [ "$name" = ".git" ] && continue',
  '    p="$cur/$name"',
  '    [ -e "$p" ] || [ -L "$p" ] || continue',
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
  '  [ -d "$cur" ] && [ -r "$cur" ] && [ -x "$cur" ] || break',
  '  depth=$((depth+1))',
  'done',
].join("\n");

/** Normalize a filesystem path to forward slashes without trailing slash (preserving root "/"). */
function normRootPath(p) {
  const s = String(p || "").replace(/\\/g, "/");
  if (s === "/") return "/";
  return s.replace(/\/+$/, "");
}

/**
 * Compute a workspace-scoped context key for the folder tree cache.
 * Deliberately excludes `tabId` so switching terminal tabs inside the same
 * workspace keeps cached folders, watchers, and in-flight expands intact.
 */
export function computeWorkspaceContextKey(loc) {
  return JSON.stringify({
    cwd: loc?.cwd || null,
    on: loc?.on ?? null,
    space: loc?.space || null,
  });
}

/**
 * Return ancestor directory paths needed to reveal `relPath`, skipping any already cached in `entriesMap`.
 * When `includeSelf` is true (directory reveal), includes `relPath` itself; otherwise stops at parent.
 */
export function collectMissingAncestorPaths(relPath, entriesMap = null, includeSelf = true) {
  const clean = String(relPath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!clean) return [];
  const segments = clean.split("/").filter(Boolean);
  const limit = includeSelf ? segments.length : Math.max(0, segments.length - 1);
  const missing = [];
  let accum = "";
  for (let i = 0; i < limit; i++) {
    accum = accum ? `${accum}/${segments[i]}` : segments[i];
    if (!entriesMap || !entriesMap.has(accum)) {
      missing.push(accum);
    }
  }
  return missing;
}

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
 * Build flattened virtualized tree rows for `#files`.
 * Normalizes `root` once outside traversal and skips path joining completely when
 * `repoRoots`, `dirCounts`, and `marks` are empty.
 */
export function buildTreeRows({
  entries,
  folders,
  pending,
  root = "",
  isWindows = false,
  serviceFilter = "all",
  services = null,
  serviceFiles = null,
  repoRoots = null,
  dirCounts = null,
  marks = null,
  maxTotal = TOTAL_TREE_LIMIT,
} = {}) {
  const selectedService = (serviceFilter && serviceFilter !== "all")
    ? (services || []).find(s => s.id === serviceFilter) || null
    : null;
  const out = [];
  const byKey = new Map();

  if (selectedService?.isSibling) {
    const siblingFiles = serviceFiles?.[selectedService.id] ?? [];
    const cap = Math.min(siblingFiles.length, maxTotal);
    for (let i = 0; i < cap; i++) {
      const sf = siblingFiles[i];
      const rowKey = `sibling:${sf.fullPath}`;
      const row = {
        key: rowKey,
        kind: "sibling",
        fullPath: sf.fullPath,
        path: sf.fullPath,
        name: sf.name,
        mark: sf.mark,
      };
      out.push(row);
      byKey.set(rowKey, row);
    }
    return { rows: out, hitVisibleCap: siblingFiles.length > maxTotal, byKey };
  }

  const normRoot = normRootPath(root);
  const rawRootNoTrail = String(root || "").replace(/[\\/]+$/, "");
  const rootPrefixNorm = normRoot === "/" ? "/" : (normRoot ? `${normRoot}/` : "");
  const rootPrefixRaw = rawRootNoTrail === "/" ? "/" : (rawRootNoTrail ? `${rawRootNoTrail}/` : "");
  const rawDiffersFromNorm = rootPrefixRaw !== rootPrefixNorm;

  const hasRepos = Boolean(repoRoots && repoRoots.size > 0);
  const hasDirCounts = Boolean(dirCounts && Object.keys(dirCounts).length > 0);
  const hasMarks = Boolean(marks && Object.keys(marks).length > 0);
  const needDirLookup = hasRepos || hasDirCounts;
  const filterRel = selectedService?.relPath || null;

  let hitVisibleCap = false;

  const append = (prefix, depth) => {
    if (out.length >= maxTotal) {
      hitVisibleCap = true;
      return;
    }
    if (depth > 40) return;

    const list = entries?.get(prefix);
    if (!list?.length) return;

    for (let i = 0; i < list.length; i++) {
      if (out.length >= maxTotal) {
        hitVisibleCap = true;
        return;
      }
      const entry = list[i];
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (filterRel && !matchesServiceFilter(path, filterRel)) continue;

      const isDir = Boolean(entry.dir);
      const open = Boolean(isDir && folders?.has(path));
      const isLoadingFolder = Boolean(isDir && pending?.has(path));

      let isRepo = false;
      let dirCount = 0;
      let mark = null;

      if ((isDir && needDirLookup) || (!isDir && hasMarks)) {
        const normFullPath = rootPrefixNorm ? `${rootPrefixNorm}${path}` : path;
        const cmpFullPath = isWindows ? normFullPath.toLowerCase() : normFullPath;
        const rawFullPath = rawDiffersFromNorm ? `${rootPrefixRaw}${path}` : normFullPath;
        if (isDir) {
          if (hasRepos) {
            isRepo = Boolean(
              repoRoots.has(normFullPath) ||
              (isWindows && repoRoots.has(cmpFullPath)) ||
              (rawDiffersFromNorm && repoRoots.has(rawFullPath))
            );
          }
          if (hasDirCounts) {
            dirCount =
              dirCounts[normFullPath] ||
              (isWindows ? dirCounts[cmpFullPath] : 0) ||
              (rawDiffersFromNorm ? dirCounts[rawFullPath] : 0) ||
              0;
          }
        } else if (hasMarks) {
          mark =
            marks[normFullPath] ||
            (isWindows ? marks[cmpFullPath] : null) ||
            (rawDiffersFromNorm ? marks[rawFullPath] : null) ||
            null;
        }
      }

      const row = {
        key: path,
        kind: isDir ? "dir" : "file",
        path,
        depth,
        entry,
        open,
        isLoadingFolder,
        isRepo,
        dirCount,
        mark,
      };
      out.push(row);
      byKey.set(path, row);

      if (open) append(path, depth + 1);
    }
  };

  append("", 0);
  return { rows: out, hitVisibleCap, byKey };
}

/**
 * Resolves a single-folder cascade synchronously from an in-memory directory cache.
 * Returns null for invalid input, or { complete, missingPath, stagedEntries, stagedFolders }.
 */
export function resolveCachedCascade({
  startPath,
  maxDepth = MAX_CASCADE_DEPTH,
  getFilterRel,
  getCachedEntries,
}) {
  if (!startPath || !getCachedEntries) return null;

  const stagedEntries = new Map();
  const stagedFolders = [];
  const visited = new Set([startPath]);
  let curPath = startPath;

  for (let depth = 0; depth <= maxDepth; depth++) {
    const entries = getCachedEntries(curPath);
    if (!entries) {
      return {
        complete: false,
        missingPath: curPath,
        stagedEntries,
        stagedFolders,
      };
    }

    stagedEntries.set(curPath, entries);
    stagedFolders.push(curPath);

    if (depth >= maxDepth) break;

    const filterRel = getFilterRel ? getFilterRel() : null;
    const nextChild = getCascadeChildPath(curPath, entries, filterRel);
    if (!nextChild || visited.has(nextChild)) break;

    visited.add(nextChild);
    curPath = nextChild;
  }

  return {
    complete: true,
    missingPath: null,
    stagedEntries,
    stagedFolders,
  };
}

/**
 * Resolve a cascading single-folder chain completely in memory before committing UI state,
 * so all nested single folders visually expand together once loaded.
 * Unreadable nested folders (`depth > 0`) stop cascading gracefully without failing the parent open.
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
  let batchExhausted = false;

  for (let depth = 0; depth <= maxDepth; depth++) {
    if (isCancelled?.()) return null;

    let entries = stagedEntries.has(curPath)
      ? stagedEntries.get(curPath)
      : getCachedEntries?.(curPath);

    if (!entries && fetchCascadeBatch && !batchExhausted) {
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
      if (!entries && depth > 0) {
        // Nested folder failed inside batch cascade (e.g., EACCES); stop cascading cleanly at parent.
        break;
      }
    }

    if (!entries) {
      try {
        entries = await fetchSingleEntries(curPath);
      } catch (err) {
        if (depth === 0) throw err;
        break;
      }
      if (isCancelled?.()) return null;
      stagedEntries.set(curPath, entries);
      if (depth > 0) batchExhausted = true;
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
