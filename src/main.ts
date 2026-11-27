import * as THREE from 'three';
import { DATA_AS_OF, DEFAULT_PART_LIMIT, MAX_LEVEL, WIKI_URL } from './constants';
import { CATEGORIES, PART_ORDER, PARTS, type Category } from './data';
import { Editor } from './editor';
import { I } from './icons';
import { costLine, esc, levelName, renderMaterials, renderMeters, renderPhases, renderRaid, renderUpkeep, shoppingText } from './panels';
import {
  currentDesignId, decodeShare, deleteDesign, encodeShare, listDesigns, loadSettings, newId, sanitize, saveDesign, saveSettings,
  strip, type Design, type Settings,
} from './persist';
import { analyseRaid, type Metric, type RaidTarget } from './raidpath';
import { anchorFrom, exportDze, MAPS, piecesFromDze, readDze, type Anchor, type ExportMode } from './dayz';
import { Store, type Piece } from './store';
import { renderThumbs } from './thumbs';
import { WalkMode } from './walk';
import { instance, loadModel, missingTextures, modelName, openedPbos, openPbos, placeholder, placeSite, pboModels, sanitizeSites, siteKey, type SiteRef } from './house';

const hasOwn = Object.prototype.hasOwnProperty;
const timeFormatter = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const nameCollator = new Intl.Collator();
const MAX_JSON_IMPORT_BYTES = 20 * 1024 * 1024;

const CAT_COUNTS: Record<Category, number> = { wood: 0, cinder: 0, metal: 0, fort: 0, general: 0, furniture: 0 };
for (const id of PART_ORDER) CAT_COUNTS[PARTS[id].cat]++;

