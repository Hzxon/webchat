// A card's brief before its owner hands it to their agent (R-035, D-105): the card and the
// decisions it follows, as the agent will get them, raw, so nothing Markdown hides is missed, with
// each passage a teammate wrote marked. The page signs a hash of exactly this text into the
// request, so the agent refuses to run it once the card or a decision changed.
import { useEffect, useMemo, useState } from 'react';
import { textHash } from '../../../shared/e2ee';
import { AGENT_LEVEL, briefText, isHeld } from '../../../shared/types';
import { asleep, ownAgents, seatFor, seatKey, short, WAKE, type Seat } from '../agents';
import { api } from '../api';
import { boardDocs, parseCard, type Card } from '../board';
import { requestRun } from '../chat';
import { loadSections, type DocSection } from '../docs';
import { actions, senderName, useAppState, type State } from '../store';


export function AgentBrief({ brief }: { brief: NonNullable<State['agentBrief']> }) {
  const docs = useAppState((s) => s.docs);
  const conversations = useAppState((s) => s.conversations);
  const projects = useAppState((s) => s.projects);
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const doc = docs[brief.docId];
  const decisionsDoc = boardDocs(docs, conversations, brief.projectId).decisions;
  const [loaded, setLoaded] = useState<{ card?: Card; decisions: DocSection[] } | null>(null);
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The repositories the project links (D-050), where an agent with no folder of one clones it first (R-036).
  const [linked, setLinked] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    api.projectRepos(brief.projectId).then(
      (view) => live && setLinked(view.repos.map((r) => r.repo)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [brief.projectId]);

  // The card and the decisions as they are now, again whenever either doc changes. The agent reads
  // only the sections that open, so the page leaves out the others too.
  useEffect(() => {
    let live = true;
    void Promise.all([doc ? loadSections(doc) : [], decisionsDoc ? loadSections(decisionsDoc) : []]).then(
      ([cards, decisions]) => live && setLoaded({ card: cards.map(parseCard).find((c) => c.id === brief.section), decisions: decisions.filter((d) => !d.failed) }),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [doc?.version, decisionsDoc?.version, brief.section]);

  const held = useMemo(() => (loaded?.decisions ?? []).filter((d) => isHeld(d.text)), [loaded]);
  const by = (authorId: number | undefined) => (authorId === undefined || authorId === meId ? null : senderName(users, authorId, 'Someone'));
  const others = [...new Set(held.map((d) => by(d.authorId)).filter((n): n is string => n !== null))];
  // The agent must be in the card's project to read it. It runs in a repository the project links, or one it has a folder for.
  const members = projects[brief.projectId]?.memberIds;
  const inProject = useMemo(
    () =>
      ownAgents(users, meId)
        .filter((agent) => members?.includes(agent.id))
        .flatMap((agent) => [...new Set([...linked, ...agent.agentRepos.map((s) => s.repo.toLowerCase())])].flatMap((repo) => seatFor(agent, repo) ?? [])),
    [users, meId, members, linked],
  );
  const can = (s: Seat) => s.online && s.protocol >= AGENT_LEVEL.cards;
  const seat = inProject.find((s) => seatKey(s) === picked) ?? inProject.find(can) ?? inProject[0];
  const lock = doc?.locks.find((l) => l.section === brief.section && l.userId !== meId);

  let blocked = '';
  if (!seat) blocked = 'Your agent is not in this project. Add it under the project’s people, then start.';
  else if (!seat.online) blocked = `${asleep(seat)}. ${WAKE}`;
  else if (seat.protocol < AGENT_LEVEL.cards) blocked = `${short(seat.repo)} can’t take cards yet. In Claude Code on your laptop, type /webchat:connect: it says what is missing.`;
  else if (lock) blocked = `${senderName(users, lock.userId)} is editing this card. Start once they are done, so your agent gets all of it.`;

  async function start() {
    if (!loaded?.card || !seat) return;
    setBusy(true);
    setError('');
    try {
      const hash = await textHash(briefText(loaded.card.text, loaded.decisions.map((d) => d.text)));
      actions.setAgentsOpen(true, await requestRun(brief.docId, loaded.card, seat.agent, seat.repo, hash));
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
          <p className="agents-note">Loading the card…</p>
        ) : !card ? (
          <p className="composer-blocked">This card is no longer on the board.</p>
        ) : (
          <>
            <p className="agents-draft-label">The card{by(card.authorId) ? ` · last written by ${by(card.authorId)}` : ''}</p>
            <pre className="agents-brief-text">{card.text.trim()}</pre>
            {held.length > 0 && (
              <details>
                <summary className="agents-draft-label">
                  Follows {held.length} {held.length === 1 ? 'decision' : 'decisions'}
                  {others.length > 0 && ` · ${held.filter((d) => by(d.authorId)).length} with text by ${others.join(' or ')}`}
                </summary>
                {held.map((d) => (
                  <div key={d.id}>
                    {by(d.authorId) && <p className="agents-draft-label">By {by(d.authorId)}</p>}
                    <pre className="agents-brief-text">{d.text.trim()}</pre>
                  </div>
                ))}
              </details>
            )}
            <p className="agents-hint">Your agent follows this text with your GitHub login. To change what it does, edit the card.</p>
            {inProject.length > 1 ? (
              <label className="agents-repo">
                Runs in
                <select value={seat ? seatKey(seat) : ''} onChange={(e) => setPicked(e.target.value)}>
                  {inProject.map((s) => (
                    <option key={seatKey(s)} value={seatKey(s)}>
                      {short(s.repo)}
                      {can(s) ? (s.noFolder ? ' (clones first)' : '') : ' (not ready)'}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              seat && <p className="agents-repo">Runs in {short(seat.repo)}</p>
            )}
            {!blocked && seat?.noFolder && <p className="agents-hint">Your laptop has no copy of {short(seat.repo)} yet. Your agent asks you before it clones it.</p>}
            {blocked && <p className="composer-blocked">{blocked}</p>}
            <div className="agents-draft-actions">
              <button className="button-primary" disabled={!!blocked || busy} onClick={() => void start()}>
                Start
              </button>
            </div>
          </>
        )}
        {error && <p className="form-error">{error}</p>}
      </div>
    </div>
  );
}
