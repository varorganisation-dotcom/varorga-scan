/* VarOrga Scan : interface */
'use strict';

const VERSION = '1.0 du 11/11/2026';
const CATEGORIES = ['Sans catégorie', 'Factures', 'Contrats', 'Administratif', 'Banque', 'Santé', 'Courrier', 'David Perso'];
const MAX_PHOTO = 3200;             // côté max de la photo conservée
const QUALITE = { normale: { cote: 2000, jpeg: 0.8 }, haute: { cote: 2600, jpeg: 0.9 } };

const $ = s => document.querySelector(s);
const attendreRendu = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)));

/* ---------- Réglages (localStorage, protégé) ---------- */
function lireReglage(cle, defaut) {
  try { const v = localStorage.getItem('vos.' + cle); return v === null ? defaut : v; } catch (e) { return defaut; }
}
function ecrireReglage(cle, v) { try { localStorage.setItem('vos.' + cle, v); } catch (e) {} }
const config = () => ({ url: lireReglage('url', ''), cle: lireReglage('cle', '') });

/* ---------- Petits outils d'affichage ---------- */
let minuteurToast;
function toast(txt, ms = 3200) {
  const t = $('#toast'); t.textContent = txt; t.hidden = false;
  clearTimeout(minuteurToast); minuteurToast = setTimeout(() => { t.hidden = true; }, ms);
}
function attente(txt) { $('#attente-texte').textContent = txt || 'Un instant…'; $('#attente').hidden = false; }
function finAttente() { $('#attente').hidden = true; }
const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const aujourdhui = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
function nomFichier(nom) {
  const propre = (nom || '').replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Scan ' + new Date().toTimeString().slice(0, 5).replace(':', 'h');
  return aujourdhui() + ' - ' + propre + '.pdf';
}
const canvasVersBlob = (c, type = 'image/jpeg', q = 0.9) => new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('Image vide')), type, q));
const blobVersDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });

async function blobVersCanvas(blob, max = MAX_PHOTO) {
  let src, w, h;
  try {
    src = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    w = src.width; h = src.height;
  } catch (e) {
    src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Photo illisible')); i.src = URL.createObjectURL(blob); });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  const e = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * e); c.height = Math.round(h * e);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  if (src.close) src.close();
  return c;
}

/* ---------- Navigation (avec le bouton retour d'Android) ---------- */
let ecranCourant = 'accueil';
function afficher(nom) {
  if (nom !== ecranCourant) $('#toast').hidden = true;
  document.querySelectorAll('.ecran').forEach(e => e.classList.toggle('actif', e.id === 'ecran-' + nom));
  ecranCourant = nom;
  if (nom === 'accueil') {
    if (history.state && history.state.vos) history.back();
    rafraichirAccueil();
  } else if (!(history.state && history.state.vos)) {
    history.pushState({ vos: 1 }, '');
  }
  if (nom === 'recadrage') requestAnimationFrame(() => Rec.mettreEnPage());
}
window.addEventListener('popstate', () => {
  if (!$('#feuille').hidden) { $('#feuille').hidden = true; history.pushState({ vos: 1 }, ''); return; }
  switch (ecranCourant) {
    case 'accueil': return;
    case 'recadrage': annulerEdition(); return;
    case 'filtre': afficher('recadrage'); return;
    case 'enregistrer': afficher('document'); return;
    default: afficher('accueil');
  }
});

/* ---------- Document en cours ---------- */
let brouillon = { pages: [], nom: '', categorie: 'Sans catégorie' };
async function chargerBrouillon() {
  try { const b = await Store.get('etat', 'brouillon'); if (b && Array.isArray(b.pages)) brouillon = b; } catch (e) {}
}
async function sauverBrouillon() { try { await Store.put('etat', brouillon, 'brouillon'); } catch (e) { console.warn(e); } }
async function viderBrouillon() {
  for (const pid of brouillon.pages) { try { await Store.del('pages', pid); } catch (e) {} }
  brouillon = { pages: [], nom: '', categorie: brouillon.categorie || 'Sans catégorie' };
  await sauverBrouillon();
}

/* ---------- Prise de photo ---------- */
function choisirPhotos({ camera, multiple }) {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    if (camera) inp.setAttribute('capture', 'environment');
    if (multiple) inp.multiple = true;
    inp.style.display = 'none';
    inp.addEventListener('change', () => { resolve([...(inp.files || [])]); inp.remove(); });
    document.body.appendChild(inp);
    inp.click();
  });
}

