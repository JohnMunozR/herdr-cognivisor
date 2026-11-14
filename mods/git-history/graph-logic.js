export const LOG_FIELD_SEP = "\x1f";
export const LOG_RECORD_SEP = "\x1e";

const DEFAULT_PALETTE_SIZE = 10;

const KNOWN_REMOTE_PREFIXES = new Set([
  "origin",
  "upstream",
  "remote",
  "fork",
  "github",
  "gitlab",
  "bitbucket",
  "mirror",
]);

/**
 * Parses a `git log --format=%D` decoration string into structured ref badges.
 *
 * @param {string | null | undefined} raw
 * @param {Iterable<string>} [remoteNames]
 * @returns {Array<{ kind: "head" | "local" | "remote" | "tag", label: string, isHeadBranch?: boolean }>}
 */
export function parseDecorations(raw, remoteNames) {
  if (typeof raw !== "string") return [];
  let trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    trimmed = trimmed.slice(1, -1).trim();
    if (!trimmed) return [];
  }

  const remotes = remoteNames ? new Set(remoteNames) : KNOWN_REMOTE_PREFIXES;
  const refs = [];

  for (const part of trimmed.split(",")) {
    const token = part.trim();
    if (!token) continue;

    if (token.startsWith("HEAD -> ")) {
      const target = token.slice("HEAD -> ".length).trim().replace(/^refs\/heads\//, "");
      if (target) {
        refs.push({ kind: "head", label: target, isHeadBranch: true });
      }
      continue;
    }

    if (token === "HEAD") {
      refs.push({ kind: "head", label: "HEAD" });
      continue;
    }

    if (token.startsWith("tag: ")) {
      const tagName = token.slice("tag: ".length).trim().replace(/^refs\/tags\//, "");
      if (tagName) {
        refs.push({ kind: "tag", label: tagName });
      }
      continue;
    }

    if (token.startsWith("refs/tags/")) {
      const tagName = token.slice("refs/tags/".length).trim();
      if (tagName) {
        refs.push({ kind: "tag", label: tagName });
      }
      continue;
    }

    if (token.startsWith("refs/remotes/")) {
      const remoteName = token.slice("refs/remotes/".length).trim();
      if (remoteName) {
        refs.push({ kind: "remote", label: remoteName });
      }
      continue;
    }

    if (token.startsWith("refs/heads/")) {
      const localName = token.slice("refs/heads/".length).trim();
      if (localName) {
        refs.push({ kind: "local", label: localName });
      }
      continue;
    }

    const arrowIdx = token.indexOf(" -> ");
    if (arrowIdx > 0) {
      const lhs = token.slice(0, arrowIdx).trim();
      const slashIdx = lhs.indexOf("/");
      const prefix = slashIdx > 0 ? lhs.slice(0, slashIdx) : "";
      if (remotes.has(prefix) || lhs.endsWith("/HEAD")) {
        refs.push({ kind: "remote", label: lhs });
        continue;
      }
    }

    const slashIdx = token.indexOf("/");
    if (slashIdx > 0) {
      const prefix = token.slice(0, slashIdx);
      const rest = token.slice(slashIdx + 1);
      if (remotes.has(prefix) || rest === "HEAD") {
        refs.push({ kind: "remote", label: token });
        continue;
      }
    }

    refs.push({ kind: "local", label: token });
  }

  return refs;
}

/**
 * Parses `git log` output formatted with LOG_FIELD_SEP (`\x1f`) and LOG_RECORD_SEP (`\x1e`).
 * Expected format: `%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1f%b%x1e`
 *
 * @param {string | null | undefined} stdout
 * @returns {Array<{
 *   hash: string,
 *   shortHash: string,
 *   parents: string[],
 *   author: string,
 *   email: string,
 *   timestamp: number,
 *   refs: Array<{ kind: "head" | "local" | "remote" | "tag", label: string, isHeadBranch?: boolean }>,
 *   subject: string,
 *   body: string
 * }>}
 */
export function parseGitLogOutput(stdout) {
  if (typeof stdout !== "string" || !stdout) return [];

  const commits = [];
  const records = stdout.split(LOG_RECORD_SEP);

  for (const record of records) {
    if (!record || !record.trim()) continue;
    const fields = record.split(LOG_FIELD_SEP);
    const hash = (fields[0] ?? "").trim();
    if (!hash) continue;

    const parentsRaw = (fields[1] ?? "").trim();
    const parents = parentsRaw ? parentsRaw.split(/\s+/).filter(Boolean) : [];
    const author = (fields[2] ?? "").trim();
    const email = (fields[3] ?? "").trim();
    const tsParsed = Number.parseInt((fields[4] ?? "").trim(), 10);
    const timestamp = Number.isFinite(tsParsed) ? tsParsed : 0;
    const refs = parseDecorations(fields[5] ?? "");
    const subject = (fields[6] ?? "").replace(/\r?\n/g, " ").trim();
    const body = fields.length > 7 ? fields.slice(7).join(LOG_FIELD_SEP).trim() : "";

    commits.push({
      hash,
      shortHash: hash.slice(0, 7),
      parents,
      author,
      email,
      timestamp,
      refs,
      subject,
      body,
    });
  }

  return commits;
}

function findLowestFreeLane(activeLanes) {
  for (let i = 0; i < activeLanes.length; i++) {
    if (activeLanes[i] === null) return i;
  }
  return activeLanes.length;
}

function allocateColorIndex(activeLanes, paletteSize, cursorRef) {
  if (paletteSize <= 30) {
    let usedMask = 0;
    for (let i = 0; i < activeLanes.length; i++) {
      const slot = activeLanes[i];
      if (slot !== null) {
        const idx = slot.colorIndex;
        if (idx >= 0 && idx < paletteSize) usedMask |= 1 << idx;
      }
    }
    for (let offset = 0; offset < paletteSize; offset++) {
      const candidate = (cursorRef.value + offset) % paletteSize;
      if ((usedMask & (1 << candidate)) === 0) {
        cursorRef.value = (candidate + 1) % paletteSize;
        return candidate;
      }
    }
  } else {
    const used = new Uint8Array(paletteSize);
    for (let i = 0; i < activeLanes.length; i++) {
      const slot = activeLanes[i];
      if (slot !== null && slot.colorIndex >= 0 && slot.colorIndex < paletteSize) {
        used[slot.colorIndex] = 1;
      }
    }
    for (let offset = 0; offset < paletteSize; offset++) {
      const candidate = (cursorRef.value + offset) % paletteSize;
      if (used[candidate] === 0) {
        cursorRef.value = (candidate + 1) % paletteSize;
        return candidate;
      }
    }
  }

  const fallback = cursorRef.value % paletteSize;
  cursorRef.value = (fallback + 1) % paletteSize;
  return fallback;
}

function trimTrailingNulls(activeLanes) {
  while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === null) {
    activeLanes.pop();
  }
}

