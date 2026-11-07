/* Birdie Tickets – Startseite: Effekte & Interaktionen */
(function () {
  'use strict';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = window.matchMedia('(pointer: fine)').matches;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  /* ---------- Hero-Überschrift einfliegen ---------- */
  const hero = $('.hero');
  requestAnimationFrame(() => setTimeout(() => hero && hero.classList.add('ready'), 80));

  /* ---------- Navigation ---------- */
  const nav = $('#nav');
  $('#navToggle').addEventListener('click', () => nav.classList.toggle('open'));
  $$('#nav a').forEach(a => a.addEventListener('click', () => nav.classList.remove('open')));

  /* ---------- Scroll: Fortschritt, Höhenmesser, Nav, Flugplan ---------- */
  const progress = $('#progress');
  const alt = $('#altimeter'), altFill = $('#altFill'), altBird = $('#altBird'), altVal = $('#altVal');
  const plan = $('#plan'), planPath = $('#planPath'), planBird = $('#planBird');
  let planLen = 0;
  if (planPath) {
    planLen = planPath.getTotalLength();
    planPath.style.strokeDasharray = planLen;
    planPath.style.strokeDashoffset = planLen;
  }
  const fmt = new Intl.NumberFormat('de-AT');
  let ticking = false;
  function onScroll() {
    ticking = false;
    const y = window.scrollY, max = document.documentElement.scrollHeight - innerHeight;
    const p = max > 0 ? Math.min(1, y / max) : 0;
    progress.style.transform = 'scaleX(' + p + ')';
    nav.classList.toggle('scrolled', y > 40);
    alt.classList.toggle('is-on', y > innerHeight * 0.6);
    altFill.style.height = (p * 100) + '%';
    altBird.style.bottom = (p * 100) + '%';
    altVal.textContent = fmt.format(Math.round(p * 10000 / 50) * 50) + ' m';

    if (plan && planLen && getComputedStyle(planBird).display !== 'none') {
      const r = plan.getBoundingClientRect();
      const start = innerHeight * 0.85, end = innerHeight * 0.25;
      let t = (start - r.top) / (start - end + r.height * 0.4);
      t = Math.max(0, Math.min(1, t));
      planPath.style.strokeDashoffset = planLen * (1 - t);
      const pt = planPath.getPointAtLength(planLen * t);
      const svg = planPath.ownerSVGElement.getBoundingClientRect();
      const x = pt.x / 1000 * svg.width, yy = pt.y / 220 * svg.height + (svg.top - r.top);
      const ahead = planPath.getPointAtLength(Math.min(planLen, planLen * t + 4));
      const ang = Math.atan2((ahead.y - pt.y) * svg.height / 220, (ahead.x - pt.x) * svg.width / 1000) * 180 / Math.PI;
      planBird.style.transform = 'translate(' + (x - 27) + 'px,' + (yy - 27) + 'px) rotate(' + (ang * 0.5) + 'deg)';
      planBird.style.opacity = t > 0.01 ? 1 : 0.4;
    }
  }
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
  window.addEventListener('resize', onScroll);
  onScroll();

  /* ---------- Einblenden + Zähler + Diagramm ---------- */
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      const el = e.target;
      el.classList.add('visible');
      $$('[data-count]', el).forEach(countUp);
      if (el.id === 'chart' || el.querySelector('#chart')) $('#chart').classList.add('go');
      io.unobserve(el);
    });
  }, { threshold: 0.14 });
  $$('.reveal, #fSlogan').forEach(el => io.observe(el));
  function countUp(el) {
    const to = +el.dataset.count;
    if (reduce || !to) { el.textContent = to; return; }
    const t0 = performance.now(), dur = 1600;
    (function step(t) {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 4);
      el.textContent = Math.round(to * e);
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }

  /* ---------- Spotlight auf den Kacheln ---------- */
  $$('.tile').forEach(t => t.addEventListener('pointermove', e => {
    const r = t.getBoundingClientRect();
    t.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    t.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }));

  /* ---------- Magnetische Buttons ---------- */
  if (fine && !reduce) {
    $$('.magnetic').forEach(b => {
      b.addEventListener('pointermove', e => {
        const r = b.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
        b.style.transform = 'translate(' + dx * 0.22 + 'px,' + dy * 0.3 + 'px)';
      });
      b.addEventListener('pointerleave', () => { b.style.transform = ''; });
    });
  }

  /* ---------- Hero: Parallax mit der Maus ---------- */
  const flight = $('#flight');
  if (flight && fine && !reduce) {
    const layers = $$('[data-depth]', flight);
    hero.addEventListener('pointermove', e => {
      const cx = (e.clientX / innerWidth - 0.5), cy = (e.clientY / innerHeight - 0.5);
      layers.forEach(l => {
        const d = +l.dataset.depth;
        l.style.transform = 'translate(' + (cx * d) + 'px,' + (cy * d) + 'px)';
      });
    });
  }
  /* Flugbahn der Mini-Tickets an die Größe anpassen */
  function scaleRoute() {
    if (!flight) return;
    const k = flight.clientWidth / 600;
    const d = 'M40,470 C140,330 210,520 320,360 S470,120 560,90'.replace(/-?\d+(\.\d+)?/g, n => (n * k).toFixed(1));
    $$('.fly-tkt', flight).forEach(t => { t.style.offsetPath = 'path("' + d + '")'; });
  }
  scaleRoute(); window.addEventListener('resize', scaleRoute);

  /* ---------- Hero: aufsteigende Lichtpunkte ---------- */
  const cv = $('#sky');
  if (cv && !reduce) {
    const ctx = cv.getContext('2d');
    let W = 0, H = 0, dpr = Math.min(2, window.devicePixelRatio || 1), parts = [], running = true;
    function size() {
      W = cv.clientWidth; H = cv.clientHeight;
      cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round(Math.min(90, W * H / 16000));
      parts = Array.from({ length: n }, () => mk(true));
    }
    function mk(any) {
      return { x: Math.random() * W, y: any ? Math.random() * H : H + 10, r: Math.random() * 1.8 + 0.4,
        s: Math.random() * 0.5 + 0.15, w: Math.random() * 2 * Math.PI, v: Math.random() < 0.3,
        a: Math.random() * 0.5 + 0.2 };
    }
    function frame() {
      if (!running) return;
      ctx.clearRect(0, 0, W, H);
      for (const p of parts) {
        p.y -= p.s; p.w += 0.01; p.x += Math.sin(p.w) * 0.25;
        if (p.y < -10) Object.assign(p, mk(false));
        const fade = Math.min(1, p.y / (H * 0.25));
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.v ? 'rgba(167,139,250,' + (p.a * fade) + ')' : 'rgba(232,220,196,' + (p.a * fade * 0.8) + ')';
        ctx.fill();
      }
      requestAnimationFrame(frame);
    }
    size(); window.addEventListener('resize', size);
    new IntersectionObserver(([e]) => { const was = running; running = e.isIntersecting; if (running && !was) frame(); }).observe(hero);
    frame();
  }

  /* ---------- Mini-Shop zum Ausprobieren ---------- */
  const shop = $('#miniShop');
  if (shop) {
    const eur = new Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' });
    const sum = () => {
      let s = 0;
      $$('.mrow', shop).forEach(r => { s += +r.dataset.price * +$('.n', r).textContent; });
      $('#miniSum').textContent = eur.format(s);
    };
    shop.addEventListener('click', e => {
      const b = e.target.closest('button[data-d]'); if (!b) return;
      const n = $('.n', b.closest('.mrow'));
      n.textContent = Math.max(0, Math.min(9, +n.textContent + +b.dataset.d));
      sum();
    });
  }

  /* ---------- Sitzplan zum Ausprobieren ---------- */
  const seats = $('#seatDemo');
  if (seats) {
    const sold = new Set([1, 2, 6, 9, 12, 13, 19, 21, 26, 27, 30, 35, 38]);
    const sel = new Set([17, 18]);
    let h = '';
    for (let i = 0; i < 40; i++) {
      const c = sel.has(i) ? 'sel' : sold.has(i) ? 'sold' : '';
      h += '<button type="button" class="' + c + '" aria-label="Platz ' + (i + 1) + '"></button>';
    }
    seats.innerHTML = h;
    seats.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || b.classList.contains('sold')) return;
      b.classList.toggle('sel');
    });
  }

  /* ---------- 3D-Ticket ---------- */
  const tk = $('#tk3d');
  if (tk && fine && !reduce) {
    const stage = tk.parentElement;
    stage.addEventListener('pointermove', e => {
      const r = tk.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      tk.style.transform = 'rotateY(' + ((px - 0.5) * 22) + 'deg) rotateX(' + ((0.5 - py) * 18) + 'deg)';
      tk.style.setProperty('--gx', px * 100 + '%'); tk.style.setProperty('--gy', py * 100 + '%');
      tk.style.setProperty('--hx', px * 100 + '%');
    });
    stage.addEventListener('pointerleave', () => { tk.style.transform = ''; });
  } else if (tk && !reduce) {
    let a = 0;
    (function idle() { a += 0.012; tk.style.transform = 'rotateY(' + Math.sin(a) * 10 + 'deg) rotateX(' + Math.cos(a * 0.8) * 6 + 'deg)'; tk.style.setProperty('--hx', (50 + Math.sin(a) * 40) + '%'); requestAnimationFrame(idle); })();
  }

  /* ---------- QR-Muster (dekorativ, mit Positionsmarken) ---------- */
  $$('.qr-box').forEach((box, k) => {
    const N = 25; let seed = 7 + k * 13;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const finder = (x, y) => {
      for (const [fx, fy] of [[0, 0], [N - 7, 0], [0, N - 7]]) {
        const dx = x - fx, dy = y - fy;
        if (dx >= -1 && dx <= 7 && dy >= -1 && dy <= 7) {
          if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return 0;
          const ring = Math.min(dx, dy, 6 - dx, 6 - dy);
          return ring === 1 ? 0 : 1;
        }
      }
      return -1;
    };
    let r = '';
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const f = finder(x, y);
      if (f === 1 || (f === -1 && rnd() < 0.47)) r += 'M' + x + ' ' + y + 'h1v1h-1z';
    }
    box.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 ' + N + ' ' + N + '" shape-rendering="crispEdges" aria-hidden="true"><path fill="#1F3D2B" d="' + r + '"/></svg>');
    box.classList.add('has-svg');
  });

  /* ---------- Sanftes Scrollen zu Ankern ---------- */
  $$('a[href^="#"]').forEach(a => a.addEventListener('click', e => {
    const id = a.getAttribute('href'); if (id.length < 2) return;
    const t = document.querySelector(id);
    if (t) { e.preventDefault(); t.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' }); }
  }));
})();