let ed = null; // page en cours de modification

async function nouvellePhoto(remplacer = null) {
  const fichiers = await choisirPhotos({ camera: true, multiple: false });
  if (!fichiers.length) return;
  await ouvrirPhoto(fichiers[0], remplacer);
}

async function ouvrirPhoto(fichier, remplacer) {
  attente('Préparation de la photo…');
  try {
    const canvas = await blobVersCanvas(fichier);
    const original = await canvasVersBlob(canvas, 'image/jpeg', 0.92);
    const pid = remplacer ? remplacer.pageId : id();
    // On garde la photo tout de suite : si Android recharge l'appli, rien n'est perdu
    const ancienne = remplacer ? await Store.get('pages', pid) : null;
    await Store.put('pages', { ...(ancienne || {}), id: pid, original, points: null, filtre: lireReglage('filtre', 'magique'), rotation: 0, resultat: ancienne ? ancienne.resultat : null });
    ed = { pageId: pid, nouvelle: remplacer ? remplacer.nouvelle : true, canvas, points: null, filtre: remplacer ? remplacer.filtre : lireReglage('filtre', 'magique'), rotation: 0 };
    await sauverEdition();
    attente('Détection des bords…');
    await Scan.chargerOpenCV();
    const d = Scan.detecterDocument(canvas);
    ed.points = d.points;
    ed.detecte = d.trouve;
    finAttente();
    afficher('recadrage');
    infoRecadrage(d.trouve ? 'Bords détectés. Ajuste les coins si besoin.' : 'Bords non trouvés : place les coins à la main.');
  } catch (e) {
    finAttente(); console.error(e);
    toast('Impossible de lire la photo : ' + e.message);
  }
}

async function sauverEdition() {
  try { await Store.put('etat', ed ? { pageId: ed.pageId, nouvelle: ed.nouvelle, filtre: ed.filtre, rotation: ed.rotation } : null, 'edition'); } catch (e) {}
}

async function annulerEdition() {
  if (ed && ed.nouvelle) { try { await Store.del('pages', ed.pageId); } catch (e) {} }
  ed = null; await sauverEdition();
  afficher(brouillon.pages.length ? 'document' : 'accueil');
  if (brouillon.pages.length) rafraichirDocument();
}

async function modifierPage(pid) {
  const p = await Store.get('pages', pid);
  if (!p) return;
  attente('Ouverture de la page…');
  try {
    const canvas = await blobVersCanvas(p.original);
    await Scan.chargerOpenCV();
    ed = { pageId: pid, nouvelle: false, canvas, points: p.points || Scan.detecterDocument(canvas).points, filtre: p.filtre, rotation: p.rotation || 0 };
    await sauverEdition();
    finAttente();
    afficher('recadrage');
  } catch (e) { finAttente(); toast('Erreur : ' + e.message); }
}

/* ---------- Écran de recadrage ---------- */
let minuteurInfo;
function infoRecadrage(txt) {
  const b = $('#rec-info'); b.textContent = txt; b.hidden = false;
  clearTimeout(minuteurInfo); minuteurInfo = setTimeout(() => { b.hidden = true; }, 3500);
}

