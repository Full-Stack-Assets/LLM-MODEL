import OpenAI from 'openai';
import {
  BaseMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { ModelResponse, ToolCall, ToolDefinition } from '../types';

// Use OPENROUTER_MODEL env var to override the default model at deploy time.
const MODEL_NAME =
  process.env.OPENROUTER_MODEL || 'anthropic/claude-opus-4-8';
// Non-streaming request, so keep max_tokens under typical provider limits.
const MAX_TOKENS = 16000;

export class ClaudeService {
  // Constructed lazily so importing this module (and its singleton) is cheap and
  // side-effect-free — letting the startup env-validation run and report a
  // friendly error before any client is built.
  private _client: OpenAI | null = null;

  private get client(): OpenAI {
    if (!this._client) {
      if (!process.env.OPENROUTER_API_KEY) {
        throw new Error('OPENROUTER_API_KEY is not set');
      }
      this._client = new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: 'https://openrouter.ai/api/v1',
      });
    }
    return this._client;
  }

  async generateResponse(
    messages: BaseMessage[],
    tools: ToolDefinition[] = [],
    workingDirectory?: string
  ): Promise<ModelResponse> {
    const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.buildSystemPrompt(workingDirectory) },
      ...this.convertMessages(messages),
    ];

    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: MODEL_NAME,
      max_tokens: MAX_TOKENS,
      messages: chatMessages,
    };

    if (tools.length > 0) {
      params.tools = this.convertTools(tools);
    }

    const response = await this.client.chat.completions.create(params);
    const choice = response.choices[0];
    const msg = choice.message;

    const textParts: { type: 'text'; text: string }[] = [];
    const functionCalls: ModelResponse['function_calls'] = [];

    if (msg.content) {
      textParts.push({ type: 'text', text: msg.content });
    }

    for (const tc of msg.tool_calls ?? []) {
      functionCalls.push({
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments || '{}'),
      });
    }

    return {
      content: textParts,
      function_calls: functionCalls,
      stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    };
  }

  private buildSystemPrompt(workingDirectory?: string): string {
    const cwd = workingDirectory || process.cwd();
    return `You are a proactive AI coding assistant with MCP tool access.

CORE PRINCIPLES:
1. Working Directory: ${cwd}
2. ALWAYS use tools - never fabricate or assume information
3. Use full absolute paths for file operations
4. Execute immediately without asking for confirmation unless genuinely ambiguous

TOOL USAGE RULES:
- To see files: list_directory or list_allowed_directories first
- To read content: read_file or read_multiple_files with full paths
- To create/modify: write_file with full path
- When user says "here" or "current directory", use: ${cwd}

WORKFLOW:
1. Understand the request
2. Use tools to gather needed information
3. Execute the action with tools
4. Report results concisely

EXAMPLES:
User: "list files" -> list_directory("${cwd}")
User: "read package.json" -> read_file("${cwd}/package.json")
User: "create test.js" -> write_file("${cwd}/test.js", <content>)
User: "summarize the project" -> list_directory -> read relevant files -> provide summary

Be direct, use tools proactively, and complete tasks efficiently.`;
  }

  /**
   * Convert LangChain messages to the OpenAI chat completions format.
   *
   * OpenRouter requires every tool message to reference a tool_call that
   * appears earlier in the same request. Because the conversation history is
   * loaded from the database with a row limit, the oldest messages can be
   * truncated mid-pair — leaving a tool message whose tool_call was cut off.
   * We track the tool-call IDs we have emitted and drop any orphaned tool
   * messages to avoid a 400 from the API.
   */
  private convertMessages(
    messages: BaseMessage[]
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    const seenToolCallIds = new Set<string>();

    for (const message of messages) {
      if (message instanceof HumanMessage) {
        result.push({ role: 'user', content: String(message.content) });
      } else if (message instanceof AIMessage) {
        const toolCalls = (message.tool_calls || []) as unknown as ToolCall[];
        const textContent =
          typeof message.content === 'string' ? message.content : '';

        const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: textContent || null,
        };

        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls.map((tc) => {
            seenToolCallIds.add(tc.id);
            return {
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments || '{}',
              },
            };
          });
        }

        result.push(assistantMsg);
      } else if (message instanceof ToolMessage) {
        // Skip results whose originating tool_call was truncated out of history.
        if (!seenToolCallIds.has(message.tool_call_id)) {
          continue;
        }

        result.push({
          role: 'tool',
          tool_call_id: message.tool_call_id,
          content:
            typeof message.content === 'string'
              ? message.content
              : JSON.stringify(message.content),
        });
      }
    }

    return result;
  }

  /**
   * Convert MCP/web-search tool definitions to the OpenAI function-calling format.
   */
  convertTools(tools: ToolDefinition[]): OpenAI.Chat.ChatCompletionTool[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description || 'No description provided',
        parameters:
          tool.inputSchema && tool.inputSchema.type === 'object'
            ? (tool.inputSchema as OpenAI.FunctionParameters)
            : { type: 'object', properties: {} },
      },
    }));
  }
}

export const claudeService = new ClaudeService();
