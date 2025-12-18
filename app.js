// --- Global Configuration ---
const LEAGUE_ID = "1262418074540195841";
const USER_USERNAME = "conner27lax";
const UPDATE_INTERVAL_MS = 30000; // 30 seconds

// Force the app to always display Week 16
const DISPLAY_WEEK = 16;

// --- Global Data Stores (Client-side Cache) ---
const API_BASE = "https://api.sleeper.app/v1";
const AVATAR_BASE = "https://sleepercdn.com/avatars/thumbs/";

// Raw weekly stats file (your generated nflreadpy output)
const RAW_STATS_PATH = "data/player-stats-raw.json";

let nflState = {};
let playerCache = {};
let leagueContext = {
  users: null,
  rosters: null,
  userRosterId: null,
  matchupId: null,
};

let scheduleByTeam = {}; // { TEAM: { opp: TEAM, homeAway: 'vs'|'@', gameStatus: string, start: string } }
let updateTimer = null;
let lastUpdatedTime = null;

// Raw stats cache (from nflreadpy file)
let rawStats = {
  loaded: false,
  season: null,
  maxWeek: 0,
  weeks: {}, // weeks["1"]["00-0023459"] = stats row object
};

// ------------------------------
// Utilities
// ------------------------------
async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} for ${url}`);
  }
  return response.json();
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setImgSrc(id, src) {
  const el = document.getElementById(id);
  if (el && el.tagName === "IMG") el.src = src;
}

function safeText(v) {
  return v === undefined || v === null ? "" : String(v);
}

function formatStatValue(v) {
  if (v === undefined || v === null) return "—";
  const n = Number(v);
  if (Number.isFinite(n)) return Math.abs(n % 1) < 1e-9 ? String(n) : n.toFixed(2);
  return String(v);
}

function getLastNWeeksCompleted(currentWeek, n, maxAvailableWeek) {
  const lastCompleted = Math.max(0, Number(currentWeek) - 1);
  const last = Math.min(lastCompleted, Number(maxAvailableWeek || lastCompleted));
  const start = Math.max(1, last - (n - 1));
  const out = [];
  for (let w = start; w <= last; w += 1) out.push(w);
  return out;
}

function weightedAvg(values) {
  let num = 0, den = 0;
  for (const { v, w } of values) {
    const vn = Number(v);
    const wn = Number(w);
    if (!Number.isFinite(vn) || !Number.isFinite(wn)) continue;
    num += vn * wn;
    den += wn;
  }
  return den > 0 ? num / den : 0;
}

function buildEspnPlayerUrl(playerObj) {
  const espnId = playerObj?.espn_id ?? playerObj?.espnId;
  if (!espnId) return "";
  return `https://www.espn.com/nfl/player/_/id/${encodeURIComponent(String(espnId))}`;
}

// ------------------------------
// Load RAW_STATS_PATH (nflreadpy output)
// Shape:
/// {
///   season: 2025,
///   ...,
///   weeks: {
///     "1": { "00-0023459": { ... }, ... },
///     "2": { ... }
///   }
/// }
// ------------------------------
async function loadRawStatsOnce() {
  if (rawStats.loaded) return;

  try {
    const payload = await fetchJson(RAW_STATS_PATH);

    const weeks = payload?.weeks && typeof payload.weeks === "object" ? payload.weeks : {};
    rawStats.weeks = weeks;

    rawStats.season = Number(payload?.season) || null;

    // Determine max week present (either from metadata or by scanning keys)
    const metaMax =
      Number(payload?.data_max_week_in_file) ||
      Number(payload?.last_completed_week_target) ||
      0;

    const keys = Object.keys(weeks || {});
    const scannedMax = keys.reduce((m, k) => {
      const wk = Number(k);
      return Number.isFinite(wk) ? Math.max(m, wk) : m;
    }, 0);

    rawStats.maxWeek = Math.max(metaMax, scannedMax, 0);
    rawStats.loaded = true;

    console.log(`[rawStats] loaded season=${rawStats.season} maxWeek=${rawStats.maxWeek}`);
  } catch (e) {
    rawStats.loaded = true; // prevent retry spam; you can refresh to retry
    rawStats.season = null;
    rawStats.maxWeek = 0;
    rawStats.weeks = {};
    console.warn(`[rawStats] failed to load ${RAW_STATS_PATH}:`, e);
  }
}