const Rec = {
  canvas: null, ctx: null, s: 1, ox: 0, oy: 0, dpr: 1, drag: null,
  init() {
    this.canvas = $('#canvas-recadrage'); this.ctx = this.canvas.getContext('2d');
    this.loupe = $('#loupe'); this.lctx = this.loupe.getContext('2d');
    const c = this.canvas;
    c.addEventListener('pointerdown', e => this.debut(e));
    c.addEventListener('pointermove', e => this.bouge(e));
    c.addEventListener('pointerup', e => this.fin(e));
    c.addEventListener('pointercancel', e => this.fin(e));
    window.addEventListener('resize', () => { if (ecranCourant === 'recadrage') this.mettreEnPage(); });
  },
  mettreEnPage() {
    if (!ed) return;
    const zone = $('#zone-recadrage').getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(zone.width * this.dpr);
    this.canvas.height = Math.round(zone.height * this.dpr);
    this.l = zone.width; this.h = zone.height;
    const marge = 26, iw = ed.canvas.width, ih = ed.canvas.height;
    this.s = Math.min((this.l - 2 * marge) / iw, (this.h - 2 * marge) / ih);
    this.ox = (this.l - iw * this.s) / 2; this.oy = (this.h - ih * this.s) / 2;
    this.dessiner();
  },
  versEcran(p) { return { x: this.ox + p.x * this.s, y: this.oy + p.y * this.s }; },
  versImage(x, y) { return { x: (x - this.ox) / this.s, y: (y - this.oy) / this.s }; },
  poignees() {
    const p = ed.points, h = [];
    for (let i = 0; i < 4; i++) h.push({ type: 'coin', i, p: p[i] });
    for (let i = 0; i < 4; i++) { const a = p[i], b = p[(i + 1) % 4]; h.push({ type: 'bord', i, p: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }); }
    return h;
  },
  dessiner() {
    if (!ed) return;
    const ctx = this.ctx, d = this.dpr;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, this.l, this.h);
    ctx.drawImage(ed.canvas, this.ox, this.oy, ed.canvas.width * this.s, ed.canvas.height * this.s);
    const q = ed.points.map(p => this.versEcran(p));
    // Voile sombre autour de la feuille
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.l, this.h);
    ctx.moveTo(q[0].x, q[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y); ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fill('evenodd');
    ctx.restore();
    ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y); ctx.closePath();
    ctx.lineWidth = 2.5; ctx.strokeStyle = '#00C9B1'; ctx.stroke();
    ctx.fillStyle = 'rgba(0,201,177,.10)'; ctx.fill();
    for (const h of this.poignees()) {
      const e = this.versEcran(h.p);
      ctx.beginPath();
      if (h.type === 'coin') ctx.arc(e.x, e.y, 13, 0, Math.PI * 2);
      else ctx.arc(e.x, e.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = this.drag && this.drag.h.type === h.type && this.drag.h.i === h.i ? '#F9E300' : '#fff';
      ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#00C9B1'; ctx.stroke();
    }
  },
  pos(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; },
  debut(e) {
    if (!ed) return;
    const m = this.pos(e);
    let meilleur = null, dist = 44;
    for (const h of this.poignees()) {
      const p = this.versEcran(h.p), dd = Math.hypot(p.x - m.x, p.y - m.y) - (h.type === 'coin' ? 6 : 0);
      if (dd < dist) { dist = dd; meilleur = h; }
    }
    if (!meilleur) return;
    this.canvas.setPointerCapture(e.pointerId);
    const ref = this.versImage(m.x, m.y);
    this.drag = { h: meilleur, depart: ref, pts: ed.points.map(p => ({ ...p })) };
    this.bouge(e);
  },
  bouge(e) {
    if (!this.drag) return;
    e.preventDefault();
    const m = this.pos(e), pi = this.versImage(m.x, m.y);
    const W = ed.canvas.width, H = ed.canvas.height, lim = p => ({ x: Math.max(0, Math.min(W, p.x)), y: Math.max(0, Math.min(H, p.y)) });
    const { h, depart, pts } = this.drag;
    if (h.type === 'coin') ed.points[h.i] = lim(pi);
    else {
      const dx = pi.x - depart.x, dy = pi.y - depart.y, a = h.i, b = (h.i + 1) % 4;
      ed.points[a] = lim({ x: pts[a].x + dx, y: pts[a].y + dy });
      ed.points[b] = lim({ x: pts[b].x + dx, y: pts[b].y + dy });
    }
    this.dessiner();
    this.dessinerLoupe(h.type === 'coin' ? ed.points[h.i] : pi, m);
  },
  fin() {
    if (!this.drag) return;
    this.drag = null; this.loupe.style.display = 'none'; this.dessiner();
  },
  dessinerLoupe(p, m) {
    const L = this.loupe, ctx = this.lctx, taille = 240;
    L.style.display = 'block';
    L.classList.toggle('droite', m.x < this.l / 2 && m.y < 170);
    const zone = Math.max(30, 60 / this.s); // pixels d'image montrés
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, taille, taille);
    ctx.drawImage(ed.canvas, p.x - zone / 2, p.y - zone / 2, zone, zone, 0, 0, taille, taille);
    // Bords du cadre dans la loupe
    const k = taille / zone, t = q => ({ x: (q.x - p.x) * k + taille / 2, y: (q.y - p.y) * k + taille / 2 });
    ctx.beginPath(); const q = ed.points.map(t);
    ctx.moveTo(q[0].x, q[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y); ctx.closePath();
    ctx.lineWidth = 3; ctx.strokeStyle = '#00C9B1'; ctx.stroke();
    ctx.strokeStyle = '#F9E300'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(taille / 2 - 16, taille / 2); ctx.lineTo(taille / 2 + 16, taille / 2);
    ctx.moveTo(taille / 2, taille / 2 - 16); ctx.lineTo(taille / 2, taille / 2 + 16); ctx.stroke();
  },
};

