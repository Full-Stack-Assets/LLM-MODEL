import { StateGraph, END } from '@langchain/langgraph';
import { AgentStateAnnotation, AgentState } from './state';
import { userInputNode, modelNode, toolUseNode } from './nodes';

// Hard cap on model <-> tool loops within a single user turn. Prevents a
// misbehaving model from looping on tool calls forever.
export const MAX_ITERATIONS = 20;

// Edge function to determine if the agent should continue to tool execution
export function shouldContinueToTools(state: AgentState): string {
  // Stop if we've hit the iteration ceiling, regardless of the model's intent.
  if (state.iterations >= MAX_ITERATIONS) {
    return 'end';
  }
  return state.shouldContinue ? 'continue' : 'end';
}


// Create and compile the LangGraph state machine

const workflow = new StateGraph(AgentStateAnnotation)
  // Add nodes
  .addNode('userInput', userInputNode)
  .addNode('model', modelNode)
  .addNode('toolUse', toolUseNode)

  // Set entry point
  .setEntryPoint('userInput')

  // Add edges
  .addEdge('userInput', 'model')
  .addConditionalEdges('model', shouldContinueToTools, {
    continue: 'toolUse',
    end: END,
  })
  .addEdge('toolUse', 'model');

// Compile the graph
export const graph = workflow.compile();
