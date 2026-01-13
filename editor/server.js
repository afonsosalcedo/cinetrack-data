const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const DATA_DIR = path.join(__dirname, '..');

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

app.listen(PORT, () => {
  console.log(`\n  CineTrack Editor running at http://localhost:${PORT}\n`);
});
