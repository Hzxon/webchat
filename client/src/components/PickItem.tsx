import { useRef, type ReactNode } from 'react';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { ListItem } from '@astryxdesign/core/List';
import { Stack } from '@astryxdesign/core/Stack';

/** A list row with a checkbox; a tap anywhere on the row toggles it. */
export function PickItem({
  label,
  description,
  start,
  checked,
  onChange,
  isDisabled,
}: {
  label: string;
  description?: ReactNode;
  start?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  isDisabled?: boolean;
}) {
  const box = useRef<HTMLInputElement>(null);
  return (
    <ListItem
      interactiveRef={box}
      label={label}
      description={description}
      isDisabled={isDisabled}
      startContent={
        <Stack direction="horizontal" gap={3} vAlign="center">
          <CheckboxInput
            ref={box}
            label={label}
            isLabelHidden
            value={checked}
            onChange={onChange}
            isDisabled={isDisabled}
          />
          {start}
        </Stack>
      }
    />
  );
}
