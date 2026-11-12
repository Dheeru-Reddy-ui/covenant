import { invoke } from '@forge/bridge';
import {
  Box,
  Button,
  Checkbox,
  DatePicker,
  Inline,
  Label,
  LoadingButton,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  SectionMessage,
  Select,
  Stack,
  Text,
  Textfield,
  xcss,
} from '@forge/react';
import React, { useState } from 'react';
import type { ObligationView, Reply, RunView } from '../shared/panel';

/** The two edit dialogs. They send what the person typed; the resolvers validate it and explain any problem. */

interface Option {
  label: string;
  value: string;
}

const KINDS: Option[] = [
  { value: 'renewal_notice', label: 'Renewal notice' },
  { value: 'payment', label: 'Payment' },
  { value: 'price_change', label: 'Price change' },
  { value: 'reporting_deliverable', label: 'Report or deliverable' },
  { value: 'audit_insurance', label: 'Audit or insurance' },
  { value: 'service_credit', label: 'Service credit' },
];

const UNITS: Option[] = [
  { value: 'day', label: 'days' },
  { value: 'business_day', label: 'business days' },
  { value: 'week', label: 'weeks' },
  { value: 'month', label: 'months' },
  { value: 'year', label: 'years' },
];

const TERM_UNITS: Option[] = UNITS.filter((u) => u.value !== 'business_day');

const DIRECTIONS: Option[] = [
  { value: 'before', label: 'before' },
  { value: 'after', label: 'after' },
  { value: 'on', label: 'on' },
];

const ANCHORS: Option[] = [
  { value: 'term_end', label: 'the end of the current term' },
  { value: 'term_start', label: 'the start of the current term' },
  { value: 'effective_date', label: 'the effective date' },
  { value: 'period_end', label: 'the end of each period' },
  { value: 'period_start', label: 'the start of each period' },
  { value: 'anniversary', label: 'each anniversary of the effective date' },
  { value: 'event', label: 'an outside event' },
];

const pick = (options: Option[], value: string | null | undefined): Option | undefined => options.find((o) => o.value === value);

const quoteBox = xcss({ backgroundColor: 'color.background.neutral', padding: 'space.100', borderRadius: 'radius.medium' });

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <Stack space="space.050">
      <Label labelFor={id}>{label}</Label>
      {children}
    </Stack>
  );
}

const valueOf = (event: { target: { value?: unknown } }): string => String(event.target.value ?? '');

