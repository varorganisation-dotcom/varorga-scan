/* VarOrga Scan : stockage local (IndexedDB)
 * pages  : photos et pages traitées du document en cours
 * etat   : document en cours (ordre des pages, nom, catégorie)
 * envois : historique et file d'attente des PDF à envoyer sur le Drive
 */
'use strict';

const Store = (() => {
  let dbP = null;
  let memoire = { pages: new Map(), etat: new Map(), envois: new Map() }; // repli si IndexedDB est indisponible

  function ouvrir() {
    if (dbP) return dbP;
    dbP = new Promise(resolve => {
      try {
        const req = indexedDB.open('varorga-scan', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          db.createObjectStore('pages', { keyPath: 'id' });
          db.createObjectStore('etat');
          db.createObjectStore('envois', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return dbP;
  }

  async function tx(store, mode, fn) {
    const db = await ouvrir();
    if (!db) return fn(null, memoire[store]);
    return new Promise((resolve, reject) => {
      try {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let resultat;
        const r = fn(s, null);
        if (r && 'onsuccess' in r) r.onsuccess = () => { resultat = r.result; };
        t.oncomplete = () => resolve(resultat);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      } catch (e) { reject(e); }
    });
  }

  const cleDe = (store, v) => store === 'etat' ? null : v.id;

  return {
    get: (store, cle) => tx(store, 'readonly', (s, m) => s ? s.get(cle) : Promise.resolve(m.get(cle))),
    put: (store, valeur, cle) => tx(store, 'readwrite', (s, m) => {
      if (s) return store === 'etat' ? s.put(valeur, cle) : s.put(valeur);
      m.set(store === 'etat' ? cle : cleDe(store, valeur), valeur);
    }),
    del: (store, cle) => tx(store, 'readwrite', (s, m) => { if (s) return s.delete(cle); m.delete(cle); }),
    all: (store) => tx(store, 'readonly', (s, m) => s ? s.getAll() : Promise.resolve([...m.values()])),
  };
})();
