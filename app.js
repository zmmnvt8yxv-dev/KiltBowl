// --- Global Configuration ---
const LEAGUE_ID = "1262418074540195841";
const USER_USERNAME = "conner27lax";
const UPDATE_INTERVAL_MS = 30000; // 30 seconds refresh rate

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
let updateTimer = null;
let lastUpdatedTime = null;

// Utility to fetch JSON data
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
      // treat null/empty object/empty array as "no useful data"
      if (data && (Array.isArray(data) ? data.length > 0 : Object.keys(data).length > 0)) {
        return data;
      }
    } catch (err) {
      // ignore and try next
    }
  }
  return null;
}

/**
 * STEP 1: Get the current NFL season and week.
 */
async function getNFLState() {
  try {
    const url = `${API_BASE}/state/nfl`;
    nflState = await fetchJson(url);
    console.log(`Current NFL Week: ${nflState.week}, Season: ${nflState.season}`);
  } catch (error) {
    console.error("Error fetching NFL State:", error);
    throw new Error("Failed to retrieve current NFL season information.");
  }
}

/**
 * STEP 2 (Initial Load Only): Cache all NFL player data.
 */
async function getAllPlayers() {
  try {
    if (Object.keys(playerCache).length > 0) {
      console.log("Player cache already populated.");
      return;
    }
    const url = `${API_BASE}/players/nfl`;
    const playersData = await fetchJson(url);
    playerCache = playersData || {};
    console.log(`Cached ${Object.keys(playerCache).length} players.`);
  } catch (error) {
    console.error("Error fetching all players:", error);
    throw new Error("Failed to cache player data. Cannot translate Player IDs.");
  }
}

/**
 * STEP 3 (Initial Load Only): Map users and rosters.
 */
async function fetchInitialContext() {
  try {
    const userUrl = `${API_BASE}/user/${USER_USERNAME}`;
    const userData = await fetchJson(userUrl);
    const userId = userData.user_id;

    const usersUrl = `${API_BASE}/league/${LEAGUE_ID}/users`;
    const rostersUrl = `${API_BASE}/league/${LEAGUE_ID}/rosters`;
    const [users, rosters] = await Promise.all([
      fetchJson(usersUrl),
      fetchJson(rostersUrl),
    ]);

    leagueContext.users = users;
    leagueContext.rosters = rosters;

    const userRoster = rosters.find((r) => r.owner_id === userId);
    if (!userRoster) {
      throw new Error(`Roster not found for user ${USER_USERNAME} in league ${LEAGUE_ID}.`);
    }
    leagueContext.userRosterId = userRoster.roster_id;
    console.log(`Identified current user's Roster ID: ${leagueContext.userRosterId}`);
  } catch (error) {
    const loadingEl = document.getElementById("loading");
    if (loadingEl) {
      loadingEl.textContent = `Error: Failed to identify user or fetch league structure. Check if '${USER_USERNAME}' is correct.`;
    }
    console.error("Error fetching initial league context:", error);
    throw new Error("Failed to identify user or fetch league structure.");
  }
}

/**
 * STEP 4: Retrieve matchup, stats, and projections.
 */
