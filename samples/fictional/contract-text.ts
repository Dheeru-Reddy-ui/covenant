// A fictional master services agreement, written for Covenant's tests and demos.
// Every party, person, address and figure here is invented. It is not legal advice
// and not based on any real agreement.

export interface Section {
  heading: string;
  paragraphs: string[];
}

export const CONTRACT_TITLE = 'MASTER SERVICES AGREEMENT';

/**
 * The clauses that carry dated obligations. Tests quote from these, so change
 * the wording here and the checks in scripts/make-samples.ts follow.
 */
export const KEY_CLAUSES = {
  term: 'This Agreement commences on 1 March 2025 (the "Effective Date") and, unless terminated earlier in accordance with its terms, continues for an initial term of two (2) years (the "Initial Term").',
  renewal:
    'This Agreement renews automatically for successive periods of one (1) year (each a "Renewal Term") unless either party gives the other written notice of non-renewal at least ninety (90) days before the end of the then-current term.',
  payment: 'Customer shall pay each undisputed invoice within thirty (30) days after the date of the invoice.',
  priceChange:
    'Supplier may increase the Fees no more than once in each contract year, with effect from an anniversary of the Effective Date, by giving Customer written notice at least sixty (60) days before that anniversary.',
  reporting:
    'Supplier shall deliver to Customer a written service level report within fifteen (15) business days after the end of each calendar quarter.',
  insurance:
    'Supplier shall deliver to Customer a certificate evidencing the insurance required by this clause within thirty (30) days after each anniversary of the Effective Date.',
  serviceCredit:
    'Customer must claim a Service Credit in writing within forty-five (45) days after the end of the calendar month in which the relevant failure occurred, after which the claim lapses.',
} as const;

const servicesSchedule = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => {
    const id = String(i + 1).padStart(2, '0');
    return `A.${id} Service component ${id}. Supplier shall provide the hosted route planning module identified as component ${id}, including configuration, routine maintenance, capacity monitoring and incident handling, in accordance with the service levels in Schedule B and the security requirements in Schedule C. Customer shall give Supplier the information and access reasonably needed to provide component ${id}, and shall name an operational contact for it within the onboarding period agreed in the project plan.`;
  });

const securitySchedule = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => {
    const id = String(i + 1).padStart(2, '0');
    return `C.${id} Control ${id}. Supplier shall maintain an administrative, technical and physical safeguard for control area ${id} that is appropriate to the nature of the Customer Data, shall review the safeguard whenever the Services change materially, and shall record the outcome of each review. Supplier shall make the record for control area ${id} available to Customer on reasonable written request, subject to the confidentiality obligations in this Agreement.`;
  });

