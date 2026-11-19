
/** The board stops waiting on a request that no agent answers in this long (D-100). */
export const RUN_PICKUP_MS = 30 * 60_000;

/**
 * A board card handed to a coding agent (R-027, D-086), the agent's report on the run, or the
 * owner's cancel. All travel inside a message's envelope, like a shared pull request, so the
 * server sees messages and nothing more. A report or a cancel names the request's message.
 */
export type RunDTO = RunRequest | RunReport | RunCancel | RunFix | RunClone;

export interface RunRequest {
  kind: 'request';
  /** The card's id, such as K-12. */
  card: string;
  title: string;
  docId: string;
  section: string;
  /** The agent account asked to run it. */
  runtime: number;
  /**
   * When the owner's page sent it. Signed, unlike the server's time, so an old request cannot be
   * played again as new (K-42). The agent refuses a request without it, from before D-089.
   */
  sentAt?: number;
  /**
   * The repository the menu showed for the agent, as "owner/name". An agent in a Claude Code
   * session runs the card only in a session open in it (R-030). Older pages send none.
   */
  repo?: string;
  /**
   * The hash of the brief the owner saw before pressing Start: the card and the decisions, as
   * briefText makes it (D-105). The agent refuses a request without it, or whose brief changed.
   */
  hash?: string;
  /** The card's status when the owner pressed Start, which their page puts back if the run fails. */
  was?: string;
  /**
   * The harness the owner picked, by its `HarnessState.name`. A page from before the pick names
   * none, and the run goes to the laptop's host harness; one the laptop has not enabled fails.
   */
  harness?: string;
  /** The owner's page can show a question of the agent, so the agent may ask before an action (docs/decisions/harness-approvals.md). An older page never sets it. */
  asks?: true;
}

export interface RunReport {
  /**
   * "fixing" starts another round on the run's pull request, after CI failed, a conflict or a review
   * (R-030). "review" says someone other than the owner reviewed it, and the round waits for the
   * owner's go; its text holds their comments. "ended" says the watching stopped (D-105). "nocopy"
   * says the laptop has no folder of the request's repository, and the run waits for the owner to
   * have it cloned (R-036). Since R-042: "stale" says the card no longer holds, why in the note,
   * nothing was pushed, and the card is the change of its status the owner can add; "decision" says
   * the run waits for a decision nobody foresaw, whose draft is the card; "draft" hands the owner a
   * change the run asks of the board; "merged" says the draft was merged, so the owner's page
   * finishes the card and accepts its decisions (D-118); "closed" says it was closed unmerged, so the
   * owner's page gives the card back the status it had before the run. "progress" says in the note
   * what the run does now, at most every 30 seconds; "paused" says the owner stopped a run whose
   * work was unfinished, which keeps its worktree, branch, draft and session for their next words
   * (docs/decisions/stop-pauses-run.md). "planned" holds in the note the plan of a card that holds,
   * which waits for the owner's go or words before the claim commit (docs/decisions/redirect-plan-gate.md).
   * "note" puts a message in the run's thread and changes nothing, such as a screenshot (R-046).
   * "overlap" says the run waits because its files overlap those of an earlier draft, named in
   * `waits`, until the two card owners choose (docs/roadmap/new-overlap-gate.md).
   */
  kind: 'claimed' | 'done' | 'failed' | 'fixing' | 'review' | 'ended' | 'nocopy' | 'stale' | 'decision' | 'merged' | 'closed' | 'draft' | 'progress' | 'paused' | 'planned' | 'note' | 'overlap';
  request: number;
  /** What happened, in a line. */
  note?: string;
  /** For a run that is done: the branch it left, and the pull request it opened. */
  branch?: string;
  pull?: { repo: string; number: number };
  /** For a "stale", "decision" or "draft": the card or change the run asks the board for, which only the owner's page adds (D-104). */
  card?: CardDraftDTO;
  /** For a "merged": the Proposed decisions the work made true, which the owner's page marks Accepted (R-042). */
  decisions?: string[];
  /** For an "overlap": the card the earlier draft claims, such as K-12, or the draft itself, such as #12. */
  waits?: string;
}

/** The owner stops a run, or the watching of its pull request (R-030). The agent heeds only its owner. */
export interface RunCancel {
  kind: 'cancel';
  request: number;
}

/**
 * The owner's go for another round on a run's draft (D-105): after a review waits, or with their own
 * words in `note`, as when they reply after the draft is ready. The agent heeds only its owner.
 */
