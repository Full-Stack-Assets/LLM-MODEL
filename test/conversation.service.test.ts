import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HumanMessage,
  AIMessage,
  ToolMessage,
  SystemMessage,
} from '@langchain/core/messages';

// ConversationService instantiates a PrismaClient on import, but that is lazy
// and does not connect, so these pure mapping tests need no database.
async function newService() {
  const { ConversationService } = await import(
    '../src/services/conversation.service'
  );
  return new ConversationService();
}

test('mapMessageRole maps each LangChain message type to the Prisma enum', async () => {
  const service: any = await newService();

  assert.equal(service.mapMessageRole(new HumanMessage('hi')), 'USER');
  assert.equal(service.mapMessageRole(new AIMessage('yo')), 'ASSISTANT');
  assert.equal(
    service.mapMessageRole(
      new ToolMessage({ content: 'r', tool_call_id: 'x', name: 't' })
    ),
    'TOOL'
  );
});

test('mapMessageRole falls back to USER for unknown message types', async () => {
  const service: any = await newService();
  assert.equal(service.mapMessageRole(new SystemMessage('sys')), 'USER');
});