async function fetchDynamicData(week, season) {
  if (!week || !season) {
    throw new Error(`Invalid week (${week}) or season (${season})`);
  }

  const matchupUrl = `${API_BASE}/league/${LEAGUE_ID}/matchups/${week}`;

  // Several Sleeper endpoints are undocumented or vary between wrappers.
  // We'll try a few candidates and fall back to empty objects if none succeed.
  const projectionCandidates = [
    `${API_BASE}/projections/nfl/${season}/${week}`,
    `${API_BASE}/projections/${season}/${week}`,
    // legacy/undocumented possibilities
    `${API_BASE}/players/nfl/projections/${season}/${week}`,
  ];
  const statsCandidates = [
    `${API_BASE}/stats/nfl/players/${season}/${week}`,
    `${API_BASE}/stats/nfl/${season}/${week}`,
    `${API_BASE}/players/nfl/stats/${season}/${week}`,
  ];

  // Fetch concurrently. If projections/stats candidates fail, default to {}.
  const [matchups, fetchedProjections, fetchedStats] = await Promise.all([
    fetchJson(matchupUrl),
    tryFetchFirst(projectionCandidates).catch(() => null),
    tryFetchFirst(statsCandidates).catch(() => null),
  ]);

  const projections = fetchedProjections || {};
  const stats = fetchedStats || {};

  if (!Array.isArray(matchups) || matchups.length === 0) {
    console.warn(`No matchup data available for Week ${week}`);
    // still return empty structure so caller can handle graceful UI
    return { matchupTeams: [], projections, stats };
  }

  const userTeamMatchup = matchups.find((m) => m && m.roster_id === leagueContext.userRosterId);
  if (!userTeamMatchup) {
    throw new Error(`Matchup data for Roster ID ${leagueContext.userRosterId} not found in Week ${week}.`);
  }

  leagueContext.matchupId = userTeamMatchup.matchup_id;

  const currentMatchupTeams = matchups
    .filter((m) => m && m.matchup_id === leagueContext.matchupId)
    .sort((a, b) => a.roster_id - b.roster_id);

  return {
    matchupTeams: currentMatchupTeams,
    projections,
    stats,
  };
}

/**
 * STEP 5: Merge all data sets and render to the DOM.
 */
function mergeAndRenderData(data) {
  if (!data || !Array.isArray(data.matchupTeams)) {
    console.error("Invalid data structure received:", data);
    return;
  }

  const { matchupTeams, projections, stats } = data;

  const teamA = matchupTeams.find((t) => t && t.roster_id === leagueContext.userRosterId);
  const teamB = matchupTeams.find((t) => t && t.roster_id !== leagueContext.userRosterId);

  if (!teamA || !teamB) {
    throw new Error("Could not identify both teams in the matchup.");
  }

  const getTeamDetails = (roster) => {
    if (!roster) return null;

    const user = leagueContext.users?.find((u) => u && u.user_id === roster.owner_id);
    const teamName = roster.metadata?.team_name || user?.display_name || `Roster ${roster.roster_id}`;
    const wins = roster.settings?.wins || 0;
    const losses = roster.settings?.losses || 0;
    const ties = roster.settings?.ties || 0;
    const record = `${wins}-${losses}${ties > 0 ? "-" + ties : ""}`;

    return {
      id: roster.roster_id,
      name: teamName,
      record,
      avatar: user?.avatar || "",
      starters: roster.starters || [], // roster object from /rosters should contain starters
      points: roster.points || 0,
    };
  };

  const teamADetails = getTeamDetails(teamA);
  const teamBDetails = getTeamDetails(teamB);

  if (!teamADetails || !teamBDetails) {
    throw new Error("Failed to get team details");
  }

  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  const setImgSrc = (id, src) => {
    const el = document.getElementById(id);
    if (el && el.tagName === "IMG") el.src = src;
  };

  setText("team-a-name", teamADetails.name);
  setText("team-a-record", teamADetails.record);
  setImgSrc("team-a-avatar", teamADetails.avatar ? `${AVATAR_BASE}${teamADetails.avatar}` : "");
  setText("score-a", Number(teamADetails.points || 0).toFixed(2));

  setText("team-b-name", teamBDetails.name);
  setText("team-b-record", teamBDetails.record);
  setImgSrc("team-b-avatar", teamBDetails.avatar ? `${AVATAR_BASE}${teamBDetails.avatar}` : "");
  setText("score-b", Number(teamBDetails.points || 0).toFixed(2));

  renderStarters(teamADetails.starters, "team-a-starters", projections, stats);
  renderStarters(teamBDetails.starters, "team-b-starters", projections, stats);

  const scoreboardEl = document.getElementById("scoreboard");
  if (scoreboardEl) scoreboardEl.classList.remove("hidden");
  const loadingEl = document.getElementById("loading");
  if (loadingEl) loadingEl.classList.add("hidden");

  lastUpdatedTime = new Date();
  const lastUpdatedEl = document.getElementById("last-updated");
  if (lastUpdatedEl) lastUpdatedEl.textContent = lastUpdatedTime.toLocaleTimeString();
}

