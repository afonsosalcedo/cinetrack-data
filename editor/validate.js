// Checks season files and the manifest against what the app can decode.
//
// The app decodes a whole season file in one go, so a single film with a
// missing field or a wrongly shaped nomination makes the entire season fail
// to load. Errors here are exactly those cases, plus anything that would
// attach one person's watched state to the wrong film. Warnings are things
// worth a look that do not break the app.
//
// Used by the server before every save, and from the command line:
//   npm run validate

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..');

// Categories stored as a true/false flag on the film.
const FLAG_CATEGORIES = {
  bestpicture: 'Best Picture',
  bestdirector: 'Best Director',
  bestoriginalscreenplay: 'Best Original Screenplay',
  bestadaptedscreenplay: 'Best Adapted Screenplay',
  bestanimatedfeature: 'Best Animated Feature',
  bestanimatedshortfilm: 'Best Animated Short Film',
  bestinternationalfeature: 'Best International Feature',
  bestdocumentaryfeature: 'Best Documentary Feature',
  bestdocumentaryshort: 'Best Documentary Short',
  bestcinematography: 'Best Cinematography',
  bestfilmediting: 'Best Film Editing',
  bestproductiondesign: 'Best Production Design',
  bestcostumedesign: 'Best Costume Design',
  bestmakeupandhairstyling: 'Best Makeup & Hairstyling',
  bestsound: 'Best Sound',
  bestvisualeffects: 'Best Visual Effects',
  bestoriginalscore: 'Best Original Score',
  bestliveactionshort: 'Best Live Action Short Film',
  bestcasting: 'Best Casting'
};

// Flags older season files do not have. The app treats them as optional.
const OPTIONAL_FLAGS = new Set(['bestcasting']);

// Categories stored as a list of people on the film.
const ACTING_CATEGORIES = {
  bestactor: 'Best Actor',
  bestactress: 'Best Actress',
  bestsupportingactor: 'Best Supporting Actor',
  bestsupportingactress: 'Best Supporting Actress'
};

const SHORTLIST_FLAGS = [
  'shortlistAnimatedShort', 'shortlistCasting', 'shortlistCinematography',
  'shortlistDocumentaryFeature', 'shortlistDocumentaryShort',
  'shortlistInternationalFeature', 'shortlistLiveActionShort',
  'shortlistMakeupAndHairstyling', 'shortlistOriginalScore',
  'shortlistOriginalSong', 'shortlistSound', 'shortlistVisualEffects'
];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YEAR_PATTERN = /^\d{4}$/;

const isString = value => typeof value === 'string';
const isStringArray = value => Array.isArray(value) && value.every(isString);
const expectedNominees = key => (key === 'bestpicture' ? 10 : 5);

/**
 * Validates one season's films.
 * `nominationsAnnounced` turns on the nominee-count checks.
 * Returns { errors: [string], warnings: [string] }.
 */