function getRawStatRowByGsis(weekNumber, gsisId) {
  if (!gsisId) return null;
  const wk = String(Number(weekNumber));
  const weekMap = rawStats.weeks?.[wk];
  if (!weekMap || typeof weekMap !== "object") return null;
  return weekMap[String(gsisId)] || null;
}

// ------------------------------
// Step 1: NFL state (season/year)
// ------------------------------
async function getNFLState() {
  const url = `${API_BASE}/state/nfl`;
  nflState = await fetchJson(url);
  console.log(`NFL State: week=${nflState.week} season=${nflState.season} type=${nflState.season_type}`);
}

// ------------------------------
// Step 2: Players cache (Sleeper)
// ------------------------------
async function getAllPlayers() {
  if (Object.keys(playerCache).length > 0) return;
  const url = `${API_BASE}/players/nfl`;
  playerCache = (await fetchJson(url)) || {};
  console.log(`Cached ${Object.keys(playerCache).length} players.`);
}

// ------------------------------
// Step 3: League context (users/rosters + user roster id)
// ------------------------------
async function fetchInitialContext() {
  const userUrl = `${API_BASE}/user/${USER_USERNAME}`;
  const userData = await fetchJson(userUrl);
  const userId = userData.user_id;

  const usersUrl = `${API_BASE}/league/${LEAGUE_ID}/users`;
  const rostersUrl = `${API_BASE}/league/${LEAGUE_ID}/rosters`;

  const [users, rosters] = await Promise.all([fetchJson(usersUrl), fetchJson(rostersUrl)]);

  leagueContext.users = users;
  leagueContext.rosters = rosters;

  const userRoster = rosters.find((r) => r && r.owner_id === userId);
  if (!userRoster) {
    throw new Error(`Roster not found for user ${USER_USERNAME} in league ${LEAGUE_ID}.`);
  }

  leagueContext.userRosterId = userRoster.roster_id;
  console.log(`User roster_id=${leagueContext.userRosterId}`);
}

// ------------------------------
// Step 4: Schedule for opponent display
// ------------------------------
function buildScheduleMapForWeek(schedule, week) {
  const map = {};
  if (!Array.isArray(schedule)) return map;

  const weekGames = schedule.filter((g) => {
    const w = Number(g?.week ?? g?.week_number ?? g?.weekNumber);
    return w === Number(week);
  });

  weekGames.forEach((g) => {
    const home = g?.home ?? g?.home_team ?? g?.homeTeam;
    const away = g?.away ?? g?.away_team ?? g?.awayTeam;
    if (!home || !away) return;

    const status = String(g?.status ?? g?.game_status ?? g?.state ?? "");
    const kickoff = g?.kickoff ?? g?.start_time ?? g?.start ?? g?.date ?? "";

    map[String(home)] = { opp: String(away), homeAway: "vs", gameStatus: status, start: String(kickoff) };
    map[String(away)] = { opp: String(home), homeAway: "@", gameStatus: status, start: String(kickoff) };
  });

  return map;
}

async function fetchScheduleForSeasonAndWeek(season, week) {
  const regularUrl = `https://api.sleeper.app/schedule/nfl/regular/${season}`;
  const schedule = await fetchJson(regularUrl).catch(() => null);
  scheduleByTeam = buildScheduleMapForWeek(schedule, week);
}

// ------------------------------
// Step 5: Matchups + Projections (Sleeper)
// ------------------------------
function normalizeProjectionsToMap(projData) {
  const map = {};
  if (Array.isArray(projData)) {
    for (const p of projData) {
      const pid = p?.player_id ?? p?.playerId ?? p?.id;
      if (pid !== undefined && pid !== null) map[String(pid)] = p;
    }
    return map;
  }
  if (projData && typeof projData === "object") {
    for (const [k, v] of Object.entries(projData)) map[String(k)] = v;
  }
  return map;
}