function quadValide(q) {
  let signe = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1) return false;
    if (!signe) signe = Math.sign(z); else if (Math.sign(z) !== signe) return false;
  }
  return true;
}

/* ---------- Écran filtre ---------- */
let urlApercu = null, jetonApercu = 0;
async function majApercu() {
  const jeton = ++jetonApercu;
  document.querySelectorAll('#liste-filtres button').forEach(b => b.classList.toggle('actif', b.dataset.filtre === ed.filtre));
  $('#fil-chargement').hidden = false;
  await attendreRendu();
  if (jeton !== jetonApercu || !ed) return;
  try {
    const c = Scan.traiterPage(ed.canvas, ed.points, ed.filtre, ed.rotation, 1300);
    const b = await canvasVersBlob(c, 'image/jpeg', 0.85);
    if (jeton !== jetonApercu) return;
    if (urlApercu) URL.revokeObjectURL(urlApercu);
    urlApercu = URL.createObjectURL(b);
    $('#img-apercu').src = urlApercu;
  } catch (e) { console.error(e); toast('Erreur de traitement : ' + e.message); }
  if (jeton === jetonApercu) $('#fil-chargement').hidden = true;
}

async function validerPage() {
  if (!ed) return;
  attente('Finalisation de la page…');
  await attendreRendu();
  try {
    const q = QUALITE[lireReglage('qualite', 'normale')] || QUALITE.normale;
    const c = Scan.traiterPage(ed.canvas, ed.points, ed.filtre, ed.rotation, q.cote);
    const resultat = await canvasVersBlob(c, 'image/jpeg', q.jpeg);
    const ancien = await Store.get('pages', ed.pageId);
    const original = ancien && ancien.original ? ancien.original : await canvasVersBlob(ed.canvas, 'image/jpeg', 0.92);
    await Store.put('pages', { id: ed.pageId, original, points: ed.points, filtre: ed.filtre, rotation: ed.rotation, resultat, largeur: c.width, hauteur: c.height });
    if (!brouillon.pages.includes(ed.pageId)) brouillon.pages.push(ed.pageId);
    await sauverBrouillon();
    ecrireReglage('filtre', ed.filtre);
    ed = null; await sauverEdition();
    finAttente();
    afficher('document');
    rafraichirDocument();
    toast('Page ' + brouillon.pages.length + ' ajoutée');
  } catch (e) { finAttente(); console.error(e); toast('Erreur : ' + e.message); }
}

/* Import de plusieurs photos : traitement automatique */
async function importer() {
  const fichiers = await choisirPhotos({ camera: false, multiple: true });
  if (!fichiers.length) return;
  if (fichiers.length === 1) return ouvrirPhoto(fichiers[0], null);
  try {
    attente('Chargement de l\'outil de scan…');
    await Scan.chargerOpenCV();
    const filtre = lireReglage('filtre', 'magique');
    const q = QUALITE[lireReglage('qualite', 'normale')] || QUALITE.normale;
    let n = 0;
    for (const f of fichiers) {
      n++;
      attente('Page ' + n + ' sur ' + fichiers.length + '…');
      await attendreRendu();
      const canvas = await blobVersCanvas(f);
      const d = Scan.detecterDocument(canvas);
      const c = Scan.traiterPage(canvas, d.points, filtre, 0, q.cote);
      const pid = id();
      await Store.put('pages', {
        id: pid, original: await canvasVersBlob(canvas, 'image/jpeg', 0.92), points: d.points, filtre, rotation: 0,
        resultat: await canvasVersBlob(c, 'image/jpeg', q.jpeg), largeur: c.width, hauteur: c.height,
      });
      brouillon.pages.push(pid);
      await sauverBrouillon();
    }
    finAttente();
    afficher('document'); rafraichirDocument();
    toast(fichiers.length + ' pages ajoutées. Touche une page pour corriger ses bords.');
  } catch (e) { finAttente(); console.error(e); toast('Erreur : ' + e.message); }
}

