'use strict';
/* Matinee: random public-domain films from the Internet Archive, docked under the file list. */
const { Plugin, PluginSettingTab, Setting, requestUrl, setIcon } = require('obsidian');

const SHELVES = {
  noir: { name: 'Film noir', q: 'collection:film_noir' },
  scifi: { name: 'Sci-fi and horror', q: 'collection:SciFi_Horror AND year:[1910 TO 1959]' },
  silent: { name: 'Silent era', q: '(collection:silent_films OR (collection:feature_films AND year:[1895 TO 1929]))' },
  features: { name: 'Classic features', q: 'collection:feature_films AND year:[1925 TO 1955]' },
  shorts: { name: 'Newsreels and shorts', q: 'collection:prelinger AND year:[1920 TO 1955]' },
  cartoons: { name: 'Early cartoons', q: 'collection:classic_cartoons AND year:[1915 TO 1945]' }
};
const DEFAULTS = {
  enabled: true,
  shelves: { noir: true, scifi: true, silent: true, features: true, shorts: true, cartoons: false },
  position: 'bottom', mono: true, randomStart: true, muted: true, volume: 0.5, aspect: '4:3', fill: 'cover', recent: []
};
// smaller web versions first: plenty for a sidebar and kinder to your connection
const FORMATS = ['512Kb MPEG4', 'MPEG4', 'h.264', 'h.264 IA', 'Ogg Video'];
const pick = a => a[Math.floor(Math.random() * a.length)];