function getProjectedPoints(projObj) {
  if (!projObj) return 0;
  const v = projObj.pts_ppr ?? projObj.fantasy_points ?? projObj.points;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function fetchDynamicData(week, season) {
  const matchupUrl = `${API_BASE}/league/${LEAGUE_ID}/matchups/${week}`;
  const projectionsUrl =
    `https://api.sleeper.app/projections/nfl/${season}/${week}` +
    `?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&position[]=FLEX`;

  const [matchups, projectionsRaw] = await Promise.all([
    fetchJson(matchupUrl),
    fetchJson(projectionsUrl).catch(() => null),
  ]);

  const projections = normalizeProjectionsToMap(projectionsRaw || {});
  window.__latestProjections = projections;

  if (!Array.isArray(matchups) || matchups.length === 0) {
    return { matchupTeams: [], projections };
  }

  const userTeamMatchup = matchups.find((m) => m && m.roster_id === leagueContext.userRosterId);
  if (!userTeamMatchup) {
    throw new Error(`Matchup data for roster_id ${leagueContext.userRosterId} not found in week ${week}.`);
  }

  leagueContext.matchupId = userTeamMatchup.matchup_id;

  const currentMatchupTeams = matchups
    .filter((m) => m && m.matchup_id === leagueContext.matchupId)
    .sort((a, b) => a.roster_id - b.roster_id);

  return { matchupTeams: currentMatchupTeams, projections };
}

// ------------------------------
// Step 6: Merge + Render
// ------------------------------
function mergeAndRenderData(data) {
  if (!data || !Array.isArray(data.matchupTeams)) return;

  const { matchupTeams, projections } = data;

  const teamA = matchupTeams.find((t) => t && t.roster_id === leagueContext.userRosterId);
  const teamB = matchupTeams.find((t) => t && t.roster_id !== leagueContext.userRosterId);
  if (!teamA || !teamB) throw new Error("Could not identify both teams in the matchup.");

  const getTeamDetails = (matchupTeam) => {
    const roster = leagueContext.rosters?.find((r) => r && r.roster_id === matchupTeam.roster_id) || null;
    const user = roster ? leagueContext.users?.find((u) => u && u.user_id === roster.owner_id) : null;

    const teamName = roster?.metadata?.team_name || user?.display_name || `Roster ${matchupTeam.roster_id}`;
    const wins = roster?.settings?.wins || 0;
    const losses = roster?.settings?.losses || 0;
    const ties = roster?.settings?.ties || 0;
    const record = `${wins}-${losses}${ties > 0 ? "-" + ties : ""}`;

    return {
      id: matchupTeam.roster_id,
      name: teamName,
      record,
      avatar: user?.avatar || "",
      starters: Array.isArray(matchupTeam.starters) ? matchupTeam.starters : [],
      points: Number(matchupTeam.points || 0),
      playersPoints: matchupTeam.players_points || {},
    };
  };

  const a = getTeamDetails(teamA);
  const b = getTeamDetails(teamB);

  setText("team-a-name", a.name);
  setText("team-a-record", a.record);
  setImgSrc("team-a-avatar", a.avatar ? `${AVATAR_BASE}${a.avatar}` : "");
  setText("score-a", a.points.toFixed(2));

  setText("team-b-name", b.name);
  setText("team-b-record", b.record);
  setImgSrc("team-b-avatar", b.avatar ? `${AVATAR_BASE}${b.avatar}` : "");
  setText("score-b", b.points.toFixed(2));

  renderStarters(a.starters, "team-a-starters", a.playersPoints, projections);
  renderStarters(b.starters, "team-b-starters", b.playersPoints, projections);

  const scoreboardEl = document.getElementById("scoreboard");
  if (scoreboardEl) scoreboardEl.classList.remove("hidden");
  const loadingEl = document.getElementById("loading");
  if (loadingEl) loadingEl.classList.add("hidden");

  lastUpdatedTime = new Date();
  const lastUpdatedEl = document.getElementById("last-updated");
  if (lastUpdatedEl) lastUpdatedEl.textContent = lastUpdatedTime.toLocaleTimeString();
}

// ------------------------------
// Starters list rendering (Sleeper for list; raw stats ONLY for headshot + modal)
// ------------------------------
function getOpponentTextForTeam(teamAbbrev) {
  const entry = scheduleByTeam?.[teamAbbrev];
  if (!entry) return "N/A";
  const ha = entry.homeAway || "vs";
  const opp = entry.opp || "";
  const status = entry.gameStatus ? ` • ${entry.gameStatus}` : "";
  return `${ha} ${opp}${status}`.trim();
}

// Prefer raw headshot (from file) when possible, else fallback to Sleeper (none), else blank
function getHeadshotUrlForSleeperPlayer(playerObj) {
  const gsis = playerObj?.gsis_id;
  if (!gsis || !rawStats.loaded || !rawStats.maxWeek) return "";

  // pick the latest available week row for that GSIS id
  for (let w = rawStats.maxWeek; w >= 1; w -= 1) {
    const row = getRawStatRowByGsis(w, gsis);
    if (row?.headshot_url) return String(row.headshot_url);
  }
  return "";
}

function renderStarters(starterIds = [], containerId, playersPoints = {}, projections = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = "";
  if (!Array.isArray(starterIds)) return;

  starterIds.forEach((playerIdRaw) => {
    const sleeperPlayerId = String(playerIdRaw);

    // Team DEF often appears as "HOU", "DAL", etc.
    const isTeamDef = /^[A-Z]{2,4}$/.test(sleeperPlayerId) && !playerCache[sleeperPlayerId];
    const player = playerCache[sleeperPlayerId] || playerCache[Number(sleeperPlayerId)] || null;

    const position = isTeamDef ? "DEF" : (player?.position || "N/A");
    const name = isTeamDef
      ? `${sleeperPlayerId} Defense`
      : (player?.full_name || (player?.first_name ? `${player.first_name} ${player.last_name}` : "Unknown Player"));

    const teamShort = isTeamDef ? sleeperPlayerId : (player?.team || "");
    const actualScore = Number(playersPoints?.[sleeperPlayerId] ?? 0);

    const projObj = projections?.[sleeperPlayerId] || projections?.[Number(sleeperPlayerId)] || null;
    const projScore = getProjectedPoints(projObj);

    const oppText = teamShort ? getOpponentTextForTeam(teamShort) : "N/A";

    const card = document.createElement("div");
    card.className = "player-card";

    // Optional headshot (raw stats)
    let headshot = "";
    if (!isTeamDef && player) headshot = getHeadshotUrlForSleeperPlayer(player);

    // Clickable modal for real players
    if (!isTeamDef) {
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      const open = () => showPlayerDetailsModal(sleeperPlayerId).catch((e) => console.error("Player modal error:", e));
      card.addEventListener("click", open);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
    }

    card.innerHTML = `
      ${headshot ? `<img class="player-headshot" src="${escapeHtml(headshot)}" alt="${escapeHtml(name)} headshot" />` : ""}
      <div class="player-info">
        <span class="player-name">${escapeHtml(name)} (${escapeHtml(position)})</span>
        <div class="player-details">${escapeHtml(teamShort || "N/A")} • ${escapeHtml(oppText)}</div>
      </div>
      <div class="score-box">
        <div class="score-actual">${Number(actualScore).toFixed(2)}</div>
        <div class="score-projected">P: ${Number(projScore).toFixed(2)}</div>
      </div>
    `;

    container.appendChild(card);
  });
}

// ------------------------------
// Player modal helpers
// ------------------------------
let modalIsOpen = false;
let modalLastFocusedEl = null;

function getEl(id) { return document.getElementById(id); }

function openPlayerModal() {
  const backdrop = getEl("player-modal-backdrop");
  if (!backdrop) return;
  modalLastFocusedEl = document.activeElement;
  backdrop.classList.add("open");
  backdrop.setAttribute("aria-hidden", "false");
  modalIsOpen = true;
  const closeBtn = getEl("player-modal-close");
  if (closeBtn) closeBtn.focus();
}

function closePlayerModal() {
  const backdrop = getEl("player-modal-backdrop");
  if (!backdrop) return;
  backdrop.classList.remove("open");
  backdrop.setAttribute("aria-hidden", "true");
  modalIsOpen = false;
  if (modalLastFocusedEl && typeof modalLastFocusedEl.focus === "function") modalLastFocusedEl.focus();
}

function wirePlayerModalEventsOnce() {
  const backdrop = getEl("player-modal-backdrop");
  const closeBtn = getEl("player-modal-close");
  if (!backdrop || !closeBtn) return;
  if (backdrop.__wired) return;
  backdrop.__wired = true;

  closeBtn.addEventListener("click", closePlayerModal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closePlayerModal(); });
  document.addEventListener("keydown", (e) => { if (modalIsOpen && e.key === "Escape") closePlayerModal(); });
}