function validateFilms(films, { nominationsAnnounced = false } = {}) {
  const errors = [];
  const warnings = [];

  if (!Array.isArray(films)) {
    return { errors: ['The season file must be a list of films.'], warnings };
  }

  const seenIds = new Map();
  const seenTmdbIds = new Map();
  const seenTitles = new Map();

  films.forEach((film, index) => {
    if (film === null || typeof film !== 'object' || Array.isArray(film)) {
      errors.push(`Entry ${index + 1} is not a film.`);
      return;
    }
    const name = isString(film.title) && film.title.trim() ? `"${film.title}"` : `Entry ${index + 1}`;
    const error = message => errors.push(`${name}: ${message}`);
    const warn = message => warnings.push(`${name}: ${message}`);

    // Identity
    if (!isString(film.id) || !UUID_PATTERN.test(film.id)) {
      error('id is missing or is not a UUID.');
    } else {
      const key = film.id.toLowerCase();
      if (seenIds.has(key)) error(`has the same id as ${seenIds.get(key)}.`);
      else seenIds.set(key, name);
    }

    if (!isString(film.title) || !film.title.trim()) {
      error('title is empty.');
    } else {
      if (film.title !== film.title.trim()) error('title has spaces at the start or end.');
      const key = film.title.trim().toLowerCase();
      if (seenTitles.has(key)) warn('another film has the same title.');
      else seenTitles.set(key, name);
    }

    if (film.tmdbId === undefined || film.tmdbId === null) {
      warn('has no TMDB ID, so the app will guess the film from its title.');
    } else if (!Number.isInteger(film.tmdbId) || film.tmdbId <= 0) {
      error('tmdbId must be a positive whole number.');
    } else if (seenTmdbIds.has(film.tmdbId)) {
      error(`has the same TMDB ID (${film.tmdbId}) as ${seenTmdbIds.get(film.tmdbId)}.`);
    } else {
      seenTmdbIds.set(film.tmdbId, name);
    }

    // Details the app requires to be present, even if empty
    for (const field of ['releaseDate', 'director', 'description', 'imageURL']) {
      if (!isString(film[field])) error(`${field} must be text (it can be empty).`);
    }
    if (!Number.isInteger(film.runtime) || film.runtime < 0) error('runtime must be a whole number of minutes.');
    if (!isStringArray(film.cast)) error('cast must be a list of names.');
    if (isString(film.imageURL) && film.imageURL && !/^https:\/\//.test(film.imageURL)) {
      error('imageURL must start with https://.');
    }

    // Personal state must never ship in the shared data
    if (film.watched !== false) error('watched must be false in the data file.');
    if (film.rating !== 0) error('rating must be 0 in the data file.');

    // Nominations
    for (const key of Object.keys(FLAG_CATEGORIES)) {
      if (film[key] === undefined && OPTIONAL_FLAGS.has(key)) continue;
      if (typeof film[key] !== 'boolean') error(`${key} must be true or false.`);
    }
    for (const key of SHORTLIST_FLAGS) {
      if (film[key] !== undefined && typeof film[key] !== 'boolean') error(`${key} must be true or false.`);
    }
    for (const [key, label] of Object.entries(ACTING_CATEGORIES)) {
      if (!Array.isArray(film[key])) {
        error(`${key} must be a list.`);
        continue;
      }
      const names = new Set();
      for (const entry of film[key]) {
        const actorName = entry && typeof entry === 'object' ? entry.actorName : undefined;
        if (!isString(actorName) || !actorName.trim()) {
          error(`${label} has an entry without a name. Each one must look like {"actorName": "Name"}.`);
        } else if (names.has(actorName.trim().toLowerCase())) {
          error(`${label} lists ${actorName} twice.`);
        } else {
          names.add(actorName.trim().toLowerCase());
        }
      }
    }
    if (!Array.isArray(film.bestoriginalsong)) {
      error('bestoriginalsong must be a list.');
    } else {
      for (const song of film.bestoriginalsong) {
        if (!song || typeof song !== 'object' || !isString(song.songTitle) || !song.songTitle.trim()) {
          error('has a song without a title.');
          continue;
        }
        if (!isStringArray(song.songwriters)) error(`song "${song.songTitle}": songwriters must be a list of names.`);
        else if (song.songwriters.length === 0 && song.nominated !== false) warn(`nominated song "${song.songTitle}" has no songwriters.`);
        if (song.nominated !== undefined && typeof song.nominated !== 'boolean') {
          error(`song "${song.songTitle}": nominated must be true or false.`);
        }
      }
    }

    const hasAnything =
      Object.keys(FLAG_CATEGORIES).some(key => film[key] === true) ||
      SHORTLIST_FLAGS.some(key => film[key] === true) ||
      Object.keys(ACTING_CATEGORIES).some(key => Array.isArray(film[key]) && film[key].length > 0) ||
      (Array.isArray(film.bestoriginalsong) && film.bestoriginalsong.length > 0);
    if (!hasAnything) warn('is not shortlisted or nominated for anything.');
  });

  if (nominationsAnnounced) {
    const count = (label, actual, expected) => {
      if (actual !== expected) warnings.push(`${label} has ${actual} nominee${actual === 1 ? '' : 's'}, expected ${expected}.`);
    };
    const real = films.filter(film => film && typeof film === 'object');
    for (const [key, label] of Object.entries(FLAG_CATEGORIES)) {
      const actual = real.filter(film => film[key] === true).length;
      if (actual === 0 && OPTIONAL_FLAGS.has(key)) continue;
      count(label, actual, expectedNominees(key));
    }
    for (const [key, label] of Object.entries(ACTING_CATEGORIES)) {
      count(label, real.reduce((sum, film) => sum + (Array.isArray(film[key]) ? film[key].length : 0), 0), 5);
    }
    count('Best Original Song', real.reduce((sum, film) => sum +
      (Array.isArray(film.bestoriginalsong) ? film.bestoriginalsong.filter(song => song && song.nominated !== false).length : 0), 0), 5);
  }

  return { errors, warnings };
}

