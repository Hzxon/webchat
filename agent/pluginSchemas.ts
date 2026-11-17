

/** Cards and decisions a turn drafts, for its owner's page to add (D-104, D-116). */
export const DRAFTS = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['idea', 'issue', 'decision'] },
      title: { type: 'string' },
      body: { type: 'string', description: 'What goes under the title and the status line, in Markdown, shaped like the cards on the board.' },
      replaces: { type: 'string', description: 'The card or decision your draft changes, such as K-12 or D-3. Leave it out for a new one.' },
      checked: { type: 'string', description: 'One line on what your check read: the cards, the decisions, the code at which commit, and the open pull requests.' },
      related: {
        type: 'array',
        description: 'Each card, decision or open pull request that the draft repeats or goes against.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'A card or decision, such as K-12 or D-3, or a pull request, such as #12.' },
            kind: { type: 'string', enum: ['duplicate', 'conflict'] },
            why: { type: 'string', description: 'One sentence.' },
          },
          required: ['id', 'kind', 'why'],
        },
      },
    },
    required: ['kind', 'title', 'body', 'checked'],
  },
};

export const ANSWER = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['done', 'failed', 'decision'] },
    note: { type: 'string', description: 'One or two sentences on what you did, on what blocks you, or on the decision you need.' },
    title: { type: 'string', description: 'The draft pull request title, the first time the work is done.' },
    body: { type: 'string', description: 'The draft pull request body: what changed and why.' },
    drafts: { ...DRAFTS, description: 'The decision you need, or the changes to the board the work calls for.' },
    decisions: { type: 'array', items: { type: 'string' }, description: 'The Proposed decisions on the board that your work makes true, such as D-12.' },
  },
  required: ['outcome', 'note'],
};

/** How a run's first turn ends: whether the card still holds, and what the check read (R-042, D-107). */
export const CHECK = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['holds', 'stale'] },
    note: { type: 'string', description: 'For stale, why the card no longer holds, in one or two sentences.' },
    status: { type: 'string', enum: ['Done', 'Dropped'], description: 'For stale: Done when the code already does what the card asks, Dropped when a decision or another card rules it out or covers it.' },
    checked: { type: 'string', description: "One line on what your check read: the card's Checked line, the code at which commit, the decisions and the cards." },
    plan: { type: 'string', description: 'For holds: how you will do the work, in a few short lines: what you will change, and how you will test it.' },
  },
  required: ['outcome', 'note', 'checked'],
};

/**
 * How a conversation's turn ends (D-102), with drafts only when the owner asked for them (D-104):
 * a card, and the decision it needs, each with what the check before it read (D-116).
 */
export const REPLY = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'Your answer to your owner, in Markdown.' },
    drafts: { ...DRAFTS, description: 'Only when your owner asks you to draft a board card or decision, or a change to one: at most a card and the decision it needs.' },
  },
  required: ['reply'],
};
