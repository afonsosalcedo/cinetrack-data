const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = 3000;
const DATA_DIR = path.join(__dirname, '..');

// TMDB API configuration
const TMDB_API_KEY = '120d0c87f20d3451002b9ce962943cec';
const TMDB_BASE_URL = 'api.themoviedb.org';

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
    const filename = `oscars${req.params.year}.json`;
    const filepath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'Year not found' });
    }
    const films = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    res.json(films);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save films for a specific year
app.post('/api/films/:year', (req, res) => {
  try {
    const filename = `oscars${req.params.year}.json`;
    const filepath = path.join(DATA_DIR, filename);
    const { films, changelog } = req.body;

    // Write films with pretty formatting
    fs.writeFileSync(filepath, JSON.stringify(films, null, 2));

    // Update manifest
    const manifestPath = path.join(DATA_DIR, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    // Bump patch version
    const versionParts = manifest.version.split('.');
    versionParts[2] = parseInt(versionParts[2]) + 1;
    manifest.version = versionParts.join('.');
    manifest.lastUpdated = new Date().toISOString();

    // Update changelog if provided
    if (changelog) {
      manifest.changelog = changelog;
    }

    // Update film count for this year
    const yearEntry = manifest.years.find(y => y.id === req.params.year);
    if (yearEntry) {
      yearEntry.filmCount = films.length;
    }

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    res.json({ success: true, version: manifest.version });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update manifest (for changelog, nominationsAnnounced, etc.)
app.post('/api/manifest', (req, res) => {
  try {
    const manifestPath = path.join(DATA_DIR, 'manifest.json');
    const manifest = req.body;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
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

app.listen(PORT, () => {
  console.log(`\n  CineTrack Editor running at http://localhost:${PORT}\n`);
});