/**
 * Computes GitKraken-style topological commit graph lane layout and edge geometry.
 *
 * Continuity invariant:
 * Every active lane slot `l` at the end of row `r` terminates at `(l, yBot)` on row `r`
 * (via `passThroughLanes` or `outgoingEdges`) and enters row `r + 1` at `(l, yTop)`
 * (via `passThroughLanes` or `incomingEdges`) with the exact same `colorIndex`.
 *
 * @param {Array<{ hash: string, parents?: string[] }>} commits
 * @param {{ paletteSize?: number }} [options]
 * @returns {{
 *   rows: Array<{
 *     hash: string,
 *     lane: number,
 *     colorIndex: number,
 *     isMerge: boolean,
 *     isRoot: boolean,
 *     maxLanes: number,
 *     passThroughLanes: Array<{ lane: number, colorIndex: number }>,
 *     incomingEdges: Array<{ fromLane: number, toLane: number, colorIndex: number }>,
 *     outgoingEdges: Array<{ fromLane: number, toLane: number, colorIndex: number }>
 *   }>,
 *   maxLaneCount: number
 * }}
 */
export function computeCommitGraphLayout(commits, options = {}) {
  if (!Array.isArray(commits) || commits.length === 0) {
    return { rows: [], maxLaneCount: 0 };
  }

  const rawPaletteSize = options?.paletteSize;
  const paletteSize =
    typeof rawPaletteSize === "number" && Number.isFinite(rawPaletteSize) && rawPaletteSize >= 1
      ? Math.floor(rawPaletteSize)
      : DEFAULT_PALETTE_SIZE;

  /** @type {Array<{ hash: string, colorIndex: number } | null>} */
  const activeLanes = [];
  const cursorRef = { value: 0 };
  const rows = [];
  let maxLaneCount = 0;

  for (const commit of commits) {
    const hash = commit?.hash ?? "";
    const rawParents = Array.isArray(commit?.parents) ? commit.parents : [];
    const parents = [];
    for (const p of rawParents) {
      if (p && p !== hash && !parents.includes(p)) {
        parents.push(p);
      }
    }

    // 1. Identify all lanes currently expecting this commit.
    const matchingLanes = [];
    for (let l = 0; l < activeLanes.length; l++) {
      if (activeLanes[l] !== null && activeLanes[l].hash === hash) {
        matchingLanes.push(l);
      }
    }

    // 2. Choose commitLane and commitColor.
    let commitLane;
    let commitColor;
    if (matchingLanes.length > 0) {
      commitLane = matchingLanes[0];
      commitColor = activeLanes[commitLane].colorIndex;
    } else {
      commitLane = findLowestFreeLane(activeLanes);
      commitColor = allocateColorIndex(activeLanes, paletteSize, cursorRef);
      if (commitLane === activeLanes.length) {
        activeLanes.push(null);
      }
    }

    // 3. Top half geometry (yTop -> yMid) & pass-through lanes.
    const incomingEdges = [];
    const passThroughLanes = [];

    for (let l = 0; l < activeLanes.length; l++) {
      const slot = activeLanes[l];
      if (slot === null) continue;

      if (l === commitLane) {
        incomingEdges.push({ fromLane: l, toLane: commitLane, colorIndex: commitColor });
      } else if (slot.hash === hash) {
        incomingEdges.push({ fromLane: l, toLane: commitLane, colorIndex: slot.colorIndex });
        activeLanes[l] = null;
      } else {
        passThroughLanes.push({ lane: l, colorIndex: slot.colorIndex });
      }
    }

    // 4. Bottom half geometry (yMid -> yBot) & next activeLanes state.
    const outgoingEdges = [];
    const isRoot = parents.length === 0;
    const isMerge = parents.length > 1;

    if (isRoot) {
      activeLanes[commitLane] = null;
    } else {
      const primaryParent = parents[0];
      const existingP0 = activeLanes.findIndex(
        (slot, idx) => idx !== commitLane && slot !== null && slot.hash === primaryParent,
      );

      if (existingP0 === -1) {
        activeLanes[commitLane] = { hash: primaryParent, colorIndex: commitColor };
        outgoingEdges.push({
          fromLane: commitLane,
          toLane: commitLane,
          colorIndex: commitColor,
        });
      } else {
        outgoingEdges.push({
          fromLane: commitLane,
          toLane: existingP0,
          colorIndex: commitColor,
        });
        activeLanes[commitLane] = null;
      }

      for (let i = 1; i < parents.length; i++) {
        const secondaryParent = parents[i];
        const existingPi = activeLanes.findIndex(
          (slot) => slot !== null && slot.hash === secondaryParent,
        );

        if (existingPi !== -1) {
          outgoingEdges.push({
            fromLane: commitLane,
            toLane: existingPi,
            colorIndex: activeLanes[existingPi].colorIndex,
          });
        } else {
          const forkLane = findLowestFreeLane(activeLanes);
          const forkColor = allocateColorIndex(activeLanes, paletteSize, cursorRef);
          if (forkLane === activeLanes.length) {
            activeLanes.push({ hash: secondaryParent, colorIndex: forkColor });
          } else {
            activeLanes[forkLane] = { hash: secondaryParent, colorIndex: forkColor };
          }
          outgoingEdges.push({
            fromLane: commitLane,
            toLane: forkLane,
            colorIndex: forkColor,
          });
        }
      }
    }

    trimTrailingNulls(activeLanes);

    let maxLaneIdx = commitLane;
    for (const pt of passThroughLanes) {
      if (pt.lane > maxLaneIdx) maxLaneIdx = pt.lane;
    }
    for (const edge of incomingEdges) {
      if (edge.fromLane > maxLaneIdx) maxLaneIdx = edge.fromLane;
      if (edge.toLane > maxLaneIdx) maxLaneIdx = edge.toLane;
    }
    for (const edge of outgoingEdges) {
      if (edge.fromLane > maxLaneIdx) maxLaneIdx = edge.fromLane;
      if (edge.toLane > maxLaneIdx) maxLaneIdx = edge.toLane;
    }

    const maxLanes = maxLaneIdx + 1;
    if (maxLanes > maxLaneCount) {
      maxLaneCount = maxLanes;
    }

    rows.push({
      hash,
      lane: commitLane,
      colorIndex: commitColor,
      isMerge,
      isRoot,
      maxLanes,
      passThroughLanes,
      incomingEdges,
      outgoingEdges,
    });
  }

  return { rows, maxLaneCount };
}

