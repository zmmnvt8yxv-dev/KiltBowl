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
// Uses undocumented but widely-used endpoint:
//   https://api.sleeper.app/schedule/nfl/regular/<year>
// (surfaced in community wrappers)
// ------------------------------
function buildScheduleMapForWeek(schedule, week) {
  const map = {};
  if (!Array.isArray(schedule)) return map;

  const weekGames = schedule.filter((g) => {
    const w = Number(g?.week ?? g?.week_number ?? g?.weekNumber);
    return w === Number(week);
  });

  weekGames.forEach((g) => {
    // Common shapes seen in the wild:
    // { week, home, away, kickoff, status }
    // or { week, home_team, away_team, start_time }
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
  // Per sleeper-go docs, schedule endpoint is:
  // https://api.sleeper.app/schedule/nfl/<regular or post>/<year>
  const regularUrl = `https://api.sleeper.app/schedule/nfl/regular/${season}`;
  const candidates = [regularUrl];

  const schedule = await tryFetchFirst(candidates);
  scheduleByTeam = buildScheduleMapForWeek(schedule, week);

  console.log(`Schedule map built for week ${week}. Teams mapped: ${Object.keys(scheduleByTeam).length}`);
}

// ------------------------------
// Step 5: Matchups + Projections
// ------------------------------
function normalizeProjectionsToMap(projData) {
  // Sleeper projections frequently returns an array of objects, each containing player_id and scoring fields.
  // Normalize to: { [player_id]: projectionObject }
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
  // sometimes it might already be a map
  if (projData && typeof projData === "object") {
    for (const [k, v] of Object.entries(projData)) {
      map[String(k)] = v;
    }
  }
  return map;
}

async function fetchDynamicData(week, season) {
  const matchupUrl = `${API_BASE}/league/${LEAGUE_ID}/matchups/${week}`;

  // Undocumented but widely used projections endpoint (from sleeper-go docs):
  // https://api.sleeper.app/projections/nfl/<season>/<week>?season_type=regular&position[]=...
  // We request all common fantasy positions.
  const projectionsUrl = `https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&position[]=FLEX`;

  const [matchups, projectionsRaw] = await Promise.all([
    fetchJson(matchupUrl),
    tryFetchFirst([projectionsUrl]).catch(() => null),
  ]);

  const projections = normalizeProjectionsToMap(projectionsRaw || {});

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
  // common field names seen in Sleeper projections
  // pts_ppr, fantasy_points, points
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

  // Always show Week 16
  const week = DISPLAY_WEEK;
  const season = Number(nflState?.season) || new Date().getFullYear();

  // Schedule map (opponents)
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
        // Keep season in sync, but do NOT change DISPLAY_WEEK
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

    // Initial render
    await fetchAndRenderData();

    // Live updates
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
