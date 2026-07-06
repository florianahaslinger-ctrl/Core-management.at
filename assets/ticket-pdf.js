/* =========================================================
   CORE Management Ticketshop – PDF-Tickets (ticket-pdf.js)
   Erzeugt ohne externe Bibliotheken ein PDF (eine Seite pro
   Ticket) mit QR-Code und klassischem Ticketcode.
   Benötigt assets/qrcode.js (globale Funktion `qrcode`).
   ========================================================= */
(function (global) {
  'use strict';

  /* --- QR-Code als Canvas rendern (gemeinsam mit Shop nutzbar) --- */
  function qrCanvas(text, sizePx) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 2; // Ruhezone in Modulen
    const scale = Math.max(2, Math.floor(sizePx / (n + 2 * quiet)));
    const size = (n + 2 * quiet) * scale;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
        }
      }
    }
    return cv;
  }

  /* --- PDF-Grundbausteine --- */

  // Typografische Zeichen, die in WinAnsi eigene Codes haben
  const WINANSI = {
    '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92,
    '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99
  };

  // Text in WinAnsi/Latin-1 kodieren und für PDF-Strings escapen
  function pdfText(s) {
    let out = '';
    for (const ch of String(s)) {
      let code = WINANSI[ch] || ch.codePointAt(0);
      if (code > 255) code = 63; // '?'
      if (code === 40 || code === 41 || code === 92) out += '\\' + ch;
      else if (code < 32 || code > 126) out += '\\' + code.toString(8).padStart(3, '0');
      else out += ch;
    }
    return out;
  }

  function dataURLtoBytes(dataURL) {
    const b64 = dataURL.split(',')[1];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  const latin1 = s => {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
  };

  /* Baut das PDF aus Objekten zusammen (Chunks: String oder Uint8Array) */
  function buildPDF(objects) {
    const chunks = [];
    const offsets = [0];
    let pos = 0;
    const push = c => {
      const b = typeof c === 'string' ? latin1(c) : c;
      chunks.push(b); pos += b.length;
    };
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    objects.forEach((obj, i) => {
      offsets[i + 1] = pos;
      push((i + 1) + ' 0 obj\n');
      obj.forEach(push);
      push('\nendobj\n');
    });
    const xrefPos = pos;
    let xref = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
    for (let i = 1; i <= objects.length; i++) {
      xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    }
    push(xref);
    push('trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF');
    const total = new Uint8Array(pos);
    let o = 0;
    chunks.forEach(c => { total.set(c, o); o += c.length; });
    return total;
  }

  /* --- Layout einer Ticketseite (A4: 595 x 842 pt) --- */

  const GOLD = '0.788 0.659 0.298'; // #C9A84C
  const DARK = '0.045 0.045 0.045';
  const GRAY = '0.45 0.45 0.45';

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('de-AT', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
  }

  function pageContent(t, order, imgName, idx, count) {
    const eur = new Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' });
    const line = (x, y, font, size, color, text) =>
      color + ' rg\nBT /' + font + ' ' + size + ' Tf ' + x + ' ' + y + ' Td (' + pdfText(text) + ') Tj ET\n';

    let s = '';
    // Kopfleiste
    s += DARK + ' rg\n0 762 595 80 re f\n';
    s += line(60, 800, 'F1', 22, GOLD, 'CORE MANAGEMENT');
    s += line(60, 778, 'F2', 10, '0.7 0.7 0.7', 'Events & Entertainment Austria');
    s += line(455, 792, 'F1', 20, GOLD, 'TICKET');

    // Eventblock
    s += line(60, 700, 'F1', 21, '0 0 0', t.eventName);
    s += line(60, 674, 'F2', 12, GRAY, fmtDate(t.eventDate) + (t.eventLocation ? '  ·  ' + t.eventLocation : ''));

    // Kategorie & Preis
    s += GOLD + ' rg\n60 640 200 26 re f\n';
    s += line(70, 648, 'F1', 13, '0.08 0.06 0.02', t.categoryName);
    s += line(280, 648, 'F1', 13, '0 0 0', eur.format(t.price));

    // Bestelldaten
    s += line(60, 600, 'F2', 10, GRAY, 'Bestellung: ' + order.id + '   ·   ' + order.email);
    s += line(60, 584, 'F2', 10, GRAY, 'Bestellt am: ' + new Date(order.createdAt).toLocaleString('de-AT') +
      '   ·   Ticket ' + idx + ' von ' + count);
    s += line(60, 568, 'F2', 10, '0.18 0.5 0.25', 'Status: BEZAHLT');

    // QR-Code (rechts) mit Rahmen
    s += '0.85 0.85 0.85 RG 1 w\n351 331 198 198 re S\n';
    s += 'q 190 0 0 190 355 335 cm /' + imgName + ' Do Q\n';

    // Klassischer Ticketcode (altes System) – groß, links neben dem QR
    s += line(60, 480, 'F2', 10, GRAY, 'Ticketcode (manuelle Eingabe):');
    s += line(60, 448, 'F1', 26, '0 0 0', t.code);
    s += line(60, 400, 'F2', 9, GRAY, 'Beim Einlass QR-Code scannen lassen oder den');
    s += line(60, 387, 'F2', 9, GRAY, 'Ticketcode oben vorzeigen. Beide Codes sind gleichwertig.');

    // Trennlinie + Hinweise
    s += GOLD + ' RG 1.2 w\n60 300 m 535 300 l S\n';
    s += line(60, 278, 'F1', 10, '0 0 0', 'Wichtige Hinweise');
    const hints = [
      'Dieses Ticket ist nur einmal gültig und wird beim Einlass entwertet.',
      'Der Zutritt ist nur mit gültigem Ticket (QR-Code oder Ticketcode) möglich.',
      'Weitergabe nur inklusive dieses Dokuments; Kopien werden beim Einlass ungültig.',
      'Veranstalter: CORE Management · core-management.at'
    ];
    hints.forEach((h, i) => { s += line(60, 260 - i * 15, 'F2', 9, GRAY, '·  ' + h); });

    return s;
  }

  /* --- Öffentliche API --- */

  function makePDF(order, tickets) {
    const objects = [];
    const pageRefs = [];
    // Objekt 1: Catalog, 2: Pages, 3: F1, 4: F2, danach pro Ticket: Bild, Inhalt, Seite
    const FIRST_DYNAMIC = 5;
    tickets.forEach((t, i) => {
      const imgObj = FIRST_DYNAMIC + i * 3;
      const contentObj = imgObj + 1;
      const pageObj = imgObj + 2;
      pageRefs.push(pageObj + ' 0 R');
    });

    objects.push(['<< /Type /Catalog /Pages 2 0 R >>']);
    objects.push(['<< /Type /Pages /Kids [' + pageRefs.join(' ') + '] /Count ' + tickets.length + ' >>']);
    objects.push(['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>']);
    objects.push(['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);

    tickets.forEach((t, i) => {
      const imgObj = FIRST_DYNAMIC + i * 3;
      const cv = qrCanvas(t.code, 400);
      const jpg = dataURLtoBytes(cv.toDataURL('image/jpeg', 0.92));
      objects.push([
        '<< /Type /XObject /Subtype /Image /Width ' + cv.width + ' /Height ' + cv.height +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpg.length + ' >>\nstream\n',
        jpg,
        '\nendstream'
      ]);
      const content = pageContent(t, order, 'Im' + i, i + 1, tickets.length);
      objects.push([
        '<< /Length ' + latin1(content).length + ' >>\nstream\n' + content + '\nendstream'
      ]);
      objects.push([
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
        '/Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << /Im' + i + ' ' + imgObj + ' 0 R >> >> ' +
        '/Contents ' + (imgObj + 1) + ' 0 R >>'
      ]);
    });

    return buildPDF(objects);
  }

  function download(order, tickets) {
    tickets = tickets || order.tickets;
    const bytes = makePDF(order, tickets);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tickets-' + order.id + '.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  global.CMTicketPDF = { download, makePDF, qrCanvas };
})(window);