/**
 * Renders the list of starting players for one team.
 * starterIds: array of player IDs (strings or numbers)
 * containerId: DOM id where player cards should be appended
 * projections: object mapping playerId -> projection object (shape may vary)
 * stats: object mapping playerId -> actual stats object (shape may vary)
 */
function renderStarters(starterIds = [], containerId, projections = {}, stats = {}) {
  const container = document.getElementById(containerId);
  if (!container) {
    console.warn("Container not found for:", containerId);
    return;
  }

  container.innerHTML = "";

  if (!Array.isArray(starterIds)) {
    console.error("starterIds is not an array:", starterIds);
    return;
  }

  starterIds.forEach((playerIdRaw) => {
    const playerId = String(playerIdRaw);
    const player = playerCache[playerId] || playerCache[Number(playerId)] || null;

    const position = player?.position || "N/A";
    const name = player?.full_name || player?.first_name ? `${player.first_name} ${player.last_name}` : "Unknown Player";
    const teamShort = player?.team || "";

    // attempt several possible projection field names
    const projObj = projections?.[playerId] || projections?.[Number(playerId)] || {};
    const projScore = (projObj?.pts_ppr ?? projObj?.fantasy_points ?? projObj?.points ?? 0) || 0;

    // attempt several possible stats field names
    const statObj = stats?.[playerId] || stats?.[Number(playerId)] || {};
    const actualScore = (statObj?.pts_ppr ?? statObj?.fantasy_points ?? statObj?.points ?? 0) || 0;

    let statusText = teamShort ? `${teamShort}` : "N/A";
    if (actualScore > 0.01 && projScore !== 0) {
      statusText += " - LIVE";
    } else if (projScore === 0) {
      statusText += " - BYE/Post-Game";
    } else {
      statusText += " - YET TO PLAY";
    }

    const card = document.createElement("div");
    card.className = "player-card";
    card.innerHTML = `
      <div class="player-info">
        <span class="player-name">${escapeHtml(name)} (${escapeHtml(position)})</span>
        <div class="player-details">
          ${escapeHtml(statusText)}
        </div>
      </div>
      <div class="score-box">
        <div class="score-actual">${Number(actualScore).toFixed(2)}</div>
        <div class="score-projected">P: ${Number(projScore).toFixed(2)}</div>
      </div>
    `;
    container.appendChild(card);
  });
}

// small helper to avoid XSS if names contain unexpected markup
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Main application initializer.
 */
async function initializeApp() {
  try {
    await getNFLState();
    await getAllPlayers();
    await fetchInitialContext();
    await fetchAndRenderData(nflState.week, nflState.season);
    startLiveUpdate();
  } catch (error) {
    const loadingEl = document.getElementById("loading");
    if (loadingEl) {
      loadingEl.textContent = `Error: ${error.message}. Please check your LEAGUE_ID and USER_USERNAME configuration.`;
    }
    console.error("Initialization Failed:", error);
  }
}

/**
 * Handles the periodic update loop.
 */
async function fetchAndRenderData(week, season) {
  try {
    if (!leagueContext.users || !leagueContext.rosters || !leagueContext.userRosterId) {
      console.error("League context not initialized properly");
      return;
    }

    const dynamicData = await fetchDynamicData(week, season);
    mergeAndRenderData(dynamicData);
  } catch (error) {
    console.warn(`Live Update Warning (Week ${week}): ${error.message}. Retrying on next interval.`);
  }
}

/**
 * Start the live update countdown and refresh.
 */
function startLiveUpdate() {
  // prevent multiple timers
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
        await getNFLState(); // refetch to detect week/season changes
        await fetchAndRenderData(nflState.week, nflState.season);
      } catch (err) {
        console.error("Error updating NFL state / live data:", err);
      }
    } else {
      countdownValue -= 1;
    }
  };

  // initial immediate tick to display countdown right away
  tick();
  updateTimer = setInterval(tick, 1000);
}

// Kick off the application when page loads
initializeApp();
