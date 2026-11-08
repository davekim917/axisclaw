/**
 * What a polled batch admits, shared by the poll loop and the early task gate that runs before the agent boots. Kept
 * free of provider and SDK imports: the early gate loads this on every scheduled fire.
 */
import type { MessageInRow } from './db/messages-in.js';
import { isClearCommand } from './formatter.js';

/** System rows are MCP tool responses; only recall_context reaches the prompt. */
export function pollableRows(messages: MessageInRow[]): MessageInRow[] {
  return messages.filter((m) => {
    if (m.kind !== 'system') return true;
    try {
      const parsed = JSON.parse(m.content) as { subtype?: string };
      return parsed.subtype === 'recall_context';
    } catch {
      return false;
    }
  });
}

export function isAdmissibleTrigger(m: MessageInRow): boolean {
  if (m.trigger !== 1) return false;
  if (m.kind === 'system') return false;
  if ((m.kind === 'chat' || m.kind === 'chat-sdk') && isClearCommand(m)) return false;
  return true;
}

function recallTargetId(m: MessageInRow): string | null {
  if (m.kind !== 'system' || !m.id.startsWith('recall-')) return null;
  try {
    const parsed = JSON.parse(m.content) as { subtype?: unknown };
    return parsed.subtype === 'recall_context' ? m.id.slice('recall-'.length) : null;
  } catch {
    return null;
  }
}

export function retainCompleteRecallPairs(original: MessageInRow[], admitted: MessageInRow[]): MessageInRow[] {
  const originalRecallByTarget = new Map<string, string>();
  for (const row of original) {
    const targetId = recallTargetId(row);
    if (targetId !== null && original.some((candidate) => candidate.id === targetId)) {
      originalRecallByTarget.set(targetId, row.id);
    }
  }
  if (originalRecallByTarget.size === 0) return admitted;

  const admittedIds = new Set(admitted.map((row) => row.id));
  return admitted.filter((row) => {
    const targetId = recallTargetId(row);
    if (targetId !== null && originalRecallByTarget.get(targetId) === row.id) {
      return admittedIds.has(targetId);
    }
    const recallId = originalRecallByTarget.get(row.id);
    return recallId === undefined || admittedIds.has(recallId);
  });
}
