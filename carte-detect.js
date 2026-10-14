// carte-detect.js — bandeau « Détection » de la Carte, placé entre la carte et le panneau inférieur.
// Utilise le moteur de detect.js (Detector) sur le réseau actif :
//   - GNSS réel (watchPosition, écran maintenu allumé quand le navigateur le permet) ;
//   - simulation du service affiché dans le panneau (réglages repris de Réglages › Détection) ;
//   - rejeu de la dernière trace enregistrée.
// Chaque session est enregistrée (positions + décisions) dans localStorage (« detect-trace ») et peut être exportée
// en JSON pour analyser les essais terrain. La position s'affiche sur la carte ; quand un service est identifié,
// le panneau l'ouvre (si l'utilisateur ne regarde pas autre chose) et suit l'avancement arrêt par arrêt.

class DetectBand {
  static TRACE_KEY = 'detect-trace';
  static MAX_FIXES = 20000;
  static LOST_MS = 5 * 60000;     // suivi verrouillé : déverrouillage si plus aucune position sur le tracé depuis 5 min
  static RETURN_MS = 30000;       // sans toucher l'écran pendant 30 s, le panneau revient au service verrouillé

  constructor(ctx) {
    this.ctx = ctx;
    this.bang = ctx.bang;
    this.net = null;
    this.det = null;
    this.src = null;          // 'gnss' | 'sim' | 'replay' | null (arrêté)
    this.s = null;            // dernier état renvoyé par Detector.feed
    this.fix = null;          // dernière position
    this.msg = null;          // message ({text, warn})
    this.trace = null;        // session en cours (ou dernière session)
    this.watch = null;
    this.timer = null;
    this.wake = null;
    this.follow = true;
    this.autoId = null;       // service ouvert automatiquement dans le panneau
    // Suivi verrouillé : une fois un service identifié, on s'y tient (tronçons communs, écarts passagers)
    // jusqu'à la fin du service, une perte prolongée du tracé ou un déverrouillage manuel.
    this.lock = null;         // {id, since, how: 'auto' | 'manuel'}
    this.lockCand = null;     // état du service verrouillé (Detector.track)
    this.noRelock = new Map();  // id -> instant (temps des positions) avant lequel ce service ne se reverrouille pas seul
    this._injectStyle();
    this.el = document.createElement('div');
    this.el.className = 'cd-band';
    this.el.hidden = true;
    this.card = document.createElement('div');
    this.card.className = 'cd-card';
    this.el.appendChild(this.card);
    this.trace = this._loadTrace();
    if (window.GeoPerm) { GeoPerm.on(() => this.render()); GeoPerm.state(); }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.src) this._wakeLock();
      if (document.visibilityState === 'hidden' && this.trace && this.src) this._saveTrace();
    });
  }

  // ----- Réseau -----------------------------------------------------------------------------------
  // Appelé par CarteContext à chaque (re)construction de la carte. Une détection en cours sur le même réseau continue.
  // sig : signature des données du réseau (un réseau modifié reconstruit le détecteur, sauf pendant une détection)
  setNetwork(net, sig) {
    const ok = net && net.services.length && net.stops.some(s => s.lat !== null && s.lon !== null);
    if (ok && net === this.net && this.det && (this.src || sig === this._sig)) { this._afterMapChange(); this.render(); return; }
    this._sig = sig;
    this.stop();
    this.net = ok ? net : null;
    this.det = ok ? new Detector(net) : null;
    this.s = null;
    this.fix = null;
    this.msg = null;
    this.el.hidden = !this.det;
    this.render();
  }

  // La carte a été recréée : y reporter la position et le mode suivi
  _afterMapChange() {
    const m = this.ctx.map;
    if (!m) return;
    m.onFollow = on => { this.follow = on; this.render(); };
    if (this.fix && m.setMe) m.setMe(this.fix.lat, this.fix.lon, { live: !!this.src });
  }

  get running() { return !!this.src; }

  // ----- Sources ----------------------------------------------------------------------------------
  startLive() {
    if (!this.det) return;
    if (!navigator.geolocation) { this._say('Ce navigateur n’a pas de GNSS.', true); return; }
    this._begin('gnss');
    this.watch = navigator.geolocation.watchPosition(p => {
      const c = p.coords;
      if (this.msg && this.msg.wait) this.msg = null;
      if (window.GeoPerm && GeoPerm.current !== 'granted') GeoPerm.noteSuccess();
      this._feed({ t: p.timestamp || Date.now(), lat: c.latitude, lon: c.longitude, acc: c.accuracy, speed: c.speed, heading: c.heading });
    }, err => {
      if (err.code === 1) {                      // refus : inutile d'insister
        this.stop();
        this._say('Accès à la position refusé.', true);
        if (window.GeoPerm) { GeoPerm.noteError(err); GeoPerm.showHelp('denied'); }
      } else {                                   // délai dépassé / position indisponible : la surveillance continue
        this._say(err.code === 3 ? 'Signal GNSS faible, en attente…' : 'Position indisponible, en attente…', true, true);
      }
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }

  // Réglages de simulation : ceux de Réglages › Détection GNSS s'ils existent
  _simOpts() {
    const fd = this.bang.contexts.map['feed-detect'];
    let st = fd && fd.state;
    if (!st) { try { st = JSON.parse(localStorage.getItem('ctx:feed-detect') || 'null'); } catch (e) { st = null; } }
    return Object.assign({ noise: 15, speed: 30, delay: 0, from: 0 }, st || {});
  }

  // Service à simuler : celui affiché dans le panneau, sinon le premier de la ligne affichée
  simTarget() {
    const net = this.net, c = this.ctx;
    if (!net) return null;
    if (c.mode === 'service' && c.selSvc) return net.services.find(s => s.id === c.selSvc) || null;
    if (c.mode === 'line' && c.selLine) { const l = net.getLine(c.selLine); return l && l.services[0] || null; }
    return null;
  }

  startSim(sv) {
    if (!this.det || !sv) return;
    const o = this._simOpts();
    let day = new Date();
    for (let i = 0; i < 400; i++, day.setDate(day.getDate() + 1)) if (sv.runsOn(day, this.net)) break;
    day = new Date(day);
    const from = Math.max(0, Math.min(sv.stopTimes.length - 2, Math.floor((sv.stopTimes.length - 1) * o.from)));
    const fixes = Detector.simulate(sv, { date: day, noise: o.noise, delay: o.delay, from, seed: Date.now() & 0xffff, every: 5 });
    if (!fixes.length) { this._say('Ce service n’a pas d’horaires exploitables.', true); return; }
    this._play(fixes, o.speed, 'sim', { service: sv.id, code: sv.code || '', noise: o.noise, delay: o.delay, from: o.from, speed: o.speed });
  }

  // Rejoue la dernière trace enregistrée (positions réelles) à vitesse accélérée
  startReplay() {
    const tr = this.trace;
    if (!this.det || !tr || !tr.fixes || !tr.fixes.length) return;
    const fixes = tr.fixes.map(DetectBand.unpack);
    this._play(fixes, 10, 'replay', { of: tr.started, source: tr.source }, true);
  }

  // Lecture accélérée d'une liste de positions : une horloge virtuelle avance de `speed` × le temps réel
  _play(fixes, speed, src, extra, noRecord) {
    this._begin(src, extra, noRecord);
    const stepMs = 200;
    let i = 0, clock = fixes[0].t;
    this.speed = speed;
    this.timer = setInterval(() => {
      clock += stepMs * speed;
      let last = null;
      while (i < fixes.length && fixes[i].t <= clock) last = this._feed(fixes[i++], true);
      if (last) this._showFix(this.fix, true);
      this.progress = i / fixes.length;
      if (i >= fixes.length) this.stop();
    }, stepMs);
  }

  _begin(src, extra, noRecord) {
    this.stop();
    this.det.reset();
    this.src = src;
    this.s = this.det.state;
    this.msg = null;
    this.progress = null;
    this.autoId = null;
    this.lock = null;
    this.lockCand = null;
    this.noRelock.clear();
    this.follow = true;
    const m = this.ctx.map;
    if (m) { m.follow = true; this._afterMapChange(); }
    if (!noRecord) {
      this.trace = { kind: 'bang-lab/detect-trace', v: 1, source: src, started: new Date().toISOString(), ended: null,
        network: { id: this.net.id, name: this.net.name }, ua: navigator.userAgent, opts: extra || null,
        fixes: [], decisions: [] };
      this._decKey = null;
    }
    this._recording = !noRecord;
    if (src === 'gnss') this._wakeLock();
    this.render();
  }

  stop() {
    if (this.watch != null && navigator.geolocation) navigator.geolocation.clearWatch(this.watch);
    this.watch = null;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const was = this.src;
    this.src = null;
    this.lock = null;
    this.lockCand = null;
    this._release();
    if (was && this._recording && this.trace) { this.trace.ended = new Date().toISOString(); this._saveTrace(); }
    this._recording = false;
    if (was) {
      const m = this.ctx.map;
      if (m && this.fix && m.setMe) m.setMe(this.fix.lat, this.fix.lon, { live: false });
      this.render();
    }
  }

  // ----- Positions --------------------------------------------------------------------------------
  _feed(f, batch) {
    const s = this.det.feed(f);
    this.s = s;
    this.fix = f;
    if (this._recording) this._record(f, s);
    this._lockStep(s, f.t || Date.now());
    this._auto();
    if (!batch) this._showFix(f, false);
    return s;
  }

  _showFix(f, fast) {
    if (!f) return;
    const m = this.ctx.map;
    if (m && m.setMe) m.setMe(f.lat, f.lon, { live: true, follow: this.follow, duration: fast ? 150 : 700 });
    this._mark();
    this.render();
  }

  // ----- Verrouillage du suivi -----------------------------------------------------------------------
  // Service affiché par la détection : le service verrouillé, sinon le premier candidat
  _cur() { return this.lock ? this.lockCand : (this.s && this.s.candidates[0]) || null; }

  _lockStep(s, t) {
    if (this.lock) {
      const c = this.lockCand = this.det.track(this.lock.id, t);
      if (!c) { this._unlock('perdu', t); return; }
      const n = c.service.stopTimes.length;
      if (c.fresh && c.index >= n - 2 && c.progress >= 0.97) { this._unlock('fin', t); return; }   // terminus atteint
      if (t - Math.max(c.lastHit || 0, this.lock.since) > DetectBand.LOST_MS) this._unlock('perdu', t);
      return;
    }
    const b = s.best;
    if (s.status === 'locked' && b && !((this.noRelock.get(b.service.id) || 0) > t)) this._lockOn(b.service.id, t, 'auto');
  }

  _lockOn(id, t, how) {
    this.lock = { id, since: t, how };
    this.lockCand = this.det.track(id, t);
    this.msg = null;
    this._event('lock', id, how, t);
    this.render();
  }

  _unlock(reason, t) {
    if (!this.lock) return;
    const id = this.lock.id, sv = this.lockCand && this.lockCand.service, name = sv ? (sv.code || sv.name || '') : '';
    // ne pas se reverrouiller aussitôt sur le même service (terminus, ou service écarté par le conducteur)
    this.noRelock.set(id, t + (reason === 'fin' ? 20 : 10) * 60000);
    this.lock = null;
    this.lockCand = null;
    this.autoId = null;
    this._event('unlock', id, reason, t);
    this.ctx.markProgress(null, null);
    this._say(reason === 'fin' ? 'Service ' + name + ' terminé : suivi déverrouillé.'
      : reason === 'perdu' ? 'Tracé de ' + name + ' perdu depuis 5 min : suivi déverrouillé.'
      : 'Suivi déverrouillé : détection libre.', reason === 'perdu');
  }

  _now() { return (this.det && this.det.lastT) || Date.now(); }

  toggleLock() {
    if (this.lock) { this._unlock('manuel', this._now()); return; }
    const b = this.s && this.s.candidates[0];
    if (b && this.s.status !== 'off' && this.s.status !== 'none') this._lockOn(b.service.id, this._now(), 'manuel');
  }

  _event(event, id, reason, t) {
    if (this._recording && this.trace) this.trace.decisions.push({ t, event, id, reason });
  }

  // Suivi verrouillé : ouvrir la fiche du service si l'utilisateur regarde la vue d'ensemble, sa ligne
  // (ou le service précédemment ouvert automatiquement), ou s'il n'a pas touché l'écran depuis 30 s.
  _auto() {
    const cur = this._cur(), c = this.ctx;
    if (!this.lock || !cur) return;
    const id = this.lock.id;
    if (c.mode === 'service' && c.selSvc === id) { this.autoId = id; return; }
    const idle = Date.now() - (c._userTouch || 0) > DetectBand.RETURN_MS;
    const free = c.mode === 'overview' || c.mode === 'info'
      || (c.mode === 'line' && c.selLine === Network.lineKey(cur.service))          // on regarde déjà sa ligne
      || (this.autoId && c.mode === 'service' && c.selSvc === this.autoId);
    if (!free && !idle) return;
    this.autoId = id;
    c._go('service', { id });
  }

  // Avancement dans la liste d'arrêts du panneau (si le service suivi y est affiché)
  _mark() {
    this._renderTrack();
    const b = this._cur();
    const ok = this.src && b && b.fresh && (this.lock || this.s.status === 'locked' || this.s.status === 'probable');
    this.ctx.markProgress(ok ? b.service.id : null, ok ? b.index : null);
  }
  markNow() { this._mark(); }

  // ----- Trace ------------------------------------------------------------------------------------
  static pack(f) {
    const r = (v, k) => Number.isFinite(v) ? Math.round(v * k) / k : null;
    return [f.t, r(f.lat, 1e6), r(f.lon, 1e6), r(f.acc, 10), r(f.speed, 100), r(f.heading, 10)];
  }
  static unpack(a) { return { t: a[0], lat: a[1], lon: a[2], acc: a[3], speed: a[4], heading: a[5] }; }

  _record(f, s) {
    const tr = this.trace;
    tr.fixes.push(DetectBand.pack(f));
    if (tr.fixes.length > DetectBand.MAX_FIXES) tr.fixes.splice(0, tr.fixes.length - DetectBand.MAX_FIXES);
    const b = s.candidates[0];
    // une décision n'est notée que lorsqu'elle change (statut, service en tête, tronçon)
    const key = s.status + '|' + (b ? b.service.id + '|' + (b.fresh ? b.index : '') : '');
    if (key !== this._decKey) {
      this._decKey = key;
      tr.decisions.push({ t: f.t, status: s.status, n: s.n,
        top: s.candidates.slice(0, 3).map(c => ({ id: c.service.id, code: c.service.code || '', p: Math.round(c.p * 1000) / 1000,
          index: c.fresh ? c.index : null, delay: c.fresh && c.delay != null ? Math.round(c.delay * 10) / 10 : null })) });
    }
    if (this.src === 'gnss' && tr.fixes.length % 20 === 0) this._saveTrace();   // Android peut tuer l'appli : on écrit souvent
  }

  _saveTrace() {
    try { localStorage.setItem(DetectBand.TRACE_KEY, JSON.stringify(this.trace)); }
    catch (e) { this._say('Trace trop volumineuse pour être conservée : exporte-la avant d’arrêter.', true); }
  }

  _loadTrace() {
    try { const t = JSON.parse(localStorage.getItem(DetectBand.TRACE_KEY) || 'null'); return t && Array.isArray(t.fixes) ? t : null; }
    catch (e) { return null; }
  }

  exportTrace() {
    const tr = this.trace;
    if (!tr || !tr.fixes.length) return;
    const d = new Date(tr.started), p = n => String(n).padStart(2, '0');
    const name = 'cadence-trace-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.json';
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify(tr)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      this._say('« ' + name + ' » enregistré dans tes téléchargements.');
    } catch (e) { this._say('Export impossible : ' + (e && e.message || e), true); }
  }

  // ----- Écran allumé -----------------------------------------------------------------------------
  async _wakeLock() {
    if (!navigator.wakeLock || this.wake || document.visibilityState !== 'visible') return;
    try {
      this.wake = await navigator.wakeLock.request('screen');
      this.wake.addEventListener('release', () => { this.wake = null; this.render(); });
      if (!this.src) this._release();
    } catch (e) { this.wake = null; }
    this.render();
  }
  _release() { if (this.wake) { const w = this.wake; this.wake = null; w.release().catch(() => {}); } }

  // ----- Affichage --------------------------------------------------------------------------------
  _say(text, warn, wait) { this.msg = { text, warn: !!warn, wait: !!wait }; this.render(); }

  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); });
  }

  _e(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  _btn(cls, text, fn, label) {
    const b = this._e('button', cls, text);
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    b.addEventListener('click', ev => { ev.stopPropagation(); fn(); });
    return b;
  }
  _badge(sv) {
    const b = this._e('span', 'cm-code cd-code', sv.code || '•');
    if (sv.symcolor0) b.style.background = sv.symcolor0;
    if (sv.symcolor1) b.style.color = sv.symcolor1;
    if (sv.symcolor2) b.style.boxShadow = '0 0 0 2px ' + sv.symcolor2;
    return b;
  }

  _render() {
    this._renderTrack();
    if (!this.det) { this.card.replaceChildren(); return; }
    this.card.classList.toggle('on', !!this.src);
    if (this.src) this._renderLive(); else this._renderIdle();
  }

  _renderIdle() {
    const row = this._e('div', 'cd-row');
    row.insertAdjacentHTML('beforeend', uiSvg('<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>', 'cd-ico'));
    const tx = this._e('div', 'cd-tx');
    tx.appendChild(this._e('b', null, 'Détection du service'));
    const sub = this.msg ? this.msg.text
      : this.s && this.s.n ? 'Arrêtée · ' + this._resultText()
      : 'GNSS · ' + (navigator.wakeLock ? 'l’écran restera allumé' : 'garde l’écran allumé');
    const perm = window.GeoPerm ? GeoPerm.current : 'unknown';
    const blocked = perm === 'denied' || perm === 'insecure' || perm === 'unsupported';
    const permSub = blocked ? 'Position ' + GeoPerm.label(perm).toLowerCase() + ' · touche Aide'
      : perm === 'prompt' ? 'Autorise l’accès à la position pour démarrer' : null;
    tx.appendChild(this._e('small', (this.msg && this.msg.warn) || blocked ? 'cd-warn' : null, this.msg ? this.msg.text : permSub || sub));
    let go;
    if (blocked) go = this._btn('cd-go cd-help', 'Aide', () => GeoPerm.showHelp(perm === 'denied' ? 'denied' : perm));
    else if (perm === 'prompt') go = this._btn('cd-go', 'Autoriser', () => this._askPerm(go));
    else go = this._btn('cd-go', 'Démarrer', () => this.startLive());
    row.append(tx, go);
    const links = this._e('div', 'cd-links');
    const sv = this.simTarget();
    if (sv) links.appendChild(this._btn('cd-link', 'Simuler ' + (sv.code || sv.name || 'ce service'), () => this.startSim(sv)));
    const tr = this.trace;
    if (tr && tr.fixes && tr.fixes.length) {
      links.appendChild(this._e('small', 'cd-tr', 'Trace ' + this._when(tr.started) + ' · ' + tr.fixes.length + ' pos.'));
      links.appendChild(this._btn('cd-link', 'Exporter', () => this.exportTrace()));
      links.appendChild(this._btn('cd-link', 'Rejouer', () => this.startReplay()));
    }
    this.card.replaceChildren(row);
    if (links.childNodes.length) this.card.appendChild(links);
  }

  // Demande d'accès à la position depuis le bandeau ; en cas de succès, l'autorisation suffit (Démarrer s'affiche)
  async _askPerm(btn) {
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    const r = await GeoPerm.request();
    this.msg = null;
    if (!r.ok) GeoPerm.showHelp(r.error);
    else this._say('Position autorisée : touche Démarrer quand tu es dans le véhicule.');
    this.render();
  }

  _resultText() {
    const b = this.s.best;
    return b ? (b.service.code ? b.service.code + ' · ' : '') + (b.service.name || 'service') + ' (' + Math.round(b.p * 100) + ' %)' : 'aucun service identifié';
  }

  _when(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = n => String(n).padStart(2, '0'), today = new Date();
    const hm = p(d.getHours()) + ':' + p(d.getMinutes());
    return d.toDateString() === today.toDateString() ? hm : p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + hm;
  }

  // Avance / retard (minutes, > 0 : en retard). Noir à l'heure ou en retard ; orange au-delà de 3 min d'avance,
  // rouge au-delà de 5 min d'avance (rouler en avance est la faute à éviter).
  static delayInfo(d) {
    if (d == null || !Number.isFinite(d)) return { text: '—', label: 'horaire inconnu', cls: 'na' };
    const m = Math.round(d);
    if (m === 0) return { text: 'À l’heure', label: '', cls: 'ok' };
    if (m > 0) return { text: '+' + m + ' min', label: 'de retard', cls: 'late' };
    const e = -m;
    return { text: '−' + e + ' min', label: 'd’avance', cls: e > 5 ? 'early5' : e > 3 ? 'early3' : 'early' };
  }

  // Ligne de contrôle commune au bandeau et à l'en-tête fusionné : statut, source, précision, suivre, arrêter
  _controlsRow() {
    const LABEL = { none: ['En attente de positions…', 'wait'], off: ['Hors réseau', 'off'], ambiguous: ['Ambigu', 'amb'],
      probable: ['Service probable', 'prob'], locked: ['Service identifié', 'lock'] };
    const s = this.s || { status: 'none', candidates: [], n: 0, matched: 0 };
    let [txt, cls] = LABEL[s.status] || LABEL.none;
    if (this.lock) [txt, cls] = this.lockCand && this.lockCand.fresh ? ['Suivi verrouillé', 'lock'] : ['Hors tracé', 'amb'];
    const row = this._e('div', 'cd-row');
    const pill = this._e('span', 'cd-st ' + cls);
    if (this.lock) pill.insertAdjacentHTML('beforeend', uiSvg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>', 'cd-lk'));
    pill.append(txt);
    row.appendChild(pill);
    const meta = [];
    if (this.src === 'sim') meta.push('simulation × ' + this.speed);
    else if (this.src === 'replay') meta.push('rejeu × ' + this.speed);
    meta.push(s.n + ' pos.');
    if (this.fix && Number.isFinite(this.fix.acc)) meta.push('± ' + Math.round(this.fix.acc) + ' m');
    if (this.src === 'gnss' && navigator.wakeLock && !this.wake) meta.push('écran non maintenu');
    row.appendChild(this._e('small', 'cd-meta', meta.join(' · ')));
    const fol = this._btn('cd-ic' + (this.follow ? ' on' : ''), '', () => {
      this.follow = !this.follow;
      const m = this.ctx.map;
      if (m) m.follow = this.follow;
      if (this.follow && this.fix) this._showFix(this.fix, false); else this.render();
    }, this.follow ? 'Ne plus suivre ma position' : 'Suivre ma position');
    fol.innerHTML = uiSvg('<circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>');
    const stop = this._btn('cd-ic cd-x', '', () => this.stop(), 'Arrêter la détection');
    stop.innerHTML = uiSvg('<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/>');
    // Verrou : fermé = suivi verrouillé (toucher pour libérer la détection) ; ouvert = verrouiller le service en tête
    const canLock = this.lock || (s.candidates[0] && s.status !== 'off' && s.status !== 'none');
    if (canLock) {
      const lk = this._btn('cd-ic' + (this.lock ? ' on' : ''), '', () => this.toggleLock(),
        this.lock ? 'Déverrouiller le suivi' : 'Verrouiller le suivi sur ce service');
      lk.innerHTML = uiSvg(this.lock ? '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>'
        : '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 7.6-1.7"/>');
      row.appendChild(lk);
    }
    if (this.ctx.engine === 'gl') row.appendChild(fol);    // la carte SVG de secours ne sait pas suivre
    row.appendChild(stop);
    return row;
  }

  // Le service détecté est-il celui affiché dans le panneau ? Alors bandeau et fiche fusionnent.
  _tracking() {
    const s = this.s, b = this._cur(), c = this.ctx;
    if (!this.src || !b || c.mode !== 'service' || c.selSvc !== b.service.id) return null;
    return this.lock || (b.fresh && s.status !== 'off' && s.status !== 'none') ? b : null;
  }

  // En-tête fusionné (dans la barre collante de la fiche du service) : statut et commandes, avance / retard en grand,
  // horaire prévu au prochain arrêt, avancement sur le tronçon. Le bandeau séparé est alors masqué.
  _renderTrack() {
    const b = this._tracking(), bar = this.ctx.bar;
    this.el.classList.toggle('cd-merged', !!b);
    if (!b) { if (this.trk && this.trk.parentNode) this.trk.remove(); return; }
    if (!this.trk) { this.trk = this._e('div', 'cd-trk'); }
    const di = b.fresh ? DetectBand.delayInfo(b.delay) : { text: 'Hors tracé', label: 'position éloignée du service', cls: 'off' };
    const main = this._e('div', 'cd-trk-main');
    const dl = this._e('div', 'cd-delay ' + di.cls);
    dl.append(this._e('b', null, di.text));
    if (di.label) dl.appendChild(this._e('span', null, di.label));
    main.appendChild(dl);
    if (b.fresh && b.next) {
      const arr = b.next.arrival != null ? b.next.arrival : b.next.departure;
      const nx = this._e('div', 'cd-trk-at');
      nx.append(this._e('span', null, 'Prochain arrêt prévu'), this._e('b', null, arr ? arr.slice(0, 5) : '—'));
      main.appendChild(nx);
    }
    const kids = [this._controlsRow()];
    if (this.msg) kids.push(this._e('small', 'cd-msg' + (this.msg.warn ? ' cd-warn' : ''), this.msg.text));
    kids.push(main);
    const pr = this._e('div', 'cd-prog'), fill = this._e('i');
    fill.style.width = Math.round((b.progress || 0) * 100) + '%';
    pr.appendChild(fill);
    kids.push(pr);
    this.trk.replaceChildren(...kids);
    if (this.trk.parentNode !== bar) bar.appendChild(this.trk);
  }

  _renderLive() {
    const s = this.s || { status: 'none', candidates: [], n: 0, matched: 0 };
    this.card.replaceChildren(this._controlsRow());

    if (this.msg) this.card.appendChild(this._e('small', 'cd-msg' + (this.msg.warn ? ' cd-warn' : ''), this.msg.text));

    // Ligne 2 : service suivi ou en tête (touchable : ouvre sa fiche) ; ligne 3 : prochain arrêt, avance / retard
    const b = this._cur();
    if (b && (this.lock || (s.status !== 'off' && s.status !== 'none'))) {
      const sv = b.service;
      const btn = this._btn('cd-svc', '', () => this.ctx._go('service', { id: sv.id }), 'Voir le service ' + (sv.name || sv.code || ''));
      btn.append(this._badge(sv), this._e('b', 'cd-n', sv.name || sv.code || 'Service'));
      if (!this.lock) btn.appendChild(this._e('span', 'cd-p', Math.round(b.p * 100) + ' %'));   // verrouillé : la probabilité n'importe plus
      const others = s.candidates.slice(1).filter(x => x.p >= 0.05).length;
      if (!this.lock && s.status === 'ambiguous' && others) btn.appendChild(this._e('small', 'cd-more', '+' + others));
      btn.insertAdjacentHTML('beforeend', uiSvg('<path d="M9 5l7 7-7 7"/>', 'cd-chev'));
      this.card.appendChild(btn);
      if (b.fresh && b.next) {
        const arr = b.next.arrival != null ? b.next.arrival : b.next.departure;
        const di = DetectBand.delayInfo(b.delay);
        const l = ['→ ' + b.next.stop.name + (arr ? ' ' + arr.slice(0, 5) : '')];
        if (b.delay != null) l.push(di.text + (di.label ? ' ' + di.label : ''));
        const nx = this._e('small', 'cd-next ' + di.cls, l.join(' · '));
        this.card.appendChild(nx);
      }
    }
    // Barre fine : avancement sur le tronçon (ou dans le rejeu / la simulation)
    const pr = this._e('div', 'cd-prog'), fill = this._e('i');
    const v = b && b.fresh && (this.lock || s.status === 'locked' || s.status === 'probable') ? b.progress : null;
    if (v != null) fill.style.width = Math.round(v * 100) + '%';
    else if (this.progress != null) { fill.style.width = Math.round(this.progress * 100) + '%'; fill.className = 'alt'; }
    else pr.hidden = true;
    pr.appendChild(fill);
    this.card.appendChild(pr);
  }

  _injectStyle() {
    if (document.getElementById('cd-style')) return;
    const st = document.createElement('style');
    st.id = 'cd-style';
    st.textContent = `
      .cd-band{flex:none;position:relative;z-index:1;background:var(--background-color);padding:.1em .8em .45em}
      .cd-band[hidden]{display:none}
      .cd-card{position:relative;overflow:hidden;background:#fff;border-radius:16px;box-shadow:0 1px 6px rgba(17,94,136,.12);
        padding:.5em .6em .55em .75em;display:flex;flex-direction:column;gap:.3em}
      .cd-card.on{box-shadow:0 1px 6px rgba(17,94,136,.12),inset 3px 0 0 var(--accent-color)}
      .cd-row{display:flex;align-items:center;gap:.55em;min-width:0}
      .cd-ico{width:22px;height:22px;flex:none;color:var(--accent-color)}
      .cd-tx{flex:1;min-width:0}
      .cd-tx b{display:block;font-size:.95em}
      .cd-tx small,.cd-meta,.cd-next,.cd-msg{display:block;color:var(--inactive-color);font-size:.78em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .cd-meta{flex:1;min-width:0}
      .cd-warn{color:#b3261e!important}
      .cd-go,.cd-go:hover{flex:none;border-radius:999px;padding:.45em 1.1em;background:var(--accent-color);color:#fff;font-weight:600;font-size:.88em}
      .cd-go[disabled]{opacity:.6}
      .cd-help,.cd-help:hover{background:#fbe2e0;color:#b3261e}
      .cd-ic,.cd-ic:hover{flex:none;width:2.1em;height:2.1em;padding:0;border-radius:50%;background:#eef3f7;color:var(--inactive-color);
        display:flex;align-items:center;justify-content:center}
      .cd-ic svg{width:1.15em;height:1.15em}
      .cd-ic.on,.cd-ic.on:hover{background:#e0eefa;color:var(--accent-color)}
      .cd-x,.cd-x:hover{background:#fbe2e0;color:#b3261e}
      .cd-links{display:flex;flex-wrap:wrap;align-items:center;gap:.35em .4em}
      .cd-link,.cd-link:hover{border-radius:999px;padding:.25em .8em;background:#eef3f7;color:var(--accent-color);font-size:.78em;font-weight:600}
      .cd-tr{color:var(--inactive-color);font-size:.75em}
      .cd-st{flex:none;border-radius:999px;padding:.2em .75em;font-weight:700;font-size:.8em;white-space:nowrap}
      .cd-st.wait,.cd-st.off{background:#eceff2;color:#5b6772}
      .cd-st.amb{background:#fff0d1;color:#9a6200}
      .cd-st.prob{background:#e0eefa;color:#115e88}
      .cd-st.lock{background:#dff3e6;color:#1c7a4d}
      .cd-svc,.cd-svc:hover{display:flex;align-items:center;gap:.55em;width:100%;min-width:0;padding:.1em 0;margin:0;border-radius:0;
        background:none;color:inherit;text-align:left;font-size:1em}
      .cd-code{flex:none;font-size:.82em;padding:.18em .7em}
      .cd-n{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:.95em}
      .cd-p{flex:none;font-weight:700;font-variant-numeric:tabular-nums}
      .cd-more{flex:none;color:#9a6200;font-weight:700;font-size:.78em}
      .cd-chev{width:16px;height:16px;flex:none;color:var(--inactive-color)}
      .cd-next{color:#111}
      .cd-next.early3{color:#c25e00;font-weight:700}
      .cd-next.early5{color:#c62828;font-weight:700}
      .cd-band.cd-merged{display:none}
      .cd-trk{flex-basis:100%;position:relative;display:flex;flex-direction:column;gap:.45em;margin:.35em 0 .1em;padding:.55em .75em .7em;
        background:#fff;border-radius:16px;box-shadow:0 1px 6px rgba(17,94,136,.12),inset 3px 0 0 var(--accent-color);overflow:hidden}
      .cd-trk-main{display:flex;align-items:flex-end;justify-content:space-between;gap:.8em}
      .cd-delay{display:flex;align-items:baseline;gap:.4em;color:#111;min-width:0}
      .cd-delay b{font-size:2em;line-height:1;font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap}
      .cd-delay span{font-size:1em;font-weight:600}
      .cd-delay.early3{color:#c25e00}
      .cd-delay.early5{color:#c62828}
      .cd-delay.na{color:var(--inactive-color)}
      .cd-delay.na b{font-size:1.3em}
      .cd-delay.off{color:#9a6200;flex-direction:column;align-items:flex-start;gap:.15em}
      .cd-delay.off b{font-size:1.4em}
      .cd-delay.off span{font-size:.8em;font-weight:500}
      .cd-st{display:inline-flex;align-items:center;gap:.3em}
      .cd-lk{width:1em;height:1em;flex:none}
      .cd-trk-at{flex:none;text-align:right;line-height:1.15}
      .cd-trk-at span{display:block;font-size:.72em;color:var(--inactive-color)}
      .cd-trk-at b{font-size:1.35em;font-variant-numeric:tabular-nums}
      .cd-prog{position:absolute;left:0;right:0;bottom:0;height:3px;background:#e3e9ee}
      .cd-prog[hidden]{display:none}
      .cd-prog i{display:block;height:100%;background:var(--accent-color);transition:width .3s}
      .cd-prog i.alt{background:#9fb4c4}
    `;
    document.head.appendChild(st);
  }
}

window.DetectBand = DetectBand;