module.exports = class Matinee extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.settings.shelves = Object.assign({}, DEFAULTS.shelves, this.settings.shelves);
    this.counts = {};
    this.film = null;
    this.fails = 0;
    this.build();
    this.addSettingTab(new MatineeSettings(this.app, this));

    this.addCommand({ id: 'next-film', name: 'Next film', callback: () => this.next() });
    this.addCommand({ id: 'toggle-panel', name: 'Show or hide the film', callback: () => this.setEnabled(!this.settings.enabled) });
    this.addCommand({ id: 'toggle-sound', name: 'Sound on or off', callback: () => this.setMuted(!this.settings.muted) });

    this.app.workspace.onLayoutReady(() => { this.place(); if (this.settings.enabled) this.next(); });
    this.registerEvent(this.app.workspace.on('layout-change', () => this.place()));
    this.registerDomEvent(document, 'visibilitychange', () => this.autoPause());
  }

  onunload() { this.video && this.video.removeAttribute('src'); this.video && this.video.load(); this.host && this.host.remove(); }

  save() { return this.saveData(this.settings); }

  /* ---------- the screen ---------- */
  build() {
    const host = this.host = createDiv({ cls: 'mat-host' });
    const v = this.video = host.createEl('video', { cls: 'mat-video', attr: { playsinline: '', preload: 'metadata', disablepictureinpicture: '' } });
    v.muted = this.settings.muted; v.volume = this.settings.volume;
    this.msg = host.createDiv({ cls: 'mat-msg' });
    const top = host.createDiv({ cls: 'mat-top' });
    this.titleEl = top.createDiv({ cls: 'mat-title' });
    this.yearEl = top.createDiv({ cls: 'mat-year' });
    const bar = host.createDiv({ cls: 'mat-bar' });
    const btn = (icon, label, fn) => { const b = bar.createEl('button', { cls: 'mat-btn clickable-icon', attr: { 'aria-label': label } }); setIcon(b, icon); b.addEventListener('click', e => { e.stopPropagation(); fn(); }); return b; };
    this.bPlay = btn('pause', 'Pause', () => this.togglePlay());
    this.bNext = btn('shuffle', 'Another film', () => this.next());
    this.bSound = btn('volume-x', 'Sound on', () => this.setMuted(!this.settings.muted));
    bar.createDiv({ cls: 'mat-gap' });
    this.bOpen = btn('external-link', 'Open on archive.org', () => this.film && window.open('https://archive.org/details/' + encodeURIComponent(this.film.id)));

    v.addEventListener('loadedmetadata', () => {
      if (this.settings.randomStart && isFinite(v.duration) && v.duration > 300) v.currentTime = v.duration * (0.05 + Math.random() * 0.65);
    });
    v.addEventListener('playing', () => { this.fails = 0; this.say(''); this.paintButtons(); });
    v.addEventListener('pause', () => this.paintButtons());
    v.addEventListener('ended', () => this.next());
    v.addEventListener('error', () => { if (v.getAttribute('src')) this.retry(); });
    this.applyLook();
  }

  applyLook() {
    const s = this.settings, h = this.host;
    h.toggleClass('is-mono', s.mono);
    h.toggleClass('is-wide', s.aspect === '16:9');
    h.toggleClass('is-fit', s.fill === 'contain');
    h.toggleClass('mat-hidden', !s.enabled);
    this.paintButtons();
  }

  paintButtons() {
    if (!this.bPlay) return;
    const playing = !this.video.paused;
    setIcon(this.bPlay, playing ? 'pause' : 'play'); this.bPlay.setAttr('aria-label', playing ? 'Pause' : 'Play');
    setIcon(this.bSound, this.settings.muted ? 'volume-x' : 'volume-2'); this.bSound.setAttr('aria-label', this.settings.muted ? 'Sound on' : 'Sound off');
  }

  say(text) { this.msg.setText(text); this.msg.toggleClass('is-on', !!text); }

  // Sit at the bottom of the lowest panel in the left sidebar: under the file list, above the vault name
  place() {
    const split = this.app.workspace.leftSplit && this.app.workspace.leftSplit.containerEl;
    if (!split) return;
    const groups = Array.from(split.querySelectorAll(':scope > .workspace-tabs'));
    const top = this.settings.position === 'top';
    const target = groups.length ? groups[top ? 0 : groups.length - 1] : split;
    this.host.toggleClass('is-top', top);
    if (this.host.parentElement !== target) {
      const wasPlaying = !this.video.paused;
      if (top) target.insertBefore(this.host, target.firstChild); else target.appendChild(this.host);
      if (wasPlaying) this.video.play().catch(() => {});   // moving a video pauses it
    }
    this.autoPause();
  }

  autoPause() {
    const collapsed = this.app.workspace.leftSplit && this.app.workspace.leftSplit.collapsed;
    const away = document.hidden || collapsed || !this.settings.enabled;
    if (away && !this.video.paused) { this.video.pause(); this.pausedByUs = true; }
    else if (!away && this.pausedByUs) { this.pausedByUs = false; this.video.play().catch(() => {}); }
  }

  /* ---------- choosing a film ---------- */
  async search(key, rows, page) {
    const q = `(${SHELVES[key].q}) AND mediatype:movies`;
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=year&rows=${rows}&page=${page}&output=json`;
    const r = await requestUrl({ url, throw: true });
    return r.json.response;
  }

  async findFilm() {
    const keys = Object.keys(SHELVES).filter(k => this.settings.shelves[k]);
    if (!keys.length) keys.push('features');
    for (let attempt = 0; attempt < 6; attempt++) {
      const key = pick(keys);
      if (this.counts[key] == null) this.counts[key] = (await this.search(key, 0, 1)).numFound || 0;
      const n = this.counts[key];
      if (!n) continue;
      const page = 1 + Math.floor(Math.random() * Math.ceil(n / 50));
      const docs = ((await this.search(key, 50, page)).docs || []).filter(d => !this.settings.recent.includes(d.identifier));
      if (!docs.length) continue;
      const doc = pick(docs);
      const meta = (await requestUrl({ url: 'https://archive.org/metadata/' + encodeURIComponent(doc.identifier), throw: true })).json;
      const files = (meta && meta.files) || [];
      let file = null;
      for (const f of FORMATS) { file = files.find(x => x.format === f && /\.(mp4|m4v|ogv)$/i.test(x.name)); if (file) break; }
      if (!file) file = files.find(x => /\.mp4$/i.test(x.name));
      if (!file) continue;
      const m = meta.metadata || {}, one = x => Array.isArray(x) ? x[0] : x;
      return {
        id: doc.identifier,
        title: one(m.title) || doc.title || doc.identifier,
        year: one(m.year) || (one(m.date) || '').slice(0, 4) || doc.year || '',
        url: `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${file.name.split('/').map(encodeURIComponent).join('/')}`
      };
    }
    return null;
  }

  async next() {
    if (!this.settings.enabled || this.busy) return;
    this.busy = true;
    this.say(this.film ? '' : 'Finding a film…');
    try {
      const film = await this.findFilm();
      if (!film) throw new Error('none');
      this.film = film;
      this.settings.recent = [film.id].concat(this.settings.recent.filter(x => x !== film.id)).slice(0, 40);
      this.save();
      this.titleEl.setText(film.title); this.yearEl.setText(film.year ? String(film.year) : '');
      this.video.src = film.url;
      this.video.muted = this.settings.muted;
      await this.video.play().catch(() => {});
      this.autoPause();
    } catch (e) {
      this.retry();
    } finally { this.busy = false; }
  }

  retry() {
    this.fails++;
    if (this.fails < 4) { window.setTimeout(() => this.next(), 800); return; }
    this.say("Can't reach archive.org right now. Trying again in a minute.");
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => { this.fails = 0; this.next(); }, 60000);
  }

  togglePlay() { this.pausedByUs = false; if (this.video.paused) this.video.play().catch(() => {}); else this.video.pause(); }

  setMuted(m) { this.settings.muted = m; this.video.muted = m; this.paintButtons(); this.save(); }

  setEnabled(on) {
    this.settings.enabled = on; this.applyLook(); this.save();
    if (on && !this.film) this.next(); else this.autoPause();
  }
};

class MatineeSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const p = this.plugin, s = p.settings, el = this.containerEl;
    el.empty();
    const changed = () => { p.applyLook(); p.save(); };
    new Setting(el).setName('Show the film').setDesc('The screen sits under your file list, above the vault name.')
      .addToggle(t => t.setValue(s.enabled).onChange(v => p.setEnabled(v)));
    new Setting(el).setName('Position').setDesc('Where the screen sits in the left sidebar.')
      .addDropdown(d => d.addOptions({ top: 'Top of the sidebar', bottom: 'Bottom, above the vault name' }).setValue(s.position).onChange(v => { s.position = v; p.save(); p.place(); }));
    new Setting(el).setName('What to show').setHeading();
    for (const k in SHELVES) {
      new Setting(el).setName(SHELVES[k].name).addToggle(t => t.setValue(!!s.shelves[k]).onChange(v => { s.shelves[k] = v; p.save(); }));
    }
    new Setting(el).setName('Picture').setHeading();
    new Setting(el).setName('Always black and white').setDesc('Turns any colour film grey, so the look stays consistent.')
      .addToggle(t => t.setValue(s.mono).onChange(v => { s.mono = v; changed(); }));
    new Setting(el).setName('Shape').addDropdown(d => d.addOptions({ '4:3': 'Classic 4:3', '16:9': 'Wide 16:9' }).setValue(s.aspect).onChange(v => { s.aspect = v; changed(); }));
    new Setting(el).setName('Fit').setDesc('Fill crops the edges so the screen has no black bars.')
      .addDropdown(d => d.addOptions({ cover: 'Fill the screen', contain: 'Show the whole picture' }).setValue(s.fill).onChange(v => { s.fill = v; changed(); }));
    new Setting(el).setName('Start part-way through').setDesc('Drop into a random scene instead of the opening credits.')
      .addToggle(t => t.setValue(s.randomStart).onChange(v => { s.randomStart = v; p.save(); }));
    new Setting(el).setName('Sound').setHeading();
    new Setting(el).setName('Start muted').addToggle(t => t.setValue(s.muted).onChange(v => p.setMuted(v)));
    new Setting(el).setName('Volume').addSlider(sl => sl.setLimits(0, 1, 0.05).setValue(s.volume).setDynamicTooltip().onChange(v => { s.volume = v; p.video.volume = v; p.save(); }));
    new Setting(el).setName('Another film now').addButton(b => b.setButtonText('Shuffle').onClick(() => p.next()));
  }
}
