// Ceremony night: announce winners to the app as they are read out, and set
// the ceremony start time.
//
// A winner is always chosen from the season's nominees, never typed, so the
// text sent is exactly what the app compares ballots against. Everything can
// be rehearsed against the test year (9999) before the real night.

// The app's own category names, which are the keys it listens for.
const APP_CATEGORY = {
  bestpicture: 'Best Picture', bestdirector: 'Best Director',
  bestactor: 'Best Actor', bestactress: 'Best Actress',
  bestsupportingactor: 'Best Supporting Actor', bestsupportingactress: 'Best Supporting Actress',
  bestoriginalscreenplay: 'Best Original Screenplay', bestadaptedscreenplay: 'Best Adapted Screenplay',
  bestanimatedfeature: 'Best Animated Feature', bestanimatedshortfilm: 'Best Animated Short Film',
  bestinternationalfeature: 'Best International Feature', bestdocumentaryfeature: 'Best Documentary Feature',
  bestdocumentaryshort: 'Best Documentary Short', bestcinematography: 'Best Cinematography',
  bestfilmediting: 'Best Film Editing', bestproductiondesign: 'Best Production Design',
  bestcostumedesign: 'Best Costume Design', bestmakeupandhairstyling: 'Best Makeup and Hairstyling',
  bestsound: 'Best Sound', bestvisualeffects: 'Best Visual Effects',
  bestoriginalscore: 'Best Original Score', bestoriginalsong: 'Best Original Song',
  bestliveactionshort: 'Best Live Action Short', bestcasting: 'Best Casting'
};

const TEST_YEAR = '9999';
// The season whose films the app shows in its test season (OscarYear.testYear in the app).
const TEST_SEASON_FILMS = '2025';

const ceremony = {
  target: 'rehearsal', // 'rehearsal' (test year) or 'live' (the season on screen)
  category: 'bestsupportingactor',
  data: null,          // what the server last reported
  chosen: null,        // index of the nominee picked but not yet announced
  busy: false,
  timer: null,
  testFilms: null      // the films the app shows in its test season
};

// Rehearsal always uses the test season's own films, whatever season is
// selected at the top, so the winners sent match what the app is showing.
function ceremonyFilms() {
  return ceremony.target === 'rehearsal' && ceremony.testFilms ? ceremony.testFilms : films;
}

async function loadTestFilms() {
  const list = await fetch(`/api/films/${TEST_SEASON_FILMS}`).then(r => r.json());
  if (!Array.isArray(list)) throw new Error(`Season ${TEST_SEASON_FILMS} could not be loaded`);
  const ids = list.map(film => film.tmdbId).filter(id => id && !(id in tmdbInfo));
  if (ids.length) {
    const data = await fetch(`/api/tmdb/films?ids=${ids.join(',')}`).then(r => r.json());
    if (data.films) Object.assign(tmdbInfo, data.films);
  }
  ceremony.testFilms = list;
}

function ceremonyTargetYear() {
  return ceremony.target === 'live' ? currentYear : TEST_YEAR;
}

// Compares names the way the app does, loosely enough to survive accents and punctuation.
function sameWinner(a, b) {
  return plainTitle(a) === plainTitle(b);
}

// The nominees of a category, each with the exact text to send if it wins.
function ceremonyNominees(key) {
  const config = categories[key];
  const list = [];
  if (config.type === 'acting') {
    ceremonyFilms().forEach(film => (film[key] || []).forEach(entry =>
      list.push({ value: entry.actorName, primary: entry.actorName, secondary: film.title, film })));
  } else if (config.type === 'song') {
    ceremonyFilms().forEach(film => (film.bestoriginalsong || []).filter(isNominated).forEach(song =>
      list.push({ value: song.songTitle, primary: `"${song.songTitle}"`, secondary: film.title, film })));
  } else if (key === 'bestdirector') {
    // The app shows and compares the director's name, which it gets from TMDB.
    ceremonyFilms().filter(film => film[key]).forEach(film => {
      const director = film.tmdbId && tmdbInfo[film.tmdbId] ? tmdbInfo[film.tmdbId].director : null;
      list.push({ value: director || film.title, primary: director || 'Director not known yet', secondary: film.title, film });
    });
  } else {
    ceremonyFilms().filter(film => film[key]).forEach(film =>
      list.push({ value: film.title, primary: film.title, secondary: filmFacts(film), film }));
  }
  return list.sort((a, b) => a.primary.localeCompare(b.primary));
}

