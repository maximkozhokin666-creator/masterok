/* Мастерок — экспорт коммерческого предложения в PDF.
 *
 * Самодостаточный генератор без внешних зависимостей: работает офлайн (PWA) и в Android WebView.
 * Шрифты (Inter, Lora; SIL OFL) берутся из pdf-fonts.js и встраиваются в документ,
 * поэтому кириллица и «₽» выглядят одинаково в любом просмотрщике.
 *
 * API: MasterokPdf.build(model) -> Promise<Uint8Array>
 * model: { title, client, executor, phone, address, deadline, paymentTerms, description, date,
 *          items:[{kind:'work'|'material', name, unit, qty, price, sum}],
 *          totals:{works, materials, total} }
 * Суммы приходят уже посчитанными приложением (lineSum / propTotals) — здесь они только форматируются.
 */
(function (root) {
  'use strict';

  /* ---------- геометрия (pt) и палитра ---------- */
  const PW = 595.276, PH = 841.89;          // A4
  const M = 40, CW = PW - 2 * M;            // поля и ширина контента
  const HEAD_H = 30;                        // колонтитул на 2+ страницах
  const TOP2 = HEAD_H + 28;                 // начало контента на 2+ страницах
  const BOT = PH - 52;                      // нижняя граница контента
  const COL = {
    graphite: '#1D1F23', graphite2: '#2A2D33', rule: '#3B3E45',
    gold: '#D2AE66', goldHi: '#F0D9A2', goldDeep: '#8A6A2B', goldTint: '#F1EAD8',
    ink: '#1E2024', text: '#34373D', muted: '#6E7178', faint: '#8B8E95',
    line: '#D9D5CA', lineSoft: '#E7E3D9', zebra: '#F7F5F0', white: '#FFFFFF', onDark: '#F3F0E8', onDarkMuted: '#B9B5A8'
  };
  const NBSP = '\u00A0';
  const enc = new TextEncoder();

  /* ---------- утилиты ---------- */
  const n2 = v => (Math.round(v * 100) / 100).toString();
  const rgb = hex => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => (v / 255).toFixed(3)).join(' '); };
  const b64ToU8 = b64 => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  const utf16hex = s => { let h = 'FEFF'; for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, '0'); return '<' + h + '>'; };
  const group = i => i.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const fmMoney = v => { v = Number(v) || 0; const neg = v < 0; const [i, f] = Math.abs(v).toFixed(2).split('.'); return (neg ? '\u2212' : '') + group(i) + ',' + f; };
  const fmQty = v => { v = Number(v) || 0; const neg = v < 0; const [i, f] = Math.abs(v).toFixed(3).split('.'); const fr = f.replace(/0+$/, ''); return (neg ? '\u2212' : '') + group(i) + (fr ? ',' + fr : ''); };

  async function deflate(u8) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const cs = new CompressionStream('deflate'), w = cs.writable.getWriter();
      w.write(u8); w.close();
      return new Uint8Array(await new Response(cs.readable).arrayBuffer());
    } catch (e) { return null; }
  }

  /* ---------- TrueType: разбор нужных таблиц ---------- */
  class Font {
    constructor(b64, psName, prefix) {
      this.data = b64ToU8(b64);
      const dv = this.dv = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
      const t = this.t = {};
      for (let i = 0, n = dv.getUint16(4); i < n; i++) {
        const o = 12 + i * 16, tag = String.fromCharCode(this.data[o], this.data[o + 1], this.data[o + 2], this.data[o + 3]);
        t[tag] = { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) };
      }
      this.upm = dv.getUint16(t.head.off + 18);
      this.bbox = [dv.getInt16(t.head.off + 36), dv.getInt16(t.head.off + 38), dv.getInt16(t.head.off + 40), dv.getInt16(t.head.off + 42)];
      this.asc = dv.getInt16(t.hhea.off + 4); this.desc = dv.getInt16(t.hhea.off + 6);
      const nhm = dv.getUint16(t.hhea.off + 34), ng = dv.getUint16(t.maxp.off + 4);
      this.adv = new Uint16Array(ng);
      for (let g = 0; g < ng; g++) this.adv[g] = dv.getUint16(t.hmtx.off + 4 * Math.min(g, nhm - 1));
      this.cap = (t['OS/2'] && dv.getUint16(t['OS/2'].off) >= 2) ? dv.getInt16(t['OS/2'].off + 88) : Math.round(this.asc * 0.7);
      this.cmap = this._cmap();
      this.psName = prefix + '+' + psName;
      this.used = new Map();           // gid -> unicode (для /W и ToUnicode)
      this.ref = null;
    }
    _cmap() {
      const dv = this.dv, base = this.t.cmap.off, map = new Map();
      let sub = -1;
      for (let i = 0, n = dv.getUint16(base + 2); i < n; i++) {
        const plat = dv.getUint16(base + 4 + i * 8), enc_ = dv.getUint16(base + 6 + i * 8), off = base + dv.getUint32(base + 8 + i * 8);
        if (dv.getUint16(off) === 4 && ((plat === 3 && enc_ === 1) || plat === 0)) { sub = off; if (plat === 3) break; }
      }
      if (sub < 0) throw new Error('В шрифте нет cmap формата 4');
      const sc = dv.getUint16(sub + 6) / 2, endO = sub + 14, startO = endO + sc * 2 + 2, deltaO = startO + sc * 2, rangeO = deltaO + sc * 2;
      for (let s = 0; s < sc; s++) {
        const end = dv.getUint16(endO + s * 2), start = dv.getUint16(startO + s * 2), delta = dv.getInt16(deltaO + s * 2), ro = dv.getUint16(rangeO + s * 2);
        for (let c = start; c <= end && c < 0xFFFF; c++) {
          let g;
          if (ro === 0) g = (c + delta) & 0xFFFF;
          else { g = dv.getUint16(rangeO + s * 2 + ro + (c - start) * 2); if (g) g = (g + delta) & 0xFFFF; }
          if (g) map.set(c, g);
        }
      }
      return map;
    }
    /* Приводит строку к тому, что шрифт умеет рисовать (без «квадратиков»). */
    clean(s) {
      s = String(s == null ? '' : s).replace(/\r\n?/g, '\n');
      try { s = s.normalize('NFC'); } catch (e) { }
      let o = '';
      for (const ch of s) {
        let cp = ch.codePointAt(0);
        if (cp === 10 || cp === 0x2028 || cp === 0x2029) { o += '\n'; continue; }
        if (cp === 9) { o += ' '; continue; }
        if (cp < 32 || (cp >= 0x7F && cp < 0xA0) || cp === 0xAD) continue;
        if ((cp >= 0x2000 && cp <= 0x200A) || cp === 0x202F || cp === 0x205F || cp === 0x3000 || cp === 0x1680) { o += ' '; continue; }
        if ((cp >= 0x200B && cp <= 0x200F) || cp === 0x2060 || cp === 0xFEFF || (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0x2600 && cp <= 0x27BF) || cp > 0xFFFF) continue;
        if (cp === 0xA0 && !this.cmap.has(0xA0)) { o += ' '; continue; }
        o += this.cmap.has(cp) ? ch : '?';
      }
      return o;
    }
    gid(cp) { return this.cmap.get(cp) || this.cmap.get(63) || 0; }
    width(s, size, sp) {
      let w = 0, k = 0;
      for (const ch of s) { w += this.adv[this.gid(ch.codePointAt(0))]; k++; }
      return w * size / this.upm + (sp || 0) * k;
    }
  }

  /* ---------- перенос строк ---------- */
  function breakWord(w, font, size, maxW, sp) {
    const chars = Array.from(w), parts = [];
    let cur = '', cw = 0;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i], a = font.width(ch, size, sp);
      if (cur && cw + a > maxW) {
        let cut = -1;                                   // предпочитаем перенос после - / _ . ,
        for (let k = cur.length - 1; k > 0; k--) if ('-/_.,;:)'.includes(cur[k - 1])) { cut = k; break; }
        if (cut > 0 && cut >= cur.length * 0.4) { parts.push(cur.slice(0, cut)); cur = cur.slice(cut); }
        else { parts.push(cur); cur = ''; }
        cw = font.width(cur, size, sp);
      }
      cur += ch; cw += a;
    }
    if (cur) parts.push(cur);
    return parts;
  }
  function wrap(text, font, size, maxW, sp) {
    const out = [];
    for (const para of font.clean(text).split('\n')) {
      const words = para.split(/ +/).filter(Boolean);
      if (!words.length) { out.push(''); continue; }
      let line = '';
      for (const w of words) {
        const cand = line ? line + ' ' + w : w;
        if (font.width(cand, size, sp) <= maxW) { line = cand; continue; }
        if (line) { out.push(line); line = ''; }
        if (font.width(w, size, sp) <= maxW) { line = w; continue; }
        const parts = breakWord(w, font, size, maxW, sp);
        for (let i = 0; i < parts.length - 1; i++) out.push(parts[i]);
        line = parts[parts.length - 1] || '';
      }
      out.push(line);
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  }
  function fit(text, font, size, maxW, sp) {            // одна строка с многоточием
    let s = font.clean(text).replace(/\n+/g, ' ').trim();
    if (font.width(s, size, sp) <= maxW) return s;
    const chars = Array.from(s);
    while (chars.length && font.width(chars.join('').trimEnd() + '\u2026', size, sp) > maxW) chars.pop();
    return chars.join('').trimEnd() + '\u2026';
  }

  /* ---------- страницы и рисование ---------- */
  class Doc {
    constructor(fonts) { this.fonts = fonts; this.pages = []; this.cur = null; }
    newPage() { this.cur = { ops: [] }; this.pages.push(this.cur); return this.cur; }
    add(op) { this.cur.ops.push(op); }
    rect(x, y, w, h, fill) { this.add(`${rgb(fill)} rg ${n2(x)} ${n2(PH - y - h)} ${n2(w)} ${n2(h)} re f`); }
    hline(x1, x2, y, color, w) { this.add(`${rgb(color)} RG ${w || 0.5} w ${n2(x1)} ${n2(PH - y)} m ${n2(x2)} ${n2(PH - y)} l S`); }
    text(str, x, y, font, size, color, o) {
      o = o || {};
      str = font.clean(str).replace(/\n/g, ' ');
      if (!str) return;
      const sp = o.sp || 0, w = font.width(str, size, sp);
      if (o.align === 'right') x -= w; else if (o.align === 'center') x -= w / 2;
      let hex = '';
      for (const ch of str) {
        const cp = ch.codePointAt(0), g = font.gid(cp);
        font.used.set(g, cp);
        hex += g.toString(16).padStart(4, '0');
      }
      this.add(`BT ${rgb(color)} rg /${font.res} ${n2(size)} Tf ${sp ? n2(sp) + ' Tc ' : '0 Tc '}1 0 0 1 ${n2(x)} ${n2(PH - y)} Tm <${hex}> Tj ET`);
    }
  }

  /* ---------- сборка PDF-файла ---------- */
  async function serialize(doc, meta) {
    const objs = [];
    const reserve = () => { objs.push(null); return objs.length; };
    const putDict = (id, body) => { objs[id - 1] = { head: body, data: null }; };
    const putStream = async (id, body, data, compress) => {
      let d = data, extra = '';
      if (compress !== false) { const z = await deflate(data); if (z && z.length < data.length) { d = z; extra = ' /Filter /FlateDecode'; } }
      objs[id - 1] = { head: `<< ${body}${extra} /Length ${d.length} >>`, data: d };
    };
    const catalog = reserve(), pagesId = reserve(), info = reserve();

    const fontRefs = [];
    for (const f of doc.fonts) {
      const type0 = reserve(), cid = reserve(), desc = reserve(), file = reserve(), tou = reserve();
      f.ref = type0; fontRefs.push(f);
      const gids = [...f.used.keys()].sort((a, b) => a - b);
      const w = gids.map(g => `${g} [${Math.round(f.adv[g] * 1000 / f.upm)}]`).join(' ');
      putDict(type0, `<< /Type /Font /Subtype /Type0 /BaseFont /${f.psName} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${tou} 0 R >>`);
      putDict(cid, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${f.psName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /CIDToGIDMap /Identity /DW 600 /W [${w}] >>`);
      const sc = 1000 / f.upm;
      putDict(desc, `<< /Type /FontDescriptor /FontName /${f.psName} /Flags ${f.serif ? 34 : 32} /FontBBox [${f.bbox.map(v => Math.round(v * sc)).join(' ')}] /ItalicAngle 0 /Ascent ${Math.round(f.asc * sc)} /Descent ${Math.round(f.desc * sc)} /CapHeight ${Math.round(f.cap * sc)} /StemV ${f.serif ? 110 : 90} /FontFile2 ${file} 0 R >>`);
      await putStream(file, `/Length1 ${f.data.length}`, f.data);
      const entries = [...f.used.entries()].sort((a, b) => a[0] - b[0]).filter(e => e[1] <= 0xFFFF);
      let cm = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n';
      for (let i = 0; i < entries.length; i += 100) {
        const ch = entries.slice(i, i + 100);
        cm += `${ch.length} beginbfchar\n` + ch.map(e => `<${e[0].toString(16).padStart(4, '0')}> <${e[1].toString(16).padStart(4, '0')}>`).join('\n') + '\nendbfchar\n';
      }
      cm += 'endcmap CMapName currentdict /CMap defineresource pop end end';
      await putStream(tou, '', enc.encode(cm));
    }

    const fontRes = fontRefs.map(f => `/${f.res} ${f.ref} 0 R`).join(' ');
    const kids = [];
    for (const p of doc.pages) {
      const content = reserve(), page = reserve();
      await putStream(content, '', enc.encode(p.ops.join('\n')));
      putDict(page, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n2(PW)} ${n2(PH)}] /Resources << /Font << ${fontRes} >> >> /Contents ${content} 0 R >>`);
      kids.push(page + ' 0 R');
    }
    putDict(pagesId, `<< /Type /Pages /Count ${kids.length} /Kids [${kids.join(' ')}] >>`);
    putDict(catalog, `<< /Type /Catalog /Pages ${pagesId} 0 R /Lang (ru-RU) /ViewerPreferences << /DisplayDocTitle true >> >>`);
    const d = new Date(), z = v => String(v).padStart(2, '0');
    const cdate = `D:${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`;
    putDict(info, `<< /Title ${utf16hex(meta.title)} ${meta.author ? '/Author ' + utf16hex(meta.author) + ' ' : ''}/Creator ${utf16hex('Мастерок')} /Producer ${utf16hex('Мастерок')} /CreationDate (${cdate}) >>`);

    const chunks = [], offsets = [];
    let pos = 0;
    const push = u8 => { chunks.push(u8); pos += u8.length; };
    push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x37, 0x0A, 0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));
    objs.forEach((o, i) => {
      offsets.push(pos);
      push(enc.encode(`${i + 1} 0 obj\n${o.head}\n`));
      if (o.data) { push(enc.encode('stream\n')); push(o.data); push(enc.encode('\nendstream\n')); }
      push(enc.encode('endobj\n'));
    });
    const xref = pos;
    let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach(o => { x += String(o).padStart(10, '0') + ' 00000 n \n'; });
    x += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    push(enc.encode(x));
    const out = new Uint8Array(pos);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  /* ---------- вёрстка документа ---------- */
  async function build(model) {
    const F = root.MasterokPdfFonts;
    if (!F) throw new Error('Не загружены шрифты PDF (pdf-fonts.js)');
    const sans = new Font(F.sans, 'Inter-Regular', 'AAAAAA'); sans.res = 'F1';
    const bold = new Font(F.sansBold, 'Inter-SemiBold', 'BBBBBB'); bold.res = 'F2';
    const serif = new Font(F.serifBold, 'Lora-Bold', 'CCCCCC'); serif.res = 'F3'; serif.serif = true;
    const d = new Doc([sans, bold, serif]);

    const s = v => String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();
    const m = {
      title: sans.clean(s(model.title)).replace(/\n+/g, ' ').trim(), client: s(model.client), executor: s(model.executor),
      phone: s(model.phone), address: s(model.address), deadline: s(model.deadline), paymentTerms: s(model.paymentTerms),
      description: s(model.description), date: s(model.date)
    };
    const items = (model.items || []).map(i => ({
      kind: i.kind === 'material' ? 'material' : 'work', name: s(i.name) || '\u2014', unit: s(i.unit), qty: i.qty, price: i.price, sum: i.sum,
      qtyS: fmQty(i.qty), priceS: fmMoney(i.price), sumS: fmMoney(i.sum)
    }));
    const T = model.totals || {};
    const S = { y: 0 };

    const ensure = h => { if (S.y + h > BOT) { newPage(); } };
    function newPage() {
      d.newPage();
      const idx = d.pages.length - 1;
      if (idx > 0) {                                   // колонтитул продолжения
        d.rect(0, 0, PW, HEAD_H, COL.graphite);
        d.rect(0, HEAD_H, PW, 1.2, COL.gold);
        d.text('КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ', M, 19, bold, 7.2, COL.gold, { sp: 1.2 });
        const right = m.title || m.executor;
        if (right) d.text(fit(right, sans, 8.5, CW - 190), M + CW, 19, sans, 8.5, COL.onDark, { align: 'right' });
      }
      S.y = idx === 0 ? 0 : TOP2;
    }

    /* --- титульная часть --- */
    function cover() {
      newPage();
      const q = [], T_ = (...a) => q.push(() => d.text(...a));
      let y = 34;
      if (m.title) { T_('КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ', M, y + 7, bold, 8, COL.gold, { sp: 1.8 }); y += 24; }
      const tl = wrap(m.title || 'Коммерческое предложение', serif, 26, CW);
      tl.forEach((l, i) => T_(l, M, y + 23 + i * 31, serif, 26, COL.white));
      y += tl.length * 31 + 8;
      q.push(((yy) => () => d.rect(M, yy, 38, 2.4, COL.gold))(y)); y += 18;
      if (m.date) { T_('Дата: ' + m.date, M, y + 8, sans, 9, COL.onDarkMuted); y += 20; }
      const info = [['ИСПОЛНИТЕЛЬ', m.executor], ['КЛИЕНТ', m.client], ['ТЕЛЕФОН', m.phone], ['АДРЕС ОБЪЕКТА', m.address]].filter(r => r[1]);
      if (info.length) {
        const dy = y; q.push(() => d.hline(M, M + CW, dy, COL.rule, 0.7)); y += 16;
        const gap = 28, cw = (CW - gap) / 2;
        for (let i = 0; i < info.length; i += 2) {
          const pair = info.slice(i, i + 2).map((r, k) => ({ x: M + k * (cw + gap), label: r[0], lines: wrap(r[1], sans, 10.5, cw) }));
          const rowY = y;
          pair.forEach(c => {
            T_(c.label, c.x, rowY + 7, bold, 7, COL.gold, { sp: 1.1 });
            c.lines.forEach((l, k) => T_(l, c.x, rowY + 23 + k * 14.5, sans, 10.5, COL.onDark));
          });
          y += 23 + (Math.max(...pair.map(c => c.lines.length)) - 1) * 14.5 + 16;
        }
        y -= 4;
      }
      y += 10;
      d.rect(0, 0, PW, y, COL.graphite);
      d.rect(0, y, PW, 2.2, COL.gold);
      q.forEach(f => f());
      S.y = y + 2.2 + 24;
    }

    /* --- заголовок раздела --- */
    function heading(title) {
      d.rect(M, S.y + 1, 3, 12, COL.gold);
      d.text(title, M + 11, S.y + 11, bold, 9, COL.ink, { sp: 1.4 });
      d.hline(M, M + CW, S.y + 20, COL.line, 0.6);
      S.y += 30;
    }

    /* --- описание проекта --- */
    function description() {
      const LH = 15.5, lines = wrap(m.description, sans, 10, CW - 16);
      ensure(30 + LH * Math.min(3, lines.length));
      heading('О ПРОЕКТЕ');
      for (const l of lines) {
        if (l === '') { ensure(8); d.rect(M, S.y, 2, 8, COL.gold); S.y += 8; continue; }
        if (S.y + LH > BOT) newPage();
        d.rect(M, S.y, 2, LH, COL.gold);
        d.text(l, M + 14, S.y + 11, sans, 10, COL.text);
        S.y += LH;
      }
      S.y += 24;
    }

    /* --- таблица --- */
    function table(kind, title, subtitle, list, subtotal) {
      const PAD = 7, LH = 13, PADV = 6.5, FS = 9.5, HEADH = 24, SUBH = 30;
      const wOf = (f, sz, k) => Math.max(0, ...list.map(r => f.width(r[k], sz)));
      const hdrW = t => bold.width(t, 8);
      const qtyW = Math.max(54, Math.ceil(wOf(sans, FS, 'qtyS')) + 2 * PAD, hdrW('Кол-во') + 2 * PAD);
      const prW = Math.max(66, Math.ceil(wOf(sans, FS, 'priceS')) + 2 * PAD, hdrW('Цена, \u20BD') + 2 * PAD);
      const smW = Math.max(78, Math.ceil(wOf(bold, FS, 'sumS')) + 2 * PAD, hdrW('Сумма, \u20BD') + 2 * PAD);
      const longestUnit = Math.max(0, ...list.map(r => Math.max(0, ...sans.clean(r.unit).split(/\s+/).map(w => sans.width(w, FS)))));
      const unW = Math.min(72, Math.max(44, Math.ceil(longestUnit) + 2 * PAD, hdrW('Ед. изм.') + 2 * PAD));
      const nW = 28, nameW = CW - nW - unW - qtyW - prW - smW;
      const x0 = M, xName = x0 + nW, xUnit = xName + nameW, xQty = xUnit + unW, xPr = xQty + qtyW, xSm = xPr + prW;
      const rows = list.map((r, i) => {
        const nameL = wrap(r.name, sans, FS, nameW - 2 * PAD), unitL = wrap(r.unit, sans, FS, unW - 10);
        const n = Math.max(1, nameL.length, unitL.length);
        return { r, i, nameL, unitL, n, h: Math.max(26, 2 * PADV + n * LH) };
      });
      const FRESH = BOT - TOP2 - 16 - HEADH;                // место под строки на чистой странице

      const head = () => {
        d.rect(x0, S.y, CW, HEADH, COL.graphite);
        d.rect(x0, S.y + HEADH, CW, 1.2, COL.gold);
        const by = S.y + 15.5, o = { sp: 0.2 };
        d.text('№', x0 + nW / 2, by, bold, 8, COL.onDark, { align: 'center' });
        d.text('Наименование', xName + PAD, by, bold, 8, COL.onDark, o);
        d.text('Ед. изм.', xUnit + unW / 2, by, bold, 8, COL.onDark, { align: 'center' });
        d.text('Кол-во', xQty + qtyW - PAD, by, bold, 8, COL.onDark, { align: 'right' });
        d.text('Цена, \u20BD', xPr + prW - PAD, by, bold, 8, COL.onDark, { align: 'right' });
        d.text('Сумма, \u20BD', xSm + smW - PAD, by, bold, 8, COL.onDark, { align: 'right' });
        S.y += HEADH + 1.2;
      };
      const contHead = () => {
        newPage();
        d.text((title + ' \u2014 ПРОДОЛЖЕНИЕ').toUpperCase(), M, S.y + 8, bold, 7.5, COL.muted, { sp: 1.2 });
        S.y += 16; head();
      };
      const seg = (row, from, to, first) => {
        const cnt = to - from, h = 2 * PADV + cnt * LH;
        if (row.i % 2 === 1) d.rect(x0, S.y, CW, h, COL.zebra);
        const base = S.y + PADV + 9.6;
        if (first) {
          d.text(String(row.i + 1), x0 + nW / 2, base, sans, 8.5, COL.faint, { align: 'center' });
          d.text(row.r.qtyS, xQty + qtyW - PAD, base, sans, FS, COL.text, { align: 'right' });
          d.text(row.r.priceS, xPr + prW - PAD, base, sans, FS, COL.text, { align: 'right' });
          d.text(row.r.sumS, xSm + smW - PAD, base, bold, FS, COL.ink, { align: 'right' });
          row.unitL.forEach((l, k) => d.text(l, xUnit + unW / 2, base + k * LH, sans, FS, COL.muted, { align: 'center' }));
        }
        for (let k = from; k < to; k++) if (row.nameL[k] != null) d.text(row.nameL[k], xName + PAD, base + (k - from) * LH, sans, FS, COL.ink);
        S.y += h;
        d.hline(x0, x0 + CW, S.y, COL.lineSoft, 0.6);
      };
      const subtotalRow = () => {
        d.rect(x0, S.y, CW, SUBH, COL.goldTint);
        d.hline(x0, x0 + CW, S.y, COL.gold, 0.9);
        d.text(subtitle, x0 + PAD + 3, S.y + 19.5, bold, 10, COL.ink);
        d.text(fmMoney(subtotal) + NBSP + '\u20BD', x0 + CW - PAD, S.y + 19.5, bold, 10.5, COL.ink, { align: 'right' });
        S.y += SUBH;
      };

      ensure(30 + HEADH + 2 + Math.min(rows[0].h, 60));
      heading(title.toUpperCase());
      head();
      rows.forEach((row, idx) => {
        const last = idx === rows.length - 1, extra = last ? SUBH : 0;
        if (S.y + row.h + extra <= BOT) { seg(row, 0, row.n, true); return; }
        if (row.h + extra <= FRESH) { contHead(); seg(row, 0, row.n, true); return; }
        // строка выше страницы: режем по строкам текста
        let k = 0;
        while (k < row.n) {
          let avail = Math.floor((BOT - S.y - 2 * PADV) / LH);
          if (avail < 2 && k < row.n) { contHead(); avail = Math.floor((BOT - S.y - 2 * PADV) / LH); }
          const take = Math.min(row.n - k, avail);
          seg(row, k, k + take, k === 0);
          k += take;
          if (k < row.n) contHead();
        }
      });
      if (S.y + SUBH > BOT) contHead();
      subtotalRow();
      S.y += 20;
    }

    /* --- итоги --- */
    function totals() {
      const rows = [];
      if (items.some(i => i.kind === 'work')) rows.push(['Стоимость работ', T.works]);
      if (items.some(i => i.kind === 'material')) rows.push(['Стоимость материалов', T.materials]);
      const CARD = 60, RH = 25;
      ensure(rows.length * RH + CARD + 14);
      rows.forEach(r => {
        d.text(r[0], M + 2, S.y + 17, sans, 10.5, COL.muted);
        d.text(fmMoney(r[1]) + NBSP + '\u20BD', M + CW - 2, S.y + 17, bold, 11, COL.ink, { align: 'right' });
        S.y += RH; d.hline(M, M + CW, S.y, COL.lineSoft, 0.6);
      });
      S.y += 12;
      d.rect(M, S.y, CW, CARD, COL.graphite);
      d.rect(M, S.y, 4, CARD, COL.gold);
      d.text('ИТОГОВАЯ СУММА', M + 24, S.y + 35, bold, 8.5, COL.gold, { sp: 1.6 });
      d.text(fmMoney(T.total) + NBSP + '\u20BD', M + CW - 22, S.y + 39, serif, 25, COL.goldHi, { align: 'right' });
      S.y += CARD + 16;
    }

    /* --- сроки и условия --- */
    function terms() {
      const list = [['СРОКИ ВЫПОЛНЕНИЯ', m.deadline], ['УСЛОВИЯ ОПЛАТЫ', m.paymentTerms]].filter(r => r[1]);
      if (!list.length) return;
      const LH = 14.5, PADX = 18, PADY = 12, GAP = 26, inner = CW - 2 * PADX - 4;
      const colW = list.length === 2 ? (inner - GAP) / 2 : inner;
      const blocks = list.map((r, k) => ({ label: r[0], x: M + PADX + 4 + k * (colW + GAP), lines: wrap(r[1], sans, 10, colW) }));
      const h = 2 * PADY + 17 + Math.max(...blocks.map(b => b.lines.length)) * LH;
      ensure(30 + h);
      heading('СРОКИ И УСЛОВИЯ');
      d.rect(M, S.y, CW, h, COL.zebra);
      d.rect(M, S.y, 3, h, COL.gold);
      blocks.forEach(b => {
        d.text(b.label, b.x, S.y + PADY + 7, bold, 7, COL.goldDeep, { sp: 1.1 });
        b.lines.forEach((l, k) => d.text(l, b.x, S.y + PADY + 24 + k * LH, sans, 10, COL.text));
      });
      S.y += h + 20;
    }

    /* --- сборка --- */
    cover();
    if (m.description) description();
    const works = items.filter(i => i.kind === 'work'), mats = items.filter(i => i.kind === 'material');
    if (works.length) table('work', 'Работы', 'Итого по работам', works, T.works);
    if (mats.length) table('material', 'Материалы', 'Итого по материалам', mats, T.materials);
    totals();
    terms();

    /* нижние колонтитулы — когда известно число страниц */
    const total = d.pages.length, left = [m.executor, m.phone].filter(Boolean).join('  \u00B7  ') || m.title;
    d.pages.forEach((p, i) => {
      d.cur = p;
      d.hline(M, M + CW, PH - 42, COL.line, 0.6);
      if (left) d.text(fit(left, sans, 8, CW - 130), M, PH - 28, sans, 8, COL.faint);
      d.text('Страница ' + (i + 1) + ' из ' + total, M + CW, PH - 28, sans, 8, COL.faint, { align: 'right' });
    });

    return serialize(d, { title: m.title || 'Коммерческое предложение', author: m.executor });
  }

  const api = { build, _wrap: wrap, _Font: Font };
  root.MasterokPdf = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