// ------------------------------------------------------------------ layout
const app = document.getElementById('app')!;
app.innerHTML = `
<div class="stage">
  <div id="viewport"></div>

  <div class="float topleft">
    <div class="brand">${I.logo}<div><b>Basis-Planer</b><small>für Aftermath · inoffiziell</small></div></div>
    <div class="rel"><button class="btn" id="designsBtn">${I.folder} Pläne ${I.chevron}</button><div class="menu" id="designsMenu" hidden></div></div>
    <input class="design-name" id="designName" maxlength="60" spellcheck="false">
    <span class="save-state" id="saveState">Gespeichert</span>
  </div>

  <div class="float toolbar">
    <button class="tb" id="tbUndo" data-tip="Rückgängig (Strg+Z)">${I.undo}</button>
    <button class="tb" id="tbRedo" data-tip="Wiederholen (Strg+Y)">${I.redo}</button>
    <span class="tb-sep"></span>
    <button class="tb on" id="tbSnap" data-tip="Einrasten an/aus (X)">${I.magnet}</button>
    <button class="tb" id="tbWalk" data-tip="Durch die Basis laufen (V)">${I.walk}</button>
    <button class="tb" id="tbFrame" data-tip="Ganze Basis zeigen (F)">${I.frame}</button>
    <button class="tb on" id="tbTerritory" data-tip="Territorium anzeigen (T)">${I.territory}</button>
    <span class="tb-sep"></span>
    <button class="tb" id="tbShot" data-tip="Screenshot speichern">${I.camera}</button>
    <button class="tb" id="tbShare" data-tip="Teilen-Link kopieren">${I.share}</button>
    <button class="tb" id="tbHouse" data-tip="Gebäude aus DayZ-Dateien laden">${I.house}</button>
    <button class="tb" id="tbDayz" data-tip="In DayZ ansehen (Export für DayZ Editor)">${I.globe}</button>
    <button class="tb" id="tbHelp" data-tip="Hilfe & Tastatur (?)">${I.help}</button>
    <button class="tb on" id="tbPanel" data-tip="Seitenleiste ein/aus">${I.panel}</button>
  </div>

  <div class="float levels" id="levels"></div>

  <aside class="float panel" id="panel">
    <div class="tabs">
      <button class="tab on" data-tab="mat">Material</button>
      <button class="tab" data-tab="phase">Ebenen</button>
      <button class="tab" data-tab="upkeep">Unterhalt</button>
      <button class="tab" data-tab="raid">Raid</button>
    </div>
    <div class="panel-body"><div id="meters"></div><div id="tabBody"></div></div>
    <div class="foot">Daten: <a href="${WIKI_URL}" target="_blank" rel="noopener">Aftermath-Wiki</a>, Stand ${DATA_AS_OF} · inoffizielles Fan-Tool</div>
  </aside>

  <div class="float status" id="status" hidden></div>
  <div class="float selcard" id="selcard" hidden></div>

  <div id="walkLayer" hidden>
    <div class="crosshair"></div>
    <div class="walkhint" id="walkHint" hidden></div>
    <div class="float walkcta" id="walkCta"><b>Klicken zum Umsehen</b><span style="color:var(--muted)">Esc gibt die Maus frei, nochmal Esc beendet</span></div>
    <div class="float walkhud" id="walkHud"></div>
  </div>

  <div class="toast" id="toast"></div>
  <div class="help-wrap" id="help" hidden></div>
  <input type="file" id="importFile" accept=".json,application/json" hidden>
  <input type="file" id="dzeAnchorFile" accept=".dze" hidden>
  <input type="file" id="dzeImportFile" accept=".dze" hidden>
  <div class="help-wrap" id="dayz" hidden></div>
  <div class="help-wrap" id="houses" hidden></div>
  <input type="file" id="pboFile" accept=".pbo" multiple hidden>
  <input type="file" id="pboDir" webkitdirectory multiple hidden>
</div>
<footer class="catalog" id="catalog">
  <div class="cat-head" id="catHead"></div>
  <div class="cards" id="cards"></div>
</footer>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------------- state
const store = new Store();
let settings: Settings = loadSettings({
  upkeepPrices: {}, partLimit: DEFAULT_PART_LIMIT, rawNails: false, rawSheet: false, rawPlanks: false,
});
let design: Design = { id: newId(), name: 'Meine Basis', updated: Date.now(), pieces: [] };
// buildings from the game files (declared early: boot() opens a design right away)
let sites: SiteRef[] = [];
const siteObjects = new Map<string, THREE.Object3D>();
const siteState = new Map<string, 'ok' | 'missing' | 'error' | 'loading'>();
/** models of all opened PBOs */
let catalog: { pbo: string; pboLow: string; name: string; nameLow: string; size: number; building: boolean }[] | null = null;
let onlyBuildings = true;
let houseQuery = '';
let houseBusy = '';

let tab: 'mat' | 'phase' | 'upkeep' | 'raid' = 'mat';
let catTab: Category = 'wood';
let search = '';
const thumbs = new Map<string, HTMLCanvasElement>();
const route: { target: RaidTarget | null; metric: Metric; picking: boolean } = { target: null, metric: 'charges', picking: false };

const editor = new Editor($('viewport'), store, {
  onPreview: () => renderStatus(),
  onSelect: () => renderSelection(),
  onMoveChange: () => renderStatus(),
  onMoveRejected: (reason) => toast(`Nicht verschoben: ${reason}`),
  onRaidPick: (on) => {
    route.picking = on;
    if (tab === 'raid') renderPanel();
  },
  onRaidTarget: (t) => {
    route.target = t;
    renderPanel();
  },
});
editor.partLimit = settings.partLimit;
if (import.meta.env.DEV) Object.assign(window, { __ed: editor, __store: store });

// --------------------------------------------------------------- walk HUD
let lastWalkHudKey = '';
let lastWalkHint: string | null = null;
const walk = new WalkMode(
  editor,
  {
    show(v) {
      $('walkLayer').hidden = !v;
      $('catalog').style.display = v ? 'none' : '';
      for (const id of ['panel', 'levels', 'status', 'selcard']) $(id).style.visibility = v ? 'hidden' : '';
      document.querySelector<HTMLElement>('.toolbar')!.style.visibility = v ? 'hidden' : '';
      document.querySelector<HTMLElement>('.topleft')!.style.visibility = v ? 'hidden' : '';
      if (!v) {
        lastWalkHudKey = '';
        lastWalkHint = null;
      }
    },
    update(s) {
      $('walkCta').hidden = s.locked;
      const hintText = s.hint ?? '';
      if (hintText !== lastWalkHint) {
        lastWalkHint = hintText;
        const hint = $('walkHint');
        hint.hidden = !hintText;
        hint.textContent = hintText;
      }
      const hudKey = `${s.stance}|${s.noclip ? 1 : 0}`;
      if (hudKey !== lastWalkHudKey) {
        lastWalkHudKey = hudKey;
        const st = { stand: 'Stehend', crouch: 'Geduckt', prone: 'Liegend' }[s.stance];
        $('walkHud').innerHTML = `
          <span class="pill on">${I.walk.replace('<svg', '<svg width="14" height="14"')} Laufmodus</span>
          <span class="pill">${st}</span>
          <span class="pill ${s.noclip ? 'on' : ''}">No-Clip ${s.noclip ? 'an' : 'aus'}</span>
          <span class="k"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> gehen · <kbd>Shift</kbd> rennen · <kbd>Leertaste</kbd> springen ·
          <kbd>C</kbd> ducken · <kbd>Z</kbd> hinlegen · <kbd>F</kbd> Tür · <kbd>N</kbd> No-Clip · <kbd>Esc</kbd> beenden</span>
          <button class="btn" id="walkExit">Beenden</button>`;
        $('walkExit').onclick = () => walk.exit();
      }
    },
  },
  () => renderToolbar(),
);

if (import.meta.env.DEV) Object.assign(window, { __walk: walk });

// ----------------------------------------------------------------- helpers
let toastTimer = 0;
function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2600);
}

function download(name: string, href: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
}

function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  download(name, url);
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const fileSafe = (s: string) => s.replace(/[^\w\-äöüÄÖÜß ]+/g, '').trim().replace(/\s+/g, '-') || 'basis';

// --------------------------------------------------------------- designs
let saveTimer = 0;
function markDirty() {
  $('saveState').textContent = 'Speichert …';
  $('saveState').classList.add('dirty');
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(persistNow, 500);
}

function persistNow() {
  design.pieces = strip(store.all());
  design.sites = sites.map((s) => ({ ...s }));
  design.name = ($('designName') as HTMLInputElement).value.trim() || 'Unbenannt';
  design.updated = Date.now();
  try {
    saveDesign(design);
    const t = timeFormatter.format(new Date());
    $('saveState').textContent = `Gespeichert ${t}`;
    $('saveState').classList.remove('dirty');
  } catch {
    $('saveState').textContent = 'Speichern fehlgeschlagen';
  }
}

function openDesign(d: Design) {
  clearTimeout(saveTimer);
  design = d;
  ($('designName') as HTMLInputElement).value = d.name;
  store.load(d.pieces);
  sites = (d.sites ?? []).map((s) => ({ ...s }));
  void syncSites();
  editor.setActivePart(null);
  editor.frameAll();
  try {
    saveDesign(design);
  } catch {
    /* private mode or quota exceeded */
  }
  $('saveState').textContent = 'Gespeichert';
  $('saveState').classList.remove('dirty');
  renderAll();
}

function renderDesignsMenu() {
  const list = listDesigns();
  const m = $('designsMenu');
  m.innerHTML = `
    <h6>Deine Pläne</h6>
    ${list
      .map((d) => `<button class="menu-item ${d.id === design.id ? 'current' : ''}" data-open="${esc(d.id)}">${I.folder}<span>${esc(d.name)}</span><small>${d.pieces.length} Teile</small></button>`)
      .join('') || '<div class="info" style="padding:0 8px">Noch keine.</div>'}
    <hr>
    <button class="menu-item" data-act="new">${I.plus}<span>Neuer Plan</span></button>
    <button class="menu-item" data-act="dup">${I.copy}<span>Plan duplizieren</span></button>
    <button class="menu-item" data-act="export">${I.download}<span>Als Datei exportieren (.json)</span></button>
    <button class="menu-item" data-act="import">${I.upload}<span>Datei importieren</span></button>
    <button class="menu-item" data-act="dze-import">${I.globe}<span>Aus DayZ Editor importieren (.dze)</span></button>
    <button class="menu-item" data-act="clear">${I.trash}<span>Alle Teile entfernen</span></button>
    <button class="menu-item" data-act="delete">${I.trash}<span>Plan löschen</span></button>`;
}

$('designsBtn').onclick = (e) => {
  e.stopPropagation();
  const m = $('designsMenu');
  if (m.hidden) renderDesignsMenu();
  m.hidden = !m.hidden;
};
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('#designsMenu')) $('designsMenu').hidden = true;
});
$('designsMenu').onclick = (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  persistNow();
  const open = b.dataset.open;
  if (open) {
    const d = listDesigns().find((x) => x.id === open);
    if (d) openDesign(d);
  }
  switch (b.dataset.act) {
    case 'new':
      openDesign({ id: newId(), name: 'Neue Basis', updated: Date.now(), pieces: [] });
      break;
    case 'dup':
      openDesign({ ...design, id: newId(), name: design.name + ' (Kopie)', pieces: strip(store.all()), sites: sites.map((s) => ({ ...s })) });
      break;
    case 'export': {
      const blob = new Blob([JSON.stringify({ app: 'aftermath-base-planner', v: 1, name: design.name, pieces: strip(store.all()), sites }, null, 1)], { type: 'application/json' });
      downloadBlob(fileSafe(design.name) + '.json', blob);
      break;
    }
    case 'dze-import':
      $('dzeImportFile').click();
      break;
    case 'import':
      $('importFile').click();
      break;
    case 'clear':
      if (store.pieces.size && confirm('Alle Teile dieses Plans entfernen? (Rückgängig mit Strg+Z möglich)')) store.clear();
      break;
    case 'delete':
      if (confirm(`Plan „${design.name}“ endgültig löschen?`)) {
        deleteDesign(design.id);
        const next = listDesigns()[0];
        openDesign(next ?? { id: newId(), name: 'Meine Basis', updated: Date.now(), pieces: [] });
      }
      break;
  }
  $('designsMenu').hidden = true;
};

($('importFile') as HTMLInputElement).onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  if (f.size > MAX_JSON_IMPORT_BYTES) {
    toast('Datei ist zu groß (max. 20 MB)');
    return;
  }
  try {
    const data: unknown = JSON.parse(await f.text());
    if (!data || typeof data !== 'object') throw new Error('invalid');
    const obj = data as { name?: unknown; pieces?: unknown; sites?: unknown };
    const pieces = sanitize(obj.pieces);
    const rawName = typeof obj.name === 'string' && obj.name.trim() ? obj.name : f.name.replace(/\.json$/i, '');
    openDesign({ id: newId(), name: rawName.slice(0, 60), updated: Date.now(), pieces, sites: sanitizeSites(obj.sites) });
    toast(`${pieces.length} Teile importiert`);
  } catch {
    toast('Datei konnte nicht gelesen werden');
  }
};

$('designName').addEventListener('input', markDirty);

// --------------------------------------------------------------- toolbar
function renderToolbar() {
  ($('tbUndo') as HTMLButtonElement).disabled = !store.canUndo();
  ($('tbRedo') as HTMLButtonElement).disabled = !store.canRedo();
  $('tbSnap').classList.toggle('on', editor.snap);
  $('tbTerritory').classList.toggle('on', editor.showTerritory);
  $('tbPanel').classList.toggle('on', !$('panel').classList.contains('collapsed'));
}

$('tbUndo').onclick = () => store.undo();
$('tbRedo').onclick = () => store.redo();
$('tbSnap').onclick = () => {
  toast(editor.toggleSnap() ? 'Einrasten an' : 'Freie Platzierung');
  renderToolbar();
};
$('tbWalk').onclick = () => startWalk();
$('tbFrame').onclick = () => editor.frameAll();
$('tbTerritory').onclick = () => {
  editor.setTerritoryVisible(!editor.showTerritory);
  renderToolbar();
};
$('tbShot').onclick = () => {
  try {
    download(fileSafe(design.name) + '.png', editor.screenshot());
  } catch {
    toast('Screenshot vom Browser blockiert (Fingerprinting-Schutz)');
  }
};
$('tbShare').onclick = () => share();
$('tbHelp').onclick = () => toggleHelp();
$('tbDayz').onclick = () => toggleDayz();
$('tbHouse').onclick = () => toggleHouses();
$('tbPanel').onclick = () => {
  $('panel').classList.toggle('collapsed');
  renderToolbar();
};

function startWalk() {
  if (!store.pieces.size && !sites.length) {
    toast('Bau erst etwas, dann kannst du hindurchlaufen');
    return;
  }
  walk.enter();
}

async function share() {
  const code = await encodeShare(design.name, store.all(), sites);
  const url = `${location.origin}${location.pathname}#plan=${code}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link kopiert – wer ihn öffnet, bekommt eine Kopie des Plans');
  } catch {
    prompt('Link zum Teilen:', url);
  }
}

