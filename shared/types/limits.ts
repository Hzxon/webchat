

/** Response header that names the server's build. A tab reloads when the value changes. */
export const BUILD_HEADER = 'x-webchat-build';

/** Under Hobby's 2,000 Blob uploads a month and 1 GB stored, which the rest of the project shares (D-003, D-123). */
export const UPLOADS_PER_MONTH = 1800;
export const STORED_BYTES = 900 * 1024 * 1024;

export const LIMITS = {
  messageLength: 4000,
  /** Characters of the quoted message a reply carries. */
  quoteLength: 160,
  /**
   * Base64url ciphertext of the longest message with its quote, each character up to 4 UTF-8
   * bytes: that is under 17 KB, which pads to 32 KB (PAD_MIN_BYTES in shared/e2ee.ts), plus the
   * 16-byte tag.
   */
  ciphertextLength: 43_712,
  groupTitleLength: 60,
  projectNameLength: 60,
  channelNameLength: 40,
  /** People added to a project or group at once. Each needs every channel key, and requests stop at 256 KB. */
  addMembersAtOnce: 20,
  displayNameLength: 40,
  /** GitHub's own limit for a pull request title. */
  pullTitleLength: 256,
  /** Reviewers, and assignees, that the poll reads and a card names. */
  pullPeople: 10,
  /** Repositories one project links. Each pull request event in them becomes a message. */
  reposPerProject: 10,
  pageSize: 50,
  docTitleLength: 120,
  docSectionLength: 10_000,
  /**
   * Base64url ciphertext of the longest section: JSON escapes a UTF-16 unit to at most 6 bytes, so
   * it stays under 64 KB, which is its padding band, plus the 16-byte tag.
   */
  docCiphertextLength: 87_403,
  /** Sections a new doc starts with, from a template. */
  docSectionsAtOnce: 20,
  /** Revisions of a section that its history shows. */
  docHistory: 100,
  /** A run report's note, and a run request's card title. */
  runNoteLength: 1000,
  /** A branch name in a run report. */
  branchLength: 200,
  /** Repositories one laptop's check-in names (R-036). */
  agentRepos: 50,
  /** A card draft's check line, and its related cards with their reasons (R-041). */
  checkedLength: 500,
  relatedPerDraft: 10,
  relatedWhyLength: 300,
  /** Skills an agent offers its owner, and a skill's description, so its answer stays one message (R-039). */
  setupSkills: 40,
  skillDescriptionLength: 140,
  /** Harnesses an agent's answer lists, and the length of a name, a version, a path or a refusal (D-115). */
  harnesses: 8,
  harnessFieldLength: 500,
  /** A pairing's sealed picks, in base64url characters. */
  pairingPicks: 4096,
  /** A file's plain bytes (R-005, D-123); its ciphertext adds FILE_OVERHEAD in shared/e2ee.ts. */
  fileBytes: 10 * 1024 * 1024,
  /** A photo's longer side after the page resizes it. */
  photoPixels: 1600,
  /** A file's name, and its sealed preview as a data URL, small enough that a push still carries the envelope (D-017). */
  fileNameLength: 200,
  previewLength: 600,
  /** Days the server keeps a file's ciphertext; the message stays. */
  fileDays: 7,
  uploadsPerMonth: UPLOADS_PER_MONTH,
  storedBytes: STORED_BYTES,
  /** Each person's share of both, so one looping client cannot fill the store for everyone (D-123). */
  uploadsPerPerson: UPLOADS_PER_MONTH / 4,
  storedBytesPerPerson: STORED_BYTES / 4,
} as const;
