// Category entry: the Shortlists and Nominations screens.
//
// Built for speed on announcement day. Every category is one click away in
// the sidebar, the cursor is always in one box, and a nominee is added by
// typing a few letters and pressing Enter. A film that is not in the season
// yet is picked from TMDB, so it always arrives with the right TMDB ID.
//
// Uses the shared state and helpers declared in index.html (films, manifest,
// categories, tmdbInfo, esc, plainTitle, addNewFilm, showStatus, ...).

let entryStage = null;        // 'shortlist' or 'nominations'; null until a season is opened
let entryInfoTriedFor = null; // the season we already asked TMDB about
let pasteState = null;        // the "Paste a list" panel, when open

// The one text box and its list of suggestions.
const quick = {
  text: '',
  items: [],
  index: 0,
  pending: null,     // { kind: 'actorFilm', name } or { kind: 'songTitle', film }
  tmdbResults: null, // results of the last TMDB search for this text
  searching: false,
  token: 0,
  timer: null
};

// ---------- Which categories, and how many are in each ----------

function expectedCount(cat) {
  return cat === 'bestpicture' ? 10 : 5;
}

function isNominated(song) {
  return song.nominated !== false; // older files have no flag: those songs are nominees
}

function stageCategories() {
  const entries = Object.entries(categories);
  if (entryStage === 'shortlist') {
    return entries.filter(([, val]) => val.shortlist).sort((a, b) => a[1].label.localeCompare(b[1].label));
  }
  return entries;
}

function shortlistCount(cat) {
  const config = categories[cat];
  if (config.type === 'song') {
    return films.reduce((sum, f) => sum + (f[config.shortlist] ? (f.bestoriginalsong || []).length : 0), 0);
  }
  return films.filter(f => f[config.shortlist]).length;
}

function getNominationCount(cat) {
  const config = categories[cat];
  if (config.type === 'boolean') return films.filter(f => f[cat]).length;
  if (config.type === 'acting') return films.reduce((sum, f) => sum + (f[cat] ? f[cat].length : 0), 0);
  return films.reduce((sum, f) => sum + (f.bestoriginalsong || []).filter(isNominated).length, 0);
}

// What kind of film a category expects, used to rank TMDB results.
function categoryTraits(cat) {
  return {
    short: /short(?!list)/i.test(cat),
    documentary: /documentary/i.test(cat),
    animation: /animated/i.test(cat)
  };
}

// ---------- Layout ----------

function renderCategorySidebar() {
  const item = ([key, val]) => {
    let count, state = '';
    if (entryStage === 'shortlist') {
      count = String(shortlistCount(key));
    } else {
      const have = getNominationCount(key);
      const expected = expectedCount(key);
      state = have === expected ? 'done' : have > expected ? 'over' : '';
      count = `${have}/${expected}`;
    }
    return `
      <button class="cat-item ${key === currentCategory ? 'active' : ''} ${state}" onclick="changeCategory('${key}')">
        <span>${esc(val.label)}</span>
        <span class="cat-count">${count}</span>
      </button>`;
  };
  const entries = stageCategories();
  const body = entryStage === 'shortlist'
    ? entries.map(item).join('')
    : `<h4>First group</h4>${entries.filter(([, val]) => val.group === 1).map(item).join('')}
       <h4>Second group</h4>${entries.filter(([, val]) => val.group === 2).map(item).join('')}`;
  return `
    <nav class="cat-sidebar" id="catSidebar">
      <div class="mode-toggle stage-toggle">
        <button class="${entryStage === 'shortlist' ? 'active' : ''}" onclick="setEntryStage('shortlist')">Shortlists</button>
        <button class="${entryStage === 'nominations' ? 'active' : ''}" onclick="setEntryStage('nominations')">Nominations</button>
      </div>
      ${body}
      <p class="cat-hint">With the box empty, ↑ ↓ move between categories</p>
    </nav>`;
}