// ---------------------------------------------------------------- levels
function renderLevels() {
  const counts = new Array(MAX_LEVEL + 1).fill(0);
  for (const p of store.pieces.values()) {
    if (p.l >= 0 && p.l <= MAX_LEVEL) counts[p.l]++;
  }
  const btns = [];
  for (let l = MAX_LEVEL; l >= 0; l--) {
    btns.push(`<button class="lv ${editor.level === l ? 'active' : ''}" data-l="${l}" title="${levelName(l)} (Bild↑/Bild↓)">${l === 0 ? 'G' : l}${counts[l] ? `<span class="n">${counts[l]}</span>` : ''}</button>`);
  }
  $('levels').innerHTML = `<div class="title">Ebenen</div>${btns.join('')}
    <button class="lv-all ${editor.showAll ? 'on' : ''}" id="lvAll" title="Ebenen über der aktiven ein-/ausblenden">${editor.showAll ? 'Alle sichtbar' : 'Bis hier'}</button>`;
}

$('levels').onclick = (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  if (b.id === 'lvAll') editor.setShowAll(!editor.showAll);
  else {
    editor.setLevel(Number(b.dataset.l));
    if (editor.showAll && editor.level < MAX_LEVEL) editor.setShowAll(false);
  }
  renderLevels();
};

// ----------------------------------------------------------------- panel
function currentRoute(pieces: Piece[]) {
  if (tab !== 'raid' || !route.target) {
    editor.clearRaidPath();
    return null;
  }
  const res = analyseRaid(pieces, route.target, route.metric);
  editor.showRaidPath(res.reachable ? res.path : [], route.target, res.steps.map((s) => s.pieceId));
  return res;
}

function renderPanel() {
  const pieces = store.all();
  if (tab !== 'raid') editor.clearRaidPath();
  $('meters').innerHTML = renderMeters(pieces, settings.partLimit);
  const body = $('tabBody');
  body.innerHTML =
    tab === 'mat' ? renderMaterials(pieces, settings)
    : tab === 'phase' ? renderPhases(pieces)
    : tab === 'upkeep' ? renderUpkeep(pieces, settings)
    : renderRaid(pieces, { ...route, result: currentRoute(pieces) });
  document.querySelectorAll<HTMLElement>('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === tab));
}

document.querySelector('.tabs')!.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('.tab');
  if (!t) return;
  tab = t.dataset.tab as typeof tab;
  renderPanel();
});

$('tabBody').addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement;
  const opt = el.dataset.opt;
  if (opt === 'rawNails' || opt === 'rawSheet') settings[opt] = el.checked;
  if (opt === 'rawPlanks') settings.rawPlanks = (el.value || false) as Settings['rawPlanks'];
  if (opt === 'raidMetric') route.metric = el.value as Metric;
  const priceKey = el.dataset.price;
  if (priceKey && priceKey !== '__proto__' && priceKey !== 'constructor' && priceKey !== 'prototype') {
    settings.upkeepPrices[priceKey] = Math.max(0, Number(el.value) || 0);
  }
  saveSettings(settings);
  renderPanel();
});

$('tabBody').addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (b?.dataset.act === 'raid-pick') editor.setRaidPick(!editor.raidPick);
  if (b?.dataset.act === 'raid-clear') {
    route.target = null;
    renderPanel();
  }
  if (b?.dataset.act === 'copy-list') {
    const text = shoppingText(store.all(), settings, design.name);
    try {
      await navigator.clipboard.writeText(text);
      toast('Einkaufsliste kopiert');
    } catch {
      prompt('Einkaufsliste:', text);
    }
  }
});

// ---------------------------------------------------------------- catalog
function renderCatalogHead() {
  $('catHead').innerHTML = `${CATEGORIES.map((c) =>
    `<button class="ctab ${!search && catTab === c.id ? 'on' : ''}" data-cat="${c.id}">${c.name}<small>${CAT_COUNTS[c.id]}</small></button>`
  ).join('')}
    <label class="search">${I.search.replace('<svg', '<svg width="15" height="15"')}<input id="search" placeholder="Teile suchen" value="${esc(search)}"></label>
    <button class="tb cat-toggle" id="catToggle" title="Leiste ein-/ausklappen">${I.chevron}</button>`;
  ($('search') as HTMLInputElement).oninput = (e) => {
    search = (e.target as HTMLInputElement).value;
    renderCards();
    document.querySelectorAll('.ctab').forEach((t) => t.classList.toggle('on', !search && (t as HTMLElement).dataset.cat === catTab));
  };
  $('catToggle').onclick = () => $('catalog').classList.toggle('min');
}

