import { ProposalFace } from '@webchat/board-kit';

const open = () => undefined;
const drawer = { width: 760, display: 'grid', gap: 8 } as const;

// A draft from a proposal file: dashed, because it is not a card until its owner adds it.
export const NewCard = () => (
  <div style={drawer}>
    <ProposalFace title="Bark banner for iOS 15" tag="Proposal" repo="capstone" onOpen={open} />
  </div>
);

// A proposed change names the card it rewrites.
export const Change = () => (
  <div style={drawer}>
    <ProposalFace title="Search in channels" tag="Proposed change to R-12" repo="capstone" onOpen={open} />
  </div>
);
