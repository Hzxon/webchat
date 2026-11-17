import { useEffect, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Divider } from '@astryxdesign/core/Divider';
import { Heading } from '@astryxdesign/core/Heading';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { safetyCode } from '../../../shared/e2ee';
import { trustKeys } from '../chat';
import { keyring, type ChatConversation } from '../e2ee/keyring';
import { useAppState } from '../store';
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

  return (
    <Dialog title="Security codes" onClose={onClose}>
      <Text as="p" color="secondary">
        Messages in this chat are end-to-end encrypted. Compare the code with each person, in person or on a call. If it
        matches on both phones, no one in between, not even the server, can read your messages.
      </Text>
      {rows.map((row) => (
        <Stack key={row.userId} as="section" gap={2}>
          <Divider />
          <Heading level={3}>{row.name}</Heading>
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
              description="If you did not expect this, ask them before you trust it."
              endContent={
                <Button
                  label="I checked the code, trust it"
                  onClick={() => {
                    const user = users[row.userId];
                    if (user) void trustKeys(user);
                  }}
                />
              }
            />
          )}
        </Stack>
      ))}
    </Dialog>
  );
}