async function refreshCeremony() {
  try {
    const year = ceremonyTargetYear();
    const data = await fetch(`/api/ceremony/${year}`).then(r => r.json());
    if (year !== ceremonyTargetYear()) return; // the target changed while we waited
    const changed = JSON.stringify(data) !== JSON.stringify(ceremony.data);
    ceremony.data = data;
    if (changed && currentMode === 'ceremony' && ceremony.chosen === null && !ceremony.busy) renderCeremonyMode();
  } catch (e) {
    ceremony.data = { error: e.message, winners: {} };
  }
}

function startCeremonyPolling() {
  stopCeremonyPolling();
  ceremony.timer = setInterval(refreshCeremony, 5000);
}

function stopCeremonyPolling() {
  clearInterval(ceremony.timer);
  ceremony.timer = null;
}

function setCeremonyTarget(target) {
  ceremony.target = target;
  ceremony.data = null;
  ceremony.chosen = null;
  renderCeremonyMode();
}

function setCeremonyCategory(key) {
  ceremony.category = key;
  ceremony.chosen = null;
  renderCeremonyMode();
}

function renderCeremonyMode() {
  const editor = document.getElementById('editor');
  if (!ceremony.timer) startCeremonyPolling();
  if (ceremony.target === 'rehearsal' && !ceremony.testFilms) {
    editor.innerHTML = '<div class="empty-state">Loading the test season...</div>';
    loadTestFilms()
      .catch(e => { ceremony.testFilms = []; showStatus(e.message, 'error'); })
      .then(() => { if (currentMode === 'ceremony') renderCeremonyMode(); });
    return;
  }
  if (!ceremony.data) {
    editor.innerHTML = '<div class="empty-state">Checking the database...</div>';
    refreshCeremony().then(() => { if (currentMode === 'ceremony') renderCeremonyMode(); });
    // Directors and posters come from TMDB.
    if (entryInfoTriedFor !== currentYear && !tmdbLoading) {
      entryInfoTriedFor = currentYear;
      loadTmdbInfo().then(() => { if (currentMode === 'ceremony' && ceremony.chosen === null) renderCeremonyMode(); });
    }
    return;
  }

  const winners = ceremony.data.winners || {};
  const live = ceremony.target === 'live';
  // A season that ended over a month ago is history: shown, never changed.
  const season = manifest.years.find(year => year.id === currentYear);
  const locked = live && season && Date.now() - Date.parse(season.ceremonyDate) > 30 * 24 * 60 * 60 * 1000;
  const data = locked ? { ...ceremony.data, canWrite: false } : ceremony.data;
  const key = ceremony.category;
  const appName = APP_CATEGORY[key];
  const nominees = ceremonyNominees(key);
  const current = winners[appName] || null;
  const sidebarScroll = document.getElementById('catSidebar')?.scrollTop || 0;
  const announced = Object.keys(APP_CATEGORY).filter(k => winners[APP_CATEGORY[k]]).length;

  const item = ([k, val]) => {
    const winner = winners[APP_CATEGORY[k]];
    return `
      <button class="cat-item ${k === key ? 'active' : ''} ${winner ? 'done' : ''}" onclick="setCeremonyCategory('${k}')">
        <span>${esc(val.label)}${winner ? `<span class="cat-winner">${esc(winner)}</span>` : ''}</span>
        <span class="cat-count">${winner ? '✓' : ''}</span>
      </button>`;
  };
  const entries = Object.entries(categories);

  let notice = '';
  if (!data.hasDatabaseUrl) {
    notice = '<div class="ceremony-notice bad">Not connected. Add FIREBASE_DATABASE_URL to editor/.env and restart the editor.</div>';
  } else if (data.error) {
    notice = `<div class="ceremony-notice bad">The database could not be read: ${esc(data.error)}</div>`;
  } else if (data.keyError) {
    notice = `<div class="ceremony-notice bad">The service account key could not be used: ${esc(data.keyError)}</div>`;
  } else if (locked) {
    notice = '';
  } else if (!data.canWrite) {
    notice = '<div class="ceremony-notice">Read-only: there is no service account key, so winners cannot be sent from here. Pick a winner to get the exact text to paste into the Firebase console.</div>';
  }

  editor.innerHTML = `
    <div class="nom-layout">
      <nav class="cat-sidebar" id="catSidebar">
        <div class="mode-toggle stage-toggle">
          <button class="${!live ? 'active' : ''}" onclick="setCeremonyTarget('rehearsal')">Rehearsal</button>
          <button class="${live ? 'active live' : ''}" onclick="setCeremonyTarget('live')">Live ${esc(currentYear)}</button>
        </div>
        <p class="cat-hint" style="margin: 0 0 0.5rem 0.6rem;">${announced} of ${entries.length} announced</p>
        <h4>First group</h4>${entries.filter(([, val]) => val.group === 1).map(item).join('')}
        <h4>Second group</h4>${entries.filter(([, val]) => val.group === 2).map(item).join('')}
      </nav>
      <div class="nomination-container">
        <div class="ceremony-banner ${live && !locked ? 'live' : ''}">
          ${locked
            ? `<strong>Finished.</strong> The ${esc(currentYear)} results are locked and shown for reference.`
            : live
            ? `<strong>LIVE.</strong> Winners go to everyone using the ${esc(currentYear)} season, immediately.`
            : `<strong>Rehearsal.</strong> Winners go to the test season (${TEST_YEAR}) only. Nobody's real ballot is affected.
               <br><span class="entry-secondary">Showing the ${TEST_SEASON_FILMS} nominees, which is what the app's Test season uses.</span>`}
        </div>
        ${notice}
        ${locked ? '' : renderCeremonyStart()}
        <div class="nomination-header">
          <h2>${esc(categories[key].label)}</h2>
          <span class="nom-count">sent as "${esc(appName)}"</span>
        </div>
        ${current ? `
          <div class="ceremony-current">
            <div><span class="entry-secondary">Announced winner</span><div class="entry-primary">${esc(current)}</div>
              ${nominees.some(n => sameWinner(n.value, current)) ? '' : '<div class="match-bad">This does not match any nominee below, so no ballot will score it.</div>'}</div>
            ${data.canWrite ? `<button class="secondary" onclick="sendWinner(null)" ${ceremony.busy ? 'disabled' : ''}>Clear</button>` : ''}
          </div>` : ''}
        ${nominees.length === 0 ? '<p style="color:#666;">This category has no nominees in the season data.</p>' : `
          <div class="ceremony-grid">
            ${nominees.map((nominee, index) => `
              <button class="ceremony-nominee ${ceremony.chosen === index ? 'chosen' : ''} ${current && sameWinner(nominee.value, current) ? 'winner' : ''}"
                      onclick="chooseWinner(${index})">
                ${filmThumb(nominee.film)}
                <span><span class="entry-primary">${esc(nominee.primary)}</span><span class="entry-secondary">${esc(nominee.secondary)}</span></span>
              </button>`).join('')}
          </div>`}
        ${!locked && ceremony.chosen !== null && nominees[ceremony.chosen] ? renderCeremonyConfirm(nominees[ceremony.chosen], appName) : ''}
      </div>
    </div>`;
  document.getElementById('catSidebar').scrollTop = sidebarScroll;
}

function renderCeremonyConfirm(nominee, appName) {
  const live = ceremony.target === 'live';
  if (!ceremony.data.canWrite) {
    return `
      <div class="ceremony-confirm">
        <p>In the Firebase console, under <code>years/${esc(ceremonyTargetYear())}/winners</code>, add:</p>
        <div class="copy-row"><span class="entry-secondary">Key</span><code>${esc(appName)}</code>
          <button class="secondary" onclick="copyText(this, '${esc(appName.replace(/'/g, "\\'"))}')">Copy</button></div>
        <div class="copy-row"><span class="entry-secondary">Value</span><code>${esc(nominee.value)}</code>
          <button class="secondary" onclick="copyChosenValue(this)">Copy</button></div>
        <button class="secondary" onclick="chooseWinner(null)">Close</button>
      </div>`;
  }
  return `
    <div class="ceremony-confirm">
      <p>Announce <strong>${esc(nominee.value)}</strong> as the winner of ${esc(categories[ceremony.category].label)}?</p>
      <div class="row">
        <button class="${live ? 'live' : ''}" onclick="sendChosenWinner()" ${ceremony.busy ? 'disabled' : ''}>
          ${live ? `Announce to the live ${esc(currentYear)} app` : 'Announce in rehearsal'}
        </button>
        <button class="secondary" onclick="chooseWinner(null)">Cancel</button>
      </div>
      <p class="entry-secondary">Enter announces, Esc cancels.</p>
    </div>`;
}

function renderCeremonyStart() {
  const data = ceremony.data;
  const live = ceremony.target === 'live';
  const can = data.canWrite ? '' : 'disabled title="Needs the service account key"';
  if (!live) {
    const started = data.ceremonyStarted === true;
    return `
      <div class="ceremony-start">
        <span>Test ceremony: <strong>${started ? 'started' : 'not started'}</strong></span>
        <button class="secondary" onclick="setCeremonyStart(${started ? 'null' : 'Date.now()'})" ${can}>${started ? 'End it' : 'Start it'}</button>
        <button class="secondary" onclick="clearRehearsal()" ${can}>Clear all rehearsal winners</button>
      </div>`;
  }
  const season = manifest.years.find(year => year.id === currentYear);
  const scheduled = season && season.ceremonyDate ? Date.parse(season.ceremonyDate) : null;
  const when = ms => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  return `
    <div class="ceremony-start">
      <span>Ballots lock at: <strong>${data.ceremonyStart ? esc(when(data.ceremonyStart)) : 'not set'}</strong>
        <span class="entry-secondary">(your local time)</span></span>
      ${scheduled ? `<button class="secondary" onclick="setCeremonyStart(${scheduled})" ${can}>Set to the scheduled start (${esc(when(scheduled))})</button>` : ''}
      ${data.ceremonyStart ? `<button class="secondary" onclick="setCeremonyStart(null)" ${can}>Clear</button>` : ''}
    </div>`;
}

function chooseWinner(index) {
  ceremony.chosen = index;
  renderCeremonyMode();
}

function chosenNominee() {
  return ceremony.chosen === null ? null : ceremonyNominees(ceremony.category)[ceremony.chosen];
}

function copyText(button, text) {
  navigator.clipboard.writeText(text).then(() => { button.textContent = 'Copied'; });
}

function copyChosenValue(button) {
  const nominee = chosenNominee();
  if (nominee) copyText(button, nominee.value);
}

function sendChosenWinner() {
  const nominee = chosenNominee();
  if (nominee) sendWinner(nominee.value);
}

async function ceremonyPut(pathSuffix, body) {
  const response = await fetch(`/api/ceremony/${ceremonyTargetYear()}/${pathSuffix}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!data.success) throw new Error(data.error || 'Not sent');
}

