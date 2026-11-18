// The harness picker (docs/roadmap/new-harness-adapter.md): the coding agents the owner's agent
// lists in its sealed setup answer, one of which each run request and prompt names, signed. The
// agent runs every harness its laptop enables and keeps no default, so the page remembers the last
// pick in this browser only. A harness that cannot do what is asked, a card or a question, is greyed,
// with the reason.
import { useEffect, useState } from 'react';
import type { UserDTO } from '../../../shared/types';
import { Selector } from '@astryxdesign/core/Selector';
import { blockedBy, useAgentChat } from '../agents';
import { askSetup } from '../chat';
import { useAppState } from '../store';

const PICK_KEY = 'webchat.harness';
/** The agents this page asked for their setup, so an open picker asks each once. */
const asked = new Set<number>();

export interface HarnessChoice {
  name: string;
  /** Why it cannot do what is asked, or nothing when it can. */
  reason?: string;
  /** The models a session can pick for it (R-072). */
  models?: string[];
}

/**
 * The harnesses the agent lists, each with why it cannot take a card, or answer a question for
 * `questions`, and the one a request should name: the remembered pick while it can, else the first
 * that can. An agent from before linking says only why it takes no cards. Nothing until the agent
 * has answered, which it is asked once; a plugin from before the list never lists them, and a
 * request to it names none, so it runs on the host harness.
 */
export function useHarnessPick(agent: UserDTO | undefined, questions = false) {
  const chat = useAgentChat(agent);
  // The newest answer alone, so a new message in the chat renders nothing here.
  const state = useAppState((s) =>
    chat ? s.messages[chat.id]?.findLast((m) => m.senderId === agent?.id && m.setupState)?.setupState : undefined,
  );
  const [picked, setPicked] = useState(remembered);
  useEffect(() => {
    if (agent && !state && !asked.has(agent.id) && !blockedBy(agent, true)) {
      asked.add(agent.id);
      void askSetup(agent.id);
    }
  }, [agent?.id, !!state]);
  const list = state?.harnesses?.map((h): HarnessChoice => ({
    name: h.name,
    models: h.models,
    reason:
      questions && h.linked !== undefined
        ? h.answers
        : (h.refusal ?? (state.choice.off?.includes(h.name) ? 'turned off in Agent settings' : undefined)),
  }));
  const harness = (list?.find((h) => h.name === picked && !h.reason) ?? list?.find((h) => !h.reason))?.name;
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
export function HarnessPicker({
  list,
  value,
  onChange,
}: {
  list?: HarnessChoice[];
  value?: string;
  onChange: (name: string) => void;
}) {
  if (!list?.length) return null;
  return (
    <div className="agents-repo">
      with
      <Selector
        label="Coding agent"
        isLabelHidden
        size="sm"
        value={value ?? ''}
        onChange={onChange}
        options={list.map((h) => ({ value: h.name, label: h.name, description: h.reason, disabled: !!h.reason }))}
      />
    </div>
  );
}
