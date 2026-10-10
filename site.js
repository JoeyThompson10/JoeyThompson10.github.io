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

   Screen
     One chart, always the stock projection against its key levels.
     Below it, one report at a time, each a table built from the same plan.
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
  const svg = $('plan-chart');
  const plot = $('plan-plot');
  const tip = $('plan-tip');
  const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const one = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const dec = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let seed = 1304836823;
  let noise = null;
  let plan = null;
  let report = null;
  let active = 'position';
  let cursor = null;
  let chart = null;
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

    for (let t = 0; t < DAYS; t += 1) {
      const opening = onHand;
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

      if (short > 0) exceptions.push({ t, type: 'Out of stock', onHand, safety, short });
      else if (onHand < safety) exceptions.push({ t, type: 'Below safety stock', onHand, safety, short: 0 });

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
        opening,
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

    /* Weekly and monthly roll-ups that the reports read from */
    const weeks = [];
    for (let w = 0; w < WEEKS; w += 1) {
      const slice = days.slice(w * 7, w * 7 + 7);
      const sum = (key) => slice.reduce((total, d) => total + d[key], 0);
      const last = slice[6];
      const first = slice[0];
      const nextDaily = forecast[(w + 1) * 7] + 0;
      const forecastWeek = sum('forecast');
      const plannedWeek = sum('planned');
      const committedWeek = sum('committedShip');
      weeks.push({
        week: w + 1,
        month: first.month,
        monthIndex: monthOfDay(w * 7),
        index: idx[w],
        baseForecast: Math.round(base * 7),
        forecast: forecastWeek,
        planned: plannedWeek,
        committedShip: committedWeek,
        plan: forecastWeek + plannedWeek + committedWeek,
        demand: sum('demand'),
        sold: sum('sold'),
        short: sum('short'),
        received: sum('received'),
        ordered: sum('ordered'),
        opening: first.opening,
        onHand: last.onHand,
        committed: last.committed,
        available: last.available,
        onOrder: last.onOrder,
        position: last.position,
        lowest: Math.min.apply(null, slice.map((d) => d.onHand)),
        average: sum('onHand') / 7,
        outDays: slice.filter((d) => d.short > 0).length,
        lowDays: slice.filter((d) => d.short === 0 && d.onHand < d.safety).length,
        daysOfSupply: nextDaily > 0 ? last.onHand / nextDaily : 0,
        forecastPerDay: first.forecast,
        safety: first.safety,
        reorder: first.reorder,
        orderUpTo: first.orderUpTo,
        lastYear: historyTotal[w]
      });
    }
    weeks.forEach((w) => {
      w.vsLastYear = w.lastYear ? w.plan / w.lastYear - 1 : 0;
      w.error = w.demand - w.plan;
      w.errorPct = w.plan ? w.error / w.plan : 0;
      w.absErrorPct = Math.abs(w.errorPct);
      w.leadDemand = w.reorder - w.safety;
      w.orderSize = w.orderUpTo - w.reorder;
      w.status = w.outDays > 0 ? 'Out of stock this week' : w.onHand < w.safety ? 'Below safety stock' : w.ordered > 0 ? 'Order placed' : w.onOrder > 0 ? 'Awaiting receipt' : 'OK';
    });

    const months = MONTHS.map((name, m) => {
      const slice = weeks.filter((w) => w.monthIndex === m);
      const sum = (key) => slice.reduce((total, w) => total + w[key], 0);
      const demand = sum('demand');
      const average = sum('average') / slice.length;
      const row = {
        month: name,
        weeks: slice.length,
        index: season.monthly[m],
        perDay: Math.round(base * season.monthly[m]),
        forecast: sum('forecast'),
        planned: sum('planned'),
        committedShip: sum('committedShip'),
        plan: sum('plan'),
        lastYear: sum('lastYear'),
        demand,
        sold: sum('sold'),
        short: sum('short'),
        outDays: sum('outDays'),
        average: Math.round(average),
        fillRate: demand ? sum('sold') / demand : 1,
        daysOfSupply: demand ? average / (demand / (slice.length * 7)) : 0,
        turns: average ? (demand / slice.length) * WEEKS / average : 0
      };
      row.vsLastYear = row.lastYear ? row.plan / row.lastYear - 1 : 0;
      return row;
    });

    const total = (rows, key) => rows.reduce((sum, r) => sum + r[key], 0);
    const yearDemand = total(weeks, 'demand');
    const yearAverage = total(days, 'onHand') / DAYS;

    return {
      inp,
      season,
      base,
      start,
      days,
      weeks,
      months,
      orders,
      exceptions,
      byCustomer,
      historyTotal,
      year: {
        plan: total(weeks, 'plan'),
        forecast: total(weeks, 'forecast'),
        demand: yearDemand,
        sold: total(weeks, 'sold'),
        short: total(weeks, 'short'),
        lastYear: total(weeks, 'lastYear'),
        average: yearAverage,
        fillRate: yearDemand ? total(weeks, 'sold') / yearDemand : 1,
        turns: yearAverage ? yearDemand / yearAverage : 0,
        mape: total(weeks, 'absErrorPct') / WEEKS,
        bias: total(weeks, 'plan') ? total(weeks, 'error') / total(weeks, 'plan') : 0
      },
      stats: {
        safety: days[0].safety,
        reorder: days[0].reorder,
        orderUpTo: days[0].orderUpTo,
        average: Math.round(yearAverage),
        orders: orders.length,
        outDays: exceptions.filter((e) => e.short > 0).length
      }
    };
  }

  /* ---------- The chart: stock projection against its key levels ---------- */

  const M = { l: 46, r: 12, t: 14, b: 26 };
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

  const compact = (n) => (n >= 1000 ? (Math.round(n / 100) / 10).toString() + 'K' : String(n));
  const weekName = (d) => 'Week ' + d.week + ', day ' + d.day + ' (' + d.month + ')';
  const weekDay = (t) => 'Week ' + (Math.floor(t / 7) + 1) + ', day ' + ((t % 7) + 1);

  function drawChart() {
    const p = plan;
    W = Math.max(280, Math.round(plot.clientWidth) || 640);
    H = W < 440 ? 240 : Math.round(Math.min(360, W * 0.4));
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.textContent = '';

    const x0 = M.l;
    const x1 = W - M.r;
    const y0 = H - M.b;
    const y1 = M.t;
    let peak = p.start;
    p.days.forEach((d) => {
      peak = Math.max(peak, d.orderUpTo, d.opening + d.received);
    });
    const step = niceStep(peak * 1.05);
    const top = Math.ceil((peak * 1.05) / step) * step;
    const x = (day) => x0 + ((x1 - x0) * day) / DAYS;
    const y = (units) => y0 - ((y0 - y1) * units) / top;

    for (let v = 0; v <= top + 1e-9; v += step) {
      svg.appendChild(el('line', { class: 'grid', x1: x0, x2: x1, y1: y(v), y2: y(v) }));
      svg.appendChild(el('text', { class: 'tick', x: x0 - 8, y: y(v) + 4, 'text-anchor': 'end' }, compact(Math.round(v))));
    }
    const narrow = W < 520;
    for (let m = 0; m < 12; m += 1) {
      if (narrow && m % 2 === 1) continue;
      svg.appendChild(el('text', { class: 'tick', x: x0 + ((x1 - x0) * m) / 12 + 2, y: H - 7 }, MONTHS[m]));
    }

    /* Sawtooth: a receipt lifts the line at the start of the day, sales draw it down. */
    let path = 'M' + x(0).toFixed(1) + ' ' + y(p.start).toFixed(1);
    let maxPath = '';
    let minPath = '';
    let safetyPath = '';
    p.days.forEach((d, i) => {
      const cmd = i ? 'L' : 'M';
      const px = x(i + 1).toFixed(1);
      if (d.received > 0) path += 'L' + x(i).toFixed(1) + ' ' + y(d.opening + d.received).toFixed(1);
      path += 'L' + px + ' ' + y(d.onHand).toFixed(1);
      maxPath += cmd + px + ' ' + y(d.orderUpTo).toFixed(1);
      minPath += cmd + px + ' ' + y(d.reorder).toFixed(1);
      safetyPath += cmd + px + ' ' + y(d.safety).toFixed(1);
    });
    const area = el('path', { class: 'area', d: path + 'L' + x1 + ' ' + y0 + 'L' + x0 + ' ' + y0 + 'Z' });
    svg.appendChild(area);
    svg.appendChild(el('path', { class: 'level level-max', d: maxPath }));
    svg.appendChild(el('path', { class: 'level level-min', d: minPath }));
    svg.appendChild(el('path', { class: 'level level-safety', d: safetyPath }));
    const line = el('path', { class: 'line', d: path });
    svg.appendChild(line);

    p.days.forEach((d, i) => {
      if (d.short > 0) svg.appendChild(el('rect', { class: 'out', x: x(i), y: y0 - 6, width: Math.max(2, x(i + 1) - x(i)), height: 6 }));
    });
    p.days.forEach((d, i) => {
      if (d.ordered > 0) svg.appendChild(el('circle', { class: 'po', cx: x(i + 1), cy: y(d.onHand), r: narrow ? 3 : 4 }));
    });

    const cross = el('line', { class: 'cross', y1, y2: y0, visibility: 'hidden' });
    const dot = el('circle', { class: 'cross-dot', r: 5, visibility: 'hidden' });
    svg.appendChild(cross);
    svg.appendChild(dot);
    chart = { x, y, x0, x1, line, area, cross, dot };
  }

  function showCursor(index) {
    cursor = Math.min(DAYS - 1, Math.max(0, index));
    const d = plan.days[cursor];
    const px = chart.x(cursor + 1);
    chart.cross.setAttribute('x1', px);
    chart.cross.setAttribute('x2', px);
    chart.cross.setAttribute('visibility', 'visible');
    chart.dot.setAttribute('cx', px);
    chart.dot.setAttribute('cy', chart.y(d.onHand));
    chart.dot.setAttribute('visibility', 'visible');

    const events = [];
    if (d.received > 0) events.push('Received ' + int.format(d.received));
    if (d.short > 0) events.push('Out of stock, ' + int.format(d.short) + ' short');
    if (d.ordered > 0) events.push('Ordered ' + int.format(d.ordered));

    tip.textContent = '';
    const head = document.createElement('strong');
    head.textContent = weekName(d);
    tip.appendChild(head);
    [['On hand', d.onHand], ['Inventory position', d.position], ['Order-up-to level', d.orderUpTo], ['Reorder point', d.reorder], ['Safety stock', d.safety], ['Demand', d.demand]].forEach((entry) => {
      const row = document.createElement('span');
      const name = document.createElement('i');
      name.textContent = entry[0];
      const value = document.createElement('b');
      value.textContent = int.format(entry[1]);
      row.append(name, value);
      tip.appendChild(row);
    });
    if (events.length) {
      const note = document.createElement('em');
      note.textContent = events.join('. ');
      tip.appendChild(note);
    }
    tip.hidden = false;

    const box = plot.getBoundingClientRect();
    const at = (px / W) * box.width;
    const width = tip.offsetWidth;
    tip.style.left = Math.max(0, at + 14 + width > box.width ? at - 14 - width : at + 14) + 'px';
  }

  function hideCursor() {
    cursor = null;
    tip.hidden = true;
    if (chart) {
      chart.cross.setAttribute('visibility', 'hidden');
      chart.dot.setAttribute('visibility', 'hidden');
    }
  }

  function indexFromPointer(event) {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    return Math.round(((px - chart.x0) / (chart.x1 - chart.x0)) * DAYS) - 1;
  }

  /* ---------- Reports: every one is a table built from the same plan ---------- */

  const col = (key, label, kind) => ({ key, label, kind: kind || 'int' });
  const pct = (v) => Math.round(v * 100) + '%';
  const signed = (v) => (v > 0 ? '+' : '') + pct(v);

  const DAILY = [col('week', 'Week'), col('day', 'Day'), col('month', 'Month', 'text'), col('forecast', 'Forecast'), col('planned', 'Planned demand'), col('committedShip', 'Committed shipped'), col('demand', 'Total demand'), col('sold', 'Shipped'), col('short', 'Short'), col('received', 'Received'), col('onHand', 'On hand'), col('committed', 'Committed'), col('available', 'Available'), col('onOrder', 'On order'), col('position', 'Inventory position'), col('safety', 'Safety stock'), col('reorder', 'Reorder point'), col('orderUpTo', 'Order-up-to level'), col('ordered', 'Ordered')];

  const REPORTS = {
    position: (p) => ({
      title: 'Inventory position',
      blurb: 'Where the product stands at the end of each week. Inventory position is on hand, plus on order, minus committed. It is the number the planner compares to the reorder point.',
      columns: [col('week', 'Week'), col('month', 'Month', 'text'), col('onHand', 'On hand'), col('committed', 'Committed'), col('available', 'Available'), col('onOrder', 'On order'), col('position', 'Inventory position'), col('reorder', 'Reorder point'), col('orderUpTo', 'Order-up-to level'), col('daysOfSupply', 'Days of supply', 'one'), col('status', 'Status', 'text')],
      rows: p.weeks,
      footer: 'Average on hand ' + int.format(p.year.average) + ' units. ' + one.format(p.year.turns) + ' inventory turns a year.'
    }),

    projection: (p) => ({
      title: 'Projected inventory',
      blurb: 'The chart above, as numbers: what each week opens with, what arrives, what ships, and what is left.',
      columns: [col('week', 'Week'), col('month', 'Month', 'text'), col('opening', 'Opening on hand'), col('received', 'Received'), col('demand', 'Demand'), col('sold', 'Shipped'), col('short', 'Short'), col('onHand', 'Closing on hand'), col('lowest', 'Lowest on hand'), col('outDays', 'Days out')],
      rows: p.weeks,
      footer: int.format(p.year.sold) + ' of ' + int.format(p.year.demand) + ' units shipped. Fill rate ' + one.format(p.year.fillRate * 100) + '%.'
    }),

    levels: (p) => ({
      title: 'Key levels',
      blurb: 'The three lines on the chart, week by week. They move with the forecast, so they rise ahead of a busy season or a planned-demand week and fall after it.',
      columns: [col('week', 'Week'), col('month', 'Month', 'text'), col('forecastPerDay', 'Forecast per day'), col('leadDemand', 'Lead-time demand'), col('safety', 'Safety stock'), col('reorder', 'Reorder point (min)'), col('orderUpTo', 'Order-up-to level (max)'), col('orderSize', 'Order size at the min')],
      rows: p.weeks,
      footer: 'Lead time ' + p.inp.lead + ' days. Order cycle ' + p.inp.cycle + ' days.'
    }),

    orders: (p) => ({
      title: 'Suggested orders',
      blurb: 'Every purchase order the planner would place this year. Each is sized to bring the inventory position back up to the order-up-to level.',
      columns: [col('no', 'Order'), col('placedOn', 'Placed', 'text'), col('dueOn', 'Due', 'text'), col('qty', 'Quantity'), col('position', 'Position when placed'), col('reorder', 'Reorder point'), col('orderUpTo', 'Order-up-to level')],
      rows: p.orders.map((o) => Object.assign({ placedOn: weekDay(o.placed), dueOn: o.due < DAYS ? weekDay(o.due) : 'Next year' }, o)),
      empty: 'No orders. Stock never fell to the reorder point.',
      footer: int.format(p.orders.length) + ' orders, ' + int.format(p.orders.reduce((sum, o) => sum + o.qty, 0)) + ' units in total.'
    }),

    service: (p) => ({
      title: 'Service by month',
      blurb: 'How well the plan served customers and what it cost in stock. Fill rate is units shipped over units asked for. Turns are annualized.',
      columns: [col('month', 'Month', 'text'), col('demand', 'Demand'), col('sold', 'Shipped'), col('short', 'Short'), col('fillRate', 'Fill rate', 'pct1'), col('outDays', 'Days out of stock'), col('average', 'Average on hand'), col('daysOfSupply', 'Days of supply', 'one'), col('turns', 'Inventory turns', 'one')],
      rows: p.months,
      footer: 'Year: fill rate ' + one.format(p.year.fillRate * 100) + '%, ' + int.format(p.year.short) + (p.year.short === 1 ? ' unit short, ' : ' units short, ') + one.format(p.year.turns) + ' turns.'
    }),

    exceptions: (p) => ({
      title: 'Exceptions',
      blurb: 'The days that need a person: the shelf ran empty, or stock dipped into the safety stock. A good plan keeps this list short.',
      columns: [col('when', 'When', 'text'), col('type', 'Exception', 'text'), col('onHand', 'On hand'), col('safety', 'Safety stock'), col('short', 'Units short')],
      rows: p.exceptions.map((e) => Object.assign({ when: weekName(p.days[e.t]) }, e)),
      empty: 'No exceptions. Nothing ran out, and stock never dipped into the safety stock.',
      footer: p.exceptions.length ? int.format(p.exceptions.length) + ' exception days out of ' + DAYS + '.' : ''
    }),

    forecastWeekly: (p) => ({
      title: 'Weekly forecast',
      blurb: 'What the planner expects to ship each week: the base rate shaped by the seasonal index, plus planned demand and the committed quantity.',
      columns: [col('week', 'Week'), col('month', 'Month', 'text'), col('baseForecast', 'Base forecast'), col('index', 'Seasonal index', 'dec'), col('forecast', 'Seasonal forecast'), col('planned', 'Planned demand'), col('committedShip', 'Committed'), col('plan', 'Total plan'), col('lastYear', 'Last year'), col('vsLastYear', 'vs last year', 'signed')],
      rows: p.weeks,
      footer: 'Plan for the year: ' + int.format(p.year.plan) + ' units, ' + signed(p.year.plan / p.year.lastYear - 1) + ' against last year. Base rate ' + int.format(Math.round(p.base)) + ' units a day.'
    }),

    forecastMonthly: (p) => ({
      title: 'Monthly forecast',
      blurb: 'The same plan rolled up by month, set against what sold in the same month last year. A month here is the weeks that start in it.',
      columns: [col('month', 'Month', 'text'), col('weeks', 'Weeks'), col('index', 'Seasonal index', 'dec'), col('forecast', 'Seasonal forecast'), col('planned', 'Planned demand'), col('committedShip', 'Committed'), col('plan', 'Total plan'), col('lastYear', 'Last year'), col('vsLastYear', 'vs last year', 'signed')],
      rows: p.months,
      footer: 'Plan for the year: ' + int.format(p.year.plan) + ' units. Last year: ' + int.format(p.year.lastYear) + ' units.'
    }),

    accuracy: (p) => ({
      title: 'Forecast against actual',
      blurb: 'How the simulated year played out against the plan. Error is actual minus plan, so a positive number means the forecast ran low.',
      columns: [col('week', 'Week'), col('month', 'Month', 'text'), col('plan', 'Plan'), col('demand', 'Actual demand'), col('error', 'Error'), col('errorPct', 'Error %', 'signed'), col('absErrorPct', 'Absolute error %', 'pct')],
      rows: p.weeks,
      footer: 'Weekly MAPE ' + one.format(p.year.mape * 100) + '%. Bias ' + (p.year.bias > 0 ? '+' : '') + one.format(p.year.bias * 100) + '% over the year.'
    }),

    season: (p) => {
      const year = p.season.monthly.reduce((a, b) => a + b, 0);
      return {
        title: 'Seasonal profile',
        blurb: 'The shape of a normal year, as a multiplier on average sales. 1.20 means a month runs 20% above average. The forecast is the base rate times this index.',
        columns: [col('month', 'Month', 'text'), col('index', 'Seasonal index', 'dec'), col('perDay', 'Forecast per day'), col('forecast', 'Forecast for the month'), col('share', 'Share of the year', 'pct1')],
        rows: p.months.map((m) => Object.assign({ share: m.index / year }, m)),
        footer: 'Peak month ' + MONTHS[p.season.monthly.indexOf(Math.max.apply(null, p.season.monthly))] + '. Slowest month ' + MONTHS[p.season.monthly.indexOf(Math.min.apply(null, p.season.monthly))] + '.'
      };
    },

    customers: (p) => {
      const half = WEEKS / 2;
      const total = p.year.lastYear;
      return {
        title: 'Customer history',
        blurb: 'Last year\'s sales by who bought. This is the raw material for the forecast: the planner totals it, removes the seasonal shape, and projects it forward.',
        columns: [col('name', 'Customer', 'text'), col('units', 'Units last year'), col('share', 'Share', 'pct'), col('weekly', 'Average per week'), col('peak', 'Biggest week'), col('change', 'Second half vs first', 'signed')],
        rows: CUSTOMERS.map((c, i) => {
          const units = p.byCustomer[i].reduce((a, b) => a + b, 0);
          const first = p.byCustomer[i].slice(0, half).reduce((a, b) => a + b, 0);
          return { name: c.name, units, share: units / total, weekly: Math.round(units / WEEKS), peak: Math.max.apply(null, p.byCustomer[i]), change: (units - first) / first - 1 };
        }),
        footer: int.format(total) + ' units sold last year, which works out to a base rate of ' + int.format(Math.round(p.base)) + ' a day.'
      };
    },

    customersWeekly: (p) => ({
      title: 'Customer history by week',
      blurb: 'The same history, week by week, one column per customer.',
      columns: [col('week', 'Week'), col('month', 'Month', 'text')].concat(CUSTOMERS.map((c, i) => col('c' + i, c.name)), [col('total', 'Total')]),
      rows: p.weeks.map((w, wi) => {
        const row = { week: w.week, month: w.month, total: p.historyTotal[wi] };
        CUSTOMERS.forEach((c, i) => { row['c' + i] = p.byCustomer[i][wi]; });
        return row;
      }),
      footer: int.format(p.year.lastYear) + ' units across ' + CUSTOMERS.length + ' customers.'
    })
  };

  function show(value, kind) {
    if (typeof value !== 'number') return value;
    if (kind === 'pct') return pct(value);
    if (kind === 'pct1') return one.format(value * 100) + '%';
    if (kind === 'signed') return signed(value);
    if (kind === 'dec') return dec.format(value);
    if (kind === 'one') return one.format(value);
    return int.format(value);
  }

  function renderReport() {
    report = REPORTS[active](plan);
    $('report-title').textContent = report.title;
    $('report-blurb').textContent = report.blurb;
    $('report-footer').textContent = report.footer || '';
    $('report-footer').hidden = !report.footer;

    const table = $('report-table');
    const wrap = $('report-table-wrap');
    const empty = $('report-empty');
    table.textContent = '';
    wrap.hidden = !report.rows.length;
    empty.hidden = !!report.rows.length;
    wrap.setAttribute('aria-label', report.title + ' table');
    if (!report.rows.length) {
      empty.textContent = report.empty || 'Nothing to show.';
      return;
    }

    const head = document.createElement('tr');
    report.columns.forEach((c) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = c.label;
      if (c.kind === 'text') th.className = 'left';
      head.appendChild(th);
    });
    const thead = document.createElement('thead');
    thead.appendChild(head);
    table.appendChild(thead);
    const body = document.createElement('tbody');
    report.rows.forEach((row) => {
      const tr = document.createElement('tr');
      report.columns.forEach((c) => {
        const td = document.createElement('td');
        td.textContent = show(row[c.key], c.kind);
        if (c.kind === 'text') td.className = 'left';
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    table.appendChild(body);
    wrap.scrollTop = 0;
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
    drawChart();
    renderReport();
    if (keep !== null) showCursor(keep);
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

  const fileName = (id) => id.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());

  /* ---------- Wiring ---------- */

  root.hidden = false;
  const picked = root.querySelector('input[name="pl-report"]:checked');
  if (picked && REPORTS[picked.value]) active = picked.value;
  rollNoise();
  update();

  $('plan-controls').addEventListener('input', update);
  $('plan-controls').addEventListener('submit', (event) => event.preventDefault());
  $('plan-roll').addEventListener('click', () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    rollNoise();
    update();
  });

  $('report-picker').addEventListener('change', (event) => {
    if (!REPORTS[event.target.value]) return;
    active = event.target.value;
    $('report-status').textContent = '';
    renderReport();
  });

  $('report-export').addEventListener('click', () => download(fileName(active), report.columns, report.rows));
  $('plan-extract').addEventListener('click', () => download('daily-extract', DAILY, plan.days));

  svg.addEventListener('pointermove', (event) => showCursor(indexFromPointer(event)));
  svg.addEventListener('pointerdown', (event) => showCursor(indexFromPointer(event)));
  svg.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse') hideCursor();
  });
  svg.addEventListener('blur', hideCursor);
  svg.addEventListener('keydown', (event) => {
    const steps = { ArrowLeft: -1, ArrowRight: 1, PageUp: -28, PageDown: 28 };
    if (event.key in steps) {
      event.preventDefault();
      showCursor((cursor === null ? -1 : cursor) + steps[event.key]);
    } else if (event.key === 'Home') {
      event.preventDefault();
      showCursor(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      showCursor(DAYS - 1);
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
      animatePending = false;
      const line = chart.line;
      const area = chart.area;
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
