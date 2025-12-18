// --- Global Configuration ---
const LEAGUE_ID = "1262418074540195841";
const USER_USERNAME = "conner27lax";
const UPDATE_INTERVAL_MS = 30000; // 30 seconds
const DISPLAY_WEEK = 16;          // Force the app to always display this week
const RAW_STATS_URL = "data/player-stats-raw.json"; // Your raw stats file (array of rows)

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

let scheduleByTeam = {}; // { TEAM: { opp, homeAway, gameStatus, start } }
let updateTimer = null;
let lastUpdatedTime = null;

// --- Raw Stats (from data/player-stats-raw.json) ---
// We normalize your raw file into:
// rawStats = { season, maxWeek, byWeek: { [week]: { [gsis]: row } }, headshotByGsis: { [gsis]: url } }
let rawStats = null;
let rawStatsLoadPromise = null;

// Modal state
let modalIsOpen = false;
let modalLastFocusedEl = null;

// Manual “news” overrides (key: Sleeper player_id string)
const NEWS_OVERRIDES = {
  // "96": { mult: 1.30, note: "Expected to start (+30%)" },
};

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

function getEl(id) {
  return document.getElementById(id);
}

function safeText(v) {
  return v === undefined || v === null ? "" : String(v);
}

function buildEspnPlayerUrl(playerObj) {
  const espnId = playerObj?.espn_id ?? playerObj?.espnId;
  if (!espnId) return "";
  return `https://www.espn.com/nfl/player/_/id/${encodeURIComponent(String(espnId))}`;
}

function formatStatValue(v) {
  if (v === undefined || v === null) return "—";
  const n = Number(v);
  if (Number.isFinite(n)) return Math.abs(n % 1) < 1e-9 ? String(n) : n.toFixed(2);
  return String(v);
}

function weightedAvg(values) {
  let num = 0, den = 0;
  for (const { v, w } of values) {
    if (!Number.isFinite(v) || !Number.isFinite(w)) continue;
    num += v * w;
    den += w;
  }
  return den > 0 ? num / den : 0;
}

function getNewsMultiplierAndNote(sleeperPlayerId, sleeperPlayerObj) {
  const pid = String(sleeperPlayerId ?? sleeperPlayerObj?.player_id ?? "");
  const override = NEWS_OVERRIDES[pid];
  if (override && Number.isFinite(Number(override.mult))) {
    return { mult: Number(override.mult), note: String(override.note || "Manual adjustment") };
  }

  const injury = String(sleeperPlayerObj?.injury_status || "").toLowerCase();
  const practice = String(sleeperPlayerObj?.practice_participation || "").toLowerCase();
  const status = String(sleeperPlayerObj?.status || "").toLowerCase();

  if (status === "inactive" || injury === "out") return { mult: 0.0, note: "Out" };
  if (injury === "doubtful") return { mult: 0.40, note: "Doubtful (-60%)" };
  if (injury === "questionable") return { mult: 0.85, note: "Questionable (-15%)" };
  if (practice === "dnp" || practice === "did_not_participate") return { mult: 0.80, note: "DNP practice (-20%)" };
  if (practice === "limited") return { mult: 0.90, note: "Limited practice (-10%)" };

  return { mult: 1.0, note: "" };
}

// ------------------------------
// Raw stats loader + normalizer
// Supports:
// 1) Array of rows (what you showed)
// 2) Object with rows under common keys
// ------------------------------
function extractRowsFromRawFile(payload) {
  if (Array.isArray(payload)) return payload;

  // Common wrappers
  const candidates = [
    payload?.rows,
    payload?.data,
    payload?.player_stats,
    payload?.playerStats,
    payload?.stats,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }

  // If it already has byWeek/weeks, treat as empty rows
  return [];
}