/** Validates the manifest's own structure (not the season files it points to). */
function validateManifest(manifest) {
  const errors = [];
  const warnings = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { errors: ['The manifest must be an object.'], warnings };
  }
  if (!isString(manifest.version) || !/^\d+\.\d+\.\d+$/.test(manifest.version)) errors.push('version must look like 1.2.3.');
  if (!isString(manifest.lastUpdated) || Number.isNaN(Date.parse(manifest.lastUpdated))) errors.push('lastUpdated must be a date.');
  if (manifest.changelog !== undefined && manifest.changelog !== null && !isString(manifest.changelog)) errors.push('changelog must be text.');
  if (!Array.isArray(manifest.years) || manifest.years.length === 0) {
    errors.push('years must list at least one season.');
    return { errors, warnings };
  }

  const seen = new Set();
  for (const year of manifest.years) {
    const label = `Season ${year && year.id}`;
    if (!year || !isString(year.id) || !YEAR_PATTERN.test(year.id)) {
      errors.push('Every season needs a four-digit id, written as text.');
      continue;
    }
    if (seen.has(year.id)) errors.push(`${label} is listed twice.`);
    seen.add(year.id);
    if (year.filename !== `oscars${year.id}.json`) errors.push(`${label}: filename must be oscars${year.id}.json.`);
    if (typeof year.nominationsAnnounced !== 'boolean') errors.push(`${label}: nominationsAnnounced must be true or false.`);
    if (!Number.isInteger(year.filmCount) || year.filmCount < 0) errors.push(`${label}: filmCount must be a whole number.`);
    // The app hides a season that has no ceremony date.
    if (!isOffsetDate(year.ceremonyDate)) errors.push(`${label}: ceremonyDate must be a date with a time zone offset, like 2027-03-14T16:00:00-07:00.`);
    for (const field of ['nominationsDate', 'shortlistDate']) {
      if (year[field] !== undefined && !isOffsetDate(year[field])) errors.push(`${label}: ${field} must be a date with a time zone offset.`);
    }
    const order = ['shortlistDate', 'nominationsDate', 'ceremonyDate'].filter(field => isOffsetDate(year[field]));
    for (let i = 1; i < order.length; i++) {
      if (Date.parse(year[order[i - 1]]) >= Date.parse(year[order[i]])) errors.push(`${label}: ${order[i - 1]} must be before ${order[i]}.`);
    }
  }
  return { errors, warnings };
}

// The app parses dates with a strict ISO 8601 reader: seconds and an offset
// are required, fractional seconds are not allowed.
function isOffsetDate(value) {
  return isString(value) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

/** Validates the manifest and every season file it lists, as they are on disk. */
function validateAll(dataDir = DATA_DIR) {
  const report = [];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json'), 'utf8'));
  } catch (e) {
    return [{ name: 'manifest.json', errors: [`Could not be read: ${e.message}`], warnings: [] }];
  }
  const manifestResult = validateManifest(manifest);
  report.push({ name: 'manifest.json', ...manifestResult });

  for (const year of Array.isArray(manifest.years) ? manifest.years : []) {
    if (!year || !isString(year.id) || !YEAR_PATTERN.test(year.id)) continue;
    const filename = `oscars${year.id}.json`;
    let films;
    try {
      films = JSON.parse(fs.readFileSync(path.join(dataDir, filename), 'utf8'));
    } catch (e) {
      report.push({ name: filename, errors: [`Could not be read: ${e.message}`], warnings: [] });
      continue;
    }
    const result = validateFilms(films, { nominationsAnnounced: year.nominationsAnnounced === true });
    if (Array.isArray(films) && year.filmCount !== films.length) {
      manifestResult.errors.push(`Season ${year.id}: filmCount is ${year.filmCount} but the file has ${films.length} films.`);
    }
    report.push({ name: filename, ...result });
  }
  return report;
}

module.exports = { validateFilms, validateManifest, validateAll, YEAR_PATTERN };

if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const report = validateAll();
  let errorCount = 0;
  for (const { name, errors, warnings } of report) {
    errorCount += errors.length;
    console.log(`\n${name}: ${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`);
    errors.forEach(message => console.log(`  ERROR  ${message}`));
    const shown = verbose ? warnings : warnings.slice(0, 8);
    shown.forEach(message => console.log(`  warn   ${message}`));
    if (shown.length < warnings.length) console.log(`  ...and ${warnings.length - shown.length} more warnings (--verbose shows all)`);
  }
  console.log(errorCount === 0 ? '\nNo errors.\n' : `\n${errorCount} error${errorCount === 1 ? '' : 's'} must be fixed.\n`);
  process.exit(errorCount === 0 ? 0 : 1);
}
