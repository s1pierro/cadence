// detect-scope.js — lignes et services soumis à la détection (Réglages › Lignes à détecter).
// On mémorise, par réseau, les services EXCLUS : par défaut tout est testé, et un service ajouté plus tard l'est aussi.
// Stockage : localStorage « detect-scope » = { idRéseau: [ids des services exclus] }.

const DetectScope = {
  KEY: 'detect-scope',
  _subs: [],

  _load() {
    try { const o = JSON.parse(localStorage.getItem(this.KEY)); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
  },
  _save(all) {
    try { localStorage.setItem(this.KEY, JSON.stringify(all)); } catch (e) {}
    this._subs.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  },

  excluded(net) { return new Set(net ? this._load()[net.id] || [] : []); },
  includes(net, sv) { return !this.excluded(net).has(sv.id); },
  // Filtre figé au moment de l'appel (le détecteur le redemande à chaque changement, voir on())
  filter(net) { const ex = this.excluded(net); return sv => !ex.has(sv.id); },

  // Active / désactive une liste de services
  set(net, ids, on) {
    if (!net) return;
    const all = this._load(), ex = new Set(all[net.id] || []);
    ids.forEach(id => (on ? ex.delete(id) : ex.add(id)));
    // on ne garde que les services qui existent encore
    const known = new Set(net.services.map(sv => sv.id));
    const list = [...ex].filter(id => known.has(id));
    if (list.length) all[net.id] = list; else delete all[net.id];
    this._save(all);
  },

  // Résumé pour Réglages : { lines, linesOn, services, servicesOn }
  count(net) {
    const ex = this.excluded(net), lines = net ? net.lines() : [];
    const services = net ? net.services.length : 0;
    const servicesOn = net ? net.services.filter(sv => !ex.has(sv.id)).length : 0;
    return { lines: lines.length, linesOn: lines.filter(l => l.services.some(sv => !ex.has(sv.id))).length, services, servicesOn };
  },

  on(fn) { this._subs.push(fn); }
};

window.DetectScope = DetectScope;
