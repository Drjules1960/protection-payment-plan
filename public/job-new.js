// Adds and removes payment step rows, fills in templates, and shows the running total.
(function () {
  const TEMPLATES = {
    kitchen: [['Materials delivered', 'inspector'], ['Demolition and rough-in', 'permit'], ['Cabinets and counters installed', 'inspector'], ['Final inspection', 'permit']],
    bath: [['Materials delivered', 'inspector'], ['Demo, plumbing rough-in and waterproofing', 'permit'], ['Tile and vanity installed', 'inspector'], ['Final inspection', 'permit']],
    roof: [['Materials delivered', 'inspector'], ['Tear-off and decking repair', 'inspector'], ['Shingles and flashing installed', 'inspector'], ['Final inspection', 'permit']],
  };
  const list = document.getElementById('steps');
  const totalEl = document.getElementById('job-total');
  const blank = list.querySelector('.steprow').cloneNode(true);
  blank.querySelectorAll('input').forEach((i) => { i.value = ''; });

  function addRow(name, proof) {
    const row = blank.cloneNode(true);
    row.querySelector('[name=step_name]').value = name || '';
    row.querySelector('[name=step_proof]').value = proof || 'inspector';
    list.appendChild(row);
    return row;
  }
  function updateTotal() {
    let cents = 0;
    list.querySelectorAll('[name=step_amount]').forEach((i) => {
      const n = Number(i.value.replace(/[$,\s]/g, ''));
      if (n > 0) cents += Math.round(n * 100);
    });
    totalEl.textContent = (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }
  document.getElementById('add-step').addEventListener('click', () => addRow().querySelector('input').focus());
  list.addEventListener('click', (e) => {
    if (!e.target.closest('.remove')) return;
    if (list.children.length > 1) e.target.closest('.steprow').remove();
    updateTotal();
  });
  list.addEventListener('input', updateTotal);
  document.querySelectorAll('[data-template]').forEach((b) => b.addEventListener('click', () => {
    list.innerHTML = '';
    TEMPLATES[b.dataset.template].forEach(([n, p]) => addRow(n, p));
    updateTotal();
  }));
  updateTotal();
})();
