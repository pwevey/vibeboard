/**
 * Build Board - Git Utilities
 * Provides git diff, change detection, and branch management for the automation feature.
 */

import { spawn } from 'child_process';

/**
 * Run a git command in the given working directory and return stdout.
 */
function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, shell: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      if (code === 0) { resolve(stdout.trim()); }
      else { reject(new Error(`git ${args.join(' ')} failed (code ${code}): ${stderr}`)); }
    });
    proc.on('error', (err) => { reject(err); });
  });
}

// ── Branch Management ──────────────────────────────────────────

/**
 * Get the name of the currently checked-out branch.
 */
export async function getCurrentBranch(cwd: string): Promise<string> {
  return runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

/**
 * Check whether a local branch exists.
 */
export async function branchExists(cwd: string, name: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', name], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a new branch and check it out. If the branch already exists, just check it out.
 */
export async function createAndCheckoutBranch(cwd: string, name: string): Promise<void> {
  const exists = await branchExists(cwd, name);
  if (exists) {
    await runGit(['checkout', name], cwd);
  } else {
    await runGit(['checkout', '-b', name], cwd);
  }
}

/**
 * Switch to an existing branch.
 */
export async function checkoutBranch(cwd: string, name: string): Promise<void> {
  await runGit(['checkout', name], cwd);
}

/**
 * Merge the given branch into the current branch (fast-forward if possible).
 */
export async function mergeBranch(cwd: string, branchName: string): Promise<void> {
  await runGit(['merge', branchName, '--no-edit'], cwd);
}

/**
 * Delete a local branch. Uses -D (force) so it works even if unmerged.
 */
export async function deleteBranch(cwd: string, name: string): Promise<void> {
  try {
    await runGit(['branch', '-D', name], cwd);
  } catch {
    // Branch may not exist — ignore deletion errors
  }
}

/**
 * Stash uncommitted changes (if any).
 * Returns true if a stash was created, false if there was nothing to stash.
 */
export async function stashChanges(cwd: string): Promise<boolean> {
  const dirty = await hasUncommittedChanges(cwd);
  if (!dirty) { return false; }
  await runGit(['stash', 'push', '-m', 'buildboard-automation'], cwd);
  return true;
}

/**
 * Pop the most recent stash entry.
 */
export async function stashPop(cwd: string): Promise<void> {
  try {
    await runGit(['stash', 'pop'], cwd);
  } catch {
    // Nothing to pop — ignore
  }
}

/**
 * Commit all current changes with the given message.
 * Stages everything first (`git add -A`).
 */
export async function commitAll(cwd: string, message: string): Promise<void> {
  await runGit(['add', '-A'], cwd);
  await runGit(['commit', '-m', message, '--allow-empty'], cwd);
}

/**
 * Generate a git-safe branch name from a task tag and title.
 * Example: slugifyForBranch('feature', 'Add dark mode') → 'buildboard/feature/add-dark-mode'
 */
export function slugifyForBranch(tag: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // replace non-alphanumeric runs with hyphens
    .replace(/^-+|-+$/g, '')        // trim leading/trailing hyphens
    .substring(0, 50);              // cap length
  return `buildboard/${tag}/${slug}`;
}

/**
 * Get the unified diff of all uncommitted changes (staged + unstaged).
 */
export async function getGitDiff(cwd: string): Promise<string> {
  try {
    // Unstaged changes
    const unstaged = await runGit(['diff'], cwd);
    // Staged changes
    const staged = await runGit(['diff', '--cached'], cwd);
    const parts = [unstaged, staged].filter(Boolean);
    return parts.join('\n');
  } catch {
    return '';
  }
}

/**
 * Get a list of changed file paths (modified, added, deleted).
 */
export async function getChangedFiles(cwd: string): Promise<string[]> {
  try {
    const result = await runGit(['status', '--porcelain'], cwd);
    if (!result) { return []; }
    return result
      .split('\n')
      .filter(Boolean)
      .map((line) => line.substring(3).trim());
  } catch {
    return [];
  }
}

/**
 * Check if there are any uncommitted changes.
 */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  try {
    const result = await runGit(['status', '--porcelain'], cwd);
    return result.length > 0;
  } catch {
    return false;
  }
}

/**
 * Get a short diff stat summary (e.g., "3 files changed, 12 insertions, 5 deletions").
 */
export async function getDiffStat(cwd: string): Promise<string> {
  try {
    const stat = await runGit(['diff', '--stat'], cwd);
    const cachedStat = await runGit(['diff', '--cached', '--stat'], cwd);
    const parts = [stat, cachedStat].filter(Boolean);
    return parts.join('\n') || 'No changes detected';
  } catch {
    return 'Git not available';
  }
}
