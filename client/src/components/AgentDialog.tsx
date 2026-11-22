// Pairs a coding agent with this account (R-030, D-093), in three steps: Install, Approve, Done. The
// page makes a one-time code, which the owner's install line hands the agent. The page then waits
// for the agent's keys, which the code proves, and the owner names the agent, picks its projects and
// approves. No invite code or password. Install also lists the owner's agents, so one can be
// removed (R-033).
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Dialog as AstryxDialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { List, ListItem } from '@astryxdesign/core/List';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { newPairingCode } from '../../../shared/e2ee';
import {
  AGENT_RELEASES,
  LIMITS,
  PAIRING_TTL_MS,
  type PairingPick,
  type PublicKeysDTO,
  type UserDTO,
} from '../../../shared/types';
import { ownAgents } from '../agents';
import { api, ApiError } from '../api';
import { holdReloadWhile } from '../build';
import { connectAgent, pairingKeys, removeAgent } from '../chat';
import { useAppState } from '../store';
import { HarnessLogo } from './HarnessPicker';
import { PickItem } from './PickItem';
import { presenceText } from './format';
import { confirmAction } from './ConfirmHost';

const PHONE = '(max-width: 760px)';
const phoneQuery = () => window.matchMedia(PHONE);

/** Whether the screen is a phone's, where the agents' dialogs take the whole screen. */
export function usePhone() {
  return useSyncExternalStore(
    (change) => {
      const query = phoneQuery();
      query.addEventListener('change', change);
      return () => query.removeEventListener('change', change);
    },
    () => phoneQuery().matches,
  );
}

const STEPS = ['Install', 'Approve', 'Done'];

/** The release's own installer, which checks the agent file against the release's checksum before it installs it (docs/decisions/agent-install.md). */
const installLine = (release: string, pasted: string) =>
  `curl -fsSL ${AGENT_RELEASES}/v${release}/install.sh | sh -s -- '${pasted}'`;

