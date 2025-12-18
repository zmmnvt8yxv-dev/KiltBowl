// --- Global Configuration ---
const LEAGUE_ID = "1262418074540195841";
const USER_USERNAME = "conner27lax";
const UPDATE_INTERVAL_MS = 30000; // 30 seconds
const DISPLAY_WEEK = 16;          // force display week
const RAW_STATS_URL = "data/player-stats-raw.json"; // static file in /data

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

// Raw weekly stats cache (from /data/player-stats-raw.json)
let rawStatsBundle = null; // { season, weeks: { "1": { "00-00xxxxx": {...} } } }
let rawStatsLoadPromise = null;

// Modal state
let modalIsOpen = false;
let modalLastFocusedEl = null;

// Manual “news” overrides you can edit anytime (multiplier + note)
// Keys should be Sleeper player_id (string).
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
// Raw stats loader (static JSON)
// ------------------------------
async function loadRawStatsOnce() {
  if (rawStatsBundle) return rawStatsBundle;
  if (rawStatsLoadPromise) return rawStatsLoadPromise;

  rawStatsLoadPromise = (async () => {
    const data = await fetchJson(RAW_STATS_URL);
    rawStatsBundle = data || null;
    return rawStatsBundle;
  })();

  return rawStatsLoadPromise;
}

function getRawMaxWeek(bundle) {
  const v =
    Number(bundle?.data_max_week_in_file) ||
    Number(bundle?.last_completed_week) ||
    Number(bundle?.last_completed_week_target) ||
    0;
  return Number.isFinite(v) ? v : 0;
}

