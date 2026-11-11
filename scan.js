/* VarOrga Scan : traitement d'image (OpenCV.js)
 * - detecterDocument : trouve les 4 coins de la feuille
 * - traiterPage      : redresse la perspective, applique le filtre, tourne
 */
'use strict';

const Scan = (() => {
  let pret = null;

  /* Chargement d'OpenCV (10 Mo, mis en cache par le service worker) */
  function chargerOpenCV() {
    if (pret) return pret;
    pret = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'lib/opencv.js';
      s.async = true;
      s.onerror = () => reject(new Error('OpenCV introuvable'));
      s.onload = () => {
        const fin = Date.now() + 60000;
        const attendre = () => {
          const c = window.cv;
          if (c && typeof c.then === 'function' && !c.Mat) {
            // Certaines versions renvoient une promesse : on récupère le module
            c.then(m => { try { delete m.then; } catch (e) {} window.cv = m; });
          }
          if (window.cv && window.cv.Mat && window.cv.getPerspectiveTransform) return resolve(window.cv);
          if (Date.now() > fin) return reject(new Error('OpenCV ne démarre pas'));
          setTimeout(attendre, 60);
        };
        attendre();
      };
      document.head.appendChild(s);
    });
    return pret;
  }

  const supprimer = (...mats) => mats.forEach(m => { try { m && m.delete && m.delete(); } catch (e) {} });

  /* Range 4 points : haut-gauche, haut-droite, bas-droite, bas-gauche */
  function ordonner(pts) {
    const parSomme = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const tl = parSomme[0], br = parSomme[3];
    const reste = [parSomme[1], parSomme[2]].sort((a, b) => (a.y - a.x) - (b.y - b.x));
    return [tl, reste[0], br, reste[1]];
  }

  function aire(q) {
    let s = 0;
    for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; s += a.x * b.y - b.x * a.y; }
    return Math.abs(s) / 2;
  }

  function estConvexe(q) {
    let signe = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(z) < 1e-6) return false;
      const sg = Math.sign(z);
      if (signe === 0) signe = sg; else if (sg !== signe) return false;
    }
    return true;
  }

  /* Angles du quadrilatère : rejette les formes trop tordues */
  function anglesCorrects(q) {
    for (let i = 0; i < 4; i++) {
      const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
      const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
      const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y));
      const ang = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
      if (ang < 45 || ang > 135) return false;
    }
    return true;
  }

  /* Un vrai bord de feuille sépare le papier du fond : on compare la luminosité juste à
   l'intérieur et juste à l'extérieur de chaque côté. Un cadre imprimé sur la feuille
   (case, tableau) a du papier des deux côtés : il est rejeté. */
function contrasteBords(gris, q, W, H) {
  const d = Math.max(4, 0.012 * Math.max(W, H));
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const val = (x, y) => gris.data[Math.round(y) * W + Math.round(x)];
  const dedans = (x, y) => x >= 0 && y >= 0 && x <= W - 1 && y <= H - 1;
  let bonsCotes = 0, cotesReels = 0, total = 0, plusClair = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let nx = -(b.y - a.y) / L, ny = (b.x - a.x) / L;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; } // normale vers l'extérieur
    const diffs = []; let horsImage = 0, n = 0;
    for (let t = 0.1; t <= 0.9001; t += 0.05) {
      n++;
      const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
      const ix = px - nx * d, iy = py - ny * d, ox = px + nx * d, oy = py + ny * d;
      if (!dedans(ox, oy) || !dedans(ix, iy)) { horsImage++; continue; }
      diffs.push(val(ix, iy) - val(ox, oy));
    }
    const abs = diffs.map(Math.abs).sort((u, v) => u - v);
    const med = abs.length ? abs[Math.floor(abs.length / 2)] : 0;
    const signe = diffs.reduce((s, v) => s + v, 0);
    if (horsImage > n / 2) { bonsCotes++; continue; }      // côté collé au bord de la photo
    if (med >= 9) { bonsCotes++; cotesReels++; total += med; plusClair += signe > 0 ? 1 : -1; }
  }
  return { ok: bonsCotes === 4 && cotesReels >= 2, force: cotesReels ? total / cotesReels : 0, plusClair: plusClair > 0 };
}

