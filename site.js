/* Thompson SWE LLC
   One working tool on the home page. No dependencies. */

/* ---------------------------------------------------------------------------
   Cost of a manual task: hours x people x hourly cost x 50 working weeks.
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
