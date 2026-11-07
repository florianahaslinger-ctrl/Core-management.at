/* Birdie Tickets – dezente Effekte im Ticketshop (reine Optik, keine Shop-Logik) */
(function () {
  'use strict';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = window.matchMedia('(pointer: fine)').matches;

  /* Neu gerenderte Event-Karten und Tickets gestaffelt einblenden */
  function stagger(root, sel) {
    if (!root || reduce) return;
    let i = 0;
    root.querySelectorAll(sel).forEach(el => {
      if (el.dataset.fx) return;
      el.dataset.fx = '1';
      el.style.setProperty('--fx-d', (i++ * 0.08) + 's');
      el.classList.add('fx-in');
      if (el.classList.contains('ticket') && !el.querySelector('.fx-holo')) {
        el.insertAdjacentHTML('beforeend', '<span class="fx-holo" aria-hidden="true"></span>');
      }
    });
  }
  const events = document.getElementById('eventList');
  const mine = document.getElementById('myTicketsArea');
  [[events, '.card'], [mine, '.ticket']].forEach(([root, sel]) => {
    if (!root) return;
    stagger(root, sel);
    new MutationObserver(() => stagger(root, sel)).observe(root, { childList: true, subtree: true });
  });

  /* Lichtkegel auf den Event-Karten, Holo-Glanz auf den Tickets */
  if (fine) {
    document.addEventListener('pointermove', e => {
      const card = e.target.closest && e.target.closest('#eventList .card');
      if (card) {
        const r = card.getBoundingClientRect();
        card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
        card.style.setProperty('--my', (e.clientY - r.top) + 'px');
      }
      const tk = e.target.closest && e.target.closest('.ticket');
      if (tk) {
        const r = tk.getBoundingClientRect();
        tk.style.setProperty('--hx', ((e.clientX - r.left) / r.width * 100) + '%');
      }
    }, { passive: true });
  }

  /* „+“ gedrückt: Mini-Ticket fliegt in den Warenkorb, Summe poppt */
  if (events && !reduce) {
    let before = null;
    events.addEventListener('pointerdown', e => {
      const b = e.target.closest('button[data-d="1"]');
      const inp = b && b.parentElement.querySelector('input');
      before = inp ? inp.value : null;
    });
    events.addEventListener('click', e => {
      const b = e.target.closest('button[data-d="1"]');
      if (!b) return;
      const inp = b.parentElement.querySelector('input');
      const was = before; before = null;
      setTimeout(() => {
        if (inp && was !== null && inp.value === was) return;   // Maximum erreicht – nichts hinzugefügt
        fly(b);
      }, 30);
    });
  }
  function fly(fromEl) {
    const sum = document.getElementById('cartSum');
    const from = fromEl.getBoundingClientRect();
    const to = sum && sum.offsetParent ? sum.getBoundingClientRect()
      : { left: innerWidth / 2, top: innerHeight - 40, width: 0, height: 0 };
    const t = document.createElement('span');
    t.className = 'fx-fly';
    document.body.appendChild(t);
    const x0 = from.left + from.width / 2 - 15, y0 = from.top + from.height / 2 - 9;
    const x1 = to.left + to.width / 2 - 15, y1 = to.top + to.height / 2 - 9;
    const lift = Math.min(160, Math.abs(y1 - y0) * 0.5 + 60);
    const anim = t.animate([
      { transform: `translate(${x0}px,${y0}px) rotate(0deg) scale(.6)`, opacity: 0 },
      { transform: `translate(${(x0 + x1) / 2}px,${Math.min(y0, y1) - lift}px) rotate(-18deg) scale(1.15)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${x1}px,${y1}px) rotate(8deg) scale(.5)`, opacity: 0.2 }
    ], { duration: 750, easing: 'cubic-bezier(.4,0,.2,1)' });
    t.style.left = '0'; t.style.top = '0';
    anim.onfinish = () => {
      t.remove();
      if (sum) { sum.classList.remove('pop'); void sum.offsetWidth; sum.classList.add('pop'); }
    };
  }
})();