async function sendWinner(value) {
  if (ceremony.busy) return;
  const appName = APP_CATEGORY[ceremony.category];
  if (value === null && !confirm(`Clear the winner of ${categories[ceremony.category].label}?`)) return;
  ceremony.busy = true;
  try {
    await ceremonyPut('winner', { category: appName, winner: value });
    showStatus(value === null ? 'Winner cleared' : `Sent: ${value}`, 'success');
    ceremony.chosen = null;
    // Move on to the next category that has no winner yet.
    await refreshCeremony();
    if (value !== null) {
      const keys = Object.keys(categories);
      const start = keys.indexOf(ceremony.category);
      const next = keys.slice(start + 1).concat(keys.slice(0, start))
        .find(k => !(ceremony.data.winners || {})[APP_CATEGORY[k]]);
      if (next) ceremony.category = next;
    }
  } catch (e) {
    showStatus('Not sent: ' + e.message, 'error');
  }
  ceremony.busy = false;
  renderCeremonyMode();
}

async function setCeremonyStart(timestamp) {
  const live = ceremony.target === 'live';
  if (live && !confirm(timestamp === null
    ? 'Clear the ceremony start? Pool ballots would be editable again.'
    : 'Set the ceremony start? After that time, pool ballots can no longer be changed.')) return;
  try {
    await ceremonyPut('start', { timestamp });
    showStatus('Ceremony start updated', 'success');
    await refreshCeremony();
  } catch (e) {
    showStatus('Not sent: ' + e.message, 'error');
  }
  renderCeremonyMode();
}

async function clearRehearsal() {
  if (!confirm('Clear every winner in the test season?')) return;
  try {
    for (const appName of Object.keys(ceremony.data.winners || {})) {
      await ceremonyPut('winner', { category: appName, winner: null });
    }
    showStatus('Rehearsal winners cleared', 'success');
    await refreshCeremony();
  } catch (e) {
    showStatus('Not sent: ' + e.message, 'error');
  }
  renderCeremonyMode();
}

document.addEventListener('keydown', (e) => {
  if (currentMode !== 'ceremony' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof Element && e.target.closest('input, select, textarea')) return;
  const keys = Object.keys(categories);
  const index = keys.indexOf(ceremony.category);
  if (e.key === 'ArrowDown') { e.preventDefault(); setCeremonyCategory(keys[(index + 1) % keys.length]); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setCeremonyCategory(keys[(index - 1 + keys.length) % keys.length]); }
  else if (e.key === 'Escape' && ceremony.chosen !== null) { chooseWinner(null); }
  else if (e.key === 'Enter' && ceremony.chosen !== null && ceremony.data && ceremony.data.canWrite) { e.preventDefault(); sendChosenWinner(); }
});
