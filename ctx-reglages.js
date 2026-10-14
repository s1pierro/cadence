// ctx-reglages.js — onglet « Réglages » de Bang Lab : réseau actif, outils, affichage, application.

class ReglagesContext extends Context {
  build(el) {
    this._injectStyle();
    this.list = document.createElement('div');
    this.list.className = 'rg-list';
    el.append(this.list);
    this.refresh();
    if (window.PWA) PWA.on(() => this.refresh());
    if (window.GeoPerm) { GeoPerm.on(() => this.refresh()); GeoPerm.state(); }
    if (window.ServerData) ServerData.on(() => this.refresh());
    if (window.DetectScope) DetectScope.on(() => this.refresh());
  }

  onShow() { if (this.built) this.refresh(); }

  _row(icon, label, sub, onTap, cls) {
    const row = document.createElement('div');
    row.className = 'rg-row' + (cls ? ' ' + cls : '');
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.innerHTML = uiSvg(icon);
    const t = document.createElement('span');
    t.append(label);
    if (sub) { const s = document.createElement('small'); s.textContent = sub; t.appendChild(s); }
    row.appendChild(t);
    row.insertAdjacentHTML('beforeend', uiSvg('<path d="M9 5l7 7-7 7"/>', 'rg-chev'));
    if (onTap) {
      row.addEventListener('click', onTap);
      row.addEventListener('keydown', ev => { if (ev.key === 'Enter') onTap(); });
    }
    return row;
  }

  _group(title, rows) {
    const g = document.createElement('div');
    if (title) { const h = document.createElement('div'); h.className = 'rg-h'; h.textContent = title; g.appendChild(h); }
    const box = document.createElement('div');
    box.className = 'rg-box';
    rows.filter(Boolean).forEach(r => box.appendChild(r));
    g.appendChild(box);
    return g;
  }

  refresh() {
    const bang = this.bang, nets = bang.store.networks, net = bang.network;
    const groups = [];

    // Réseau actif : une ligne par réseau (le réseau coché est utilisé par la carte, les formulaires et la détection)
    const netRows = nets.map(n => {
      const r = this._row(n === net ? '<path d="M5 12.5l4.5 4.5L19 7.5"/>' : '<circle cx="12" cy="12" r="7"/>',
        n.name || 'Réseau', (n.services ? n.services.length : 0) + ' service' + (n.services && n.services.length > 1 ? 's' : ''),
        () => { bang.store.setActive(n.id); this._netChanged(); }, n === net ? 'rg-on' : '');
      r.querySelector('.rg-chev').remove();
      return r;
    });
    if (!netRows.length) netRows.push(this._row('<circle cx="12" cy="12" r="7"/>', 'Aucun réseau', 'Importe un jeu de données dans Formulaires › Importer', () => bang.contexts.open('feed')));
    groups.push(this._group('Réseau actif', netRows));

    // Formulaires : saisie, import et export des données du réseau
    const dataRows = [this._row('<rect x="4" y="5" width="16" height="16" rx="4"/><path d="M8 3v4M16 3v4M8 12h8M8 16h5"/>',
      'Formulaires', 'Réseaux, lignes, arrêts, services · importer, exporter', () => bang.contexts.open('feed'))];

    // Données du serveur : état de la dernière synchronisation ; toucher recharge le fichier (remplace les données locales)
    if (window.ServerData) {
      const sd = ServerData, busy = sd.status === 'loading';
      const warn = sd.status === 'missing' || sd.status === 'error';
      const row = this._row('<path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"/><path d="M4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7"/><path d="M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5"/>',
        busy ? 'Chargement des données…' : 'Recharger les données du serveur', sd.summary(), busy ? null : async () => {
          const s = await sd.sync(bang, true);
          sd.toast(s === 'synced' ? 'Données du serveur rechargées.'
            : s === 'missing' ? 'Fichier introuvable : ' + sd.url
            : s === 'offline' ? 'Hors ligne : données locales conservées.'
            : 'Échec : ' + sd.detail, s === 'synced' ? '' : 'err');
        }, warn ? 'rg-warn' : '');
      dataRows.push(row);
    }
    groups.push(this._group('Données', dataRows));

    // Autorisation de position : état, demande, aide pour réactiver
    let geo = null;
    if (window.GeoPerm) {
      const ps = GeoPerm.current;
      const sub = ps === 'granted' ? 'Autorisée · utilisée par la carte et la détection'
        : ps === 'prompt' || ps === 'unknown' ? 'Pas encore autorisée · toucher pour la demander'
        : GeoPerm.label(ps) + ' · toucher pour l’aide';
      geo = this._row('<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
        'Autorisation de position', sub, () => {
          if (ps === 'prompt' || ps === 'unknown') GeoPerm.ensure();
          else GeoPerm.showHelp(ps === 'granted' ? 'unavailable' : ps);
        }, ps === 'denied' || ps === 'insecure' ? 'rg-warn' : '');
    }

    // Lignes à détecter : restreindre les candidats aux lignes réellement exploitées améliore la détection
    let scope = null;
    if (window.DetectScope && net && net.services.length) {
      const c = DetectScope.count(net);
      scope = this._row('<path d="M4 6h16M4 12h10M4 18h6"/><path d="M15 17l2 2 4-4"/>', 'Lignes à détecter',
        c.servicesOn === c.services ? 'Toutes les lignes (' + c.lines + ')'
          : c.linesOn + ' ligne' + (c.linesOn > 1 ? 's' : '') + ' sur ' + c.lines + ' · ' + c.servicesOn + ' service' + (c.servicesOn > 1 ? 's' : '') + ' sur ' + c.services,
        () => bang.contexts.open('detect-scope'), c.servicesOn ? '' : 'rg-warn');
    }

    groups.push(this._group('Outils', [
      geo,
      scope,
      this._row('<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
        'Détection du service en cours', 'GNSS réel ou trace simulée', () => bang.contexts.open('feed-detect')),
      this._row('<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
        'Calendrier de circulation', 'Vacances et jours fériés', () => bang.contexts.open('feed-calendar'))
    ]));

    let fs = null;
    if (window.PWA && PWA.fullscreenSupported()) {
      fs = this._row('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', 'Plein écran',
        PWA.isFullscreen() ? 'Activé · toucher pour quitter' : 'Désactivé · toucher pour activer', () => PWA.toggleFullscreen());
    }
    groups.push(this._group('Application', [
      fs,
      this._row('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>', 'Installation et état',
        'Version, mise à jour, hors ligne, données', () => { if (window.PWA) PWA.openPanel(); })
    ]));
    this.list.replaceChildren(...groups);
  }