/* ---------- Écran document ---------- */
let urlsVignettes = [];
async function rafraichirDocument() {
  urlsVignettes.forEach(u => URL.revokeObjectURL(u)); urlsVignettes = [];
  const g = $('#grille-pages'); g.innerHTML = '';
  $('#doc-titre').textContent = brouillon.pages.length + (brouillon.pages.length > 1 ? ' pages' : ' page');
  let i = 0;
  for (const pid of brouillon.pages) {
    i++;
    const p = await Store.get('pages', pid);
    const div = document.createElement('button');
    div.className = 'page'; div.type = 'button';
    if (p && p.resultat) {
      const u = URL.createObjectURL(p.resultat); urlsVignettes.push(u);
      const img = document.createElement('img'); img.src = u; img.alt = 'Page ' + i; div.appendChild(img);
    }
    const num = document.createElement('span'); num.className = 'num'; num.textContent = i; div.appendChild(num);
    const index = i - 1;
    div.addEventListener('click', () => ouvrirFeuille(index));
    g.appendChild(div);
  }
  $('#doc-terminer').disabled = brouillon.pages.length === 0;
}

let pageFeuille = -1;
function ouvrirFeuille(index) {
  pageFeuille = index;
  $('#feuille-titre').textContent = 'Page ' + (index + 1);
  $('#feuille').hidden = false;
}
async function actionFeuille(action) {
  $('#feuille').hidden = true;
  const i = pageFeuille, p = brouillon.pages;
  if (i < 0 || i >= p.length) return;
  if (action === 'modifier') return modifierPage(p[i]);
  if (action === 'avant' && i > 0) [p[i - 1], p[i]] = [p[i], p[i - 1]];
  if (action === 'apres' && i < p.length - 1) [p[i + 1], p[i]] = [p[i], p[i + 1]];
  if (action === 'supprimer') {
    if (!confirm('Supprimer la page ' + (i + 1) + ' ?')) return;
    const [pid] = p.splice(i, 1);
    try { await Store.del('pages', pid); } catch (e) {}
  }
  await sauverBrouillon();
  if (!p.length) { afficher('accueil'); return; }
  rafraichirDocument();
}

/* ---------- PDF ---------- */
async function fabriquerPDF() {
  if (!window.jspdf) throw new Error('Outil PDF non chargé');
  const { jsPDF } = window.jspdf;
  let doc = null;
  for (const pid of brouillon.pages) {
    const p = await Store.get('pages', pid);
    if (!p || !p.resultat) continue;
    let w = p.largeur, h = p.hauteur;
    if (!w || !h) { const c = await blobVersCanvas(p.resultat, 10000); w = c.width; h = c.height; }
    const orientation = w > h ? 'l' : 'p';
    if (!doc) doc = new jsPDF({ orientation, unit: 'mm', format: 'a4', compress: true });
    else doc.addPage('a4', orientation);
    const pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight();
    // Feuille au format A4 : pleine page. Petits documents (ticket, carte) : centrés avec une marge
    const r = w / h, ra = pw / ph;
    const pleine = Math.abs(r - ra) / ra < 0.06;
    const marge = pleine ? 0 : 12;
    const k = Math.min((pw - 2 * marge) / w, (ph - 2 * marge) / h);
    const dw = w * k, dh = h * k;
    doc.addImage(await blobVersDataURL(p.resultat), 'JPEG', (pw - dw) / 2, pleine ? (ph - dh) / 2 : marge, dw, dh, undefined, 'FAST');
  }
  if (!doc) throw new Error('Aucune page');
  doc.setProperties({ title: brouillon.nom || 'Scan', creator: 'VarOrga Scan' });
  return doc.output('blob');
}

