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
  rewriteTask(input: string): Promise<{ title: string; description: string; tag: string; priority: string; status: string }>;
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

  async rewriteTask(input: string): Promise<{ title: string; description: string; tag: string; priority: string; status: string }> {
    const fallback = { title: input, description: '', tag: 'note', priority: 'medium', status: 'up-next' };
    const model = await this.getModel();
    if (!model) { return fallback; }

    const prompt = `You are a task classifier and formatter for a Kanban board.

Given the user's raw input, do the following:

1. CLASSIFY the input into exactly one category: bug, feature, refactor, or note.
2. Based on the category, FORMAT the task using the exact template below.
3. Write a clear, concise title with the appropriate prefix.
4. Fill in the template description sections using information from the user's input. Be specific and actionable.

Classification guidance:
- "feature" = any actionable work: building, testing, validating, implementing, investigating, spiking, researching, writing, creating, setting up, configuring, adding, integrating, or exploring something. When in doubt between feature and note, choose feature.
- "bug" = something is broken, wrong, or not working as expected.
- "refactor" = restructuring, cleaning up, or improving existing code without changing behavior.
- "note" = ONLY for passive information, reminders, ideas with no immediate action, or reference material. Do NOT classify actionable tasks as notes.

Templates by category:

bug:
  Title prefix: "Bug: "
  Priority: high
  Column: up-next
  Description format:
    Steps to reproduce:
    1. [step]

    Expected:
    [what should happen]

    Actual:
    [what actually happens]

feature:
  Title prefix: "Spike: "
  Priority: medium
  Column: up-next
  Description format:
    Goal:
    [what we want to achieve]

    Approach:
    [how to do it]

    Questions:
    [open questions]

refactor:
  Title prefix: "Refactor: "
  Priority: medium
  Column: backlog
  Description format:
    Current state:
    [how it works now]

    Desired state:
    [how it should work]

    Risks:
    [potential issues]

note:
  Title prefix: ""
  Priority: low
  Column: notes
  Description format:
    [clear note text]

Respond in EXACTLY this format (sections separated by ===):
CATEGORY
===
TITLE WITH PREFIX
===
DESCRIPTION

User input: ${input}`;

    try {
      const messages = [vscode.LanguageModelChatMessage.User(prompt)];
      const response = await model.sendRequest(messages, {});
      let result = '';
      for await (const chunk of response.text) {
        result += chunk;
      }

      const parts = result.split('===');
      if (parts.length >= 3) {
        // Strip markdown formatting (backticks, asterisks, etc.) from the category
        const rawTag = parts[0].trim().toLowerCase().replace(/[`*_#\r\n]/g, '').trim();
        const title = parts[1].trim().replace(/^["']|["']$/g, '').replace(/[`*]/g, '');
        const description = parts.slice(2).join('===').trim().replace(/^```[\s\S]*?```$/gm, '').trim();

        // Infer tag from title prefix — this is the most reliable signal
        // because the model formats the title correctly even when it misclassifies
        const lowerTitle = title.toLowerCase();
        let tag = '';
        if (lowerTitle.startsWith('bug:')) { tag = 'bug'; }
        else if (lowerTitle.startsWith('spike:')) { tag = 'feature'; }
        else if (lowerTitle.startsWith('refactor:')) { tag = 'refactor'; }

        // Fall back to the model's explicit category if title prefix didn't match
        if (!tag) {
          const validTags = ['bug', 'feature', 'refactor', 'note'];
          tag = validTags.includes(rawTag) ? rawTag : '';
          if (!tag) {
            for (const vt of validTags) {
              if (rawTag.includes(vt)) { tag = vt; break; }
            }
          }
        }

        // Also check description structure as another signal
        if (!tag) {
          const lowerDesc = description.toLowerCase();
          if (lowerDesc.includes('steps to reproduce') || lowerDesc.includes('expected:') || lowerDesc.includes('actual:')) { tag = 'bug'; }
          else if (lowerDesc.includes('goal:') || lowerDesc.includes('approach:')) { tag = 'feature'; }
          else if (lowerDesc.includes('current state:') || lowerDesc.includes('desired state:')) { tag = 'refactor'; }
          else { tag = 'note'; }
        }
        if (!tag) { tag = 'note'; }

        const tagDefaults: Record<string, { priority: string; status: string }> = {
          bug: { priority: 'high', status: 'up-next' },
          feature: { priority: 'medium', status: 'up-next' },
          refactor: { priority: 'medium', status: 'backlog' },
          note: { priority: 'low', status: 'notes' },
        };
        const defaults = tagDefaults[tag] || tagDefaults['note'];

        return { title: title || input, description, tag, priority: defaults.priority, status: defaults.status };
      }
      return fallback;
    } catch {
      return fallback;
    }
  }
}
