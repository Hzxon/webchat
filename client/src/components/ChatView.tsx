import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Divider } from '@astryxdesign/core/Divider';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import type { QuotedMessage } from '../../../shared/e2ee';
import { githubCardEvent } from '../../../shared/github';
import { FILE_EXTENSIONS, FILE_TYPE_LIST, isPhotoType, LIMITS, RUN_PICKUP_MS, type CardNoteDTO, type FileDTO, type GithubCardDTO, type PullCardDTO, type PullEvent, type RunReport, type RunRequest } from '../../../shared/types';
import { seatFor } from '../agents';
import { firstEmoji } from '../chatText';
import { holdReloadWhile } from '../build';
import { cancelRun, discardMessage, loadDraft, loadOlder, quoteOf, react, retryMessage, saveDraft, sendFile, sendMessage, setMuted } from '../chat';
import { downloadFile, formatSize, isExpired, openFile, prepareFile, RefusedFileError, type Attachment } from '../files';
import type { ChatConversation, ChatMessage } from '../e2ee/keyring';
import { actions, chatTitle, otherMemberId, senderName, useAppState, type MessageReactions, type State } from '../store';
import { Avatar, nameColor } from './Avatar';
import { chatText, dayLabel, formatTime, presenceText } from './format';
import {
  AlertIcon,
  ArrowUpIcon,
  BackIcon,
  BellIcon,
  BellOffIcon,
  ClockIcon,
  CloseIcon,
  CopyIcon,
  DownloadIcon,
  FileIcon,
  LockIcon,
  LockOpenIcon,
  PlusIcon,
  PullRequestIcon,
  ReplyIcon,
  SearchIcon,
  ShieldIcon,
  SmilePlusIcon,
  Ticks,
  UserPlusIcon,
  UsersIcon,
} from './icons';
import type { MembersTarget } from './MembersDialog';
import { PullTags, RUN_TAGS, Tag, type Tone } from './PullTags';
import { receiptState } from './receipts';
import { SecurityCodeDialog } from './SecurityCodeDialog';

const EMPTY: ChatMessage[] = [];
const NO_REACTIONS: Record<number, MessageReactions> = {};
/** The six quick reactions WhatsApp offers. */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/** Phones and tablets: no hover, so tapping a message opens its reactions and reply. */
const touchOnly = () => window.matchMedia('(hover: none)').matches;

const copyText = (text: string) =>
  navigator.clipboard.writeText(text).then(
    () => actions.addToast({ conversationId: null, title: 'Copied', body: 'The message text is on your clipboard.' }),
    () => actions.addToast({ conversationId: null, title: 'Not copied', body: 'This browser did not allow copying.' }),
  );

/** Messages one time and one name stand for: the same sender in the same minute, so no day divider between them. */
const sameRun = (a: ChatMessage | undefined, b: ChatMessage | undefined) =>
  !!a && !!b && a.senderId === b.senderId && Math.floor(a.createdAt / 60_000) === Math.floor(b.createdAt / 60_000);

/**
 * Why messages cannot be sent here yet, if so. A chat from before encryption gets its key on the
 * first send, which needs every member's public keys.
 */
function sendBlockedReason(conversation: ChatConversation, state: Pick<State, 'me' | 'users'>): string | null {
  if (conversation.keyId) return null;
  const missing = conversation.members
    .filter((m) => m.userId !== state.me?.id && !state.users[m.userId]?.keys)
    .map((m) => state.users[m.userId]?.displayName ?? 'Someone');
  if (missing.length === 0) return null;
  return `${missing.join(', ')} must sign in again before you can send encrypted messages here.`;
}

interface ChatViewProps {
  conversation: ChatConversation;
  onAddPeople: (target: MembersTarget) => void;
  onMembers: (target: MembersTarget) => void;
}

