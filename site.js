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
   2. Same store, two ways.

   Two copies of one made-up corner store get exactly the same customers for
   two weeks: eight products, three suppliers.

   Counted by hand
     Every Monday morning the owner counts each shelf and orders enough to
     fill it, rounded to the supplier's case size. The count takes two hours.

   Software
     Every sale lowers the count. After closing, the software updates how fast
     each product is selling. A product whose count, plus what is already on
     the way, will not last until a new order could arrive (with a margin for
     a busy day) goes on an order to its supplier. Orders go out next morning.

   Both stores
     Deliveries arrive in the morning, after the supplier's delivery time.
     A customer who wants a product that is out is turned away and the sale
     is lost.

   The whole two weeks is worked out up front, one snapshot per day, and
   playing it only steps through the snapshots.
   ------------------------------------------------------------------------ */
(() => {
  'use strict';

  const root = document.getElementById('race');
  if (!root || !window.Intl) return;

  const SUPPLIERS = {
    drinks: { name: 'beverage distributor', lead: 2 },
    snacks: { name: 'snack distributor', lead: 3 },
    goods: { name: 'general goods wholesaler', lead: 5 }
  };

  /* start: Monday-morning count, full: what the shelf holds, pack: case size,
     rate: average wanted per ordinary day, price: shelf price */
  const PRODUCTS = [
    { name: 'Bottled water', word: 'water', supplier: 'drinks', start: 46, full: 72, pack: 24, rate: 9, price: 1.79 },
    { name: 'Cola', word: 'cola', supplier: 'drinks', start: 50, full: 72, pack: 24, rate: 7, price: 2.29 },
    { name: 'Energy drinks', word: 'energy drinks', supplier: 'drinks', start: 24, full: 36, pack: 12, rate: 4, price: 3.29 },
    { name: 'Potato chips', word: 'chips', supplier: 'snacks', start: 34, full: 48, pack: 12, rate: 5, price: 2.19 },
    { name: 'Candy bars', word: 'candy bars', supplier: 'snacks', start: 52, full: 72, pack: 24, rate: 6, price: 1.99 },
    { name: 'Beef jerky', word: 'jerky', supplier: 'snacks', start: 16, full: 24, pack: 12, rate: 1.5, price: 7.99 },
    { name: 'Paper towels', word: 'paper towels', supplier: 'goods', start: 14, full: 18, pack: 6, rate: 1, price: 2.49 },
    { name: 'Phone chargers', word: 'phone chargers', supplier: 'goods', start: 12, full: 18, pack: 6, rate: 0.8, price: 12.99 }
  ];

  const DAYS = 14;
  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const WEEKDAY = [0.9, 0.9, 0.95, 1, 1.15, 1.3, 1.1];   /* weekends are busier */
  const HEAT = { drinks: 1.6, snacks: 1.1, goods: 1 };  /* heat wave: far more drinks */
  const COUNT_HOURS = 2;
  const MARGIN = 2;     /* safety margin, in standard deviations of demand */
  const LEARN = 0.4;    /* how quickly the software follows a change in pace */
  const FIRST_SEED = 20261017;
  const STEP_MS = 650;
  const LOW = 0.2;      /* a shelf at or under a fifth full shows as low */

  const $ = (id) => document.getElementById(id);
  const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const plural = (n, one, many) => int.format(n) + ' ' + (n === 1 ? one : many);
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function mulberry32(a) {
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* customers wanting one product on one day, Poisson around the mean */
  function draw(rand, mean) {
    const limit = Math.exp(-mean);
    let k = 0;
    let p = rand();
    while (p > limit) {
      k += 1;
      p *= rand();
    }
    return k;
  }

  function list(words) {
    if (words.length < 3) return words.join(' and ');
    return words.slice(0, -1).join(', ') + ', and ' + words[words.length - 1];
  }

  /* ---------- Model ---------- */

  function newStore() {
    return {
      items: PRODUCTS.map((p) => ({ p, onHand: p.start, onOrder: 0, pace: p.rate })),
      open: [],
      away: 0,
      lost: 0,
      hours: 0
    };
  }

  function snapshot(store, today) {
    return {
      onHand: store.items.map((it) => it.onHand),
      onOrder: store.items.map((it) => it.onOrder),
      away: store.away,
      lost: store.lost,
      hours: store.hours,
      today
    };
  }

  function placeOrders(store, lines, arrives) {
    const bySupplier = {};
    lines.forEach((line) => {
      line.item.onOrder += line.qty;
      (bySupplier[line.item.p.supplier] = bySupplier[line.item.p.supplier] || []).push(line);
    });
    Object.keys(bySupplier).forEach((id) => {
      store.open.push({ due: arrives(SUPPLIERS[id].lead), lines: bySupplier[id] });
    });
  }

  function simulate(seed, heat) {
    const rand = mulberry32(seed);
    const wanted = [];
    for (let d = 0; d < DAYS; d += 1) {
      wanted.push(PRODUCTS.map((p) => draw(rand, p.rate * WEEKDAY[d % 7] * (heat ? HEAT[p.supplier] : 1))));
    }

    const hand = newStore();
    const soft = newStore();
    const days = [{ hand: snapshot(hand, null), soft: snapshot(soft, null) }];

    for (let d = 0; d < DAYS; d += 1) {
      const today = { hand: { out: [], away: 0, counted: false, delivered: [], ordered: [] }, soft: { out: [], away: 0, delivered: [], ordered: [] } };

      /* morning deliveries */
      [['hand', hand], ['soft', soft]].forEach(([key, store]) => {
        store.open.filter((o) => o.due === d).forEach((order) => {
          order.lines.forEach((line) => {
            line.item.onHand += line.qty;
            line.item.onOrder -= line.qty;
          });
          today[key].delivered.push(SUPPLIERS[order.lines[0].item.p.supplier].name);
        });
        store.open = store.open.filter((o) => o.due !== d);
      });

      /* Monday morning: the owner counts and fills every shelf */
      if (d % 7 === 0) {
        const lines = [];
        hand.items.forEach((item) => {
          const qty = Math.round((item.p.full - item.onHand - item.onOrder) / item.p.pack) * item.p.pack;
          if (qty > 0) lines.push({ item, qty });
        });
        placeOrders(hand, lines, (lead) => d + lead);
        hand.hours += COUNT_HOURS;
        today.hand.counted = true;
      }

      /* the same customers walk into both stores */
      [['hand', hand], ['soft', soft]].forEach(([key, store]) => {
        store.items.forEach((item, i) => {
          const want = wanted[d][i];
          const sold = Math.min(want, item.onHand);
          item.onHand -= sold;
          item.sold = sold;
          if (want > sold) {
            store.away += want - sold;
            store.lost += (want - sold) * item.p.price;
            today[key].away += want - sold;
            today[key].out.push(item.p.word);
          }
        });
      });

      /* after closing: the software learns the pace and writes orders */
      const lines = [];
      soft.items.forEach((item) => {
        item.pace = (1 - LEARN) * item.pace + LEARN * (item.sold / WEEKDAY[d % 7]);
        const lead = SUPPLIERS[item.p.supplier].lead;
        let need = 0;
        for (let k = 1; k <= lead + 1; k += 1) need += item.pace * WEEKDAY[(d + k) % 7];
        const trigger = Math.ceil(need + MARGIN * Math.sqrt(need));
        const position = item.onHand + item.onOrder;
        if (position > trigger) return;
        /* as many whole cases as the shelf has room for; a single case if there
           is no room for one, unless one is already on the way */
        let qty = Math.floor((item.p.full - position) / item.p.pack) * item.p.pack;
        if (qty === 0 && item.onOrder === 0) qty = item.p.pack;
        if (qty === 0) return;
        lines.push({ item, qty });
        today.soft.ordered.push(item.p.word);
      });
      placeOrders(soft, lines, (lead) => d + 1 + lead);

      days.push({ hand: snapshot(hand, today.hand), soft: snapshot(soft, today.soft) });
    }
    return days;
  }

  /* ---------- Screen ---------- */

  const shelf = $('race-shelf');
  const strip = $('race-days');
  const play = $('race-play');
  const cells = { hand: [], soft: [] };

  function el(name, className, text) {
    const node = document.createElement(name);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function buildCell() {
    const td = el('td');
    const wrap = el('span', 'race-cell');
    const bar = el('span', 'race-bar');
    bar.setAttribute('aria-hidden', 'true');
    const fill = el('span', 'race-fill');
    const way = el('span', 'race-way');
    bar.appendChild(fill);
    bar.appendChild(way);
    const num = el('span', 'race-num');
    const note = el('span', 'visually-hidden');
    wrap.appendChild(bar);
    wrap.appendChild(num);
    wrap.appendChild(note);
    td.appendChild(wrap);
    return { td, wrap, fill, way, num, note };
  }

  PRODUCTS.forEach((p) => {
    const row = el('tr');
    const name = el('th', null, p.name);
    name.scope = 'row';
    row.appendChild(name);
    ['hand', 'soft'].forEach((key) => {
      const cell = buildCell();
      cells[key].push(cell);
      row.appendChild(cell.td);
    });
    shelf.appendChild(row);
  });

  for (let d = 0; d < DAYS; d += 1) strip.appendChild(el('li', null, DAY_NAMES[d % 7][0]));

  function handNews(t) {
    const parts = [];
    if (t.counted) parts.push('Spent ' + COUNT_HOURS + ' hours counting shelves and writing orders.');
    if (t.out.length) parts.push('Out of ' + list(t.out) + '. ' + plural(t.away, 'customer', 'customers') + ' turned away.');
    else if (t.delivered.length && !t.counted) parts.push(t.delivered.length === 1 ? 'A delivery came in.' : 'Two deliveries came in.');
    if (!t.out.length) parts.push(t.counted || t.delivered.length ? 'Nothing ran out.' : 'Nothing ran out. Nothing to do until Monday.');
    return parts.join(' ');
  }

  function softNews(t) {
    const parts = [];
    if (t.out.length) parts.push('Out of ' + list(t.out) + '. ' + plural(t.away, 'customer', 'customers') + ' turned away.');
    if (t.ordered.length) parts.push('Ordered ' + list(t.ordered) + ' tonight, before ' + (t.ordered.length === 1 ? 'it runs' : 'they run') + ' out.');
    else if (t.delivered.length) parts.push(t.delivered.length === 1 ? 'A delivery came in.' : 'Two deliveries came in.');
    if (!t.out.length) parts.push('Nothing ran out.');
    return parts.join(' ');
  }

  function verdict(days, heat) {
    const end = days[DAYS];
    const h = end.hand;
    const s = end.soft;
    const lead = heat ? 'In a heat wave, with the same customers in both stores, ' : 'Same customers, same shelves. ';
    const handPart = (heat ? 'counting by hand' : 'Counting by hand') + ' turned away ' + plural(h.away, 'customer', 'customers') +
      ', lost ' + money.format(h.lost) + ' in sales, and took ' + plural(h.hours, 'hour', 'hours') + ' of the owner’s time. ';
    const softPart = s.away === 0
      ? 'The software turned away nobody, and nobody counted anything.'
      : 'The software turned away ' + int.format(s.away) + ', and nobody counted anything.';
    return lead + handPart + softPart;
  }

  let days = null;
  let step = 0;
  let timer = null;
  let runs = 0;

  const heat = () => root.querySelector('input[name="race-weeks"]:checked').value === 'heat';

  function render() {
    const snap = days[step];
    $('race-day').textContent = step === 0
      ? 'Week 1, Monday morning'
      : 'Week ' + (step <= 7 ? 1 : 2) + ', ' + DAY_NAMES[(step - 1) % 7];

    Array.prototype.forEach.call(strip.children, (li, i) => {
      li.className = i < step - 1 ? 'is-past' : (i === step - 1 ? 'is-now' : '');
    });

    if (step === 0) {
      $('race-news-hand').textContent = 'Opens Monday with the same shelves as the store next door.';
      $('race-news-soft').textContent = 'Opens Monday with the same shelves. Press play.';
    } else {
      $('race-news-hand').textContent = handNews(snap.hand.today);
      $('race-news-soft').textContent = softNews(snap.soft.today);
    }

    ['hand', 'soft'].forEach((key) => {
      const s = snap[key];
      PRODUCTS.forEach((p, i) => {
        const c = cells[key][i];
        const onHand = s.onHand[i];
        const onOrder = s.onOrder[i];
        const fill = Math.min(onHand / p.full, 1);
        const way = Math.min(onOrder / p.full, 1 - fill);
        c.fill.style.width = (fill * 100) + '%';
        c.way.style.width = (way * 100) + '%';
        c.fill.classList.toggle('is-low', onHand > 0 && onHand <= p.full * LOW);
        c.wrap.classList.toggle('is-out', onHand === 0);
        c.num.textContent = onHand === 0 ? 'Out' : int.format(onHand);
        c.note.textContent = onOrder ? ', ' + int.format(onOrder) + ' on the way' : '';
      });
      const awayCell = $('race-away-' + key);
      awayCell.textContent = int.format(s.away);
      awayCell.classList.toggle('is-bad', s.away > 0);
      const lostCell = $('race-lost-' + key);
      lostCell.textContent = money.format(s.lost);
      lostCell.classList.toggle('is-bad', s.lost > 0);
      $('race-hours-' + key).textContent = int.format(s.hours);
    });

    $('race-verdict').textContent = step === DAYS ? verdict(days, heat()) : '';
    play.textContent = timer ? 'Pause' : (step === 0 ? 'Play two weeks' : (step === DAYS ? 'Play again' : 'Keep going'));
    $('race-skip').disabled = step === DAYS;
  }

  function stop() {
    if (timer) window.clearInterval(timer);
    timer = null;
  }

  function load() {
    stop();
    days = simulate(runs === 0 ? FIRST_SEED : FIRST_SEED + runs * 7919, heat());
    step = 0;
  }

  function advance() {
    step += 1;
    if (step >= DAYS) {
      step = DAYS;
      stop();
    }
    render();
  }

  function start() {
    if (step === DAYS) {
      runs += 1;
      load();
    }
    timer = window.setInterval(advance, reduceMotion ? STEP_MS * 1.4 : STEP_MS);
    advance();
  }

  load();
  root.hidden = false;
  render();

  $('race-controls').addEventListener('submit', (event) => event.preventDefault());
  $('race-controls').addEventListener('change', (event) => {
    if (event.target.name !== 'race-weeks') return;
    load();
    render();
  });
  play.addEventListener('click', () => {
    if (timer) {
      stop();
      render();
    } else {
      start();
    }
  });
  $('race-skip').addEventListener('click', () => {
    stop();
    step = DAYS;
    render();
  });
})();
