/* 전북 면접사례 검색 — 정적 웹앱 (GitHub Pages)
 * 데이터(data/cases.bin)와 PDF(data/pdf/*.bin)는 AES-256-GCM 으로 암호화되어 있고
 * 비밀번호로 만든 키로 브라우저 안에서만 복호화한다. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const PAGE = 60;
  const LS = { key: 'jbe.key', fav: 'jbe.fav', hideA: 'jbe.hideA' };
  const store = {
    get(k, s = localStorage) { try { return s.getItem(k); } catch { return null; } },
    set(k, v, s = localStorage) { try { s.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {} },
  };

  /* ---------- 암호 ---------- */
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const toB64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  let KEY = null, META = null;

  async function deriveKey(pw, meta) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(meta.salt), iterations: meta.iter },
      base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
  }
  async function decrypt(buf, key = KEY) {
    const u = new Uint8Array(buf);
    if (u[0] !== 0x4A || u[1] !== 0x42 || u[2] !== 0x45 || u[3] !== 0x31) throw new Error('bad-format');
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(4, 16) }, key, u.slice(16));
  }
  async function checkKey(key) {
    try { await decrypt(b64(META.check).buffer, key); return true; } catch { return false; }
  }
  async function gunzip(buf) {
    if (!('DecompressionStream' in window)) throw new Error('이 브라우저는 지원되지 않습니다. 최신 크롬·엣지·사파리를 사용해 주세요.');
    const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(s).text();
  }
  async function fetchBin(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`파일을 불러오지 못했습니다 (${r.status})`);
    return r.arrayBuffer();
  }

  /* ---------- 상태 ---------- */
  const S = {
    cases: [], byId: new Map(), qIndex: [], stats: {},
    q: '', tokens: [], group: '', year: '', univ: '', form: '', hasQ: false, favOnly: false,
    mode: 'case', results: [], shown: PAGE, sel: null, tab: 'info',
    fav: new Set(JSON.parse(store.get(LS.fav) || '[]')),
    hideA: store.get(LS.hideA) === '1',
  };

  /* ---------- 유틸 ---------- */
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s ?? '').toLowerCase();
  const nospace = s => s.replace(/\s+/g, '');
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function hl(text) {
    const t = esc(text);
    if (!S.tokens.length) return t;
    const re = new RegExp('(' + S.tokens.map(reEsc).join('|') + ')', 'gi');
    return t.replace(re, '<mark>$1</mark>');
  }
  function has(hay, tok) { return hay.includes(tok); }
  function hasMeta(c, tok) { return c.metaHay.includes(tok) || c.metaNs.includes(tok); }
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 1800);
  }
  const pagesText = c => c.srcPages ? (c.srcPages[0] === c.srcPages[1] ? `${c.srcPages[0]}쪽` : `${c.srcPages[0]}~${c.srcPages[1]}쪽`) : '';
  const bookText = c => c.bookPages ? (c.bookPages[0] === c.bookPages[1] ? `책자 ${c.bookPages[0]}쪽` : `책자 ${c.bookPages[0]}~${c.bookPages[1]}쪽`) : '';
  const qCount = c => (c.qs || []).reduce((n, q) => n + 1 + (q.followups || []).length, 0);

  /* ---------- 데이터 준비 ---------- */
  function prepare(payload) {
    S.cases = payload.cases;
    S.stats = payload.stats || {};
    S.cases.forEach((c, i) => {
      c.i = i;
      const alias = u => [u.replace('교육대', '교대'), u.replace('외국어대', '외대'), u.replace('과학기술대', '과기대'), u.replace('여자대', '여대'), u.replace(/^국립/, ''), u.replace(/대$/, '대학교'), u.replace(/대(\(.+\))$/, '대학교$1')].join(' ');
      c.metaHay = norm([c.univ, alias(c.univ), c.dept, c.adm, c.group, c.year, c.gkey].join(' '));
      c.metaNs = nospace(c.metaHay);
      const sq = /_(\d+)\.pdf$/.exec(c.fn); c.seq = sq ? +sq[1] : 0;
      const parts = [];
      (c.qs || []).forEach(q => {
        parts.push(q.q, q.a);
        S.qIndex.push({ c, no: String(q.no), q: q.q, a: q.a, fu: false, hay: norm(q.q + ' ' + q.a) });
        (q.followups || []).forEach((f, j) => {
          parts.push(f.q, f.a);
          S.qIndex.push({ c, no: `${q.no}-${j + 1}`, q: f.q, a: f.a, fu: true, hay: norm(f.q + ' ' + f.a) });
        });
      });
      c.qHay = norm(parts.join(' '));
      const iv = c.iv || {};
      c.etcHay = norm([c.intro, c.passage, c.etc, iv.method, iv.time, iv.ratio, (iv.form || []).join(' '), (iv.mode || []).join(' ')].join(' '));
      S.byId.set(c.id, c);
    });
    $('#built').textContent = payload.built ? ` · 데이터 ${payload.built}` : '';
    const univs = new Set(S.cases.map(c => c.univ)).size;
    $('#stats').textContent = `사례 ${S.cases.length.toLocaleString()}건 · 대학 ${univs}곳 · 질문 ${(S.stats.questions || S.qIndex.length).toLocaleString()}개`;
    buildFilters();
  }

  function countBy(fn) { const m = new Map(); S.cases.forEach(c => { const k = fn(c); if (k != null) m.set(k, (m.get(k) || 0) + 1); }); return m; }
  function buildFilters() {
    const groups = countBy(c => c.group);
    const chips = $('#groupChips');
    chips.innerHTML = `<button class="chip on" data-g="">전체<b>${S.cases.length}</b></button>` +
      [...groups].map(([g, n]) => `<button class="chip" data-g="${esc(g)}">${esc(g.replace(/계열$/, ''))}<b>${n}</b></button>`).join('');
    chips.onclick = e => { const b = e.target.closest('.chip'); if (!b) return; S.group = b.dataset.g; syncChips(); refillUniv(); run(); };
    const years = [...countBy(c => c.year)].sort((a, b) => b[0] - a[0]);
    $('#fYear').innerHTML = `<option value="">전체 연도</option>` + years.map(([y, n]) => `<option value="${y}">${y}학년도 (${n})</option>`).join('');
    const forms = countBy(c => null); S.cases.forEach(c => (c.iv?.form || []).forEach(f => forms.set(f, (forms.get(f) || 0) + 1)));
    $('#fForm').innerHTML = `<option value="">면접 형식 전체</option>` + [...forms].sort((a, b) => b[1] - a[1]).map(([f, n]) => `<option value="${esc(f)}">${esc(f)} (${n})</option>`).join('');
    refillUniv();
  }
  function refillUniv() {
    const base = S.cases.filter(c => (!S.group || c.group === S.group) && (!S.year || String(c.year) === S.year));
    const m = new Map(); base.forEach(c => m.set(c.univ, (m.get(c.univ) || 0) + 1));
    const list = [...m].sort((a, b) => a[0].localeCompare(b[0], 'ko'));
    if (S.univ && !m.has(S.univ)) S.univ = '';
    $('#fUniv').innerHTML = `<option value="">대학 전체 (${list.length}곳)</option>` + list.map(([u, n]) => `<option value="${esc(u)}"${u === S.univ ? ' selected' : ''}>${esc(u)} (${n})</option>`).join('');
  }
  function syncChips() { document.querySelectorAll('#groupChips .chip').forEach(b => b.classList.toggle('on', b.dataset.g === S.group)); }

  /* ---------- 검색 ---------- */
  function passFilters(c) {
    if (S.group && c.group !== S.group) return false;
    if (S.year && String(c.year) !== S.year) return false;
    if (S.univ && c.univ !== S.univ) return false;
    if (S.form && !(c.iv?.form || []).includes(S.form)) return false;
    if (S.hasQ && !(c.qs && c.qs.length)) return false;
    if (S.favOnly && !S.fav.has(c.id)) return false;
    return true;
  }
  function run(keepSel) {
    S.tokens = norm(S.q).split(/\s+/).filter(Boolean);
    const T = S.tokens;
    if (S.mode === 'case') {
      const out = [];
      for (const c of S.cases) {
        if (!passFilters(c)) continue;
        let score = 0, ok = true;
        for (const t of T) {
          const m = hasMeta(c, t), q = has(c.qHay, t), e = has(c.etcHay, t);
          if (!m && !q && !e) { ok = false; break; }
          score += (m ? 10 : 0) + (q ? 3 : 0) + (e ? 1 : 0);
        }
        if (ok) out.push({ c, score: score + (c.qs ? 0.5 : 0) });
      }
      out.sort((a, b) => b.score - a.score || a.c.i - b.c.i);
      S.results = out;
    } else {
      const out = [];
      for (const it of S.qIndex) {
        if (!passFilters(it.c)) continue;
        if (T.every(t => has(it.hay, t) || hasMeta(it.c, t))) out.push(it);
      }
      S.results = out;
    }
    S.shown = PAGE;
    renderList();
    if (!keepSel) writeHash();
  }

  /* ---------- 목록 ---------- */
  function snippet(c) {
    if (!c.qs || !c.qs.length) return '';
    let pick = null;
    if (S.tokens.length) {
      outer: for (const q of c.qs) {
        for (const x of [q, ...(q.followups || [])]) {
          const h = norm(x.q + ' ' + x.a);
          if (S.tokens.some(t => has(h, t))) { pick = x; break outer; }
        }
      }
    }
    pick = pick || c.qs[0];
    return `<div class="c-snip"><span class="qmark">Q</span>${hl(pick.q)}</div>`;
  }
  function caseCard(c) {
    const forms = (c.iv?.form || []).map(f => `<span class="tag form">${esc(f)}</span>`).join('');
    const qn = qCount(c);
    return `<button class="card${S.sel === c.id ? ' sel' : ''}" data-id="${c.id}">
      <div class="c-top"><span class="c-univ">${hl(c.univ)}</span><span class="c-dept">${hl(c.dept)}</span>${S.fav.has(c.id) ? '<span class="c-fav">★</span>' : ''}</div>
      <div class="c-meta"><span class="tag">${hl(c.adm)}</span>${c.seq ? `<span class="tag">사례 ${c.seq}</span>` : ''}<span class="tag">${esc(c.group.replace(/계열$/, ''))}</span>${forms}
        ${qn ? `<span>질문 ${qn}개</span>` : '<span class="tag none">문항 정리 전 · PDF 보기</span>'}<span>${c.year} · ${c.npages || '?'}쪽</span></div>
      ${snippet(c)}
    </button>`;
  }
  function qCard(it) {
    return `<button class="card q-card" data-id="${it.c.id}" data-no="${esc(it.no)}">
      <div class="c-q">${it.fu ? '<span class="fu">꼬리</span>' : ''}${hl(it.q)}</div>
      <div class="c-src">${esc(it.c.univ)} · ${esc(it.c.dept)} · ${esc(it.c.adm)}</div>
    </button>`;
  }
  function renderList() {
    const L = $('#list');
    const n = S.results.length;
    $('#count').textContent = S.mode === 'case' ? `사례 ${n.toLocaleString()}건` : `질문 ${n.toLocaleString()}개`;
    if (!n) {
      const hint = S.mode === 'q' && !S.qIndex.length ? '아직 문항이 정리된 사례가 없습니다.' :
        S.mode === 'q' ? '질문 보기는 문항이 정리된 사례에서만 찾습니다. "사례" 탭에서 대학·학과로 찾아보세요.' : '검색어를 줄이거나 필터를 풀어 보세요.';
      L.innerHTML = `<div class="nores"><p><strong>결과가 없습니다</strong></p><p class="muted">${hint}</p></div>`;
      return;
    }
    const slice = S.results.slice(0, S.shown);
    L.innerHTML = (S.mode === 'case' ? slice.map(r => caseCard(r.c)) : slice.map(qCard)).join('') +
      (n > S.shown ? `<button class="ghost more" id="moreBtn">더 보기 (${(n - S.shown).toLocaleString()}개 남음)</button>` : '');
  }
  $('#list').addEventListener('click', e => {
    if (e.target.id === 'moreBtn') { S.shown += PAGE; renderList(); return; }
    const b = e.target.closest('.card'); if (!b) return;
    open(b.dataset.id, b.dataset.no);
  });

  /* ---------- 상세 ---------- */
  function resultIds() { return S.mode === 'case' ? S.results.map(r => r.c.id) : [...new Set(S.results.map(r => r.c.id))]; }
  function open(id, no, fromHash) {
    const c = S.byId.get(id); if (!c) return;
    const changed = S.sel !== id;
    S.sel = id;
    document.querySelectorAll('#list .card').forEach(b => b.classList.toggle('sel', b.dataset.id === id));
    $('#emptyDetail').hidden = true; $('#detailBody').hidden = false;
    $('#dSub').textContent = `${c.year}학년도 · ${c.group} · ${c.adm}`;
    $('#dTitle').textContent = `${c.univ} ${c.dept}` + (c.seq ? ` (사례 ${c.seq})` : '');
    $('#favBtn').textContent = S.fav.has(id) ? '★' : '☆';
    $('#favBtn').style.color = S.fav.has(id) ? 'var(--star)' : '';
    renderInfo(c);
    const hasQ = c.qs && c.qs.length;
    setTab(no || hasQ ? 'info' : 'pdf', changed);
    if (no) setTimeout(() => {
      const el = document.querySelector(`#infoView [data-no="${CSS.escape(no)}"]`);
      if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1700); }
    }, 30);
    else {
      $('#infoView').scrollTop = 0;
      if (S.tokens.length && hasQ) setTimeout(() => {
        const hit = [...document.querySelectorAll('#infoView .qs [data-no]')].find(el => el.querySelector(':scope > .q-line mark, :scope > .q-text mark, :scope > .a-text mark'));
        if (hit) hit.scrollIntoView({ block: 'start' });
      }, 30);
    }
    const app = $('#app');
    if (matchMedia('(max-width:900px)').matches && !app.classList.contains('detail-open')) {
      app.classList.add('detail-open');
      if (!fromHash) history.pushState({ d: 1 }, '');
    }
    writeHash();
  }
  function closeDetail() { $('#app').classList.remove('detail-open'); }

  function renderInfo(c) {
    const iv = c.iv || {};
    const rows = [
      ['대학', c.univ], ['학과', c.dept], ['전형', c.adm],
      ['면접 형식', (iv.form || []).join(', ')], ['대면 방식', (iv.mode || []).join(', ')],
      ['면접 비율', iv.ratio], ['시간', iv.time], ['세부 방법', iv.method],
      ['원본', [c.fn, pagesText(c), bookText(c)].filter(Boolean).join(' · ')],
    ].filter(r => r[1]);
    let h = `<dl class="info-grid">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${hl(v)}</dd>`).join('')}</dl>`;
    if (c.qs && c.qs.length) {
      if (c.intro) h += `<div class="sec"><h3>면접 전 참고</h3><div class="note">${hl(c.intro)}</div></div>`;
      if (c.passage) h += `<div class="sec"><h3>제시문</h3><div class="note passage">${hl(c.passage)}</div></div>`;
      h += `<div class="sec"><h3>질문과 답변 <span class="muted">${qCount(c)}개</span>
              <button class="ghost small" id="toggleA" style="margin-left:auto">${S.hideA ? '답변 보기' : '질문만 보기'}</button></h3>
            <ol class="qs${S.hideA ? ' hide-a' : ''}">` +
        c.qs.map(q => `<li class="q" data-no="${esc(String(q.no))}">
            <div class="q-line"><span class="q-no">${esc(q.no)}</span><div class="q-text">${hl(q.q)}</div></div>
            ${q.a ? `<div class="a-text">${hl(q.a)}</div>` : ''}
            ${(q.followups || []).length ? `<ul class="fus">${q.followups.map((f, j) => `<li data-no="${q.no}-${j + 1}">
                <div class="q-text">${hl(f.q)}</div>${f.a ? `<div class="a-text">${hl(f.a)}</div>` : ''}</li>`).join('')}</ul>` : ''}
          </li>`).join('') + `</ol></div>`;
      if (c.etc) h += `<div class="sec"><h3>기타 면접정보</h3><div class="note">${hl(c.etc)}</div></div>`;
    } else {
      h += `<div class="sec nodata"><p><strong>이 사례는 아직 문항이 정리되지 않았습니다.</strong></p>
             <p class="muted small">질문·답변은 원본 PDF에서 확인하세요. 정리가 끝나면 여기와 검색에 반영됩니다.</p>
             <button class="ghost" id="goPdf">원본 PDF 보기</button></div>`;
    }
    $('#infoView').innerHTML = h;
  }
  $('#infoView').addEventListener('click', e => {
    if (e.target.id === 'goPdf') setTab('pdf');
    if (e.target.id === 'toggleA') {
      S.hideA = !S.hideA; store.set(LS.hideA, S.hideA ? '1' : '0');
      $('#infoView .qs').classList.toggle('hide-a', S.hideA);
      e.target.textContent = S.hideA ? '답변 보기' : '질문만 보기';
    }
  });

  function setTab(t, reload) {
    S.tab = t;
    $('#tabInfo').classList.toggle('on', t === 'info');
    $('#tabPdf').classList.toggle('on', t === 'pdf');
    $('#infoView').hidden = t !== 'info';
    $('#pdfView').hidden = t !== 'pdf';
    if (t === 'pdf') showPdf(S.byId.get(S.sel), reload);
  }
  $('#tabInfo').onclick = () => setTab('info');
  $('#tabPdf').onclick = () => setTab('pdf');

  /* ---------- PDF ---------- */
  const pdfCache = new Map(); // id -> Uint8Array (최근 10개)
  const P = { id: null, doc: null, zoom: 1, fit: 1, bytes: null, url: null, token: 0 };
  async function getPdfjs() {
    for (let i = 0; i < 50 && !window.pdfjsLib; i++) await new Promise(r => setTimeout(r, 100));
    const lib = window.pdfjsLib;
    if (lib && !lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    return lib;
  }

  async function getPdfBytes(c) {
    if (pdfCache.has(c.id)) return pdfCache.get(c.id);
    const bytes = new Uint8Array(await decrypt(await fetchBin(c.pdf)));
    pdfCache.set(c.id, bytes);
    if (pdfCache.size > 10) pdfCache.delete(pdfCache.keys().next().value);
    return bytes;
  }
  async function showPdf(c, reload) {
    if (!c) return;
    if (P.id === c.id && P.doc && !reload) return;
    const box = $('#pdfPages');
    const my = ++P.token;
    P.id = c.id; P.doc = null; P.zoom = 1;
    if (P.url) { URL.revokeObjectURL(P.url); P.url = null; }
    $('#pdfInfo').textContent = [pagesText(c) && `원본 ${pagesText(c)}`, bookText(c)].filter(Boolean).join(' · ');
    if (!c.pdf) { box.innerHTML = '<div class="pdf-msg">이 사례의 PDF가 아직 올라가지 않았습니다.</div>'; return; }
    box.innerHTML = '<div class="spin"></div>';
    try {
      const bytes = await getPdfBytes(c);
      if (my !== P.token) return;
      P.bytes = bytes;
      const lib = await getPdfjs();
      if (my !== P.token) return;
      if (!lib) { box.innerHTML = '<div class="pdf-msg">PDF 뷰어를 불러오지 못했습니다. 인터넷 연결을 확인하거나 "새 탭"·"내려받기"를 이용하세요.</div>'; return; }
      P.doc = await lib.getDocument({ data: bytes.slice() }).promise;
      if (my !== P.token) return;
      const first = await P.doc.getPage(1);
      const vw = first.getViewport({ scale: 1 }).width;
      P.fit = Math.max(0.4, (box.clientWidth - 32) / vw);
      await renderPages(my);
    } catch (err) {
      console.error(err);
      if (my === P.token) box.innerHTML = `<div class="pdf-msg">PDF를 열지 못했습니다.<br><span class="small">${esc(err.message)}</span></div>`;
    }
  }
  async function renderPages(my) {
    const box = $('#pdfPages');
    const scale = P.fit * P.zoom;
    $('#zoomVal').textContent = Math.round(P.zoom * 100) + '%';
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const frag = document.createDocumentFragment();
    const canvases = [];
    for (let n = 1; n <= P.doc.numPages; n++) {
      const cv = document.createElement('canvas'); frag.appendChild(cv); canvases.push(cv);
    }
    box.innerHTML = ''; box.appendChild(frag);
    for (let n = 1; n <= P.doc.numPages; n++) {
      if (my !== P.token) return;
      const page = await P.doc.getPage(n);
      const vp = page.getViewport({ scale });
      const cv = canvases[n - 1];
      cv.width = Math.floor(vp.width * dpr); cv.height = Math.floor(vp.height * dpr);
      cv.style.width = Math.floor(vp.width) + 'px'; cv.style.height = Math.floor(vp.height) + 'px';
      await page.render({ canvasContext: cv.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
    }
  }
  function zoom(f) { if (!P.doc) return; P.zoom = f === 'fit' ? 1 : Math.min(3, Math.max(0.5, +(P.zoom * f).toFixed(2))); renderPages(P.token); }
  $('#zoomIn').onclick = () => zoom(1.2);
  $('#zoomOut').onclick = () => zoom(1 / 1.2);
  $('#zoomFit').onclick = () => zoom('fit');
  function pdfUrl() { if (!P.bytes) return null; if (!P.url) P.url = URL.createObjectURL(new Blob([P.bytes], { type: 'application/pdf' })); return P.url; }
  $('#pdfOpen').onclick = () => { const u = pdfUrl(); if (u) window.open(u, '_blank'); else toast('PDF를 불러오는 중입니다'); };
  $('#pdfDown').onclick = () => {
    const u = pdfUrl(); if (!u) return toast('PDF를 불러오는 중입니다');
    const a = document.createElement('a'); a.href = u; a.download = S.byId.get(S.sel)?.fn || 'case.pdf'; a.click();
  };
  let rz; window.addEventListener('resize', () => {
    clearTimeout(rz); rz = setTimeout(() => {
      if (S.tab === 'pdf' && P.doc) P.doc.getPage(1).then(p => { P.fit = Math.max(0.4, ($('#pdfPages').clientWidth - 32) / p.getViewport({ scale: 1 }).width); renderPages(P.token); });
    }, 250);
  });

  /* ---------- 이동·즐겨찾기·링크 ---------- */
  function step(d) {
    const ids = resultIds(); if (!ids.length) return;
    let i = ids.indexOf(S.sel); i = i < 0 ? 0 : (i + d + ids.length) % ids.length;
    if (i >= S.shown && S.mode === 'case') { S.shown = i + PAGE; renderList(); }
    open(ids[i]);
    document.querySelector(`#list .card[data-id="${ids[i]}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  $('#prevBtn').onclick = () => step(-1);
  $('#nextBtn').onclick = () => step(1);
  $('#backBtn').onclick = () => { if (history.state?.d) history.back(); else closeDetail(); };
  window.addEventListener('popstate', () => closeDetail());
  $('#favBtn').onclick = () => {
    const id = S.sel; if (!id) return;
    S.fav.has(id) ? S.fav.delete(id) : S.fav.add(id);
    store.set(LS.fav, JSON.stringify([...S.fav]));
    $('#favBtn').textContent = S.fav.has(id) ? '★' : '☆';
    $('#favBtn').style.color = S.fav.has(id) ? 'var(--star)' : '';
    toast(S.fav.has(id) ? '즐겨찾기에 추가했습니다' : '즐겨찾기에서 뺐습니다');
    if (S.favOnly) run(true); else renderList();
  };
  $('#linkBtn').onclick = async () => {
    writeHash();
    try { await navigator.clipboard.writeText(location.href); toast('링크를 복사했습니다 (비밀번호는 따로 알려주세요)'); }
    catch { prompt('링크를 복사하세요', location.href); }
  };

  /* ---------- 주소(해시) ---------- */
  function writeHash() {
    const p = new URLSearchParams();
    if (S.q) p.set('q', S.q);
    if (S.group) p.set('g', S.group);
    if (S.univ) p.set('u', S.univ);
    if (S.mode === 'q') p.set('m', 'q');
    if (S.sel) p.set('id', S.sel);
    const h = p.toString();
    history.replaceState(history.state, '', h ? '#' + h : location.pathname + location.search);
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    S.q = p.get('q') || ''; S.group = p.get('g') || ''; S.univ = p.get('u') || ''; S.mode = p.get('m') === 'q' ? 'q' : 'case';
    $('#q').value = S.q; syncChips(); refillUniv(); setMode(S.mode, true);
    run(true);
    const id = p.get('id'); if (id && S.byId.has(id)) open(id, null, true);
  }

  /* ---------- 입력 이벤트 ---------- */
  let qt; $('#q').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { S.q = e.target.value.trim(); run(); }, 120); });
  $('#fYear').onchange = e => { S.year = e.target.value; refillUniv(); run(); };
  $('#fUniv').onchange = e => { S.univ = e.target.value; run(); };
  $('#fForm').onchange = e => { S.form = e.target.value; run(); };
  $('#fHasQ').onchange = e => { S.hasQ = e.target.checked; run(); };
  $('#fFav').onchange = e => { S.favOnly = e.target.checked; run(); };
  $('#resetBtn').onclick = () => {
    Object.assign(S, { q: '', group: '', year: '', univ: '', form: '', hasQ: false, favOnly: false });
    $('#q').value = ''; $('#fYear').value = ''; $('#fForm').value = ''; $('#fHasQ').checked = false; $('#fFav').checked = false;
    syncChips(); refillUniv(); run();
  };
  function setMode(m, silent) {
    S.mode = m;
    $('#modeCase').classList.toggle('on', m === 'case'); $('#modeQ').classList.toggle('on', m === 'q');
    if (!silent) run();
  }
  $('#modeCase').onclick = () => setMode('case');
  $('#modeQ').onclick = () => setMode('q');
  document.addEventListener('keydown', e => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); $('#q').focus(); $('#q').select(); }
    else if (e.key === 'Escape') { if (typing) document.activeElement.blur(); else if ($('#app').classList.contains('detail-open')) $('#backBtn').click(); }
    else if (!typing && S.sel && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); step(e.key === 'ArrowLeft' ? -1 : 1); }
  });

  /* ---------- 잠금 해제 ---------- */
  async function loadAll() {
    const payload = JSON.parse(await gunzip(await decrypt(await fetchBin('data/cases.bin'))));
    prepare(payload);
    $('#lock').hidden = true; $('#app').hidden = false;
    readHash();
  }
  async function boot() {
    try { META = await (await fetch('data/meta.json', { cache: 'no-cache' })).json(); }
    catch { $('#lockMsg').textContent = '데이터(meta.json)를 찾지 못했습니다. 빌드가 되었는지 확인하세요.'; return; }
    const saved = store.get(LS.key) || store.get(LS.key, sessionStorage);
    if (saved) {
      try {
        const k = await crypto.subtle.importKey('raw', b64(saved), { name: 'AES-GCM' }, true, ['decrypt']);
        if (await checkKey(k)) { KEY = k; await loadAll(); return; }
      } catch {}
      store.del(LS.key);
    }
    $('#pw').focus();
  }
  $('#lockForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!META) return;
    const btn = $('#unlockBtn'); btn.disabled = true; btn.textContent = '확인 중…'; $('#lockMsg').textContent = '';
    try {
      const k = await deriveKey($('#pw').value, META);
      if (!(await checkKey(k))) throw new Error('비밀번호가 맞지 않습니다.');
      KEY = k;
      const raw = toB64(await crypto.subtle.exportKey('raw', k));
      store.set(LS.key, raw, sessionStorage);
      btn.textContent = '데이터 여는 중…';
      await loadAll();
    } catch (err) {
      $('#lockMsg').textContent = err.message || '열지 못했습니다.';
      $('#pw').select();
    } finally { btn.disabled = false; btn.textContent = '자료실 열기'; }
  });
  $('#lockBtn').onclick = () => { store.del(LS.key); location.hash = ''; location.reload(); };

  $('#pwToggle').onclick = () => {
    const i = $('#pw'), show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    $('#pwToggle').textContent = show ? '숨김' : '표시';
    i.focus();
  };

  boot();
})();