export function EditObligationModal({ item, onClose, onSaved }: { item: ObligationView; onClose: () => void; onSaved: () => void }) {
  const [summary, setSummary] = useState(item.summary);
  const [party, setParty] = useState(item.party);
  const [kind, setKind] = useState(item.kind);
  const [count, setCount] = useState(String(item.offset.count));
  const [unit, setUnit] = useState(item.offset.unit);
  const [direction, setDirection] = useState<string>(item.offset.direction);
  const [anchor, setAnchor] = useState(item.anchor);
  const [eventText, setEventText] = useState(item.anchorDescription ?? '');
  const [eventDate, setEventDate] = useState(item.eventDate ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    const offsetCount = direction === 'on' ? 0 : Number.parseInt(count, 10);
    const edit: Record<string, unknown> = {
      summary,
      responsibleParty: party,
      kind,
      anchor,
      offset: { count: Number.isFinite(offsetCount) ? offsetCount : -1, unit, direction },
    };
    if (anchor === 'event') {
      edit.anchorDescription = eventText;
      edit.eventDate = eventDate === '' ? null : eventDate;
    }
    const reply = (await invoke<Reply<null>>('obligation.edit', { obligationId: item.id, edit })) as Reply<null>;
    setSaving(false);
    if (reply.ok) onSaved();
    else setError(reply.error);
  };

  return (
    <Modal onClose={onClose} width="large">
      <ModalHeader>
        <ModalTitle>Check and edit this obligation</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.200">
          {item.clause && (
            <Box xcss={quoteBox}>
              <Text>“{item.clause.quote}”</Text>
            </Box>
          )}
          {item.secondReading && <Text>A second reading said: {item.secondReading}</Text>}
          <Field id="ob-summary" label="What must be done">
            <Textfield id="ob-summary" value={summary} onChange={(e) => setSummary(valueOf(e))} />
          </Field>
          <Inline space="space.200" shouldWrap>
            <Field id="ob-party" label="Who must do it">
              <Textfield id="ob-party" value={party} onChange={(e) => setParty(valueOf(e))} />
            </Field>
            <Field id="ob-kind" label="Kind">
              <Select inputId="ob-kind" options={KINDS} value={pick(KINDS, kind)} onChange={(o: Option) => setKind(o.value)} />
            </Field>
          </Inline>
          <Text>When it is due</Text>
          <Inline space="space.100" shouldWrap alignBlock="end">
            {direction !== 'on' && (
              <Field id="ob-count" label="How many">
                <Textfield id="ob-count" type="number" width={80} value={count} onChange={(e) => setCount(valueOf(e))} />
              </Field>
            )}
            {direction !== 'on' && (
              <Field id="ob-unit" label="Unit">
                <Select inputId="ob-unit" options={UNITS} value={pick(UNITS, unit)} onChange={(o: Option) => setUnit(o.value)} />
              </Field>
            )}
            <Field id="ob-direction" label="Before or after">
              <Select inputId="ob-direction" options={DIRECTIONS} value={pick(DIRECTIONS, direction)} onChange={(o: Option) => setDirection(o.value)} />
            </Field>
            <Field id="ob-anchor" label="Measured from">
              <Select inputId="ob-anchor" options={ANCHORS} value={pick(ANCHORS, anchor)} onChange={(o: Option) => setAnchor(o.value)} />
            </Field>
          </Inline>
          {anchor === 'event' && (
            <Inline space="space.200" shouldWrap>
              <Field id="ob-event" label="The event, in a few words">
                <Textfield id="ob-event" value={eventText} onChange={(e) => setEventText(valueOf(e))} />
              </Field>
              <Field id="ob-event-date" label="When it happened (optional)">
                <DatePicker id="ob-event-date" value={eventDate} onChange={(v: string) => setEventDate(v ?? '')} />
              </Field>
            </Inline>
          )}
          {error && (
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
          Save
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}

export function EditTermsModal({ run, onClose, onSaved }: { run: RunView; onClose: () => void; onSaved: () => void }) {
  const t = run.terms;
  const [effectiveDate, setEffectiveDate] = useState(t?.effectiveDate ?? '');
  const [termCount, setTermCount] = useState(t?.initialTerm ? String(t.initialTerm.count) : '');
  const [termUnit, setTermUnit] = useState(t?.initialTerm?.unit ?? 'year');
  const [termEnd, setTermEnd] = useState(t?.initialTermEnd ?? '');
  const [renewalCount, setRenewalCount] = useState(t?.renewalTerm ? String(t.renewalTerm.count) : '');
  const [renewalUnit, setRenewalUnit] = useState(t?.renewalTerm?.unit ?? 'year');
  const [autoRenew, setAutoRenew] = useState(t?.autoRenew ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const duration = (count: string, unit: string) => (count.trim() === '' ? null : { count: Number.parseInt(count, 10), unit });

  const save = async () => {
    setSaving(true);
    setError(null);
    const terms = {
      effectiveDate: effectiveDate === '' ? null : effectiveDate,
      initialTerm: duration(termCount, termUnit),
      initialTermEnd: termEnd === '' ? null : termEnd,
      renewalTerm: duration(renewalCount, renewalUnit),
    };
    const reply = (await invoke<Reply<null>>('terms.edit', { runId: run.id, terms, autoRenew })) as Reply<null>;
    setSaving(false);
    if (reply.ok) onSaved();
    else setError(reply.error);
  };

  return (
    <Modal onClose={onClose}>
      <ModalHeader>
        <ModalTitle>Contract terms</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.200">
          <Text>Every date Covenant works out hangs from these facts. Leave a field empty if the contract does not say.</Text>
          <Field id="terms-effective" label="Effective date">
            <DatePicker id="terms-effective" value={effectiveDate} onChange={(v: string) => setEffectiveDate(v ?? '')} />
          </Field>
          <Inline space="space.100" alignBlock="end" shouldWrap>
            <Field id="terms-length" label="Initial term">
              <Textfield id="terms-length" type="number" width={80} value={termCount} onChange={(e) => setTermCount(valueOf(e))} />
            </Field>
            <Field id="terms-unit" label="Unit">
              <Select inputId="terms-unit" options={TERM_UNITS} value={pick(TERM_UNITS, termUnit)} onChange={(o: Option) => setTermUnit(o.value)} />
            </Field>
            <Field id="terms-end" label="or ends on">
              <DatePicker id="terms-end" value={termEnd} onChange={(v: string) => setTermEnd(v ?? '')} />
            </Field>
          </Inline>
          <Inline space="space.100" alignBlock="end" shouldWrap>
            <Field id="terms-renewal" label="Each renewal term">
              <Textfield id="terms-renewal" type="number" width={80} value={renewalCount} onChange={(e) => setRenewalCount(valueOf(e))} />
            </Field>
            <Field id="terms-renewal-unit" label="Unit">
              <Select
                inputId="terms-renewal-unit"
                options={TERM_UNITS}
                value={pick(TERM_UNITS, renewalUnit)}
                onChange={(o: Option) => setRenewalUnit(o.value)}
              />
            </Field>
          </Inline>
          <Checkbox
            label="Renews automatically unless someone gives notice"
            isChecked={autoRenew}
            onChange={(e) => setAutoRenew(Boolean(e.target.checked))}
          />
          {error && (
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
          Save
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}