export interface RunFix {
  kind: 'fix';
  request: number;
  /** The review report it approves: only the text that report showed runs, never what came after. */
  review?: number;
  note?: string;
  sentAt: number;
}

/**
 * The owner has their agent clone a repository its laptop has no folder for, after a "nocopy"
 * report on the request; the run that waits for it then goes on (R-036, D-108). The agent heeds
 * only its owner, and clones only a repository one of their projects links.
 */
export interface RunClone {
  kind: 'clone';
  request: number;
  repo: string;
  sentAt: number;
}

/** A board card's status line, without "Status:" and its final period (D-082). */
export const cardStatus = (text: string) => /^Status:\s*(.*?)\.?\s*$/.exec(text.split('\n').filter((l) => l.trim())[1] ?? '')?.[1] ?? '';

/**
 * The brief a card's run follows, as the owner's page shows it and both sides hash it (D-105): the
 * card, then the decisions the team holds, without the superseded ones.
 */
export const briefText = (card: string, decisions: string[]) => [card.trim(), ...heldDecisions(decisions)].join('\n\n');

/** Whether the team holds a decision still, so a run follows it: every one but the superseded. */
export const isHeld = (decision: string) => !cardStatus(decision).toLowerCase().startsWith('superseded');

/** The decisions a run follows, each trimmed. */
export const heldDecisions = (decisions: string[]) => decisions.filter(isHeld).map((d) => d.trim());

/**
 * The owner's conversation with their agent, in their direct chat (R-035, D-102): a prompt, the
 * agent's answers, and the owner's replies and cancels. Each is a message of its own whose sealed
 * field names the conversation by its prompt's client id, which the sender signs, unlike the
 * server's message id. The text holds the words. The owner's page signs the send time into each of
 * its own, so the agent can refuse an old one played again (K-42).
 */
export type PromptDTO =
  // A prompt names its project's board and, unless the project links none, one of its repositories
  // (R-038), and the harness that answers, which every reply then resumes; none for the host harness.
  // `own` says the owner typed it, so it may run in their own setup; Check again never sets it (D-157).
  // `events` says the page shows the session's steps, which an older page would show as messages (R-072).
  // `card` asks for one checked draft of that kind, from the new card form's fields as they stand (R-071).
  // `model` and `mode` are the session's controls (R-072); a mode counts only in the user's own setup.
  | { kind: 'prompt'; repo?: string; sentAt: number; project?: number; harness?: string; asks?: true; own?: true; events?: true; card?: CardAskDTO; model?: string; mode?: PermissionMode }
  // A batch of the session's steps, in a message of kind `events` (R-072).
  | { kind: 'events'; to: string; events: SessionEventDTO[]; about?: SessionAboutDTO }
  // `handover` asks for a summary to hand the session to another harness, or, with the summary as
  // the user saw and edited it, hands it over (D-156).
  | { kind: 'reply'; to: string; sentAt: number; card?: CardAskDTO; model?: string; mode?: PermissionMode; handover?: { harness: string; summary?: string } }
  // The summary a harness wrote for handing its session over, which the user reads and may edit (D-156).
  | { kind: 'summary'; to: string; harness: string }
  | { kind: 'cancel'; to: string; sentAt: number }
  | { kind: 'answer'; to: string; card?: CardDraftDTO }
  | { kind: 'failed'; to: string }
  // The agent's laptop has no folder of the prompt's repository, and the turn waits for a clone; the
  // owner's clone has it made; a note says what the agent does meanwhile, and changes no state (R-036).
  | { kind: 'nocopy'; to: string }
  | { kind: 'clone'; to: string; repo: string; sentAt: number }
  | { kind: 'note'; to: string };

/** A session's permission mode in the user's own setup, as Claude Code names them (R-072). */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan';
export const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan'];

/** The new card form's fields as they stand, which ask the session for one draft of that kind (R-071). */
export interface CardAskDTO {
  kind: 'R' | 'K' | 'D';
  title: string;
  body: string;
}

/**
 * What a session runs with, as its harness and the agent know it, for the pane's head and its
 * details (R-072). Each field is left out when nobody can tell. `context` is the tokens the newest
 * turn sent the model.
 */
export interface SessionAboutDTO {
  model?: string;
  branch?: string;
  own?: boolean;
  plugins?: number;
  skills?: number;
  hooks?: number;
  mcp?: string[];
  context?: number;
  /** The harness's own commands and skills, which the box offers after a slash. */
  commands?: string[];
}

/**
 * One step of a harness session as its adapter saw it (R-072). Every field is the harness's own
 * text, which the page shows as plain text, never Markdown: a command can hide in it.
 */