  // Le réseau actif a changé : la carte, les formulaires et la détection se reconstruisent à leur prochaine ouverture
  _netChanged() { this.refresh(); }

  _injectStyle() {
    if (document.getElementById('rg-style')) return;
    const st = document.createElement('style');
    st.id = 'rg-style';
    st.textContent = `
      .rg-list{padding:env(safe-area-inset-top,0px) 0 1.5em}
      .rg-h{margin:1.2em 1.4em .4em;font-size:.8em;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--inactive-color)}
      .rg-box{margin:0 1em;background:#fff;border-radius:14px;overflow:hidden}
      .rg-row{display:flex;align-items:center;gap:1em;padding:.95em 1em;cursor:pointer;color:var(--text-color);border-top:1px solid #eee;
        -webkit-tap-highlight-color:transparent;user-select:none}
      .rg-row:first-child{border-top:0}
      .rg-row:active{background:#f2f2f2}
      .rg-row>svg{width:24px;height:24px;flex:none;color:var(--accent-color)}
      .rg-row>span{flex:1;min-width:0}
      .rg-row small{display:block;font-size:.8em;margin-top:.15em;color:var(--inactive-color)}
      .rg-row .rg-chev{width:18px;height:18px;flex:none;color:var(--inactive-color)}
      .rg-on>span{font-weight:700;color:var(--accent-color)}
      .rg-warn small{color:#b3261e}
    `;
    document.head.appendChild(st);
  }
}

window.ReglagesContext = ReglagesContext;

// --- Réglages › Lignes à détecter ----------------------------------------------------------------
// Une carte par ligne : interrupteur de la ligne entière ; toucher la ligne déplie ses services (un interrupteur chacun).

