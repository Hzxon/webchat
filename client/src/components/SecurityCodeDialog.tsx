import { useEffect, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { safetyCode } from '../../../shared/e2ee';
import { trustKeys } from '../chat';
import { keyring, type ChatConversation } from '../e2ee/keyring';
import { actions, useAppState } from '../store';
import { Dialog } from './Dialog';

interface CodeRow {
  userId: number;
  name: string;
  code: string[] | null;
}

/**
 * Shows the security code the user shares with each member. If both people see the same code,
 * nobody swapped their keys, so nobody in between can read the chat.
 */
export function SecurityCodeDialog({ conversation, onClose }: { conversation: ChatConversation; onClose: () => void }) {
  const me = useAppState((s) => s.me);
  const users = useAppState((s) => s.users);
  const warnings = useAppState((s) => s.keyWarnings);
  const [rows, setRows] = useState<CodeRow[]>([]);

  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    const others = conversation.members.filter((m) => m.userId !== me.id).map((m) => users[m.userId]);
    void Promise.all(
      others.map(async (user): Promise<CodeRow | null> => {
        if (!user) return null;
        const code = user.keys
          ? await safetyCode({ id: me.id, keys: keyring.myKeys() }, { id: user.id, keys: user.keys })
          : null;
        return { userId: user.id, name: user.displayName, code };
      }),
    ).then((list) => {
      if (!cancelled) setRows(list.filter((row): row is CodeRow => row !== null));
    });
    return () => {
      cancelled = true;
    };
  }, [conversation, me, users]);

  const verify = (row: CodeRow) => {
    const user = users[row.userId];
    if (!user) return;
    void trustKeys(user).then(() => actions.addToast({ conversationId: null, title: `Marked ${row.name} as verified`, body: 'This device trusts the code you compared.' }));
  };
  // A direct chat has one code, so the dialog names the person and its footer verifies them.
  const single = rows.length === 1 ? rows[0] : null;

  return (
    <Dialog title={single ? `Security code with ${single.name}` : 'Security codes'} onClose={onClose}>
      <Text as="p">
        {single
          ? `Compare this code with the one on ${single.name.split(' ')[0]}’s phone, in person or on a call. If they match, nobody is reading in between.`
          : 'Compare the code with each person, in person or on a call. If they match, nobody is reading in between.'}
      </Text>
      {rows.map((row) => (
        <Stack key={row.userId} as="section" gap={2}>
          {!single && (
            <Stack direction="horizontal" vAlign="center" hAlign="between">
              <Heading level={3}>{row.name}</Heading>
              {row.code && <Button size="sm" label="Mark as verified" onClick={() => verify(row)} />}
            </Stack>
          )}
          {row.code ? (
            <p className="security-code-digits" aria-label={`Security code with ${row.name}`}>
              {row.code.map((group, i) => (
                <span key={i}>{group}</span>
              ))}
            </p>
          ) : (
            <Text as="p" weight="semibold">
              {row.name} has not set up encryption yet.
            </Text>
          )}
          {warnings[row.userId] && (
            <Banner
              status="warning"
              title={`${row.name}’s security code changed since this device first saw it.`}
              description="If you did not expect this, compare the code with them before you mark them as verified."
            />
          )}
        </Stack>
      ))}
      {single?.code && (
        <Stack direction="horizontal" gap={2} hAlign="end">
          <Button label="Close" onClick={onClose} />
          <Button
            variant="primary"
            label="Mark as verified"
            onClick={() => {
              verify(single);
              onClose();
            }}
          />
        </Stack>
      )}
    </Dialog>
  );
}