export const SECTIONS: Section[] = [
  {
    heading: 'Parties',
    paragraphs: [
      'This Master Services Agreement (the "Agreement") is made between Tallowmere Freight Ltd, a company with its registered office at 14 Harbour Row, Port Ellery ("Customer"), and Quillfeather Systems BV, a company with its registered office at Lindenkade 7, Oosterwijk ("Supplier"). Customer and Supplier are each a "party" and together the "parties".',
      'Supplier provides hosted route planning software and related services. Customer wishes to receive those services on the terms of this Agreement.',
    ],
  },
  {
    heading: '1. Definitions',
    paragraphs: [
      '1.1 "Affiliate" means any entity that controls, is controlled by, or is under common control with a party, where control means ownership of more than half of the voting interests.',
      '1.2 "Business Day" means a day other than a Saturday, a Sunday or a public holiday in the place where the receiving party has its registered office.',
      '1.3 "Customer Data" means all data that Customer or its users submit to the Services.',
      '1.4 "Fees" means the charges set out in Schedule D, as adjusted in accordance with this Agreement.',
      '1.5 "Services" means the hosted software and related services described in Schedule A.',
      '1.6 "Service Credit" means a credit against future Fees calculated in accordance with Schedule B.',
      '1.7 Headings are for convenience only and do not affect how this Agreement is read. A reference to a clause or a schedule is to a clause of, or a schedule to, this Agreement.',
    ],
  },
  {
    heading: '2. Term and renewal',
    paragraphs: [
      `2.1 Term. ${KEY_CLAUSES.term}`,
      `2.2 Renewal. ${KEY_CLAUSES.renewal}`,
      '2.3 The Initial Term and each Renewal Term together are the "Term". The Fees for a Renewal Term are the Fees in effect at the end of the preceding term, unless changed under clause 4.',
    ],
  },
  {
    heading: '3. Fees and payment',
    paragraphs: [
      '3.1 Supplier shall invoice the Fees monthly in advance. Each invoice must identify the Services and the period it covers.',
      `3.2 ${KEY_CLAUSES.payment}`,
      '3.3 If Customer disputes part of an invoice in good faith, it shall tell Supplier in writing which part and why, and shall pay the undisputed part on time. The parties shall work together to resolve the dispute promptly.',
      '3.4 All amounts are stated exclusive of value added tax and similar taxes, which Customer shall pay where they apply.',
    ],
  },
  {
    heading: '4. Changes to the Fees',
    paragraphs: [
      `4.1 ${KEY_CLAUSES.priceChange}`,
      '4.2 An increase under clause 4.1 must not exceed five percent (5%) of the Fees in effect immediately before the increase.',
      '4.3 A notice under clause 4.1 that is given late has no effect for that anniversary.',
    ],
  },
  {
    heading: '5. Service levels, reports and credits',
    paragraphs: [
      '5.1 Supplier shall provide the Services so that they meet or exceed the service levels in Schedule B.',
      `5.2 ${KEY_CLAUSES.reporting} Each report must state the availability achieved, each incident of priority one or two, and any Service Credit that has accrued.`,
      `5.3 If Supplier fails to meet a service level, Customer is entitled to the Service Credit set out in Schedule B. ${KEY_CLAUSES.serviceCredit}`,
      '5.4 Service Credits are Customer\'s only financial remedy for a failure to meet a service level, without affecting its right to terminate under clause 9.',
    ],
  },
  {
    heading: '6. Insurance and audit',
    paragraphs: [
      '6.1 Supplier shall maintain, with a reputable insurer, professional indemnity and cyber liability insurance with a limit of not less than two million euros for each claim.',
      `6.2 ${KEY_CLAUSES.insurance}`,
      '6.3 Customer may audit Supplier\'s compliance with this Agreement no more than once in each contract year, on at least twenty (20) Business Days\' written notice, during normal working hours and without unreasonably disrupting Supplier\'s business.',
    ],
  },
  {
    heading: '7. Confidentiality',
    paragraphs: [
      '7.1 Each party shall keep the other party\'s confidential information secret, use it only to perform or receive the Services, and disclose it only to those of its staff and advisers who need to know it and are bound to protect it.',
      '7.2 Clause 7.1 does not apply to information that is public other than through a breach of this Agreement, that the receiving party already held lawfully, or that the law requires a party to disclose.',
    ],
  },
  {
    heading: '8. Data protection',
    paragraphs: [
      '8.1 Each party shall comply with the data protection laws that apply to it. Supplier shall process personal data in the Customer Data only on Customer\'s documented instructions and as set out in Schedule C.',
      '8.2 Supplier shall tell Customer without undue delay after becoming aware of a personal data breach affecting the Customer Data.',
    ],
  },
  {
    heading: '9. Termination',
    paragraphs: [
      '9.1 Either party may terminate this Agreement by written notice if the other party commits a material breach and, where the breach can be remedied, fails to remedy it within thirty (30) days after receiving written notice of it.',
      '9.2 On termination or expiry, Supplier shall make the Customer Data available for export for a period of sixty (60) days, after which Supplier shall delete it.',
    ],
  },
  {
    heading: '10. Liability',
    paragraphs: [
      '10.1 Nothing in this Agreement limits liability that cannot be limited by law.',
      '10.2 Subject to clause 10.1, each party\'s total liability under this Agreement in any contract year is limited to the Fees paid or payable in that contract year.',
    ],
  },
  {
    heading: '11. General',
    paragraphs: [
      '11.1 Notices. A notice under this Agreement must be in writing and sent to the address of the receiving party stated above, or to another address that party has notified. A notice sent by courier is received when it is delivered.',
      '11.2 This Agreement is the entire agreement between the parties about its subject matter. It may be changed only in writing signed by both parties.',
      '11.3 Neither party may assign this Agreement without the other\'s written consent, which must not be unreasonably withheld.',
      '11.4 This Agreement is governed by the laws stated in Schedule D, and the courts stated there have exclusive jurisdiction.',
    ],
  },
  { heading: 'Schedule A: Services', paragraphs: servicesSchedule(87) },
  {
    heading: 'Schedule B: Service levels',
    paragraphs: [
      'B.1 Availability. The Services shall be available at least 99.5% of the time in each calendar month, measured over the whole month and excluding planned maintenance of which Supplier has given at least five (5) Business Days\' notice.',
      'B.2 Service Credits. If availability in a calendar month is below 99.5% and at or above 99.0%, the Service Credit is 5% of the Fees for that month. If it is below 99.0%, the Service Credit is 10% of the Fees for that month.',
      'B.3 Incident response. Supplier shall respond to a priority one incident within one hour and to a priority two incident within four hours, in each case measured during the support hours stated in the project plan.',
    ],
  },
  { heading: 'Schedule C: Security', paragraphs: securitySchedule(87) },
  {
    heading: 'Schedule D: Fees and governing law',
    paragraphs: [
      'D.1 The Fees are eighteen thousand euros for each month of the Term, invoiced in accordance with clause 3.',
      'D.2 This Agreement is governed by the laws of the fictional jurisdiction of Port Ellery, and the courts of Port Ellery have exclusive jurisdiction.',
      'Signed for Tallowmere Freight Ltd by Imogen Ravensdale, Director. Signed for Quillfeather Systems BV by Pieter Vandermolen, Managing Director.',
    ],
  },
];
