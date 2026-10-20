/**
 * EZE-496: change evidence for the Done Gate.
 *
 * The Done Gate used to know only the paths the Parent and the Worker reported in
 * this session. A change made with bash or git, or in an earlier session, was never
 * seen, so a ticket with real changes could complete. This module asks Git what
 * actually differs from a baseline commit, so the gate can tell "no changes" apart
 * from "changes it cannot see".
 *
 * Every call is read-only: `git` runs without a shell, with a timeout, and with
 * optional locks off, so it never writes to the repository. Any failure is reported
 * as an unknown answer, never as an empty one.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/** One git call. A hung repository fails closed instead of stalling the Parent. */
const GIT_TIMEOUT_MS = 20_000;
/** Room for the binary diff of a large working tree. */
const GIT_MAX_BUFFER = 512 * 1024 * 1024;
/** The empty tree is the baseline of a repository that has no commit yet. */
const EMPTY_TREE_SOURCE = "/dev/null";

export type BaselineResult = { ok: true; head: string } | { ok: false; reason: string };

export type ChangeSet =
  | { known: true; paths: string[]; fingerprint: string }
  | { known: false; reason: string };

function runGit(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

function runGitText(cwd: string, args: string[]): string {
  return runGit(cwd, args).toString("utf8").trim();
}

function splitNul(output: Buffer): string[] {
  return output.toString("utf8").split("\0").filter((entry) => entry.length > 0);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The commit the ticket's changes are measured from: HEAD, or the empty tree when
 * the repository has no commit yet. Fails when `cwd` is not a Git work tree.
 */
export function captureBaseline(cwd: string): BaselineResult {
  try {
    const inside = runGitText(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") {
      return { ok: false, reason: "the working directory is not inside a Git work tree" };
    }
  } catch (error) {
    return { ok: false, reason: `Git is unavailable or the directory is not a repository (${describeError(error)})` };
  }

  try {
    const head = runGitText(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (head) return { ok: true, head };
  } catch {
    // An unborn branch has no HEAD yet: the work is measured from the empty tree below.
  }

  try {
    const emptyTree = runGitText(cwd, ["hash-object", "-t", "tree", "--", EMPTY_TREE_SOURCE]);
    if (emptyTree) return { ok: true, head: emptyTree };
    return { ok: false, reason: "Git returned no baseline object" };
  } catch (error) {
    return { ok: false, reason: `Git could not name the empty tree (${describeError(error)})` };
  }
}

/**
 * Everything that differs from `baseline`: tracked changes in the index, in the
 * working tree and in commits made after the baseline (deletions included), plus
 * the files Git does not track yet. The fingerprint covers the content of all of
 * them, so an edit made after a PASS changes it, while a commit of the same content
 * does not.
 */
export function collectChanges(cwd: string, baseline: string): ChangeSet {
  try {
    // Every command runs from the top of the work tree, so all paths share one base.
    const root = runGitText(cwd, ["rev-parse", "--show-toplevel"]);
    const tracked = splitNul(runGit(root, ["diff", "--name-only", "--no-renames", "-z", baseline]));
    const untracked = splitNul(runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"])).sort();
    const paths = [...new Set([...tracked, ...untracked])].sort();

    const hash = createHash("sha256");
    hash.update(runGit(root, ["diff", "--binary", "--no-renames", "--no-ext-diff", "--no-textconv", baseline]));
    for (const path of untracked) {
      hash.update(`\0untracked ${path}\0`);
      hash.update(runGit(root, ["hash-object", "--", path]));
    }
    return { known: true, paths, fingerprint: hash.digest("hex") };
  } catch (error) {
    return { known: false, reason: `Git could not describe the working tree (${describeError(error)})` };
  }
}
