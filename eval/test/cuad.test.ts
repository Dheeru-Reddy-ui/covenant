import { describe, expect, it } from 'vitest';
import { type CuadContract, DEV_SAMPLE, EVAL_SAMPLE, buildCuad, joinKey, parseCsv, selectSample } from '../src/cuad';

describe('parseCsv', () => {
  it('handles quoted commas, doubled quotes, newlines and CRLF', () => {
    const text = 'a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\nlast,,\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
      ['last', '', ''],
    ]);
  });
});

describe('buildCuad', () => {
  const json = {
    data: [
      {
        title: "ACME,INC_01_01_2020-EX-10.1-SUPPLY AGREEMENT",
        paragraphs: [
          {
            context: 'This Agreement is effective as of January 1, 2020. Either party may give 90 days notice.',
            qas: [
              { id: 'ACME,INC_01_01_2020-EX-10.1-SUPPLY AGREEMENT__Effective Date', answers: [{ text: 'January 1, 2020', answer_start: 34 }] },
              { id: 'ACME,INC_01_01_2020-EX-10.1-SUPPLY AGREEMENT__Notice Period To Terminate Renewal', answers: [] },
            ],
          },
        ],
      },
    ],
  };
  const csv = [
    'Filename,Effective Date-Answer,Expiration Date-Answer,Renewal Term-Answer,Notice Period To Terminate Renewal- Answer',
    '"ACME,INC_01_01_2020-EX-10.1-SUPPLY AGREEMENT.pdf",1/1/20,perpetual,,90 days',
    'ORPHAN.pdf,,,,',
  ].join('\n');

  it('joins the JSON text and spans to the CSV answers, whatever the punctuation', () => {
    const { contracts, unmatched } = buildCuad(json, csv);
    expect(unmatched).toBe(1);
    expect(contracts).toHaveLength(1);
    const [c] = contracts;
    expect(c?.answers).toEqual({
      'Effective Date': '1/1/20',
      'Expiration Date': 'perpetual',
      'Renewal Term': '',
      'Notice Period To Terminate Renewal': '90 days',
    });
    expect(c?.spans['Effective Date']).toEqual([{ start: 34, end: 49 }]);
    expect(c?.text.slice(34, 49)).toBe('January 1, 2020');
    expect(c?.spans['Renewal Term']).toEqual([]);
  });

  it('matches names that differ only in punctuation and extension', () => {
    expect(joinKey("KALLOINC_11_03_2011-EX-10.1-STRATEGIC ALLIANCE AGREEMENT.PDF'")).toBe(joinKey('KALLOINC_11_03_2011-EX-10.1-STRATEGIC ALLIANCE AGREEMENT'));
  });
});

describe('selectSample', () => {
  const contract = (i: number, notice: boolean, chars = 1000): CuadContract => ({
    id: `C${String(i).padStart(3, '0')}`,
    text: 'x'.repeat(chars),
    spans: { 'Effective Date': [], 'Expiration Date': [], 'Renewal Term': [], 'Notice Period To Terminate Renewal': [] },
    answers: { 'Effective Date': '', 'Expiration Date': '', 'Renewal Term': '', 'Notice Period To Terminate Renewal': notice ? '30 days' : '' },
  });
  const pool = [
    ...Array.from({ length: 40 }, (_, i) => contract(i, true)),
    ...Array.from({ length: 60 }, (_, i) => contract(100 + i, false)),
    contract(999, true, 500_000), // too long for the product's scope
  ];

  it('draws half with a notice-period answer and half without, from in-scope contracts only', () => {
    const sample = selectSample(pool, EVAL_SAMPLE);
    expect(sample).toHaveLength(30);
    expect(sample.filter((c) => c.answers['Notice Period To Terminate Renewal'] !== '')).toHaveLength(15);
    expect(sample.some((c) => c.id === 'C999')).toBe(false);
  });

  it('is the same sample on every run, whatever the input order', () => {
    const a = selectSample(pool, EVAL_SAMPLE).map((c) => c.id);
    const b = selectSample([...pool].reverse(), EVAL_SAMPLE).map((c) => c.id);
    expect(a).toEqual(b);
  });

  it('keeps the dev contracts apart from the scored ones', () => {
    const scored = new Set(selectSample(pool, EVAL_SAMPLE).map((c) => c.id));
    const dev = selectSample(pool, DEV_SAMPLE, 'dev');
    expect(dev).toHaveLength(10);
    expect(dev.filter((c) => scored.has(c.id))).toEqual([]);
  });
});
