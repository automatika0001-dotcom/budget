/* US take-home pay estimate, tax year 2026.
   Federal: IRS Rev. Proc. 2025-32 (brackets, standard deduction), Social Security 6.2% to $184,500, Medicare 1.45% + 0.9% above $200k/$250k.
   States: Tax Foundation "State Individual Income Tax Rates and Brackets, 2026" (as of Feb 11, 2026).
   Not included: local/city income taxes, state disability/family leave payroll deductions, credit phase-outs. It is an estimate. */
(function (root) {
  'use strict';
  const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  // brackets: [[start, rate], ...]
  const FED = {
    std: { single: 16100, married: 32200, head: 24150 },
    brackets: {
      single: [[0, .10], [12400, .12], [50400, .22], [105700, .24], [201775, .32], [256225, .35], [640600, .37]],
      married: [[0, .10], [24800, .12], [100800, .22], [211400, .24], [403550, .32], [512450, .35], [768700, .37]],
      head: [[0, .10], [17700, .12], [67450, .22], [105700, .24], [201750, .32], [256200, .35], [640600, .37]]
    },
    childCredit: 2200, childPhaseout: { single: 200000, married: 400000, head: 200000 }
  };
  const FICA = { ss: .062, ssBase: 184500, med: .0145, addl: .009, addlFrom: { single: 200000, married: 250000, head: 200000 } };

  // s: single brackets, m: married brackets, std: [single, married], ex: [single, married, per dependent] (deductions),
  // cr: [single, married, per dependent] (credits, subtracted from tax), stdCr: standard deduction given as a credit
  const P = (pairs) => pairs.map(([a, r]) => [a, r / 100]);
  const STATES = {
    AL: { n: 'Alabama', s: P([[0, 2], [500, 4], [3000, 5]]), m: P([[0, 2], [1000, 4], [6000, 5]]), std: [3000, 8500], ex: [1500, 3000, 1000] },
    AK: { n: 'Alaska', none: true },
    AZ: { n: 'Arizona', s: P([[0, 2.5]]), std: [8350, 16700], cr: [0, 0, 100] },
    AR: { n: 'Arkansas', s: P([[0, 2], [4600, 3.9]]), std: [2470, 4940], cr: [29, 58, 29] },
    CA: { n: 'California', s: P([[0, 1], [11079, 2], [26264, 4], [41452, 6], [57542, 8], [72724, 9.3], [371479, 10.3], [445771, 11.3], [742953, 12.3], [1000000, 13.3]]),
      m: P([[0, 1], [22158, 2], [52528, 4], [82904, 6], [115084, 8], [145448, 9.3], [742958, 10.3], [891542, 11.3], [1000000, 12.3], [1485906, 13.3]]), std: [5540, 11080], cr: [153, 306, 153] },
    CO: { n: 'Colorado', s: P([[0, 4.4]]), std: [16100, 32200] },
    CT: { n: 'Connecticut', s: P([[0, 2], [10000, 4.5], [50000, 5.5], [100000, 6], [200000, 6.5], [250000, 6.9], [500000, 6.99]]),
      m: P([[0, 2], [20000, 4.5], [100000, 5.5], [200000, 6], [400000, 6.5], [500000, 6.9], [1000000, 6.99]]), ex: [15000, 24000, 0] },
    DE: { n: 'Delaware', s: P([[0, 0], [2000, 2.2], [5000, 3.9], [10000, 4.8], [20000, 5.2], [25000, 5.55], [60000, 6.6]]), std: [3250, 6500], cr: [110, 220, 110] },
    DC: { n: 'District of Columbia', s: P([[0, 4], [10000, 6], [40000, 6.5], [60000, 8.5], [250000, 9.25], [500000, 9.75], [1000000, 10.75]]), std: [16100, 32200] },
    FL: { n: 'Florida', none: true },
    GA: { n: 'Georgia', s: P([[0, 5.19]]), std: [12000, 24000], ex: [0, 0, 4000] },
    HI: { n: 'Hawaii', s: P([[0, 1.4], [9600, 3.2], [14400, 5.5], [19200, 6.4], [24000, 6.8], [36000, 7.2], [48000, 7.6], [125000, 7.9], [175000, 8.25], [225000, 9], [275000, 10], [325000, 11]]),
      m: P([[0, 1.4], [19200, 3.2], [28800, 5.5], [38400, 6.4], [48000, 6.8], [72000, 7.2], [96000, 7.6], [250000, 7.9], [350000, 8.25], [450000, 9], [550000, 10], [650000, 11]]), std: [4400, 8800], ex: [1144, 2288, 1144] },
    ID: { n: 'Idaho', s: P([[0, 0], [4811, 5.3]]), m: P([[0, 0], [9622, 5.3]]), std: [16100, 32200] },
    IL: { n: 'Illinois', s: P([[0, 4.95]]), ex: [2925, 5850, 2925] },
    IN: { n: 'Indiana', s: P([[0, 2.95]]), ex: [1000, 2000, 1000] },
    IA: { n: 'Iowa', s: P([[0, 3.8]]), std: [16100, 32200], cr: [40, 80, 40] },
    KS: { n: 'Kansas', s: P([[0, 5.2], [23000, 5.58]]), m: P([[0, 5.2], [46000, 5.58]]), std: [3605, 8240], ex: [9160, 18320, 2320] },
    KY: { n: 'Kentucky', s: P([[0, 3.5]]), std: [3360, 3360] },
    LA: { n: 'Louisiana', s: P([[0, 3]]), std: [12875, 25750] },
    ME: { n: 'Maine', s: P([[0, 5.8], [27399, 6.75], [64849, 7.15]]), m: P([[0, 5.8], [54849, 6.75], [129749, 7.15]]), std: [8350, 16700], ex: [5300, 10600, 0], cr: [0, 0, 305] },
    MD: { n: 'Maryland', s: P([[0, 2], [1000, 3], [2000, 4], [3000, 4.75], [100000, 5], [125000, 5.25], [150000, 5.5], [250000, 5.75], [500000, 6.25], [1000000, 6.5]]),
      m: P([[0, 2], [1000, 3], [2000, 4], [3000, 4.75], [150000, 5], [175000, 5.25], [225000, 5.5], [300000, 5.75], [600000, 6.25], [1200000, 6.5]]), std: [3350, 6700], ex: [3200, 6400, 3200] },
    MA: { n: 'Massachusetts', s: P([[0, 5], [1083150, 9]]), ex: [4400, 8800, 1000] },
    MI: { n: 'Michigan', s: P([[0, 4.25]]), ex: [5900, 11800, 5900] },
    MN: { n: 'Minnesota', s: P([[0, 5.35], [33310, 6.8], [109430, 7.85], [203150, 9.85]]), m: P([[0, 5.35], [48700, 6.8], [193480, 7.85], [337930, 9.85]]), std: [15300, 30600], ex: [0, 0, 5300] },
    MS: { n: 'Mississippi', s: P([[0, 0], [10000, 4]]), std: [2300, 4600], ex: [6000, 12000, 1500] },
    MO: { n: 'Missouri', s: P([[0, 0], [1348, 2], [2696, 2.5], [4044, 3], [5392, 3.5], [6740, 4], [8088, 4.5], [9436, 4.7]]), std: [16100, 32200] },
    MT: { n: 'Montana', s: P([[0, 4.7], [47500, 5.65]]), m: P([[0, 4.7], [95000, 5.65]]), std: [16100, 32200] },
    NE: { n: 'Nebraska', s: P([[0, 2.46], [4130, 3.51], [24760, 4.55]]), m: P([[0, 2.46], [8250, 3.51], [49530, 4.55]]), std: [8850, 17700], cr: [176, 352, 176] },
    NV: { n: 'Nevada', none: true },
    NH: { n: 'New Hampshire', none: true },
    NJ: { n: 'New Jersey', s: P([[0, 1.4], [20000, 1.75], [35000, 3.5], [40000, 5.53], [75000, 6.37], [500000, 8.97], [1000000, 10.75]]),
      m: P([[0, 1.4], [20000, 1.75], [50000, 2.45], [70000, 3.5], [80000, 5.53], [150000, 6.37], [500000, 8.97], [1000000, 10.75]]), ex: [1000, 2000, 1500] },
    NM: { n: 'New Mexico', s: P([[0, 1.5], [5500, 3.2], [16500, 4.3], [33500, 4.7], [66500, 4.9], [210000, 5.9]]), m: P([[0, 1.5], [8000, 3.2], [25000, 4.3], [50000, 4.7], [100000, 4.9], [315000, 5.9]]), std: [16100, 32200], ex: [0, 0, 4000] },
    NY: { n: 'New York', s: P([[0, 3.9], [8500, 4.4], [11700, 5.15], [13900, 5.4], [80650, 5.9], [215400, 6.85], [1077550, 9.65], [5000000, 10.3], [25000000, 10.9]]),
      m: P([[0, 3.9], [17150, 4.4], [23600, 5.15], [27900, 5.4], [161550, 5.9], [323200, 6.85], [2155350, 9.65], [5000000, 10.3], [25000000, 10.9]]), std: [8000, 16050], ex: [0, 0, 1000] },
    NC: { n: 'North Carolina', s: P([[0, 3.99]]), std: [12750, 25500] },
    ND: { n: 'North Dakota', s: P([[0, 0], [48475, 1.95], [244825, 2.5]]), m: P([[0, 0], [80975, 1.95], [298075, 2.5]]), std: [16100, 32200] },
    OH: { n: 'Ohio', s: P([[0, 0], [26050, 2.75]]), ex: [2400, 4800, 2400] },
    OK: { n: 'Oklahoma', s: P([[0, 0], [3750, 2.5], [4900, 3.5], [7200, 4.5]]), m: P([[0, 0], [7500, 2.5], [9800, 3.5], [14400, 4.5]]), std: [6350, 12700], ex: [1000, 2000, 1000] },
    OR: { n: 'Oregon', s: P([[0, 4.75], [4550, 6.75], [11400, 8.75], [125000, 9.9]]), m: P([[0, 4.75], [9100, 6.75], [22800, 8.75], [250000, 9.9]]), std: [2910, 5820], cr: [256, 512, 256] },
    PA: { n: 'Pennsylvania', s: P([[0, 3.07]]) },
    RI: { n: 'Rhode Island', s: P([[0, 3.75], [82050, 4.75], [186450, 5.99]]), std: [11200, 22400], ex: [5250, 10500, 5250] },
    SC: { n: 'South Carolina', s: P([[0, 0], [3640, 3], [18230, 6]]), std: [8350, 16700], ex: [0, 0, 4930] },
    SD: { n: 'South Dakota', none: true },
    TN: { n: 'Tennessee', none: true },
    TX: { n: 'Texas', none: true },
    UT: { n: 'Utah', s: P([[0, 4.5]]), stdCr: [966, 1932] },
    VT: { n: 'Vermont', s: P([[0, 3.35], [49400, 6.6], [119700, 7.6], [249700, 8.75]]), m: P([[0, 3.35], [82500, 6.6], [199450, 7.6], [304000, 8.75]]), std: [7650, 15300], ex: [5300, 10600, 5300] },
    VA: { n: 'Virginia', s: P([[0, 2], [3000, 3], [5000, 5], [17000, 5.75]]), std: [8750, 17500], ex: [930, 1860, 930] },
    WA: { n: 'Washington', none: true }, // only taxes large capital gains
    WV: { n: 'West Virginia', s: P([[0, 2.22], [10000, 2.96], [25000, 3.33], [40000, 4.44], [60000, 4.82]]), ex: [2000, 4000, 2000] },
    WI: { n: 'Wisconsin', s: P([[0, 3.5], [15110, 4.4], [51950, 5.3], [332720, 7.65]]), m: P([[0, 3.5], [20150, 4.4], [69260, 5.3], [443630, 7.65]]), std: [13960, 25840], ex: [700, 1400, 700] },
    WY: { n: 'Wyoming', none: true }
  };

  function bracketTax(income, brackets) {
    let tax = 0;
    for (let i = 0; i < brackets.length; i++) {
      const [start, rate] = brackets[i];
      const end = i + 1 < brackets.length ? brackets[i + 1][0] : Infinity;
      if (income <= start) break;
      tax += (Math.min(income, end) - start) * rate;
    }
    return tax;
  }

  function stateTax(code, income, filing, deps) {
    const st = STATES[code];
    if (!st || st.none) return 0;
    const m = filing === 'married';
    const i = m ? 1 : 0; // head of household uses the single schedule in this estimate
    const std = st.std ? st.std[i] : 0;
    const ex = st.ex ? st.ex[i] + st.ex[2] * deps : 0;
    const taxable = Math.max(0, income - std - ex);
    let tax = bracketTax(taxable, (m && st.m) || st.s);
    if (st.cr) tax -= st.cr[i] + st.cr[2] * deps;
    if (st.stdCr) tax -= st.stdCr[i];
    return Math.max(0, tax);
  }

  /**
   * Yearly take-home estimate.
   * o: { state: 'NV', filing: 'single'|'married'|'head', dependents: 0, pretax: yearly 401k/health premiums (optional) }
   */
  function usNet(grossYear, o) {
    o = o || {};
    const filing = FED.std[o.filing] ? o.filing : 'single';
    const deps = Math.max(0, parseInt(o.dependents, 10) || 0);
    const gross = Math.max(0, +grossYear || 0);
    const pretax = Math.min(gross, Math.max(0, +o.pretax || 0));
    const incomeForTax = gross - pretax;
    let federal = bracketTax(Math.max(0, incomeForTax - FED.std[filing]), FED.brackets[filing]);
    if (deps) {
      const over = Math.max(0, incomeForTax - FED.childPhaseout[filing]);
      const credit = Math.max(0, deps * FED.childCredit - Math.ceil(over / 1000) * 50);
      federal = Math.max(0, federal - credit);
    }
    const socialSecurity = Math.min(gross, FICA.ssBase) * FICA.ss;
    const medicare = gross * FICA.med + Math.max(0, gross - FICA.addlFrom[filing]) * FICA.addl;
    const state = stateTax(o.state, incomeForTax, filing, deps);
    const net = gross - pretax - federal - socialSecurity - medicare - state;
    return {
      gross: r2(gross), pretax: r2(pretax), federal: r2(federal), socialSecurity: r2(socialSecurity), medicare: r2(medicare), state: r2(state),
      net: r2(net), netMonth: r2(net / 12), effectiveRate: gross ? (gross - pretax - net) / gross : 0
    };
  }

  const PER_YEAR = { year: 1, month: 12, biweek: 26, week: 52 };
  const stateList = () => Object.keys(STATES).map((c) => ({ code: c, name: STATES[c].n, none: !!STATES[c].none })).sort((a, b) => a.name.localeCompare(b.name));

  const api = { FED, FICA, STATES, bracketTax, stateTax, usNet, PER_YEAR, stateList };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.USTax = api;
})(typeof window !== 'undefined' ? window : globalThis);
