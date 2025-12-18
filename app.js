// --- Global Configuration ---
const LEAGUE_ID = "1262418074540195841";
const USER_USERNAME = "conner27lax";
const UPDATE_INTERVAL_MS = 30000; // 30 seconds

// Force the app to always display Week 16
const DISPLAY_WEEK = 16;

// --- Global Data Stores (Client-side Cache) ---
const API_BASE = "https://api.sleeper.app/v1";
const AVATAR_BASE = "https://sleepercdn.com/avatars/thumbs/";

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

// Weekly stats cache: { [weekNumber]: statsPayload }
let statsCacheByWeek = {};

// Modal state
let modalIsOpen = false;
let modalLastFocusedEl = null;

// ------------------------------
// Utilities
// ------------------------------
async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} for ${url}`);
  }
  return response.json();
}

// Try multiple candidate URLs and return first successful non-empty result
async function tryFetchFirst(urls = []) {
  for (const url of urls) {
    try {
      const data = await fetchJson(url);
      if (data && (Array.isArray(data) ? data.length > 0 : Object.keys(data).length > 0)) {
        return data;
      }
    } catch (_) {
      // ignore and try next
    }
  }
  return null;
}

function escapeHtml(str) {
  return String(str)
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

// ------------------------------
// Player modal helpers
// Requires HTML elements with ids:
// player-modal-backdrop, player-modal-title, player-modal-subtitle,
// player-modal-actions, player-modal-body, player-modal-close
// ------------------------------
function getEl(id) {
  return document.getElementById(id);
}

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

  if (modalLastFocusedEl && typeof modalLastFocusedEl.focus === "function") {
    modalLastFocusedEl.focus();
  }
}

function wirePlayerModalEventsOnce() {
  const backdrop = getEl("player-modal-backdrop");
  const closeBtn = getEl("player-modal-close");
  if (!backdrop || !closeBtn) return;

  if (backdrop.__wired) return;
  backdrop.__wired = true;

  closeBtn.addEventListener("click", closePlayerModal);

  // Click outside closes
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closePlayerModal();
  });

  // Escape closes
  document.addEventListener("keydown", (e) => {
    if (!modalIsOpen) return;
    if (e.key === "Escape") closePlayerModal();
  });
}

function safeText(v) {
  return v === undefined || v === null ? "" : String(v);
}

function buildEspnPlayerUrl(playerObj) {
  const espnId = playerObj?.espn_id ?? playerObj?.espnId;
  if (!espnId) return "";
  return `https://www.espn.com/nfl/player/_/id/${encodeURIComponent(String(espnId))}`;
}

async function fetchStatsForWeekCached(season, week) {
  const w = Number(week);
  if (statsCacheByWeek[w]) return statsCacheByWeek[w];

  const url = `${API_BASE}/stats/nfl/${season}/${w}`;
  const data = await tryFetchFirst([url]);
  statsCacheByWeek[w] = data || null;
  return statsCacheByWeek[w];
}

function getPlayerStatsFromWeekPayload(weekPayload, playerId) {
  if (!weekPayload) return null;
  const pid = String(playerId);

  if (typeof weekPayload === "object" && !Array.isArray(weekPayload)) {
    if (weekPayload[pid]) return weekPayload[pid];
    if (weekPayload[String(Number(pid))]) return weekPayload[String(Number(pid))];

    const nested = weekPayload.data || weekPayload.stats || null;
    if (nested) return getPlayerStatsFromWeekPayload(nested, pid);
  }

  if (Array.isArray(weekPayload)) {
    const row = weekPayload.find((r) => String(r?.player_id ?? r?.playerId ?? r?.id) === pid);
    if (!row) return null;
    return row?.stats ? row.stats : row;
  }

  return null;
}