class DetectScopeContext extends Context {
  build(el) {
    if (typeof fdInjectStyle === 'function') fdInjectStyle();
    this._injectStyle();
    this.open = new Set();    // lignes dépliées
    const title = document.createElement('div');
    title.className = 'fd-title';
    const h = document.createElement('h2');
    h.textContent = 'Lignes à détecter';
    this.sub = document.createElement('small');
    title.append(h, this.sub);
    const note = document.createElement('p');
    note.className = 'sc-note';
    note.textContent = 'Seuls les services cochés sont proposés par la détection. Écarter les lignes que vous n’exploitez pas '
      + 'évite les confusions sur les tronçons communs.';
    const acts = document.createElement('div');
    acts.className = 'sc-acts';
    acts.append(this._btn('Tout cocher', () => this._setAll(true)), this._btn('Tout décocher', () => this._setAll(false)));
    this.list = document.createElement('div');
    this.list.className = 'sc-list';
    el.append(fdMkBar(this.bang, { back: true }), title, note, acts, this.list);
    DetectScope.on(() => this.refresh());
    this.refresh();
  }

  onShow() { if (this.built) this.refresh(); }

  _btn(label, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sc-btn';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  _setAll(on) {
    const net = this.bang.network;
    if (net) DetectScope.set(net, net.services.map(sv => sv.id), on);
  }

  // Interrupteur ; mixed : ligne en partie cochée
  _switch(on, mixed, label, fn) {
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'sc-sw' + (on ? ' on' : '') + (mixed ? ' mixed' : '');
    s.setAttribute('role', 'switch');
    s.setAttribute('aria-checked', mixed ? 'mixed' : String(on));
    s.setAttribute('aria-label', label);
    s.addEventListener('click', ev => { ev.stopPropagation(); fn(); });
    return s;
  }

  _badge(o) {
    const b = document.createElement('span');
    b.className = 'sc-code';
    b.textContent = o.code || '•';
    if (o.symcolor0) b.style.background = o.symcolor0;
    if (o.symcolor1) b.style.color = o.symcolor1;
    if (o.symcolor2) b.style.boxShadow = '0 0 0 2px ' + o.symcolor2;
    return b;
  }

  _svLabel(sv) {
    const a = sv.departure, b = sv.arrival;
    const t = st => (st && (st.departure || st.arrival)) || '';
    const tb = st => (st && (st.arrival || st.departure)) || '';
    const TS = window.TicketSearch;
    return {
      main: [t(a), a && b ? a.stop.name + ' → ' + b.stop.name : sv.name].filter(Boolean).join(' · '),
      sub: [tb(b) ? 'arrivée ' + tb(b) : '', TS ? TS.daysLabel(sv.operatingDays) : '', TS ? TS.periodsLabel(sv.operatingPeriods) : '']
        .filter(Boolean).join(' · ')
    };
  }

  refresh() {
    const net = this.bang.network;
    if (!net || !net.services.length) {
      this.sub.textContent = net ? 'Réseau : ' + net.name : '';
      const n = document.createElement('p');
      n.className = 'sc-note';
      n.textContent = net ? 'Ce réseau n’a pas encore de service.' : 'Aucun réseau actif.';
      this.list.replaceChildren(n);
      return;
    }
    const ex = DetectScope.excluded(net), c = DetectScope.count(net);
    this.sub.textContent = net.name + ' · ' + c.servicesOn + ' service' + (c.servicesOn > 1 ? 's' : '') + ' sur ' + c.services;
    const toMin = st => { const m = st && /^(\d{1,2}):(\d{2})/.exec(st.departure || st.arrival || ''); return m ? +m[1] * 60 + +m[2] : 1e9; };
    this.list.replaceChildren(...net.lines().map(line => {
      const on = line.services.filter(sv => !ex.has(sv.id)).length, all = line.services.length;
      const card = document.createElement('div');
      card.className = 'sc-line' + (on ? '' : ' off');
      const head = document.createElement('div');
      head.className = 'sc-head';
      head.setAttribute('role', 'button');
      head.tabIndex = 0;
      head.setAttribute('aria-expanded', String(this.open.has(line.key)));
      const txt = document.createElement('span');
      txt.className = 'sc-txt';
      const name = document.createElement('b');
      name.textContent = line.name;
      const small = document.createElement('small');
      small.textContent = (on === all ? all + ' service' + (all > 1 ? 's' : '') : on + ' service' + (on > 1 ? 's' : '') + ' sur ' + all) + ' · toucher pour '
        + (this.open.has(line.key) ? 'replier' : 'choisir');
      txt.append(name, small);
      head.append(this._badge(line), txt,
        this._switch(on === all, on > 0 && on < all, 'Ligne ' + (line.code || line.name),
          () => DetectScope.set(net, line.services.map(sv => sv.id), on < all)));
      const fold = () => { if (this.open.has(line.key)) this.open.delete(line.key); else this.open.add(line.key); this.refresh(); };
      head.addEventListener('click', fold);
      head.addEventListener('keydown', ev => { if (ev.key === 'Enter') fold(); });
      card.appendChild(head);
      if (this.open.has(line.key)) {
        const box = document.createElement('div');
        box.className = 'sc-svs';
        line.services.slice().sort((x, y) => toMin(x.departure) - toMin(y.departure)).forEach(sv => {
          const r = document.createElement('div');
          r.className = 'sc-sv' + (ex.has(sv.id) ? ' off' : '');
          const l = this._svLabel(sv), t = document.createElement('span');
          t.className = 'sc-txt';
          const m = document.createElement('span');
          m.textContent = l.main;
          const s = document.createElement('small');
          s.textContent = l.sub;
          t.append(m, s);
          const sw = this._switch(!ex.has(sv.id), false, 'Service ' + l.main, () => DetectScope.set(net, [sv.id], ex.has(sv.id)));
          r.append(t, sw);
          r.addEventListener('click', () => sw.click());
          box.appendChild(r);
        });
        card.appendChild(box);
      }
      return card;
    }));
  }