function renderNominationMode() {
  if (!entryStage) {
    const season = manifest.years.find(y => y.id === currentYear);
    entryStage = season && season.nominationsAnnounced ? 'nominations' : 'shortlist';
  }
  const available = stageCategories();
  if (!available.some(([key]) => key === currentCategory)) currentCategory = available[0][0];

  const editor = document.getElementById('editor');
  const config = categories[currentCategory];
  const sidebarScroll = document.getElementById('catSidebar')?.scrollTop || 0;
  const countText = entryStage === 'shortlist'
    ? `${shortlistCount(currentCategory)} shortlisted`
    : `${getNominationCount(currentCategory)} of ${expectedCount(currentCategory)} nominated`;
  const canPaste = !(entryStage === 'nominations' && config.type === 'acting');

  editor.innerHTML = `
    <div class="nom-layout">
      ${renderCategorySidebar()}
      <div class="nomination-container">
        <div class="nomination-header">
          <h2>${esc(config.label)}</h2>
          <span class="nom-count">${countText}</span>
          ${canPaste && !pasteState ? '<button class="secondary" style="margin-left:auto" onclick="openPaste()">Paste a list</button>' : ''}
        </div>
        ${pasteState ? renderPaste() : `
          <div class="quick-add">
            <input type="text" id="quickAdd" autocomplete="off" spellcheck="false"
                   placeholder="${esc(quickPlaceholder())}" value="${esc(quick.text)}"
                   oninput="quickInput()" onkeydown="quickKey(event)">
            ${quick.pending ? '<button class="secondary" onclick="resetQuick(); renderNominationMode()">Cancel</button>' : ''}
          </div>
          <div id="quickResults"></div>
          ${renderEntries()}`}
      </div>
    </div>
    <button class="save-float" onclick="saveFilms()">Save All Changes</button>
  `;
  document.getElementById('catSidebar').scrollTop = sidebarScroll;
  if (!pasteState) {
    renderQuickResults();
    document.getElementById('quickAdd').focus({ preventScroll: true });
  }

  // Posters and cast lists come from TMDB, once per season, in the background.
  if (entryInfoTriedFor !== currentYear && !tmdbLoading) {
    entryInfoTriedFor = currentYear;
    loadTmdbInfo().then(() => {
      if (currentMode === 'nomination' && !quick.text && !pasteState) renderNominationMode();
    });
  }
}

function setEntryStage(stage) {
  entryStage = stage;
  pasteState = null;
  resetQuick();
  renderNominationMode();
}

function changeCategory(cat) {
  currentCategory = cat;
  pasteState = null;
  resetQuick();
  renderNominationMode();
}

function stepCategory(delta) {
  const keys = stageCategories().map(([key]) => key);
  const index = keys.indexOf(currentCategory);
  changeCategory(keys[(index + delta + keys.length) % keys.length]);
}

document.addEventListener('keydown', (e) => {
  if (currentMode !== 'nomination' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof Element && e.target.closest('input, select, textarea')) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); stepCategory(1); }
  if (e.key === 'ArrowUp') { e.preventDefault(); stepCategory(-1); }
});

// ---------- What is already in the category ----------

function filmThumb(film) {
  const info = film.tmdbId ? tmdbInfo[film.tmdbId] : null;
  return info && info.poster ? `<img class="thumb" src="${esc(info.poster)}" alt="" loading="lazy">` : '<div class="thumb"></div>';
}

function filmFacts(film) {
  if (!film.tmdbId) return 'No TMDB ID';
  const info = tmdbInfo[film.tmdbId];
  if (!info) return '';
  return [info.year, info.director].filter(Boolean).join(' · ');
}

function entryRow(film, primary, secondary, removeCall, extra = '') {
  return `
    <div class="nominated-item">
      ${filmThumb(film)}
      <div class="entry-text">
        <div class="entry-primary">${primary}</div>
        <div class="entry-secondary ${!film.tmdbId ? 'match-bad' : ''}">${secondary}</div>
        ${extra}
      </div>
      <button class="secondary" onclick="${removeCall}">Remove</button>
    </div>`;
}

function byTitle(a, b) {
  return a.title.localeCompare(b.title);
}

