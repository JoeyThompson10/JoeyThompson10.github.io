/* Thompson SWE LLC
   Two working tools on the home page. No dependencies. */

/* ---------------------------------------------------------------------------
   1. Cost of a manual task: hours x people x hourly cost x 50 working weeks.
   ------------------------------------------------------------------------ */
(() => {
  'use strict';

  const calc = document.getElementById('calc');
  if (!calc || !window.Intl) return;

  const WEEKS = 50;
  const fmt = new Intl.NumberFormat('en-US');
  const hours = document.getElementById('in-hours');
  const people = document.getElementById('in-people');
  const rate = document.getElementById('in-rate');

  function update() {
    const h = Number(hours.value);
    const p = Number(people.value);
    const r = Number(rate.value);
    document.getElementById('out-hours').textContent = h + (h === 1 ? ' hour' : ' hours');
    document.getElementById('out-people').textContent = p + (p === 1 ? ' person' : ' people');
    document.getElementById('out-rate').textContent = '$' + r;
    document.getElementById('calc-cost').textContent = '$' + fmt.format(h * p * r * WEEKS);
    document.getElementById('calc-time').textContent = fmt.format(h * p * WEEKS);
  }

  calc.hidden = false;
  update();
  document.getElementById('calc-controls').addEventListener('input', update);
  document.getElementById('calc-controls').addEventListener('submit', (event) => event.preventDefault());
})();

/* ---------------------------------------------------------------------------
   2. Replenishment planner for one product, 52 weeks ahead.

   Forecast
     Last year's sales by customer are simulated, then de-seasonalized to get a
     base rate. forecast(day) = base x seasonal index for that week.
     Planned demand is known extra demand in one week, added on top.
     Committed quantity is stock already promised to open orders. It ships over
     the first five days and is not available to anyone else.

   Policy: min/max, reviewed daily
     inventory position  = on hand + on order - committed
     safety stock        = z x sigma of demand over the lead time
     reorder point (min) = expected demand over the lead time + safety stock
     order-up-to (max)   = expected demand over lead time + order cycle + safety stock
     When position <= reorder point, order (order-up-to level - position).
     The order arrives one lead time later. Unmet demand is lost.
   ------------------------------------------------------------------------ */