function renderCards() {
  const q = search.trim().toLowerCase();
  const ids = PART_ORDER.filter((id) => (q ? PARTS[id].name.toLowerCase().includes(q) : PARTS[id].cat === catTab));
  $('cards').innerHTML = ids
    .map((id) => {
      const d = PARTS[id];
      const cost = costLine(id);
      return `<button class="card ${editor.activePart === id ? 'on' : ''}" data-part="${id}" title="${esc(d.name + (d.note ? ' – ' + d.note : ''))}">
        <div class="img"><canvas width="192" height="128" data-thumb="${id}"></canvas></div>
        <div class="nm">${esc(d.name)}</div>
        <div class="cost ${cost ? '' : 'unknown'}">${esc(cost ?? 'Kosten nicht im Wiki')}</div></button>`;
    })
    .join('') || '<div class="info">Nichts gefunden.</div>';
  for (const c of $('cards').querySelectorAll<HTMLCanvasElement>('canvas[data-thumb]')) paintThumb(c);
}

/** Update active-card highlight without tearing down and redrawing every thumbnail canvas. */
function syncActiveCard() {
  for (const b of $('cards').querySelectorAll<HTMLElement>('.card[data-part]')) {
    b.classList.toggle('on', b.dataset.part === editor.activePart);
  }
}

/** Copy a rendered preview into a card canvas (no toDataURL, so canvas-blocking browsers still show it). */
function paintThumb(c: HTMLCanvasElement) {
  const src = thumbs.get(c.dataset.thumb!);
  if (src) c.getContext('2d')?.drawImage(src, 0, 0);
}

$('catHead').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-cat]');
  if (!b) return;
  catTab = b.dataset.cat as Category;
  search = '';
  renderCatalogHead();
  renderCards();
});

$('cards').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-part]');
  if (!b) return;
  const id = b.dataset.part!;
  if (!hasOwn.call(PARTS, id)) return;
  editor.setActivePart(editor.activePart === id ? null : id);
  if (editor.activePart) {
    const k = PARTS[id].kind;
    if ((k === 'palisade' || k === 'plotpole') && editor.level !== 0) {
      editor.setLevel(0);
      renderLevels();
    }
  }
  syncActiveCard();
  renderStatus();
});

// ------------------------------------------------------- status/selection
let lastStatusHtml = '';
function renderStatus() {
  const s = $('status');
  const moving = editor.moving != null ? store.pieces.get(editor.moving) : null;
  const part = moving?.t ?? editor.activePart;
  if (!part || !hasOwn.call(PARTS, part)) {
    if (!s.hidden) s.hidden = true;
    return;
  }
  const d = PARTS[part];
  const v = editor.verdict;
  const mode = editor.placement ? (editor.placement.snapped ? 'Eingerastet' : 'Frei') : d.kind === 'bars' ? 'Zeige auf ein Fenster' : 'Zeige auf die Fläche';
  if (s.hidden) s.hidden = false;
  const o = editor.offset;
  const cm = (val: number) => `${val >= 0 ? '+' : ''}${Math.round(val * 100)}`;
  const off = editor.hasOffset()
    ? `<span class="mode">Versatz ${cm(o.x)} / ${cm(o.y)} / ${cm(o.z)} cm${Math.abs(editor.offsetYaw) > 1e-6 ? ` · ${Math.round((editor.offsetYaw * 180) / Math.PI)}°` : ''} <kbd>Pos1</kbd> zurück</span>`
    : '';
  const html = `<b>${esc(d.name)}</b><span class="mode">${mode}</span>${off}
    ${v && !v.ok ? `<span class="bad">${esc(v.reason ?? '')}</span>` : ''}
    ${moving
      ? '<span class="k">Verschieben: <kbd>Loslassen</kbd> absetzen · <kbd>Q</kbd><kbd>E</kbd> drehen · <kbd>←↑↓→</kbd> <kbd>Bild↑↓</kbd> fein · <kbd>Esc</kbd> abbrechen</span>'
      : '<span class="k"><kbd>Klick</kbd> setzen · <kbd>Q</kbd><kbd>E</kbd> drehen · <kbd>←↑↓→</kbd> <kbd>Bild↑↓</kbd> fein verschieben · <kbd>X</kbd> Einrasten · <kbd>Rechtsklick</kbd>/<kbd>Esc</kbd> fertig</span>'}`;
  if (html !== lastStatusHtml) {
    lastStatusHtml = html;
    s.innerHTML = html;
  }
}

function renderSelection() {
  const c = $('selcard');
  const id = editor.selected;
  const p = id != null ? store.pieces.get(id) : null;
  if (!p || !hasOwn.call(PARTS, p.t)) {
    c.hidden = true;
    return;
  }
  const d = PARTS[p.t];
  const cost = costLine(p.t);
  c.hidden = false;
  c.innerHTML = `<div><div class="nm">${esc(d.name)}</div><div class="lv-tag">${levelName(p.l)}${cost ? ' · ' + esc(cost) : ''}</div></div>
    <button class="btn" id="selSame">${I.plus} Noch eins</button>
    <button class="btn danger" id="selDel">${I.trash} Entfernen</button>`;
  $('selSame').onclick = () => {
    editor.setLevel(p.l);
    editor.setActivePart(p.t);
    renderLevels();
    syncActiveCard();
    renderStatus();
  };
  $('selDel').onclick = () => editor.deleteSelected();
}

