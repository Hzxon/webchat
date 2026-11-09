// The harness picker (docs/roadmap/new-harness-adapter.md): the coding agents the owner's agent
// lists in its sealed setup answer, one of which each run request and prompt names, signed. The
// agent runs every harness its laptop enables and keeps no default, so the page remembers the last
// pick in this browser only. A harness that takes no cards is greyed, with the reason.
import { useEffect, useMemo, useState } from 'react';
import type { UserDTO } from '../../../shared/types';
import { blockedBy, useAgentChats } from '../agents';
import { askSetup } from '../chat';
import { useAppState } from '../store';

const PICK_KEY = 'webchat.harness';
/** The agents this page asked for their setup, so an open picker asks each once. */
const asked = new Set<number>();

export interface HarnessChoice {
  name: string;
  /** Why it takes no cards, or nothing when it does. */
  reason?: string;
}

/**
 * The harnesses the agent lists, each with why it takes no cards, and the one a request should
 * name: the remembered pick while it takes cards, else the first that does. Nothing until the agent
 * has answered, which it is asked once; a plugin from before the list never lists them, and a
 * request to it names none, so it runs on the host harness.
 */
export function useHarnessPick(agent: UserDTO | undefined) {
  const chat = useAgentChats().find((c) => agent && c.members.some((m) => m.userId === agent.id));
  const messages = useAppState((s) => (chat ? s.messages[chat.id] : undefined));
  const state = messages?.findLast((m) => m.senderId === agent?.id && m.setupState)?.setupState;
  const [picked, setPicked] = useState(remembered);
  useEffect(() => {
    if (agent && !state && !asked.has(agent.id) && !blockedBy(agent, true)) {
      asked.add(agent.id);
      void askSetup(agent.id);
    }
  }, [agent?.id, !!state]);
  const list = useMemo(
    () => state?.harnesses?.map((h): HarnessChoice => ({ name: h.name, reason: h.refusal ?? (state.choice.off?.includes(h.name) ? 'turned off in Agent settings' : undefined) })),
    [state],
  );
  const takes = (h: HarnessChoice) => !h.reason;
  const harness = (list?.find((h) => h.name === picked && takes(h)) ?? list?.find(takes))?.name;
  const pick = (name: string) => {
    setPicked(name);
    try {
      localStorage.setItem(PICK_KEY, name);
    } catch {
      // A private window keeps no pick.
    }
  };
  return { list, harness, pick };
}

function remembered() {
  try {
    return localStorage.getItem(PICK_KEY) ?? '';
  } catch {
    return '';
  }
}

/** The pick, as a line after the repository: nothing while the agent has listed no harnesses. */
export function HarnessPicker({ list, value, onChange }: { list?: HarnessChoice[]; value?: string; onChange: (name: string) => void }) {
  if (!list?.length) return null;
  return (
    <label className="agents-repo">
      with
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label="Coding agent">
        {list.map((h) => (
          <option key={h.name} value={h.name} disabled={!!h.reason}>
            {h.name}
            {h.reason && ` (${h.reason})`}
          </option>
        ))}
      </select>
    </label>
  );
}