function renderEntries() {
  const cat = currentCategory;
  const config = categories[cat];
  const none = '<p style="color: #666;">Nothing here yet</p>';

  if (entryStage === 'shortlist') {
    if (config.type === 'song') {
      const songs = [];
      films.filter(f => f[config.shortlist]).sort(byTitle).forEach(f =>
        (f.bestoriginalsong || []).forEach((song, index) => songs.push({ film: f, song, index })));
      songs.sort((a, b) => a.song.songTitle.localeCompare(b.song.songTitle));
      return `<div class="nominated-section"><h3>Shortlisted songs (${songs.length})</h3>
        <div class="nominated-list">${songs.map(s => entryRow(s.film,
          `"${esc(s.song.songTitle)}"`, `from ${esc(s.film.title)}`,
          `removeSong2('${s.film.id}', ${s.index})`)).join('') || none}</div></div>`;
    }
    const listed = films.filter(f => f[config.shortlist]).sort(byTitle);
    return `<div class="nominated-section"><h3>Shortlisted (${listed.length})</h3>
      <div class="nominated-list">${listed.map(f => entryRow(f, esc(f.title), esc(filmFacts(f)),
        `setFlag('${f.id}', '${config.shortlist}', false)`)).join('') || none}</div></div>`;
  }

  if (config.type === 'acting') {
    const people = [];
    films.forEach(f => (f[cat] || []).forEach((entry, index) => people.push({ film: f, name: entry.actorName, index })));
    people.sort((a, b) => a.name.localeCompare(b.name));
    return `<div class="nominated-section"><h3>Nominated (${people.length})</h3>
      <div class="nominated-list">${people.map(p => entryRow(p.film, esc(p.name), esc(p.film.title),
        `removeActing('${p.film.id}', '${cat}', ${p.index})`)).join('') || none}</div></div>`;
  }

  if (config.type === 'song') {
    const shortlisted = [], nominated = [];
    films.forEach(f => (f.bestoriginalsong || []).forEach((song, index) => {
      const entry = { film: f, song, index };
      if (isNominated(song)) nominated.push(entry);
      else if (f[config.shortlist]) shortlisted.push(entry);
    }));
    const bySong = (a, b) => a.song.songTitle.localeCompare(b.song.songTitle);
    return `
      ${shortlisted.length ? `<div class="shortlisted-section"><h3>Shortlisted songs (click to nominate)</h3>
        <div class="film-chips">${shortlisted.sort(bySong).map(s => `
          <div class="film-chip" onclick="setSongNominated('${s.film.id}', ${s.index}, true)">
            "${esc(s.song.songTitle)}" <span class="chip-dim">${esc(s.film.title)}</span>
          </div>`).join('')}</div></div>` : ''}
      <div class="nominated-section"><h3>Nominated (${nominated.length})</h3>
        <div class="nominated-list">${nominated.sort(bySong).map(s => entryRow(s.film,
          `"${esc(s.song.songTitle)}"`, `from ${esc(s.film.title)}`,
          `setSongNominated('${s.film.id}', ${s.index}, false)`,
          `<input type="text" class="writers" placeholder="Songwriters, separated by commas"
                  value="${esc((s.song.songwriters || []).join(', '))}"
                  onchange="setSongwriters('${s.film.id}', ${s.index}, this.value)">`)).join('') || none}</div></div>`;
  }

  const shortlisted = config.shortlist ? films.filter(f => f[config.shortlist] && !f[cat]).sort(byTitle) : [];
  const nominated = films.filter(f => f[cat]).sort(byTitle);
  return `
    ${shortlisted.length ? `<div class="shortlisted-section"><h3>Shortlisted (click to nominate)</h3>
      <div class="film-chips">${shortlisted.map(f => `
        <div class="film-chip" onclick="setFlag('${f.id}', '${cat}', true)">${esc(f.title)}</div>`).join('')}</div></div>` : ''}
    <div class="nominated-section"><h3>Nominated (${nominated.length})</h3>
      <div class="nominated-list">${nominated.map(f => entryRow(f, esc(f.title), esc(filmFacts(f)),
        `setFlag('${f.id}', '${cat}', false)`)).join('') || none}</div></div>`;
}

// ---------- Changes ----------

function findFilm(id) {
  return films.find(f => f.id === id);
}

function setFlag(filmId, key, value) {
  const film = findFilm(filmId);
  if (film) film[key] = value;
  renderNominationMode();
}

function removeActing(filmId, cat, index) {
  const film = findFilm(filmId);
  if (film && film[cat]) film[cat].splice(index, 1);
  renderNominationMode();
}

function setSongNominated(filmId, index, value) {
  const film = findFilm(filmId);
  if (film && film.bestoriginalsong[index]) film.bestoriginalsong[index].nominated = value;
  renderNominationMode();
}

function setSongwriters(filmId, index, value) {
  const film = findFilm(filmId);
  if (film && film.bestoriginalsong[index]) {
    film.bestoriginalsong[index].songwriters = value.split(',').map(s => s.trim()).filter(Boolean);
  }
}

