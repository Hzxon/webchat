// What a new doc starts with. Each string is one section, so team members can each take one.

interface DocTemplate {
  name: string;
  description: string;
  sections: string[];
}

export const DOC_TEMPLATES: DocTemplate[] = [
  {
    name: 'Blank',
    description: 'One empty section.',
    sections: [''],
  },
  {
    name: 'Product requirements (PRD)',
    description: 'The problem, who has it, and what the product must do.',
    sections: [
      '## Problem\n\nWhat problem do users have today, and why does it matter?',
      '## Goals\n\n- \n\n## Non-goals\n\n- ',
      '## Users and stories\n\n- As a …, I want …, so that …',
      '## Requirements\n\n| # | Requirement | Priority |\n| --- | --- | --- |\n| 1 |  | Must |',
      '## Success metrics\n\n- ',
      '## Open questions\n\n- [ ] ',
    ],
  },
  {
    name: 'Technical spec',
    description: 'How the team will build it, and why this way.',
    sections: [
      '## Context\n\nWhat exists today, and what has to change.',
      '## Proposal\n\nHow it works.',
      '## Alternatives\n\nWhat else was considered, and why not.',
      '## Data and interfaces\n\n',
      '## Risks\n\n- ',
      '## Plan\n\n- [ ] ',
    ],
  },
  {
    name: 'Meeting notes',
    description: 'Agenda, decisions and who does what by when.',
    sections: [
      '## Attendees\n\n- ',
      '## Agenda\n\n1. ',
      '## Notes\n\n',
      '## Decisions\n\n- ',
      '## Action items\n\n- [ ] Who: what, by when',
    ],
  },
  {
    name: 'Project proposal',
    description: 'What the team will deliver, for the lecturer.',
    sections: [
      '## Summary\n\n',
      '## Background\n\n',
      '## Objectives\n\n- ',
      '## Scope\n\n**In:**\n\n- \n\n**Out:**\n\n- ',
      '## Deliverables and schedule\n\n| Week | Deliverable |\n| --- | --- |\n| 1 |  |',
      '## Team and roles\n\n- ',
    ],
  },
];
