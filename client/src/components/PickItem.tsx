import { useRef, type ReactNode } from 'react';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { ListItem } from '@astryxdesign/core/List';
import { Stack } from '@astryxdesign/core/Stack';

/** A list row with a checkbox, at its start or its end; a tap anywhere on the row toggles it. */
export function PickItem({
  label,
  description,
  start,
  checked,
  onChange,
  isDisabled,
  isCheckboxEnd,
}: {
  label: string;
  description?: ReactNode;
  start?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  isDisabled?: boolean;
  isCheckboxEnd?: boolean;
}) {
  const box = useRef<HTMLInputElement>(null);
  const checkbox = <CheckboxInput ref={box} label={label} isLabelHidden value={checked} onChange={onChange} isDisabled={isDisabled} />;
  return (
    <ListItem
      interactiveRef={box}
      label={label}
      description={description}
      isDisabled={isDisabled}
      startContent={
        isCheckboxEnd ? (
          start
        ) : (
          <Stack direction="horizontal" gap={3} vAlign="center">
            {checkbox}
            {start}
          </Stack>
        )
      }
      endContent={isCheckboxEnd ? checkbox : undefined}
    />
  );
}