// Removing a film's last shortlisted song takes the film off the song shortlist too.
function removeSong2(filmId, index) {
  const film = findFilm(filmId);
  if (!film) return;
  film.bestoriginalsong.splice(index, 1);
  if (film.bestoriginalsong.length === 0) film.shortlistOriginalSong = false;
  renderNominationMode();
}

function addActing(film, name) {
  const cat = currentCategory;
  if (!film[cat]) film[cat] = [];
  if (!film[cat].some(entry => plainTitle(entry.actorName) === plainTitle(name))) film[cat].push({ actorName: name.trim() });
}

function addSongTo(film, title) {
  if (!film.bestoriginalsong) film.bestoriginalsong = [];
  const existing = film.bestoriginalsong.find(song => plainTitle(song.songTitle) === plainTitle(title));
  if (entryStage === 'shortlist') {
    film.shortlistOriginalSong = true;
    if (!existing) film.bestoriginalsong.push({ songTitle: title.trim(), songwriters: [], nominated: false });
  } else if (existing) {
    existing.nominated = true;
  } else {
    film.bestoriginalsong.push({ songTitle: title.trim(), songwriters: [], nominated: true });
  }
}

// Puts a film into the current category for the current stage.
function addFilmToCategory(film) {
  const config = categories[currentCategory];
  film[entryStage === 'shortlist' ? config.shortlist : currentCategory] = true;
}

// The season's film for a TMDB result: the one that already has that ID, or a new one.
function filmForTmdb(movie, title) {
  const existing = films.find(f => f.tmdbId === movie.id);
  if (existing) return existing;
  const film = addNewFilm(title || movie.title);
  film.tmdbId = movie.id;
  tmdbInfo[movie.id] = movie;
  return film;
}

// ---------- The quick-add box ----------

function resetQuick() {
  clearTimeout(quick.timer);
  quick.text = '';
  quick.items = [];
  quick.index = 0;
  quick.pending = null;
  quick.tmdbResults = null;
  quick.searching = false;
  quick.token++;
}

function quickMode() {
  if (quick.pending?.kind === 'songTitle') return 'songTitle';
  if (quick.pending?.kind === 'actorFilm') return 'film';
  if (entryStage === 'nominations' && categories[currentCategory].type === 'acting') return 'person';
  return 'film';
}

function quickPlaceholder() {
  if (quick.pending?.kind === 'songTitle') return `Song title from ${quick.pending.film.title}, then Enter`;
  if (quick.pending?.kind === 'actorFilm') return `Which film is ${quick.pending.name} nominated for?`;
  if (quickMode() === 'person') return 'Type a name, then Enter';
  if (categories[currentCategory].type === 'song') return 'Type the film the song is from';
  return 'Type a film title, then Enter';
}

// Every top-billed name in the season's films, for picking acting nominees.
function castIndex() {
  const entries = [];
  for (const film of films) {
    const info = film.tmdbId ? tmdbInfo[film.tmdbId] : null;
    ((info && info.cast) || []).forEach((name, billing) => entries.push({ name, film, billing }));
  }
  return entries;
}

function rankText(candidate, query) {
  if (candidate === query) return 0;
  if (candidate.startsWith(query)) return 1;
  if ((' ' + candidate).includes(' ' + query)) return 2;
  return 3;
}