export function AgentDialog({ onClose }: { onClose: () => void }) {
  const projects = useAppState((s) => s.projects);
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const mine = useMemo(() => ownAgents(users, meId), [users, meId]);
  const [code] = useState(newPairingCode);
  const [keys, setKeys] = useState<PublicKeysDTO | null>(null);
  // The harnesses the agent asks to link, which its code opens: shown before the owner approves.
  const [picks, setPicks] = useState<PairingPick[]>([]);
  const [name, setName] = useState('Claude Code');
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ name: string; projects: string }>();
  const [note, setNote] = useState('');
  // The server's release names the files the line fetches. Without it, the line is left out.
  const [release, setRelease] = useState('');
  const sorted = useMemo(() => Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)), [projects]);

  useEffect(() => {
    void api.config().then(
      ({ release: found }) => setRelease(found),
      () => undefined,
    );
  }, []);

  // The code lives only in this page. A reload after a deploy would lose it while the agent waits
  // on it, and the owner leaves the tab for Claude Code, so it would go hidden or idle (D-040).
  useEffect(() => holdReloadWhile(() => true), []);

  // Looks for the agent's half every 2 seconds, for as long as the code works. A failed request, in
  // a deploy or a network blip, shows its error and the look goes on (K-61).
  useEffect(() => {
    const until = Date.now() + PAIRING_TTL_MS;
    let live = true;
    let failed = false;
    let timer: ReturnType<typeof setTimeout>;
    const look = async () => {
      try {
        const found = await pairingKeys(code);
        if (!live) return;
        if (failed) setError('');
        failed = false;
        if (found) {
          setKeys(found.keys);
          setPicks(found.picks);
          return;
        }
      } catch (err) {
        if (!live) return;
        // Keys that did not come with the code are no blip: they stay an error for good (D-093).
        if (!(err instanceof ApiError)) {
          setError((err as Error).message);
          return;
        }
        failed = true;
        setError(`${err.message} Still trying.`);
      }
      if (Date.now() > until) setError('The code lapsed. Close this window and open it again for a new one.');
      else timer = setTimeout(() => void look(), 2000);
    };
    void look();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [code]);

  function toggle(id: number) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function remove(agent: UserDTO) {
    const yes = await confirmAction({
      title: `Remove ${agent.displayName}?`,
      body: 'It leaves every project, and its sessions stop taking cards. This cannot be undone.',
      confirmLabel: 'Remove',
    });
    if (!yes) return;
    setBusy(true);
    setError('');
    try {
      await removeAgent(agent);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setBusy(true);
    setError('');
    try {
      const agent = await connectAgent(code, keys!, name.trim(), [...picked]);
      const joined = sorted.filter((p) => picked.has(p.id)).map((p) => p.name);
      setDone({ name: agent.displayName, projects: joined.join(', ') || 'No project yet' });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const phone = usePhone();
  const step = done ? 2 : keys ? 1 : 0;
  const close = (open: boolean) => !open && onClose();
  return (
    <AstryxDialog
      isOpen
      onOpenChange={close}
      purpose="form"
      width={640}
      maxHeight="min(780px, 90dvh)"
      variant={phone ? 'fullscreen' : 'standard'}
      padding={0}
    >
      <div className="agents-dialog-head">
        <DialogHeader title="Connect agent" onOpenChange={close} />
      </div>
      {/* Where the owner is; the agent's answer moves it on. */}
      <ol className="connect-steps" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label} className={i < step ? 'is-done' : i === step ? 'is-on' : undefined} aria-current={i === step ? 'step' : undefined}>
            <span className="connect-step-n">{i < step ? '✓' : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <div className="connect-body">
        {done ? (
          <>
            <h3 className="connect-h is-title">{done.name} connected</h3>
            <dl className="connect-summary" aria-label="What was set up">
              <dt>Laptop</dt>
              <dd>{done.name}</dd>
              {picks.length > 0 && (
                <>
                  <dt>Harnesses</dt>
                  <dd>
                    {picks.map((p) => (
                      <span key={p.name} className="connect-harness">
                        <HarnessLogo name={p.name} size={16} />
                        {p.name}
                        {p.signedIn === false && <span className="is-warn">Sign in on the laptop to use it</span>}
                      </span>
                    ))}
                  </dd>
                </>
              )}
              <dt>Projects</dt>
              <dd>{done.projects}</dd>
            </dl>
          </>
        ) : !keys ? (
          <>
            {release && (
              <>
                <h3 className="connect-h">Run this line in a terminal on your laptop</h3>
                {/* Long lines wrap, so the dialog never scrolls sideways. */}
                <CodeBlock
                  code={installLine(release, `${location.origin}#${code}`)}
                  isWrapped
                  width="100%"
                  onCopy={() => setNote('Copied.')}
                  onCopyError={() => setNote('Select the text, then copy it.')}
                />
                <Text as="p" color="secondary">
                  It installs the agent and keeps it running whenever you are logged in. It needs a Mac or Linux, and an
                  account that can use sudo.
                  {/windows/i.test(navigator.userAgent) && ' On Windows, open Ubuntu on WSL2 and run it there.'}
                </Text>
              </>
            )}
            {!error && (
              <div className="connect-wait" role="status">
                <strong>{note || 'Waiting for your agent…'}</strong>
                <span>The install line expires in {Math.round(PAIRING_TTL_MS / 60_000)} minutes</span>
              </div>
            )}
            {mine.length > 0 && (
              <List edge="flush" header="Your agents">
                {mine.map((agent) => (
                  <ListItem
                    key={agent.id}
                    label={agent.displayName}
                    description={presenceText(agent)}
                    endContent={
                      <Button
                        variant="ghost"
                        size="sm"
                        label="Remove"
                        aria-label={`Remove ${agent.displayName}`}
                        onClick={() => void remove(agent)}
                        isDisabled={busy}
                      />
                    }
                  />
                ))}
              </List>
            )}
          </>
        ) : (
          <form
            id="connect-approve"
            className="connect-form"
            onSubmit={(e) => {
              e.preventDefault();
              void approve();
            }}
          >
            <Text as="p">Your agent sent the code. Name it, and pick any projects it joins: it reads their channels.</Text>
            {/* Display only: Unlink in Agent settings takes one back. */}
            {picks.length > 0 && (
              <List edge="flush" header="Harnesses it links, and runs your questions and cards with">
                {picks.map((p) => (
                  <ListItem
                    key={p.name}
                    startContent={<HarnessLogo name={p.name} />}
                    label={p.name}
                    description={
                      [p.version, p.signedIn !== undefined && (p.signedIn ? 'signed in' : 'not signed in')]
                        .filter(Boolean)
                        .join(', ') || 'not installed yet'
                    }
                  />
                ))}
              </List>
            )}
            <TextInput
              label="Name"
              description="Your team sees this name in projects and on cards it runs."
              value={name}
              onChange={(v) => setName(v.slice(0, LIMITS.displayNameLength))}
            />
            <List edge="flush" header="Projects it joins">
              {sorted.map((project) => (
                <PickItem
                  key={project.id}
                  label={project.name}
                  checked={picked.has(project.id)}
                  onChange={() => toggle(project.id)}
                />
              ))}
            </List>
          </form>
        )}
        {error && <Banner status="error" title={error} />}
      </div>
      {step > 0 && (
        <footer className="connect-foot">
          {step === 1 ? (
            <>
              <Button label="Cancel" onClick={onClose} />
              <Button variant="primary" type="submit" form="connect-approve" isLoading={busy} isDisabled={!name.trim()} label="Approve" />
            </>
          ) : (
            <Button variant="primary" label="Start a chat" onClick={onClose} />
          )}
        </footer>
      )}
    </AstryxDialog>
  );
}
