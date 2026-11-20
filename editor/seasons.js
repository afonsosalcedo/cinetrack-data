// Season settings: create a season, or change its dates and its
// nominations-announced flag. Dates are typed in Pacific time, the time zone
// of the ceremony and the announcements, and stored with the right offset for
// that day (standard or daylight time).

const PACIFIC = 'America/Los_Angeles';

// "-08:00" or "-07:00" for a Pacific wall-clock date and time.
function pacificOffset(date, time) {
  const instant = new Date(`${date}T${time}:00Z`);
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC, timeZoneName: 'longOffset' })
    .formatToParts(instant).find(part => part.type === 'timeZoneName').value;
  return zone.replace('GMT', '') || '+00:00';
}

function toStoredDate(date, time) {
  return date && time ? `${date}T${time}:00${pacificOffset(date, time)}` : null;
}

// A stored date as Pacific { date: 'YYYY-MM-DD', time: 'HH:MM' }.
function toPacificParts(stored) {
  if (!stored) return { date: '', time: '' };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: PACIFIC, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(stored)).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function seasonLabel(year) {
  return `${year.id} season (${year.nominationsAnnounced ? 'nominations' : 'shortlists'})`;
}

function refreshYearSelect() {
  const select = document.getElementById('yearSelect');
  select.innerHTML = manifest.years
    .map(year => `<option value="${esc(year.id)}">${esc(seasonLabel(year))}</option>`).join('');
  select.value = currentYear;
}

function dateRow(label, key, stored, required) {
  const parts = toPacificParts(stored);
  return `
    <div class="season-row">
      <label>${label}</label>
      <input type="date" id="season-${key}-date" value="${parts.date}" ${required ? 'required' : ''}>
      <input type="time" id="season-${key}-time" value="${parts.time}" ${required ? 'required' : ''}>
    </div>`;
}

function openSeasonDialog(isNew) {
  const season = isNew ? null : manifest.years.find(year => year.id === currentYear);
  const newest = Math.max(...manifest.years.map(year => parseInt(year.id)));
  const dialog = document.getElementById('seasonDialog');
  dialog.innerHTML = `
    <form method="dialog" onsubmit="event.preventDefault(); saveSeason(${isNew})">
      <h3>${isNew ? 'New season' : `Season ${esc(season.id)}`}</h3>
      <p class="entry-secondary">All times are Pacific time.</p>
      ${isNew ? `
        <div class="season-row">
          <label>Ceremony year</label>
          <input type="number" id="season-id" value="${newest + 1}" min="2000" max="2100" required>
        </div>` : ''}
      ${dateRow('Shortlists announced', 'shortlistDate', season?.shortlistDate, false)}
      ${dateRow('Nominations announced', 'nominationsDate', season?.nominationsDate, false)}
      ${dateRow('Ceremony starts', 'ceremonyDate', season?.ceremonyDate, true)}
      ${isNew ? '' : `
        <label class="checkbox-item" style="margin-top: 0.75rem;">
          <input type="checkbox" id="season-announced" ${season.nominationsAnnounced ? 'checked' : ''}>
          Nominations have been announced
        </label>
        <p class="entry-secondary">Turn this on once the nominees are in. The editor then checks that every category has the right number.</p>`}
      <ul class="season-errors" id="seasonErrors"></ul>
      <div class="row">
        <button type="submit">${isNew ? 'Create season' : 'Save'}</button>
        <button type="button" class="secondary" onclick="document.getElementById('seasonDialog').close()">Cancel</button>
      </div>
      ${isNew ? '<p class="entry-secondary">The new season starts empty. Nothing reaches the app until the data is pushed.</p>' : ''}
    </form>`;
  dialog.showModal();
}

async function saveSeason(isNew) {
  const value = id => document.getElementById(id)?.value || '';
  const stored = key => toStoredDate(value(`season-${key}-date`), value(`season-${key}-time`));
  const body = {
    shortlistDate: stored('shortlistDate'),
    nominationsDate: stored('nominationsDate'),
    ceremonyDate: stored('ceremonyDate')
  };
  if (isNew) body.id = value('season-id');
  else body.nominationsAnnounced = document.getElementById('season-announced').checked;

  const errorList = document.getElementById('seasonErrors');
  const half = ['shortlistDate', 'nominationsDate'].find(key =>
    Boolean(value(`season-${key}-date`)) !== Boolean(value(`season-${key}-time`)));
  if (half) {
    errorList.innerHTML = '<li>Give both a date and a time, or leave both empty.</li>';
    return;
  }

  try {
    const response = await fetch(isNew ? '/api/seasons' : `/api/seasons/${currentYear}`, {
      method: isNew ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!data.success) {
      errorList.innerHTML = (data.errors || [data.error || 'Not saved']).map(message => `<li>${esc(message)}</li>`).join('');
      return;
    }
    manifest = data.manifest;
    document.getElementById('seasonDialog').close();
    if (isNew) {
      currentYear = body.id;
      refreshYearSelect();
      await loadYear(currentYear);
      showStatus(`Season ${body.id} created`, 'success');
    } else {
      refreshYearSelect();
      showStatus('Season saved', 'success');
      if (currentMode === 'nomination') renderNominationMode();
    }
  } catch (e) {
    errorList.innerHTML = `<li>${esc(e.message)}</li>`;
  }
}