export function ChatView({ conversation, onAddPeople, onMembers }: ChatViewProps) {
  const me = useAppState((s) => s.me);
  const meId = me?.id;
  const users = useAppState((s) => s.users);
  const warnings = useAppState((s) => s.keyWarnings);
  const project = useAppState((s) => (conversation.projectId === null ? undefined : s.projects[conversation.projectId]));
  const [showCodes, setShowCodes] = useState(false);
  /** The words searched for in this chat's loaded messages; null while search is closed. */
  const [query, setQuery] = useState<string | null>(null);
  useEffect(() => setQuery(null), [conversation.id]);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [dropped, setDropped] = useState<File | null>(null);

  const isChannel = conversation.type === 'channel';
  const title = isChannel ? `#${conversation.title ?? 'channel'}` : chatTitle(conversation);
  const otherId = otherMemberId(conversation, meId);
  const people = conversation.members.length;
  const subtitle = isChannel
    ? `${project?.name ?? 'Project'} · ${people} ${people === 1 ? 'member' : 'members'}`
    : otherId !== undefined
      ? presenceText(users[otherId])
      : conversation.members
          .map((m) => (m.userId === meId ? 'You' : (users[m.userId]?.displayName ?? 'Unknown')))
          .join(', ');
  const changed = conversation.members
    .filter((m) => warnings[m.userId])
    .map((m) => users[m.userId]?.displayName ?? 'Someone');
  const membersOf: MembersTarget | null =
    isChannel && project
      ? { kind: 'project', projectId: project.id }
      : conversation.type === 'group'
        ? { kind: 'group', conversationId: conversation.id }
        : null;

  return (
    <section
      className="chat"
      // Without this the browser opens a dropped file itself, outside the checks the paperclip makes.
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        const file = e.dataTransfer.files[0];
        if (!file) return;
        e.preventDefault();
        setDropped(file);
      }}
    >
      <header className="chat-header">
        <IconButton
          className="back-button"
          variant="ghost"
          label="Back to chats"
          onClick={() => actions.setActive(null)}
          icon={<BackIcon />}
        />
        {isChannel ? (
          <Avatar name={project?.name ?? '#'} seed={(project?.id ?? 0) + 5} size={36} square />
        ) : (
          <Avatar name={title} seed={otherId ?? conversation.id + 3} size={36} online={otherId ? users[otherId]?.online : false} />
        )}
        <Stack gap={0} className="chat-header-text">
          <Text weight="semibold" maxLines={1}>
            {title}
          </Text>
          <Text type="supporting" color="secondary" maxLines={1}>
            {subtitle}
          </Text>
        </Stack>
        <Stack direction="horizontal" gap={0.5}>
          {membersOf && (
            <>
              <IconButton variant="ghost" label="Members" tooltip="Members" onClick={() => onMembers(membersOf)} icon={<UsersIcon />} />
              <IconButton
                variant="ghost"
                label="Add people"
                tooltip="Add people"
                onClick={() => onAddPeople(membersOf)}
                icon={<UserPlusIcon />}
              />
            </>
          )}
          <IconButton
            variant="ghost"
            label={conversation.muted ? 'Unmute' : 'Mute'}
            tooltip={conversation.muted ? 'Unmute' : 'Mute'}
            onClick={() => void setMuted(conversation.id, !conversation.muted)}
            icon={conversation.muted ? <BellOffIcon /> : <BellIcon />}
          />
          <IconButton
            variant="ghost"
            label="Search this chat"
            tooltip="Search this chat"
            onClick={() => setQuery((q) => (q === null ? '' : null))}
            icon={<SearchIcon />}
          />
          <IconButton
            variant="ghost"
            label="Encryption and security codes"
            tooltip="Encryption and security codes"
            onClick={() => setShowCodes(true)}
            icon={<ShieldIcon />}
          />
        </Stack>
      </header>
      {changed.length > 0 && (
        <Banner
          status="warning"
          container="section"
          title={`${changed.join(', ')}’s security code changed. Check it with them before trusting new messages.`}
          endContent={<Button size="sm" label="Check" onClick={() => setShowCodes(true)} />}
        />
      )}
      {query !== null && (
        <Stack direction="horizontal" gap={1} vAlign="center" className="chat-search">
          <TextInput
            type="search"
            label="Search this chat"
            isLabelHidden
            placeholder="Search this chat"
            startIcon={SearchIcon}
            hasAutoFocus
            width="100%"
            value={query}
            onChange={setQuery}
            onKeyDown={(e) => e.key === 'Escape' && setQuery(null)}
          />
          <IconButton variant="ghost" label="Close search" onClick={() => setQuery(null)} icon={<CloseIcon />} />
        </Stack>
      )}
      <MessageList conversation={conversation} filter={query?.trim().toLowerCase() ?? ''} onShowCodes={() => setShowCodes(true)} onReply={setReplyTo} />
      <Composer
        conversationId={conversation.id}
        addressee={otherId !== undefined ? title.split(' ')[0] : title}
        blockedReason={sendBlockedReason(conversation, { me, users })}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        dropped={dropped}
      />
      {showCodes && <SecurityCodeDialog conversation={conversation} onClose={() => setShowCodes(false)} />}
    </section>
  );
}