// ------------------------------------------------------------------ help
let helpBuilt = false;
function toggleHelp(force?: boolean) {
  const h = $('help');
  const show = force ?? h.hidden;
  h.hidden = !show;
  if (!show || helpBuilt) return;
  helpBuilt = true;
  const row = (k: string, t: string) => `<div><span>${t}</span><span>${k}</span></div>`;
  h.innerHTML = `<div class="float help" style="position:relative">
    <button class="tb close" id="helpClose">${I.x}</button>
    <h2>Basis-Planer für Aftermath</h2>
    <p>Plane deine Basis außerhalb des Spiels, sieh sofort, was du an Material, Werkzeug, Unterhalt und Raid-Schutz brauchst, und lauf in der Ego-Perspektive hindurch.
    Die Rezepte stammen aus dem öffentlichen <a href="${WIKI_URL}/base-building/building-recipes" target="_blank" rel="noopener">Aftermath-Wiki</a> (Stand ${DATA_AS_OF}).
    Im Spiel zeigt die Werkbank immer die aktuellen Kosten.</p>
    <h3>Bauen</h3>
    <div class="grid">
      ${row('<kbd>Klick</kbd>', 'Teil setzen / auswählen')}
      ${row('Teil <kbd>ziehen</kbd>', 'Platziertes Teil verschieben')}
      ${row('<kbd>Q</kbd> <kbd>E</kbd>', 'Drehen bzw. Seite wechseln')}
      ${row('<kbd>Shift</kbd>+<kbd>Q</kbd>/<kbd>E</kbd>', 'Frei: um 90° drehen')}
      ${row('<kbd>X</kbd>', 'Einrasten an/aus')}
      ${row('<kbd>Rechtsklick</kbd> / <kbd>Esc</kbd>', 'Bauen beenden')}
      ${row('<kbd>Entf</kbd>', 'Auswahl entfernen')}
      ${row('<kbd>Strg</kbd>+<kbd>Z</kbd> / <kbd>Y</kbd>', 'Rückgängig / Wiederholen')}
      ${row('<kbd>←</kbd><kbd>↑</kbd><kbd>↓</kbd><kbd>→</kbd>', 'Fein verschieben, 5 cm (Teil in der Hand oder ausgewählt)')}
      ${row('<kbd>Bild↑</kbd> <kbd>Bild↓</kbd>', 'Fein hoch / runter, 5 cm')}
      ${row('<kbd>Shift</kbd> / <kbd>Alt</kbd> dazu', '25 cm / 1 cm; <kbd>Alt</kbd>+<kbd>Q</kbd>/<kbd>E</kbd> dreht um 1°')}
      ${row('<kbd>Pos1</kbd>', 'Versatz des Teils in der Hand zurücksetzen')}
      ${row('<kbd>0</kbd> … <kbd>7</kbd>', 'Ebene wechseln (0 = Erdgeschoss)')}
    </div>
    <h3>Kamera</h3>
    <div class="grid">
      ${row('<kbd>Rechte Maus</kbd> ziehen', 'Umsehen (ohne Teil in der Hand auch links)')}
      ${row('<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>', 'Fliegen in Blickrichtung')}
      ${row('<kbd>Leertaste</kbd> / <kbd>C</kbd> oder <kbd>Strg</kbd>', 'Hoch / runter')}
      ${row('<kbd>Shift</kbd> / <kbd>Alt</kbd>', 'Schneller / langsamer')}
      ${row('<kbd>Mausrad</kbd>', 'Vor / zurück')}
      ${row('<kbd>Mittlere Maus</kbd> ziehen', 'Seitlich und hoch/runter schieben')}
      ${row('<kbd>F</kbd>', 'Ganze Basis zeigen')}
      ${row('<kbd>V</kbd>', 'Laufmodus')}
      ${row('<kbd>T</kbd>', 'Territorium ein/aus')}
    </div>
    <h3>So rastet was ein</h3>
    <p>Böden an Bodenkanten und auf Wänden der Ebene darunter, Wände und Türen an Bodenkanten, Halb- und Drittelwände übereinander, Treppen auf quadratische Böden,
    Wendeltreppen übereinander, Palisaden an Palisaden, Fenstergitter an Fensterwänden. Möbel stehen frei auf jeder Fläche.</p>
    <h3>Annahmen</h3>
    <p>Maße und Öffnungen stammen aus den Bauteil-Modellen der Aftermath-Mod (Raster 4,46 m, 2,92 m pro Ebene). Texturen sind nachgebaut, keine Spieldateien.
    Das Teile-Limit (${DEFAULT_PART_LIMIT}) und einige Raid-Werte (mit * markiert) sind geschätzt.
    Unterhaltspreise trägst du selbst ein. Dieses Tool ist ein Fanprojekt und steht in keiner Verbindung zu Aftermath Gaming.</p>
  </div>`;
  $('helpClose').onclick = () => toggleHelp(false);
}
$('help').addEventListener('click', (e) => {
  if (e.target === $('help')) toggleHelp(false);
});

// ------------------------------------------------------------- keyboard
const ZERO_VEC = new THREE.Vector3();
window.addEventListener('keydown', (e) => {
  if (walk.active) return;
  if ((e.target as HTMLElement)?.closest?.('input,textarea,select')) return;
  const k = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && k === 'z') {
    e.preventDefault();
    e.shiftKey ? store.redo() : store.undo();
    return;
  }
  if (ctrl && k === 'y') {
    e.preventDefault();
    store.redo();
    return;
  }
  if (ctrl) {
    // Ctrl alone flies down; keep the browser from saving, bookmarking or selecting meanwhile
    if (k === 's' || k === 'a' || k === 'd' || k === ' ') e.preventDefault();
    return;
  }
  // fine adjustment: arrows along the ground (relative to the view), Page Up/Down height
  if (k === 'arrowup' || k === 'arrowdown' || k === 'arrowleft' || k === 'arrowright' || k === 'pageup' || k === 'pagedown') {
    e.preventDefault();
    const step = e.altKey ? 0.01 : e.shiftKey ? 0.25 : 0.05;
    let delta: THREE.Vector3;
    if (k === 'pageup') delta = new THREE.Vector3(0, step, 0);
    else if (k === 'pagedown') delta = new THREE.Vector3(0, -step, 0);
    else {
      const ax = editor.viewAxes();
      delta =
        k === 'arrowup' ? ax.fwd.multiplyScalar(step)
        : k === 'arrowdown' ? ax.fwd.multiplyScalar(-step)
        : k === 'arrowright' ? ax.right.multiplyScalar(step)
        : ax.right.multiplyScalar(-step);
    }
    if (editor.nudge(delta)) {
      renderStatus();
      renderSelection();
    } else toast('Erst ein Teil wählen oder in die Hand nehmen, dann fein verschieben');
    return;
  }
  if (k.length === 1 && k >= '0' && k <= '7') {
    editor.setLevel(Number(k));
    renderLevels();
    return;
  }
  if (k === ' ') {
    e.preventDefault(); // Space flies up; do not press the focused button
    (document.activeElement as HTMLElement | null)?.blur?.();
    return;
  }
  switch (k) {
    case 'escape':
      if (!$('dayz').hidden) toggleDayz(false);
      else if (!$('houses').hidden) toggleHouses(false);
      else if (editor.moving != null) editor.endMove(false);
      else if (editor.raidPick) editor.setRaidPick(false);
      else if (!$('help').hidden) toggleHelp(false);
      else if (editor.activePart) editor.setActivePart(null);
      else editor.select(null);
      syncActiveCard();
      renderStatus();
      break;
    case 'q':
    case 'e':
    case 'r': {
      const dir = k === 'q' ? -1 : 1;
      const inHand = editor.activePart || editor.moving != null;
      if (e.altKey) {
        e.preventDefault();
        editor.nudge(ZERO_VEC, (dir * Math.PI) / 180); // 1°
      } else if (inHand) editor.rotate(dir, e.shiftKey);
      else if (editor.selected != null) editor.nudge(ZERO_VEC, dir * (e.shiftKey ? Math.PI / 2 : Math.PI / 12));
      renderStatus();
      break;
    }
    case 'home':
      e.preventDefault();
      editor.resetOffset();
      renderStatus();
      break;
    case 'x':
      $('tbSnap').click();
      break;
    case 'delete':
    case 'backspace':
      editor.deleteSelected();
      break;
    case 'f':
      editor.frameAll();
      break;
    case 't':
      $('tbTerritory').click();
      break;
    case 'v':
      startWalk();
      break;
    case '?':
    case 'h':
      toggleHelp();
      break;
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'Alt') e.preventDefault();
});

