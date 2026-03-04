/**
 * Vibe Board - Secure Credential Storage
 *
 * Uses VS Code's SecretStorage API — backed by the OS keychain
 * (Windows Credential Manager / macOS Keychain / Linux Secret Service).
 * Sensitive Jira credentials (email, API token) are stored here
 * instead of plain text in settings.json.
 */

import * as vscode from 'vscode';

const KEY_JIRA_EMAIL = 'vibeboard.jira.email';
const KEY_JIRA_TOKEN = 'vibeboard.jira.apiToken';

export interface JiraCredentials {
  baseUrl: string;
  email: string;
  token: string;
}

export class SecretStorageService {
  constructor(private secrets: vscode.SecretStorage) {}

  /**
   * Store Jira credentials.
   * - baseUrl is saved in VS Code settings (not sensitive).
   * - email and apiToken are encrypted via OS keychain.
   * - If email or token is an empty string, the existing stored value is kept.
   */
  async saveJiraCredentials(baseUrl: string, email: string, token: string): Promise<void> {
    // Base URL goes to settings (not a secret)
    await vscode.workspace.getConfiguration('vibeboard')
      .update('jiraBaseUrl', baseUrl, vscode.ConfigurationTarget.Global);

    // Sensitive fields go to SecretStorage (empty = keep existing)
    if (email) {
      await this.secrets.store(KEY_JIRA_EMAIL, email);
    }
    if (token) {
      await this.secrets.store(KEY_JIRA_TOKEN, token);
    }
  }

  /**
   * Retrieve full Jira credentials.
   * Returns null if any required field is missing.
   */
  async getJiraCredentials(): Promise<JiraCredentials | null> {
    const config = vscode.workspace.getConfiguration('vibeboard');
    const baseUrl = (config.get<string>('jiraBaseUrl') || '').replace(/\/+$/, '');
    const email = (await this.secrets.get(KEY_JIRA_EMAIL)) || '';
    const token = (await this.secrets.get(KEY_JIRA_TOKEN)) || '';

    if (!baseUrl || !email || !token) {
      return null;
    }
    return { baseUrl, email, token };
  }

  /**
   * Check whether all Jira credentials are configured.
   */
  async isJiraConfigured(): Promise<boolean> {
    const creds = await this.getJiraCredentials();
    return creds !== null;
  }

  /**
   * Get a safe summary for the webview (no secrets exposed).
   * Returns email (for display) and token length (for mask rendering).
   */
  async getJiraSummary(): Promise<{
    email: string;
    tokenLength: number;
    configured: boolean;
  }> {
    const config = vscode.workspace.getConfiguration('vibeboard');
    const baseUrl = (config.get<string>('jiraBaseUrl') || '').trim();
    const email = (await this.secrets.get(KEY_JIRA_EMAIL)) || '';
    const token = (await this.secrets.get(KEY_JIRA_TOKEN)) || '';

    return {
      email,
      tokenLength: token.length,
      configured: !!(baseUrl && email && token),
    };
  }

  /**
   * Delete stored Jira credentials from the keychain.
   */
  async clearJiraCredentials(): Promise<void> {
    await this.secrets.delete(KEY_JIRA_EMAIL);
    await this.secrets.delete(KEY_JIRA_TOKEN);
    await vscode.workspace.getConfiguration('vibeboard')
      .update('jiraBaseUrl', '', vscode.ConfigurationTarget.Global);
  }

  /**
   * Migrate credentials from plain-text settings to SecretStorage.
   * Called once on activation. Clears the plain-text values after migration.
   */
  async migrateFromSettings(): Promise<void> {
    const config = vscode.workspace.getConfiguration('vibeboard');
    const plainEmail = config.get<string>('jiraEmail', '');
    const plainToken = config.get<string>('jiraApiToken', '');

    let migrated = false;

    if (plainEmail) {
      // Only migrate if SecretStorage doesn't already have a value
      const existing = await this.secrets.get(KEY_JIRA_EMAIL);
      if (!existing) {
        await this.secrets.store(KEY_JIRA_EMAIL, plainEmail);
      }
      // Clear from plain-text settings
      await config.update('jiraEmail', undefined, vscode.ConfigurationTarget.Global);
      migrated = true;
    }

    if (plainToken) {
      const existing = await this.secrets.get(KEY_JIRA_TOKEN);
      if (!existing) {
        await this.secrets.store(KEY_JIRA_TOKEN, plainToken);
      }
      // Clear from plain-text settings
      await config.update('jiraApiToken', undefined, vscode.ConfigurationTarget.Global);
      migrated = true;
    }

    if (migrated) {
      console.log('[VB] Migrated Jira credentials from settings.json to secure storage.');
    }
  }
}
