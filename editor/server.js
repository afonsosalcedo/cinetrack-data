const express = require('express');
const fs = require('fs');
const path = require('path');
const { validateFilms, validateManifest, YEAR_PATTERN } = require('./validate');

const app = express();
// Both can be overridden to rehearse against a copy of the data:
//   CINETRACK_DATA_DIR=/path/to/copy PORT=3001 npm start
const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = process.env.CINETRACK_DATA_DIR
  ? path.resolve(process.env.CINETRACK_DATA_DIR)
  : path.join(__dirname, '..');

// TMDB API configuration
// The key is read from the environment or from editor/.env (gitignored).
// Never commit it: this repository is public.
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}
loadEnvFile();
const TMDB_API_KEY = process.env.TMDB_API_KEY;
if (!TMDB_API_KEY) {
  console.warn('\n  TMDB_API_KEY is not set. Add it to editor/.env; TMDB search will fail until then.\n');
}
const TMDB_BASE_URL = 'api.themoviedb.org';

// Writes to a temporary file first and then swaps it in, so a crash or a full
// disk can never leave a half-written season file behind.
function writeJsonAtomic(filepath, value) {
  const temp = `${filepath}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, filepath);
}

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'manifest.json'), 'utf8'));
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// Get manifest
app.get('/api/manifest', (req, res) => {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'manifest.json'), 'utf8'));
    res.json(manifest);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get films for a specific year
app.get('/api/films/:year', (req, res) => {
  try {
    if (!YEAR_PATTERN.test(req.params.year)) {
      return res.status(400).json({ error: 'Year must be four digits' });
    }
    const filepath = path.join(DATA_DIR, `oscars${req.params.year}.json`);
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'Year not found' });
    }
    const films = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    res.json(films);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check a season as it is on disk, without saving anything
app.get('/api/validate/:year', (req, res) => {
  try {
    if (!YEAR_PATTERN.test(req.params.year)) {
      return res.status(400).json({ error: 'Year must be four digits' });
    }
    const yearEntry = readManifest().years.find(y => y.id === req.params.year);
    const filepath = path.join(DATA_DIR, `oscars${req.params.year}.json`);
    if (!yearEntry || !fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'Year not found' });
    }
    const films = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    res.json(validateFilms(films, { nominationsAnnounced: yearEntry.nominationsAnnounced === true }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save films for a specific year. Nothing is written if the films would not
// load in the app.
app.post('/api/films/:year', (req, res) => {
  try {
    if (!YEAR_PATTERN.test(req.params.year)) {
      return res.status(400).json({ error: 'Year must be four digits' });
    }
    const { films, changelog } = req.body;
    const manifestPath = path.join(DATA_DIR, 'manifest.json');
    const manifest = readManifest();
    const yearEntry = manifest.years.find(y => y.id === req.params.year);
    if (!yearEntry) {
      return res.status(404).json({ error: `Season ${req.params.year} is not in the manifest` });
    }

    const { errors, warnings } = validateFilms(films, { nominationsAnnounced: yearEntry.nominationsAnnounced === true });
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Not saved: the data has errors', errors, warnings });
    }

    bumpVersion(manifest);
    if (typeof changelog === 'string' && changelog.trim()) {
      manifest.changelog = changelog.trim();
    }
    yearEntry.filmCount = films.length;

    const manifestCheck = validateManifest(manifest);
    if (manifestCheck.errors.length > 0) {
      return res.status(400).json({ error: 'Not saved: the manifest has errors', errors: manifestCheck.errors, warnings });
    }

    writeJsonAtomic(path.join(DATA_DIR, `oscars${req.params.year}.json`), films);
    writeJsonAtomic(manifestPath, manifest);

    res.json({ success: true, version: manifest.version, warnings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update manifest (for changelog, nominationsAnnounced, etc.)
app.post('/api/manifest', (req, res) => {
  try {
    const manifest = req.body;
    const { errors } = validateManifest(manifest);
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Not saved: the manifest has errors', errors });
    }
    writeJsonAtomic(path.join(DATA_DIR, 'manifest.json'), manifest);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---- Seasons ----

function bumpVersion(manifest) {
  const parts = manifest.version.split('.');
  parts[2] = parseInt(parts[2]) + 1;
  manifest.version = parts.join('.');
  manifest.lastUpdated = new Date().toISOString();
}

// Copies the season fields a form may set. Empty optional dates are removed.
function applySeasonFields(entry, body) {
  entry.ceremonyDate = body.ceremonyDate;
  for (const field of ['nominationsDate', 'shortlistDate']) {
    if (body[field]) entry[field] = body[field];
    else delete entry[field];
  }
  if (typeof body.nominationsAnnounced === 'boolean') entry.nominationsAnnounced = body.nominationsAnnounced;
}

// Create a season: an empty film file plus its manifest entry.
app.post('/api/seasons', (req, res) => {
  try {
    const id = String(req.body.id || '');
    if (!YEAR_PATTERN.test(id)) return res.status(400).json({ error: 'The season needs a four-digit year' });
    const manifest = readManifest();
    const filepath = path.join(DATA_DIR, `oscars${id}.json`);
    if (manifest.years.some(y => y.id === id) || fs.existsSync(filepath)) {
      return res.status(400).json({ error: `Season ${id} already exists` });
    }
    const entry = { id, filename: `oscars${id}.json`, nominationsAnnounced: false, filmCount: 0 };
    applySeasonFields(entry, { ...req.body, nominationsAnnounced: false });
    manifest.years.push(entry);
    manifest.years.sort((a, b) => b.id.localeCompare(a.id));
    bumpVersion(manifest);
    const { errors } = validateManifest(manifest);
    if (errors.length > 0) return res.status(400).json({ error: 'Not saved', errors });
    writeJsonAtomic(filepath, []);
    writeJsonAtomic(path.join(DATA_DIR, 'manifest.json'), manifest);
    res.json({ success: true, manifest });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Change a season's dates or its nominations-announced flag.
app.put('/api/seasons/:year', (req, res) => {
  try {
    const manifest = readManifest();
    const entry = manifest.years.find(y => y.id === req.params.year);
    if (!entry) return res.status(404).json({ error: 'Season not found' });
    applySeasonFields(entry, req.body);
    bumpVersion(manifest);
    const { errors } = validateManifest(manifest);
    if (errors.length > 0) return res.status(400).json({ error: 'Not saved', errors });
    writeJsonAtomic(path.join(DATA_DIR, 'manifest.json'), manifest);
    res.json({ success: true, manifest });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---- TMDB ----
// Used only to help choose the right film and to show what an ID points to.
// Nothing fetched here is written to the data files: they hold the TMDB ID
// and the app fetches the rest itself.

async function tmdbGet(pathAndQuery) {
  if (!TMDB_API_KEY) throw new Error('TMDB_API_KEY is not set in editor/.env');
  const separator = pathAndQuery.includes('?') ? '&' : '?';
  const response = await fetch(`https://${TMDB_BASE_URL}/3${pathAndQuery}${separator}api_key=${TMDB_API_KEY}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`TMDB answered ${response.status}`);
  return response.json();
}