/* ---------- Écran enregistrer ---------- */
function ouvrirEnregistrer() {
  $('#enr-nom').value = brouillon.nom || '';
  majNomFichier();
  const zone = $('#enr-categories'); zone.innerHTML = '';
  const actuelle = brouillon.categorie || lireReglage('categorie', 'Sans catégorie');
  brouillon.categorie = CATEGORIES.includes(actuelle) ? actuelle : 'Sans catégorie';
  for (const c of CATEGORIES) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = c;
    b.classList.toggle('actif', c === brouillon.categorie);
    b.addEventListener('click', () => {
      brouillon.categorie = c; sauverBrouillon();
      zone.querySelectorAll('button').forEach(x => x.classList.toggle('actif', x === b));
      majNomFichier();
    });
    zone.appendChild(b);
  }
  const cfg = config();
  $('#enr-drive').disabled = false;
  $('#enr-resume').textContent = cfg.url ? '' : 'Drive non relié : le PDF sera gardé en attente et envoyé dès que la liaison sera réglée.';
  afficher('enregistrer');
}
function majNomFichier() {
  brouillon.nom = $('#enr-nom').value.trim();
  $('#enr-fichier').textContent = 'Fichier : ' + (brouillon.categorie || 'Sans catégorie') + ' / ' + nomFichier(brouillon.nom);
}

async function envoyerDocument() {
  majNomFichier(); await sauverBrouillon();
  attente('Création du PDF…');
  await attendreRendu();
  try {
    const pdf = await fabriquerPDF();
    const env = { id: id(), date: Date.now(), fichier: nomFichier(brouillon.nom), categorie: brouillon.categorie || 'Sans catégorie', pages: brouillon.pages.length, statut: 'attente', pdf };
    await Store.put('envois', env);
    ecrireReglage('categorie', env.categorie);
    await viderBrouillon();
    finAttente();
    afficher('accueil');
    if (!config().url) { toast('PDF gardé en attente. Relie le Drive dans les réglages.', 5000); return; }
    toast('Envoi sur le Drive…');
    const ok = await envoyer(env);
    toast(ok ? 'Envoyé dans ' + env.categorie + ' ✓' : 'Pas envoyé pour l\'instant, nouvel essai automatique plus tard.', 4500);
  } catch (e) { finAttente(); console.error(e); toast('Erreur : ' + e.message, 5000); }
}

async function partagerDocument(telecharger) {
  majNomFichier(); await sauverBrouillon();
  attente('Création du PDF…');
  await attendreRendu();
  try {
    const pdf = await fabriquerPDF();
    const nom = nomFichier(brouillon.nom);
    finAttente();
    const f = new File([pdf], nom, { type: 'application/pdf' });
    if (!telecharger && navigator.canShare && navigator.canShare({ files: [f] })) {
      try { await navigator.share({ files: [f], title: nom }); } catch (e) { if (e.name !== 'AbortError') throw e; }
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(pdf); a.download = nom;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      if (!telecharger) toast('Partage indisponible : PDF téléchargé.');
    }
  } catch (e) { finAttente(); console.error(e); toast('Erreur : ' + e.message, 5000); }
}