function normalizeRawStats(rows) {
  const byWeek = {}; // week -> gsis -> row
  const headshotByGsis = {};
  let season = null;
  let maxWeek = 0;

  for (const r of rows) {
    const gsis = safeText(r?.player_id || r?.gsis_id || "");
    const week = Number(r?.week);
    const s = Number(r?.season);

    if (!gsis || !Number.isFinite(week) || week <= 0) continue;

    if (!byWeek[String(week)]) byWeek[String(week)] = {};
    byWeek[String(week)][gsis] = r;

    if (Number.isFinite(s) && !season) season = s;
    if (week > maxWeek) maxWeek = week;

    const hs = safeText(r?.headshot_url || r?.headshot || "");
    if (hs && hs.startsWith("http")) {
      headshotByGsis[gsis] = hs; // later rows overwrite earlier (fine)
    }
  }

  return {
    season: season || null,
    maxWeek,
    byWeek,
    headshotByGsis,
  };
}

async function loadRawStatsOnce() {
  if (rawStats) return rawStats;
  if (rawStatsLoadPromise) return rawStatsLoadPromise;

  rawStatsLoadPromise = (async () => {
    const payload = await fetchJson(RAW_STATS_URL);
    const rows = extractRowsFromRawFile(payload);
    rawStats = normalizeRawStats(rows);
    return rawStats;
  })();

  return rawStatsLoadPromise;
}

function headshotUrlFromRawByGsis(gsis) {
  const id = safeText(gsis);
  if (!rawStats || !id) return "";
  const hs = rawStats.headshotByGsis?.[id] || "";
  return typeof hs === "string" ? hs : "";
}

function headshotUrlFromSleeperPlayer(sleeperPlayerObj) {
  return headshotUrlFromRawByGsis(sleeperPlayerObj?.gsis_id);
}

function getLastNCompletedWeeks(displayWeek, rawMaxWeek, n) {
  const lastCompleted = Math.max(0, Math.min(Number(displayWeek) - 1, Number(rawMaxWeek || 0)));
  const start = Math.max(1, lastCompleted - n + 1);
  const weeks = [];
  for (let w = start; w <= lastCompleted; w++) weeks.push(w);
  return weeks;
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

  if (!Array.isArray(matchups) || matchups.length === 0) return { matchupTeams: [], projections };

  const userTeamMatchup = matchups.find((m) => m && m.roster_id === leagueContext.userRosterId);
  if (!userTeamMatchup) throw new Error(`Matchup data for roster_id ${leagueContext.userRosterId} not found in week ${week}.`);

  leagueContext.matchupId = userTeamMatchup.matchup_id;

  const currentMatchupTeams = matchups
    .filter((m) => m && m.matchup_id === leagueContext.matchupId)
    .sort((a, b) => a.roster_id - b.roster_id);

  return { matchupTeams: currentMatchupTeams, projections };
}

// ------------------------------
// Step 6: Merge + Render (Sleeper)
// ------------------------------
function mergeAndRenderData(data) {
  if (!data || !Array.isArray(data.matchupTeams)) return;

  const { matchupTeams, projections } = data;

  const teamA = matchupTeams.find((t) => t && t.roster_id === leagueContext.userRosterId);
  const teamB = matchupTeams.find((t) => t && t.roster_id !== leagueContext.userRosterId);
  if (!teamA || !teamB) return;

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

  const teamADetails = getTeamDetails(teamA);
  const teamBDetails = getTeamDetails(teamB);

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

  const scoreboardEl = getEl("scoreboard");
  if (scoreboardEl) scoreboardEl.classList.remove("hidden");
  const loadingEl = getEl("loading");
  if (loadingEl) loadingEl.classList.add("hidden");

  lastUpdatedTime = new Date();
  const lastUpdatedEl = getEl("last-updated");
  if (lastUpdatedEl) lastUpdatedEl.textContent = lastUpdatedTime.toLocaleTimeString();
}

// ------------------------------
// Opponent text
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

// ------------------------------
// Modal helpers
// ------------------------------
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

  if (titleEl) titleEl.textContent = title || "";
  if (subEl) subEl.textContent = subtitle || "";
  if (actionsEl) actionsEl.innerHTML = actionsHtml || "";
  if (bodyEl) bodyEl.innerHTML = bodyHtml || "";
}