function buildQuickItems() {
  const query = plainTitle(quick.text);
  const mode = quickMode();
  const cat = currentCategory;
  const config = categories[cat];
  quick.items = [];
  quick.index = 0;
  if (!query) return;

  if (mode === 'songTitle') {
    quick.items.push({ kind: 'songTitle' });
    return;
  }

  if (mode === 'person') {
    const matches = castIndex()
      .filter(entry => plainTitle(entry.name).includes(query))
      .filter(entry => !(entry.film[cat] || []).some(existing => plainTitle(existing.actorName) === plainTitle(entry.name)))
      // Best text match first, then the most prominently billed: nominees are
      // nearly always among a film's first few names.
      .sort((a, b) => rankText(plainTitle(a.name), query) - rankText(plainTitle(b.name), query) || a.billing - b.billing || a.name.localeCompare(b.name))
      .slice(0, 8);
    matches.forEach(entry => quick.items.push({ kind: 'person', name: entry.name, film: entry.film }));
    quick.items.push({ kind: 'actorName' });
    return;
  }

  // Choosing a film: this season's films first, then TMDB.
  const flag = entryStage === 'shortlist' ? config.shortlist : cat;
  const skipExisting = !quick.pending && config.type === 'boolean';
  const local = films
    .filter(f => plainTitle(f.title).includes(query) && !(skipExisting && f[flag]))
    .sort((a, b) => rankText(plainTitle(a.title), query) - rankText(plainTitle(b.title), query) || byTitle(a, b))
    .slice(0, 8);
  local.forEach(film => quick.items.push({ kind: 'film', film }));

  if (quick.tmdbResults) {
    const inSeason = new Set(films.map(f => f.tmdbId).filter(Boolean));
    quick.tmdbResults.filter(movie => !inSeason.has(movie.id)).slice(0, 6)
      .forEach(movie => quick.items.push({ kind: 'tmdb', movie }));
  } else {
    quick.items.push({ kind: 'search' });
  }
}

function quickInput() {
  quick.text = document.getElementById('quickAdd').value;
  quick.tmdbResults = null;
  quick.searching = false;
  quick.token++;
  clearTimeout(quick.timer);
  buildQuickItems();
  renderQuickResults();
  // Nothing in the season matches: look on TMDB without being asked.
  const onlySearch = quick.items.length === 1 && quick.items[0].kind === 'search';
  if (onlySearch && plainTitle(quick.text).length >= 3) quick.timer = setTimeout(runQuickSearch, 350);
}

// Orders TMDB results so the likeliest film for this season and category is first.
function rankTmdb(results, title, cat) {
  const season = parseInt(currentYear);
  const traits = categoryTraits(cat);
  const wanted = plainTitle(title);
  const score = movie => {
    let points = 0;
    const year = parseInt(movie.year);
    if (year >= season - 2 && year <= season) points += 3;
    if (plainTitle(movie.title) === wanted || plainTitle(movie.originalTitle) === wanted) points += 3;
    if (traits.short && movie.runtime) points += movie.runtime <= 45 ? 2 : -2;
    if (!traits.short && movie.runtime && movie.runtime < 40) points -= 3; // a short with a feature's title
    if (traits.documentary && (movie.genres || []).length) points += movie.genres.includes('Documentary') ? 2 : -2;
    if (traits.animation && (movie.genres || []).length) points += movie.genres.includes('Animation') ? 2 : -2;
    return points;
  };
  return results.map((movie, order) => ({ movie, points: score(movie), order }))
    .sort((a, b) => b.points - a.points || a.order - b.order)
    .map(entry => entry.movie);
}

async function searchTmdbFor(title) {
  const data = await fetch(`/api/tmdb/search?q=${encodeURIComponent(title)}&season=${currentYear}`).then(r => r.json());
  if (data.error) throw new Error(data.error);
  data.results.forEach(movie => { tmdbInfo[movie.id] = movie; });
  return data.results;
}

async function runQuickSearch() {
  const text = quick.text.trim();
  if (!text) return;
  const token = ++quick.token;
  quick.searching = true;
  renderQuickResults();
  try {
    const results = rankTmdb(await searchTmdbFor(text), text, currentCategory);
    if (token !== quick.token) return;
    quick.tmdbResults = results;
  } catch (e) {
    if (token !== quick.token) return;
    showStatus('TMDB: ' + e.message, 'error');
  }
  quick.searching = false;
  buildQuickItems();
  renderQuickResults();
}

