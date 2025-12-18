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
  matchupId: null, // "my matchup" id for DISPLAY_WEEK
};

let scheduleByTeam = {}; // { TEAM: { opp: TEAM, homeAway: 'vs'|'@', gameStatus: string, start: string } }
let updateTimer = null;
let lastUpdatedTime = null;

// Matchup selector state
let matchupIndexById = {}; // { [matchup_id]: { matchupId, rosterIds:[a,b], label } }
let selectedMatchupId = null;

// Raw stats cache (from nflreadpy file)
let rawStats = {
  loaded: false,
  season: null,
  maxWeek: 0,
  weeks: {}, // weeks["1"]["00-0023459"] = stats row object
};

// GSIS fallback index (name/team/pos)
let rawIndexBuilt = false;
let rawIndex = {
  byNameTeamPos: new Map(), // key: normName|TEAM|POS -> gsis
  byNamePos: new Map(), // key: normName|POS -> gsis
  byLastInitTeam: new Map(), // key: last|init|TEAM -> gsis
};

let gsisFallbackCacheBySleeperId = {}; // { sleeper_player_id: gsis_id }

// Modal state
let modalIsOpen = false;
let modalLastFocusedEl = null;

// ------------------------------
// League scoring (your settings)
// ------------------------------
const LEAGUE_SCORING = {
  passing: {
    yards_per_point: 25, // +0.04 per yard
    td: 4,
    two_pt: 2,
    int: -1,
  },
  rushing: {
    yards_per_point: 10, // +0.1 per yard
    td: 6,
    two_pt: 2,
  },
  receiving: {
    rec: 0.5,
    yards_per_point: 10, // +0.1 per yard
    td: 6,
    two_pt: 2,
  },
  kicking: {
    fg_made_0_19: 3,
    fg_made_20_29: 3,
    fg_made_30_39: 3,
    fg_made_40_49: 4,
    fg_made_50_plus: 5,
    pat_made: 1,

    fg_miss_base: -1,
    fg_miss_0_19: -2,
    fg_miss_20_29: -2,
    fg_miss_30_39: -2,
    fg_miss_40_49: -1,

    pat_miss: -2,
  },
  misc: {
    fumble_lost: -2,
    fumble_recovery_td: 6,
    special_teams_td: 6,
  },
  bonus: {
    pass_300_399: 2,
    pass_400_plus: 4,
    rush_100_199: 2,
    rush_200_plus: 4,
    rec_100_199: 2,
    rec_200_plus: 4,
  },
};

