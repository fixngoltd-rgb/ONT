/* Fix & Go work report PDF maker.
   Rebuilds the Canva "Work Completion Report" layout in the browser:
   - template header/footer are baked images (wr/template.jpg, wr/footer.jpg)
   - text and photos are placed by the rules below
   Layouts (chosen automatically):
     A  1-4 photos, text fits at a good size  -> text on the left, photos in a column on the right
     B  1-4 photos, long text                  -> text full width, photos in a row underneath
     C  5+ photos                              -> text-only first page, photo page(s) after it
   No numbers/prices are ever added. The text is exactly what is typed into the box. */
(function(){
  const W = 1860, H = 2631;
  const FOOT_TOP = 2367;                // where the purple terms bar starts
  const TEXT_TOP = 1150, TEXT_BOTTOM = 2310;
  const MAX_SZ = 44, MIN_SZ_A = 32, MIN_SZ_B = 26, MIN_SZ_C = 22;
  const LH = 1.375, INDENT = 1.72;
  const BASE = window.WR_BASE || ((document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/[^\/]*$/, '') : 'wr/');

  let assetsP = null;
  function loadAssets(){
    if(assetsP) return assetsP;
    const b64 = buf => { let s = '', a = new Uint8Array(buf); for(let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
    const url = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
    assetsP = Promise.all([
      fetch(BASE + 'Montserrat-400.ttf').then(r => r.arrayBuffer()).then(b64),
      fetch(BASE + 'Montserrat-700.ttf').then(r => r.arrayBuffer()).then(b64),
      fetch(BASE + 'template.jpg').then(r => r.blob()).then(url),
      fetch(BASE + 'footer.jpg').then(r => r.blob()).then(url)
    ]).then(([reg, bold, tpl, foot]) => ({ reg, bold, tpl, foot }));
    assetsP.catch(() => { assetsP = null; });
    return assetsP;
  }

  /* ---------- text ---------- */
  const SECTION_RE = /^(issues reported|work carried out|outcome)\s*(\([^)]*\))?\s*:?$/i;   // main headings, with or without a bracket note or colon
  function parseText(raw){
    const out = [];
    String(raw || '').replace(/\r/g, '').split('\n').forEach(l0 => {
      let l = l0.trim();
      if(!l) return;
      if(/\[\d+ attachments?:/i.test(l)) l = l.replace(/\s*\[\d+ attachments?:[^\]]*\]\s*$/i, '').trim();
      if(!l) return;
      if(/ref:\s*job-\d+/i.test(l) || /ref:\s*quo-\d+/i.test(l)) return;   // address/ref line is not part of the report body
      if(!out.length && /^work report/i.test(l)){ out.push({ k: 'h', t: l }); return; }
      // any un-bulleted line that is a main heading or ends with a colon (e.g. 'Visit 1 - Initial inspection:') is a heading, not a bullet
      if(SECTION_RE.test(l) || (!/^[•\-\*–]/.test(l) && /:$/.test(l))){ out.push({ k: 's', t: l.replace(/\s*:$/, '') }); return; }
      out.push({ k: 'b', t: l.replace(/^[•\-\*–]\s*/, '') });
    });
    return out;
  }

  function flow(doc, blocks, sz, width){
    const lines = []; let secCount = 0;
    const wrap = (txt, font, w) => {
      doc.setFont('Montserrat', font); doc.setFontSize(sz);
      const words = txt.split(/\s+/); const res = []; let cur = '';
      words.forEach(wd => {
        const tr = cur ? cur + ' ' + wd : wd;
        if(doc.getTextWidth(tr) <= w || !cur) cur = tr; else { res.push(cur); cur = wd; }
      });
      if(cur) res.push(cur); return res;
    };
    blocks.forEach(b => {
      if(b.k === 'h'){ wrap(b.t, 'bold', width).forEach(t => lines.push({ k: 'h', t })); }
      else if(b.k === 's'){
        if(secCount++ > 0 && !(lines.length && lines[lines.length-1].k === 's')) lines.push({ k: 'gap' });
        wrap(b.t, 'bold', width).forEach(t => lines.push({ k: 's', t }));
      } else {
        wrap(b.t, 'normal', width - INDENT * sz).forEach((t, i) => lines.push({ k: 'b', t, first: i === 0 }));
      }
    });
    return { lines, height: lines.length * LH * sz };
  }

  function fit(doc, blocks, width, avail, maxSz, minSz){
    for(let sz = maxSz; sz >= minSz; sz -= 0.5){
      const f = flow(doc, blocks, sz, width);
      if(f.height <= avail) return { sz, f };
    }
    return null;
  }

  function drawText(doc, f, sz, x, top){
    doc.setTextColor(0, 0, 0); let y = top;
    f.lines.forEach(l => {
      if(l.k !== 'gap'){
        doc.setFont('Montserrat', l.k === 'b' ? 'normal' : 'bold'); doc.setFontSize(sz);
        if(l.k === 'b'){
          if(l.first){ doc.setFillColor(0, 0, 0); doc.circle(x + 1.13 * sz, y + 0.55 * sz, 0.17 * sz, "F"); }
          doc.text(l.t, x + INDENT * sz, y + 0.968 * sz);
        } else doc.text(l.t, x, y + 0.968 * sz);
      }
      y += LH * sz;
    });
  }

  /* ---------- photos ---------- */
  function addPhoto(doc, p, bx, by, bw, bh, valign){
    const sc = Math.min(bw / p.w, bh / p.h);
    const w = p.w * sc, h = p.h * sc;
    const x = bx + (bw - w) / 2, y = valign === 'middle' ? by + (bh - h) / 2 : by;
    doc.saveGraphicsState();
    doc.roundedRect(x, y, w, h, 28, 28, null); doc.clip(); doc.discardPath();
    doc.addImage(p.data, 'JPEG', x, y, w, h, undefined, 'FAST');
    doc.restoreGraphicsState();
  }

  async function prepPhoto(src){
    // src: URL string or Blob/File
    let blob = src;
    if(typeof src === 'string'){
      const r = await fetch(src); if(!r.ok) throw new Error('photo download failed (' + r.status + ')');
      blob = await r.blob();
    }
    const u = URL.createObjectURL(blob);
    try {
      const img = new Image(); img.src = u; await img.decode();
      let w = img.naturalWidth, h = img.naturalHeight; const m = Math.max(w, h), lim = 1500;
      if(m > lim){ w = Math.round(w * lim / m); h = Math.round(h * lim / m); }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
      return { data: c.toDataURL('image/jpeg', 0.85), w, h };
    } finally { URL.revokeObjectURL(u); }
  }

  /* ---------- page furniture ---------- */
  function addressLines(doc, address){
    const toks = String(address || '').split(',').map(s => s.trim()).filter(Boolean);
    doc.setFont('Montserrat', 'bold'); doc.setFontSize(34.8);
    let lines = toks.map((t, i) => i < toks.length - 1 ? t + ',' : t);
    // wrap any line that is still too wide for the address column (e.g. no commas)
    const wrapW = 560, out = [];
    lines.forEach(l => {
      if(doc.getTextWidth(l) <= wrapW){ out.push(l); return; }
      let cur = ''; l.split(' ').forEach(wd => { const tr = cur ? cur + ' ' + wd : wd; if(doc.getTextWidth(tr) <= wrapW || !cur) cur = tr; else { out.push(cur); cur = wd; } });
      if(cur) out.push(cur);
    });
    lines = out;
    while(lines.length > 3){
      // merge the shortest neighbouring pair
      let bi = 0, bw = 1e9;
      for(let i = 0; i < lines.length - 1; i++){ const w = doc.getTextWidth(lines[i] + ' ' + lines[i + 1]); if(w < bw){ bw = w; bi = i; } }
      lines.splice(bi, 2, lines[bi] + ' ' + lines[bi + 1]);
    }
    return lines;
  }

  function firstPage(doc, A, address){
    doc.addImage(A.tpl, 'JPEG', 0, 0.5, W, 2629, undefined, 'FAST');
    doc.setTextColor(36, 61, 77);
    doc.setFont('Montserrat', 'bold'); doc.setFontSize(31.1); doc.text('fixngoltd@gmail.com', 1469, 248 + 0.968 * 31.1);
    doc.setFontSize(32); doc.text('01217203344', 1469, 363 + 0.968 * 32);
    doc.setTextColor(65, 66, 65); doc.setFontSize(34.8);
    ['Accomodation.co.uk', ' 111 Piccadilly, Manchester,', 'England, M1 2HY.'].forEach((t, i) => doc.text(t, 726, 668 + 48 * i + 0.968 * 34.8));
    addressLines(doc, address).forEach((t, i) => doc.text(t, 1308, 668 + 48 * i + 0.968 * 34.8));
  }

  /* ---------- main ---------- */
  async function makePdf(opts){
    // opts: { address, text, photos: [url|Blob...] }
    const A = await loadAssets();
    const J = (window.jspdf && window.jspdf.jsPDF); if(!J) throw new Error('PDF library not loaded');
    const doc = new J({ unit: 'pt', format: [W, H], orientation: 'portrait', compress: true });
    doc.addFileToVFS('M400.ttf', A.reg); doc.addFont('M400.ttf', 'Montserrat', 'normal');
    doc.addFileToVFS('M700.ttf', A.bold); doc.addFont('M700.ttf', 'Montserrat', 'bold');

    const blocks = parseText(opts.text);
    if(!blocks.length) throw new Error('Write the report text first.');
    const photos = [];
    for(const p of (opts.photos || [])) photos.push(await prepPhoto(p));
    const N = photos.length;
    const avail = TEXT_BOTTOM - TEXT_TOP;
    const notes = [];

    firstPage(doc, A, opts.address);
    let layout = null;

    if(N <= 4){
      const wide = N >= 3;
      const colX = wide ? 1094 : 1214, colW = wide ? 706 : 569;
      const tx = 58, tw = N === 0 ? 1740 : (wide ? 1044 - 58 : 1150 - 58);
      const a = fit(doc, blocks, tw, avail, MAX_SZ, N === 0 ? MIN_SZ_C : MIN_SZ_A);
      if(a){
        layout = 'A';
        drawText(doc, a.f, a.sz, tx, TEXT_TOP);
        if(N === 1) addPhoto(doc, photos[0], colX, 1201, colW, 1011, 'top');
        else if(N === 2){ const h = 548; addPhoto(doc, photos[0], colX, 1199, colW, h, 'middle'); addPhoto(doc, photos[1], colX, 1199 + h + 30, colW, h, 'middle'); }
        else if(N >= 3){
          const cw = (colW - 30) / 2, ch = 560;
          addPhoto(doc, photos[0], colX, 1150, cw, ch, 'middle'); addPhoto(doc, photos[1], colX + cw + 30, 1150, cw, ch, 'middle');
          if(N === 3) addPhoto(doc, photos[2], colX + (colW - cw) / 2, 1150 + ch + 30, cw, ch, 'middle');
          else { addPhoto(doc, photos[2], colX, 1150 + ch + 30, cw, ch, 'middle'); addPhoto(doc, photos[3], colX + cw + 30, 1150 + ch + 30, cw, ch, 'middle'); }
        }
      } else {
        const rowTop = 1680, rowH = 630;
        const b = fit(doc, blocks, 1740, rowTop - 30 - TEXT_TOP, MAX_SZ, MIN_SZ_B);
        if(b){
          layout = 'B';
          drawText(doc, b.f, b.sz, 58, TEXT_TOP);
          const gap = 36, cw = Math.min(560, (1740 - (N - 1) * gap) / N);
          const total = N * cw + (N - 1) * gap; let x = (W - total) / 2;
          photos.forEach(p => { addPhoto(doc, p, x, rowTop, cw, rowH, 'middle'); x += cw + gap; });
        }
      }
    }
    if(!layout){
      // C: text only on page 1 (full width), photos on following grey page(s)
      const c = fit(doc, blocks, 1740, avail, MAX_SZ, 16);
      if(!c) throw new Error('The report text is too long to fit on one page.');
      layout = 'C';
      drawText(doc, c.f, c.sz, 58, TEXT_TOP);
      for(let i = 0; i < N; i += 6){
        doc.addPage([W, H], 'portrait');
        doc.setFillColor(237, 237, 237); doc.rect(0, 0, W, FOOT_TOP, 'F');
        doc.addImage(A.foot, 'JPEG', 0, FOOT_TOP - 0.5, W, H - FOOT_TOP + 0.5, undefined, 'FAST');
        const chunk = photos.slice(i, i + 6), cw = 726, ch = 700, gx = 36, gy = 36, x0 = (W - (2 * cw + gx)) / 2, y0 = 100;
        chunk.forEach((p, j) => addPhoto(doc, p, x0 + (j % 2) * (cw + gx), y0 + Math.floor(j / 2) * (ch + gy), cw, ch, 'middle'));
      }
    }
    const blob = doc.output('blob');
    blob.layout = layout;
    return blob;
  }

  window.WorkReport = { makePdf, parseText };
})();