// --------------------------------------------------------------- wiring
function renderAll() {
  renderToolbar();
  renderLevels();
  renderPanel();
  renderCards();
  renderStatus();
  renderSelection();
}

store.on(() => {
  markDirty();
  renderToolbar();
  renderLevels();
  renderPanel();
  renderSelection();
});

renderCatalogHead();

async function boot() {
  const m = location.hash.match(/^#plan=([\w-]+)/);
  if (m) {
    const shared = await decodeShare(m[1]);
    history.replaceState(null, '', location.pathname + location.search);
    if (shared) {
      openDesign({ id: newId(), name: shared.name, updated: Date.now(), pieces: shared.pieces, sites: shared.sites });
      toast(`Geteilten Plan „${shared.name}“ geladen (${shared.pieces.length} Teile)`);
      return;
    }
    toast('Link konnte nicht gelesen werden');
  }
  const cur = listDesigns().find((d) => d.id === currentDesignId()) ?? listDesigns()[0];
  openDesign(cur ?? design);
  if (!cur) setTimeout(() => toggleHelp(true), 400);
}
boot();

renderThumbs(PART_ORDER, (id, canvas) => {
  thumbs.set(id, canvas);
  const c = document.querySelector<HTMLCanvasElement>(`canvas[data-thumb="${id}"]`);
  if (c) paintThumb(c);
}).catch((e) => console.warn('Vorschaubilder nicht verfügbar', e));

// ------------------------------------------------------- DayZ Editor (.dze)
const ANCHOR_KEY = 'abp.dayzAnchor.v1';
function loadAnchor(): Anchor {
  const def: Anchor = { map: 'chernarusplus', x: 0, y: 0, z: 0, yaw: 0 };
  try {
    const raw = JSON.parse(localStorage.getItem(ANCHOR_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object') return def;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
      map: typeof raw.map === 'string' && raw.map ? raw.map : def.map,
      x: num(raw.x),
      y: num(raw.y),
      z: num(raw.z),
      yaw: num(raw.yaw),
    };
  } catch {
    return def;
  }
}
let anchor = loadAnchor();
let exportMode: ExportMode = (() => {
  try {
    return localStorage.getItem('abp.dayzMode.v1') === 'class' ? 'class' : 'model';
  } catch {
    return 'model';
  }
})();
const saveAnchor = () => {
  try {
    localStorage.setItem(ANCHOR_KEY, JSON.stringify(anchor));
  } catch {
    /* private mode */
  }
};

function toggleDayz(force?: boolean) {
  const h = $('dayz');
  const show = force ?? h.hidden;
  h.hidden = !show;
  if (show) renderDayz();
}

function renderDayz(note = '') {
  const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
  const unset = anchor.x === 0 && anchor.z === 0;
  $('dayz').innerHTML = `<div class="float help dayz" style="position:relative">
    <button class="tb close" data-dz="close">${I.x}</button>
    <h2>In DayZ ansehen</h2>
    <p>Exportiert die Basis als <b>.dze</b>-Datei für den <b>DayZ Editor</b>. Dort steht sie mit den echten Aftermath-Modellen auf der echten Karte.</p>
    <h3>1 · Karte</h3>
    <div class="dz-row">
      <select data-dz="map">${MAPS.map((m) => `<option value="${m.id}" ${anchor.map === m.id ? 'selected' : ''}>${m.name}</option>`).join('')}
        ${MAPS.some((m) => m.id === anchor.map) ? '' : `<option value="${esc(anchor.map)}" selected>${esc(anchor.map)}</option>`}</select>
    </div>
    <h3>2 · Bauplatz (Mitte der Basis, Bodenhöhe)</h3>
    <div class="dz-row">
      <label>X <input class="num" data-dz="x" type="number" step="0.1" value="${n(anchor.x)}"></label>
      <label>Höhe <input class="num" data-dz="y" type="number" step="0.1" value="${n(anchor.y)}"></label>
      <label>Z <input class="num" data-dz="z" type="number" step="0.1" value="${n(anchor.z)}"></label>
      <label>Richtung ° <input class="num" data-dz="yaw" type="number" step="1" value="${n(anchor.yaw)}"></label>
    </div>
    <div class="dz-row">
      <button class="btn" data-dz="pick">${I.upload} Bauplatz aus .dze-Datei übernehmen</button>
      <span class="info" style="margin:0">Setz im Editor ein beliebiges Objekt an die Stelle, speichere und wähle die Datei hier aus. Position, Höhe und Drehung werden übernommen.</span>
    </div>
    ${unset ? '<div class="warn">Noch kein Bauplatz gesetzt – die Basis landet sonst in der Kartenecke (0 / 0).</div>' : ''}
    ${note ? `<div class="info box">${note}</div>` : ''}
    <h3>3 · Exportieren</h3>
    <div class="dz-row">
      <label><input type="radio" name="dzmode" data-dz="mode" value="model" ${exportMode === 'model' ? 'checked' : ''}> Als Modelle – zum Ansehen im Editor (empfohlen)</label>
      <label><input type="radio" name="dzmode" data-dz="mode" value="class" ${exportMode === 'class' ? 'checked' : ''}> Als Klassen – nur für Server mit Bausystem</label>
    </div>
    <div class="dz-row">
      <button class="btn primary" data-dz="export" ${store.pieces.size ? '' : 'disabled'}>${I.download} ${store.pieces.size} Teile als .dze herunterladen</button>
    </div>
    <h3>Im Spiel öffnen</h3>
    <ol class="dz-steps">
      <li>Im DayZ Launcher die Mods <b>DayZ Editor</b> (InclementDab), <b>Dabs Framework</b>, <b>CF</b> und die <b>Aftermath-Mods</b> (Aftermath_Licenced, AftermathServerMod, …) aktivieren.</li>
      <li>DayZ starten, im Hauptmenü den <b>Editor</b> öffnen und die passende Karte wählen.</li>
      <li>Im Editor <b>Datei → Öffnen</b> und die exportierte .dze-Datei laden. Kamera fliegt zur Basis.</li>
    </ol>
    <p class="info">Rückweg: Im Pläne-Menü „Aus DayZ Editor importieren“ holt Aftermath-Bauteile aus einer .dze-Datei in den Planer.</p>
  </div>`;
}

$('dayz').addEventListener('click', async (e) => {
  if (e.target === $('dayz')) return toggleDayz(false);
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-dz]');
  if (!b) return;
  const act = b.dataset.dz;
  if (act === 'close') toggleDayz(false);
  if (act === 'pick') $('dzeAnchorFile').click();
  if (act === 'export') {
    const res = exportDze(store.all(), anchor, exportMode);
    const blob = new Blob([res.binary as BlobPart], { type: 'application/octet-stream' });
    downloadBlob(fileSafe(design.name) + '.dze', blob);
    toast(`${res.count} Teile exportiert${res.skipped.length ? `, ${res.skipped.length} ohne DayZ-Klasse übersprungen` : ''}`);
  }
});

$('dayz').addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement;
  const k = el.dataset.dz;
  if (k === 'map') anchor.map = el.value;
  if (k === 'mode') {
    exportMode = el.value === 'class' ? 'class' : 'model';
    try {
      localStorage.setItem('abp.dayzMode.v1', exportMode);
    } catch {
      /* private mode */
    }
    return;
  }
  if (k === 'x' || k === 'y' || k === 'z' || k === 'yaw') anchor[k] = Number(el.value) || 0;
  saveAnchor();
});

