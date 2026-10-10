/* Thompson SWE LLC
   Two small working tools on the home page. No dependencies.

   Reorder-point example:

   Model: one item, mean demand MU units a day with normally distributed noise.
   Continuous review (s, Q): when stock on hand plus stock on order falls to the
   reorder point, order Q units, which arrive one lead time later.
     safety stock  = z * sigma * sqrt(lead time)
     reorder point = MU * lead time + safety stock
   Unmet demand is lost, not backordered. */

/* Cost of a manual task: hours x people x hourly cost x 50 working weeks. */
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

(() => {
  'use strict';

  const sim = document.getElementById('sim');
  if (!sim || !window.Intl || !document.createElementNS) return;

  const NS = 'http://www.w3.org/2000/svg';
  const DAYS = 90;
  const MU = 100;
  const ORDER_QTY = MU * 14;
  const M = { l: 40, r: 10, t: 14, b: 26 };
  const X0 = M.l;
  const Y1 = M.t;
  /* The chart is drawn at the pixel size of its container, so text never shrinks on a phone. */
  let W = 640;
  let H = 300;
  let X1 = W - M.r;
  let Y0 = H - M.b;

  const svg = document.getElementById('sim-chart');
  const plot = document.getElementById('sim-plot');
  const tip = document.getElementById('sim-tip');
  const inLead = document.getElementById('in-lead');
  const inCv = document.getElementById('in-cv');
  const outLead = document.getElementById('out-lead');
  const outCv = document.getElementById('out-cv');
  const rowsEl = document.getElementById('sim-rows');
  const fmt = new Intl.NumberFormat('en-US');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let seed = 1304836823;
  let noise = [];
  let result = null;
  let cursor = null;
  let firstDraw = true;

  /* Small seeded generator so a given roll is repeatable while the controls move. */
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
    noise = [];
    for (let i = 0; i < DAYS; i += 1) {
      let u = 0;
      while (u === 0) u = rand();
      const v = rand();
      noise.push(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
    }
  }

  function simulate(lead, cv, z) {
    const sigma = cv * MU;
    const safety = Math.round(z * sigma * Math.sqrt(lead));
    const reorder = MU * lead + safety;
    let onHand = reorder + Math.round(ORDER_QTY * 0.6);
    let pipeline = [];
    const start = onHand;
    const rows = [];
    let total = 0;
    let outDays = 0;

    for (let day = 1; day <= DAYS; day += 1) {
      let received = 0;
      pipeline = pipeline.filter((po) => {
        if (po.day === day) {
          received += po.qty;
          return false;
        }
        return true;
      });
      onHand += received;

      const demand = Math.max(0, Math.round(MU + sigma * noise[day - 1]));
      const sold = Math.min(onHand, demand);
      const short = demand - sold;
      onHand -= sold;

      let onOrder = pipeline.reduce((sum, po) => sum + po.qty, 0);
      let ordered = 0;
      while (onHand + onOrder <= reorder) {
        pipeline.push({ day: day + lead, qty: ORDER_QTY });
        onOrder += ORDER_QTY;
        ordered += ORDER_QTY;
      }

      if (short > 0) outDays += 1;
      total += onHand;
      rows.push({ day, demand, onHand, onOrder, ordered, received, short });
    }

    return { start, rows, safety, reorder, average: Math.round(total / DAYS), outDays };
  }

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
    return n >= 1000 ? (n / 1000).toString().replace(/\.0$/, '') + 'K' : String(n);
  }

  let scaleX = null;
  let scaleY = null;

  function measure() {
    const width = Math.round(plot.clientWidth) || 640;
    W = Math.max(280, width);
    H = W < 440 ? 230 : Math.round(Math.min(320, W * 0.5));
    X1 = W - M.r;
    Y0 = H - M.b;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  }

  function draw() {
    const { start, rows, safety, reorder } = result;
    measure();
    let peak = Math.max(start, reorder);
    for (let i = 0; i < rows.length; i += 1) {
      const before = (i === 0 ? start : rows[i - 1].onHand) + rows[i].received;
      peak = Math.max(peak, before);
    }
    const step = niceStep(peak * 1.04);
    const top = Math.ceil((peak * 1.04) / step) * step;

    scaleX = (day) => X0 + ((X1 - X0) * day) / DAYS;
    scaleY = (units) => Y0 - ((Y0 - Y1) * units) / top;

    svg.textContent = '';

    for (let v = 0; v <= top + 1e-9; v += step) {
      const y = scaleY(v);
      svg.appendChild(el('line', { class: 'grid', x1: X0, x2: X1, y1: y, y2: y }));
      svg.appendChild(el('text', { class: 'tick', x: X0 - 8, y: y + 4, 'text-anchor': 'end' }, compact(v)));
    }
    for (let d = 0; d <= DAYS; d += 30) {
      const anchor = d === 0 ? 'start' : d === DAYS ? 'end' : 'middle';
      svg.appendChild(el('text', { class: 'tick', x: scaleX(d), y: H - 7, 'text-anchor': anchor }, 'Day ' + d));
    }

    /* Sawtooth: a receipt lifts the line at the start of the day, sales draw it down. */
    let path = 'M' + scaleX(0).toFixed(1) + ' ' + scaleY(start).toFixed(1);
    let previous = start;
    for (const row of rows) {
      if (row.received > 0) {
        path += 'L' + scaleX(row.day - 1).toFixed(1) + ' ' + scaleY(previous + row.received).toFixed(1);
      }
      path += 'L' + scaleX(row.day).toFixed(1) + ' ' + scaleY(row.onHand).toFixed(1);
      previous = row.onHand;
    }
    const area = el('path', { class: 'area', d: path + 'L' + X1 + ' ' + Y0 + 'L' + X0 + ' ' + Y0 + 'Z' });
    svg.appendChild(area);

    const yReorder = scaleY(reorder);
    const ySafety = scaleY(safety);
    svg.appendChild(el('line', { class: 'ref', x1: X0, x2: X1, y1: yReorder, y2: yReorder }));
    svg.appendChild(el('line', { class: 'ref', x1: X0, x2: X1, y1: ySafety, y2: ySafety }));

    const line = el('path', { class: 'line', d: path });
    svg.appendChild(line);

    for (const row of rows) {
      if (row.short > 0) {
        const x = scaleX(row.day - 1);
        svg.appendChild(el('rect', { class: 'out', x: x + 0.5, y: Y0 - 6, width: Math.max(2, scaleX(row.day) - x - 1), height: 6 }));
      }
    }
    for (const row of rows) {
      if (row.ordered > 0) {
        svg.appendChild(el('circle', { class: 'po', cx: scaleX(row.day), cy: scaleY(row.onHand), r: 4.5 }));
      }
    }

    svg.appendChild(el('text', { class: 'ref-label', x: X1 - 4, y: yReorder - 6, 'text-anchor': 'end' }, 'Reorder point ' + fmt.format(reorder)));
    const roomBelow = ySafety + 17 < Y0 - 8;
    const roomAbove = ySafety - yReorder > 34;
    if (roomBelow || roomAbove) {
      svg.appendChild(el('text', { class: 'ref-label', x: X1 - 4, y: roomBelow ? ySafety + 15 : ySafety - 6, 'text-anchor': 'end' }, 'Safety stock ' + fmt.format(safety)));
    }

    const cross = el('g', { id: 'sim-cross', visibility: 'hidden' });
    cross.appendChild(el('line', { class: 'cross', x1: 0, x2: 0, y1: Y1, y2: Y0 }));
    cross.appendChild(el('circle', { class: 'cross-dot', cx: 0, cy: 0, r: 5 }));
    svg.appendChild(cross);

    if (firstDraw && !reduceMotion && line.getTotalLength) {
      const length = line.getTotalLength();
      line.style.strokeDasharray = length;
      line.style.strokeDashoffset = length;
      area.style.opacity = 0;
      requestAnimationFrame(() => {
        line.style.transition = 'stroke-dashoffset 1.6s cubic-bezier(.4,0,.2,1)';
        area.style.transition = 'opacity .6s ease 1.2s';
        line.style.strokeDashoffset = 0;
        area.style.opacity = '';
        setTimeout(() => {
          line.style.transition = '';
          line.style.strokeDasharray = '';
          line.style.strokeDashoffset = '';
          area.style.transition = '';
        }, 2000);
      });
    }
    firstDraw = false;
  }

  function eventText(row) {
    const parts = [];
    if (row.received > 0) parts.push('Received ' + fmt.format(row.received));
    if (row.short > 0) parts.push('Out of stock, ' + fmt.format(row.short) + ' short');
    if (row.ordered > 0) parts.push('Ordered ' + fmt.format(row.ordered));
    return parts.join('. ');
  }

  function fillTable() {
    const frag = document.createDocumentFragment();
    for (const row of result.rows) {
      const tr = document.createElement('tr');
      [row.day, fmt.format(row.demand), fmt.format(row.onHand), fmt.format(row.onOrder), eventText(row)].forEach((value) => {
        const td = document.createElement('td');
        td.textContent = value;
        tr.appendChild(td);
      });
      frag.appendChild(tr);
    }
    rowsEl.textContent = '';
    rowsEl.appendChild(frag);
  }

  function tipLine(label, value) {
    const span = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = value;
    span.append(label, b);
    return span;
  }

  function showCursor(day) {
    cursor = Math.min(DAYS, Math.max(1, day));
    const row = result.rows[cursor - 1];
    const cross = document.getElementById('sim-cross');
    const x = scaleX(cursor);
    cross.setAttribute('visibility', 'visible');
    cross.firstChild.setAttribute('x1', x);
    cross.firstChild.setAttribute('x2', x);
    cross.lastChild.setAttribute('cx', x);
    cross.lastChild.setAttribute('cy', scaleY(row.onHand));

    tip.textContent = '';
    const head = document.createElement('strong');
    head.textContent = 'Day ' + row.day;
    tip.appendChild(head);
    tip.appendChild(tipLine('On hand', fmt.format(row.onHand)));
    tip.appendChild(tipLine('Demand', fmt.format(row.demand)));
    tip.appendChild(tipLine('On order', fmt.format(row.onOrder)));
    const note = eventText(row);
    if (note) {
      const extra = document.createElement('span');
      extra.textContent = note;
      tip.appendChild(extra);
    }
    tip.hidden = false;

    const box = plot.getBoundingClientRect();
    const px = (x / W) * box.width;
    const width = tip.offsetWidth;
    const left = px + 12 + width > box.width ? px - 12 - width : px + 12;
    tip.style.left = Math.max(0, left) + 'px';
  }

  function hideCursor() {
    cursor = null;
    tip.hidden = true;
    const cross = document.getElementById('sim-cross');
    if (cross) cross.setAttribute('visibility', 'hidden');
  }

  function dayFromPointer(event) {
    const box = svg.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * W;
    return Math.round(((x - X0) / (X1 - X0)) * DAYS);
  }

  function update() {
    const lead = Number(inLead.value);
    const cv = Number(inCv.value) / 100;
    const z = Number(sim.querySelector('input[name="svc"]:checked').value);
    outLead.textContent = lead + ' days';
    outCv.textContent = Math.round(cv * 100) + '%';

    result = simulate(lead, cv, z);
    document.getElementById('st-ss').textContent = fmt.format(result.safety);
    document.getElementById('st-rop').textContent = fmt.format(result.reorder);
    document.getElementById('st-avg').textContent = fmt.format(result.average);
    document.getElementById('st-out').textContent = fmt.format(result.outDays);

    const keep = cursor;
    draw();
    fillTable();
    if (keep) showCursor(keep);
  }

  sim.hidden = false;
  rollNoise();
  update();

  document.getElementById('sim-controls').addEventListener('input', update);
  document.getElementById('sim-controls').addEventListener('submit', (event) => event.preventDefault());
  document.getElementById('sim-roll').addEventListener('click', () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    rollNoise();
    update();
  });

  if (window.ResizeObserver) {
    let lastWidth = plot.clientWidth;
    new ResizeObserver(() => {
      if (Math.abs(plot.clientWidth - lastWidth) < 2) return;
      lastWidth = plot.clientWidth;
      const keep = cursor;
      draw();
      if (keep) showCursor(keep);
    }).observe(plot);
  }

  svg.addEventListener('pointermove', (event) => showCursor(dayFromPointer(event)));
  svg.addEventListener('pointerdown', (event) => showCursor(dayFromPointer(event)));
  svg.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse') hideCursor();
  });
  svg.addEventListener('blur', hideCursor);
  svg.addEventListener('keydown', (event) => {
    const steps = { ArrowLeft: -1, ArrowRight: 1, PageUp: -7, PageDown: 7 };
    if (event.key in steps) {
      event.preventDefault();
      showCursor((cursor || 0) + steps[event.key]);
    } else if (event.key === 'Home') {
      event.preventDefault();
      showCursor(1);
    } else if (event.key === 'End') {
      event.preventDefault();
      showCursor(DAYS);
    } else if (event.key === 'Escape') {
      hideCursor();
    }
  });
})();
