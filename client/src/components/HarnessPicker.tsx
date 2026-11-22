// The harness picker (docs/roadmap/new-harness-adapter.md): the coding agents the owner's agent
// lists in its sealed setup answer, one of which each run request and prompt names, signed. The
// agent runs every harness its laptop enables and keeps no default, so the page remembers the last
// pick in this browser only. A harness that cannot do what is asked, a card or a question, is greyed,
// with the reason.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { UserDTO } from '../../../shared/types';
import { SearchIcon } from './icons';
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
  /** The effort levels a session can pick for it, by model, `''` for its default model. */
  efforts?: Record<string, string[]>;
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
    efforts: h.efforts,
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
  return { list, harness, pick, own: state?.choice.own ?? [] };
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

const CLAUDE_PATH = 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z';
const CODEX_PATH = 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z';
/** The logos of harnesses whose mark is a picture, served from `client/public/harness`. */
const PICTURES: Record<string, string> = { Hermes: '/harness/hermes.png', Antigravity: '/harness/antigravity.svg' };

/** A harness's own mark, or its first letter for one WebChat has no mark of. */
export function HarnessLogo({ name, size = 18 }: { name: string; size?: number }) {
  if (name === 'Claude Code' || name === 'Codex')
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill={name === 'Codex' ? 'currentColor' : '#D97757'} role="img" aria-label={name}>
        <path d={name === 'Codex' ? CODEX_PATH : CLAUDE_PATH} />
      </svg>
    );
  if (PICTURES[name]) return <img src={PICTURES[name]} alt={name} width={size} height={size} className="harness-logo" />;
  return (
    <span className="harness-letter" style={{ width: size, height: size }} role="img" aria-label={name}>
      {name.charAt(0)}
    </span>
  );
}

const FAVS_KEY = 'webchat.modelFavorites';
export type Pick = { harness: string; model?: string };
const pickKey = (p: Pick) => `${p.harness}|${p.model ?? ''}`;

function favorites(): Pick[] {
  try {
    return (JSON.parse(localStorage.getItem(FAVS_KEY) ?? '[]') as Pick[]).slice(0, 6);
  } catch {
    return [];
  }
}

/** The newest picks first, at most six, kept in this browser only. */
function remember(favs: Pick[], p: Pick) {
  try {
    localStorage.setItem(FAVS_KEY, JSON.stringify([p, ...favs.filter((f) => pickKey(f) !== pickKey(p))].slice(0, 6)));
  } catch {
    // A private window keeps no favorites.
  }
}

/** The effort levels of a pick's model, or of the harness's default model when it lists none for that one. */
export function effortsOf(list: HarnessChoice[] | undefined, p: Pick) {
  const efforts = list?.find((h) => h.name === p.harness)?.efforts;
  return efforts?.[p.model ?? ''] ?? efforts?.[''] ?? [];
}

/** An effort level as the picker shows it, such as `xhigh` as Extra high. */
export const effortWord = (effort: string) => (effort === 'xhigh' ? 'Extra high' : effort.charAt(0).toUpperCase() + effort.slice(1));

/**
 * The harness, model and effort picker that the ask box's model button opens: a rail of harnesses,
 * the models of the one picked, and the efforts its picked model takes. A harness that cannot take
 * the question is greyed; `locked` keeps a running session on its harness. The permission mode is
 * the shield's (docs/decisions/new-setup-switch.md).
 */
