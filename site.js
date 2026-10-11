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
   2. From the register to the supplier order.

   A made-up parts counter: eight products, three suppliers.

   Each day
     Orders due that day arrive and go on the shelf.
     The register rings up sales. A sale lowers the shelf count.
     A customer who asks for a product that is out counts as one "ran out".
     Any product at or below its reorder level, counting what is already on
     the way, goes on a draft order for its supplier. The quantity brings it
     back up to its full level, rounded up to the supplier's pack size.

   Sending
     The visitor sends each draft, or switches to automatic and every draft
     is sent the day it is written. A sent order arrives after the supplier's
     delivery time.
   ------------------------------------------------------------------------ */
(() => {
  'use strict';

  const root = document.getElementById('flow');
  if (!root || !window.Intl) return;

  const SUPPLIERS = [
    { id: 'parts', name: 'Parts distributor', lead: 2 },
    { id: 'fluids', name: 'Fluids supplier', lead: 3 },
    { id: 'shop', name: 'Shop supplies', lead: 5 }
  ];

  /* start: opening count, low: reorder level, full: level an order brings it back to,
     pack: supplier pack size, rate: average sold per normal day */
  const PRODUCTS = [
    { name: 'Oil filter', supplier: 'parts', start: 17, low: 14, full: 36, pack: 6, cost: 4.5, rate: 4.5 },
    { name: 'Front brake pads', supplier: 'parts', start: 10, low: 5, full: 12, pack: 2, cost: 28, rate: 1.4 },
    { name: 'Wiper blades', supplier: 'parts', start: 16, low: 7, full: 20, pack: 4, cost: 7, rate: 2 },
    { name: 'Cabin air filter', supplier: 'parts', start: 6, low: 5, full: 12, pack: 4, cost: 9, rate: 1.2 },
    { name: 'Motor oil, 5 qt', supplier: 'fluids', start: 26, low: 19, full: 42, pack: 6, cost: 19, rate: 4 },
    { name: 'Coolant, 1 gal', supplier: 'fluids', start: 10, low: 6, full: 12, pack: 6, cost: 11, rate: 1 },
    { name: 'Brake cleaner', supplier: 'shop', start: 24, low: 15, full: 36, pack: 12, cost: 3.5, rate: 1.8 },
    { name: 'Shop towels, box', supplier: 'shop', start: 10, low: 9, full: 18, pack: 6, cost: 14, rate: 0.9 }
  ];

  const BUSY = { quiet: 0.6, normal: 1, busy: 1.5 };

  const $ = (id) => document.getElementById(id);
  const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const plural = (n, word) => int.format(n) + ' ' + word + (n === 1 ? '' : 's');

  let state = null;
  let rand = null;

  /* ---------- Model ---------- */

  function mulberry32(a) {
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* number of units asked for in a day, Poisson around the mean */
  function draw(mean) {
    const limit = Math.exp(-mean);
    let k = 0;
    let p = rand();
    while (p > limit) {
      k += 1;
      p *= rand();
    }
    return k;
  }

  function reset() {
    rand = mulberry32(20261010);
    state = {
      day: 0,
      sold: 0,
      sent: 0,
      ranOut: 0,
      today: [],
      arrived: [],
      drafts: [],
      open: [],
      items: PRODUCTS.map((p) => Object.assign({ onHand: p.start, onOrder: 0 }, p))
    };
  }

  const mode = () => root.querySelector('input[name="fl-mode"]:checked').value;
  const busy = () => BUSY[root.querySelector('input[name="fl-busy"]:checked').value];

  function writeDrafts() {
    state.drafts = [];
    SUPPLIERS.forEach((s) => {
      const lines = [];
      state.items.forEach((item) => {
        if (item.supplier !== s.id) return;
        if (item.onHand + item.onOrder > item.low) return;
        const need = item.full - item.onHand - item.onOrder;
        const qty = Math.ceil(need / item.pack) * item.pack;
        lines.push({ item, qty, cost: qty * item.cost });
      });
      if (lines.length) {
        state.drafts.push({ supplier: s, lines, total: lines.reduce((sum, l) => sum + l.cost, 0) });
      }
    });
  }

  function send(draft) {
    draft.lines.forEach((line) => { line.item.onOrder += line.qty; });
    state.open.push({ supplier: draft.supplier, lines: draft.lines, total: draft.total, due: state.day + draft.supplier.lead });
    state.sent += 1;
    state.drafts = state.drafts.filter((d) => d !== draft);
  }

  function runDay() {
    state.day += 1;

    state.arrived = state.open.filter((o) => o.due <= state.day);
    state.open = state.open.filter((o) => o.due > state.day);
    state.arrived.forEach((order) => {
      order.lines.forEach((line) => {
        line.item.onHand += line.qty;
        line.item.onOrder -= line.qty;
      });
    });

    const factor = busy();
    state.today = [];
    state.items.forEach((item) => {
      const asked = draw(item.rate * factor);
      const sold = Math.min(asked, item.onHand);
      item.onHand -= sold;
      state.sold += sold;
      if (asked > sold) state.ranOut += 1;
      if (asked > 0) state.today.push({ item, sold, short: asked - sold });
    });
    state.today.sort((a, b) => b.sold - a.sold);

    writeDrafts();
    if (mode() === 'auto') state.drafts.slice().forEach(send);
  }

  /* ---------- Screen ---------- */

  function el(name, className, text) {
    const node = document.createElement(name);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderSales() {
    const list = $('flow-sales');
    list.textContent = '';
    const total = state.today.reduce((sum, line) => sum + line.sold, 0);
    $('flow-sales-sub').textContent = state.day === 0
      ? 'The shop has not opened yet. Run a day.'
      : 'Day ' + state.day + ': ' + plural(total, 'item') + ' sold.';
    state.today.forEach((line) => {
      const row = el('li');
      row.appendChild(el('span', 'flow-qty', line.sold + ' ×'));
      row.appendChild(el('span', 'flow-name', line.item.name));
      if (line.short) row.appendChild(el('span', 'flow-flag flow-out', plural(line.short, 'customer') + ' turned away'));
      list.appendChild(row);
    });
  }

  function statusOf(item) {
    if (item.onHand === 0) return { text: item.onOrder ? 'Out, more on the way' : 'Out', kind: 'out' };
    if (item.onOrder) return { text: 'On the way', kind: 'way' };
    if (item.onHand <= item.low) return { text: 'Low', kind: 'low' };
    return { text: 'Fine', kind: 'ok' };
  }

  function renderShelf() {
    const body = $('flow-shelf');
    body.textContent = '';
    state.items.forEach((item) => {
      const status = statusOf(item);
      const row = el('tr');
      row.appendChild(el('th', 'left', item.name));
      row.firstChild.scope = 'row';

      const count = el('td', 'flow-count');
      const meter = el('span', 'flow-meter');
      meter.setAttribute('aria-hidden', 'true');
      const scale = Math.max(item.full, item.onHand);
      const fill = el('span', 'flow-fill flow-' + status.kind);
      fill.style.width = (item.onHand / scale * 100) + '%';
      const mark = el('span', 'flow-mark');
      mark.style.left = (item.low / scale * 100) + '%';
      meter.appendChild(fill);
      meter.appendChild(mark);
      count.appendChild(meter);
      count.appendChild(el('span', 'flow-num', int.format(item.onHand)));
      row.appendChild(count);

      row.appendChild(el('td', 'flow-at', int.format(item.low)));
      const state_ = el('td', 'left');
      state_.appendChild(el('span', 'flow-flag flow-' + status.kind, status.text));
      row.appendChild(state_);
      body.appendChild(row);
    });
  }

  function orderCard(order, sent) {
    const card = el('article', 'flow-order' + (sent ? ' flow-sent' : ''));
    const head = el('div', 'flow-order-head');
    head.appendChild(el('h5', null, order.supplier.name));
    head.appendChild(el('span', 'flow-total', money.format(order.total)));
    card.appendChild(head);

    const lines = el('ul');
    order.lines.forEach((line) => {
      const row = el('li');
      row.appendChild(el('span', 'flow-qty', line.qty + ' ×'));
      row.appendChild(el('span', 'flow-name', line.item.name));
      lines.appendChild(row);
    });
    card.appendChild(lines);

    if (sent) {
      const days = order.due - state.day;
      card.appendChild(el('p', 'flow-due', 'Sent. Arrives ' + (days === 1 ? 'tomorrow' : 'in ' + days + ' days') + '.'));
    } else {
      const button = el('button', 'button button-small', 'Send to ' + order.supplier.name.toLowerCase());
      button.type = 'button';
      button.addEventListener('click', () => {
        send(order);
        render('Order sent to ' + order.supplier.name.toLowerCase() + '. It arrives in ' + plural(order.supplier.lead, 'day') + '.');
        const next = $('flow-orders').querySelector('button') || $('flow-day');
        next.focus();
      });
      card.appendChild(button);
    }
    return card;
  }

  function renderOrders() {
    const box = $('flow-orders');
    box.textContent = '';
    state.drafts.forEach((draft) => box.appendChild(orderCard(draft, false)));
    state.open.forEach((order) => box.appendChild(orderCard(order, true)));
    if (!state.drafts.length && !state.open.length) {
      box.appendChild(el('p', 'flow-empty', 'Nothing is low, so there is nothing to order.'));
    }
    $('flow-orders-sub').textContent = state.drafts.length
      ? plural(state.drafts.length, 'order') + ' ready for you to send.'
      : (mode() === 'auto' ? 'Orders go out the day they are written.' : 'No order is waiting on you.');
  }

  function summary() {
    if (state.day === 0) return 'Opening counts are in. Run a day to see sales come through.';
    const parts = ['Day ' + state.day + ' closed'];
    if (state.arrived.length) parts.push(state.arrived.length === 1 ? '1 delivery put away' : state.arrived.length + ' deliveries put away');
    if (state.drafts.length) parts.push(plural(state.drafts.length, 'order') + ' waiting for you to send');
    else if (!state.arrived.length) parts.push('nothing needs you');
    return parts.join(', ') + '.';
  }

  function render(message) {
    renderSales();
    renderShelf();
    renderOrders();
    $('fl-day').textContent = int.format(state.day);
    $('fl-sold').textContent = int.format(state.sold);
    $('fl-sent').textContent = int.format(state.sent);
    $('fl-out').textContent = int.format(state.ranOut);
    $('flow-status').textContent = message || summary();
  }

  /* ---------- Wiring ---------- */

  reset();
  runDay();
  root.hidden = false;
  render();

  $('flow-controls').addEventListener('submit', (event) => event.preventDefault());
  $('flow-controls').addEventListener('change', (event) => {
    if (event.target.name !== 'fl-mode') return;
    if (mode() === 'auto') state.drafts.slice().forEach(send);
    render(mode() === 'auto' ? 'The software now sends each order the day it is written.' : 'You send each order yourself.');
  });
  $('flow-day').addEventListener('click', () => {
    runDay();
    render();
  });
  $('flow-week').addEventListener('click', () => {
    for (let i = 0; i < 7; i += 1) runDay();
    render();
  });
  $('flow-reset').addEventListener('click', () => {
    reset();
    runDay();
    render('Started over at day 1.');
  });
})();