function n0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clampInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function computeLeaguePointsFromRaw(row) {
  if (!row) return 0;

  // Passing
  const passYds = n0(row.passing_yards);
  const passTD = n0(row.passing_tds);
  const pass2pt = n0(row.passing_2pt_conversions);
  const passInt = n0(row.passing_interceptions);

  let pts =
    passYds / LEAGUE_SCORING.passing.yards_per_point +
    passTD * LEAGUE_SCORING.passing.td +
    pass2pt * LEAGUE_SCORING.passing.two_pt +
    passInt * LEAGUE_SCORING.passing.int;

  if (passYds >= 400) pts += LEAGUE_SCORING.bonus.pass_400_plus;
  else if (passYds >= 300) pts += LEAGUE_SCORING.bonus.pass_300_399;

  // Rushing
  const rushYds = n0(row.rushing_yards);
  const rushTD = n0(row.rushing_tds);
  const rush2pt = n0(row.rushing_2pt_conversions);

  pts +=
    rushYds / LEAGUE_SCORING.rushing.yards_per_point +
    rushTD * LEAGUE_SCORING.rushing.td +
    rush2pt * LEAGUE_SCORING.rushing.two_pt;

  if (rushYds >= 200) pts += LEAGUE_SCORING.bonus.rush_200_plus;
  else if (rushYds >= 100) pts += LEAGUE_SCORING.bonus.rush_100_199;

  // Receiving
  const rec = n0(row.receptions);
  const recYds = n0(row.receiving_yards);
  const recTD = n0(row.receiving_tds);
  const rec2pt = n0(row.receiving_2pt_conversions);

  pts +=
    rec * LEAGUE_SCORING.receiving.rec +
    recYds / LEAGUE_SCORING.receiving.yards_per_point +
    recTD * LEAGUE_SCORING.receiving.td +
    rec2pt * LEAGUE_SCORING.receiving.two_pt;

  if (recYds >= 200) pts += LEAGUE_SCORING.bonus.rec_200_plus;
  else if (recYds >= 100) pts += LEAGUE_SCORING.bonus.rec_100_199;

  // Kicking
  const fg0 = clampInt(row.fg_made_0_19);
  const fg20 = clampInt(row.fg_made_20_29);
  const fg30 = clampInt(row.fg_made_30_39);
  const fg40 = clampInt(row.fg_made_40_49);
  const fgMadeTotal = clampInt(row.fg_made);
  const fg50 = Math.max(0, fgMadeTotal - (fg0 + fg20 + fg30 + fg40));

  pts +=
    fg0 * LEAGUE_SCORING.kicking.fg_made_0_19 +
    fg20 * LEAGUE_SCORING.kicking.fg_made_20_29 +
    fg30 * LEAGUE_SCORING.kicking.fg_made_30_39 +
    fg40 * LEAGUE_SCORING.kicking.fg_made_40_49 +
    fg50 * LEAGUE_SCORING.kicking.fg_made_50_plus;

  const patMade = clampInt(row.pat_made);
  const patMiss = clampInt(row.pat_missed);
  pts += patMade * LEAGUE_SCORING.kicking.pat_made;
  pts += patMiss * LEAGUE_SCORING.kicking.pat_miss;

  const miss0 = clampInt(row.fg_missed_0_19);
  const miss20 = clampInt(row.fg_missed_20_29);
  const miss30 = clampInt(row.fg_missed_30_39);
  const miss40 = clampInt(row.fg_missed_40_49);
  const totalMiss = clampInt(row.fg_missed);

  const bucketed = miss0 + miss20 + miss30 + miss40;
  const remaining = Math.max(0, totalMiss - bucketed);

  pts += miss0 * LEAGUE_SCORING.kicking.fg_miss_0_19;
  pts += miss20 * LEAGUE_SCORING.kicking.fg_miss_20_29;
  pts += miss30 * LEAGUE_SCORING.kicking.fg_miss_30_39;
  pts += miss40 * LEAGUE_SCORING.kicking.fg_miss_40_49;
  pts += remaining * LEAGUE_SCORING.kicking.fg_miss_base;

  // Misc
  const fumLost =
    clampInt(row.rushing_fumbles_lost) +
    clampInt(row.receiving_fumbles_lost) +
    clampInt(row.sack_fumbles_lost);

  pts += fumLost * LEAGUE_SCORING.misc.fumble_lost;

  const frTd = clampInt(row.fumble_recovery_tds);
  pts += frTd * LEAGUE_SCORING.misc.fumble_recovery_td;

  const stTd = clampInt(row.special_teams_tds);
  pts += stTd * LEAGUE_SCORING.misc.special_teams_td;

  return Number.isFinite(pts) ? pts : 0;
}

// ------------------------------
// Utilities
// ------------------------------
async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`API request failed: ${response.status} for ${url}`);
  return response.json();
}

async function tryFetchFirst(urls = []) {
  for (const url of urls) {
    try {
      const data = await fetchJson(url);
      if (data && (Array.isArray(data) ? data.length > 0 : Object.keys(data).length > 0)) return data;
    } catch (_) {}
  }
  return null;
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
  let num = 0,
    den = 0;
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

function normPos(pos) {
  return String(pos || "").toUpperCase().trim();
}

function normName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\./g, " ")
    .replace(/'/g, "")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .trim();
}

function lastInit(name) {
  const n = normName(name);
  if (!n) return { last: "", init: "" };
  const parts = n.split(" ").filter(Boolean);
  const init = parts[0]?.[0] || "";
  const last = parts[parts.length - 1] || "";
  return { last, init };
}

