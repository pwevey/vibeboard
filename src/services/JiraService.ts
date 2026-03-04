/**
 * Vibe Board - Jira Integration Service
 * Creates Jira issues from Vibe Board tasks via REST API v3.
 */

import * as vscode from 'vscode';
import { VBTask, JiraProject, JiraCreatedIssue } from '../storage/models';

/** Jira REST API v3 priority mapping. */
const PRIORITY_MAP: Record<string, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** Maps VB task status to a human-readable label for the Jira description. */
const STATUS_LABEL: Record<string, string> = {
  'in-progress': 'In Progress',
  'up-next': 'Up Next',
  'backlog': 'Backlog',
  'completed': 'Completed',
  'notes': 'Notes',
};

export class JiraService {
  /**
   * Read Jira credentials from VS Code settings.
   * Returns null with an error message if any are missing.
   */
  private getConfig(): { baseUrl: string; email: string; token: string } | null {
    const config = vscode.workspace.getConfiguration('vibeboard');
    const baseUrl = (config.get<string>('jiraBaseUrl') || '').replace(/\/+$/, '');
    const email = config.get<string>('jiraEmail') || '';
    const token = config.get<string>('jiraApiToken') || '';

    if (!baseUrl || !email || !token) {
      const missing: string[] = [];
      if (!baseUrl) { missing.push('Base URL'); }
      if (!email) { missing.push('Email'); }
      if (!token) { missing.push('API Token'); }
      vscode.window.showErrorMessage(
        `Vibe Board: Jira credentials incomplete — missing: ${missing.join(', ')}. Configure them in Settings → Vibe Board.`
      );
      return null;
    }
    return { baseUrl, email, token };
  }

  /** Build Basic auth header value. */
  private authHeader(email: string, token: string): string {
    return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  }

  /**
   * Fetch available Jira projects.
   */
  async getProjects(): Promise<{ projects: JiraProject[]; error?: string }> {
    const cfg = this.getConfig();
    if (!cfg) { return { projects: [], error: 'Jira credentials not configured.' }; }

    try {
      const response = await fetch(`${cfg.baseUrl}/rest/api/3/project/search?maxResults=100&orderBy=name`, {
        method: 'GET',
        headers: {
          'Authorization': this.authHeader(cfg.email, cfg.token),
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        const text = await response.text();
        const detail = response.status === 401 ? 'Invalid credentials — check your email and API token.'
          : response.status === 403 ? 'Permission denied — ensure your token has project read access.'
          : `HTTP ${response.status}: ${text.slice(0, 200)}`;
        return { projects: [], error: detail };
      }

      const body = await response.json() as { values: { id: string; key: string; name: string }[] };
      const projects: JiraProject[] = body.values.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
      }));
      return { projects };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { projects: [], error: `Network error: ${msg}` };
    }
  }

  /**
   * Create Jira issues from an array of VB tasks.
   * Returns results for each task (success or failure).
   */
  async createIssues(
    tasks: VBTask[],
    projectKey: string,
    issueType: string = 'Task',
    onProgress?: (done: number, total: number) => void
  ): Promise<{ created: JiraCreatedIssue[]; errors: string[] }> {
    const cfg = this.getConfig();
    if (!cfg) { return { created: [], errors: ['Jira credentials not configured.'] }; }

    const created: JiraCreatedIssue[] = [];
    const errors: string[] = [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      try {
        const result = await this.createSingleIssue(cfg, task, projectKey, issueType);
        created.push(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`"${task.title}": ${msg}`);
      }
      onProgress?.(i + 1, tasks.length);
    }

    return { created, errors };
  }

  /**
   * Create a single Jira issue from a VB task.
   */
  private async createSingleIssue(
    cfg: { baseUrl: string; email: string; token: string },
    task: VBTask,
    projectKey: string,
    issueType: string
  ): Promise<JiraCreatedIssue> {
    // Build description in ADF (Atlassian Document Format)
    const descParagraphs: object[] = [];

    // Task description (main content)
    if (task.description) {
      descParagraphs.push({
        type: 'paragraph',
        content: [{ type: 'text', text: task.description }],
      });
    }

    // Metadata block
    const metaLines = [
      `Tag: ${task.tag}`,
      `Priority: ${task.priority}`,
      `Status: ${STATUS_LABEL[task.status] || task.status}`,
    ];
    if (task.timeSpentMs > 0) {
      metaLines.push(`Time spent: ${this.formatDuration(task.timeSpentMs)}`);
    }
    if (task.completedAt) {
      metaLines.push(`Completed: ${new Date(task.completedAt).toLocaleDateString()}`);
    }

    descParagraphs.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: '— Exported from Vibe Board —\n' + metaLines.join('\n'), marks: [{ type: 'em' }] },
      ],
    });

    const body = {
      fields: {
        project: { key: projectKey },
        summary: task.title.slice(0, 255), // Jira summary max 255 chars
        issuetype: { name: issueType },
        description: {
          type: 'doc',
          version: 1,
          content: descParagraphs,
        },
        labels: [task.tag],
        priority: { name: PRIORITY_MAP[task.priority] || 'Medium' },
      },
    };

    const response = await fetch(`${cfg.baseUrl}/rest/api/3/issue`, {
      method: 'POST',
      headers: {
        'Authorization': this.authHeader(cfg.email, cfg.token),
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      let detail: string;
      try {
        const errObj = JSON.parse(text);
        detail = errObj.errors
          ? Object.values(errObj.errors).join('; ')
          : errObj.errorMessages?.join('; ') || text.slice(0, 300);
      } catch {
        detail = text.slice(0, 300);
      }
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }

    const result = await response.json() as { key: string; self: string };
    return {
      taskTitle: task.title,
      issueKey: result.key,
      issueUrl: `${cfg.baseUrl}/browse/${result.key}`,
    };
  }

  /** Format milliseconds to human-readable duration. */
  private formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (hours > 0) { return `${hours}h ${minutes}m`; }
    return `${minutes}m`;
  }
}
