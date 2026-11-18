// A card's brief before its owner hands it to their agent (R-035, D-105): the card and the
// decisions it follows, as the agent will get them, raw, so nothing Markdown hides is missed, with
// each passage a teammate wrote marked. The page signs a hash of exactly this text into the
// request, so the agent refuses to run it once the card or a decision changed.
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { useEffect, useMemo, useState } from 'react';
import type { Card, DocSection } from '../../../shared/board';
import { textHash } from '../../../shared/e2ee';
import { briefText, isHeld, runsCards } from '../../../shared/types';
import { asleep, ownAgents, seatFor, seatKey, short, WAKE, type Seat } from '../agents';
import { afterWarnings, boardDocs, otherRun, startable, waitingFace, workingStatus } from '../board';
import { requestRun } from '../chat';
import { useLinkedRepos } from '../linkedRepos';
import { boardCards, loadSections } from '../docs';
import { actions, senderName, useAppState, type State } from '../store';
import { HarnessPicker, useHarnessPick } from './HarnessPicker';

const NONE: string[] = [];

export function AgentBrief({ brief }: { brief: NonNullable<State['agentBrief']> }) {
  const docs = useAppState((s) => s.docs);
  const conversations = useAppState((s) => s.conversations);
  const projects = useAppState((s) => s.projects);
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const meName = useAppState((s) => s.me?.displayName ?? '');
  const doc = docs[brief.docId];
  const decisionsDoc = boardDocs(docs, conversations, brief.projectId).decisions;
  const [loaded, setLoaded] = useState<{ card?: Card; decisions: DocSection[] } | null>(null);
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The repositories the project links (D-050), where an agent with no folder of one clones it first (R-036).
  const linked = useLinkedRepos([brief.projectId])[brief.projectId]?.repos ?? NONE;

  // The card and the decisions as they are now, again whenever either doc changes. The agent reads
  // only the sections that open, so the page leaves out the others too.
  useEffect(() => {
    let live = true;
    void Promise.all([doc ? boardCards(doc) : [], decisionsDoc ? loadSections(decisionsDoc) : []]).then(
      ([cards, decisions]) =>
        live &&
        setLoaded({ card: cards.find((c) => c.id === brief.section), decisions: decisions.filter((d) => !d.failed) }),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [doc?.version, decisionsDoc?.version, brief.section]);

  const held = useMemo(() => (loaded?.decisions ?? []).filter((d) => isHeld(d.text)), [loaded]);
  const by = (authorId: number | undefined) =>
    authorId === undefined || authorId === meId ? null : senderName(users, authorId, 'Someone');
  const others = [...new Set(held.map((d) => by(d.authorId)).filter((n): n is string => n !== null))];
  // The agent must be in the card's project to read it. It runs in a repository the project links, or one it has a folder for.
  const members = projects[brief.projectId]?.memberIds;
  const inProject = useMemo(
    () =>
      ownAgents(users, meId)
        .filter((agent) => members?.includes(agent.id))
        .flatMap((agent) =>
          [...new Set([...linked, ...agent.agentRepos.map((s) => s.repo.toLowerCase())])].flatMap(
            (repo) => seatFor(agent, repo) ?? [],
          ),
        ),
    [users, meId, members, linked],
  );
  const can = (s: Seat) => s.online && runsCards(s.protocol);
  const seat = inProject.find((s) => seatKey(s) === picked) ?? inProject.find(can) ?? inProject[0];
  const { list, harness, pick } = useHarnessPick(seat?.agent);
  const lock = doc?.locks.find((l) => l.section === brief.section && l.userId !== meId);

  let blocked = '';
  // The brief's hash covers the status line, so a run that starts after this check makes the agent refuse (D-105).
  if (loaded?.card && otherRun(loaded.card.status, meName))
    blocked = `The card says “${loaded.card.status}”, so another run of it goes or waits for review. Start once its status changes.`;
  // Not before the cards its After line names are Done or Fixed (docs/roadmap/new-after-edge.md).
  else if (loaded?.card?.waits)
    blocked = `${waitingFace(loaded.card.waits)}, which must be Done or Fixed first. ${afterWarnings(loaded.card.waits).join(' ')}`.trim();
  // Not while it holds what only its owner may write, and only from where a run may start (the card-owner decision).
  else if (loaded?.card?.refused)
    blocked = 'Someone changed this card in a way only its owner can. Move or edit it first.';
  // A run of the user's own that never reported back starts again, as it could before lanes.
  else if (loaded?.card && !startable(loaded.card, meName) && loaded.card.status !== workingStatus(meName))
    blocked =
      loaded.card.owner === undefined
        ? 'Only an open or Ready card runs.'
        : 'Only a Ready card runs, and only its owner marks it ready.';
  else if (!seat) blocked = 'Your agent is not in this project. Add it under the project’s people, then start.';
  else if (!seat.online) blocked = `${asleep(seat.lastSeen)}. ${WAKE}`;
  else if (!runsCards(seat.protocol))
    blocked = `${short(seat.repo)} can’t take cards yet. Link a coding agent in Agent settings, then connect a folder by running webchat-agent connect there, which you approve here. Running webchat-agent status says what is missing.`;
  else if (lock)
    blocked = `${senderName(users, lock.userId)} is editing this card. Start once they are done, so your agent gets all of it.`;

  async function start() {
    if (!loaded?.card || !seat) return;
    setBusy(true);
    setError('');
    try {
      const hash = await textHash(
        briefText(
          loaded.card.written,
          loaded.decisions.map((d) => d.text),
        ),
      );
      actions.setAgentsOpen(true, await requestRun(brief.docId, loaded.card, seat.agent, seat.repo, hash, harness));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const card = loaded?.card;
  return (
    <div className="messages agents-list-view">
      <div className="agents-brief">
        <p className="agents-draft-head">What your agent will follow</p>
        {!loaded ? (
          <Text as="p" color="secondary">
            Loading the card…
          </Text>
        ) : !card ? (
          <Banner status="error" title="This card is no longer on the board." />
        ) : (
          <>
            <p className="agents-draft-label">
              The card{by(card.authorId) ? ` · last written by ${by(card.authorId)}` : ''}
            </p>
            <pre className="agents-brief-text">{card.written.trim()}</pre>
            {held.length > 0 && (
              <details>
                <summary className="agents-draft-label">
                  Follows {held.length} {held.length === 1 ? 'decision' : 'decisions'}
                  {others.length > 0 &&
                    ` · ${held.filter((d) => by(d.authorId)).length} with text by ${others.join(' or ')}`}
                </summary>
                {held.map((d) => (
                  <div key={d.id}>
                    {by(d.authorId) && <p className="agents-draft-label">By {by(d.authorId)}</p>}
                    <pre className="agents-brief-text">{d.text.trim()}</pre>
                  </div>
                ))}
              </details>
            )}
            <p className="agents-hint">
              Your agent follows this text with your GitHub login. To change what it does, edit the card.
            </p>
            {inProject.length > 1 ? (
              <Selector
                label="Runs in"
                value={seat ? seatKey(seat) : ''}
                onChange={setPicked}
                options={inProject.map((s) => ({
                  value: seatKey(s),
                  label: `${short(s.repo)}${can(s) ? (s.noFolder ? ' (clones first)' : '') : ' (not ready)'}`,
                }))}
              />
            ) : (
              seat && <p className="agents-repo">Runs in {short(seat.repo)}</p>
            )}
            <HarnessPicker list={list} value={harness} onChange={pick} />
            {!blocked && seat?.noFolder && (
              <p className="agents-hint">
                Your laptop has no copy of {short(seat.repo)} yet. Your agent asks you before it clones it.
              </p>
            )}
            {blocked && <Banner status="warning" title={blocked} />}
            <div className="agents-draft-actions">
              <Button
                variant="primary"
                label="Start"
                isDisabled={!!blocked}
                isLoading={busy}
                onClick={() => void start()}
              />
            </div>
          </>
        )}
        {error && <Banner status="error" title={error} />}
      </div>
    </div>
  );
}