/* ---------- Envoi sur le Drive ---------- */
let envoiEnCours = false;
async function envoyer(env) {
  const cfg = config();
  if (!cfg.url || !env.pdf) return false;
  try {
    const dataUrl = await blobVersDataURL(env.pdf);
    const r = await fetch(cfg.url, {
      method: 'POST',
      body: JSON.stringify({ cle: cfg.cle, action: 'deposer', nom: env.fichier, categorie: env.categorie, pdf: dataUrl.split(',')[1] }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.erreur || 'refus du serveur');
    env.statut = 'envoye'; env.url = j.url; env.erreur = ''; delete env.pdf;
    await Store.put('envois', env);
    rafraichirAccueil();
    return true;
  } catch (e) {
    env.statut = navigator.onLine === false ? 'attente' : 'erreur';
    env.erreur = navigator.onLine === false ? 'Pas de réseau' : String(e.message || e);
    await Store.put('envois', env);
    rafraichirAccueil();
    return false;
  }
}
async function renvoyerTout(silencieux) {
  if (envoiEnCours || !config().url) return;
  envoiEnCours = true;
  try {
    const liste = (await Store.all('envois')).filter(e => e.statut !== 'envoye' && e.pdf);
    let ok = 0;
    for (const e of liste) if (await envoyer(e)) ok++;
    if (liste.length && !silencieux) toast(ok + ' sur ' + liste.length + ' envoyé(s)');
    else if (ok) toast(ok + ' scan(s) en attente envoyé(s) ✓');
  } finally { envoiEnCours = false; }
}

/* ---------- Accueil ---------- */
async function rafraichirAccueil() {
  $('#alerte-config').hidden = !!config().url;
  const n = brouillon.pages.length;
  $('#carte-brouillon').hidden = n === 0;
  $('#brouillon-info').textContent = n + (n > 1 ? ' pages' : ' page') + ', pas encore enregistré';
  let envois = [];
  try { envois = await Store.all('envois'); } catch (e) {}
  envois.sort((a, b) => b.date - a.date);
  // On ne garde que les 40 derniers envois réussis
  for (const e of envois.filter(x => x.statut === 'envoye').slice(40)) { try { await Store.del('envois', e.id); } catch (er) {} }
  const ul = $('#liste-envois'); ul.innerHTML = '';
  const affiches = envois.slice(0, 40);
  $('#liste-vide').hidden = affiches.length > 0;
  $('#btn-renvoyer').hidden = !envois.some(e => e.statut !== 'envoye');
  for (const e of affiches) {
    const li = document.createElement('li');
    const info = document.createElement('div'); info.className = 'info';
    const nom = document.createElement('div'); nom.className = 'nom'; nom.textContent = e.fichier.replace(/\.pdf$/, '');
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = e.categorie + ' · ' + e.pages + (e.pages > 1 ? ' pages' : ' page') + (e.statut === 'erreur' && e.erreur ? ' · ' + e.erreur : '');
    info.append(nom, meta);
    const st = document.createElement('span'); st.className = 'statut ' + e.statut;
    st.textContent = e.statut === 'envoye' ? 'Envoyé' : e.statut === 'attente' ? 'En attente' : 'Erreur';
    li.append(info, st);
    if (e.statut === 'envoye' && e.url) {
      const a = document.createElement('a'); a.href = e.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Ouvrir';
      li.appendChild(a);
    } else if (e.pdf) {
      const b = document.createElement('button'); b.className = 'lien'; b.textContent = 'Partager';
      b.addEventListener('click', async () => {
        const f = new File([e.pdf], e.fichier, { type: 'application/pdf' });
        try { if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title: e.fichier }); } catch (er) {}
      });
      li.appendChild(b);
    }
    ul.appendChild(li);
  }
}

/* ---------- Réglages ---------- */
function ouvrirReglages() {
  const c = config();
  $('#reg-url').value = c.url; $('#reg-cle').value = c.cle;
  $('#reg-filtre').value = lireReglage('filtre', 'magique');
  $('#reg-qualite').value = lireReglage('qualite', 'normale');
  $('#reg-resultat').textContent = '';
  afficher('reglages');
}
function enregistrerReglages() {
  ecrireReglage('url', $('#reg-url').value.trim());
  ecrireReglage('cle', $('#reg-cle').value.trim());
  ecrireReglage('filtre', $('#reg-filtre').value);
  ecrireReglage('qualite', $('#reg-qualite').value);
}
async function testerLiaison() {
  enregistrerReglages();
  const c = config(), out = $('#reg-resultat');
  if (!c.url) { out.textContent = 'Adresse manquante.'; return; }
  out.textContent = 'Test en cours…';
  try {
    const r = await fetch(c.url, { method: 'POST', body: JSON.stringify({ cle: c.cle, action: 'test' }) });
    const j = await r.json();
    out.textContent = j.ok ? '✓ Liaison OK. Les scans vont dans « ' + j.dossier + ' » sur ton Drive.' : '✗ Refusé : ' + (j.erreur || 'erreur inconnue');
    if (j.ok) renvoyerTout(true);
  } catch (e) { out.textContent = '✗ Pas de réponse du serveur (' + e.message + ')'; }
}

/* Réglage par QR code : …/#cfg=<base64 de {"u":…,"k":…}> */
function lireConfigDansAdresse() {
  const m = location.hash.match(/cfg=([A-Za-z0-9_\-+/=]+)/);
  if (!m) return false;
  try {
    const json = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')))));
    if (json.u) ecrireReglage('url', json.u);
    if (json.k) ecrireReglage('cle', json.k);
    history.replaceState(null, '', location.pathname + location.search);
    return true;
  } catch (e) { return false; }
}