($('dzeAnchorFile') as HTMLInputElement).onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  try {
    const dze = await readDze(f);
    const a = anchorFrom(dze);
    if (!a) {
      renderDayz('In der Datei ist kein Objekt. Setz im Editor ein Objekt an den Bauplatz und speichere erneut.');
      return;
    }
    anchor = a;
    saveAnchor();
    renderDayz(`Bauplatz übernommen: ${esc(dze.objects[0].type)} bei ${a.x.toFixed(1)} / ${a.z.toFixed(1)}, Höhe ${a.y.toFixed(1)}, Richtung ${a.yaw.toFixed(0)}°.`);
  } catch (err) {
    renderDayz(`Datei konnte nicht gelesen werden (${esc(String((err as Error).message ?? err))}).`);
  }
};

($('dzeImportFile') as HTMLInputElement).onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  try {
    const dze = await readDze(f);
    const { pieces, unknown } = piecesFromDze(dze);
    if (!pieces.length) {
      toast('Keine Aftermath-Bauteile in der Datei gefunden');
      return;
    }
    openDesign({ id: newId(), name: f.name.replace(/\.dze$/i, '').slice(0, 60), updated: Date.now(), pieces });
    toast(`${pieces.length} Teile importiert${unknown ? `, ${unknown} andere Objekte ignoriert` : ''}${dze.partial ? ' (Datei nur teilweise lesbar)' : ''}`);
  } catch (err) {
    toast('Datei konnte nicht gelesen werden');
    console.error(err);
  }
};

// ------------------------------------------------ buildings from DayZ files
function disposePlaceholder(obj: THREE.Object3D) {
  if (!obj.userData.placeholder) return;
  obj.traverse((o) => {
    const geom = (o as THREE.Mesh).geometry;
    if (geom) geom.dispose();
  });
}

async function syncSites() {
  const want = new Set(sites.map((s) => s.id));
  for (const [id, obj] of siteObjects) {
    if (!want.has(id)) {
      editor.sites.remove(obj);
      disposePlaceholder(obj);
      siteObjects.delete(id);
      siteState.delete(id);
    }
  }
  await Promise.all(
    sites.map(async (s) => {
      let obj = siteObjects.get(s.id);
      if (!obj) {
        obj = placeholder(s);
        siteObjects.set(s.id, obj);
        editor.sites.add(obj);
      }
      placeSite(obj, s);
      if (!obj.userData.placeholder) return;
      siteState.set(s.id, 'loading');
      try {
        const tpl = await loadModel(s.pbo, s.path);
        const cur = siteObjects.get(s.id);
        if (!cur || !sites.includes(s) || !cur.userData.placeholder) return;
        if (tpl) {
          const inst = instance(tpl);
          inst.userData.key = siteKey(s.pbo, s.path);
          editor.sites.remove(cur);
          disposePlaceholder(cur);
          editor.sites.add(inst);
          siteObjects.set(s.id, inst);
          s.size = tpl.userData.size;
          s.center = tpl.userData.center;
          placeSite(inst, s);
          siteState.set(s.id, 'ok');
        } else siteState.set(s.id, 'missing');
      } catch (e) {
        console.error(e);
        siteState.set(s.id, 'error');
      }
    }),
  );
  if (!$('houses').hidden) renderHouses();
}

function toggleHouses(force?: boolean) {
  const h = $('houses');
  const show = force ?? h.hidden;
  h.hidden = !show;
  if (show) renderHouses();
}

function renderHouses(note = '') {
  const n = (v: number) => (Math.round(v * 100) / 100).toString();
  const missingSites = sites.filter((s) => siteState.get(s.id) === 'missing');
  const missing = [...new Set(missingSites.map((s) => s.pbo))];
  $('houses').innerHTML = `<div class="float help dayz" style="position:relative">
    <button class="tb close" data-hs="close">${I.x}</button>
    <h2>Gebäude aus DayZ</h2>
    <p>Lade einzelne Gebäude direkt aus deinen DayZ-Spieldateien und bau darin oder daneben. Die Datei wird <b>nur in deinem Browser</b> gelesen – es wird nichts hochgeladen, und der Planer enthält selbst keine DayZ-Modelle.</p>
    <h3>1 · Spieldateien wählen</h3>
    <div class="dz-row">
      <button class="btn primary" data-hs="dir">${I.folder} Addons-Ordner wählen</button>
      <button class="btn" data-hs="pick">${I.upload} Einzelne PBO-Dateien</button>
      ${catalog ? `<span class="info" style="margin:0">${openedPbos().length} PBOs geöffnet · ${catalog.length} Modelle</span>` : ''}
    </div>
    <p class="info">Wähle den Ordner <code>Steam\\steamapps\\common\\DayZ\\Addons</code>. Dann findet der Planer zu jedem Gebäude auch die Texturen, die oft in anderen PBOs liegen (z. B. <b>structures_data.pbo</b>). Der Browser fragt dabei, ob er die Dateien „hochladen“ darf – das ist nur der Standardtext: Sie werden ausschließlich lokal gelesen. Für Mod-Gebäude zusätzlich den <code>Addons</code>-Ordner des Mods wählen.</p>
    ${missing.length ? `<div class="warn">Für ${missingSites.length > 1 ? 'einige Gebäude' : 'ein Gebäude'} dieses Plans fehlt das Modell. Wähle ${missing.map((p) => `<b>${esc(p)}</b>`).join(', ')}.</div>` : ''}
    ${houseBusy ? `<div class="info box">${esc(houseBusy)}</div>` : ''}
    ${note ? `<div class="info box">${note}</div>` : ''}
    ${missingTextures.size && sites.length ? `<div class="warn">${missingTextures.size} Texturen nicht gefunden – wähle den ganzen Addons-Ordner, damit auch die gemeinsamen Texturen gefunden werden.</div>` : ''}
    ${catalog ? `<h3>2 · Gebäude hinzufügen</h3>
    <div class="dz-row"><input class="design-name" data-hs="q" placeholder="Suchen, z. B. house, barn, garage …" value="${esc(houseQuery)}" style="flex:1;min-width:220px">
      <label><input type="checkbox" data-hs="only" ${onlyBuildings ? 'checked' : ''}> nur Gebäude</label></div>
    <div class="hs-list" id="hsList"></div>` : ''}
    ${sites.length ? `<h3>Im Plan</h3>
    <div class="hs-sites">${sites
      .map((s) => {
        const st = siteState.get(s.id);
        return `<div class="hs-site" data-id="${esc(s.id)}">
        <b title="${esc(s.pbo + ' · ' + s.path)}">${esc(s.name)}</b>
        ${st === 'missing' ? `<span class="warn" style="margin:0 0 0 8px">Modell fehlt – ${esc(s.pbo)} wählen</span>` : st === 'error' ? '<span class="warn" style="margin:0 0 0 8px">Modell nicht lesbar</span>' : st === 'loading' ? '<span class="info" style="margin:0 0 0 8px">lädt …</span>' : ''}
        <div class="dz-row">
          <label>X <input class="num" data-hs="x" type="number" step="0.5" value="${n(s.x)}"></label>
          <label>Z <input class="num" data-hs="z" type="number" step="0.5" value="${n(s.z)}"></label>
          <label>Höhe <input class="num" data-hs="y" type="number" step="0.05" value="${n(s.y)}"></label>
          <label>Drehung ° <input class="num" data-hs="r" type="number" step="5" value="${n(s.r)}"></label>
          <button class="btn" data-hs="rot">↻ 90°</button>
          <button class="btn" data-hs="here" title="In die Bildmitte setzen">Hierher</button>
          <button class="btn" data-hs="del" title="Aus dem Plan entfernen">${I.trash}</button>
        </div></div>`;
      })
      .join('')}</div>
    <p class="info">Türen öffnest du im Laufmodus mit <b>F</b>, Treppen sind begehbar. Material, Unterhalt und Raid rechnen nur mit deinen eigenen Bauteilen.</p>` : ''}
  </div>`;
  renderHouseList();
}