(() => {
  'use strict';

  const root = document.getElementById('plan');
  if (!root || !window.Intl || !document.createElementNS || !window.Blob) return;

  const NS = 'http://www.w3.org/2000/svg';
  const WEEKS = 52;
  const DAYS = WEEKS * 7;
  const SHIP_DAYS = 5;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const PROFILES = {
    flat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    summer: [0.7, 0.72, 0.85, 1.0, 1.2, 1.4, 1.45, 1.35, 1.1, 0.9, 0.7, 0.63],
    holiday: [0.75, 0.72, 0.8, 0.85, 0.9, 0.9, 0.88, 0.92, 1.0, 1.15, 1.5, 1.63],
    shoulder: [0.75, 0.85, 1.2, 1.4, 1.25, 0.9, 0.75, 0.8, 1.15, 1.3, 0.95, 0.7]
  };

  /* share of volume, how strongly the customer follows the season, growth across the year, week-to-week noise */
  const CUSTOMERS = [
    { name: 'Fleet account', share: 0.35, season: 0.5, trend: 0, noise: 0.08 },
    { name: 'Contractor account', share: 0.3, season: 1.5, trend: 0, noise: 0.15 },
    { name: 'Retail counter', share: 0.2, season: 1.0, trend: 0, noise: 0.25 },
    { name: 'Online store', share: 0.15, season: 1.0, trend: 0.5, noise: 0.18 }
  ];

  const $ = (id) => document.getElementById(id);
  const svg = $('report-chart');
  const plot = $('report-plot');
  const tip = $('report-tip');
  const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const dec = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let seed = 1304836823;
  let noise = null;
  let plan = null;
  let report = null;
  let active = 'projection';
  let cursor = null;
  let animatePending = !reduceMotion;

  /* ---------- Model ---------- */

  function mulberry32(a) {
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function rollNoise() {
    const rand = mulberry32(seed);
    const gauss = () => {
      let u = 0;
      while (u === 0) u = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    };
    const daily = [];
    for (let i = 0; i < DAYS; i += 1) daily.push(gauss());
    const history = CUSTOMERS.map(() => {
      const weeks = [];
      for (let w = 0; w < WEEKS; w += 1) weeks.push(gauss());
      return weeks;
    });
    noise = { daily, history };
  }

  /* Monthly multipliers, normalized to average 1.00, then interpolated to weeks. */
  function seasonal(key) {
    const raw = PROFILES[key] || PROFILES.flat;
    const mean = raw.reduce((a, b) => a + b, 0) / 12;
    const monthly = raw.map((v) => v / mean);
    let weekly = [];
    for (let w = 0; w < WEEKS; w += 1) {
      const pos = ((w * 7 + 3.5) / DAYS) * 12 - 0.5;
      const lower = Math.floor(pos);
      const frac = pos - lower;
      /* held flat before mid-January and after mid-December, so the year does not bend toward its other end */
      weekly.push(monthly[Math.max(0, Math.min(11, lower))] * (1 - frac) + monthly[Math.max(0, Math.min(11, lower + 1))] * frac);
    }
    const weeklyMean = weekly.reduce((a, b) => a + b, 0) / WEEKS;
    weekly = weekly.map((v) => v / weeklyMean);
    return { monthly, weekly };
  }

  const monthOfDay = (dayIndex) => Math.min(11, Math.floor((dayIndex / DAYS) * 12));

  function buildPlan(inp) {
    const season = seasonal(inp.profile);
    const idx = season.weekly;

    /* Last year's sales by customer */
    const byCustomer = CUSTOMERS.map((c, ci) =>
      idx.map((v, w) => {
        const shaped = 700 * c.share * (1 + c.season * (v - 1)) * (1 + c.trend * (w / (WEEKS - 1) - 0.5));
        return Math.max(0, Math.round(shaped * (1 + c.noise * noise.history[ci][w])));
      })
    );
    const historyTotal = idx.map((_, w) => byCustomer.reduce((sum, c) => sum + c[w], 0));
    const base = historyTotal.reduce((sum, v, w) => sum + v / idx[w], 0) / WEEKS / 7;

    /* Expected demand per day, running past the end of the year so look-aheads work */
    const SPAN = DAYS + 70;
    const forecast = [];
    const planned = [];
    for (let i = 0; i < SPAN; i += 1) {
      forecast.push(base * idx[Math.floor((i % DAYS) / 7)]);
      /* whole units a day, with the remainder on the last day so the week adds up exactly */
      const inWeek = i < DAYS && inp.plannedQty > 0 && Math.floor(i / 7) === inp.plannedWeek - 1;
      const share = Math.floor(inp.plannedQty / 7);
      planned.push(inWeek ? (i % 7 === 6 ? inp.plannedQty - share * 6 : share) : 0);
    }
    const sumExpected = [0];
    const sumForecast = [0];
    const sumVariance = [0];
    for (let i = 0; i < SPAN; i += 1) {
      sumExpected.push(sumExpected[i] + forecast[i] + planned[i]);
      sumForecast.push(sumForecast[i] + forecast[i]);
      sumVariance.push(sumVariance[i] + forecast[i] * forecast[i]);
    }
    const ahead = (prefix, t, n) => prefix[t + n + 1] - prefix[t + 1];
    const safetyAt = (t) => inp.z * inp.cv * Math.sqrt(ahead(sumVariance, t, inp.lead));
    const reorderAt = (t) => ahead(sumExpected, t, inp.lead) + safetyAt(t);
    const orderUpToAt = (t) => ahead(sumExpected, t, inp.lead + inp.cycle) + safetyAt(t);

    /* Opening stock ignores planned and committed demand, so changing them shows their effect */
    const openSafety = safetyAt(0);
    const openMin = ahead(sumForecast, 0, inp.lead) + openSafety;
    const openMax = ahead(sumForecast, 0, inp.lead + inp.cycle) + openSafety;
    const start = Math.round(openMin + 0.6 * (openMax - openMin));

    const perDay = Math.floor(inp.committed / SHIP_DAYS);
    let committed = inp.committed;
    let onHand = start;
    let pipeline = [];
    const days = [];
    const orders = [];
    const exceptions = [];
    let totalOnHand = 0;
    let outDays = 0;

    for (let t = 0; t < DAYS; t += 1) {
      let received = 0;
      pipeline = pipeline.filter((po) => {
        if (po.due === t) {
          received += po.qty;
          return false;
        }
        return true;
      });
      onHand += received;

      const committedShip = t < SHIP_DAYS ? (t === SHIP_DAYS - 1 ? committed : perDay) : 0;
      const plannedToday = planned[t];
      const regular = Math.max(0, Math.round(forecast[t] * (1 + inp.cv * noise.daily[t])));
      const demand = regular + plannedToday + committedShip;
      const sold = Math.min(onHand, demand);
      const short = demand - sold;
      onHand -= sold;
      committed -= committedShip;

      const safety = Math.round(safetyAt(t));
      const reorder = Math.round(reorderAt(t));
      const orderUpTo = Math.round(orderUpToAt(t));
      let onOrder = pipeline.reduce((sum, po) => sum + po.qty, 0);
      let position = onHand + onOrder - committed;
      let ordered = 0;
      if (position <= reorder) {
        ordered = Math.max(1, orderUpTo - position);
        pipeline.push({ due: t + inp.lead, qty: ordered });
        orders.push({ no: orders.length + 1, placed: t, due: t + inp.lead, qty: ordered, position, reorder, orderUpTo });
        onOrder += ordered;
        position += ordered;
      }

      if (short > 0) {
        outDays += 1;
        exceptions.push({ t, type: 'Out of stock', onHand, safety, short });
      } else if (onHand < safety) {
        exceptions.push({ t, type: 'Below safety stock', onHand, safety, short: 0 });
      }
      totalOnHand += onHand;

      days.push({
        t,
        week: Math.floor(t / 7) + 1,
        day: (t % 7) + 1,
        month: MONTHS[monthOfDay(t)],
        forecast: Math.round(forecast[t]),
        planned: plannedToday,
        committedShip,
        demand,
        sold,
        short,
        received,
        ordered,
        onHand,
        committed,
        available: onHand - committed,
        onOrder,
        position,
        safety,
        reorder,
        orderUpTo
      });
    }

    const weeks = [];
    for (let w = 0; w < WEEKS; w += 1) {
      const slice = days.slice(w * 7, w * 7 + 7);
      const sum = (key) => slice.reduce((total, d) => total + d[key], 0);
      weeks.push({
        week: w + 1,
        month: slice[0].month,
        index: idx[w],
        forecast: sum('forecast'),
        planned: sum('planned'),
        committed: sum('committedShip'),
        demand: sum('demand'),
        received: sum('received'),
        ordered: sum('ordered'),
        short: sum('short'),
        endOnHand: slice[6].onHand,
        minOnHand: Math.min.apply(null, slice.map((d) => d.onHand)),
        outDays: slice.filter((d) => d.short > 0).length,
        lowDays: slice.filter((d) => d.short === 0 && d.onHand < d.safety).length,
        lastYear: historyTotal[w]
      });
    }

    return {
      inp,
      season,
      base,
      start,
      days,
      weeks,
      orders,
      exceptions,
      byCustomer,
      historyTotal,
      stats: {
        safety: days[0].safety,
        reorder: days[0].reorder,
        orderUpTo: days[0].orderUpTo,
        average: Math.round(totalOnHand / DAYS),
        orders: orders.length,
        outDays
      }
    };
  }

  /* ---------- Drawing helpers ---------- */

  const M = { l: 46, r: 12, t: 16, b: 26 };
  let W = 640;
  let H = 320;

  function el(name, attrs, text) {
    const node = document.createElementNS(NS, name);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function niceStep(max) {
    const rough = max / 4;
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    const unit = rough / pow;
    const step = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10;
    return step * pow;
  }

  function compact(n) {
    return n >= 1000 ? (Math.round(n / 100) / 10).toString() + 'K' : String(n);
  }

  /* Clears the chart, sizes it to its container, and draws the grid and the month axis. */
  function frame(peak, options) {
    const opt = options || {};
    W = Math.max(280, Math.round(plot.clientWidth) || 640);
    H = W < 440 ? 230 : Math.round(Math.min(opt.tall || 340, W * 0.42));
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.textContent = '';

    const x0 = M.l;
    const x1 = W - M.r;
    const y0 = H - M.b;
    const y1 = M.t;
    const floor = opt.floor || 0;
    const step = opt.step || niceStep((peak - floor) * 1.05);
    const top = floor + Math.ceil(((peak - floor) * 1.05) / step) * step;
    const y = (v) => y0 - ((y0 - y1) * (v - floor)) / (top - floor);

    for (let v = floor; v <= top + 1e-9; v += step) {
      svg.appendChild(el('line', { class: 'grid', x1: x0, x2: x1, y1: y(v), y2: y(v) }));
      svg.appendChild(el('text', { class: 'tick', x: x0 - 8, y: y(v) + 4, 'text-anchor': 'end' }, opt.dec ? dec.format(v) : compact(Math.round(v))));
    }
    const narrow = W < 520;
    for (let m = 0; m < 12; m += 1) {
      if (narrow && m % 2 === 1) continue;
      svg.appendChild(el('text', { class: 'tick', x: x0 + ((x1 - x0) * m) / 12 + 2, y: H - 7 }, MONTHS[m]));
    }
    return { x0, x1, y0, y1, y, top };
  }

  /* A column that is square at the baseline and rounded at the data end. */
  function column(x, yTop, width, height, cls, round) {
    if (height <= 0) return null;
    const r = round ? Math.min(3, width / 2, height) : 0;
    const d = 'M' + x + ' ' + (yTop + height) + 'V' + (yTop + r) + 'Q' + x + ' ' + yTop + ' ' + (x + r) + ' ' + yTop +
      'H' + (x + width - r) + 'Q' + (x + width) + ' ' + yTop + ' ' + (x + width) + ' ' + (yTop + r) + 'V' + (yTop + height) + 'Z';
    return el('path', { class: cls, d });
  }

  /* Weekly stacked columns. series = [{ cls, values[52] }] */
  function drawColumns(f, series) {
    const band = (f.x1 - f.x0) / WEEKS;
    const width = Math.max(2, Math.min(22, band - 2));
    const gap = width >= 5 ? 2 : 1;
    for (let w = 0; w < WEEKS; w += 1) {
      const x = f.x0 + band * w + (band - width) / 2;
      let level = 0;
      const live = series.filter((s) => s.values[w] > 0);
      live.forEach((s, i) => {
        const yBottom = f.y(level);
        level += s.values[w];
        const yTop = f.y(level);
        const height = yBottom - yTop - (i < live.length - 1 ? gap : 0);
        const node = column(x, yBottom - height, width, height, s.cls, i === live.length - 1 && width >= 6);
        if (node) svg.appendChild(node);
      });
    }
    return {
      count: WEEKS,
      locate: (px) => Math.floor((px - f.x0) / band),
      mark: (i) => ({ x: f.x0 + band * i, width: band })
    };
  }

  function weekLine(f, values, cls) {
    const band = (f.x1 - f.x0) / WEEKS;
    const d = values.map((v, w) => (w ? 'L' : 'M') + (f.x0 + band * (w + 0.5)).toFixed(1) + ' ' + f.y(v).toFixed(1)).join('');
    const node = el('path', { class: cls, d });
    svg.appendChild(node);
    return node;
  }

  function label(x, y, text, anchor) {
    svg.appendChild(el('text', { class: 'ref-label', x, y, 'text-anchor': anchor || 'end' }, text));
  }

  const weekName = (d) => 'Week ' + d.week + ', day ' + d.day + ' (' + d.month + ')';

  /* ---------- Reports ---------- */

  const num = (key, labelText) => ({ key, label: labelText, align: 'r' });
  const txt = (key, labelText) => ({ key, label: labelText, align: 'l' });

  const REPORTS = {
    projection: (p) => ({
      title: 'Stock projection',
      blurb: 'Units on hand for the next 52 weeks, steered between the reorder point and the order-up-to level. Dots are orders going out. A red bar is a day the shelf ran empty.',
      legend: [
        { cls: 'k-line s1', label: 'On hand' },
        { cls: 'k-line k-solid', label: 'Order-up-to level (max)' },
        { cls: 'k-line k-dash', label: 'Reorder point (min)' }
      ],
      columns: [num('week', 'Week'), txt('month', 'Month'), num('demand', 'Demand'), num('received', 'Received'), num('ordered', 'Ordered'), num('endOnHand', 'On hand, week end'), num('minOnHand', 'Lowest on hand'), num('outDays', 'Days out')],
      rows: p.weeks,
      extract: {
        label: 'Daily extract (CSV)',
        file: 'daily-extract',
        columns: [num('week', 'Week'), num('day', 'Day'), txt('month', 'Month'), num('forecast', 'Forecast'), num('planned', 'Planned demand'), num('committedShip', 'Committed shipped'), num('demand', 'Total demand'), num('sold', 'Shipped'), num('short', 'Short'), num('received', 'Received'), num('onHand', 'On hand'), num('committed', 'Committed'), num('available', 'Available'), num('onOrder', 'On order'), num('position', 'Inventory position'), num('safety', 'Safety stock'), num('reorder', 'Reorder point'), num('orderUpTo', 'Order-up-to level'), num('ordered', 'Ordered')],
        rows: p.days
      },
      draw() {
        let peak = p.start;
        p.days.forEach((d, i) => {
          peak = Math.max(peak, d.orderUpTo, (i ? p.days[i - 1].onHand : p.start) + d.received);
        });
        const f = frame(peak);
        const x = (day) => f.x0 + ((f.x1 - f.x0) * day) / DAYS;

        if (p.inp.plannedQty > 0) {
          const from = x((p.inp.plannedWeek - 1) * 7);
          const to = x(p.inp.plannedWeek * 7);
          svg.appendChild(el('rect', { class: 'band-mark', x: from, y: f.y1, width: Math.max(3, to - from), height: f.y0 - f.y1 }));
          const right = from > (f.x0 + f.x1) / 2;
          label(right ? from - 5 : to + 5, f.y1 + 12, 'Planned demand', right ? 'end' : 'start');
        }

        let path = 'M' + x(0).toFixed(1) + ' ' + f.y(p.start).toFixed(1);
        let previous = p.start;
        let maxPath = '';
        let minPath = '';
        p.days.forEach((d, i) => {
          if (d.received > 0) path += 'L' + x(i).toFixed(1) + ' ' + f.y(previous + d.received).toFixed(1);
          path += 'L' + x(i + 1).toFixed(1) + ' ' + f.y(d.onHand).toFixed(1);
          previous = d.onHand;
          maxPath += (i ? 'L' : 'M') + x(i + 1).toFixed(1) + ' ' + f.y(d.orderUpTo).toFixed(1);
          minPath += (i ? 'L' : 'M') + x(i + 1).toFixed(1) + ' ' + f.y(d.reorder).toFixed(1);
        });
        const area = el('path', { class: 'area', d: path + 'L' + f.x1 + ' ' + f.y0 + 'L' + f.x0 + ' ' + f.y0 + 'Z' });
        svg.appendChild(area);
        svg.appendChild(el('path', { class: 'ref ref-solid', d: maxPath }));
        svg.appendChild(el('path', { class: 'ref', d: minPath }));
        const line = el('path', { class: 'line s1-stroke', d: path });
        svg.appendChild(line);

        p.days.forEach((d, i) => {
          if (d.short > 0) svg.appendChild(el('rect', { class: 'out', x: x(i), y: f.y0 - 6, width: Math.max(2, x(i + 1) - x(i)), height: 6 }));
        });
        p.days.forEach((d, i) => {
          if (d.ordered > 0) svg.appendChild(el('circle', { class: 'po', cx: x(i + 1), cy: f.y(d.onHand), r: W < 520 ? 3 : 4 }));
        });

        const dot = el('circle', { class: 'cross-dot', r: 5, visibility: 'hidden' });
        svg.appendChild(dot);
        report.animate = { line, area };

        return {
          count: DAYS,
          locate: (px) => Math.round(((px - f.x0) / (f.x1 - f.x0)) * DAYS) - 1,
          mark: (i) => {
            dot.setAttribute('cx', x(i + 1));
            dot.setAttribute('cy', f.y(p.days[i].onHand));
            dot.setAttribute('visibility', 'visible');
            return { x: x(i + 1), width: 0 };
          },
          unmark: () => dot.setAttribute('visibility', 'hidden'),
          tip: (i) => {
            const d = p.days[i];
            const events = [];
            if (d.received > 0) events.push('Received ' + int.format(d.received));
            if (d.short > 0) events.push('Out of stock, ' + int.format(d.short) + ' short');
            if (d.ordered > 0) events.push('Ordered ' + int.format(d.ordered));
            return {
              title: weekName(d),
              lines: [['On hand', d.onHand, 'k-line s1'], ['Available', d.available], ['On order', d.onOrder], ['Demand', d.demand], ['Order-up-to level', d.orderUpTo], ['Reorder point', d.reorder]],
              note: events.join('. ')
            };
          }
        };
      }
    }),

    demand: (p) => ({
      title: 'Demand plan',
      blurb: 'What the planner expects to ship each week: the seasonal forecast, plus planned demand and the committed quantity. The line is what sold in the same week last year.',
      legend: [
        { cls: 'k-box s1', label: 'Forecast' },
        { cls: 'k-box s2', label: 'Planned demand' },
        { cls: 'k-box s3', label: 'Committed quantity' },
        { cls: 'k-line k-solid', label: 'Last year' }
      ],
      columns: [num('week', 'Week'), txt('month', 'Month'), { key: 'index', label: 'Seasonal index', align: 'r', dec: true }, num('forecast', 'Forecast'), num('planned', 'Planned demand'), num('committed', 'Committed'), num('total', 'Total plan'), num('lastYear', 'Last year')],
      rows: p.weeks.map((w) => Object.assign({ total: w.forecast + w.planned + w.committed }, w)),
      draw() {
        const peak = Math.max.apply(null, p.weeks.map((w) => Math.max(w.forecast + w.planned + w.committed, w.lastYear)));
        const f = frame(peak);
        const hit = drawColumns(f, [
          { cls: 's1', values: p.weeks.map((w) => w.forecast) },
          { cls: 's2', values: p.weeks.map((w) => w.planned) },
          { cls: 's3', values: p.weeks.map((w) => w.committed) }
        ]);
        weekLine(f, p.historyTotal, 'ref ref-solid ref-strong');
        hit.tip = (i) => {
          const w = p.weeks[i];
          return {
            title: 'Week ' + w.week + ' (' + w.month + ')',
            lines: [['Forecast', w.forecast, 'k-box s1'], ['Planned demand', w.planned, 'k-box s2'], ['Committed', w.committed, 'k-box s3'], ['Last year', w.lastYear, 'k-line k-solid']]
          };
        };
        return hit;
      }
    }),

    orders: (p) => ({
      title: 'Suggested orders',
      blurb: 'Every purchase order the planner would place this year. Each is sized to bring the inventory position back up to the order-up-to level.',
      legend: [],
      columns: [num('no', 'Order'), txt('placedOn', 'Placed'), txt('dueOn', 'Due'), num('qty', 'Quantity'), num('position', 'Position when placed'), num('reorder', 'Reorder point'), num('orderUpTo', 'Order-up-to level')],
      rows: p.orders.map((o) => Object.assign({
        placedOn: 'Week ' + (Math.floor(o.placed / 7) + 1) + ', day ' + ((o.placed % 7) + 1),
        dueOn: o.due < DAYS ? 'Week ' + (Math.floor(o.due / 7) + 1) + ', day ' + ((o.due % 7) + 1) : 'Next year'
      }, o)),
      footer: int.format(p.orders.length) + ' orders, ' + int.format(p.orders.reduce((sum, o) => sum + o.qty, 0)) + ' units in total.',
      draw() {
        const byWeek = p.weeks.map((w) => w.ordered);
        const f = frame(Math.max(100, Math.max.apply(null, byWeek)));
        const hit = drawColumns(f, [{ cls: 's1', values: byWeek }]);
        hit.tip = (i) => ({
          title: 'Week ' + (i + 1) + ' (' + p.weeks[i].month + ')',
          lines: [['Ordered', byWeek[i], 'k-box s1'], ['Received', p.weeks[i].received]]
        });
        return hit;
      }
    }),

    customers: (p) => {
      const half = WEEKS / 2;
      const total = p.historyTotal.reduce((a, b) => a + b, 0);
      return {
        title: 'Customer history',
        blurb: 'Last year\'s sales, broken out by who bought. This is the raw material for the forecast: the planner averages it, removes the seasonal shape, and projects it forward.',
        legend: CUSTOMERS.map((c, i) => ({ cls: 'k-box s' + (i + 1), label: c.name })),
        columns: [txt('name', 'Customer'), num('units', 'Units last year'), { key: 'share', label: 'Share', align: 'r', pct: true }, num('weekly', 'Average per week'), { key: 'change', label: 'Second half vs first', align: 'r', pct: true, signed: true }],
        rows: CUSTOMERS.map((c, i) => {
          const units = p.byCustomer[i].reduce((a, b) => a + b, 0);
          const first = p.byCustomer[i].slice(0, half).reduce((a, b) => a + b, 0);
          return { name: c.name, units, share: units / total, weekly: Math.round(units / WEEKS), change: (units - first) / first - 1 };
        }),
        footer: 'Forecast base: ' + int.format(Math.round(p.base)) + ' units a day, from ' + int.format(total) + ' units sold last year.',
        extract: {
          label: 'Weekly extract (CSV)',
          file: 'customer-history-weekly',
          columns: [num('week', 'Week'), txt('month', 'Month')].concat(CUSTOMERS.map((c, i) => num('c' + i, c.name)), [num('total', 'Total')]),
          rows: p.weeks.map((w, wi) => {
            const row = { week: w.week, month: w.month, total: p.historyTotal[wi] };
            CUSTOMERS.forEach((c, i) => { row['c' + i] = p.byCustomer[i][wi]; });
            return row;
          })
        },
        draw() {
          const f = frame(Math.max.apply(null, p.historyTotal));
          const hit = drawColumns(f, CUSTOMERS.map((c, i) => ({ cls: 's' + (i + 1), values: p.byCustomer[i] })));
          hit.tip = (w) => ({
            title: 'Week ' + (w + 1) + ' (' + p.weeks[w].month + '), last year',
            lines: CUSTOMERS.map((c, i) => [c.name, p.byCustomer[i][w], 'k-box s' + (i + 1)]).concat([['Total', p.historyTotal[w]]])
          });
          return hit;
        }
      };
    },

    season: (p) => ({
      title: 'Seasonal profile',
      blurb: 'The shape of a normal year, as a multiplier on average sales. 1.20 means a week runs 20% above average. The forecast is the base rate times this curve.',
      legend: [],
      columns: [txt('month', 'Month'), { key: 'index', label: 'Seasonal index', align: 'r', dec: true }, num('perDay', 'Forecast per day'), num('perMonth', 'Forecast for the month')],
      rows: MONTHS.map((m, i) => ({ month: m, index: p.season.monthly[i], perDay: Math.round(p.base * p.season.monthly[i]), perMonth: Math.round((p.base * p.season.monthly[i] * DAYS) / 12) })),
      draw() {
        const values = p.season.weekly;
        const high = Math.max(1.25, Math.max.apply(null, values));
        const low = Math.min(0.75, Math.min.apply(null, values));
        const floor = Math.floor(low * 4) / 4;
        const f = frame(high, { floor, step: 0.25, dec: true });
        svg.appendChild(el('line', { class: 'ref', x1: f.x0, x2: f.x1, y1: f.y(1), y2: f.y(1) }));
        label(f.x1 - 4, f.y(1) - 6, 'Average, 1.00');
        weekLine(f, values, 'line s1-stroke');
        const band = (f.x1 - f.x0) / WEEKS;
        const dot = el('circle', { class: 'cross-dot', r: 5, visibility: 'hidden' });
        svg.appendChild(dot);
        return {
          count: WEEKS,
          locate: (px) => Math.floor((px - f.x0) / band),
          mark: (i) => {
            dot.setAttribute('cx', f.x0 + band * (i + 0.5));
            dot.setAttribute('cy', f.y(values[i]));
            dot.setAttribute('visibility', 'visible');
            return { x: f.x0 + band * (i + 0.5), width: 0 };
          },
          unmark: () => dot.setAttribute('visibility', 'hidden'),
          tip: (i) => ({
            title: 'Week ' + (i + 1) + ' (' + p.weeks[i].month + ')',
            lines: [['Seasonal index', dec.format(values[i]), 'k-line s1'], ['Forecast per day', Math.round(p.base * values[i])]]
          })
        };
      }
    }),

    exceptions: (p) => ({
      title: 'Exceptions',
      blurb: 'The days that need a person: the shelf ran empty, or stock dipped into the safety stock. A good plan keeps this list short.',
      legend: [
        { cls: 'k-box warn', label: 'Below safety stock' },
        { cls: 'k-box crit', label: 'Out of stock' }
      ],
      columns: [txt('when', 'When'), txt('type', 'Exception'), num('onHand', 'On hand'), num('safety', 'Safety stock'), num('short', 'Units short')],
      rows: p.exceptions.map((e) => Object.assign({ when: weekName(p.days[e.t]) }, e)),
      empty: 'No exceptions. Nothing ran out, and stock never dipped into the safety stock.',
      footer: p.exceptions.length ? int.format(p.exceptions.length) + ' exception days out of ' + DAYS + '.' : '',
      draw() {
        const most = Math.max.apply(null, p.weeks.map((w) => w.lowDays + w.outDays));
        const f = frame(Math.max(3, most) / 1.05, { step: 1, tall: 240 });
        const hit = drawColumns(f, [
          { cls: 'warn', values: p.weeks.map((w) => w.lowDays) },
          { cls: 'crit', values: p.weeks.map((w) => w.outDays) }
        ]);
        hit.tip = (i) => ({
          title: 'Week ' + (i + 1) + ' (' + p.weeks[i].month + ')',
          lines: [['Days below safety stock', p.weeks[i].lowDays, 'k-box warn'], ['Days out of stock', p.weeks[i].outDays, 'k-box crit']]
        });
        return hit;
      }
    })
  };

  /* ---------- Rendering ---------- */

  function show(value, col) {
    if (typeof value !== 'number') return value;
    if (col.pct) return (col.signed && value > 0 ? '+' : '') + Math.round(value * 100) + '%';
    if (col.dec) return dec.format(value);
    return int.format(value);
  }

  function renderTable() {
    const table = $('report-table');
    const wrap = $('report-table-wrap');
    const empty = $('report-empty');
    table.textContent = '';
    if (!report.rows.length) {
      wrap.hidden = true;
      empty.hidden = false;
      empty.textContent = report.empty || 'Nothing to show.';
      return;
    }
    wrap.hidden = false;
    empty.hidden = true;
    const caption = document.createElement('caption');
    caption.textContent = report.title;
    caption.className = 'visually-hidden';
    table.appendChild(caption);
    const head = document.createElement('tr');
    report.columns.forEach((col) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = col.label;
      if (col.align === 'l') th.className = 'left';
      head.appendChild(th);
    });
    const thead = document.createElement('thead');
    thead.appendChild(head);
    table.appendChild(thead);
    const body = document.createElement('tbody');
    report.rows.forEach((row) => {
      const tr = document.createElement('tr');
      report.columns.forEach((col) => {
        const td = document.createElement('td');
        td.textContent = show(row[col.key], col);
        if (col.align === 'l') td.className = 'left';
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    table.appendChild(body);
  }

  function renderLegend() {
    const legend = $('report-legend');
    legend.textContent = '';
    legend.hidden = !report.legend.length;
    report.legend.forEach((item) => {
      const li = document.createElement('li');
      const key = document.createElement('span');
      key.className = 'key ' + item.cls;
      key.setAttribute('aria-hidden', 'true');
      li.append(key, item.label);
      legend.appendChild(li);
    });
  }

  function drawChart() {
    report.hit = report.draw();
    svg.appendChild(el('rect', { class: 'hoverband', id: 'report-band', visibility: 'hidden', y: M.t, height: H - M.b - M.t }));
    svg.appendChild(el('line', { class: 'cross', id: 'report-cross', visibility: 'hidden', y1: M.t, y2: H - M.b }));
  }

  function renderReport() {
    report = REPORTS[active](plan);
    $('report-title').textContent = report.title;
    $('report-blurb').textContent = report.blurb;
    $('report-footer').textContent = report.footer || '';
    $('report-footer').hidden = !report.footer;
    const extract = $('report-extract');
    extract.hidden = !report.extract;
    if (report.extract) extract.textContent = report.extract.label;
    svg.setAttribute('aria-label', report.title + '. ' + report.blurb);
    renderLegend();
    drawChart();
    renderTable();
    hideCursor();
  }

  function update() {
    const lead = Number($('pl-lead').value);
    const cycle = Number($('pl-cycle').value);
    const cv = Number($('pl-cv').value) / 100;
    const plannedQty = Number($('pl-planned').value);
    const plannedWeek = Number($('pl-week').value);
    const committed = Number($('pl-committed').value);
    const profile = $('pl-profile').value;
    const z = Number(root.querySelector('input[name="pl-svc"]:checked').value);

    $('out-lead').textContent = lead + ' days';
    $('out-cycle').textContent = cycle + ' days';
    $('out-cv').textContent = Math.round(cv * 100) + '%';
    $('out-planned').textContent = int.format(plannedQty) + ' units';
    $('out-week').textContent = 'Week ' + plannedWeek + ' (' + MONTHS[monthOfDay((plannedWeek - 1) * 7)] + ')';
    $('out-committed').textContent = int.format(committed) + ' units';

    plan = buildPlan({ lead, cycle, cv, plannedQty, plannedWeek, committed, profile, z });
    $('st-ss').textContent = int.format(plan.stats.safety);
    $('st-rop').textContent = int.format(plan.stats.reorder);
    $('st-outl').textContent = int.format(plan.stats.orderUpTo);
    $('st-avg').textContent = int.format(plan.stats.average);
    $('st-orders').textContent = int.format(plan.stats.orders);
    $('st-out').textContent = int.format(plan.stats.outDays);

    const keep = cursor;
    renderReport();
    if (keep !== null) showCursor(keep);
  }

  /* ---------- Hover and keyboard ---------- */

  function showCursor(index) {
    const hit = report.hit;
    if (!hit) return;
    cursor = Math.min(hit.count - 1, Math.max(0, index));
    const at = hit.mark(cursor);
    const band = $('report-band');
    const cross = $('report-cross');
    if (at.width) {
      band.setAttribute('x', at.x);
      band.setAttribute('width', at.width);
      band.setAttribute('visibility', 'visible');
    } else {
      cross.setAttribute('x1', at.x);
      cross.setAttribute('x2', at.x);
      cross.setAttribute('visibility', 'visible');
    }

    const data = hit.tip(cursor);
    tip.textContent = '';
    const head = document.createElement('strong');
    head.textContent = data.title;
    tip.appendChild(head);
    data.lines.forEach((entry) => {
      const row = document.createElement('span');
      const name = document.createElement('i');
      if (entry[2]) {
        const key = document.createElement('span');
        key.className = 'key ' + entry[2];
        name.appendChild(key);
      }
      name.append(entry[0]);
      const value = document.createElement('b');
      value.textContent = typeof entry[1] === 'number' ? int.format(entry[1]) : entry[1];
      row.append(name, value);
      tip.appendChild(row);
    });
    if (data.note) {
      const note = document.createElement('em');
      note.textContent = data.note;
      tip.appendChild(note);
    }
    tip.hidden = false;

    const box = plot.getBoundingClientRect();
    const px = ((at.x + at.width / 2) / W) * box.width;
    const width = tip.offsetWidth;
    const left = px + 14 + width > box.width ? px - 14 - width : px + 14;
    tip.style.left = Math.max(0, left) + 'px';
  }

  function hideCursor() {
    cursor = null;
    tip.hidden = true;
    const band = $('report-band');
    const cross = $('report-cross');
    if (band) band.setAttribute('visibility', 'hidden');
    if (cross) cross.setAttribute('visibility', 'hidden');
    if (report && report.hit && report.hit.unmark) report.hit.unmark();
  }

  function indexFromPointer(event) {
    const box = svg.getBoundingClientRect();
    return report.hit.locate(((event.clientX - box.left) / box.width) * W);
  }

  /* ---------- Exports ---------- */

  function toCsv(columns, rows) {
    const cell = (value) => {
      if (typeof value === 'number') return String(Math.round(value * 10000) / 10000);
      const text = String(value === undefined || value === null ? '' : value);
      return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };
    const lines = [columns.map((c) => cell(c.label)).join(',')];
    rows.forEach((row) => lines.push(columns.map((c) => cell(row[c.key])).join(',')));
    return lines.join('\r\n') + '\r\n';
  }

  function download(name, columns, rows) {
    const blob = new Blob(['﻿' + toCsv(columns, rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'thompson-swe-planner-' + name + '.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('report-status').textContent = 'Downloaded ' + link.download + ', ' + int.format(rows.length) + ' rows.';
  }

  /* ---------- Wiring ---------- */

  const tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));

  function selectTab(id, focus) {
    active = id;
    tabs.forEach((tab) => {
      const on = tab.dataset.report === id;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      if (on) {
        $('report').setAttribute('aria-labelledby', tab.id);
        if (focus) tab.focus();
      }
    });
    $('report-status').textContent = '';
    renderReport();
  }

  root.hidden = false;
  rollNoise();
  update();

  $('plan-controls').addEventListener('input', update);
  $('plan-controls').addEventListener('submit', (event) => event.preventDefault());
  $('plan-roll').addEventListener('click', () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    rollNoise();
    update();
  });

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.report, false));
    tab.addEventListener('keydown', (event) => {
      const move = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (move) {
        event.preventDefault();
        selectTab(tabs[(i + move + tabs.length) % tabs.length].dataset.report, true);
      } else if (event.key === 'Home') {
        event.preventDefault();
        selectTab(tabs[0].dataset.report, true);
      } else if (event.key === 'End') {
        event.preventDefault();
        selectTab(tabs[tabs.length - 1].dataset.report, true);
      }
    });
  });

  $('report-export').addEventListener('click', () => download(active, report.columns, report.rows));
  $('report-extract').addEventListener('click', () => {
    if (report.extract) download(report.extract.file, report.extract.columns, report.extract.rows);
  });

  svg.addEventListener('pointermove', (event) => showCursor(indexFromPointer(event)));
  svg.addEventListener('pointerdown', (event) => showCursor(indexFromPointer(event)));
  svg.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse') hideCursor();
  });
  svg.addEventListener('blur', hideCursor);
  svg.addEventListener('keydown', (event) => {
    const big = Math.max(1, Math.round(report.hit.count / 13));
    const steps = { ArrowLeft: -1, ArrowRight: 1, PageUp: -big, PageDown: big };
    if (event.key in steps) {
      event.preventDefault();
      showCursor((cursor === null ? -1 : cursor) + steps[event.key]);
    } else if (event.key === 'Home') {
      event.preventDefault();
      showCursor(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      showCursor(report.hit.count - 1);
    } else if (event.key === 'Escape') {
      hideCursor();
    }
  });

  if (window.ResizeObserver) {
    let lastWidth = plot.clientWidth;
    new ResizeObserver(() => {
      if (Math.abs(plot.clientWidth - lastWidth) < 2) return;
      lastWidth = plot.clientWidth;
      const keep = cursor;
      drawChart();
      if (keep !== null) showCursor(keep);
    }).observe(plot);
  }

  /* One moment of motion: the stock line draws itself the first time the chart scrolls into view. */
  if (animatePending && window.IntersectionObserver) {
    const watcher = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      watcher.disconnect();
      if (!animatePending || active !== 'projection' || !report.animate) return;
      animatePending = false;
      const line = report.animate.line;
      const area = report.animate.area;
      if (!line.isConnected || !line.getTotalLength) return;
      const length = line.getTotalLength();
      line.style.strokeDasharray = length;
      line.style.strokeDashoffset = length;
      area.style.opacity = 0;
      requestAnimationFrame(() => {
        line.style.transition = 'stroke-dashoffset 2s cubic-bezier(.4,0,.2,1)';
        area.style.transition = 'opacity .6s ease 1.6s';
        line.style.strokeDashoffset = 0;
        area.style.opacity = '';
        setTimeout(() => {
          line.style.transition = '';
          line.style.strokeDasharray = '';
          line.style.strokeDashoffset = '';
          area.style.transition = '';
        }, 2400);
      });
    }, { threshold: 0.4 });
    watcher.observe(plot);
  }
})();
