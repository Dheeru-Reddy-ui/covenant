// The sample workspace: three fictional contracts and the work around them, for demos
// and for judges on a clean site. Every party, person and figure is invented.
//
// Dates are set relative to the day the workspace is loaded, so the renewal notice
// deadlines always land about 20, 50 and 85 days ahead: one in each of the register's
// 30, 60 and 90 day views, whenever it is installed. No CUAD text is used.
import { type IsoDate, addDays, addMonths } from '../../packages/core/src';
import type { Section } from './contract-text';

export interface SampleRelated {
  summary: string;
  /** "incident" items get an incident-like type when the project has one, and the label "incident". */
  kind: 'task' | 'incident';
  description: string;
}

export interface SampleContract {
  slug: string;
  workItemSummary: string;
  fileName: string;
  title: string;
  sections: Section[];
  /** Clauses the parsed file must contain word for word. */
  keyClauses: Record<string, string>;
  related: SampleRelated[];
  /** For the check script only: when the notice deadline should land. */
  expectedNoticeDeadline: IsoDate;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "1 March 2025": the way these contracts write dates. */
export function writtenDate(date: IsoDate): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

const signature = (a: string, b: string): Section => ({
  heading: 'Signatures',
  paragraphs: [`Signed for ${a} by an authorised signatory. Signed for ${b} by an authorised signatory.`],
});

function quillfeather(today: IsoDate): SampleContract {
  // Two-year term, 90 days' notice: deadline = (effective + 2 years - 1 day) - 90 days = today + 20.
  const effective = addMonths(addDays(today, 111), -24);
  const key = {
    term: `This Agreement commences on ${writtenDate(effective)} (the "Effective Date") and, unless terminated earlier in accordance with its terms, continues for an initial term of two (2) years (the "Initial Term").`,
    renewal:
      'This Agreement renews automatically for successive periods of one (1) year (each a "Renewal Term") unless either party gives the other written notice of non-renewal at least ninety (90) days before the end of the then-current term.',
    payment: 'Customer shall pay each undisputed invoice within thirty (30) days after the date of the invoice.',
    reporting:
      'Supplier shall deliver to Customer a written service level report within fifteen (15) business days after the end of each calendar quarter.',
    insurance:
      'Supplier shall deliver to Customer a certificate evidencing the insurance required by this clause within thirty (30) days after each anniversary of the Effective Date.',
  };
  return {
    slug: 'quillfeather',
    workItemSummary: 'Contract: Quillfeather Systems route planning MSA',
    fileName: 'sample-quillfeather-msa.docx',
    title: 'MASTER SERVICES AGREEMENT',
    keyClauses: key,
    expectedNoticeDeadline: addDays(today, 20),
    sections: [
      {
        heading: 'Parties',
        paragraphs: [
          'This Master Services Agreement (the "Agreement") is made between Tallowmere Freight Ltd ("Customer") and Quillfeather Systems BV ("Supplier"). This is a fictional agreement written for testing.',
          'Supplier provides hosted route planning software. Customer wishes to receive it on the terms below.',
        ],
      },
      { heading: '1. Term and renewal', paragraphs: [`1.1 ${key.term}`, `1.2 ${key.renewal}`] },
      {
        heading: '2. Fees and payment',
        paragraphs: ['2.1 Supplier shall invoice the Fees monthly in advance.', `2.2 ${key.payment}`],
      },
      {
        heading: '3. Service levels and reports',
        paragraphs: ['3.1 The Services shall be available at least 99.5% of the time in each calendar month.', `3.2 ${key.reporting}`],
      },
      { heading: '4. Insurance', paragraphs: ['4.1 Supplier shall maintain professional indemnity insurance of at least two million euros.', `4.2 ${key.insurance}`] },
      {
        heading: '5. General',
        paragraphs: ['5.1 Notices must be in writing and sent to the address of the receiving party.', '5.2 This Agreement is governed by the laws of the fictional jurisdiction of Port Ellery.'],
      },
      signature('Tallowmere Freight Ltd', 'Quillfeather Systems BV'),
    ],
    related: [
      {
        summary: 'Quarterly service review with Quillfeather Systems',
        kind: 'task',
        description: 'Review route planning availability, open incidents and the last service level report with Quillfeather.',
      },
      {
        summary: 'Incident: route planning unavailable for three hours',
        kind: 'incident',
        description: 'Drivers could not load routes from 07:10 to 10:05. Quillfeather confirmed a failed database upgrade.',
      },
      {
        summary: 'Collect Quillfeather insurance certificate',
        kind: 'task',
        description: 'Ask Quillfeather for this year’s professional indemnity certificate.',
      },
    ],
  };
}

function brightwell(today: IsoDate): SampleContract {
  // One-year term, 60 days' notice: deadline = (effective + 1 year - 1 day) - 60 days = today + 50.
  const effective = addMonths(addDays(today, 111), -12);
  const key = {
    term: `This Agreement commences on ${writtenDate(effective)} (the "Effective Date") and continues for an initial term of one (1) year.`,
    renewal:
      'This Agreement renews automatically for successive periods of one (1) year unless either party gives the other written notice of termination at least sixty (60) days before the end of the then-current term.',
    payment: 'Customer shall pay each invoice within forty-five (45) days after the date of the invoice.',
    priceChange:
      'Contractor may increase the Fees with effect from an anniversary of the Effective Date by giving Customer written notice at least thirty (30) days before that anniversary.',
    insurance:
      'Contractor shall deliver to Customer a copy of its current public liability insurance certificate within fourteen (14) days after each anniversary of the Effective Date.',
  };
  return {
    slug: 'brightwell',
    workItemSummary: 'Contract: Brightwell Facility Care cleaning services',
    fileName: 'sample-brightwell-facilities.docx',
    title: 'FACILITIES SERVICES AGREEMENT',
    keyClauses: key,
    expectedNoticeDeadline: addDays(today, 50),
    sections: [
      {
        heading: 'Parties',
        paragraphs: [
          'This Facilities Services Agreement (the "Agreement") is made between Tallowmere Freight Ltd ("Customer") and Brightwell Facility Care Ltd ("Contractor"). This is a fictional agreement written for testing.',
          'Contractor provides cleaning and caretaking at Customer’s depots listed in the Schedule.',
        ],
      },
      { heading: '1. Term', paragraphs: [`1.1 ${key.term}`, `1.2 ${key.renewal}`] },
      { heading: '2. Fees', paragraphs: [`2.1 ${key.payment}`, `2.2 ${key.priceChange}`] },
      { heading: '3. Insurance', paragraphs: [`3.1 ${key.insurance}`] },
      { heading: '4. Standards', paragraphs: ['4.1 Contractor shall clean each depot to the standard in the Schedule and keep a log of each visit.'] },
      signature('Tallowmere Freight Ltd', 'Brightwell Facility Care Ltd'),
    ],
    related: [
      {
        summary: 'Site walk-round with Brightwell at the Harbour Row depot',
        kind: 'task',
        description: 'Walk the depot with Brightwell’s supervisor and agree fixes for the missed areas.',
      },
      {
        summary: 'Incident: Harbour Row depot not cleaned for two nights',
        kind: 'incident',
        description: 'Night shift reported no cleaning visit on two consecutive nights. Brightwell blamed a staffing gap.',
      },
    ],
  };
}

function corvane(today: IsoDate): SampleContract {
  // Three-year term, 120 days' notice: deadline = (effective + 3 years - 1 day) - 120 days = today + 85.
  const effective = addMonths(addDays(today, 206), -36);
  const key = {
    term: `This Agreement commences on ${writtenDate(effective)} (the "Effective Date") and continues for an initial term of three (3) years.`,
    renewal:
      'Thereafter this Agreement renews automatically for successive renewal terms of one (1) year each, unless the Licensee gives the Licensor written notice of non-renewal at least one hundred and twenty (120) days before the end of the then-current term.',
    payment: 'The Licensee shall pay the annual licence fee within thirty (30) days after each anniversary of the Effective Date.',
    serviceCredit:
      'The Licensee must claim any service credit in writing within thirty (30) days after the end of the calendar quarter in which the service level was missed.',
    reporting: 'The Licensor shall deliver to the Licensee an annual security report within sixty (60) days after the end of each calendar year.',
  };
  return {
    slug: 'corvane',
    workItemSummary: 'Contract: Corvane Analytics software licence and support',
    fileName: 'sample-corvane-licence.docx',
    title: 'SOFTWARE LICENCE AND SUPPORT AGREEMENT',
    keyClauses: key,
    expectedNoticeDeadline: addDays(today, 85),
    sections: [
      {
        heading: 'Parties',
        paragraphs: [
          'This Software Licence and Support Agreement (the "Agreement") is made between Corvane Analytics GmbH (the "Licensor") and Tallowmere Freight Ltd (the "Licensee"). This is a fictional agreement written for testing.',
        ],
      },
      { heading: '1. Term', paragraphs: [`1.1 ${key.term}`, `1.2 ${key.renewal}`] },
      { heading: '2. Licence fee', paragraphs: [`2.1 ${key.payment}`] },
      {
        heading: '3. Support and service levels',
        paragraphs: ['3.1 The Licensor shall answer priority one support requests within one hour.', `3.2 ${key.serviceCredit}`],
      },
      { heading: '4. Security', paragraphs: [`4.1 ${key.reporting}`] },
      signature('Corvane Analytics GmbH', 'Tallowmere Freight Ltd'),
    ],
    related: [
      {
        summary: 'Plan the Corvane licence true-up',
        kind: 'task',
        description: 'Count active analytics users and compare them with the licensed number before the renewal decision.',
      },
      {
        summary: 'Corvane support backlog review',
        kind: 'task',
        description: 'Go through open Corvane support requests and note any missed response times for service credits.',
      },
    ],
  };
}

export function sampleWorkspace(today: IsoDate): SampleContract[] {
  return [quillfeather(today), brightwell(today), corvane(today)];
}