export interface SessionEventDTO {
  kind: 'thinking' | 'read' | 'search' | 'command' | 'edit' | 'tool' | 'text' | 'plan';
  /** Its line: the command, the file, the pattern or the tool, or the text's first line. */
  title: string;
  /** The reasoning, the text, a command's output, an edit's change, or a plan's steps as `[x] Step` lines, cut to its end. */
  detail?: string;
  at: number;
}

/**
 * A board card an agent drafted when its owner asked (D-104): a new decision, idea or issue, or a
 * change to the card it replaces, named by its doc and section, with a hash of the text the agent
 * saw. It goes on the board only when the owner's page writes it. Since R-041 it says what the
 * agent's check read, and which cards, decisions or open pull requests (`#12`) it repeats or goes
 * against, each one the brief held (D-116).
 */
export interface CardDraftDTO {
  kind: 'D' | 'R' | 'K' | 'Q';
  title: string;
  body: string;
  replaces?: { card: string; doc: string; section: string; seen: string };
  checked?: string;
  related?: Array<{ id: string; kind: 'duplicate' | 'conflict'; why: string }>;
  /** A proposal's new status line for the card it changes, as its file in the repository says (R-040). */
  status?: string;
  /**
   * For the second card of a split, the title of the contract card drafted before it, which must be
   * on the board first: the page writes its number on the new card's After line (docs/roadmap/new-after-edge.md).
   */
  after?: string;
}

/**
 * How the owner's agent keeps a linked repository's `docs/roadmap.md` and `docs/decisions.md` as
 * copies of the board (R-040, D-117), sealed in the owner's direct chat with it. The owner's page
 * asks for the repository's entries when the owner links it, and imports them; the agent answers
 * in parts. Once a proposal file reaches the default branch, the agent sends it as a card draft,
 * and it names the cards that open pull requests claim, whose status the owner's page then sets.
 */
export type BoardSyncDTO =
  | { kind: 'link'; project: number; repo: string; sentAt: number }
  | { kind: 'entries'; to: string; part: number; parts: number; entries: string[] }
  | { kind: 'failed'; to: string }
  | { kind: 'proposal'; project: number; repo: string; card: CardDraftDTO }
  | { kind: 'claims'; project: number; repo: string; claims: Array<{ card: string; pull: number }> };

/**
 * A request about a board card, sent to the member asked in their direct chat with the asker, so
 * only they get a push (the card-notes decision). It names the card inside the sealed content only.
 */
export interface CardNoteDTO {
  kind: 'ready' | 'review' | 'waiting';
  card: string;
  docId: string;
  section: string;
}

/**
 * A request from the owner's laptop that the owner approves on their page, and the approval, in
 * their direct chat, sealed (docs/decisions/harness-linking.md, docs/decisions/connect-approval.md).
 * `kind` says what is asked; each kind has its own steps. The laptop's `request` names what it asks,
 * and the approval or decline names the request by its message's client id (`to`) with the signed
 * time it was sent. A connect's approval also signs the repository and the folder the owner saw.
 */
export type AskDTO =
  | { kind: 'link'; step: 'request'; harness: string }
  | { kind: 'connect'; step: 'request'; repo: string; folder: string }
  | { kind: 'link'; step: 'approve'; to: string; sentAt: number }
  | { kind: 'connect'; step: 'approve'; to: string; sentAt: number; repo: string; folder: string }
  | { kind: 'link' | 'connect'; step: 'decline'; to: string; sentAt: number }
  | { kind: 'link' | 'connect'; step: 'done' | 'failed'; to: string; note?: string };

/**
 * What an agent asks its owner before an action its harness would ask about, and the owner's answer,
 * in their direct chat, sealed (docs/decisions/harness-approvals.md). A question names its thread as
 * run reports and prompts do: `request` (the run request's message) for a card, `to` (the prompt's
 * client id) for a conversation. An answer and a `settled` name the question by its client id, which
 * its sender signs. The answer signs the time, and `seen`, a hash of what the owner saw.
 */
export type PermitDTO =
  | { kind: 'question'; request?: number; to?: string; what: 'run' | 'edit' | 'read' | 'fetch' | 'other'; detail: string; expires: number }
  | { kind: 'answer'; to: string; decision: 'once' | 'run' | 'deny'; seen: string; sentAt: number }
  | { kind: 'settled'; to: string; outcome: 'allowed' | 'allowedForRun' | 'denied' | 'expired' | 'stopped' | 'stale' };
