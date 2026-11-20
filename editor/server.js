const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
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

    // Bump patch version
    const versionParts = manifest.version.split('.');
    versionParts[2] = parseInt(versionParts[2]) + 1;
    manifest.version = versionParts.join('.');
    manifest.lastUpdated = new Date().toISOString();
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

// Helper function to fetch movie credits
function fetchMovieCredits(movieId) {
  return new Promise((resolve, reject) => {
    const creditsPath = `/3/movie/${movieId}/credits?api_key=${TMDB_API_KEY}`;
    const options = {
      hostname: TMDB_BASE_URL,
      path: creditsPath,
      method: 'GET'
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const credits = JSON.parse(data);
          const director = credits.crew?.find(c => c.job === 'Director');
          resolve(director ? director.name : null);
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Search TMDB for movies
app.get('/api/tmdb/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Query parameter q is required' });
  }

  const searchPath = `/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&include_adult=false`;

  const options = {
    hostname: TMDB_BASE_URL,
    path: searchPath,
    method: 'GET'
  };

  const tmdbReq = https.request(options, async (tmdbRes) => {
    let data = '';
    tmdbRes.on('data', chunk => data += chunk);
    tmdbRes.on('end', async () => {
      try {
        const parsed = JSON.parse(data);
        const topResults = (parsed.results || []).slice(0, 8);

        // Fetch directors for all results in parallel
        const directorsPromises = topResults.map(movie => fetchMovieCredits(movie.id));
        const directors = await Promise.all(directorsPromises);

        // Return simplified results with director info
        const results = topResults.map((movie, i) => ({
          id: movie.id,
          title: movie.title,
          year: movie.release_date ? movie.release_date.substring(0, 4) : 'Unknown',
          director: directors[i] || 'Unknown',
          overview: movie.overview ? movie.overview.substring(0, 150) + '...' : 'No description',
          poster: movie.poster_path ? `https://image.tmdb.org/t/p/w92${movie.poster_path}` : null
        }));
        res.json({ results });
      } catch (e) {
        res.status(500).json({ error: 'Failed to parse TMDB response' });
      }
    });
  });

  tmdbReq.on('error', (e) => {
    res.status(500).json({ error: e.message });
  });

  tmdbReq.end();
});

// Get TMDB movie details by ID
app.get('/api/tmdb/movie/:id', (req, res) => {
  const movieId = req.params.id;
  const detailsPath = `/3/movie/${movieId}?api_key=${TMDB_API_KEY}`;

  const options = {
    hostname: TMDB_BASE_URL,
    path: detailsPath,
    method: 'GET'
  };

  const tmdbReq = https.request(options, (tmdbRes) => {
    let data = '';
    tmdbRes.on('data', chunk => data += chunk);
    tmdbRes.on('end', () => {
      try {
        const movie = JSON.parse(data);
        res.json({
          id: movie.id,
          title: movie.title,
          year: movie.release_date ? movie.release_date.substring(0, 4) : 'Unknown',
          overview: movie.overview,
          poster: movie.poster_path ? `https://image.tmdb.org/t/p/w185${movie.poster_path}` : null,
          runtime: movie.runtime
        });
      } catch (e) {
        res.status(500).json({ error: 'Failed to parse TMDB response' });
      }
    });
  });

  tmdbReq.on('error', (e) => {
    res.status(500).json({ error: e.message });
  });

  tmdbReq.end();
});

// Listen on this Mac only. The editor can rewrite the data files, so it must
// not be reachable from other devices on the network.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  CineTrack Editor running at http://localhost:${PORT}\n  Data: ${DATA_DIR}\n`);
});