function quadsDepuisContours(contours, W, H, candidats, source, gris) {
    const imgAire = W * H;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const a = cv.contourArea(c);
      if (a < imgAire * 0.06) { c.delete(); continue; }
      const hull = new cv.Mat();
      cv.convexHull(c, hull, false, true);
      const peri = cv.arcLength(hull, true);
      let trouve = null;
      for (const eps of [0.015, 0.02, 0.03, 0.045, 0.06]) {
        const approx = new cv.Mat();
        cv.approxPolyDP(hull, approx, eps * peri, true);
        if (approx.rows === 4) {
          const p = [];
          for (let k = 0; k < 4; k++) p.push({ x: approx.data32S[k * 2], y: approx.data32S[k * 2 + 1] });
          trouve = ordonner(p);
        }
        approx.delete();
        if (trouve) break;
      }
      if (!trouve && a > imgAire * 0.08) {
        // Repli : rectangle de surface minimale autour de la forme
        const r = cv.minAreaRect(hull);
        const pts = cv.RotatedRect.points(r);
        trouve = ordonner(pts.map(p => ({ x: p.x, y: p.y })));
        trouve.approx = true;
      }
      if (trouve) {
        const approxRect = !!trouve.approx;
        trouve = trouve.map(p => ({ x: Math.max(0, Math.min(W - 1, p.x)), y: Math.max(0, Math.min(H - 1, p.y)) }));
        trouve.approx = approxRect;
      }
      const cb = trouve && estConvexe(trouve) && anglesCorrects(trouve) ? contrasteBords(gris, trouve, W, H) : null;
      // Une forme plus sombre que ce qui l'entoure (bandeau, logo, carte foncée) n'est retenue que si elle est grande
      if (cb && cb.ok && (cb.plusClair || aire(trouve) > imgAire * 0.2)) {
        const aq = aire(trouve);
        const bordure = trouve.every(p => p.x < 3 || p.y < 3 || p.x > W - 4 || p.y > H - 4);
        if (aq < imgAire * 0.97 && !bordure) {
          // Score : grande surface, forme bien remplie, petit bonus pour un vrai quadrilatère
          const remplissage = Math.min(1, a / aq);
          candidats.push({ q: trouve, score: aq * (0.6 + 0.4 * remplissage) * (trouve.approx ? 0.85 : 1), source });
        }
      }
      hull.delete(); c.delete();
    }
  }

  function medianeGris(gray) {
    const h = new Array(256).fill(0);
    const d = gray.data;
    for (let i = 0; i < d.length; i += 7) h[d[i]]++;
    const total = h.reduce((s, v) => s + v, 0);
    let cum = 0;
    for (let i = 0; i < 256; i++) { cum += h[i]; if (cum >= total / 2) return i; }
    return 128;
  }

  /* Détection de la feuille sur une image (canvas). Renvoie 4 points en coordonnées du canvas. */
  function detecterDocument(canvas) {
    const W0 = canvas.width, H0 = canvas.height;
    const echelle = Math.min(1, 900 / Math.max(W0, H0));
    const src = cv.imread(canvas);
    const petit = new cv.Mat();
    cv.resize(src, petit, new cv.Size(Math.round(W0 * echelle), Math.round(H0 * echelle)), 0, 0, cv.INTER_AREA);
    src.delete();
    const W = petit.cols, H = petit.rows;
    const gray = new cv.Mat();
    cv.cvtColor(petit, gray, cv.COLOR_RGBA2GRAY);
    const candidats = [];
    const grisLisse = new cv.Mat();
    cv.GaussianBlur(gray, grisLisse, new cv.Size(5, 5), 0);

    // Stratégie 1 : on efface le texte (fermeture morphologique) puis contours de Canny
    try {
      const ferme = new cv.Mat(), flou = new cv.Mat(), bords = new cv.Mat();
      const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
      cv.morphologyEx(gray, ferme, cv.MORPH_CLOSE, k, new cv.Point(-1, -1), 3);
      cv.GaussianBlur(ferme, flou, new cv.Size(5, 5), 0);
      const m = medianeGris(flou);
      cv.Canny(flou, bords, Math.max(10, 0.5 * m), Math.min(255, 1.2 * m + 20));
      const k2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      cv.dilate(bords, bords, k2, new cv.Point(-1, -1), 2);
      const contours = new cv.MatVector(), hier = new cv.Mat();
      cv.findContours(bords, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      quadsDepuisContours(contours, W, H, candidats, 'canny-ferme', grisLisse);
      supprimer(ferme, flou, bords, k, k2, contours, hier);
    } catch (e) { console.warn(e); }

    // Stratégie 2 : Canny direct (fond texturé, feuille peu contrastée)
    try {
      const flou = new cv.Mat(), bords = new cv.Mat();
      cv.GaussianBlur(gray, flou, new cv.Size(5, 5), 0);
      cv.Canny(flou, bords, 30, 90);
      const k2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
      cv.morphologyEx(bords, bords, cv.MORPH_CLOSE, k2);
      const contours = new cv.MatVector(), hier = new cv.Mat();
      cv.findContours(bords, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      quadsDepuisContours(contours, W, H, candidats, 'canny', grisLisse);
      supprimer(flou, bords, k2, contours, hier);
    } catch (e) { console.warn(e); }

    // Stratégie 3 : seuillage (feuille claire sur fond plus sombre) sur gris et sur saturation
    try {
      const hsv = new cv.Mat(), rgb = new cv.Mat();
      cv.cvtColor(petit, rgb, cv.COLOR_RGBA2RGB);
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      const canaux = new cv.MatVector();
      cv.split(hsv, canaux);
      const sat = canaux.get(1);
      const sources = [[gray, false, 'otsu-gris'], [sat, true, 'otsu-sat']];
      for (const [canal, inverse, nom] of sources) {
        const flou = new cv.Mat(), bin = new cv.Mat();
        cv.GaussianBlur(canal, flou, new cv.Size(7, 7), 0);
        cv.threshold(flou, bin, 0, 255, (inverse ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY) + cv.THRESH_OTSU);
        const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
        cv.morphologyEx(bin, bin, cv.MORPH_OPEN, k);
        cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k, new cv.Point(-1, -1), 2);
        const contours = new cv.MatVector(), hier = new cv.Mat();
        cv.findContours(bin, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        quadsDepuisContours(contours, W, H, candidats, nom, grisLisse);
        supprimer(flou, bin, k, contours, hier);
      }
      supprimer(sat, canaux, hsv, rgb);
    } catch (e) { console.warn(e); }

    supprimer(gray, petit, grisLisse);

    let meilleur = null;
    for (const c of candidats) if (!meilleur || c.score > meilleur.score) meilleur = c;
    if (!meilleur) return { points: [{ x: 0, y: 0 }, { x: W0, y: 0 }, { x: W0, y: H0 }, { x: 0, y: H0 }], trouve: false };
    const pts = meilleur.q.map(p => ({ x: p.x / echelle, y: p.y / echelle }));
    return { points: pts, trouve: true, source: meilleur.source };
  }

  function coinsParDefaut(W, H) {
    const mx = W * 0.06, my = H * 0.06;
    return [{ x: mx, y: my }, { x: W - mx, y: my }, { x: W - mx, y: H - my }, { x: mx, y: H - my }];
  }

  /* Rapport largeur/hauteur réel de la feuille, en tenant compte de la perspective
   * (méthode de Zhang & He, « Whiteboard scanning », 2007). Repli sur les longueurs des côtés. */
  function rapportReel(q, W, H) {
    const [tl, tr, br, bl] = q;
    const largeur = (Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y)) / 2;
    const hauteur = (Math.hypot(bl.x - tl.x, bl.y - tl.y) + Math.hypot(br.x - tr.x, br.y - tr.y)) / 2;
    const simple = largeur / hauteur;
    try {
      const u0 = W / 2, v0 = H / 2;
      const m = p => [p.x - u0, p.y - v0, 1];
      const m1 = m(tl), m2 = m(tr), m3 = m(bl), m4 = m(br);
      const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
      const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
      const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
      const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
      if (Math.abs(n2[2]) < 1e-6 || Math.abs(n3[2]) < 1e-6) return simple;
      const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
      const focaleOk = f2 > 0 && Math.sqrt(f2) > 0.3 * Math.max(W, H) && Math.sqrt(f2) < 6 * Math.max(W, H);
      if (!focaleOk) return simple;
      const r = Math.sqrt((n2[0] ** 2 + n2[1] ** 2) / f2 + n2[2] ** 2) / Math.sqrt((n3[0] ** 2 + n3[1] ** 2) / f2 + n3[2] ** 2);
      if (!isFinite(r) || r <= 0 || r / simple > 1.6 || simple / r > 1.6) return simple;
      return r;
    } catch (e) { return simple; }
  }

  /* Recale sur un format connu si on en est proche (A4, A5, carte bancaire / de visite) */
  const FORMATS = [Math.SQRT2, 85.6 / 53.98, 85 / 55, 1];
  function caler(r) {
    const paysage = r > 1, v = paysage ? r : 1 / r;
    for (const f of FORMATS) if (Math.abs(v - f) / f < 0.045) return paysage ? f : 1 / f;
    return r;
  }

  function ajusterGamma(mat, alpha, beta) {
    mat.convertTo(mat, -1, alpha, beta);
  }

  /* Enlève les ombres et uniformise le fond : on estime le fond (texte effacé) puis on divise */
  function blanchirCanal(canal) {
    const W = canal.cols, H = canal.rows;
    const e = Math.min(1, 700 / Math.max(W, H));
    const petit = new cv.Mat(), fond = new cv.Mat(), fondG = new cv.Mat();
    cv.resize(canal, petit, new cv.Size(Math.max(1, Math.round(W * e)), Math.max(1, Math.round(H * e))), 0, 0, cv.INTER_AREA);
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
    cv.dilate(petit, fond, k, new cv.Point(-1, -1), 1);
    cv.medianBlur(fond, fond, 21);
    cv.resize(fond, fondG, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
    // resultat = canal / fond * 255
    const out = new cv.Mat();
    cv.divide(canal, fondG, out, 255, -1);
    supprimer(petit, fond, fondG, k);
    return out;
  }

  function nettete(mat, force) {
    const flou = new cv.Mat();
    cv.GaussianBlur(mat, flou, new cv.Size(0, 0), 1.6);
    cv.addWeighted(mat, 1 + force, flou, -force, 0, mat);
    flou.delete();
  }

  /* Étirement des niveaux : 1 % le plus sombre -> noir, fond -> blanc */
  function etirer(gray, basPct, hautPct) {
    const h = new Array(256).fill(0), d = gray.data;
    for (let i = 0; i < d.length; i += 3) h[d[i]]++;
    const total = h.reduce((s, v) => s + v, 0);
    let cum = 0, lo = 0, hi = 255;
    for (let i = 0; i < 256; i++) { cum += h[i]; if (cum >= total * basPct) { lo = i; break; } }
    cum = 0;
    for (let i = 255; i >= 0; i--) { cum += h[i]; if (cum >= total * hautPct) { hi = i; break; } }
    if (hi - lo < 30) return { a: 1, b: 0 };
    const a = 255 / (hi - lo);
    return { a, b: -lo * a };
  }

  function filtrer(rgb, filtre) {
    // rgb : Mat CV_8UC3. Renvoie un nouveau Mat (RGB ou GRAY)
    if (filtre === 'original') return rgb.clone();

    if (filtre === 'couleur') {
      const lab = new cv.Mat(), out = new cv.Mat();
      cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
      const canaux = new cv.MatVector();
      cv.split(lab, canaux);
      const L = canaux.get(0);
      try {
        const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
        clahe.apply(L, L);
        clahe.delete();
      } catch (e) { cv.equalizeHist(L, L); }
      canaux.set(0, L);
      cv.merge(canaux, lab);
      cv.cvtColor(lab, out, cv.COLOR_Lab2RGB);
      nettete(out, 0.5);
      supprimer(L, canaux, lab);
      return out;
    }

    if (filtre === 'magique') {
      // Couleur, fond blanc, sans ombre
      const canaux = new cv.MatVector();
      cv.split(rgb, canaux);
      const res = new cv.MatVector();
      const gris = new cv.Mat();
      cv.cvtColor(rgb, gris, cv.COLOR_RGB2GRAY);
      const g = blanchirCanal(gris);
      const { a, b } = etirer(g, 0.01, 0.0);
      for (let i = 0; i < 3; i++) {
        const c = canaux.get(i);
        const bl = blanchirCanal(c);
        ajusterGamma(bl, a, b);
        res.push_back(bl);
        bl.delete(); c.delete();
      }
      const out = new cv.Mat();
      cv.merge(res, out);
      nettete(out, 0.6);
      supprimer(canaux, res, gris, g);
      return out;
    }

    const gris = new cv.Mat();
    cv.cvtColor(rgb, gris, cv.COLOR_RGB2GRAY);
    const blanc = blanchirCanal(gris);
    gris.delete();

    if (filtre === 'gris') {
      const { a, b } = etirer(blanc, 0.01, 0.0);
      ajusterGamma(blanc, a, b);
      nettete(blanc, 0.6);
      return blanc;
    }

    // 'nb' : noir et blanc net (texte)
    const bin = new cv.Mat();
    let bloc = Math.round(Math.max(blanc.cols, blanc.rows) / 60) | 1;
    bloc = Math.max(15, Math.min(bloc, 61));
    if (bloc % 2 === 0) bloc++;
    cv.adaptiveThreshold(blanc, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, bloc, 14);
    // Ce qui est franchement sombre reste noir (aplats, logos)
    const sombre = new cv.Mat();
    cv.threshold(blanc, sombre, 110, 255, cv.THRESH_BINARY);
    cv.bitwise_and(bin, sombre, bin);
    cv.medianBlur(bin, bin, 3);
    supprimer(blanc, sombre);
    return bin;
  }

  /* Redresse + filtre + rotation. canvas : photo d'origine. points : 4 coins (tl,tr,br,bl).
   * Renvoie un canvas. */
  function traiterPage(canvas, points, filtre, rotation, maxCote = 2480) {
    const W = canvas.width, H = canvas.height;
    const q = ordonner(points);
    let r = caler(rapportReel(q, W, H));
    const [tl, tr, br, bl] = q;
    const largeurPx = Math.max(Math.hypot(tr.x - tl.x, tr.y - tl.y), Math.hypot(br.x - bl.x, br.y - bl.y));
    const hauteurPx = Math.max(Math.hypot(bl.x - tl.x, bl.y - tl.y), Math.hypot(br.x - tr.x, br.y - tr.y));
    // On garde la plus grande dimension mesurée, l'autre suit le rapport réel
    let w, h;
    if (largeurPx / r >= hauteurPx) { w = largeurPx; h = largeurPx / r; } else { h = hauteurPx; w = hauteurPx * r; }
    const e = Math.min(1.25, maxCote / Math.max(w, h));
    w = Math.max(20, Math.round(w * e)); h = Math.max(20, Math.round(h * e));

    const src = cv.imread(canvas);
    const rgb = new cv.Mat();
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    src.delete();
    const de = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
    const vers = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
    const M = cv.getPerspectiveTransform(de, vers);
    const plat = new cv.Mat();
    cv.warpPerspective(rgb, plat, M, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    supprimer(rgb, de, vers, M);

    // On rogne un fin liseré pour ne pas garder un reste du fond sur les bords
    const m = Math.round(Math.min(w, h) * 0.006);
    let rogne = plat;
    if (m > 0 && w > 4 * m && h > 4 * m) rogne = plat.roi(new cv.Rect(m, m, w - 2 * m, h - 2 * m));
    let res = filtrer(rogne, filtre);
    if (rogne !== plat) rogne.delete();
    plat.delete();

    const rot = ((rotation % 360) + 360) % 360;
    if (rot) {
      const t = new cv.Mat();
      cv.rotate(res, t, rot === 90 ? cv.ROTATE_90_CLOCKWISE : rot === 180 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE);
      res.delete(); res = t;
    }
    const out = document.createElement('canvas');
    cv.imshow(out, res);
    res.delete();
    return out;
  }

  return { chargerOpenCV, detecterDocument, traiterPage, coinsParDefaut, ordonner, _rapportReel: rapportReel };
})();