function s(obj, key) {
  const v = obj?.[key];
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ------------------------------
// Load raw stats (nflreadpy output)
// ------------------------------
async function loadRawStatsOnce() {
  if (rawStats.loaded) return;

  try {
    const payload = await fetchJson(RAW_STATS_PATH);

    const weeks = payload?.weeks && typeof payload.weeks === "object" ? payload.weeks : {};
    rawStats.weeks = weeks;

    rawStats.season = Number(payload?.season) || null;

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
    rawStats.loaded = true;
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

function buildRawIndexOnce() {
  if (rawIndexBuilt) return;
  rawIndexBuilt = true;

  const weeksObj = rawStats.weeks || {};
  const maxWeek = Number(rawStats.maxWeek || 0);
  if (!maxWeek) return;

  const candidateWeeks = [String(maxWeek)];
  for (let w = maxWeek - 1; w >= 1 && w >= maxWeek - 3; w -= 1) candidateWeeks.push(String(w));

  for (const wk of candidateWeeks) {
    const weekMap = weeksObj[wk];
    if (!weekMap || typeof weekMap !== "object") continue;

    for (const [gsis, row] of Object.entries(weekMap)) {
      const display = row?.player_display_name || row?.player_name || "";
      const team = String(row?.team || "").toUpperCase();
      const pos = normPos(row?.position || "");
      const n = normName(display);

      if (n && team && pos) rawIndex.byNameTeamPos.set(`${n}|${team}|${pos}`, gsis);
      if (n && pos) rawIndex.byNamePos.set(`${n}|${pos}`, gsis);

      const rawShort = String(row?.player_name || ""); // ex: A.Rodgers
      const shortInit = (rawShort.split(".")[0] || "").toLowerCase();
      const shortLastRaw = rawShort.includes(".") ? rawShort.split(".").slice(1).join(".") : "";
      const shortLast = String(shortLastRaw || lastInit(display).last)
        .toLowerCase()
        .replace(/[^a-z]/g, "");

      const init = (shortInit || lastInit(display).init).toLowerCase();
      if (shortLast && init && team) rawIndex.byLastInitTeam.set(`${shortLast}|${init}|${team}`, gsis);
    }
  }
}

function resolveGsisIdForSleeperPlayer(player) {
  if (!player) return "";

  if (player.gsis_id) return String(player.gsis_id);

  const sleeperPid = String(player.player_id || "");
  if (sleeperPid && gsisFallbackCacheBySleeperId[sleeperPid]) {
    return gsisFallbackCacheBySleeperId[sleeperPid];
  }

  if (!rawStats.loaded || !rawStats.maxWeek) return "";

  buildRawIndexOnce();

  const team = String(player.team || "").toUpperCase();
  const pos = normPos(player.position || "");
  const full = player.full_name || `${player.first_name || ""} ${player.last_name || ""}`.trim();
  const n = normName(full);

  let gsis = "";
  if (n && team && pos) gsis = rawIndex.byNameTeamPos.get(`${n}|${team}|${pos}`) || "";
  if (!gsis && n && pos) gsis = rawIndex.byNamePos.get(`${n}|${pos}`) || "";

  if (!gsis) {
    const li = lastInit(full);
    const last = li.last.replace(/[^a-z]/g, "");
    const init = li.init.toLowerCase();
    if (last && init && team) gsis = rawIndex.byLastInitTeam.get(`${last}|${init}|${team}`) || "";
  }

  if (gsis && sleeperPid) gsisFallbackCacheBySleeperId[sleeperPid] = gsis;
  return gsis;
}

// ------------------------------
// Step 1: NFL state
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
// Step 3: League context
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
  if (!userRoster) throw new Error(`Roster not found for user ${USER_USERNAME} in league ${LEAGUE_ID}.`);

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

function getRosterById(rosterId) {
  return leagueContext.rosters?.find((r) => r && r.roster_id === rosterId) || null;
}

function getUserByRoster(roster) {
  if (!roster) return null;
  return leagueContext.users?.find((u) => u && u.user_id === roster.owner_id) || null;
}

function getDisplayNameForRosterId(rosterId) {
  const roster = getRosterById(rosterId);
  const user = getUserByRoster(roster);
  return roster?.metadata?.team_name || user?.display_name || `Roster ${rosterId}`;
}

function buildMatchupLabel(rosterIdA, rosterIdB) {
  const aName = getDisplayNameForRosterId(rosterIdA);
  const bName = getDisplayNameForRosterId(rosterIdB);

  const aRoster = getRosterById(rosterIdA);
  const bRoster = getRosterById(rosterIdB);

  const aWins = aRoster?.settings?.wins ?? 0;
  const aLoss = aRoster?.settings?.losses ?? 0;
  const aTies = aRoster?.settings?.ties ?? 0;
  const bWins = bRoster?.settings?.wins ?? 0;
  const bLoss = bRoster?.settings?.losses ?? 0;
  const bTies = bRoster?.settings?.ties ?? 0;

  const aRec = `${aWins}-${aLoss}${aTies > 0 ? "-" + aTies : ""}`;
  const bRec = `${bWins}-${bLoss}${bTies > 0 ? "-" + bTies : ""}`;

  return `${aName} (${aRec}) vs ${bName} (${bRec})`;
}

function ensureMatchupSelectorWiredOnce() {
  const sel = document.getElementById("matchup-select");
  if (!sel || sel.__wired) return;
  sel.__wired = true;

  sel.addEventListener("change", async (e) => {
    const val = String(e.target.value || "");
    selectedMatchupId = val ? Number(val) : null;
    try {
      await fetchAndRenderData();
    } catch (err) {
      console.error("Matchup change render error:", err);
    }
  });
}

function renderMatchupSelector() {
  const sel = document.getElementById("matchup-select");
  const wrap = document.getElementById("matchup-select-wrap");
  if (!sel || !wrap) return;

  const entries = Object.values(matchupIndexById || {}).sort((a, b) => a.matchupId - b.matchupId);
  if (!entries.length) {
    wrap.classList.add("hidden");
    return;
  }

  wrap.classList.remove("hidden");

  const desired = Number.isFinite(Number(selectedMatchupId))
    ? Number(selectedMatchupId)
    : Number(leagueContext.matchupId);

  sel.innerHTML = entries
    .map((m) => {
      const selected = m.matchupId === desired ? "selected" : "";
      return `<option value="${m.matchupId}" ${selected}>${escapeHtml(m.label)}</option>`;
    })
    .join("");

  selectedMatchupId = desired;
  ensureMatchupSelectorWiredOnce();
}

async function fetchDynamicData(week, season) {
  const matchupUrl = `${API_BASE}/league/${LEAGUE_ID}/matchups/${week}`;

  const projectionsUrl =
    `https://api.sleeper.app/projections/nfl/${season}/${week}` +
    `?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&position[]=FLEX`;

  const [matchups, projectionsRaw] = await Promise.all([
    fetchJson(matchupUrl),
    tryFetchFirst([projectionsUrl]).catch(() => null),
  ]);

  const projections = normalizeProjectionsToMap(projectionsRaw || {});
  window.__latestProjections = projections;

  if (!Array.isArray(matchups) || matchups.length === 0) {
    return { matchupTeams: [], projections, allMatchups: [] };
  }

  // Group all matchups by matchup_id
  const groups = new Map(); // matchup_id -> []
  for (const m of matchups) {
    if (!m || m.matchup_id === null || m.matchup_id === undefined) continue;
    const id = String(m.matchup_id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(m);
  }

  // Try to read selected matchup id from dropdown (if present)
  const sel = document.getElementById("matchup-select");
  const selectedId = sel && sel.value ? String(sel.value) : "";

  let chosenId = "";

  // 1) user-selected matchup id
  if (selectedId && groups.has(selectedId)) {
    chosenId = selectedId;
  } else {
    // 2) matchup containing the user's roster
    const userRow = matchups.find((m) => m && m.roster_id === leagueContext.userRosterId);
    if (userRow && userRow.matchup_id !== undefined && userRow.matchup_id !== null) {
      const id = String(userRow.matchup_id);
      if (groups.has(id)) chosenId = id;
    }

    // 3) fallback to first group
    if (!chosenId) {
      const firstKey = groups.keys().next().value;
      if (firstKey) chosenId = String(firstKey);
    }
  }

  const currentMatchupTeams = chosenId && groups.has(chosenId) ? groups.get(chosenId) : [];

  // Keep for rendering + dropdown sync
  leagueContext.matchupId = chosenId ? Number(chosenId) : null;

  // Sort stable
  currentMatchupTeams.sort((a, b) => (a.roster_id || 0) - (b.roster_id || 0));

  return { matchupTeams: currentMatchupTeams, projections, allMatchups: matchups };
}

// ------------------------------
// Merge + Render
// ------------------------------
function mergeAndRenderData(data) {
  if (!data || !Array.isArray(data.matchupTeams) || data.matchupTeams.length < 2) {
    console.error("Invalid matchupTeams:", data?.matchupTeams);
    return;
  }

  const { matchupTeams, projections } = data;

  const [teamA, teamB] = matchupTeams;
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

  renderMatchupSelector();

  const scoreboardEl = document.getElementById("scoreboard");
  if (scoreboardEl) scoreboardEl.classList.remove("hidden");
  const loadingEl = document.getElementById("loading");
  if (loadingEl) loadingEl.classList.add("hidden");

  lastUpdatedTime = new Date();
  const lastUpdatedEl = document.getElementById("last-updated");
  if (lastUpdatedEl) lastUpdatedEl.textContent = lastUpdatedTime.toLocaleTimeString();
}

// ------------------------------
// Starters list rendering
// ------------------------------
function getOpponentTextForTeam(teamAbbrev) {
  const entry = scheduleByTeam?.[teamAbbrev];
  if (!entry) return "N/A";
  const ha = entry.homeAway || "vs";
  const opp = entry.opp || "";
  const status = entry.gameStatus ? ` • ${entry.gameStatus}` : "";
  return `${ha} ${opp}${status}`.trim();
}

function getHeadshotUrlForSleeperPlayer(playerObj) {
  if (!playerObj) return "";
  const gsis = resolveGsisIdForSleeperPlayer(playerObj);
  if (!gsis || !rawStats.loaded || !rawStats.maxWeek) return "";

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

    let headshot = "";
    if (!isTeamDef && player) headshot = getHeadshotUrlForSleeperPlayer(player);

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
// Player modal
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
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closePlayerModal();
  });
  document.addEventListener("keydown", (e) => {
    if (!modalIsOpen) return;
    if (e.key === "Escape") closePlayerModal();
  });
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

function buildRecentAndExpectedTable(rows, expectedRowForScoring) {
  const rowToHtml = (r) => {
    const pts = computeLeaguePointsFromRaw(r);
    return `
      <tr>
        <td>${escapeHtml(String(r.week ?? ""))}</td>
        <td>${escapeHtml(formatStatValue(pts))}</td>
        <td>${escapeHtml(formatStatValue(r.carries))}-${escapeHtml(formatStatValue(r.rushing_yards))} (${escapeHtml(formatStatValue(r.rushing_tds))} TD)</td>
        <td>${escapeHtml(formatStatValue(r.receptions))}/${escapeHtml(formatStatValue(r.targets))}-${escapeHtml(formatStatValue(r.receiving_yards))} (${escapeHtml(formatStatValue(r.receiving_tds))} TD)</td>
        <td>${escapeHtml(formatStatValue(r.passing_yards))} (${escapeHtml(formatStatValue(r.passing_tds))} TD, ${escapeHtml(formatStatValue(r.passing_interceptions))} INT)</td>
      </tr>
    `;
  };

  const expectedPts = computeLeaguePointsFromRaw(expectedRowForScoring);

  return `
    <table class="player-table" aria-label="Recent stats + expected">
      <thead>
        <tr>
          <th>Week</th>
          <th>League Pts</th>
          <th>Rush</th>
          <th>Rec/Tgt</th>
          <th>Pass</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(rowToHtml).join("")}
        <tr>
          <td><strong>Expected</strong></td>
          <td><strong>${escapeHtml(formatStatValue(expectedPts))}</strong></td>
          <td><strong>${escapeHtml(formatStatValue(expectedRowForScoring.carries))}-${escapeHtml(formatStatValue(expectedRowForScoring.rushing_yards))} (${escapeHtml(formatStatValue(expectedRowForScoring.rushing_tds))} TD)</strong></td>
          <td><strong>${escapeHtml(formatStatValue(expectedRowForScoring.receptions))}/${escapeHtml(formatStatValue(expectedRowForScoring.targets))}-${escapeHtml(formatStatValue(expectedRowForScoring.receiving_yards))} (${escapeHtml(formatStatValue(expectedRowForScoring.receiving_tds))} TD)</strong></td>
          <td><strong>${escapeHtml(formatStatValue(expectedRowForScoring.passing_yards))} (${escapeHtml(formatStatValue(expectedRowForScoring.passing_tds))} TD, ${escapeHtml(formatStatValue(expectedRowForScoring.passing_interceptions))} INT)</strong></td>
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

  const gsis = resolveGsisIdForSleeperPlayer(player);
  const maxWeek = Number(rawStats.maxWeek || 0);

  if (!gsis || !maxWeek) {
    renderPlayerModalContent({
      title: name,
      subtitle: `${team ? team + " • " : ""}${position || ""}`.trim(),
      actionsHtml: actions,
      bodyHtml: `<div class="player-muted">Raw stats unavailable (no GSIS match found).</div>`,
    });
    return;
  }

  const currentWeek = Number(DISPLAY_WEEK);
  const weeksToFetch = getLastNWeeksCompleted(currentWeek, 6, maxWeek);

  const rows = [];
  for (const w of weeksToFetch) {
    const row = getRawStatRowByGsis(w, gsis);
    if (row) rows.push(row);
  }

  if (!rows.length) {
    renderPlayerModalContent({
      title: name,
      subtitle: `${team ? team + " • " : ""}${position || ""}`.trim(),
      actionsHtml: actions,
      bodyHtml: `<div class="player-muted">No raw stats found for this player in the last ${escapeHtml(String(weeksToFetch.length))} completed weeks.</div>`,
    });
    return;
  }

  // Weighted expected row (fields needed by scoring + display)
  const weights = rows.map((_, i) => i + 1);
  const wAvg = (key) => weightedAvg(rows.map((r, i) => ({ v: s(r, key), w: weights[i] })));

  const expectedRow = {
    week: "Expected",
    // passing
    passing_yards: wAvg("passing_yards"),
    passing_tds: wAvg("passing_tds"),
    passing_interceptions: wAvg("passing_interceptions"),
    passing_2pt_conversions: wAvg("passing_2pt_conversions"),
    // rushing
    carries: wAvg("carries"),
    rushing_yards: wAvg("rushing_yards"),
    rushing_tds: wAvg("rushing_tds"),
    rushing_2pt_conversions: wAvg("rushing_2pt_conversions"),
    rushing_fumbles_lost: wAvg("rushing_fumbles_lost"),
    // receiving
    receptions: wAvg("receptions"),
    targets: wAvg("targets"),
    receiving_yards: wAvg("receiving_yards"),
    receiving_tds: wAvg("receiving_tds"),
    receiving_2pt_conversions: wAvg("receiving_2pt_conversions"),
    receiving_fumbles_lost: wAvg("receiving_fumbles_lost"),
    // kicking
    fg_made: wAvg("fg_made"),
    fg_made_0_19: wAvg("fg_made_0_19"),
    fg_made_20_29: wAvg("fg_made_20_29"),
    fg_made_30_39: wAvg("fg_made_30_39"),
    fg_made_40_49: wAvg("fg_made_40_49"),
    fg_missed: wAvg("fg_missed"),
    fg_missed_0_19: wAvg("fg_missed_0_19"),
    fg_missed_20_29: wAvg("fg_missed_20_29"),
    fg_missed_30_39: wAvg("fg_missed_30_39"),
    fg_missed_40_49: wAvg("fg_missed_40_49"),
    pat_made: wAvg("pat_made"),
    pat_missed: wAvg("pat_missed"),
    // misc
    sack_fumbles_lost: wAvg("sack_fumbles_lost"),
    fumble_recovery_tds: wAvg("fumble_recovery_tds"),
    special_teams_tds: wAvg("special_teams_tds"),
  };

  let headshot = "";
  for (let w = maxWeek; w >= 1; w -= 1) {
    const r = getRawStatRowByGsis(w, gsis);
    if (r?.headshot_url) {
      headshot = String(r.headshot_url);
      break;
    }
  }

  const headshotHtml = headshot
    ? `<div style="display:flex;gap:14px;align-items:center;margin-top:6px;margin-bottom:8px;">
         <img class="player-headshot" src="${escapeHtml(headshot)}" alt="${escapeHtml(name)} headshot" />
         <div class="player-muted">League scoring applied (yardage bonuses included).</div>
       </div>`
    : `<div class="player-muted" style="margin-top:6px;margin-bottom:8px;">League scoring applied (yardage bonuses included).</div>`;

  const table = buildRecentAndExpectedTable(rows, expectedRow);

  renderPlayerModalContent({
    title: name,
    subtitle: `${team ? team + " • " : ""}${position || ""}`.trim(),
    actionsHtml: actions,
    bodyHtml: `${headshotHtml}${table}
      <div class="player-muted" style="margin-top:8px;">
        Notes: 40+/50+ TD distance bonuses require play-level data and are not computed from weekly totals. Team Defense scoring not computed here.
      </div>`,
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

    // Load raw stats early so headshots + GSIS fallback work without first modal open
    loadRawStatsOnce().catch(() => null);

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