function formatStatValue(v) {
  if (v === undefined || v === null) return "—";
  const n = Number(v);
  if (Number.isFinite(n)) return Math.abs(n % 1) < 1e-9 ? String(n) : n.toFixed(2);
  return String(v);
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

async function showPlayerDetailsModal(playerId) {
  wirePlayerModalEventsOnce();

  const player = playerCache[String(playerId)] || playerCache[Number(playerId)] || null;
  if (!player) return;

  const position = String(player?.position || "").toUpperCase();
  const team = safeText(player?.team || "");
  const name = safeText(
    player?.full_name || (player?.first_name ? `${player.first_name} ${player.last_name}` : "Player")
  );

  const espnUrl = buildEspnPlayerUrl(player);
  const actions = espnUrl
    ? `<a href="${espnUrl}" target="_blank" rel="noopener noreferrer">Open ESPN player page</a>`
    : `<span class="player-muted">ESPN link unavailable (no espn_id)</span>`;

  renderPlayerModalContent({
    title: name,
    subtitle: `${team ? team + " • " : ""}${position || ""}`.trim(),
    actionsHtml: actions,
    bodyHtml: `<div class="player-loading">Loading stats, game log, and projections…</div>`,
  });

  openPlayerModal();

  const season = Number(nflState?.season) || new Date().getFullYear();
  const currentWeek = Number(DISPLAY_WEEK);

  // last 5 completed weeks prior to DISPLAY_WEEK
  const weeksToFetch = [];
  for (let w = Math.max(1, currentWeek - 5); w <= Math.max(1, currentWeek - 1); w += 1) {
    weeksToFetch.push(w);
  }

  const gameLogRows = [];
  for (const w of weeksToFetch) {
    let payload = null;
    try {
      payload = await fetchStatsForWeekCached(season, w);
    } catch (_) {
      payload = null;
    }

    const statsObj = getPlayerStatsFromWeekPayload(payload, playerId);
    const pts = statsObj?.pts_ppr ?? statsObj?.fantasy_points ?? statsObj?.points;
    gameLogRows.push({ week: w, pts: formatStatValue(pts), note: statsObj ? "" : "No data" });
  }

  const latestProjections = window.__latestProjections || {};
  const projObj = latestProjections?.[String(playerId)] || latestProjections?.[Number(playerId)] || null;
  const projPts = getProjectedPoints(projObj);

  const gameLogTable = `
    <table class="player-table" aria-label="Game log">
      <thead>
        <tr><th>Week</th><th>PPR Pts</th><th>Notes</th></tr>
      </thead>
      <tbody>
        ${gameLogRows
          .map(
            (r) =>
              `<tr><td>${r.week}</td><td>${escapeHtml(r.pts)}</td><td class="player-muted">${escapeHtml(
                r.note || ""
              )}</td></tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;

  const projPanel = `
    <div class="player-kv">
      <div class="k">Projected (PPR)</div><div>${escapeHtml(formatStatValue(projPts))}</div>
      <div class="k">Week</div><div>${escapeHtml(String(currentWeek))}</div>
    </div>
  `;

  renderPlayerModalContent({
    title: name,
    subtitle: `${team ? team + " • " : ""}${position || ""}`.trim(),
    actionsHtml: actions,
    bodyHtml: `
      <div class="player-modal-grid">
        <div class="player-panel"><h3>Projection</h3>${projPanel}</div>
        <div class="player-panel" style="grid-column: 1 / -1;"><h3>Recent game log</h3>${gameLogTable}</div>
      </div>
    `,
  });
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
// Step 2: Players cache
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
  const schedule = await tryFetchFirst([regularUrl]);
  scheduleByTeam = buildScheduleMapForWeek(schedule, week);

  console.log(`Schedule map built for week ${week}. Teams mapped: ${Object.keys(scheduleByTeam).length}`);
}

// ------------------------------
// Step 5: Matchups + Projections
// ------------------------------
function normalizeProjectionsToMap(projData) {
  const map = {};
  if (Array.isArray(projData)) {
    for (const p of projData) {
      const pid = p?.player_id ?? p?.playerId ?? p?.id;
      if (pid !== undefined && pid !== null) {
        map[String(pid)] = p;
      }
    }
    return map;
  }
  if (projData && typeof projData === "object") {
    for (const [k, v] of Object.entries(projData)) {
      map[String(k)] = v;
    }
  }
  return map;
}

async function fetchDynamicData(week, season) {
  const matchupUrl = `${API_BASE}/league/${LEAGUE_ID}/matchups/${week}`;
  const projectionsUrl = `https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&position[]=FLEX`;

  const [matchups, projectionsRaw] = await Promise.all([
    fetchJson(matchupUrl),
    tryFetchFirst([projectionsUrl]).catch(() => null),
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
  if (!data || !Array.isArray(data.matchupTeams)) {
    console.error("Invalid data structure received:", data);
    return;
  }

  const { matchupTeams, projections } = data;

  const teamA = matchupTeams.find((t) => t && t.roster_id === leagueContext.userRosterId);
  const teamB = matchupTeams.find((t) => t && t.roster_id !== leagueContext.userRosterId);

  if (!teamA || !teamB) {
    throw new Error("Could not identify both teams in the matchup.");
  }

  const getTeamDetails = (matchupTeam) => {
    if (!matchupTeam) return null;

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

  const teamADetails = getTeamDetails(teamA);
  const teamBDetails = getTeamDetails(teamB);

  if (!teamADetails || !teamBDetails) {
    throw new Error("Failed to get team details");
  }

  setText("team-a-name", teamADetails.name);
  setText("team-a-record", teamADetails.record);
  setImgSrc("team-a-avatar", teamADetails.avatar ? `${AVATAR_BASE}${teamADetails.avatar}` : "");
  setText("score-a", teamADetails.points.toFixed(2));

  setText("team-b-name", teamBDetails.name);
  setText("team-b-record", teamBDetails.record);
  setImgSrc("team-b-avatar", teamBDetails.avatar ? `${AVATAR_BASE}${teamBDetails.avatar}` : "");
  setText("score-b", teamBDetails.points.toFixed(2));

  renderStarters(teamADetails.starters, "team-a-starters", teamADetails.playersPoints, projections);
  renderStarters(teamBDetails.starters, "team-b-starters", teamBDetails.playersPoints, projections);

  const scoreboardEl = document.getElementById("scoreboard");
  if (scoreboardEl) scoreboardEl.classList.remove("hidden");
  const loadingEl = document.getElementById("loading");
  if (loadingEl) loadingEl.classList.add("hidden");

  lastUpdatedTime = new Date();
  const lastUpdatedEl = document.getElementById("last-updated");
  if (lastUpdatedEl) lastUpdatedEl.textContent = lastUpdatedTime.toLocaleTimeString();
}

// ------------------------------
// Starters list rendering (Actual + Projection + Opponent)
// ------------------------------
function getOpponentTextForTeam(teamAbbrev) {
  const entry = scheduleByTeam?.[teamAbbrev];
  if (!entry) return "N/A";

  const ha = entry.homeAway || "vs";
  const opp = entry.opp || "";
  const status = entry.gameStatus ? ` • ${entry.gameStatus}` : "";

  return `${ha} ${opp}${status}`.trim();
}

function getProjectedPoints(projObj) {
  if (!projObj) return 0;
  const v = projObj.pts_ppr ?? projObj.fantasy_points ?? projObj.points;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function renderStarters(starterIds = [], containerId, playersPoints = {}, projections = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = "";
  if (!Array.isArray(starterIds)) return;

  starterIds.forEach((playerIdRaw) => {
    const playerId = String(playerIdRaw);

    // Team DEF often appears as "HOU", "DAL", etc.
    const isTeamDef = /^[A-Z]{2,4}$/.test(playerId) && !playerCache[playerId];

    const player = playerCache[playerId] || playerCache[Number(playerId)] || null;

    const position = isTeamDef ? "DEF" : (player?.position || "N/A");
    const name = isTeamDef
      ? `${playerId} Defense`
      : (player?.full_name || (player?.first_name ? `${player.first_name} ${player.last_name}` : "Unknown Player"));

    const teamShort = isTeamDef ? playerId : (player?.team || "");
    const actualScore = Number(playersPoints?.[playerId] ?? 0);

    const projObj = projections?.[playerId] || projections?.[Number(playerId)] || null;
    const projScore = getProjectedPoints(projObj);

    const oppText = teamShort ? getOpponentTextForTeam(teamShort) : "N/A";

    const card = document.createElement("div");
    card.className = "player-card";

    // Make cards clickable for real players (not team DEF tokens)
    if (!isTeamDef) {
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");

      const open = () => showPlayerDetailsModal(playerId).catch((e) => console.error("Player modal error:", e));

      card.addEventListener("click", open);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
    }

    card.innerHTML = `
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
// Main application flow
// ------------------------------
async function fetchAndRenderData() {
  if (!leagueContext.users || !leagueContext.rosters || !leagueContext.userRosterId) return;

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

    await fetchAndRenderData();

    startLiveUpdate();
  } catch (error) {
    const loadingEl = document.getElementById("loading");
    if (loadingEl) {
      loadingEl.textContent = `Error: ${error.message}. Check LEAGUE_ID / USER_USERNAME.`;
    }
    console.error("Initialization Failed:", error);
  }
}

// Kick off the application
initializeApp();
