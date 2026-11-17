// Pairs a coding agent with this account (R-030, D-093). The page makes a one-time code, which the
// owner pastes into the agent. The page then waits for the agent's keys, which the code proves,
// and the owner names the agent, picks its projects and approves. No invite code or password. It
// also lists the owner's agents, so one can be removed (R-033).
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { List, ListItem } from '@astryxdesign/core/List';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useEffect, useMemo, useState } from 'react';
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
import { Dialog } from './Dialog';
import { PickItem } from './PickItem';
import { presenceText } from './format';
import { CopyRow } from './NotificationDialog';
import { confirmAction } from './ConfirmHost';

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
  const [done, setDone] = useState('');
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
      setDone(
        `${agent.displayName} is connected. Ask it about your code here, or hand it a roadmap card with the play button.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Connect coding agent" onClose={onClose}>
      {done ? (
        <Text as="p" color="secondary">
          {done}
        </Text>
      ) : !keys ? (
        <>
          <Text as="p" color="secondary">
            Your coding agent runs on your laptop, with Claude Code or Codex. It answers your questions about your
            team’s code and works on the cards you hand it, and nobody else’s. It needs a Mac or Linux for now.
          </Text>
          {release && (
            <>
              <Text as="p" color="secondary">
                In a terminal on your laptop, run this line. It installs the agent, asks before it installs anything
                else, and keeps the agent running whenever you are logged in. It needs an account that can use sudo, or
                an administrator on a Mac.
                {/windows/i.test(navigator.userAgent) && ' On Windows, open Ubuntu on WSL2 and run it there.'}
              </Text>
              <CopyRow value={installLine(release, `${location.origin}#${code}`)} onCopied={setNote} />
            </>
          )}
          <Text as="p" color="secondary">
            Then run <code>webchat-agent connect</code> in your team’s repository, and approve it here.
          </Text>
          {!error && (
            <Text as="p" weight="semibold">
              {note || 'Waiting for the agent…'}
            </Text>
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
        <Stack
          as="form"
          gap={4}
          onSubmit={(e: React.FormEvent) => {
            e.preventDefault();
            void approve();
          }}
        >
          <Text as="p" color="secondary">
            The agent sent the code. Name it, and pick any projects it joins: it reads their channels. You can add it to
            a project later, like anyone.
          </Text>
          {/* Display only: Unlink in Agent settings takes one back. */}
          {picks.length > 0 && (
            <List
              edge="flush"
              header="It links these coding agents on its laptop, and runs your questions and cards with them:"
            >
              {picks.map((p) => (
                <ListItem
                  key={p.name}
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
          <TextInput label="Name" value={name} onChange={(v) => setName(v.slice(0, LIMITS.displayNameLength))} />
          <List edge="flush">
            {sorted.map((project) => (
              <PickItem
                key={project.id}
                label={project.name}
                checked={picked.has(project.id)}
                onChange={() => toggle(project.id)}
              />
            ))}
          </List>
          <Button variant="primary" type="submit" isLoading={busy} isDisabled={!name.trim()} label="Approve" />
        </Stack>
      )}
      {error && <Banner status="error" title={error} />}
    </Dialog>
  );
}