function renderQuickResults() {
  const box = document.getElementById('quickResults');
  if (!box) return;
  const text = quick.text.trim();
  const rows = quick.items.map((item, i) => {
    const active = i === quick.index ? 'active' : '';
    const open = `<div class="quick-item ${active}" onmousedown="event.preventDefault()" onclick="chooseQuickAt(${i})">`;
    if (item.kind === 'film') {
      const config = categories[currentCategory];
      const listed = entryStage === 'nominations' && config.shortlist && item.film[config.shortlist];
      return `${open}${filmThumb(item.film)}<div><div class="entry-primary">${esc(item.film.title)}${listed ? ' <span class="badge shortlisted">SHORTLISTED</span>' : ''}</div>
        <div class="entry-secondary">${esc(filmFacts(item.film))}</div></div></div>`;
    }
    if (item.kind === 'person') {
      return `${open}${filmThumb(item.film)}<div><div class="entry-primary">${esc(item.name)}</div>
        <div class="entry-secondary">${esc(item.film.title)}</div></div></div>`;
    }
    if (item.kind === 'tmdb') {
      const movie = item.movie;
      return `${open}${movie.poster ? `<img class="thumb" src="${esc(movie.poster)}" alt="">` : '<div class="thumb"></div>'}
        <div><div class="entry-primary">${esc(movie.title)}${movie.originalTitle ? ` <span class="chip-dim">(${esc(movie.originalTitle)})</span>` : ''} <span class="badge">NEW, FROM TMDB</span></div>
        <div class="entry-secondary">${esc([movie.year || 'No date', movie.director || 'No director', movie.runtime ? movie.runtime + ' min' : ''].filter(Boolean).join(' · '))}</div></div></div>`;
    }
    if (item.kind === 'search') {
      return `${open}<div class="entry-primary">${quick.searching ? 'Searching TMDB...' : `Search TMDB for "${esc(text)}"`}</div></div>`;
    }
    if (item.kind === 'actorName') {
      return `${open}<div class="entry-primary">Use the name "${esc(text)}" and choose the film next</div></div>`;
    }
    return `${open}<div class="entry-primary">Add the song "${esc(text)}"</div></div>`;
  });
  if (quick.tmdbResults && !quick.items.some(item => item.kind === 'tmdb' || item.kind === 'film')) {
    rows.push('<div class="quick-item"><div class="entry-secondary">Nothing found on TMDB. Try the original-language title, or add the film in Film Mode and paste a TMDB link there.</div></div>');
  }
  box.innerHTML = rows.join('');
  box.style.display = rows.length ? 'block' : 'none';
}

function quickKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (quick.items.length === 0) {
      if (!quick.text && !quick.pending) stepCategory(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    const step = e.key === 'ArrowDown' ? 1 : -1;
    quick.index = (quick.index + step + quick.items.length) % quick.items.length;
    renderQuickResults();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (quick.items.length) chooseQuickAt(quick.index);
  } else if (e.key === 'Escape') {
    resetQuick();
    renderNominationMode();
  }
}

function chooseQuickAt(index) {
  const item = quick.items[index];
  if (!item) return;
  const text = quick.text.trim();

  if (item.kind === 'search') {
    if (!quick.searching) runQuickSearch();
    return;
  }
  if (item.kind === 'actorName') {
    quick.pending = { kind: 'actorFilm', name: text };
    askNext();
    return;
  }
  if (item.kind === 'person') {
    addActing(item.film, item.name);
    return finishQuick(`${item.name} added`);
  }
  if (item.kind === 'songTitle') {
    addSongTo(quick.pending.film, text);
    return finishQuick(`"${text}" added`);
  }

  // A film was chosen, from this season or from TMDB.
  const film = item.kind === 'tmdb' ? filmForTmdb(item.movie) : item.film;
  if (quick.pending?.kind === 'actorFilm') {
    addActing(film, quick.pending.name);
    return finishQuick(`${quick.pending.name} added`);
  }
  if (categories[currentCategory].type === 'song') {
    quick.pending = { kind: 'songTitle', film };
    askNext();
    return;
  }
  addFilmToCategory(film);
  finishQuick(`${film.title} added`);
}

// Keeps the pending step, clears the text, and asks the follow-up question.
function askNext() {
  const pending = quick.pending;
  resetQuick();
  quick.pending = pending;
  renderNominationMode();
}

function finishQuick(message) {
  resetQuick();
  showStatus(message + ' (not saved yet)', 'success');
  renderNominationMode();
}

// ---------- Paste a list ----------

function openPaste() {
  resetQuick();
  pasteState = { text: '', rows: null, busy: false };
  renderNominationMode();
}

function closePaste() {
  pasteState = null;
  renderNominationMode();
}

const QUOTES = '"“”‘’\'';
function stripQuotes(text) {
  let out = text.trim();
  while (out && QUOTES.includes(out[0])) out = out.slice(1);
  while (out && QUOTES.includes(out[out.length - 1])) out = out.slice(0, -1);
  return out.trim();
}

