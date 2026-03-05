/**
 * Vibe Board - Jira Integration Service
 * Creates Jira issues from Vibe Board tasks via REST API v3.
 * Credentials are retrieved from SecretStorageService (OS keychain).
 */

import * as vscode from 'vscode';
import { VBTask, JiraProject, JiraCreatedIssue, JiraStatus } from '../storage/models';
import { SecretStorageService, JiraCredentials } from './SecretStorageService';

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

/** Timeout in milliseconds for all Jira API requests. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Categorize an HTTP error status into a user-friendly message.
 * Specifically calls out expired / invalid tokens for 401.
 */
function describeHttpError(status: number, bodyText: string): string {
  switch (status) {
    case 401:
      return 'Authentication failed — your API token may have expired or is invalid. Generate a new token at id.atlassian.com.';
    case 403:
      return 'Permission denied — your API token does not have the required access. Check your Atlassian permissions.';
    case 404:
      return 'Not found — verify your Jira Base URL is correct (e.g. https://your-domain.atlassian.net).';
    default:
      if (status >= 500) {
        return `Jira server error (HTTP ${status}) — the Jira instance may be temporarily unavailable. Try again later.`;
      }
      return `HTTP ${status}: ${bodyText.slice(0, 200)}`;
  }
}

/**
 * Describe a network-level error with user-friendly guidance.
 */
function describeNetworkError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return 'Request timed out — the Jira server did not respond within 15 seconds. Check your Base URL and network connection.';
    }
    const msg = err.message.toLowerCase();
    if (msg.includes('enotfound') || msg.includes('getaddrinfo')) {
      return 'Could not resolve the Jira hostname — verify your Base URL is correct.';
    }
    if (msg.includes('econnrefused')) {
      return 'Connection refused — the Jira server is not accepting connections. Check your Base URL.';
    }
    if (msg.includes('certificate') || msg.includes('ssl') || msg.includes('tls')) {
      return 'SSL/TLS error — there is a certificate problem connecting to Jira. Contact your administrator.';
    }
    return `Network error: ${err.message}`;
  }
  return `Network error: ${String(err)}`;
}

export class JiraService {
  constructor(private secretStorage: SecretStorageService) {}

  /**
   * Read Jira credentials from secure storage.
   * Returns null with an error message if any are missing.
   */
  private async getConfig(): Promise<JiraCredentials | null> {
    const creds = await this.secretStorage.getJiraCredentials();
    if (!creds) {
      const summary = await this.secretStorage.getJiraSummary();
      const missing: string[] = [];
      const config = vscode.workspace.getConfiguration('vibeboard');
      const baseUrl = (config.get<string>('jiraBaseUrl') || '').trim();
      if (!baseUrl) { missing.push('Base URL'); }
      if (!summary.email) { missing.push('Email'); }
      if (summary.tokenLength === 0) { missing.push('API Token'); }
      vscode.window.showErrorMessage(
        `Vibe Board: Jira credentials incomplete — missing: ${missing.join(', ')}. Configure them in the Settings dialog.`
      );
      return null;
    }
    return creds;
  }

  /** Build Basic auth header value. */
  private authHeader(email: string, token: string): string {
    return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  }

  /**
   * Test the Jira connection by calling GET /rest/api/3/myself.
   * Returns a success boolean and user display name, or error message.
   */
  async testConnection(): Promise<{ success: boolean; displayName?: string; error?: string }> {
    const cfg = await this.getConfig();
    if (!cfg) { return { success: false, error: 'Jira credentials not configured.' }; }

    try {
      const response = await fetch(`${cfg.baseUrl}/rest/api/3/myself`, {
        method: 'GET',
        headers: {
          'Authorization': this.authHeader(cfg.email, cfg.token),
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: describeHttpError(response.status, text) };
      }

      const body = await response.json() as { displayName?: string; emailAddress?: string };
      return { success: true, displayName: body.displayName || body.emailAddress || 'Unknown user' };
    } catch (err: unknown) {
      return { success: false, error: describeNetworkError(err) };
    }
  }

  /**
   * Fetch available Jira projects.
   */
  async getProjects(): Promise<{ projects: JiraProject[]; error?: string }> {
    const cfg = await this.getConfig();
    if (!cfg) { return { projects: [], error: 'Jira credentials not configured.' }; }

    try {
      const response = await fetch(`${cfg.baseUrl}/rest/api/3/project/search?maxResults=100&orderBy=name`, {
        method: 'GET',
        headers: {
          'Authorization': this.authHeader(cfg.email, cfg.token),
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text();
        return { projects: [], error: describeHttpError(response.status, text) };
      }

      const body = await response.json() as { values: { id: string; key: string; name: string }[] };
      const projects: JiraProject[] = body.values.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
      }));
      return { projects };
    } catch (err: unknown) {
      return { projects: [], error: describeNetworkError(err) };
    }
  }