function renderHouseList() {
  const el = document.getElementById('hsList');
  if (!el || !catalog) return;
  const q = houseQuery.trim().toLowerCase();
  const rows: string[] = [];
  let totalHits = 0;
  for (let i = 0; i < catalog.length; i++) {
    const m = catalog[i];
    if (onlyBuildings && !m.building) continue;
    if (q && !m.nameLow.includes(q) && !m.pboLow.includes(q)) continue;
    totalHits++;
    if (rows.length < 250) {
      rows.push(`<button class="hs-item" data-hs="add" data-pbo="${esc(m.pbo)}" data-path="${esc(m.name)}"><span>${esc(modelName(m.name))}</span><small>${esc(m.pbo)} · ${esc(m.name)} · ${(m.size / 1024).toFixed(0)} KB</small></button>`);
    }
  }
  el.innerHTML =
    rows.join('') +
    (totalHits > 250 ? `<p class="info">… ${totalHits - 250} weitere – Suche verfeinern.</p>` : totalHits ? '' : '<p class="info">Nichts gefunden.</p>');
}

$('houses').addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.hs === 'q') {
    houseQuery = el.value;
    renderHouseList();
  }
});

$('houses').addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.hs === 'only') {
    onlyBuildings = el.checked;
    renderHouseList();
    return;
  }
  const k = el.dataset.hs as 'x' | 'y' | 'z' | 'r';
  if (k !== 'x' && k !== 'y' && k !== 'z' && k !== 'r') return;
  const s = sites.find((x) => x.id === el.closest<HTMLElement>('.hs-site')?.dataset.id);
  if (!s) return;
  s[k] = Number(el.value) || 0;
  const obj = siteObjects.get(s.id);
  if (obj) placeSite(obj, s);
  markDirty();
});

$('houses').addEventListener('click', async (e) => {
  if (e.target === $('houses')) return toggleHouses(false);
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-hs]');
  if (!b) return;
  const act = b.dataset.hs;
  const s = sites.find((x) => x.id === b.closest<HTMLElement>('.hs-site')?.dataset.id);
  if (act === 'close') toggleHouses(false);
  if (act === 'pick') $('pboFile').click();
  if (act === 'dir') $('pboDir').click();
  if (act === 'add' && catalog) {
    const path = b.dataset.path!;
    const t = editor.focusPoint();
    const ref: SiteRef = {
      id: newId(),
      pbo: b.dataset.pbo!,
      path,
      name: modelName(path),
      x: Math.round(t.x * 2) / 2,
      y: 0,
      z: Math.round(t.z * 2) / 2,
      r: 0,
      size: [8, 6, 8],
      center: [0, 3, 0],
    };
    houseBusy = `Lade ${ref.name} …`;
    renderHouses();
    try {
      const tpl = await loadModel(ref.pbo, ref.path);
      if (!tpl) throw new Error('PBO nicht geöffnet');
      sites.push(ref);
      await syncSites();
      houseBusy = '';
      markDirty();
      renderHouses(`<b>${esc(ref.name)}</b> hinzugefügt.`);
    } catch (err) {
      houseBusy = '';
      renderHouses(`${esc(ref.name)} konnte nicht gelesen werden (${esc(String((err as Error).message ?? err))}).`);
    }
    return;
  }
  if (!s) return;
  if (act === 'rot') s.r = (((s.r + 90) % 360) + 360) % 360;
  if (act === 'here') {
    const t = editor.focusPoint();
    s.x = Math.round(t.x * 2) / 2;
    s.z = Math.round(t.z * 2) / 2;
  }
  if (act === 'del') sites = sites.filter((x) => x !== s);
  void syncSites();
  markDirty();
  renderHouses();
});

async function openGameFiles(input: HTMLInputElement) {
  const files = [...(input.files ?? [])];
  input.value = '';
  const list = files.filter((f) => /\.pbo$/i.test(f.name));
  if (!files.length) return;
  if (!list.length) {
    renderHouses('In der Auswahl ist keine .pbo-Datei. Wähle den Ordner <code>DayZ\\Addons</code>.');
    return;
  }
  houseBusy = `Lese ${list.length} PBO-Dateien …`;
  renderHouses();
  const res = await openPbos(list, (done, total) => {
    houseBusy = `Lese PBO-Dateien … ${done} / ${total}`;
    const box = document.querySelector('#houses .info.box');
    if (box) box.textContent = houseBusy;
  });
  const isBuilding = (pbo: string, path: string) =>
    /structures|building|house|ruin|wreck|bunker|base/i.test(pbo) || /(^|\\)(houses?|buildings?|structures?|ruins?)\\/i.test(path);
  catalog = openedPbos().flatMap((p) => {
    const pboLow = p.name.toLowerCase();
    const pboAndPrefix = p.name + ' ' + p.index.prefix;
    return pboModels(p.index).map((e) => ({
      pbo: p.name,
      pboLow,
      name: e.name,
      nameLow: e.name.toLowerCase(),
      size: e.size,
      building: isBuilding(pboAndPrefix, e.name),
    }));
  });
  catalog.sort((a, b) => Number(b.building) - Number(a.building) || nameCollator.compare(a.pbo, b.pbo) || nameCollator.compare(a.name, b.name));
  houseBusy = '';
  houseQuery = '';
  await syncSites();
  renderHouses(
    `${res.opened} PBO${res.opened === 1 ? '' : 's'} geöffnet${res.failed ? `, ${res.failed} nicht lesbar` : ''}.` +
      (catalog.length ? '' : ' Darin sind keine Modelle.'),
  );
}

($('pboFile') as HTMLInputElement).onchange = (e) => void openGameFiles(e.target as HTMLInputElement);
($('pboDir') as HTMLInputElement).onchange = (e) => void openGameFiles(e.target as HTMLInputElement);