export function ModelPicker({
  list,
  value,
  effort,
  locked,
  onPick,
  onEffort,
  onClose,
}: {
  list: HarnessChoice[];
  value: Pick;
  /** The effort picked, or nothing for the harness's default. */
  effort?: string;
  locked?: boolean;
  onPick: (pick: Pick) => void;
  onEffort: (effort: string | undefined) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState(value.harness || list[0]?.name || '');
  const [query, setQuery] = useState('');
  const [favs] = useState(favorites);
  const box = useRef<HTMLDivElement>(null);
  const can = (name: string) => !list.find((h) => h.name === name)?.reason && (!locked || name === value.harness);
  const entries: Pick[] =
    tab === ''
      ? favs.filter((f) => list.some((h) => h.name === f.harness))
      : (list.find((h) => h.name === tab)?.models ?? [undefined]).map((model) => ({ harness: tab, model }));
  const q = query.trim().toLowerCase();
  const efforts = effortsOf(list, value);
  const shown = entries.filter((e) => !q || (e.model ?? 'default').toLowerCase().includes(q));
  const choose = (p: Pick) => {
    if (!can(p.harness)) return;
    remember(favs, p);
    onPick(p);
  };
  useEffect(() => {
    box.current?.querySelector<HTMLInputElement>('input')?.focus();
    // A click outside closes it, as a menu does.
    const away = (e: PointerEvent) => !box.current?.parentElement?.contains(e.target as Node) && onClose();
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') onClose();
    const n = Number(e.key);
    if ((e.metaKey || e.ctrlKey) && n >= 1 && n <= 9 && shown[n - 1]) {
      e.preventDefault();
      choose(shown[n - 1]!);
    }
  };
  return (
    <div className="model-picker" role="dialog" aria-label="Harness, model and effort" ref={box} onKeyDown={onKeyDown}>
      <div className="model-picker-tabs" role="tablist" aria-label="Harness" aria-orientation="vertical">
        {['', ...list.map((h) => h.name)].map((name) => [
          <button
            key={name || 'favorites'}
            type="button"
            role="tab"
            aria-selected={tab === name}
            aria-label={name || 'Favorites'}
            title={name ? (list.find((h) => h.name === name)?.reason ?? name) : 'Favorites'}
            disabled={!!name && !can(name)}
            onClick={() => {
              setTab(name);
              setQuery('');
            }}
          >
            {name ? <HarnessLogo name={name} /> : <StarIcon />}
          </button>,
          // A line sets Favorites apart from the harnesses.
          !name && <span key="sep" className="model-picker-sep" aria-hidden="true" />,
        ])}
      </div>
      <div className="model-picker-models">
        <label className="model-picker-search">
          <SearchIcon width={16} height={16} />
          <input type="search" value={query} placeholder="Search models…" aria-label="Search models" onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="model-picker-list">
          {shown.map((p, i) => (
            <button key={pickKey(p)} type="button" aria-pressed={pickKey(p) === pickKey(value)} disabled={!can(p.harness)} onClick={() => choose(p)}>
              <HarnessLogo name={p.harness} />
              <span>{p.model ?? `${p.harness} default`}</span>
              {i < 9 && <kbd>⌘{i + 1}</kbd>}
            </button>
          ))}
          {shown.length === 0 && <p>{tab === '' && !q ? 'Models you pick show here.' : 'No model matches.'}</p>}
        </div>
      </div>
      <div className="model-picker-efforts" role="radiogroup" aria-label="Effort">
        <span className="model-picker-head">Effort</span>
        {efforts.length ? (
          [undefined, ...efforts].map((e) => (
            <button key={e ?? ''} type="button" role="radio" aria-checked={e === effort} onClick={() => onEffort(e)}>
              {e ? effortWord(e) : 'Default'}
            </button>
          ))
        ) : (
          <p>{value.harness} sets its own effort.</p>
        )}
      </div>
    </div>
  );
}

const StarIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />
  </svg>
);

/** The ask box's model button: the harness's mark, the model and the effort; it opens the picker above or below. */
export function ModelButton(props: Omit<Parameters<typeof ModelPicker>[0], 'onClose'> & { up?: boolean }) {
  const [open, setOpen] = useState(false);
  const { value, effort, up } = props;
  if (!props.list.length) return null;
  return (
    <span className={`model-button${up ? ' is-up' : ''}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Harness and model: ${value.harness}, ${value.model ?? 'default model'}`}
        onClick={() => setOpen(!open)}
      >
        <HarnessLogo name={value.harness} />
        <span>{value.model ?? 'Default'}</span>
        {effort && <span className="model-button-mode">{effortWord(effort)}</span>}
      </button>
      {open && (
        <ModelPicker
          {...props}
          onPick={(p) => {
            props.onPick(p);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}
