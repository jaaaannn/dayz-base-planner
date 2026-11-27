import './style.css';

// Some privacy-hardened browsers (LibreWolf by default, Firefox with
// webgl.disabled, Tor Browser) ship with WebGL switched off. Without it the 3D
// editor cannot start, so check first and explain how to turn it on instead of
// leaving a half-built page.

function webglAvailable(): boolean {
  if (typeof WebGLRenderingContext === 'undefined') return false;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function showProblem(title: string, detailNodes: (string | Node)[]) {
  const isLibreWolf = /librewolf/i.test(navigator.userAgent);
  const isFirefox = /firefox/i.test(navigator.userAgent);
  const app = document.getElementById('app') ?? document.body;
  app.innerHTML = `
  <div class="fatal">
    <div class="fatal-card">
      <h1></h1>
      <p></p>
      <h2>So schaltest du WebGL ein</h2>
      <ol>
        ${isLibreWolf || isFirefox ? '' : '<li>Ein anderer Browser (Chrome, Edge, Firefox) funktioniert meist ohne Einstellungen.</li>'}
        <li><b>LibreWolf:</b> Einstellungen → <i>LibreWolf</i> → Haken bei <i>„Enable WebGL“</i> setzen. Alternativ in <code>about:config</code> den Wert <code>webgl.disabled</code> auf <code>false</code> stellen.</li>
        <li><b>Firefox:</b> in <code>about:config</code> den Wert <code>webgl.disabled</code> auf <code>false</code> stellen; unter Einstellungen → Allgemein → Leistung die Hardwarebeschleunigung erlauben.</li>
        <li>Danach diese Seite neu laden.</li>
      </ol>
      <p class="fatal-note">Hinweis: Der Planer läuft komplett im Browser und sendet keine Daten. WebGL wird nur für die 3D-Ansicht gebraucht.
      Wenn „Resist Fingerprinting“ aktiv ist, funktioniert der Planer trotzdem; höchstens Screenshots werden blockiert.</p>
      <button type="button">Neu laden</button>
    </div>
  </div>`;
  app.querySelector('h1')!.textContent = title;
  app.querySelector('.fatal-card > p')!.append(...detailNodes);
  app.querySelector('button')!.addEventListener('click', () => location.reload());
}

// ?nowebgl previews the notice
if (new URLSearchParams(location.search).has('nowebgl') || !webglAvailable()) {
  showProblem('Die 3D-Ansicht kann nicht starten', [
    'Dein Browser hat ',
    el('b', 'WebGL'),
    ' abgeschaltet. LibreWolf macht das standardmäßig aus Datenschutzgründen.',
  ]);
} else {
  import('./main').catch((e: unknown) => {
    console.error(e);
    const msg = e instanceof Error ? e.message : String(e);
    showProblem('Der Planer konnte nicht starten', [
      'Beim Start ist ein Fehler aufgetreten: ',
      el('code', msg),
      '. Oft liegt es an abgeschaltetem oder blockiertem WebGL.',
    ]);
  });
}
