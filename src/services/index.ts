/**
 * Vibe Board - AI Services (Phase 2)
 * Uses vscode.lm API for Copilot-powered features.
 */

import * as vscode from 'vscode';

/**
 * Service interface for AI-powered features.
 */
export interface IAIService {
  generateSummary(tasks: unknown[]): Promise<string>;
  breakdownTask(title: string, description: string): Promise<string[]>;
  rewriteTitle(title: string): Promise<string>;
}

/**
 * CopilotAIService uses the vscode.lm language model API.
 */
export class CopilotAIService implements IAIService {
  private async getModel(): Promise<vscode.LanguageModelChat | null> {
    try {
      // Try specific families first, then fall back to any available model
      const families = ['copilot-gpt-4o', 'gpt-4o', 'gpt-4', 'copilot-gpt-3.5-turbo'];
      for (const family of families) {
        try {
          const models = await vscode.lm.selectChatModels({ family });
          if (models.length > 0) { return models[0]; }
        } catch { /* try next */ }
      }
      // Fallback: request any available chat model
      const allModels = await vscode.lm.selectChatModels();
      if (allModels.length > 0) { return allModels[0]; }
      return null;
    } catch {
      return null;
    }
  }

  async generateSummary(tasks: { title: string; tag: string; status: string }[]): Promise<string> {
    const model = await this.getModel();
    if (!model) { return 'AI features require GitHub Copilot Chat to be installed and signed in.\n\nTo set up:\n1. Install the "GitHub Copilot Chat" extension from the VS Code Marketplace\n2. Sign in with your GitHub account (Copilot subscription required)\n3. Restart VS Code and try again\n\nOnce Copilot Chat is active, Vibe Board will automatically use it for AI summaries, task breakdowns, and tag suggestions.'; }

    const taskList = tasks.map((t) => `- [${t.status}] ${t.title} (${t.tag})`).join('\n');
    const prompt = `Summarize this work session in 2-3 sentences. Be concise and focus on what was accomplished:\n\n${taskList}`;

    try {
      const messages = [vscode.LanguageModelChatMessage.User(prompt)];
      const response = await model.sendRequest(messages, {});
      let result = '';
      for await (const chunk of response.text) {
        result += chunk;
      }
      return result.trim();
    } catch {
      return 'AI summary failed — model request error.';
    }
  }

  async breakdownTask(title: string, description: string): Promise<string[]> {
    const model = await this.getModel();
    if (!model) { return []; }

    const prompt = `Break this task into 3-5 actionable subtasks. Return ONLY a numbered list, nothing else.\n\nTask: ${title}\nDescription: ${description}`;

    try {
      const messages = [vscode.LanguageModelChatMessage.User(prompt)];
      const response = await model.sendRequest(messages, {});
      let result = '';
      for await (const chunk of response.text) {
        result += chunk;
      }
      return result
        .split('\n')
        .map((l) => l.replace(/^\d+\.\s*/, '').trim())
        .filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  async rewriteTitle(title: string): Promise<string> {
    const model = await this.getModel();
    if (!model) { return title; }

    const prompt = `Rewrite this task title to be clearer, more concise, and more actionable. Return ONLY the improved title text, nothing else. Do not add quotes.\n\nOriginal: ${title}`;

    try {
      const messages = [vscode.LanguageModelChatMessage.User(prompt)];
      const response = await model.sendRequest(messages, {});
      let result = '';
      for await (const chunk of response.text) {
        result += chunk;
      }
      const cleaned = result.trim().replace(/^["']|["']$/g, '');
      return cleaned || title;
    } catch {
      return title;
    }
  }
}