  _injectStyle() {
    if (document.getElementById('sc-style')) return;
    const st = document.createElement('style');
    st.id = 'sc-style';
    st.textContent = `
      .sc-note{margin:.8em 1.4em 0;font-size:.88em;line-height:1.45;color:var(--inactive-color);text-align:center}
      .sc-acts{display:flex;gap:.6em;margin:1em}
      .sc-btn,.sc-btn:hover{flex:1;border-radius:12px;padding:.7em .5em;background:#fff;color:var(--accent-color);font-weight:600;
        box-shadow:inset 0 0 0 1.5px var(--accent-color)}
      .sc-list{display:flex;flex-direction:column;gap:.6em;margin:0 1em 1.5em}
      .sc-line{background:#fff;border-radius:14px;overflow:hidden}
      .sc-head{display:flex;align-items:center;gap:.8em;padding:.8em 1em;cursor:pointer;-webkit-tap-highlight-color:transparent;user-select:none}
      .sc-head:active,.sc-sv:active{background:#f2f2f2}
      .sc-line.off .sc-code,.sc-line.off .sc-head b{opacity:.45}
      .sc-code{flex:none;min-width:2.4em;padding:.25em .5em;border-radius:8px;text-align:center;font-weight:800;font-size:.9em;
        background:var(--accent-color);color:#fff;box-sizing:border-box}
      .sc-txt{flex:1;min-width:0}
      .sc-txt small{display:block;font-size:.8em;margin-top:.15em;color:var(--inactive-color)}
      .sc-svs{border-top:1px solid #eee}
      .sc-sv{display:flex;align-items:center;gap:.8em;padding:.7em 1em .7em 1.4em;border-top:1px solid #f3f3f3;cursor:pointer;
        -webkit-tap-highlight-color:transparent;user-select:none}
      .sc-sv:first-child{border-top:0}
      .sc-sv.off .sc-txt>span{color:var(--inactive-color);text-decoration:line-through}
      .sc-sw,.sc-sw:hover{flex:none;position:relative;width:2.9em;height:1.7em;padding:0;border-radius:999px;background:#c9c9c9;transition:background .15s}
      .sc-sw::after{content:"";position:absolute;top:.2em;left:.2em;width:1.3em;height:1.3em;border-radius:50%;background:#fff;
        box-shadow:0 1px 3px rgba(0,0,0,.25);transition:left .15s}
      .sc-sw.on{background:var(--accent-color)}
      .sc-sw.on::after{left:1.4em}
      .sc-sw.mixed{background:#7fa9c2}
      .sc-sw.mixed::after{left:.8em}
      @media (prefers-reduced-motion:reduce){.sc-sw,.sc-sw::after{transition:none}}
    `;
    document.head.appendChild(st);
  }
}

window.DetectScopeContext = DetectScopeContext;