// Turns one pasted line into a film title (and a song title, for songs).
// Understands bullets and numbering, quotes, `Country, "Title"` and
// `"Song" from Film`.
function parsePasteLine(line, isSong) {
  let text = line.replace(/^\s*(?:[-–•*]|\d+[.)])\s*/, '').trim().replace(/[;,]$/, '').trim();
  if (!text) return null;
  if (isSong) {
    const match = text.match(/^(.+?)\s+from\s+(.+)$/i);
    if (!match) return { title: '', song: stripQuotes(text), problem: 'Write it as: Song title from Film title' };
    return { song: stripQuotes(match[1]), title: stripQuotes(match[2]) };
  }
  const country = text.match(/^[^,"“]{2,40},\s*["“](.+?)["”]$/);
  if (country) return { title: country[1].trim() };
  return { title: stripQuotes(text) };
}

async function matchPaste() {
  const isSong = categories[currentCategory].type === 'song';
  const cat = currentCategory;
  pasteState.text = document.getElementById('pasteText').value;
  const rows = pasteState.text.split('\n').map(line => parsePasteLine(line, isSong)).filter(Boolean);
  if (rows.length === 0) return;
  pasteState.rows = rows;
  pasteState.busy = true;
  renderNominationMode();

  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      if (row.problem) continue;
      const wanted = plainTitle(row.title);
      row.film = films.find(f => plainTitle(f.title) === wanted) || null;
      if (row.film) continue;
      try {
        row.candidates = rankTmdb(await searchTmdbFor(row.title), row.title, cat).slice(0, 6);
      } catch (e) {
        row.candidates = [];
        row.problem = 'TMDB: ' + e.message;
      }
      row.pick = row.candidates[0] || null;
      if (row.pick) {
        row.film = films.find(f => f.tmdbId === row.pick.id) || null;
        row.sure = isConfident(row.pick, row.candidates, row.title, cat);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  rows.forEach(row => { row.include = Boolean(row.film || row.pick) && !row.problem; });
  pasteState.busy = false;
  if (currentMode === 'nomination' && pasteState) renderNominationMode();
}

// A match needs no second look when the title is exact, the year fits the
// season, the film fits the category, and no other result does all three.
function isConfident(pick, candidates, title, cat) {
  const season = parseInt(currentYear);
  const traits = categoryTraits(cat);
  const wanted = plainTitle(title);
  const fits = movie => {
    const year = parseInt(movie.year);
    if (!(plainTitle(movie.title) === wanted || plainTitle(movie.originalTitle) === wanted)) return false;
    if (!(year >= season - 2 && year <= season)) return false;
    if (traits.short && movie.runtime > 45) return false;
    if (!traits.short && movie.runtime && movie.runtime < 40) return false;
    if (traits.documentary && !(movie.genres || []).includes('Documentary')) return false;
    if (traits.animation && !(movie.genres || []).includes('Animation')) return false;
    return true;
  };
  return fits(pick) && candidates.filter(fits).length === 1;
}

function renderPaste() {
  const isSong = categories[currentCategory].type === 'song';
  if (!pasteState.rows) {
    return `
      <div class="paste-panel">
        <p class="entry-secondary">One per line. Bullets, numbering and quotes are fine.
          ${isSong ? 'Write each as: Song title from Film title.' : 'Lines like Country, "Title" work too.'}</p>
        <textarea id="pasteText" rows="14" placeholder="${isSong ? '&quot;Song Title&quot; from Film Title' : 'Film Title'}">${esc(pasteState.text)}</textarea>
        <div class="row">
          <button onclick="matchPaste()">Match films</button>
          <button class="secondary" onclick="closePaste()">Cancel</button>
        </div>
      </div>`;
  }
  if (pasteState.busy) return '<div class="paste-panel"><p>Matching each line to a film...</p></div>';

  const rows = pasteState.rows;
  const included = rows.filter(row => row.include).length;
  const toCheck = rows.filter(row => !row.problem && !row.film && row.pick && !row.sure).length;
  const missing = rows.filter(row => row.problem || (!row.film && !row.pick)).length;
  return `
    <div class="paste-panel">
      <p class="entry-secondary">${rows.length} lines: ${rows.length - toCheck - missing} matched${toCheck ? `, ${toCheck} to check` : ''}${missing ? `, ${missing} not found` : ''}.</p>
      ${rows.map(renderPasteRow).join('')}
      <div class="row">
        <button onclick="applyPaste()">Add ${included} to ${esc(categories[currentCategory].label)}</button>
        <button class="secondary" onclick="pasteState.rows = null; renderNominationMode()">Back to the list</button>
        <button class="secondary" onclick="closePaste()">Cancel</button>
      </div>
    </div>`;
}

function renderPasteRow(row, i) {
  const label = row.song ? `"${esc(row.song)}" <span class="chip-dim">from ${esc(row.title)}</span>` : esc(row.title);
  let match, state = '';
  if (row.problem) {
    state = 'missing';
    match = `<div class="entry-secondary match-bad">${esc(row.problem)}</div>`;
  } else if (row.film && !row.pick) {
    match = `${filmThumb(row.film)}<div><div class="entry-primary">${esc(row.film.title)}</div><div class="entry-secondary">Already in this season</div></div>`;
  } else if (row.pick) {
    const movie = row.pick;
    state = row.sure || row.film ? '' : 'check';
    match = `${movie.poster ? `<img class="thumb" src="${esc(movie.poster)}" alt="">` : '<div class="thumb"></div>'}
      <div><div class="entry-primary">${esc(movie.title)}${movie.originalTitle ? ` <span class="chip-dim">(${esc(movie.originalTitle)})</span>` : ''}</div>
      <div class="entry-secondary">${esc([movie.year || 'No date', movie.director || 'No director', movie.runtime ? movie.runtime + ' min' : '', (movie.genres || []).slice(0, 2).join(', ')].filter(Boolean).join(' · '))}</div>
      ${row.film ? '<div class="entry-secondary">Already in this season</div>' : state ? '<span class="match-flag">Check this one</span>' : ''}</div>`;
  } else {
    state = 'missing';
    match = '<div class="entry-secondary match-bad">Not found on TMDB</div>';
  }
  const others = (row.candidates || []).length > 1 ? `
    <select onchange="pastePick(${i}, this.value)">
      ${row.candidates.map(movie => `<option value="${Number(movie.id)}" ${row.pick && movie.id === row.pick.id ? 'selected' : ''}>${esc(movie.title)} (${esc(movie.year || '?')}, ${esc(movie.director || '?')})</option>`).join('')}
    </select>` : '';
  const fix = row.problem && !row.title ? '' : `
    <input type="text" placeholder="Or paste a TMDB or IMDb link" onkeydown="if(event.key==='Enter') pasteLink(${i}, this.value)">`;
  return `
    <div class="paste-row ${state}">
      <input type="checkbox" ${row.include ? 'checked' : ''} ${row.film || row.pick ? '' : 'disabled'} onchange="pasteState.rows[${i}].include = this.checked; renderNominationMode()">
      <div class="paste-line">${label}</div>
      <div class="paste-match">${match}</div>
      <div class="paste-fix">${others}${fix}</div>
    </div>`;
}

function pastePick(i, id) {
  const row = pasteState.rows[i];
  row.pick = row.candidates.find(movie => movie.id === Number(id)) || row.pick;
  row.film = films.find(f => f.tmdbId === row.pick.id) || null;
  row.sure = true; // chosen by hand
  row.include = true;
  renderNominationMode();
}

async function pasteLink(i, pasted) {
  const row = pasteState.rows[i];
  try {
    const data = await fetch(`/api/tmdb/resolve?q=${encodeURIComponent(pasted.trim())}`).then(r => r.json());
    if (data.error) throw new Error(data.error);
    tmdbInfo[data.film.id] = data.film;
    row.pick = data.film;
    row.candidates = [data.film, ...(row.candidates || []).filter(movie => movie.id !== data.film.id)];
    row.film = films.find(f => f.tmdbId === data.film.id) || null;
    row.problem = null;
    row.sure = true;
    row.include = true;
    renderNominationMode();
  } catch (e) {
    showStatus(e.message, 'error');
  }
}

function applyPaste() {
  const isSong = categories[currentCategory].type === 'song';
  let added = 0;
  for (const row of pasteState.rows) {
    if (!row.include) continue;
    // The pasted title is the official one, so a new film keeps it.
    const film = row.film || filmForTmdb(row.pick, row.title);
    if (isSong) addSongTo(film, row.song);
    else addFilmToCategory(film);
    added++;
  }
  pasteState = null;
  showStatus(`${added} added (not saved yet)`, 'success');
  renderNominationMode();
}
