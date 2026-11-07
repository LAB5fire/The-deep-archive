(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const hexOf = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
  const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const roman = (n) => { let o = ''; for (const [v, s] of [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) while (n >= v) { o += s; n -= v; } return o; };
  const el = (tag, attrs = {}, kids = []) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === 'text') e.textContent = v; else if (k === 'html') e.innerHTML = v; else e.setAttribute(k, v); }
    for (const c of [].concat(kids)) e.append(c);
    return e;
  };
  const svgEl = (name, attrs = {}) => { const e = document.createElementNS('http://www.w3.org/2000/svg', name); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

  const KEY = 'archive-v1';
  let IDX = null;
  const S = { seals: {}, notes: {}, hints: {}, widget: {} };
  try { Object.assign(S, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* ignore */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* ignore */ } };
  const cache = {};
  let curId = null, curPayload = null;
  const assetCache = {}, extraAssets = {};

  // ---------- crypto ----------
  async function pbkdf(str, saltB64) {
    const base = await crypto.subtle.importKey('raw', enc.encode(str), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64d(saltB64), iterations: IDX.iter }, base, 512));
  }
  async function aesDec(key32, blob) {
    const key = await crypto.subtle.importKey('raw', key32, 'AES-GCM', false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12) }, key, blob.slice(12)));
  }
  async function gunzip(u8) {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const isOpen = (id) => IDX.puzzles[id].gate.ids.every((g) => S.seals[g] !== undefined);
  async function getPayload(id) {
    if (cache[id]) return cache[id];
    const P = IDX.puzzles[id];
    if (!isOpen(id)) return null;
    const key = (await pbkdf(P.gate.ids.map((g) => S.seals[g]).join('#'), P.gate.salt)).slice(32);
    const blob = new Uint8Array(await (await fetch(`data/p/${P.file}.bin?v=${IDX.v}`)).arrayBuffer());
    cache[id] = JSON.parse(dec.decode(await gunzip(await aesDec(key, blob))));
    return cache[id];
  }
  async function tryAnswer(id, values) {
    const P = IDX.puzzles[id];
    const h = await pbkdf(values.map(norm).join('|'), P.salt);
    if (hexOf(h.slice(0, 32)) !== P.ver) return null;
    const reward = dec.decode(await aesDec(h.slice(32), b64d(P.reward)));
    S.seals[id] = reward; save();
    return reward;
  }

  // ---------- views ----------
  function show(view) { for (const v of ['login', 'hub', 'puzzle']) $(v).classList.toggle('hidden', v !== view); window.scrollTo(0, 0); }

  function renderHub() {
    show('hub');
    curId = null;
    const total = IDX.rooms.reduce((n, r) => n + r.puzzles.length + 1, 0);
    const done = IDX.rooms.reduce((n, r) => n + r.puzzles.filter((p) => S.seals[p] !== undefined).length + (S.seals[r.meta] !== undefined ? 1 : 0), 0);
    $('progress').textContent = `${done} / ${total} pages`;
    const host = $('rooms'); host.innerHTML = '';
    IDX.rooms.forEach((room, ri) => {
      const open = S.seals[room.gate] !== undefined;
      const box = el('section', { class: 'room' + (open ? '' : ' sealed') });
      box.append(el('h3', { text: `${roman(ri + 1)}. ${open ? room.name : 'Sealed'}` }));
      box.append(el('p', { class: 'blurb', text: open ? room.blurb : 'The door of the previous room has not been opened yet.' }));
      const cards = el('div', { class: 'cards' });
      const card = (id, extra = '') => {
        const P = IDX.puzzles[id];
        const solved = S.seals[id] !== undefined;
        const ok = open && isOpen(id);
        const b = el('button', { class: `pcard ${solved ? 'solved' : ''} ${ok ? '' : 'locked'} ${extra}`.trim(), type: 'button' });
        b.append(el('span', { class: 't', text: ok ? P.title : '— sealed —' }));
        const m = [];
        if (P.kind === 'feeder' && ok) { const lw = S.widget[id] || {}; m.push(`locks ${[1, 2, 3, 4, 5].filter((q) => lw['lockok_' + q]).length}/5`); }
        if (P.kind === 'meta') m.push(P.final ? 'The last door' : 'The door');
        if (ok) m.push('★'.repeat(P.stars) + '☆'.repeat(5 - P.stars));
        if (solved) m.push('solved');
        b.append(el('span', { class: 'm', text: ok ? m.join(' · ') : '' }));
        if (ok) b.onclick = () => openPuzzle(id);
        return b;
      };
      room.puzzles.forEach((id) => cards.append(card(id)));
      cards.append(card(room.meta, 'door'));
      box.append(cards);
      host.append(box);
    });
  }

  // ---------- helpers for puzzle scripts ----------
  const H = {
    el, svgEl, norm, b64d, hexOf, enc, dec,
    asset(name) {
      if (assetCache[curId + name]) return assetCache[curId + name];
      const a = curPayload.assets[name] || extraAssets[name];
      const bytes = b64d(a.b64);
      const url = URL.createObjectURL(new Blob([bytes], { type: a.mime }));
      return (assetCache[curId + name] = { url, bytes, mime: a.mime });
    },
    persist(key, dflt) {
      const w = (S.widget[curId] = S.widget[curId] || {});
      return { get: () => (w[key] === undefined ? dflt : w[key]), set: (v) => { w[key] = v; save(); } };
    },
    copy(t) { navigator.clipboard && navigator.clipboard.writeText(t); },
    // Sudoku-family board with overlays. spec: {n, givens:[[r,c,v]], shade:[[r,c]], cages:[{cells,sum}], lines:[{type,cells}], dots:[{a,b,t}], regions:[...], boxR, boxC}
    board(host, spec) {
      const n = spec.n || 9, cs = spec.cell || 46, size = n * cs;
      const store = H.persist('board', Array(n * n).fill(''));
      const vals = store.get();
      const wrap = el('div', { class: 'board', style: `width:${size}px;height:${size}px` });
      const grid = el('div', { class: 'cells', style: `grid-template-columns:repeat(${n},${cs}px);grid-template-rows:repeat(${n},${cs}px)` });
      const given = {}; (spec.givens || []).forEach(([r, c, v]) => { given[r * n + c] = v; });
      const shade = new Set((spec.shade || []).map(([r, c]) => r * n + c));
      const inputs = [];
      for (let i = 0; i < n * n; i++) {
        const inp = el('input', { maxlength: String(n), inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false' });
        if (given[i]) { inp.value = given[i]; inp.readOnly = true; inp.classList.add('given'); } else inp.value = vals[i] || '';
        if (shade.has(i)) inp.classList.add('shade');
        if (inp.value.length > 1) inp.classList.add('pencil');
        inp.oninput = () => {
          const seen = []; for (const ch of inp.value) if (ch >= '1' && ch <= String(n) && !seen.includes(ch)) seen.push(ch);
          inp.value = seen.sort().join(''); inp.classList.toggle('pencil', inp.value.length > 1);
          vals[i] = inp.value; store.set(vals);
        };
        inp.onkeydown = (e) => {
          const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -n, ArrowDown: n }[e.key];
          if (d && inputs[i + d]) { e.preventDefault(); inputs[i + d].focus(); }
        };
        inputs.push(inp); grid.append(inp);
      }
      const svg = svgEl('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` });
      const line = (x1, y1, x2, y2, a) => svg.append(svgEl('line', { x1, y1, x2, y2, ...a }));
      const ctr = ([r, c]) => [(c + 0.5) * cs, (r + 0.5) * cs];
      // regions / boxes
      if (spec.regions) {
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
          const me = spec.regions[r * n + c];
          if (c + 1 < n && spec.regions[r * n + c + 1] !== me) line((c + 1) * cs, r * cs, (c + 1) * cs, (r + 1) * cs, { stroke: '#ffd98a', 'stroke-width': 3 });
          if (r + 1 < n && spec.regions[(r + 1) * n + c] !== me) line(c * cs, (r + 1) * cs, (c + 1) * cs, (r + 1) * cs, { stroke: '#ffd98a', 'stroke-width': 3 });
        }
      } else {
        const bR = spec.boxR || 3, bC = spec.boxC || 3;
        for (let k = 0; k <= n; k += bC) line(k * cs, 0, k * cs, size, { stroke: '#ffd98a', 'stroke-width': 3 });
        for (let k = 0; k <= n; k += bR) line(0, k * cs, size, k * cs, { stroke: '#ffd98a', 'stroke-width': 3 });
      }
      line(0, 0, size, 0, { stroke: '#ffd98a', 'stroke-width': 3 }); line(0, size, size, size, { stroke: '#ffd98a', 'stroke-width': 3 });
      // cages (killer)
      for (const cg of spec.cages || []) {
        const set = new Set(cg.cells.map(([r, c]) => r * n + c)), d = 4;
        for (const [r, c] of cg.cells) {
          const x = c * cs, y = r * cs, a = { stroke: '#c9d6ff', 'stroke-width': 1.3, 'stroke-dasharray': '3 3' };
          if (!set.has((r - 1) * n + c) || r === 0) line(x + d, y + d, x + cs - d, y + d, a);
          if (!set.has((r + 1) * n + c) || r === n - 1) line(x + d, y + cs - d, x + cs - d, y + cs - d, a);
          if (!set.has(r * n + c - 1) || c === 0) line(x + d, y + d, x + d, y + cs - d, a);
          if (!set.has(r * n + c + 1) || c === n - 1) line(x + cs - d, y + d, x + cs - d, y + cs - d, a);
        }
        const [r0, c0] = cg.cells.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1])[0];
        const t = svgEl('text', { x: c0 * cs + 6, y: r0 * cs + 14, fill: '#c9d6ff', 'font-size': 11, 'font-family': 'Consolas,monospace' });
        t.textContent = cg.sum; svg.append(t);
      }
      // lines: thermo, whisper, renban, palindrome, arrow
      const STY = {
        thermo: { stroke: 'rgba(170,170,170,.55)', w: cs * 0.2 }, whisper: { stroke: 'rgba(80,200,120,.7)', w: 6 },
        renban: { stroke: 'rgba(190,120,255,.65)', w: 6 }, palin: { stroke: 'rgba(120,170,255,.65)', w: 6 }, between: { stroke: 'rgba(255,170,90,.7)', w: 5 },
      };
      for (const L of spec.lines || []) {
        const s = STY[L.type];
        const pts = L.cells.map(ctr);
        svg.append(svgEl('polyline', { points: pts.map((p) => p.join(',')).join(' '), fill: 'none', stroke: s.stroke, 'stroke-width': s.w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        if (L.type === 'thermo') svg.append(svgEl('circle', { cx: pts[0][0], cy: pts[0][1], r: cs * 0.3, fill: s.stroke }));
        if (L.type === 'between') { for (const p of [pts[0], pts[pts.length - 1]]) svg.append(svgEl('circle', { cx: p[0], cy: p[1], r: cs * 0.3, fill: 'none', stroke: s.stroke, 'stroke-width': 3 })); }
      }
      // dots (kropki): t = 'w' (white, consecutive) or 'b' (black, ratio 1:2)
      for (const d of spec.dots || []) {
        const [x1, y1] = ctr(d.a), [x2, y2] = ctr(d.b);
        svg.append(svgEl('circle', { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, r: 6.5, fill: d.t === 'b' ? '#000' : '#fff', stroke: d.t === 'b' ? '#fff' : '#555', 'stroke-width': 1.5 }));
      }
      wrap.append(grid, svg); host.append(wrap);
      return { inputs };
    },
    // Letter grid. spec: {rows, cols, cells:[[null|{ch,locked,mark}]]}
    letterGrid(host, spec) {
      const store = H.persist('lgrid', {});
      const vals = store.get();
      const g = el('div', { class: 'lgrid', style: `grid-template-columns:repeat(${spec.cols},34px)` });
      const inputs = {};
      for (let r = 0; r < spec.rows; r++) for (let c = 0; c < spec.cols; c++) {
        const cell = spec.cells[r][c];
        if (!cell) { g.append(el('div', { class: 'void' })); continue; }
        const inp = el('input', { maxlength: '1', autocomplete: 'off', spellcheck: 'false' });
        const k = r + ',' + c;
        if (cell.locked) { inp.value = cell.ch; inp.readOnly = true; inp.classList.add('locked'); } else inp.value = vals[k] || '';
        if (cell.mark) inp.classList.add('mark');
        const paint = () => { const ch = inp.value.toUpperCase(); inp.value = ch; inp.style.background = ch ? `hsl(${(ch.charCodeAt(0) * 47) % 360} 45% 28%)` : '#0006'; };
        paint();
        inp.oninput = () => { paint(); vals[k] = inp.value; store.set(vals); };
        inp.onkeydown = (e) => {
          const d = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
          if (d && inputs[(r + d[0]) + ',' + (c + d[1])]) { e.preventDefault(); inputs[(r + d[0]) + ',' + (c + d[1])].focus(); }
        };
        inputs[k] = inp; g.append(inp);
      }
      host.append(g);
      return { inputs };
    },
  };

  // ---------- vault helpers: key derivation, lock tag, lock tester ----------
  const hexToBytes = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
  H.pbkdf2 = async (str, salt, iter, nbytes) => {
    const base = await crypto.subtle.importKey('raw', enc.encode(str), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, nbytes * 8));
  };
  H.lockTag = async (material, saltHex, iter) => {
    const d = await H.pbkdf2(material, hexToBytes(saltHex), iter, 64);
    const key = await crypto.subtle.importKey('raw', d.slice(0, 32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hexOf(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode('LOCK')))).slice(0, 8);
  };
  H.seal = (id) => S.seals[id];
  H.subOf = (ns) => { const h = Object.create(H); h.ns = ns; h.asset = (n) => H.asset(ns + '_' + n); h.persist = (k, d) => H.persist(ns + '_' + k, d); return h; };
  // The layer viewer: show the lock described inside an opened layer, and hand over the next vault.
  H.layerViewer = (box, pageId) => {
    const out = el('div');
    const file = el('input', { type: 'file', multiple: 'true' });
    const paste = el('textarea', { spellcheck: 'false', placeholder: '…or paste the content of the opened layer here (JSON text, or the base64 of the gzip file)', style: 'min-height:56px;font-size:.8rem' });
    const go = el('button', { type: 'button', class: 'ghostbtn', text: 'Show this layer' });
    box.append(el('p', { class: 'small', text: 'Drop the opened layer here (or choose the file). It is read in your browser; nothing is uploaded.' }), file, paste, el('div', { class: 'row' }, [go]), out);
    const renderLock = (b) => {
      const L = b.lock, sec = el('div', { class: 'layer-next' });
      for (const [k, v] of Object.entries(L.assets || {})) extraAssets[k] = v;
      sec.innerHTML = L.html.replace(/\{\{asset:([\w.-]+)\}\}/g, (_, n) => H.asset(n).url);
      out.append(sec);
      try { H.lockTester(sec.querySelector(L.tester.sel), L.tester.spec); } catch (e) { console.error(e); }
      for (const x of L.scripts || []) { const t = sec.querySelector(x.sel); try { if (x.script) new Function('H', 'host', x.script)(H.subOf(x.ns), t); } catch (e) { t.insertAdjacentHTML('beforeend', '<p class="msg bad">Script error: ' + String(e.message).replace(/</g, '&lt;') + '</p>'); console.error(e); } }
      const nextBytes = b64d(b.next);
      sec.append(el('p', {}, [el('a', { class: 'linkbtn', href: URL.createObjectURL(new Blob([nextBytes], { type: 'application/octet-stream' })), download: `vault-${pageId}-layer${L.i}.bin`, text: `Download the next vault (it is sealed by Lock ${['I', 'II', 'III', 'IV', 'V'][L.i - 1]}) · ${nextBytes.length} bytes` })]));
      sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    const open = async (u8) => {
      try {
        if (u8[0] === 0x1f && u8[1] === 0x8b) u8 = await gunzip(u8);
        const text = dec.decode(u8);
        if (!text.trim().startsWith('{')) { out.append(el('div', { class: 'vault' }, [el('p', { html: '<b>This is the last layer.</b> The line that begins <code>ANSWER:</code> is the answer of the vault.' }), el('pre', { class: 'cipher', text: text.slice(0, 2000) })])); return; }
        const b = JSON.parse(text); if (!b || !b.lock || !b.next) throw new Error('this is not the content of an opened layer');
        renderLock(b);
      } catch (e) { out.append(el('p', { class: 'err', text: 'Could not read this layer: ' + e.message })); }
    };
    file.onchange = async () => { for (const f of file.files) await open(new Uint8Array(await f.arrayBuffer())); file.value = ''; };
    go.onclick = async () => { const t = paste.value.trim(); if (!t) return; if (t.startsWith('{')) await open(enc.encode(t)); else { try { await open(b64d(t.replace(/\s+/g, ''))); } catch (e) { out.append(el('p', { class: 'err', text: 'That is not base64 or JSON.' })); } } };
    box.ondragover = (e) => { e.preventDefault(); };
    box.ondrop = async (e) => { e.preventDefault(); for (const f of e.dataTransfer.files) await open(new Uint8Array(await f.arrayBuffer())); };
    H.__openLayer = open; // for debugging
  };
  H.lockTester = (host, spec) => {
    const store = H.persist('lockin_' + spec.i, spec.mode === 'shamir' ? '' : {}), saved = store.get();
    const done = H.persist('lockok_' + spec.i, false);
    host.append(el('p', { class: 'small', html: `Lock tag <b>${spec.tag}</b> · salt <code>${spec.salt}</code> · PBKDF2-HMAC-SHA256, ${spec.iter} iterations` + (done.get() ? ' · <span class="good">✓ opened in this browser</span>' : '') }));
    const res = el('span', { class: 'small' });
    let getMaterial;
    if (spec.mode === 'parts') {
      const inputs = spec.parts.map((p, k) => {
        const inp = el('input', { autocomplete: 'off', spellcheck: 'false', placeholder: p.t === 'seal' ? 'filled in from your seals' : '' });
        inp.value = saved[k] || (p.t === 'seal' && S.seals[p.id]) || '';
        inp.oninput = () => { saved[k] = inp.value; store.set(saved); };
        host.append(el('label', { class: 'small' }, [p.label, inp])); return inp;
      });
      getMaterial = async () => { const v = inputs.map((x) => norm(x.value)); if (v.some((x) => !x)) throw new Error('Fill in every part.'); return v.join('|'); };
    } else {
      const P = BigInt(spec.p), B = BigInt(spec.alpha.length), mod = (a) => ((a % P) + P) % P;
      const inv = (a) => { let [r0, r1, s0, s1] = [mod(a), P, 1n, 0n]; while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; } return mod(s0); };
      const decode = (tok) => {
        tok = tok.toUpperCase().replace(/[^A-Z]/g, ''); if (tok.length !== spec.tl + 2) return null;
        let y = 0n, c = 0; for (let i = 0; i < spec.tl; i++) { const k = spec.alpha.indexOf(tok[i]); if (k < 0) return null; y = y * B + BigInt(k); c = (c * 31 + k + 1) % (spec.alpha.length * spec.alpha.length); }
        return spec.alpha[Math.floor(c / spec.alpha.length)] === tok[spec.tl] && spec.alpha[c % spec.alpha.length] === tok[spec.tl + 1] ? y : null;
      };
      const ta = el('textarea', { spellcheck: 'false', placeholder: 'One share per line: the share number, then the token; for a masked share add the answer of the seal after it. Examples:\n7 ABCDEFGHIKLMNOPR\n12 ABCDEFGHIKLMNOPR 123456789', style: 'min-height:110px;font-size:.85rem' });
      ta.value = saved || ''; ta.oninput = () => store.set(ta.value); host.append(ta);
      getMaterial = async () => {
        const pts = new Map();
        for (const line of ta.value.split('\n')) {
          const m = line.match(/^\s*(\d+)[\s:,.=\-]+([A-Za-z]{16})(?:[\s:,.=\-]+(.+?))?\s*$/); if (!m) continue;
          let y = decode(m[2]); if (y == null) continue;
          if (m[3]) { // masked share: XOR with the first 55 bits of SHA-256("share-mask|" + answers in normal form joined by |)
            const A = m[3].split('|').map(norm).join('|'), h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('share-mask|' + A)));
            let mk = 0n; for (let i = 0; i < 7; i++) mk = (mk << 8n) | BigInt(h[i]); y = y ^ (mk & ((1n << 55n) - 1n));
          }
          pts.set(Number(m[1]), y);
        }
        const list = [...pts].map(([x, y]) => ({ x, y }));
        if (list.length < spec.k) throw new Error(`${list.length} valid share(s) so far; ${spec.k} needed.`);
        const use = list.slice(0, spec.k); let sec = 0n;
        use.forEach((pi, i) => { let num = 1n, den = 1n; use.forEach((pj, j) => { if (i !== j) { num = mod(num * mod(-BigInt(pj.x))); den = mod(den * mod(BigInt(pi.x) - BigInt(pj.x))); } }); sec = mod(sec + pi.y * num * inv(den)); });
        return sec.toString();
      };
    }
    const btn = el('button', { type: 'button', class: 'ghostbtn', text: 'Test this key' });
    btn.onclick = async () => {
      res.className = 'small'; res.textContent = ' …deriving (this takes a moment)'; btn.disabled = true;
      try {
        const mat = await getMaterial(); const t = await H.lockTag(mat, spec.salt, spec.iter);
        if (t === spec.tag) { res.className = 'good'; res.textContent = ' ✓ This is the key of the lock.'; done.set(true); } else { res.className = 'err'; res.textContent = ' ✗ Not the key (tag ' + t + ').'; }
      } catch (e) { res.className = 'err'; res.textContent = ' ' + e.message; }
      btn.disabled = false;
    };
    host.append(el('div', { class: 'row' }, [btn, res]));
  };

  // ---------- puzzle view ----------
  const MSG = (t, cls) => { const m = $('pMsg'); m.textContent = t; m.className = 'msg ' + (cls || ''); };
  async function openPuzzle(id) {
    const P = IDX.puzzles[id];
    show('puzzle');
    $('pTitle').textContent = '…'; $('pStory').textContent = 'Opening…'; $('pBody').innerHTML = ''; $('pInputs').innerHTML = ''; $('pHints').innerHTML = ''; MSG('');
    let payload;
    try { payload = await getPayload(id); } catch (e) { $('pStory').textContent = 'Could not open this page: ' + e.message; return; }
    if (!payload) { $('pStory').textContent = 'This page is still sealed.'; return; }
    curId = id; curPayload = payload;
    $('pTitle').textContent = P.title;
    $('pMeta').textContent = [P.kind === 'feeder' ? 'A vault' : (P.final ? 'The last door' : 'The door'), '★'.repeat(P.stars) + '☆'.repeat(5 - P.stars)].join(' · ');
    $('pStory').textContent = payload.story;
    const html = payload.body.replace(/\{\{asset:([\w.-]+)\}\}/g, (_, n) => H.asset(n).url);
    $('pBody').innerHTML = html;
    $('pInputs').append(...payload.inputs.map((inp, i) => el('label', {}, [inp.label, el('input', { 'data-i': i, autocomplete: 'off', spellcheck: 'false', placeholder: inp.placeholder || '' })])));
    $('pInputs').querySelectorAll('input').forEach((x) => { x.onkeydown = (e) => { if (e.key === 'Enter') check(); }; });
    const showHints = () => {
      const n = S.hints[id] || 0;
      $('pHints').innerHTML = '';
      payload.hints.slice(0, n).forEach((h, i) => $('pHints').append(el('div', { class: 'hint', text: `Hint ${i + 1}: ${h}` })));
      $('hintBtn').textContent = payload.hints.length ? `Hint (${n}/${payload.hints.length})` : 'No hints';
      $('hintBtn').disabled = n >= payload.hints.length;
    };
    $('hintBtn').onclick = () => { S.hints[id] = (S.hints[id] || 0) + 1; save(); showHints(); };
    showHints();
    $('pNotes').value = S.notes[id] || '';
    $('pNotes').oninput = () => { S.notes[id] = $('pNotes').value; save(); };
    if (S.seals[id] !== undefined) MSG(P.final ? S.seals[id] : `Solved. Seal: ${S.seals[id]}`, 'ok');
    if (payload.script) {
      try { new Function('H', 'host', 'P', payload.script)(H, $('pBody'), payload); } catch (e) { MSG('Script error: ' + e.message, 'bad'); console.error(e); }
    }
  }
  async function check() {
    const id = curId; if (!id) return;
    const vals = [...$('pInputs').querySelectorAll('input')].map((x) => x.value);
    if (vals.some((v) => !norm(v))) { MSG('Fill in every box.', 'bad'); return; }
    $('checkBtn').disabled = true; MSG('Checking…');
    const r = await tryAnswer(id, vals);
    $('checkBtn').disabled = false;
    if (r === null) { MSG('Not right.', 'bad'); $('checkBtn').classList.add('shake'); setTimeout(() => $('checkBtn').classList.remove('shake'), 450); return; }
    MSG(IDX.puzzles[id].final ? r : `Correct. Seal: ${r}`, 'ok');
  }
  $('checkBtn').onclick = check;
  $('backBtn').onclick = () => renderHub();

  // ---------- modal / export ----------
  function modal(text, value, onOk) {
    $('modalText').textContent = text; $('modalArea').value = value; $('modal').classList.remove('hidden');
    $('modalOk').onclick = () => { $('modal').classList.add('hidden'); onOk && onOk($('modalArea').value); };
    $('modalCancel').onclick = () => $('modal').classList.add('hidden');
  }
  $('exportBtn').onclick = () => modal('Copy this code somewhere safe. It contains your seals and notes.', btoa(unescape(encodeURIComponent(JSON.stringify(S)))));
  $('importBtn').onclick = () => modal('Paste a saved progress code here.', '', (v) => {
    try { const o = JSON.parse(decodeURIComponent(escape(atob(v.trim())))); for (const k of ['seals', 'notes', 'hints']) S[k] = Object.assign(S[k] || {}, o[k] || {}); for (const [pid, w] of Object.entries(o.widget || {})) S.widget[pid] = Object.assign(S.widget[pid] || {}, w); save(); renderHub(); } catch (e) { alert('That code does not look right.'); }
  });

  // ---------- login ----------
  async function doLogin() {
    const v = $('loginInput').value;
    if (!norm(v)) return;
    $('loginBtn').disabled = true;
    const r = await tryAnswer('login', [v]);
    $('loginBtn').disabled = false;
    if (r === null) { $('loginErr').textContent = 'No.'; $('loginBtn').classList.add('shake'); setTimeout(() => $('loginBtn').classList.remove('shake'), 450); return; }
    renderHub();
  }
  $('loginBtn').onclick = doLogin;
  $('loginInput').onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };

  (async () => {
    show('login');
    if (!window.crypto || !crypto.subtle) { $('loginBoot').textContent = 'This page needs a secure context (https).'; return; }
    try {
      IDX = await (await fetch('data/index.json?' + Date.now())).json();
    } catch (e) { $('loginBoot').textContent = 'Could not load the archive index.'; return; }
    $('loginRiddle').textContent = IDX.login.riddle; $('loginBoot').textContent = '';
    if (S.seals.login !== undefined) renderHub();
    window.__H = H; // convenience for debugging; puzzle scripts receive H explicitly
  })();
})();