function renderPlayerModalContent({ title, subtitle, actionsHtml, bodyHtml }) {
  const titleEl = getEl("player-modal-title");
  const subEl = getEl("player-modal-subtitle");
  const actionsEl = getEl("player-modal-actions");
  const bodyEl = getEl("player-modal-body");
  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = subtitle;
  if (actionsEl) actionsEl.innerHTML = actionsHtml;
  if (bodyEl) bodyEl.innerHTML = bodyHtml;
}

function s(obj, key) {
  const v = obj?.[key];
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function buildRecentAndExpectedTable(rows, expectedRaw) {
  return `
    <table class="player-table" aria-label="Recent stats + expected">
      <thead>
        <tr>
          <th>Week</th>
          <th>PPR</th>
          <th>Rush</th>
          <th>Rec/Tgt</th>
          <th>Pass</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${escapeHtml(String(r.week))}</td>
            <td>${escapeHtml(formatStatValue(r.fantasy_points_ppr))}</td>
            <td>${escapeHtml(formatStatValue(r.carries))}-${escapeHtml(formatStatValue(r.rushing_yards))} (${escapeHtml(formatStatValue(r.rushing_tds))} TD)</td>
            <td>${escapeHtml(formatStatValue(r.receptions))}/${escapeHtml(formatStatValue(r.targets))}-${escapeHtml(formatStatValue(r.receiving_yards))} (${escapeHtml(formatStatValue(r.receiving_tds))} TD)</td>
            <td>${escapeHtml(formatStatValue(r.passing_yards))} (${escapeHtml(formatStatValue(r.passing_tds))} TD, ${escapeHtml(formatStatValue(r.passing_interceptions))} INT)</td>
          </tr>
        `).join("")}
        <tr>
          <td><strong>Expected</strong></td>
          <td><strong>${escapeHtml(formatStatValue(expectedRaw.fantasy_points_ppr))}</strong></td>
          <td><strong>${escapeHtml(formatStatValue(expectedRaw.carries))}-${escapeHtml(formatStatValue(expectedRaw.rushing_yards))} (${escapeHtml(formatStatValue(expectedRaw.rushing_tds))} TD)</strong></td>
          <td><strong>${escapeHtml(formatStatValue(expectedRaw.receptions))}/${escapeHtml(formatStatValue(expectedRaw.targets))}-${escapeHtml(formatStatValue(expectedRaw.receiving_yards))} (${escapeHtml(formatStatValue(expectedRaw.receiving_tds))} TD)</strong></td>
          <td><strong>${escapeHtml(formatStatValue(expectedRaw.passing_yards))} (${escapeHtml(formatStatValue(expectedRaw.passing_tds))} TD, ${escapeHtml(formatStatValue(expectedRaw.passing_interceptions))} INT)</strong></td>
        </tr>
      </tbody>
    </table>
  `;
}

async function showPlayerDetailsModal(sleeperPlayerId) {
  wirePlayerModalEventsOnce();
  await loadRawStatsOnce();

  const player = playerCache[String(sleeperPlayerId)] || playerCache[Number(sleeperPlayerId)] || null;
  if (!player) return;

  const position = String(player?.position || "").toUpperCase();
  const team = safeText(player?.team || "");
  const name = safeText(player?.full_name || (player?.first_name ? `${player.first_name} ${player.last_name}` : "Player"));

  const espnUrl = buildEspnPlayerUrl(player);
  const actions = espnUrl
    ? `<a href="${espnUrl}" target="_blank" rel="noopener noreferrer">Open ESPN player page</a>`
    : `<span class="player-muted">ESPN link unavailable</span>`;

  renderPlayerModalContent({
    title: name,
    subtitle: `${team ? team + " • " : ""}${position || ""}`.trim(),
    actionsHtml: actions,
    bodyHtml: `<div class="player-muted">Loading stats…</div>`,
  });

  openPlayerModal();

  const gsis = player?.gsis_id;
  const maxWeek = Number(rawStats.maxWeek || 0);

  if (!gsis || !maxWeek) {
    renderPlayerModalContent({
      title: name,
      subtitle: `${team ? team + " • " : ""}${position || ""}`.trim(),
      actionsHtml: actions,
      bodyHtml: `<div class="player-muted">Raw stats unavailable (missing gsis_id or raw file not loaded).</div>`,
    });
    return;
  }

  const currentWeek = Number(DISPLAY_WEEK);
  const weeksToFetch = getLastNWeeksCompleted(currentWeek, 6, maxWeek);

  // Build rows from raw file: weeks[w][gsis_id]
  const rows = [];
  for (const w of weeksToFetch) {
    const row = getRawStatRowByGsis(w, gsis);
    if (!row) continue;
    rows.push(row);
  }

  if (!rows.length) {
    renderPlayerModalContent({
      title: name,
      subtitle: `${team ? team + " • " : ""}${position || ""}`.trim(),
      actionsHtml: actions,
      bodyHtml: `<div class="player-muted">No raw stats found for this player in weeks ${escapeHtml(String(weeksToFetch[0] || 1))}–${escapeHtml(String(weeksToFetch[weeksToFetch.length - 1] || maxWeek))}.</div>`,
    });
    return;
  }

  // Weighted expected from last N rows (oldest=1 newest=N)
  const weights = rows.map((_, i) => i + 1);

  const wAvg = (key) =>
    weightedAvg(rows.map((r, i) => ({ v: s(r, key), w: weights[i] })));

  const expectedRaw = {
    fantasy_points_ppr: wAvg("fantasy_points_ppr"),
    carries: wAvg("carries"),
    rushing_yards: wAvg("rushing_yards"),
    rushing_tds: wAvg("rushing_tds"),
    receptions: wAvg("receptions"),
    targets: wAvg("targets"),
    receiving_yards: wAvg("receiving_yards"),
    receiving_tds: wAvg("receiving_tds"),
    passing_yards: wAvg("passing_yards"),
    passing_tds: wAvg("passing_tds"),
    passing_interceptions: wAvg("passing_interceptions"),
  };

  // Headshot inside modal from latest available raw row
  let headshot = "";
  for (let w = maxWeek; w >= 1; w -= 1) {
    const r = getRawStatRowByGsis(w, gsis);
    if (r?.headshot_url) { headshot = String(r.headshot_url); break; }
  }

  const headshotHtml = headshot
    ? `<div style="display:flex;gap:14px;align-items:center;margin-top:6px;margin-bottom:6px;">
         <img class="player-headshot" src="${escapeHtml(headshot)}" alt="${escapeHtml(name)} headshot" />
         <div class="player-muted">Raw stats: weeks ${escapeHtml(String(weeksToFetch[0]))}–${escapeHtml(String(weeksToFetch[weeksToFetch.length - 1]))}</div>
       </div>`
    : `<div class="player-muted" style="margin-top:6px;margin-bottom:6px;">Raw stats: weeks ${escapeHtml(String(weeksToFetch[0]))}–${escapeHtml(String(weeksToFetch[weeksToFetch.length - 1]))}</div>`;

  const table = buildRecentAndExpectedTable(rows, expectedRaw);

  renderPlayerModalContent({
    title: name,
    subtitle: `${team ? team + " • " : ""}${position || ""}`.trim(),
    actionsHtml: actions,
    bodyHtml: `${headshotHtml}${table}`,
  });
}

// ------------------------------
// Main application flow
// ------------------------------
async function fetchAndRenderData() {
  if (!leagueContext.users || !leagueContext.rosters || !leagueContext.userRosterId) return;

  // Always show Week 16
  const week = DISPLAY_WEEK;
  const season = Number(nflState?.season) || new Date().getFullYear();

  await fetchScheduleForSeasonAndWeek(season, week);

  const dynamicData = await fetchDynamicData(week, season);
  mergeAndRenderData(dynamicData);
}

function startLiveUpdate() {
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }

  let countdownValue = Math.floor(UPDATE_INTERVAL_MS / 1000);
  const countdownElement = document.getElementById("countdown");

  const tick = async () => {
    if (countdownElement) countdownElement.textContent = String(countdownValue);

    if (countdownValue <= 0) {
      countdownValue = Math.floor(UPDATE_INTERVAL_MS / 1000);
      try {
        await getNFLState();
        await fetchAndRenderData();
      } catch (err) {
        console.error("Live update error:", err);
      }
    } else {
      countdownValue -= 1;
    }
  };

  tick();
  updateTimer = setInterval(tick, 1000);
}

async function initializeApp() {
  try {
    await getNFLState();
    await getAllPlayers();
    await fetchInitialContext();

    // Load raw stats in background (so headshots appear without first modal open)
    loadRawStatsOnce().catch(() => null);

    await fetchAndRenderData();
    startLiveUpdate();
  } catch (error) {
    const loadingEl = document.getElementById("loading");
    if (loadingEl) loadingEl.textContent = `Error: ${error.message}. Check LEAGUE_ID / USER_USERNAME.`;
    console.error("Initialization Failed:", error);
  }
}

// Kick off the application
initializeApp();
