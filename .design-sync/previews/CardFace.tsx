import { CardFace } from '@webchat/board-kit';

const ann = { name: 'Ann Lee', seed: 1 };
const rafi = { name: 'Rafi Hart', seed: 3 };
const lane = { width: 280, padding: 8, borderRadius: 12, background: 'var(--lane)' } as const;
const open = () => undefined;
const pick = (
  <button type="button" className="board-small-button" onClick={open}>
    Pick
  </button>
);

// A Ready card nobody owns yet: the dashed circle, and Pick outside the button that opens it.
export const Ready = () => (
  <div style={lane}>
    <CardFace id="R-40" title="Export a chat as a file" text="Download a chat as Markdown, decrypted in the browser. The server never sees the file." owner={null} action={pick} onOpen={open} />
  </div>
);

// A card an agent runs, with its draft pull request at the right.
export const Running = () => (
  <div style={lane}>
    <CardFace id="R-35" title="Search in channels" text="The browser builds a search index from decrypted messages. The server never sees it." owner={ann} pull={{ number: 209, state: 'draft' }} onOpen={open} />
  </div>
);

// A card whose agent waits for an answer: tinted amber, with a solid "Asking you" chip.
export const AskingYou = () => (
  <div style={lane}>
    <CardFace
      id="K-12"
      title="Drop bad push keys"
      text="A 410 from the push service drops the key. The agent asks what to do about 404."
      owner={ann}
      chips={[{ tone: 'warn', label: 'Asking you' }]}
      pull={{ number: 214, state: 'draft' }}
      isWaiting
      onOpen={open}
    />
  </div>
);

// A card in review, and a finished one with its merged pull request.
export const InReviewAndDone = () => (
  <div style={{ ...lane, display: 'grid', gap: 8 }}>
    <CardFace id="R-31" title="Pin messages in channels" text="Pins are encrypted like messages and sync with the channel." owner={rafi} chips={[{ tone: 'muted', label: 'Approved' }]} pull={{ number: 205, state: 'review' }} onOpen={open} />
    <CardFace id="K-9" title="Cap push payloads at 3,000 bytes" owner={ann} pull={{ number: 198, state: 'merged' }} onOpen={open} />
  </div>
);

// A decision's face: its id, its title and its text, with no owner.
export const Decision = () => (
  <div style={lane}>
    <CardFace id="D-14" title="Messages are encrypted in the browser" text="The server never sees what people write." onOpen={open} />
  </div>
);