  /**
   * Fetch available statuses for a Jira project.
   * Returns a de-duplicated list of status names used by the project's issue types.
   */
  async getStatuses(projectKey: string): Promise<{ statuses: JiraStatus[]; error?: string }> {
    const cfg = await this.getConfig();
    if (!cfg) { return { statuses: [], error: 'Jira credentials not configured.' }; }

    try {
      const response = await fetch(`${cfg.baseUrl}/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`, {
        method: 'GET',
        headers: {
          'Authorization': this.authHeader(cfg.email, cfg.token),
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text();
        if (response.status === 404) {
          return { statuses: [], error: `Project "${projectKey}" not found.` };
        }
        return { statuses: [], error: describeHttpError(response.status, text) };
      }

      // Response is an array of issue types, each with a "statuses" array
      const body = await response.json() as { name: string; statuses: { id: string; name: string }[] }[];
      const seen = new Set<string>();
      const statuses: JiraStatus[] = [];
      for (const issueType of body) {
        for (const s of issueType.statuses) {
          if (!seen.has(s.id)) {
            seen.add(s.id);
            statuses.push({ id: s.id, name: s.name });
          }
        }
      }
      // Sort alphabetically for a nice picker
      statuses.sort((a, b) => a.name.localeCompare(b.name));
      return { statuses };
    } catch (err: unknown) {
      return { statuses: [], error: describeNetworkError(err) };
    }
  }

  /**
   * Transition a Jira issue to a target status by name.
   * Fetches available transitions, finds one whose "to" status name matches,
   * and executes it. Returns true on success.
   */
  async transitionIssue(
    issueKey: string,
    targetStatusName: string
  ): Promise<{ success: boolean; error?: string }> {
    const cfg = await this.getConfig();
    if (!cfg) { return { success: false, error: 'Jira credentials not configured.' }; }

    try {
      // Get available transitions
      const trRes = await fetch(`${cfg.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
        method: 'GET',
        headers: {
          'Authorization': this.authHeader(cfg.email, cfg.token),
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!trRes.ok) {
        const trText = await trRes.text();
        return { success: false, error: `Failed to get transitions: ${describeHttpError(trRes.status, trText)}` };
      }

      const trBody = await trRes.json() as {
        transitions: { id: string; name: string; to: { name: string } }[];
      };

      const target = targetStatusName.toLowerCase();
      const match = trBody.transitions.find((t) => t.to.name.toLowerCase() === target);
      if (!match) {
        // Issue may already be in the target status, or no valid transition path
        return { success: false, error: `No transition to "${targetStatusName}" available from current status.` };
      }

      // Execute the transition
      const execRes = await fetch(`${cfg.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
        method: 'POST',
        headers: {
          'Authorization': this.authHeader(cfg.email, cfg.token),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ transition: { id: match.id } }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!execRes.ok) {
        const text = await execRes.text();
        return { success: false, error: `Transition failed: ${describeHttpError(execRes.status, text)}` };
      }

      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: describeNetworkError(err) };
    }
  }

  /**
   * Create Jira issues from an array of VB tasks.
   * If statusMapping is provided, transitions each created issue to the mapped Jira status.
   * Returns results for each task (success or failure).
   */
  async createIssues(
    tasks: VBTask[],
    projectKey: string,
    issueType: string = 'Task',
    onProgress?: (done: number, total: number) => void,
    statusMapping?: Record<string, string>
  ): Promise<{ created: JiraCreatedIssue[]; errors: string[] }> {
    const cfg = await this.getConfig();
    if (!cfg) { return { created: [], errors: ['Jira credentials not configured.'] }; }

    const created: JiraCreatedIssue[] = [];
    const errors: string[] = [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      try {
        const result = await this.createSingleIssue(cfg, task, projectKey, issueType);
        created.push(result);

        // Transition to mapped status if specified
        if (statusMapping && statusMapping[task.status]) {
          const targetStatus = statusMapping[task.status];
          const trResult = await this.transitionIssue(result.issueKey, targetStatus);
          if (!trResult.success) {
            errors.push(`"${task.title}": created as ${result.issueKey} but transition to "${targetStatus}" failed — ${trResult.error}`);
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`"${task.title}": ${msg}`);

        // If authentication failed, abort remaining tasks — they will all fail the same way
        if (msg.includes('Authentication failed') || msg.includes('timed out')) {
          const remaining = tasks.length - i - 1;
          if (remaining > 0) {
            errors.push(`Skipped ${remaining} remaining task${remaining === 1 ? '' : 's'} due to the error above.`);
          }
          onProgress?.(tasks.length, tasks.length);
          break;
        }
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
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      // For 401, throw with the clear expired-token message
      if (response.status === 401) {
        throw new Error(describeHttpError(401, ''));
      }
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
      if (response.status >= 500) {
        throw new Error(describeHttpError(response.status, detail));
      }
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }

    const result = await response.json() as { key: string; self: string };
    return {
      taskId: task.id,
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