async function showPlayerDetailsModal(sleeperPlayerId) {
  wirePlayerModalEventsOnce();

  const sleeperPlayer =
    playerCache[String(sleeperPlayerId)] ||
    playerCache[Number(sleeperPlayerId)] ||
    null;

  if (!sleeperPlayer) return;

  const name = safeText(
    sleeperPlayer?.full_name ||
    (sleeperPlayer?.first_name ? `${sleeperPlayer.first_name} ${sleeperPlayer.last_name}` : "Player")
  );
  const position = safeText(sleeperPlayer?.position || "").toUpperCase();
  const team = safeText(sleeperPlayer?.team || "");

  const espnUrl = buildEspnPlayerUrl(sleeperPlayer);
  const actions = espnUrl
    ? `<a href="${espnUrl}" target="_blank" rel="noopener noreferrer">Open ESPN player page</a>`
    : `<span class="player-muted">ESPN link unavailable</span>`;

  renderPlayerModalContent({
    title: name,
    subtitle: `${team ? team + " • " : ""}${position}`.trim(),
    actionsHtml: actions,
    bodyHtml: `<div class="player-muted">Loading stats…</div>`,
  });
  openPlayerModal();

  const gsis = safeText(sleeperPlayer?.gsis_id || "");
  if (!gsis) {
    renderPlayerModalContent({
      title: name,
      subtitle: `${team ? team + " • " : ""}${position}`.trim(),
      actionsHtml: actions,
      bodyHtml: `<div class="player-muted">No GSIS id for this player in Sleeper. Raw stats join not possible.</div>`,
    });
    return;
  }

  let rsBundle;
  try {
    rsBundle = await loadRawStatsOnce();
  } catch (e) {
    renderPlayerModalContent({
      title: name,
      subtitle: `${team ? team + " • " : ""}${position}`.trim(),
      actionsHtml: actions,
      bodyHtml: `<div class="player-muted">Failed to load ${escapeHtml(RAW_STATS_URL)}.</div>`,
    });
    return;
  }

  const headshotUrl = headshotUrlFromSleeperPlayer(sleeperPlayer);
  const weeks = getLastNCompletedWeeks(DISPLAY_WEEK, rsBundle.maxWeek, 6);

  const rows = weeks.map((w) => {
    const row = rsBundle.byWeek?.[String(w)]?.[gsis] || null;
    const has = !!row;

    return {
      week: w,
      has,
      ppr: has ? Number(row?.fantasy_points_ppr) : NaN,
      pass_yd: has ? Number(row?.passing_yards) : NaN,
      pass_td: has ? Number(row?.passing_tds) : NaN,
      pass_int: has ? Number(row?.passing_interceptions) : NaN,
      rush_att: has ? Number(row?.carries) : NaN,
      rush_yd: has ? Number(row?.rushing_yards) : NaN,
      rush_td: has ? Number(row?.rushing_tds) : NaN,
      rec: has ? Number(row?.receptions) : NaN,
      tgt: has ? Number(row?.targets) : NaN,
      rec_yd: has ? Number(row?.receiving_yards) : NaN,
      rec_td: has ? Number(row?.receiving_tds) : NaN,
    };
  });

  const valid = rows.filter((r) => r.has);
  if (!valid.length) {
    renderPlayerModalContent({
      title: name,
      subtitle: `${team ? team + " • " : ""}${position}`.trim(),
      actionsHtml: actions,
      bodyHtml: `<div class="player-muted">No raw stats found for this player in weeks ${weeks[0]}–${weeks[weeks.length - 1]}.</div>`,
    });
    return;
  }

  const wAvg = (key) => weightedAvg(valid.map((r, i) => ({ v: Number.isFinite(r[key]) ? r[key] : 0, w: i + 1 })));

  const expectedRaw = {
    ppr: wAvg("ppr"),
    pass_yd: wAvg("pass_yd"),
    pass_td: wAvg("pass_td"),
    pass_int: wAvg("pass_int"),
    rush_att: wAvg("rush_att"),
    rush_yd: wAvg("rush_yd"),
    rush_td: wAvg("rush_td"),
    rec: wAvg("rec"),
    tgt: wAvg("tgt"),
    rec_yd: wAvg("rec_yd"),
    rec_td: wAvg("rec_td"),
  };

  const { mult, note } = getNewsMultiplierAndNote(sleeperPlayerId, sleeperPlayer);
  const expectedAdj = {};
  for (const [k, v] of Object.entries(expectedRaw)) expectedAdj[k] = Number(v) * mult;

  const headshotHtml = headshotUrl
    ? `<img class="player-headshot" src="${escapeHtml(headshotUrl)}" width="120" height="120" alt="${escapeHtml(name)} headshot" style="width:120px;height:120px;object-fit:cover;border-radius:999px;margin-bottom:12px;">`
    : "";

  const statTable = `
    ${headshotHtml}
    <table class="player-table" aria-label="Recent stats + expected">
      <thead>
        <tr>
          <th>Week</th>
          <th>PPR</th>
          <th>Pass</th>
          <th>Rush</th>
          <th>Rec/Tgt</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td>${r.week}</td>
            <td>${r.has ? escapeHtml(formatStatValue(r.ppr)) : "—"}</td>
            <td>${r.has ? `${escapeHtml(formatStatValue(r.pass_yd))} yd • ${escapeHtml(formatStatValue(r.pass_td))} TD • ${escapeHtml(formatStatValue(r.pass_int))} INT` : "—"}</td>
            <td>${r.has ? `${escapeHtml(formatStatValue(r.rush_att))} att • ${escapeHtml(formatStatValue(r.rush_yd))} yd • ${escapeHtml(formatStatValue(r.rush_td))} TD` : "—"}</td>
            <td>${r.has ? `${escapeHtml(formatStatValue(r.rec))}/${escapeHtml(formatStatValue(r.tgt))} • ${escapeHtml(formatStatValue(r.rec_yd))} yd • ${escapeHtml(formatStatValue(r.rec_td))} TD` : "—"}</td>
          </tr>
        `).join("")}

        <tr>
          <td><strong>Expected</strong></td>
          <td><strong>${escapeHtml(formatStatValue(expectedRaw.ppr))}</strong></td>
          <td><strong>${escapeHtml(formatStatValue(expectedRaw.pass_yd))} yd • ${escapeHtml(formatStatValue(expectedRaw.pass_td))} TD • ${escapeHtml(formatStatValue(expectedRaw.pass_int))} INT</strong></td>
          <td><strong>${escapeHtml(formatStatValue(expectedRaw.rush_att))} att • ${escapeHtml(formatStatValue(expectedRaw.rush_yd))} yd • ${escapeHtml(formatStatValue(expectedRaw.rush_td))} TD</strong></td>
          <td><strong>${escapeHtml(formatStatValue(expectedRaw.rec))}/${escapeHtml(formatStatValue(expectedRaw.tgt))} • ${escapeHtml(formatStatValue(expectedRaw.rec_yd))} yd • ${escapeHtml(formatStatValue(expectedRaw.rec_td))} TD</strong></td>
        </tr>

        <tr>
          <td><strong>Expected*</strong></td>
          <td><strong>${escapeHtml(formatStatValue(expectedAdj.ppr))}</strong></td>
          <td><strong>${escapeHtml(formatStatValue(expectedAdj.pass_yd))} yd • ${escapeHtml(formatStatValue(expectedAdj.pass_td))} TD • ${escapeHtml(formatStatValue(expectedAdj.pass_int))} INT</strong></td>
          <td><strong>${escapeHtml(formatStatValue(expectedAdj.rush_att))} att • ${escapeHtml(formatStatValue(expectedAdj.rush_yd))} yd • ${escapeHtml(formatStatValue(expectedAdj.rush_td))} TD</strong></td>
          <td><strong>${escapeHtml(formatStatValue(expectedAdj.rec))}/${escapeHtml(formatStatValue(expectedAdj.tgt))} • ${escapeHtml(formatStatValue(expectedAdj.rec_yd))} yd • ${escapeHtml(formatStatValue(expectedAdj.rec_td))} TD</strong></td>
        </tr>
      </tbody>
    </table>
    ${note ? `<div class="player-muted" style="margin-top:10px;">* Adjusted: ${escapeHtml(note)}</div>` : ""}
    <div class="player-muted" style="margin-top:6px;">Source: ${escapeHtml(RAW_STATS_URL)} (GSIS ${escapeHtml(gsis)}).</div>
  `;

  renderPlayerModalContent({
    title: name,
    subtitle: `${team ? team + " • " : ""}${position}`.trim(),
    actionsHtml: actions,
    bodyHtml: statTable,
  });
}

// ------------------------------
// Starters list rendering (Sleeper)
// Ensures headshots cannot blow up: explicit width/height + inline style.
// ------------------------------
function renderStarters(starterIds = [], containerId, playersPoints = {}, projections = {}) {
  const container = getEl(containerId);
  if (!container) return;

  container.innerHTML = "";
  if (!Array.isArray(starterIds)) return;

  starterIds.forEach((starterTokenRaw) => {
    const starterToken = String(starterTokenRaw);

    // Team DEF token like "PHI"
    const isTeamDefToken = /^[A-Z]{2,4}$/.test(starterToken) && !playerCache[starterToken];

    const sleeperPlayer = playerCache[starterToken] || playerCache[Number(starterToken)] || null;

    const position = isTeamDefToken ? "DEF" : (sleeperPlayer?.position || "N/A");
    const name = isTeamDefToken
      ? `${starterToken} Defense`
      : (sleeperPlayer?.full_name || (sleeperPlayer?.first_name ? `${sleeperPlayer.first_name} ${sleeperPlayer.last_name}` : "Unknown Player"));

    const teamShort = isTeamDefToken ? starterToken : (sleeperPlayer?.team || "");
    const actualScore = Number(playersPoints?.[starterToken] ?? 0);

    const projObj = projections?.[starterToken] || projections?.[Number(starterToken)] || null;
    const projScore = getProjectedPoints(projObj);

    const oppText = teamShort ? getOpponentTextForTeam(teamShort) : "N/A";

    const headshotUrl = (!isTeamDefToken && sleeperPlayer) ? headshotUrlFromSleeperPlayer(sleeperPlayer) : "";

    const card = document.createElement("div");
    card.className = "player-card";

    if (!isTeamDefToken) {
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");

      const open = () => showPlayerDetailsModal(starterToken).catch((e) => console.error("Player modal error:", e));
      card.addEventListener("click", open);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
    } else {
      card.style.cursor = "default";
    }

    // Critical: headshot uses fixed size inline to prevent massive rendering even if CSS is missing.
    const headshotHtml = headshotUrl
      ? `<img class="player-headshot" src="${escapeHtml(headshotUrl)}" alt="${escapeHtml(name)} headshot"
              width="42" height="42"
              style="width:42px;height:42px;object-fit:cover;border-radius:999px;flex:0 0 auto;" />`
      : "";

    card.innerHTML = `
      ${headshotHtml}
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
  const countdownElement = getEl("countdown");

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

    // Preload raw stats so headshots are available immediately.
    loadRawStatsOnce()
      .then(() => fetchAndRenderData().catch(() => {}))
      .catch((e) => console.warn("Raw stats preload failed:", e));

    await fetchAndRenderData();
    startLiveUpdate();
  } catch (error) {
    const loadingEl = getEl("loading");
    if (loadingEl) loadingEl.textContent = `Error: ${error.message}. Check LEAGUE_ID / USER_USERNAME.`;
    console.error("Initialization Failed:", error);
  }
}

// Kick off the application
initializeApp();
