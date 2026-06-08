import {
  GoogleGenerativeAI,
  GenerativeModel,
  HarmCategory,
  HarmBlockThreshold,
} from '@google/generative-ai';
import {
  BaseMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { JsonSchema, ModelResponse, ToolCall, ToolDefinition } from '../types';

const MODEL_NAME = 'gemini-2.5-flash';

const SAFETY_SETTINGS = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
];

export class GeminiService {
  private client: GoogleGenerativeAI;
  private model: GenerativeModel;
  // Cache of models keyed by the set of tool names so we don't re-instantiate
  // a model on every single request.
  private modelCache: Map<string, GenerativeModel> = new Map();

  constructor() {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not set');
    }
    this.client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.model = this.client.getGenerativeModel({
      model: MODEL_NAME,
      safetySettings: SAFETY_SETTINGS,
    });
  }

  async generateResponse(
    messages: BaseMessage[],
    tools: ToolDefinition[] = [],
    workingDirectory?: string
  ): Promise<ModelResponse> {
    // Convert LangChain messages to Gemini format
    const geminiMessages = this.convertMessagesToGemini(messages);

    // Pick (and cache) a model configured with the requested tools
    const modelToUse = this.getModelForTools(tools);

    // Start chat session
    const chat = modelToUse.startChat({
      history: geminiMessages.slice(0, -1), // All messages except the last one
      systemInstruction: {
        role: 'system',
        parts: [{ text: this.buildSystemPrompt(workingDirectory) }],
      },
    });

    // Send the last message
    const lastMessage = geminiMessages[geminiMessages.length - 1];
    const result = await chat.sendMessage(lastMessage.parts);

    // Parse the response
    const response = result.response;
    const text = response.text();

    // Check for function calls
    const functionCalls = response.functionCalls() || [];

    return {
      content: text ? [{ type: 'text', text }] : [],
      function_calls: functionCalls.map((call) => ({
        name: call.name,
        args: (call.args as Record<string, unknown>) || {},
      })),
      stop_reason: functionCalls.length > 0 ? 'tool_use' : 'end_turn',
    };
  }

  /**
   * Return a model instance configured with the given tools, creating and
   * caching it on first use. Models with no tools fall back to the base model.
   */
  private getModelForTools(tools: ToolDefinition[]): GenerativeModel {
    if (tools.length === 0) {
      return this.model;
    }

    const cacheKey = tools
      .map((t) => t.name)
      .sort()
      .join(',');

    const cached = this.modelCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const model = this.client.getGenerativeModel({
      model: MODEL_NAME,
      tools: this.convertToolsToGemini(tools),
      safetySettings: SAFETY_SETTINGS,
    });
    this.modelCache.set(cacheKey, model);
    return model;
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
User: "list files" → list_directory("${cwd}")
User: "read package.json" → read_file("${cwd}/package.json")
User: "create test.js" → write_file("${cwd}/test.js", <content>)
User: "summarize the project" → list_directory → read relevant files → provide summary

Be direct, use tools proactively, and complete tasks efficiently.`;
  }

  // Convert LangChain messages to Gemini format
  private convertMessagesToGemini(messages: BaseMessage[]): any[] {
    const geminiMessages: any[] = [];

    for (const message of messages) {
      if (message instanceof HumanMessage) {
        geminiMessages.push({
          role: 'user',
          parts: [{ text: message.content }],
        });
      } else if (message instanceof AIMessage) {
        const parts: any[] = [];

        // Add text content
        if (message.content && typeof message.content === 'string') {
          parts.push({ text: message.content });
        }

        // Add function calls if present
        const toolCalls = (message.tool_calls || []) as unknown as ToolCall[];
        for (const toolCall of toolCalls) {
          parts.push({
            functionCall: {
              name: toolCall.function.name,
              args: JSON.parse(toolCall.function.arguments),
            },
          });
        }

        geminiMessages.push({
          role: 'model',
          parts,
        });
      } else if (message instanceof ToolMessage) {
        // Function response - must have role 'function' not 'user' for Gemini
        let responseContent: unknown;

        // Parse content if it's a string
        if (typeof message.content === 'string') {
          try {
            responseContent = JSON.parse(message.content);
          } catch {
            // If parsing fails, wrap it as text
            responseContent = { result: message.content };
          }
        } else {
          responseContent = message.content;
        }

        geminiMessages.push({
          role: 'function',
          parts: [
            {
              functionResponse: {
                name: message.name || 'unknown_tool',
                response: responseContent,
              },
            },
          ],
        });
      }
    }

    return geminiMessages;
  }

  /**
   * Convert tools to Gemini format.
   *
   * Gemini expects a SINGLE Tool object whose `functionDeclarations` array
   * holds every available function. Emitting one Tool per function (as the
   * previous implementation did) causes the API to only register the last one.
   */
  convertToolsToGemini(tools: ToolDefinition[]): any[] {
    if (tools.length === 0) {
      return [];
    }

    return [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          description: tool.description || 'No description provided',
          parameters: this.cleanJsonSchema(tool.inputSchema),
        })),
      },
    ];
  }

  /**
   * Clean JSON Schema to match Gemini's expectations
   * Removes: $schema, additionalProperties, and other non-standard fields
   */
  cleanJsonSchema(schema: JsonSchema | undefined): JsonSchema {
    if (!schema || typeof schema !== 'object') {
      return { type: 'object', properties: {} };
    }

    const cleaned: JsonSchema = {
      type: schema.type || 'object',
    };

    // Copy allowed fields
    if (schema.properties) {
      cleaned.properties = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        cleaned.properties[key] = this.cleanJsonSchema(value);
      }
    }

    if (schema.items) {
      cleaned.items = this.cleanJsonSchema(schema.items);
    }

    if (schema.required && Array.isArray(schema.required)) {
      cleaned.required = schema.required;
    }

    if (schema.description) {
      cleaned.description = schema.description;
    }

    if (schema.enum) {
      cleaned.enum = schema.enum;
    }
    return cleaned;
  }
}

export const geminiService = new GeminiService();