// Kept in memory for this run of the editor only, so flipping between
// screens does not ask TMDB for the same film again.
const filmCache = new Map();

function summarize(movie) {
  const director = movie.credits?.crew?.find(person => person.job === 'Director');
  return {
    id: movie.id,
    title: movie.title,
    originalTitle: movie.original_title && movie.original_title !== movie.title ? movie.original_title : null,
    year: movie.release_date ? movie.release_date.substring(0, 4) : null,
    director: director ? director.name : null,
    runtime: movie.runtime || null,
    genres: (movie.genres || []).map(genre => genre.name),
    fullOverview: movie.overview || '',
    // Top-billed names, so an acting nominee can be picked instead of typed.
    cast: (movie.credits?.cast || []).slice().sort((a, b) => a.order - b.order).slice(0, 20).map(person => person.name),
    overview: movie.overview ? movie.overview.substring(0, 150) + (movie.overview.length > 150 ? '...' : '') : '',
    poster: movie.poster_path ? `https://image.tmdb.org/t/p/w185${movie.poster_path}` : null
  };
}

async function fetchFilm(id) {
  if (filmCache.has(id)) return filmCache.get(id);
  const movie = await tmdbGet(`/movie/${id}?append_to_response=credits`);
  const summary = movie ? summarize(movie) : null;
  filmCache.set(id, summary);
  return summary;
}

// Runs `task` over `items`, a few at a time, to stay well inside TMDB's limits.
async function mapLimited(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = await task(items[index]); } catch (e) { results[index] = { error: e.message }; }
    }
  }));
  return results;
}

// Search TMDB for movies. Matches English, original and alternative titles.
//
// A plain title search returns the most popular films first, so a small film
// that shares its title with better-known ones can be missing altogether.
// When `season` is given, the search is repeated for each release year that
// can qualify for that season and the results are merged, which surfaces it.
app.get('/api/tmdb/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Query parameter q is required' });
  }
  try {
    const base = `/search/movie?query=${encodeURIComponent(query)}&include_adult=false`;
    const season = /^\d{4}$/.test(req.query.season || '') ? parseInt(req.query.season) : null;
    const searches = [base];
    if (season) {
      for (const year of [season - 1, season - 2, season]) searches.push(`${base}&primary_release_year=${year}`);
    }
    const pages = await mapLimited(searches, 4, tmdbGet);
    const ids = [];
    pages.forEach((page, index) => {
      const results = (page && !page.error && page.results) || [];
      for (const movie of results.slice(0, index === 0 ? 8 : 6)) {
        if (!ids.includes(movie.id)) ids.push(movie.id);
      }
    });
    const results = (await mapLimited(ids, 6, fetchFilm)).filter(film => film && !film.error);
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// What a list of TMDB IDs point to: /api/tmdb/films?ids=1,2,3
app.get('/api/tmdb/films', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(id => /^\d+$/.test(id)).map(Number).slice(0, 300);
  try {
    const found = await mapLimited(ids, 6, fetchFilm);
    const films = {};
    ids.forEach((id, index) => { films[id] = found[index]; });
    res.json({ films });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Turns something pasted (a TMDB link, a TMDB ID, or an IMDb link or tt id)
// into a film. For the cases where searching by title does not find it.
app.get('/api/tmdb/resolve', async (req, res) => {
  const pasted = String(req.query.q || '').trim();
  try {
    let id = null;
    const imdb = pasted.match(/tt\d{6,}/);
    const tmdbLink = pasted.match(/themoviedb\.org\/movie\/(\d+)/);
    if (imdb) {
      const found = await tmdbGet(`/find/${imdb[0]}?external_source=imdb_id`);
      id = found?.movie_results?.[0]?.id ?? null;
    } else if (tmdbLink) {
      id = Number(tmdbLink[1]);
    } else if (/^\d+$/.test(pasted)) {
      id = Number(pasted);
    }
    const film = id ? await fetchFilm(id) : null;
    if (!film) return res.status(404).json({ error: 'No film found for that link or ID' });
    res.json({ film });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Listen on this Mac only. The editor can rewrite the data files, so it must
// not be reachable from other devices on the network.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  CineTrack Editor running at http://localhost:${PORT}\n  Data: ${DATA_DIR}\n`);
});