/**
 * Filters parsed commits by case-insensitive substring match against
 * hash, shortHash, subject, author, and refs[].label.
 *
 * @param {Array<{
 *   hash?: string,
 *   shortHash?: string,
 *   subject?: string,
 *   author?: string,
 *   refs?: Array<{ label?: string }>
 * }>} commits
 * @param {string | null | undefined} query
 */
export function filterCommits(commits, query) {
  if (!Array.isArray(commits)) return [];
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!q) return commits;

  return commits.filter((c) => {
    if (!c) return false;
    if (typeof c.hash === "string" && c.hash.toLowerCase().includes(q)) return true;
    if (typeof c.shortHash === "string" && c.shortHash.toLowerCase().includes(q)) return true;
    if (typeof c.subject === "string" && c.subject.toLowerCase().includes(q)) return true;
    if (typeof c.author === "string" && c.author.toLowerCase().includes(q)) return true;
    if (Array.isArray(c.refs)) {
      for (const ref of c.refs) {
        if (typeof ref?.label === "string" && ref.label.toLowerCase().includes(q)) {
          return true;
        }
      }
    }
    return false;
  });
}

/**
 * Formats a Unix timestamp (seconds) into a concise relative string
 * ("just now", "5m ago", "2h ago", "3d ago") or "YYYY-MM-DD" for older dates.
 *
 * @param {number} unixSec
 * @param {number} [nowMs]
 * @returns {string}
 */
export function formatRelativeTime(unixSec, nowMs) {
  if (typeof unixSec !== "number" || !Number.isFinite(unixSec) || unixSec < 0) {
    return "";
  }

  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  const diffSec = Math.floor((now - unixSec * 1000) / 1000);

  if (diffSec < 0) {
    if (diffSec >= -60) return "just now";
    return new Date(unixSec * 1000).toISOString().slice(0, 10);
  }
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)}d ago`;

  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}