function getLastNCompletedWeeks(currentDisplayWeek, rawMaxWeek, n) {
  const last = Math.max(0, Math.min(Number(currentDisplayWeek) - 1, Number(rawMaxWeek)));
  const start = Math.max(1, last - n + 1);
  const out = [];
  for (let w = start; w <= last; w++) out.push(w);
  return out;
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

function formatStatValue(v) {
  if (v === undefined || v === null) return "—";
  const n = Number(v);
  if (Number.isFinite(n)) return Math.abs(n % 1) < 1e-9 ? String(n) : n.toFixed(2);
  return String(v);
}

function rs(row, key) {
  const n = Number(row?.[key]);
  return Number.isFinite(n) ? n : 0;
}

// ------------------------------
// Raw headshot lookup (GSIS -> headshot_url)
// ------------------------------
function getHeadshotUrlForGsis(gsisId) {
  if (!rawStatsBundle?.weeks) return "";
  const gsis = String(gsisId || "");
  if (!gsis) return "";

  const rawMaxWeek = getRawMaxWeek(rawStatsBundle);
  const last = Math.max(1, Math.min(DISPLAY_WEEK - 1, rawMaxWeek));

  for (let w = last; w >= 1; w -= 1) {
    const row = rawStatsBundle?.weeks?.[String(w)]?.[gsis];
    const url = row?.headshot_url;
    if (url && typeof url === "string" && url.startsWith("http")) return url;
  }
  return "";
}

function getHeadshotUrlForSleeperPlayer(sleeperPlayerObj) {
  return getHeadshotUrlForGsis(sleeperPlayerObj?.gsis_id);
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
  console.log(`Schedule map built for week ${week}. Teams mapped: ${Object.keys(scheduleByTeam).length}`);
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
  if (!data || !Array.isArray(data.matchupTeams)) {
    console.error("Invalid data structure received:", data);
    return;
  }

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
// Player modal helpers
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

// Show modal stats from /data/player-stats-raw.json (joined by Sleeper player.gsis_id)
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
      bodyHtml: `<div class="player-muted">No GSIS id available for this player in Sleeper. Raw stats join not possible.</div>`,
    });
    return;
  }

  let bundle = null;
  try {
    bundle = await loadRawStatsOnce();
  } catch (e) {
    renderPlayerModalContent({
      title: name,
      subtitle: `${team ? team + " • " : ""}${position}`.trim(),
      actionsHtml: actions,
      bodyHtml: `<div class="player-muted">Failed to load ${escapeHtml(RAW_STATS_URL)}: ${escapeHtml(e?.message || String(e))}</div>`,
    });
    return;
  }

  const headshotUrl = getHeadshotUrlForSleeperPlayer(sleeperPlayer);

  const rawMaxWeek = getRawMaxWeek(bundle);
  const weeksToShow = getLastNCompletedWeeks(DISPLAY_WEEK, rawMaxWeek, 6);

  const rows = weeksToShow.map((w) => {
    const row = bundle?.weeks?.[String(w)]?.[gsis] || null;
    return {
      week: w,
      has: !!row,
      pass_yd: rs(row, "passing_yards"),
      pass_td: rs(row, "passing_tds"),
      pass_int: rs(row, "passing_interceptions"),
      rush_att: rs(row, "carries"),
      rush_yd: rs(row, "rushing_yards"),
      rush_td: rs(row, "rushing_tds"),
      rec: rs(row, "receptions"),
      tgt: rs(row, "targets"),
      rec_yd: rs(row, "receiving_yards"),
      rec_td: rs(row, "receiving_tds"),
      ppr: rs(row, "fantasy_points_ppr"),
    };
  });

  const anyData = rows.some((r) => r.has);
  if (!anyData) {
    renderPlayerModalContent({
      title: name,
      subtitle: `${team ? team + " • " : ""}${position}`.trim(),
      actionsHtml: actions,
      bodyHtml: `
        ${headshotUrl ? `<img class="player-headshot" src="${escapeHtml(headshotUrl)}" width="120" height="120" alt="${escapeHtml(name)} headshot">` : ""}
        <div class="player-muted" style="margin-top:12px;">
          No raw stats found for GSIS ${escapeHtml(gsis)} in weeks ${escapeHtml(String(weeksToShow[0] || ""))}-${escapeHtml(String(weeksToShow[weeksToShow.length - 1] || ""))}.
        </div>
      `,
    });
    return;
  }

  const validRows = rows.filter((r) => r.has);
  const wAvg = (key) => weightedAvg(validRows.map((r, i) => ({ v: Number(r[key] || 0), w: i + 1 })));

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

  const statTable = `
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
  `;

  const expectedNote = note
    ? `<div class="player-muted" style="margin-top:8px;">* Adjusted: ${escapeHtml(note)}</div>`
    : "";

  const metaNote =
    `<div class="player-muted" style="margin-top:8px;">Source: ${escapeHtml(RAW_STATS_URL)} (GSIS ${escapeHtml(gsis)}).</div>`;

  const headshotHtml = headshotUrl
    ? `<img class="player-headshot" src="${escapeHtml(headshotUrl)}" width="120" height="120" alt="${escapeHtml(name)} headshot" style="margin-bottom:12px;">`
    : "";

  renderPlayerModalContent({
    title: name,
    subtitle: `${team ? team + " • " : ""}${position}`.trim(),
    actionsHtml: actions,
    bodyHtml: `${headshotHtml}${statTable}${expectedNote}${metaNote}`,
  });
}

// ------------------------------
// Starters list rendering (Sleeper)
// IMPORTANT: use class="player-headshot" so CSS constrains it.
// Also set explicit width/height attributes to prevent layout blowups.
// ------------------------------
function renderStarters(starterIds = [], containerId, playersPoints = {}, projections = {}) {
  const container = getEl(containerId);
  if (!container) return;

  container.innerHTML = "";
  if (!Array.isArray(starterIds)) return;

  starterIds.forEach((starterTokenRaw) => {
    const starterToken = String(starterTokenRaw);

    // Team DEF often appears as "HOU", "DAL", etc.
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

    // Headshot from raw stats (GSIS join) if available
    const headshotUrl = (!isTeamDefToken && sleeperPlayer) ? getHeadshotUrlForSleeperPlayer(sleeperPlayer) : "";

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

    card.innerHTML = `
      ${headshotUrl ? `<img class="player-headshot" src="${escapeHtml(headshotUrl)}" width="42" height="42" alt="${escapeHtml(name)} headshot">` : ``}
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

    // Load raw stats in background; re-render once so headshots appear.
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
