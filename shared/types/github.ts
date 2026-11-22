

/** Combined result of a pull request's checks on its newest commit. Null when it has none. */
export type PullChecks = 'success' | 'failure' | 'pending' | null;

/** GitHub's review decision. Null when the repository does not require reviews. */
export type PullReview = 'approved' | 'changes_requested' | 'review_required' | null;

export interface PullRequestDTO {
  /** GitHub's node id. */
  id: string;
  /** "owner/name". */
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  draft: boolean;
  review: PullReview;
  checks: PullChecks;
  /** The branch cannot merge without resolving conflicts. */
  conflicts: boolean;
  comments: number;
  /** Who wrote the newest comment, to skip alerts about one's own comments. */
  lastCommenter: string | null;
  additions: number;
  deletions: number;
  updatedAt: number;
  /**
   * Who still has to review, as GitHub logins. GitHub drops a person from the list once they
   * review. Teams are left out: reading them needs the read:org scope. Absent in lists stored
   * before WebChat read it.
   */
  reviewers?: string[];
  /** GitHub logins of the people assigned. Absent in lists stored before WebChat read it. */
  assignees?: string[];
  /** GitHub logins of the people whose newest review approves it. Absent in lists stored before WebChat read it. */
  approvedBy?: string[];
  /** The branch it merges from. Absent in lists stored before WebChat read it. */
  branch?: string;
  /** When it was merged, or null while it is not. Absent in lists stored before WebChat read it. */
  mergedAt?: number | null;
  /** True once it was closed or merged. Absent in lists stored before WebChat read it. */
  closed?: boolean;
}

/**
 * A pull request shared into a chat: a snapshot of how it stood when it was shared. It travels
 * inside the message's envelope, so the server never sees which pull request was shared.
 */
export interface PullCardDTO {
  /** "owner/name". */
  repo: string;
  number: number;
  title: string;
  /** Always the pull request's page on github.com; the page checks that before it shows a card. */
  url: string;
  draft: boolean;
  review: PullReview;
  checks: PullChecks;
  conflicts: boolean;
  /** As in PullRequestDTO. Absent on cards from before cards named reviewers, which then show none. */
  reviewers?: string[];
  assignees?: string[];
}

/** What a GitHub card says happened to a pull request. */
export type PullEvent = 'opened' | 'ready' | 'reopened' | 'merged' | 'closed';

/**
 * The body of a message of kind "github". The server writes it from GitHub's webhook into each
 * channel that links the repository, so it is plain text, not end-to-end encrypted (D-050).
 */
export interface GithubCardDTO {
  event: PullEvent;
  /** The pull request as GitHub described it at that moment. GitHub's webhook says nothing of checks or reviews. */
  pull: PullCardDTO;
  /** GitHub login of the person who opened it. */
  author: string | null;
  /** GitHub login of the person who marked it ready, merged, closed or reopened it. */
  actor: string | null;
}

/** A repository linked to a project through the GitHub App. Its pull requests go to the channel as cards. */
export interface ProjectRepoDTO {
  /** GitHub's id, which stays the same when the repository is renamed or moved. */
  repoId: number;
  /** "owner/name", as GitHub last named it. */
  repo: string;
  conversationId: number;
  addedBy: number | null;
  addedAt: number;
}

/** A repository the user just showed GitHub they reach through the app, so they can link it. */
export interface RepoChoiceDTO {
  repoId: number;
  repo: string;
}

export interface ProjectReposDTO {
  /** False until the server owner sets up the GitHub App. */
  configured: boolean;
  repos: ProjectRepoDTO[];
  /** For the project's owner after they signed in to the app: the repositories they can link. Empty otherwise. */
  choices: RepoChoiceDTO[];
}

/** Links a repository the owner can reach through the GitHub App to a channel. */
export interface LinkRepoInput {
  repoId: number;
  conversationId: number;
}

export interface PullListsDTO {
  /** Open pull requests that ask this user, or one of their teams, for a review. GitHub's search finds both. */
  reviewRequested: PullRequestDTO[];
  /** Open pull requests this user opened. */
  authored: PullRequestDTO[];
  /** This user's newest merged pull requests. Absent in lists stored before WebChat read it. */
  merged?: PullRequestDTO[];
  /**
   * The newest pull requests, open or not, whoever opened them, in the repositories linked to the
   * user's projects and those of their own open pull requests: the pane's All view. Absent in lists stored before WebChat read it.
   */
  team?: PullRequestDTO[];
  /**
   * Organizations that restrict OAuth Apps and have not approved WebChat. GitHub leaves their pull
   * requests out of the lists above, so the pane names them instead (K-6). Absent in lists stored
   * before WebChat read it.
   */
  hiddenOrganizations?: string[];
}

export type GithubEventKind =
  | 'review_requested'
  | 'approved'
  | 'changes_requested'
  | 'commented'
  | 'checks_failed'
  | 'checks_passed'
  | 'conflicts'
  | 'merged'
  | 'closed';

/** A change to a watched pull request, found by comparing two polls. */
export interface GithubEventDTO {
  id: number;
  kind: GithubEventKind;
  repo: string;
  number: number;
  title: string;
  url: string;
  /** The person behind the change, when GitHub says who it was. */
  actor: string | null;
  createdAt: number;
}

export interface GithubAccountDTO {
  login: string;
  name: string | null;
  /** Push alerts for pull request changes. */
  notify: boolean;
}

export interface GithubDTO {
  /** False until the server owner sets GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET. */
  configured: boolean;
  /** False until the server owner sets up the GitHub App that projects link repositories through. */
  appConfigured: boolean;
  /** Null while no GitHub account is connected. */
  account: GithubAccountDTO | null;
  pulls: PullListsDTO | null;
  /** Newest first. */
  events: GithubEventDTO[];
  /** When the pull requests were last fetched from GitHub. */
  fetchedAt: number | null;
  /** Why the last fetch failed, if it did. */
  error: string | null;
  /** True when GitHub refused the token: the user must connect again. */
  reconnect: boolean;
  /**
   * True while a timer or a scheduler has polled in the last 10 minutes, so alerts arrive with
   * every tab closed. False means they arrive only while a WebChat tab is open.
   */
  alertsWhileClosed: boolean;
}

/** A branch the user may open a pull request from: it has none yet. */
export interface BranchChoiceDTO {
  repo: string;
  /** The repository's default branch, which the pull request merges into. */
  base: string;
  branch: string;
  /** The headline of its newest commit, which becomes the pull request's title. */
  title: string;
  updatedAt: number;
}

/** Opens a draft pull request from a branch into its repository's default branch. */
export type OpenPullInput = Pick<BranchChoiceDTO, 'repo' | 'base' | 'branch' | 'title'>;

/** A GitHub repository as "owner/name". GitHub refuses "." and ".." as names, and the agent joins the name onto its clone folder, so they are refused here too. */
export const isRepoName = (name: string) => name.length <= 200 && /^(?!\.\.?\/)[\w.-]+\/(?!\.\.?$)[\w.-]+$/.test(name);