/* ---------- Démarrage ---------- */
async function demarrer() {
  $('#version').textContent = VERSION;
  Rec.init();
  const configure = lireConfigDansAdresse();
  await chargerBrouillon();

  // Reprise après un rechargement d'Android pendant une modification
  try {
    const e = await Store.get('etat', 'edition');
    if (e && e.pageId) {
      const p = await Store.get('pages', e.pageId);
      if (p && p.original) {
        attente('Reprise de la photo…');
        await Scan.chargerOpenCV();
        const canvas = await blobVersCanvas(p.original);
        ed = { pageId: e.pageId, nouvelle: e.nouvelle, canvas, points: p.points || Scan.detecterDocument(canvas).points, filtre: e.filtre || 'magique', rotation: e.rotation || 0 };
        finAttente();
        afficher('recadrage');
      } else { await Store.put('etat', null, 'edition'); }
    }
  } catch (er) { finAttente(); console.warn(er); }

  if (ecranCourant === 'accueil') rafraichirAccueil();
  if (configure) toast('Drive relié ✓', 3500);

  $('#btn-scanner').addEventListener('click', () => nouvellePhoto());
  $('#btn-importer').addEventListener('click', importer);
  $('#btn-reprendre').addEventListener('click', () => { afficher('document'); rafraichirDocument(); });
  $('#btn-reglages').addEventListener('click', ouvrirReglages);
  $('#btn-aller-reglages').addEventListener('click', ouvrirReglages);
  $('#btn-renvoyer').addEventListener('click', () => renvoyerTout(false));

  $('#rec-annuler').addEventListener('click', annulerEdition);
  $('#rec-tout').addEventListener('click', () => {
    const W = ed.canvas.width, H = ed.canvas.height;
    ed.points = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }]; Rec.dessiner();
  });
  $('#rec-auto').addEventListener('click', () => {
    const d = Scan.detecterDocument(ed.canvas); ed.points = d.points; Rec.dessiner();
    infoRecadrage(d.trouve ? 'Bords détectés' : 'Bords non trouvés');
  });
  $('#rec-valider').addEventListener('click', () => {
    if (!quadValide(ed.points)) { infoRecadrage('Les coins se croisent : corrige le cadre.'); return; }
    sauverEdition(); afficher('filtre'); majApercu();
  });

  $('#fil-retour').addEventListener('click', () => afficher('recadrage'));
  $('#fil-rot-g').addEventListener('click', () => { ed.rotation = (ed.rotation + 270) % 360; sauverEdition(); majApercu(); });
  $('#fil-rot-d').addEventListener('click', () => { ed.rotation = (ed.rotation + 90) % 360; sauverEdition(); majApercu(); });
  $('#liste-filtres').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    ed.filtre = b.dataset.filtre; sauverEdition(); majApercu();
  });
  $('#fil-valider').addEventListener('click', validerPage);
  $('#fil-reprendre').addEventListener('click', () => nouvellePhoto({ pageId: ed.pageId, nouvelle: ed.nouvelle, filtre: ed.filtre }));

  $('#doc-retour').addEventListener('click', () => afficher('accueil'));
  $('#doc-photo').addEventListener('click', () => nouvellePhoto());
  $('#doc-importer').addEventListener('click', importer);
  $('#doc-terminer').addEventListener('click', ouvrirEnregistrer);
  $('#doc-jeter').addEventListener('click', async () => {
    if (!confirm('Abandonner ce document et ses ' + brouillon.pages.length + ' page(s) ?')) return;
    await viderBrouillon(); afficher('accueil');
  });
  $('#feuille').addEventListener('click', e => {
    const b = e.target.closest('[data-action],[data-fermer]'); if (!b) return;
    if (b.dataset.action) actionFeuille(b.dataset.action); else $('#feuille').hidden = true;
  });

  $('#enr-retour').addEventListener('click', () => afficher('document'));
  $('#enr-nom').addEventListener('input', majNomFichier);
  $('#enr-nom').addEventListener('change', sauverBrouillon);
  $('#enr-drive').addEventListener('click', envoyerDocument);
  $('#enr-partager').addEventListener('click', () => partagerDocument(false));
  $('#enr-telecharger').addEventListener('click', () => partagerDocument(true));

  $('#reg-retour').addEventListener('click', () => { enregistrerReglages(); afficher('accueil'); });
  $('#reg-enregistrer').addEventListener('click', () => { enregistrerReglages(); toast('Réglages enregistrés'); });
  $('#reg-tester').addEventListener('click', testerLiaison);

  window.addEventListener('online', () => renvoyerTout(true));
  setTimeout(() => renvoyerTout(true), 2500);
  // On charge l'outil de scan en avance, pour qu'il soit prêt au retour de l'appareil photo
  setTimeout(() => Scan.chargerOpenCV().catch(() => {}), 600);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

demarrer();
