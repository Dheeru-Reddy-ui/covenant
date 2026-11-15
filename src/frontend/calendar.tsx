import {
  Box,
  Button,
  Heading,
  Inline,
  Label,
  LoadingButton,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  SectionMessage,
  Stack,
  Text,
  TextArea,
  Textfield,
  xcss,
} from '@forge/react';
import React, { useState } from 'react';
import type { CalendarView } from '../shared/panel';
import type { RunAction } from './brief';

/**
 * The contract's holiday list: which days, besides weekends, do not count as
 * business days. The rule in force is always on screen, because a
 * business-day deadline is only as right as its calendar.
 */

const card = xcss({ borderColor: 'color.border', borderWidth: 'border.width', borderStyle: 'solid', borderRadius: 'radius.medium', padding: 'space.200' });

function EditModal({ contractId, calendar, onClose, run }: { contractId: string; calendar: CalendarView; onClose: () => void; run: RunAction }) {
  const [name, setName] = useState(calendar.holidays.length > 0 ? calendar.name : '');
  const [text, setText] = useState(calendar.holidays.map((h) => `${h.date}${h.label ? ` ${h.label}` : ''}`).join('\n'));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    const failed = await run('contract.setCalendar', { contractId, name, text }, (data) => {
      const d = data as { holidays: number; moved: number };
      return `Holiday list saved: ${d.holidays} holiday${d.holidays === 1 ? '' : 's'}. ${d.moved} date${d.moved === 1 ? '' : 's'} changed.`;
    });
    setSaving(false);
    if (failed === null) onClose();
    else setError(failed);
  };
  return (
    <Modal onClose={onClose}>
      <ModalHeader>
        <ModalTitle>Holidays for this contract</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.200">
          <Text>
            Business days are Monday to Friday, minus the days you list here. Use the holidays of the place the contract names, or of its governing law. Covenant
            ships no list of its own, because a wrong one would move deadlines without anyone noticing.
          </Text>
          <Stack space="space.050">
            <Label labelFor="calendar-name">Name of the list</Label>
            <Textfield id="calendar-name" value={name} placeholder="England and Wales, 2026 to 2027" onChange={(e) => setName(String(e.target.value ?? ''))} />
          </Stack>
          <Stack space="space.050">
            <Label labelFor="calendar-days">One holiday per line: the date as YYYY-MM-DD, then what it is</Label>
            <TextArea id="calendar-days" value={text} placeholder={'2026-12-25 Christmas Day\n2027-01-01 New Year\'s Day'} minimumRows={8} onChange={(e) => setText(String(e.target.value ?? ''))} />
          </Stack>
          <Text size="small">Leave the list empty to count weekends only. Dates already on approved work items stay as they are until you move them.</Text>
          {error !== null && (
            <SectionMessage appearance="error">
              <Text>{error}</Text>
            </SectionMessage>
          )}
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button appearance="subtle" onClick={onClose}>
          Cancel
        </Button>
        <LoadingButton appearance="primary" isLoading={saving} onClick={save}>
          Save holidays
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}

export function HolidayCalendar({ contractId, calendar, run }: { contractId: string; calendar: CalendarView; run: RunAction }) {
  const [editing, setEditing] = useState(false);
  return (
    <Box xcss={card}>
      <Stack space="space.100">
        <Inline space="space.100" alignBlock="center" spread="space-between">
          <Heading size="xsmall">Business days</Heading>
          <Button appearance="subtle" onClick={() => setEditing(true)}>
            Edit holidays
          </Button>
        </Inline>
        <Text>{calendar.rule}</Text>
        <Text size="small">
          {calendar.usedBy === 0
            ? 'No deadline in this contract is counted in business days, so the list changes nothing yet.'
            : `${calendar.usedBy} deadline${calendar.usedBy === 1 ? ' in this contract is' : 's in this contract are'} counted in business days and use${calendar.usedBy === 1 ? 's' : ''} this rule.`}
        </Text>
      </Stack>
      {editing && <EditModal contractId={contractId} calendar={calendar} onClose={() => setEditing(false)} run={run} />}
    </Box>
  );
}
