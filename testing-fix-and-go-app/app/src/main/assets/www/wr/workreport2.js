/* Fix & Go work report PDF maker - V2 layout (A4).
   Separate from V1 (workreport.js), which is not touched.
   - page 1: logo, client/property/date row, report title, then the sections of the typed text
     (Work Carried Out as a tick list, Outcome in a padded box). Text size is chosen so page 1 fills down to the terms bar.
   - photo pages: 3 across, optional section headings, BEFORE / AFTER tags and captions when labels exist.
   Photos come in as [{ url, section?, tag?, caption? }]. With no labels they are simply placed in the given order.
   Only the text typed into the report box is used. No numbers or prices are ever added. */
(function(){
  const BASE = window.WR_BASE || ((document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/[^\/]*$/, '') : 'wr/');
  const W = 595.28, H = 841.89, M = 36;
  const C = { navy: [38, 50, 74], purple: [91, 39, 121], cyan: [10, 159, 198], grey: [95, 102, 115], text: [51, 58, 71], light: [242, 243, 246], line: [220, 223, 230], tint: [244, 239, 250], white: [255, 255, 255] };
  const LOGO_AR = 401 / 900, TERMS_AR = 228 / 1600;
  const CLIENT = ['Accommodation.co.uk', '111 Piccadilly, Manchester,', 'England, M1 2HY'];

  let assetsP = null;
  function loadAssets(){
    if(assetsP) return assetsP;
    const b64 = buf => { let s = '', a = new Uint8Array(buf); for(let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
    const url = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
    assetsP = Promise.all([
      fetch(BASE + 'Montserrat-400.ttf').then(r => r.arrayBuffer()).then(b64),
      fetch(BASE + 'Montserrat-700.ttf').then(r => r.arrayBuffer()).then(b64),
      fetch(BASE + 'v2-logo.jpg').then(r => r.blob()).then(url),
      fetch(BASE + 'v2-terms.jpg').then(r => r.blob()).then(url)
    ]).then(([reg, bold, logo, terms]) => ({ reg, bold, logo, terms }));
    assetsP.catch(() => { assetsP = null; });
    return assetsP;
  }

  /* ---------- text ---------- */
  const SMALL = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'with', 'by']);
  function titleCase(s){
    return String(s).toLowerCase().replace(/[a-z0-9£&'’]+/g, (w, i) => (i > 0 && SMALL.has(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1));
  }
  function parse(text){
    const blocks = (window.WorkReport && window.WorkReport.parseText) ? window.WorkReport.parseText(text) : [];
    let title = '', sections = [], cur = null;
    blocks.forEach(b => {
      if(b.k === 'h'){ title = titleCase(b.t.replace(/^work report\s*[-:]?\s*/i, '')); return; }
      if(b.k === 's'){ cur = { name: b.t, items: [] }; sections.push(cur); return; }
      if(!cur){ cur = { name: '', items: [] }; sections.push(cur); }
      cur.items.push(b.t);
    });
    return { title, sections };
  }

  /* ---------- photos ---------- */
  async function loadImg(src){
    const r = await fetch(src); if(!r.ok) throw new Error('photo download failed (' + r.status + ')');
    const u = URL.createObjectURL(await r.blob());
    try { const img = new Image(); img.src = u; await img.decode(); return img; }
    finally { setTimeout(() => URL.revokeObjectURL(u), 0); }
  }
  // load a photo once at a sensible size (EXIF rotation applied by the browser) and keep it as a canvas
  async function loadSized(src){
    const img = await loadImg(src);
    const w0 = img.naturalWidth, h0 = img.naturalHeight, k = Math.min(1, 1300 / Math.max(w0, h0));
    const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(w0 * k)); cv.height = Math.max(1, Math.round(h0 * k));
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(img, 0, 0, cv.width, cv.height);
    return { cv, ar: w0 / h0 };
  }
  // crop a loaded photo to exactly fill a tile of tw x th (centred sideways, a little biased to the top vertically)
  function coverData(cv, tw, th){
    const ratio = tw / th, ir = cv.width / cv.height;
    let sx = 0, sy = 0, sw = cv.width, sh = cv.height;
    if(ir > ratio){ sw = Math.round(cv.height * ratio); sx = Math.round((cv.width - sw) / 2); }
    else { sh = Math.round(cv.width / ratio); sy = Math.round((cv.height - sh) * 0.4); }
    const k = Math.min(1, 1100 / Math.max(sw, sh));
    const out = document.createElement('canvas'); out.width = Math.max(1, Math.round(sw * k)); out.height = Math.max(1, Math.round(sh * k));
    out.getContext('2d').drawImage(cv, sx, sy, sw, sh, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.82);
  }
  // split photos (in order) into rows of 1-3 that run the full width with no empty space. A row's height is capped near the target
  // (so tall photos are trimmed a little top and bottom); if that would trim a photo too much (e.g. the last 1-2 portrait photos)
  // the row is left-aligned at natural proportions instead.
  function planRows(ar, W0, gap, target){
    const n = ar.length, INF = 1e9, best = new Array(n + 1).fill(INF), from = new Array(n + 1).fill(0), cap = target * 1.25;
    best[0] = 0;
    const rowOf = (i, k) => {
      let sum = 0; for(let q = i; q < i + k; q++) sum += ar[q];
      const hFull = (W0 - (k - 1) * gap) / sum, h = Math.min(hFull, cap), crop = 1 - h / hFull;
      const full = crop <= 0.3;
      let c = Math.pow(Math.log(h / target), 2) + (full ? 2 * crop * crop : 0.05 + 0.35 * (1 - (sum * h + (k - 1) * gap) / W0));
      return { h, full, cost: c };
    };
    for(let i = 0; i < n; i++){
      if(best[i] >= INF) continue;
      for(let k = 1; k <= Math.min(3, n - i); k++){
        const r = rowOf(i, k);
        if(!r.full && i + k < n) r.cost += 1.5;     // only the very last row may be left short
        if(best[i] + r.cost < best[i + k]){ best[i + k] = best[i] + r.cost; from[i + k] = i; }
      }
    }
    const rows = []; let e = n;
    while(e > 0){ const st = from[e], k = e - st, r = rowOf(st, k); const idx = []; for(let q = st; q < e; q++) idx.push(q); rows.unshift({ idx, h: r.h, full: r.full }); e = st; }
    return rows;
  }

  /* ---------- main ---------- */
  async function makePdf(opts){
    // opts: { address, text, date, photos: [{url, section, tag, caption}] }
    const A = await loadAssets();
    const J = (window.jspdf && window.jspdf.jsPDF); if(!J) throw new Error('PDF library not loaded');
    const doc = new J({ unit: 'pt', format: 'a4', orientation: 'portrait', compress: true });
    doc.addFileToVFS('M400.ttf', A.reg); doc.addFont('M400.ttf', 'Montserrat', 'normal');
    doc.addFileToVFS('M700.ttf', A.bold); doc.addFont('M700.ttf', 'Montserrat', 'bold');
    const fill = c => doc.setFillColor(c[0], c[1], c[2]);
    const ink = c => doc.setTextColor(c[0], c[1], c[2]);
    const stroke = c => doc.setDrawColor(c[0], c[1], c[2]);
    const font = (b, sz) => { doc.setFont('Montserrat', b ? 'bold' : 'normal'); doc.setFontSize(sz); };

    const rep = parse(opts.text);
    if(!rep.sections.length && !rep.title) throw new Error('Write the report text first.');
    const address = String(opts.address || '').trim();
    const dateStr = opts.date || '';

    const termsH = W * TERMS_AR;
    const LIM1 = H - termsH - 22;       // lowest y for text on page 1
    const LIMN = H - 50;                // lowest y on any later text page

    function topBand(){ fill(C.purple); doc.rect(0, 0, W, 10, 'F'); }
    function smallHeader(){
      topBand();
      const lw = 70; doc.addImage(A.logo, 'JPEG', M, 16, lw, lw * LOGO_AR, undefined, 'FAST');
      font(true, 9); ink(C.navy); doc.text('Work Completion Report', W - M, 34, { align: 'right' });
      font(false, 8); ink(C.grey); doc.text(address + (dateStr ? '  |  ' + dateStr : ''), W - M, 46, { align: 'right' });
      stroke(C.line); doc.setLineWidth(0.6); doc.line(M, 60, W - M, 60);
    }

    /* ----- page 1 header + info row ----- */
    topBand();
    const lw = 150, lh = lw * LOGO_AR;
    doc.addImage(A.logo, 'JPEG', M, 26, lw, lh, undefined, 'FAST');
    font(true, 22); ink(C.navy); doc.text('Work Completion Report', W - M, 62, { align: 'right' });
    font(false, 9); ink(C.grey); doc.text('Fix&Go Ltd', W - M, 80, { align: 'right' });
    doc.text('fixngoltd@gmail.com   |   01217203344', W - M, 92, { align: 'right' });
    let y = 26 + lh + 16;
    stroke(C.line); doc.setLineWidth(0.8); doc.line(M, y, W - M, y);
    y += 17;
    font(false, 9.5);
    const addrLines = (function(){
      const toks = address.split(',').map(s => s.trim()).filter(Boolean);
      let out = toks.map((t, i) => i < toks.length - 1 ? t + ',' : t);
      while(out.length > 3){ const n = out.length; out.splice(n - 2, 2, out[n - 2] + ' ' + out[n - 1]); }
      return out.map(l => doc.splitTextToSize(l, 180)).reduce((a, b) => a.concat(b), []);
    })();
    const cols = [['PROPERTY', addrLines, M], ['CLIENT', CLIENT, M + 205], ['DATE COMPLETED', dateStr ? [dateStr] : [''], M + 400]];
    let rowH = 0;
    cols.forEach(([lab, lines, x]) => {
      font(true, 7.5); ink(C.purple); doc.text(lab, x, y);
      font(false, 9.5); ink(C.navy);
      lines.forEach((l, i) => doc.text(l, x, y + 14 + i * 12.5));
      rowH = Math.max(rowH, 14 + lines.length * 12.5);
    });
    y += rowH + 4;
    stroke(C.line); doc.line(M, y, W - M, y);
    y += 30;
    const bodyTop = y;

    /* ----- body text flow (dry run to pick a size, then draw) ----- */
    let bodyW = W - 2 * M;
    function flow(sz, extra, draw, startPage){
      let page = 1, yy = bodyTop;
      const lead = sz * 1.34, gapItem = sz * 0.28;
      const lim = () => page === 1 ? LIM1 : LIMN;
      function brk(need){
        if(yy + need <= lim()) return;
        page++;
        if(draw){ doc.addPage(); smallHeader(); }
        yy = 78;
      }
      if(rep.title){
        font(true, sz + 6); const tl = doc.splitTextToSize(rep.title, bodyW);
        brk(tl.length * (sz + 9));
        if(draw){ ink(C.navy); tl.forEach((l, i) => doc.text(l, M, yy + i * (sz + 9))); }
        yy += tl.length * (sz + 9) + 4 + extra * 0.5;
      }
      rep.sections.forEach(sec => {
        const kind = /outcome/i.test(sec.name) ? 'box' : (/work carried out|works? (done|completed)|completed/i.test(sec.name) ? 'tick' : 'dot');
        const hH = sz + 9;
        // keep a heading with at least its first item
        font(false, sz); const firstH = sec.items.length ? doc.splitTextToSize(sec.items[0], bodyW - 24).length * lead + 8 : 0;
        brk(hH + firstH + (kind === 'box' ? 30 : 0));
        if(sec.name && kind !== 'box'){
          if(draw){ fill(C.purple); doc.rect(M, yy - sz * 0.75, 3, sz + 3, 'F'); font(true, sz + 2); ink(C.navy); doc.text(sec.name, M + 10, yy); }
          yy += hH;
        }
        if(kind === 'box'){
          font(false, sz); const lines = []; sec.items.forEach(t => doc.splitTextToSize(t, bodyW - 40).forEach(l => lines.push(l)));
          const P = 15 + extra * 0.25, tSz = sz + 2, bl = sz * 1.6;
          const boxH = P + tSz * 0.72 + 9 + (lines.length - 1) * bl + sz * 0.72 + sz * 0.22 + P;
          brk(boxH);
          if(draw){
            fill(C.tint); stroke(C.purple); doc.setLineWidth(0.6); doc.roundedRect(M, yy, bodyW, boxH, 5, 5, 'FD');
            font(true, tSz); ink(C.purple); doc.text('Outcome', M + 16, yy + P + tSz * 0.72);
            font(false, sz); ink(C.navy);
            lines.forEach((l, i) => doc.text(l, M + 16, yy + P + tSz * 0.72 + 9 + sz * 0.72 + i * bl));
          }
          yy += boxH + 8;
          return;
        }
        sec.items.forEach(t => {
          font(false, sz);
          const lines = doc.splitTextToSize(t, bodyW - 24);
          brk(lines.length * lead);
          if(draw){
            if(kind === 'tick'){
              stroke(C.cyan); doc.setLineWidth(1.5);
              doc.line(M + 1.5, yy - sz * 0.32, M + 4.5, yy + 0.4); doc.line(M + 4.5, yy + 0.4, M + 10.5, yy - sz * 0.78);
            } else { fill(C.grey); doc.circle(M + 5, yy - sz * 0.3, 1.5, 'F'); }
            font(false, sz); ink(C.text);
            lines.forEach((l, i) => doc.text(l, M + 18, yy + i * lead));
          }
          yy += lines.length * lead + gapItem;
        });
        yy += sz * 0.9 + extra;
      });
      return { page, end: yy };
    }
    // 1-4 photos and no labels: text on the left, photos in a column on the right (same idea as V1)
    const photosIn = opts.photos || [];
    const plainIn = !photosIn.some(p => p.caption || p.section);
    let side = null;
    const FULLW = bodyW;
    if(plainIn && photosIn.length >= 1 && photosIn.length <= 4){
      const n = photosIn.length, two = n >= 3;
      const colW = two ? 290 : 232, gap = 10, cols = two ? 2 : 1;
      const tw = (colW - (cols - 1) * gap) / cols;
      const avail = LIM1 - bodyTop;
      const rows = Math.ceil(n / cols);
      const th = Math.min(tw * 1.4, (avail - (rows - 1) * gap) / rows);
      side = { n, colW, cols, tw, th, gap, x: W - M - colW };
      bodyW = W - 2 * M - colW - 22;
    }
    // largest size that keeps everything on page 1; otherwise the smallest size and flow onto more pages
    let chosen = 8, ok = false;
    for(let sz = 13.5; sz >= 8; sz -= 0.25){ const r = flow(sz, 0, false); if(r.page === 1 && r.end <= LIM1){ chosen = sz; ok = true; break; } }
    if(side && !ok){ side = null; bodyW = FULLW; for(let sz = 13.5; sz >= 8; sz -= 0.25){ const r = flow(sz, 0, false); if(r.page === 1 && r.end <= LIM1){ chosen = sz; ok = true; break; } } }
    let extra = 0;
    if(ok){ const r = flow(chosen, 0, false); extra = Math.max(0, Math.min(16, (LIM1 - r.end) / Math.max(1, rep.sections.length + 1))); }
    // terms bar goes on page 1 first so it sits behind nothing else
    doc.addImage(A.terms, 'JPEG', 0, H - termsH, W, termsH, undefined, 'FAST');
    flow(chosen, extra, true);
    if(side){
      const loaded = []; for(let i = 0; i < side.n; i++) loaded.push(await loadSized(photosIn[i].url));
      const ths = loaded.map(l => Math.min(Math.max(side.tw / l.ar, side.tw * 0.72), side.tw * 1.4));
      const nRows = Math.ceil(side.n / side.cols);
      let rowsH = []; for(let r = 0; r < nRows; r++) rowsH.push(Math.max.apply(null, ths.slice(r * side.cols, r * side.cols + side.cols)));
      const availS = LIM1 - bodyTop, totS = rowsH.reduce((a, b2) => a + b2, 0) + (nRows - 1) * side.gap;
      if(totS > availS){ const k = (availS - (nRows - 1) * side.gap) / (totS - (nRows - 1) * side.gap); rowsH = rowsH.map(h => h * k); }
      let y0 = bodyTop - 10;
      for(let r = 0; r < nRows; r++){
        for(let c = 0; c < side.cols; c++){
          const i = r * side.cols + c; if(i >= side.n) break;
          doc.addImage(coverData(loaded[i].cv, side.tw, rowsH[r]), 'JPEG', side.x + c * (side.tw + side.gap), y0, side.tw, rowsH[r], undefined, 'FAST');
        }
        y0 += rowsH[r] + side.gap;
      }
    }

    /* ----- photo pages ----- */
    const photos = side ? [] : (opts.photos || []);
    if(photos.length){
      const plain = !photos.some(p => p.caption || p.section);
      const GAP = 10, FW = W - 2 * M, TOP = 84, HEAD = 28, CAP = plain ? 0 : 16;
      const LIMP = plain ? H - 29 - 24 + 0.5 : H - 46;      // lowest allowed photo edge
      const AV = LIMP - TOP, FS = 0.9;
      const TARGET = plain ? (AV - 2 * GAP) / 3 : 200;      // plain pages: three portrait rows fill the page exactly
      const loaded = []; for(const p of photos) loaded.push(Object.assign({}, p, await loadSized(p.url)));
      doc.addPage(); smallHeader();
      const newPage = () => { doc.addPage(); smallHeader(); };
      const drawRow = (row, grp, y, f) => {
        let x = M; const th = row.h * f;
        const sumAr = row.idx.reduce((a, q) => a + grp[q].ar, 0);
        row.idx.forEach(q => {
          const p = grp[q], tw = row.full ? (FW - (row.idx.length - 1) * GAP) * p.ar / sumAr : p.ar * row.h;
          doc.addImage(coverData(p.cv, tw, th), 'JPEG', x, y, tw, th, undefined, 'FAST');
          if(p.tag){
            const lab = String(p.tag).toUpperCase(); font(true, 6.5);
            const tgw = doc.getTextWidth(lab) + 12;
            fill(/before/i.test(lab) ? C.grey : C.cyan); doc.roundedRect(x + 6, y + 6, tgw, 13, 6.5, 6.5, 'F');
            ink(C.white); doc.text(lab, x + 12, y + 15);
          }
          if(p.caption){ font(false, 7.8); ink(C.navy); doc.text(doc.splitTextToSize(p.caption, tw)[0], x, y + th + 12); }
          x += tw + GAP;
        });
      };
      const groups = []; loaded.forEach(p => { const sname = p.section || ''; let g = groups.find(x => x.s === sname); if(!g){ g = { s: sname, items: [] }; groups.push(g); } g.items.push(p); });
      if(plain){
        // one run of rows; choose page breaks so each page is filled (rows stretched or squeezed a little to fit exactly)
        const items = groups[0].items, rows = planRows(items.map(p => p.ar), FW, GAP, TARGET), n = rows.length;
        const INF = 1e9, best = new Array(n + 1).fill(INF), from = new Array(n + 1).fill(0); best[0] = 0;
        for(let i = 1; i <= n; i++) for(let j = Math.max(0, i - 6); j < i; j++){
          if(best[j] >= INF) continue;
          const m = i - j; let sumh = 0; for(let q = j; q < i; q++) sumh += rows[q].h;
          const f = (AV - (m - 1) * GAP) / sumh;
          let c;
          if(i === n) c = f >= 1 ? 0.0001 : (f >= 0.85 ? Math.pow(Math.log(f), 2) : INF);
          else c = (f >= 0.85 && f <= 1.2) ? Math.pow(Math.log(f), 2) : INF;
          if(c < INF && best[j] + c + 0.002 < best[i]){ best[i] = best[j] + c + 0.002; from[i] = j; }
        }
        let pagesRows = [];
        if(best[n] < INF){ let e = n; while(e > 0){ const st = from[e]; pagesRows.unshift(rows.slice(st, e)); e = st; } }
        else { let cur = [], used = 0; rows.forEach(r => { if(cur.length && used + r.h + GAP > AV){ pagesRows.push(cur); cur = []; used = 0; } cur.push(r); used += r.h + GAP; }); if(cur.length) pagesRows.push(cur); }
        pagesRows.forEach((pr, pi) => {
          if(pi > 0) newPage();
          const sumh = pr.reduce((a, r) => a + r.h, 0), isLast = pi === pagesRows.length - 1;
          let f = (AV - (pr.length - 1) * GAP) / sumh;
          f = isLast ? Math.min(1, Math.max(0.85, f)) : Math.min(1.2, Math.max(0.85, f));
          const used = sumh * f + (pr.length - 1) * GAP;
          let y = TOP + (isLast ? 0 : Math.max(0, (AV - used) / 2));
          pr.forEach(r => { drawRow(r, items, y, f); y += r.h * f + GAP; });
        });
      } else {
        let py = TOP, first = true;
        groups.forEach(g => {
          const rows = planRows(g.items.map(p => p.ar), FW, GAP, TARGET);
          const headFor = (label) => { fill(C.purple); doc.rect(M, py - 9, 3, 13, 'F'); font(true, 11); ink(C.navy); doc.text(label, M + 10, py); py += HEAD - 10; };
          if(g.s){
            if(!first) py += 12;
            if(py + HEAD + rows[0].h * FS + CAP > LIMP + 0.01){ newPage(); py = TOP; }
            headFor(g.s);
          }
          rows.forEach(r => {
            const rh = r.h * FS;      // labelled pages use slightly shorter rows (light crop) so three rows plus a heading fit a page
            if(py + rh + CAP > LIMP + 0.01){ newPage(); py = TOP; if(g.s) headFor(g.s + ' (continued)'); }
            drawRow(r, g.items, py, FS);
            py += rh + CAP + 6; first = false;
          });
        });
      }
    }

    /* ----- page numbers + footer line ----- */
    const total = doc.getNumberOfPages();
    for(let i = 1; i <= total; i++){
      doc.setPage(i);
      if(i === 1) continue;
      font(false, 7.5); ink(C.grey);
      doc.text('Fix&Go Ltd  |  fixngoltd@gmail.com  |  01217203344', M, H - 22);
      doc.text('Page ' + i + ' of ' + total, W - M, H - 22, { align: 'right' });
    }
    const blob = doc.output('blob');
    blob.layout = 'V2';
    return blob;
  }

  window.WorkReport2 = { makePdf, parse };
})();
