# CLAUDE.md

Guidance for AI assistants (and humans) working in this repository.

## Overview

`claude-code-assistant` is an **AI-powered coding assistant** written in
**TypeScript / Node.js (18+)**. It runs as an interactive **CLI** and also exposes
a **Vercel serverless `/api/chat` endpoint**. Requests are orchestrated through a
**LangGraph.js** state machine, which calls an LLM via **OpenRouter** (using the
`openai` client), invokes tools through **MCP (Model Context Protocol)** servers,
and persists conversations to **PostgreSQL via Prisma**.

Core stack:
- TypeScript (strict mode, `target` ES2020, `module` commonjs — see `tsconfig.json`)
- `@langchain/langgraph` + `@langchain/core` — agent orchestration
- `@modelcontextprotocol/sdk` — tool servers over stdio
- `@prisma/client` + Prisma — persistence
- `openai` client pointed at OpenRouter; default model `anthropic/claude-opus-4-8`
- `tavily` — web search; `chalk` + `ora` — CLI presentation

## Commands

All commands come from `package.json` (run from the repo root):

| Command | What it does |
| --- | --- |
| `npm run build` | `tsc` — compile `src/` → `dist/` |
| `npm start` | `node dist/index.js` — run the compiled CLI |
| `npm run dev` | `ts-node src/index.ts` — run the CLI without building |
| `npm test` | `tsx --test test/*.test.ts` — run unit tests (Node test runner) |
| `npm run prisma:generate` | `prisma generate` — regenerate the Prisma client |
| `npm run db:migrate` / `npm run prisma:migrate` | `prisma migrate dev` — apply migrations |
| `npm run db:studio` | `prisma studio` — open the Prisma DB GUI |

There is **no linter or formatter** configured (no ESLint/Prettier). Match the
style of surrounding code.

CI (`.github/workflows/ci.yml`) runs on push/PR to `main` across Node 18/20/22:
`npm ci` → `npx prisma generate` → `npm run build` → `npm test`. The build must
compile and tests must pass before merge. (`npm test` runs with
`OPENROUTER_API_KEY=test-key` in CI.)

## Architecture

The agent is a LangGraph state machine (`src/agent/graph.ts`):

```
userInput → model → (shouldContinueToTools?) ──end──▶ END
                ▲                            └─continue─▶ toolUse ─┐
                └───────────────────────────────────────────────-┘
```

- Entry point is `userInput`; `model` decides whether to call tools.
- `shouldContinueToTools(state)` routes to `toolUse` when `state.shouldContinue`
  is true, and forces `end` once `state.iterations >= MAX_ITERATIONS` (**20**) —
  a hard cap that stops a misbehaving model from looping on tools forever.

### Where things live

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | CLI entry & main loop: env validation, MCP connect, command dispatch (`/help`, `/tools`, `/clear`, `/exit`), graceful SIGINT/SIGTERM shutdown |
| `src/agent/state.ts` | `AgentStateAnnotation` / `AgentState` — message flow, `iterations`, `shouldContinue`, `toolResults`, `metadata` |
| `src/agent/graph.ts` | `StateGraph` definition, `MAX_ITERATIONS`, `shouldContinueToTools`, compiled `graph` |
| `src/agent/nodes.ts` | The three nodes: `userInputNode`, `modelNode`, `toolUseNode` |
| `src/services/claude.service.ts` | OpenRouter client; builds the system prompt; `convertTools` (MCP→OpenAI function schema); `convertMessages` (LangChain→OpenAI, **filters orphaned tool messages** from truncated history) |
| `src/services/mcp.service.ts` | Connects/disconnects stdio MCP servers; maintains a `toolName → serverName` index for O(1) routing |
| `src/services/web-search.service.ts` | Tavily web-search exposed as a tool definition |
| `src/services/conversation.service.ts` | Prisma persistence; loads the **last 10 messages** for context; `mapMessageRole` (LangChain → Prisma enum) |
| `src/db/prisma.ts` | Prisma client init + health check |
| `src/types.ts` | Shared types: `JsonSchema`, `ToolDefinition`, `ToolCall`, `ModelResponse` |
| `src/cli/interface.ts` | Copper-themed (`#CD6F47`) terminal UI, banner, spinners |
| `api/chat.ts` | Vercel POST handler: `{ message, conversationId? }` → `{ conversationId, response }`; reuses or creates a conversation and invokes the same `graph` |
| `prisma/schema.prisma` | Postgres models: `conversations`, `messages`, `tool_executions`, `state_checkpoints`; enums `MessageRole` (USER/ASSISTANT/TOOL), `ToolExecutionStatus` |

The CLI (`src/index.ts`) and the HTTP endpoint (`api/chat.ts`) both drive the
**same compiled `graph`** — keep them behaviorally consistent when changing agent
logic.

## Conventions

- **Singleton services**: each service is instantiated once and exported as an
  instance, e.g. `export const conversationService = new ConversationService()`.
  Import the instance; don't construct your own.
- **File naming**: services are `*.service.ts`; tests are `*.test.ts`; LangGraph
  node functions end in `Node`.
- **Enums** are UPPERCASE (`MessageRole`, `ToolExecutionStatus`).
- **Strict typing** is on — keep it that way; no implicit `any`.
- **Reuse the conversion utilities** instead of reimplementing them:
  - `convertTools` / `convertMessages` (`claude.service.ts`)
  - `mapMessageRole` (`conversation.service.ts`)
  `convertMessages` deliberately drops orphaned tool messages left behind when
  history is truncated to 10 messages — bypassing it will cause OpenRouter API
  errors about tool-call IDs that have no matching assistant message.
- **Graceful degradation**: optional integrations (GitHub, Tavily) should fail
  soft and not break the agent when their env vars are absent.

## Configuration / Environment

From `.env.example`:

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `OPENROUTER_API_KEY` | yes | API key the code actually reads |
| `OPENROUTER_MODEL` | no | Override the model (default `anthropic/claude-opus-4-8`) |
| `GITHUB_TOKEN` | no | Enables the GitHub MCP server |
| `TAVILY_API_KEY` | no | Enables web search |

> ⚠️ **Deployment gotcha:** `render.yaml` declares `ANTHROPIC_API_KEY`, but the
> code reads `OPENROUTER_API_KEY`. When deploying to Render, set
> `OPENROUTER_API_KEY` (the value declared in `render.yaml` won't be picked up by
> the app as written).

## Testing

Tests live in `test/` and run on the Node built-in test runner via `tsx --test`:
- `graph.test.ts` — `shouldContinueToTools` edge logic and the iteration cap
- `claude.service.test.ts` — `convertTools`, `convertMessages`, orphaned-message
  filtering, tool-call ID round-tripping
- `conversation.service.test.ts` — `mapMessageRole` mapping/fallback

They are **pure unit tests** — no DB or network. They set dummy env vars and use
**dynamic imports** to load services after the env is in place, avoiding
construction-time side effects. New tests should follow this same pattern.

## Deployment

- **Render** (`render.yaml`): build `npm install && npm run build && npx prisma
  generate`, start `node dist/index.js`. (See the env-var gotcha above.)
- **Vercel** (`vercel.json`): build `npx prisma generate`; functions under
  `api/*.ts` have a 60-second max duration.