interface MessageListProps {
  conversation: ChatConversation;
  /** Lowercase words a loaded message's text must hold to show; empty shows them all. */
  filter: string;
  onShowCodes: () => void;
  onReply: (message: ChatMessage) => void;
}

function MessageList({ conversation, filter, onShowCodes, onReply }: MessageListProps) {
  const meId = useAppState((s) => s.me?.id);
  const users = useAppState((s) => s.users);
  const messages = useAppState((s) => s.messages[conversation.id] ?? EMPTY);
  const reactions = useAppState((s) => s.reactions[conversation.id] ?? NO_REACTIONS);
  const complete = useAppState((s) => s.historyComplete[conversation.id] ?? false);
  // No list yet means the first page is still loading.
  const loaded = useAppState((s) => s.messages[conversation.id] !== undefined);
  const pending = useAppState((s) => s.pending);
  const scroller = useRef<HTMLDivElement>(null);
  const restoreFrom = useRef<number | null>(null);
  const stickToBottom = useRef(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** The message whose reaction tray is open. */
  const [trayFor, setTrayFor] = useState<number | null>(null);
  /** The message just jumped to from a quote, highlighted for a moment. */
  const [flashId, setFlashId] = useState<number | null>(null);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  // An agent's reports fold into the card of the request they name, when that request is here.
  // Only the agent the request names reports on it, so nobody else can mark it done.
  const { reports, shown } = useMemo(() => {
    const reports = new Map<number, RunReport>();
    const shown: ChatMessage[] = [];
    for (const m of messages) {
      const report = m.run?.kind === 'request' || m.run?.kind === 'cancel' || m.run?.kind === 'fix' || m.run?.kind === 'clone' ? null : m.run;
      const request = report ? byId.get(report.request)?.run : null;
      if (report && request?.kind === 'request' && request.runtime === m.senderId) reports.set(report.request, report);
      else shown.push(m);
    }
    return { reports, shown: filter ? shown.filter((m) => m.text.toLowerCase().includes(filter)) : shown };
  }, [messages, byId, filter]);

  useEffect(() => {
    if (trayFor === null) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setTrayFor(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [trayFor]);

  function jumpTo(id: number) {
    const el = document.getElementById(`message-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlashId(id);
    setTimeout(() => setFlashId((current) => (current === id ? null : current)), 1600);
  }

  function onBubbleClick(event: MouseEvent, id: number) {
    // Leave links, quotes and text selection alone.
    if ((event.target as Element).closest('a, button') || !window.getSelection()?.isCollapsed) return;
    setTrayFor((current) => (touchOnly() && current !== id ? id : null));
  }

  // Keep the view pinned to the newest message unless the user scrolled up to read history.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (restoreFrom.current !== null) {
      el.scrollTop = el.scrollHeight - restoreFrom.current;
      restoreFrom.current = null;
    } else if (stickToBottom.current || messages.at(-1)?.senderId === meId) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, reactions, meId]);

  useEffect(() => {
    stickToBottom.current = true;
  }, [conversation.id]);

  // The list gets shorter when the keyboard opens or the composer grows. Keep the newest message in view.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  async function showOlder() {
    const el = scroller.current;
    if (!el) return;
    restoreFrom.current = el.scrollHeight - el.scrollTop;
    setLoadingOlder(true);
    try {
      await loadOlder(conversation.id);
    } finally {
      setLoadingOlder(false);
    }
  }

  return (
    <div
      className="messages"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      onClick={(e) => {
        if (trayFor !== null && !(e.target as Element).closest('.reaction-tray, .message-tools, .bubble')) setTrayFor(null);
      }}
    >
      {/* The header's lock opens this in every chat; the notice shows only before the first message, or over unencrypted history. */}
      {(!conversation.keyId || (messages.length === 0 && complete)) && (
        <button className="encryption-notice" onClick={onShowCodes}>
          <LockIcon width={14} height={14} />
          {conversation.keyId
            ? 'Messages are end-to-end encrypted. No one outside this chat, not even the server, can read them.'
            : 'Messages you send here will be end-to-end encrypted. Earlier ones were sent before encryption.'}
        </button>
      )}
      {loaded && !complete && (
        <Stack hAlign="center">
          <Button variant="ghost" size="sm" onClick={() => void showOlder()} isLoading={loadingOlder} label="Show earlier messages" />
        </Stack>
      )}
      {filter && shown.length === 0 && (
        <Stack padding={10} hAlign="center">
          <Text color="secondary">No loaded message matches.</Text>
        </Stack>
      )}
      {messages.length === 0 && complete && (
        <Stack padding={10} hAlign="center">
          <Text color="secondary">No messages yet. Say hello.</Text>
        </Stack>
      )}
      {shown.map((message, i) => {
        const previous = shown[i - 1];
        const newDay = !previous || dayLabel(previous.createdAt) !== dayLabel(message.createdAt);
        const mine = message.senderId === meId;
        const firstOfRun = !sameRun(previous, message);
        const lastOfRun = !sameRun(message, shown[i + 1]);
        const status = message.clientId ? pending[message.clientId] : undefined;
        const canAct = message.id > 0 && message.security !== 'failed';
        const copyable = !message.file && message.text !== '';
        const marks = reactions[message.id];
        const rowClass = [
          'bubble-row',
          mine ? 'mine' : 'theirs',
          firstOfRun ? 'first' : '',
          trayFor === message.id ? 'is-selected' : '',
          flashId === message.id ? 'is-flash' : '',
        ].join(' ');
        return (
          <Fragment key={message.clientId ?? message.id}>
            {newDay && <Divider label={dayLabel(message.createdAt)} />}
            <div className={rowClass} id={message.id > 0 ? `message-${message.id}` : undefined}>
              <div className="bubble-line">
                <div
                  className={`bubble ${message.urgent ? 'bubble-urgent' : ''}`}
                  onClick={canAct ? (e) => onBubbleClick(e, message.id) : undefined}
                >
                  {conversation.type !== 'direct' && !mine && firstOfRun && (
                    <span className="bubble-sender" style={{ color: nameColor(message.senderId ?? 0) }}>
                      {senderName(users, message.senderId, 'Unknown')}
                    </span>
                  )}
                  {message.urgent && <span className="bubble-urgent-label">Urgent</span>}
                  {message.replyTo && (
                    <Quote quote={message.replyTo} original={byId.get(message.replyTo.id)} onJump={() => jumpTo(message.replyTo!.id)} />
                  )}
                  {message.security === 'failed' ? (
                    <span className="bubble-text bubble-failed">
                      <LockIcon width={13} height={13} /> This message could not be decrypted. It may have been altered.
                    </span>
                  ) : message.github ? (
                    <GithubCard card={message.github} />
                  ) : message.run?.kind === 'request' ? (
                    <RunCard
                      run={message.run}
                      state={reports.get(message.id) ?? null}
                      users={users}
                      onCancel={mine ? () => void cancelRun({ ...message, run: message.run as RunRequest }).catch(() => undefined) : undefined}
                    />
                  ) : message.card ? (
                    <CardNote note={message.card} text={message.text} />
                  ) : message.file ? (
                    <FileBubble file={message.file} sentAt={message.createdAt} />
                  ) : message.pull ? (
                    <PullCard pull={message.pull} />
                  ) : (
                    <span className="bubble-text">{chatText(message.text)}</span>
                  )}
                  {(lastOfRun || message.security === 'plain' || message.security === 'github' || status === 'sending') && (
                    <span className="bubble-meta">
                      {message.security === 'plain' && (
                        <span className="not-encrypted" title="Sent before end-to-end encryption was turned on">
                          <LockOpenIcon width={11} height={11} /> Not encrypted
                        </span>
                      )}
                      {message.security === 'github' && (
                        <span className="not-encrypted" title="WebChat wrote this from what GitHub sent, so it is not end-to-end encrypted">
                          <LockOpenIcon width={11} height={11} /> Not encrypted
                        </span>
                      )}
                      {lastOfRun && formatTime(message.createdAt)}
                      {mine && status === 'sending' && <ClockIcon width={13} height={13} aria-label="sending" />}
                      {/* A read pointer covers every message before it, so the run's last ticks speak for the run. */}
                      {mine && !status && message.id > 0 && lastOfRun && <Ticks state={receiptState(conversation, message.id, meId)} />}
                    </span>
                  )}
                </div>
                {canAct && (
                  <span className="message-tools">
                    <IconButton
                      size="sm"
                      label="React"
                      tooltip="React"
                      onClick={() => setTrayFor((current) => (current === message.id ? null : message.id))}
                      icon={<SmilePlusIcon width={17} height={17} />}
                    />
                    <IconButton size="sm" label="Reply" tooltip="Reply" onClick={() => onReply(message)} icon={<ReplyIcon width={17} height={17} />} />
                    {copyable && (
                      <IconButton size="sm" label="Copy text" tooltip="Copy text" onClick={() => void copyText(message.text)} icon={<CopyIcon width={17} height={17} />} />
                    )}
                  </span>
                )}
                {trayFor === message.id && (
                  <div className="reaction-tray" role="menu" aria-label="React or reply">
                    {QUICK_REACTIONS.map((emoji) => (
                      <button
                        key={emoji}
                        role="menuitem"
                        className={`tray-emoji ${meId !== undefined && marks?.[meId]?.emoji === emoji ? 'is-mine' : ''}`}
                        onClick={() => {
                          setTrayFor(null);
                          void react(message, emoji);
                        }}
                        aria-label={`React with ${emoji}`}
                      >
                        {emoji}
                      </button>
                    ))}
                    <input
                      className="tray-any"
                      aria-label="React with another emoji"
                      placeholder="+"
                      title="Type or pick any emoji"
                      onChange={(e) => {
                        const emoji = firstEmoji(e.target.value);
                        if (!emoji) return;
                        setTrayFor(null);
                        void react(message, emoji);
                      }}
                    />
                    <button
                      role="menuitem"
                      className="tray-reply"
                      onClick={() => {
                        setTrayFor(null);
                        onReply(message);
                      }}
                    >
                      <ReplyIcon width={16} height={16} /> Reply
                    </button>
                    {copyable && (
                      <button
                        role="menuitem"
                        className="tray-reply"
                        onClick={() => {
                          setTrayFor(null);
                          void copyText(message.text);
                        }}
                      >
                        <CopyIcon width={16} height={16} /> Copy
                      </button>
                    )}
                  </div>
                )}
              </div>
              {marks && <ReactionChips marks={marks} target={message} onToggle={(emoji) => void react(message, emoji)} />}
              {status === 'failed' && (
                <Stack direction="horizontal" gap={1} hAlign={mine ? 'end' : 'start'}>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<AlertIcon width={14} height={14} />}
                    label="Not sent. Tap to retry."
                    onClick={() => retryMessage(message)}
                  />
                  <Button variant="ghost" size="sm" label="Remove" onClick={() => discardMessage(message)} />
                </Stack>
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/** A request about a board card (the card-notes decision): one line whose click opens the card, for a member of its project. */
function CardNote({ note, text }: { note: CardNoteDTO; text: string }) {
  const projectId = useAppState((s) => {
    const doc = s.docs[note.docId];
    return (doc && s.conversations[doc.conversationId]?.projectId) ?? null;
  });
  if (projectId === null) return <span className="bubble-text">{text}</span>;
  return (
    <button
      type="button"
      className="pull-card card-note"
      onClick={(e) => {
        e.stopPropagation();
        actions.setBoardOpen(projectId, note.section);
      }}
    >
      {text}
    </button>
  );
}

/**
 * A photo shows inline from the bytes this page decrypted and checked; any other file only offers a
 * download, and never opens inside the page. After 7 days the server has dropped it, which the
 * page tells from the message's time (R-005, D-123).
 */
export function FileBubble({ file, sentAt }: { file: FileDTO; sentAt: number }) {
  const photo = isPhotoType(file.type);
  const gone = isExpired(sentAt);
  const [url, setUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const fail = (error: unknown) => setProblem(error instanceof RefusedFileError ? error.message : 'The file could not be opened. Try again.');
  useEffect(() => {
    // A photo still sending has no id yet; its preview stands in.
    if (!photo || gone || !file.id) return;
    let current = true;
    openFile(file).then((opened) => current && setUrl(opened), (error: unknown) => current && fail(error));
    return () => {
      current = false;
    };
  }, [file.id]);
  const about = (
    <span className="file-about">
      <span className="file-name">{file.name}</span>
      <span className="file-size">{formatSize(file.size)}</span>
    </span>
  );
  return (
    <span className="file-bubble" onClick={(e) => e.stopPropagation()}>
      {photo ? (
        <span className="file-photo" style={file.width && file.height ? { aspectRatio: `${file.width} / ${file.height}` } : undefined}>
          {url ? <img src={url} alt={file.name} /> : file.preview && <img className="file-preview" src={file.preview} alt="" />}
        </span>
      ) : (
        <span className="file-card">
          <FileIcon width={22} height={22} />
          {about}
          {!gone && (
            <Button
              size="sm"
              isDisabled={!file.id}
              onClick={() => void downloadFile(file).catch(fail)}
              aria-label={`Download ${file.name}`}
              icon={<DownloadIcon width={16} height={16} />}
              label="Download"
            />
          )}
        </span>
      )}
      {photo && gone && about}
      {gone && <span className="file-note">No longer on the server</span>}
      {problem && <span className="file-note">{problem}</span>}
    </span>
  );
}

/**
 * A shared pull request, as it stood when it was shared. A click opens it on GitHub. A card that
 * reports a later event names only the pull request, with a tag for what happened.
 */
function PullCard({ pull, event }: { pull: PullCardDTO; event?: [Tone, string] }) {
  const login = useAppState((s) => s.github?.account?.login);
  return (
    <a className="pull-card" href={pull.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
      <span className="pull-card-head">
        <PullRequestIcon width={14} height={14} />
        {pull.repo}#{pull.number}
      </span>
      <span className="pull-title">{pull.title}</span>
      <span className="pull-tags">{event ? <Tag tone={event[0]}>{event[1]}</Tag> : <PullTags pull={pull} />}</span>
      {!event && pull.reviewers && <PullPeople label="Reviewers" names={pull.reviewers} login={login} />}
      {!event && pull.assignees && pull.assignees.length > 0 && (
        <PullPeople label="Assignees" names={pull.assignees} login={login} />
      )}
    </a>
  );
}

/** The same tones as the pane's activity list. */
const EVENT_TAGS: Record<Exclude<PullEvent, 'opened'>, [Tone, string]> = {
  ready: ['ok', 'Ready for review'],
  reopened: ['muted', 'Reopened'],
  merged: ['ok', 'Merged'],
  closed: ['muted', 'Closed'],
};

/**
 * A card handed to a coding agent (R-027), with the agent's latest report on it folded in. Its
 * sender can cancel it while it runs (R-030); the agent's report then says so.
 */
function RunCard({ run, state, users, onCancel }: { run: RunRequest; state: RunReport | null; users: State['users']; onCancel?: () => void }) {
  // A request nobody took in time waits no more, as on the board (D-100).
  const unanswered = !state && Date.now() - (run.sentAt ?? 0) > RUN_PICKUP_MS;
  const [tone, label] = state ? RUN_TAGS[state.kind] : ((['muted', unanswered ? 'No answer' : 'Waiting for the agent']) as [Tone, string]);
  const going = (!state && !unanswered) || state?.kind === 'claimed' || state?.kind === 'fixing' || state?.kind === 'progress';
  // Nothing runs while the agent, or its session in the request's repository, checks in nowhere.
  // A daemon that starts again reports the run (K-46).
  const agent = users[run.runtime];
  const seat = run.repo && agent ? seatFor(agent, run.repo) : agent;
  const offline = going && !seat?.online;
  return (
    <span className="pull-card">
      <span className="pull-card-head">
        {run.card} · {senderName(users, run.runtime)}
        {run.repo && ` in ${run.repo}`}
      </span>
      <span className="pull-title">{run.title}</span>
      <span className="pull-tags">
        <Tag tone={tone}>{label}</Tag>
        {offline && <Tag tone="warn">Agent offline</Tag>}
        {state?.branch && <code>{state.branch}</code>}
        {state?.pull && (
          <a href={`https://github.com/${state.pull.repo}/pull/${state.pull.number}`} target="_blank" rel="noopener noreferrer">
            {state.pull.repo}#{state.pull.number}
          </a>
        )}
      </span>
      {state?.note && <span className="pull-people">{state.note}</span>}
      {going && onCancel && (
        <Button
          size="sm"
          label="Cancel"
          onClick={(e) => {
            e.stopPropagation();
            onCancel();
          }}
        />
      )}
    </span>
  );
}

/**
 * A pull request event in a linked repository. The server wrote it from GitHub's webhook (D-050),
 * so nobody signed it; its link still leads only to the pull request on github.com.
 */
function GithubCard({ card }: { card: GithubCardDTO }) {
  return (
    <>
      <span className="bubble-text">{githubCardEvent(card)}</span>
      <PullCard pull={card.pull} event={card.event === 'opened' ? undefined : EVENT_TAGS[card.event]} />
    </>
  );
}

/** Who a card names. The viewer's own GitHub login reads "you", so a reviewer spots their turn. */
function PullPeople({ label, names, login }: { label: string; names: string[]; login?: string }) {
  const mine = login?.toLowerCase();
  return (
    <span className="pull-people">
      <span className="pull-people-label">{label}:</span>{' '}
      {names.length === 0 ? (
        'none asked yet'
      ) : (
        names.map((name, i) => (
          <Fragment key={name}>
            {i > 0 && ', '}
            {name.toLowerCase() === mine ? <strong className="pull-you">you</strong> : `@${name}`}
          </Fragment>
        ))
      )}
    </span>
  );
}

/**
 * The message a reply answers. A loaded original passed its sender's signature check, so it wins
 * over the copy inside the reply, which only the person replying wrote.
 */
function Quote({ quote, original, onJump }: { quote: QuotedMessage; original?: ChatMessage; onJump?: () => void }) {
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  // The server picks message ids and no signature covers them, so the message that now has the
  // quoted id stands in for the quote only when its sender and text match what the reply signed (K-44).
  const readable = original && original.security !== 'failed' ? original : undefined;
  const trusted =
    readable && (readable.senderId ?? 0) === quote.senderId && readable.text.slice(0, LIMITS.quoteLength) === quote.text ? readable : undefined;
  // A reply to a card from GitHub quotes sender 0.
  const senderId = quote.senderId || null;
  const text = trusted?.text ?? quote.text;
  const name = senderId === meId ? 'You' : senderName(users, senderId);
  const color = nameColor(senderId ?? 0);
  const body = (
    <>
      <span className="quote-sender" style={{ color }}>
        {name}
      </span>
      <span className="quote-text">{text}</span>
    </>
  );
  return onJump && trusted === readable ? (
    <button type="button" className="quote" style={{ borderColor: color }} onClick={onJump} title="Show the original message">
      {body}
    </button>
  ) : (
    <span className="quote" style={{ borderColor: color }}>
      {body}
    </span>
  );
}

/** One chip per emoji, with how many people chose it. Tapping a chip adds or takes back yours. */
function ReactionChips({ marks, target, onToggle }: { marks: MessageReactions; target: ChatMessage; onToggle: (emoji: string) => void }) {
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const groups = useMemo(() => {
    const byEmoji = new Map<string, { emoji: string; userIds: number[]; first: number }>();
    for (const [id, mark] of Object.entries(marks)) {
      if (!mark.emoji) continue;
      // Reactions are filed under the message id, which the server picks and no signature covers.
      // Skip one signed for another message than the one that now has the id (K-44).
      if (mark.senderId !== undefined && (mark.senderId !== (target.senderId ?? 0) || mark.clientId !== (target.clientId ?? undefined))) continue;
      const group = byEmoji.get(mark.emoji) ?? { emoji: mark.emoji, userIds: [], first: mark.eventId };
      group.userIds.push(Number(id));
      group.first = Math.min(group.first, mark.eventId);
      byEmoji.set(mark.emoji, group);
    }
    return [...byEmoji.values()].sort((a, b) => b.userIds.length - a.userIds.length || a.first - b.first);
  }, [marks, target.senderId, target.clientId]);

  if (groups.length === 0) return null;
  return (
    <div className="reactions">
      {groups.map(({ emoji, userIds }) => {
        const names = userIds.map((id) => (id === meId ? 'You' : (users[id]?.displayName ?? 'Someone')));
        const mine = meId !== undefined && userIds.includes(meId);
        return (
          <button
            key={emoji}
            className={`reaction ${mine ? 'is-mine' : ''}`}
            onClick={() => onToggle(emoji)}
            title={names.join(', ')}
            aria-label={`${emoji} from ${names.join(', ')}${mine ? '. Tap to take yours back.' : ''}`}
          >
            <span className="reaction-emoji">{emoji}</span>
            {userIds.length > 1 && <span className="reaction-count">{userIds.length}</span>}
          </button>
        );
      })}
    </div>
  );
}

interface ComposerProps {
  conversationId: number;
  /** Who the box's placeholder addresses: a first name, a group or a channel. */
  addressee: string;
  blockedReason: string | null;
  replyTo: ChatMessage | null;
  onCancelReply: () => void;
  /** A file dropped on the chat, attached as if picked with the paperclip. */
  dropped: File | null;
}

/** Grows a message box with its text up to about six lines. */
export function useAutoGrow(input: RefObject<HTMLTextAreaElement | null>, text: string) {
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight leaves out the border, and box-sizing is border-box, so add it back.
    const height = el.scrollHeight + el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(height, 150)}px`;
    el.style.overflowY = height > 150 ? 'auto' : 'hidden';
  }, [input, text]);
}

/**
 * A message box's text. The draft stays on this device, so it comes back after a close, a reload or
 * another chat (D-051), and a reload after a deploy waits until it is sent or cleared (D-040).
 */
export function useDraft(name: number | string) {
  const [text, setText] = useState('');
  const draft = useRef('');
  useEffect(() => {
    draft.current = text;
  }, [text]);
  useEffect(() => holdReloadWhile(() => draft.current.trim() !== ''), []);
  useEffect(() => {
    let current = true;
    setText('');
    void loadDraft(name).then((saved) => {
      if (current && saved) setText((typed) => typed || saved);
    });
    return () => {
      current = false;
    };
  }, [name]);
  const edit = (value: string) => {
    setText(value);
    saveDraft(name, value);
  };
  return [text, edit] as const;
}

function Composer({ conversationId, addressee, blockedReason, replyTo, onCancelReply, dropped }: ComposerProps) {
  const [text, edit] = useDraft(conversationId);
  const [urgent, setUrgent] = useState(false);
  const filesOn = useAppState((s) => s.files);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setUrgent(false);
    setAttachment(null);
    setFileProblem(null);
    // On a phone the keyboard would cover half of a chat just opened, so it waits for a tap.
    if (!touchOnly()) input.current?.focus();
  }, [conversationId]);

  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);

  useAutoGrow(input, text);

  const canAttach = filesOn && blockedReason === null;
  useEffect(() => {
    if (dropped && canAttach) void pick(dropped);
  }, [dropped]);

  async function pick(picked: File | undefined) {
    setFileProblem(null);
    if (!picked) return;
    try {
      setAttachment(await prepareFile(picked));
    } catch (error) {
      setFileProblem(error instanceof Error ? error.message : 'The file could not be read.');
    }
  }

  function submit() {
    if ((!text.trim() && !attachment) || blockedReason) return;
    // The file goes as a message of its own, before the text that comes with it.
    if (attachment) void sendFile(conversationId, attachment);
    setAttachment(null);
    if (text.trim()) void sendMessage(conversationId, text, urgent, replyTo ? quoteOf(replyTo) : null);
    edit('');
    setUrgent(false);
    onCancelReply();
    input.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape' && replyTo) {
      event.preventDefault();
      onCancelReply();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <footer className="composer">
      {blockedReason && <Banner status="warning" title={blockedReason} />}
      {replyTo && (
        <div className="composer-reply">
          <Quote quote={quoteOf(replyTo)} original={replyTo} />
          <IconButton variant="ghost" label="Cancel reply" tooltip="Cancel reply" onClick={onCancelReply} icon={<CloseIcon width={18} height={18} />} />
        </div>
      )}
      {fileProblem && (
        <Text as="p" type="supporting" color="secondary">
          {fileProblem}
        </Text>
      )}
      {attachment && (
        <div className="composer-attachment">
          {attachment.file.preview ? <img src={attachment.file.preview} alt="" /> : <FileIcon width={22} height={22} />}
          <span className="file-about">
            <span className="file-name">{attachment.file.name}</span>
            <span className="file-size">{formatSize(attachment.file.size)} · Kept for 7 days</span>
          </span>
          <IconButton variant="ghost" label="Remove file" tooltip="Remove file" onClick={() => setAttachment(null)} icon={<CloseIcon width={18} height={18} />} />
        </div>
      )}
      <button
        type="button"
        className="urgent-toggle"
        aria-pressed={urgent}
        title="Send as urgent: their device keeps ringing until they see it, even in a muted chat"
        onClick={() => setUrgent((u) => !u)}
      >
        <BellIcon width={16} height={16} />
        {urgent ? 'Urgent' : 'Mark as urgent'}
      </button>
      <div className="composer-row">
        {filesOn && (
          <>
            <button
              type="button"
              className="composer-attach"
              aria-label="Attach a photo or file"
              title="Attach a photo or file"
              disabled={blockedReason !== null}
              onClick={() => picker.current?.click()}
            >
              <PlusIcon width={18} height={18} />
            </button>
            <input
              ref={picker}
              type="file"
              hidden
              accept={[...FILE_EXTENSIONS, ...FILE_TYPE_LIST].join(',')}
              onChange={(e) => {
                void pick(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </>
        )}
        <textarea
          ref={input}
          rows={1}
          value={text}
          maxLength={LIMITS.messageLength}
          aria-label="Message"
          placeholder={`Message ${addressee}`}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            // Text copied from an office app comes with a picture of itself; the text is what was meant.
            const file = e.clipboardData.files[0];
            if (!file || !canAttach || e.clipboardData.types.includes('text/plain')) return;
            e.preventDefault();
            void pick(file);
          }}
        />
        <button
          type="button"
          className="composer-send"
          aria-label="Send"
          title="Send"
          onClick={submit}
          disabled={(!text.trim() && !attachment) || blockedReason !== null}
        >
          <ArrowUpIcon width={18} height={18} />
        </button>
      </div>
    </footer>
  );
}
