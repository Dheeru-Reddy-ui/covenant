import type { RegisterView } from './register';

/**
 * The register's money headline. With a confirmed total, the total is the
 * heading and the sentence carries on from it ("£84,000.00 a year / renews by
 * itself ..."). Without one, the sentence starts with the contracts instead.
 */
export function moneyHeadline(money: RegisterView['money']): { heading: string; text: string } {
  const { days, totals, contracts, unvalued } = money;
  if (contracts === 0) return { heading: 'Nothing', text: `No contract renews by itself with a notice deadline in the next ${days} days.` };
  const one = contracts === 1;
  if (totals.length === 0) {
    return {
      heading: 'Value not confirmed',
      text:
        `${contracts} contract${one ? ' renews by itself' : 's renew by themselves'} unless notice is given in the next ${days} days. ` +
        `${one ? 'It has no' : 'None has a'} confirmed value yet, so there is no total.`,
    };
  }
  const left = unvalued > 0 ? ` ${unvalued} of them ${unvalued === 1 ? 'has' : 'have'} no confirmed value and ${unvalued === 1 ? 'is' : 'are'} not in the total.` : '';
  return {
    heading: totals.join(' and '),
    text: `renews by itself unless notice is given in the next ${days} days, across ${contracts} contract${one ? '' : 's'}.${left}`,
  };
}
