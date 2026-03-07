/**
 * Build Board - Git Utilities
 * Provides git diff and change detection for the automation feature.
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
