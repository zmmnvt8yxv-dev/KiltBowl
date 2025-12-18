// --- Global Configuration ---
const LEAGUE_ID = "1262418074540195841";
const USER_USERNAME = "conner27lax";
const UPDATE_INTERVAL_MS = 30000; // 30 seconds

// Force the app to always display this matchup week for the scoreboard
const DISPLAY_WEEK = 16;

// --- Global Data Stores (Client-side Cache) ---
const API_BASE = "https://api.sleeper.app/v1";
const AVATAR_BASE = "https://sleepercdn.com/avatars/thumbs/";

let nflState = {};
let playerCache = {};
let LEAGUE_SEASON = null;

let leagueContext = {
  users: null,
  rosters: null,
  userRosterId: null,
  matchupId: null,
};

let scheduleByTeam = {}; // { TEAM: { opp: TEAM, homeAway: 'vs'|'@', gameStatus: string, start: string } }
let updateTimer = null;
let lastUpdatedTime = null;

// ---- Static stats (JSON) ----
// Expected path: /data/stats-static.json
// Shape (from workflow):
// {
//   season, generated_at, last_completed_week,
//   weeks: { "1": { "<sleeper_id>": { pass_cmp, pass_att, ... } }, ... }
// }
let STATIC_STATS = null;

// Modal state
let modalIsOpen = false;
let modalLastFocusedEl = null;

// Manual “news” overrides keyed by Sleeper player_id (the numeric ids in starters)
// Multiplier applies to expected row (Expected*).
const NEWS_OVERRIDES = {
  // "4046": { mult: 1.30, note: "Expected to start (+30%)" },
  // "1234": { mult: 1.10, note: "Expected increased role (+10%)" },
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

function safeText(v) {
  return v === undefined || v === null ? "" : String(v);
}

function pickSeason() {
  return Number(STATIC_STATS?.season) || Number(LEAGUE_SEASON) || Number(nflState?.season) || new Date().getFullYear();
}

function formatStatValue(v) {
  if (v === undefined || v === null) return "—";
  const n = Number(v);
  if (Number.isFinite(n)) return Math.abs(n % 1) < 1e-9 ? String(n) : n.toFixed(2);
  return String(v);
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function numOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function weightedAvg(values) {
  let num = 0;
  let den = 0;
  for (const { v, w } of values) {
    if (!Number.isFinite(v) || !Number.isFinite(w)) continue;
    num += v * w;
    den += w;
  }
  return den > 0 ? num / den : null;
}

// ------------------------------
// Static stats loader (JSON)
// ------------------------------
async function loadStaticStatsOnce() {
  if (STATIC_STATS) return STATIC_STATS;
  try {
    const res = await fetch("data/stats-static.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`data/stats-static.json HTTP ${res.status}`);
    const data = await res.json();
    STATIC_STATS = data && typeof data === "object" ? data : null;
  } catch (e) {
    STATIC_STATS = null;
  }
  return STATIC_STATS;
}

function getLastCompletedWeekForStats() {
  // Prefer workflow’s notion of last completed week, else live nflState.
  const a = Number(STATIC_STATS?.last_completed_week);
  if (Number.isFinite(a) && a >= 0) return a;

  const nflWeek = Number(nflState?.week);
  if (Number.isFinite(nflWeek) && nflWeek >= 0) return Math.max(0, nflWeek - 1);

  return 0;
}

function getLastNWeeksCompleted(n = 6) {
  const lastCompleted = getLastCompletedWeekForStats();
  const end = Math.min(lastCompleted, Math.max(0, Number(DISPLAY_WEEK) - 1)); // keep aligned with your displayed matchup era
  const start = Math.max(1, end - (n - 1));
  const weeks = [];
  for (let w = start; w <= end; w += 1) weeks.push(w);
  return weeks;
}

function getStaticPlayerWeekStats(season, week, sleeperPlayerId) {
  if (!STATIC_STATS) return null;
  if (Number(STATIC_STATS.season) !== Number(season)) return null;
  const wk = STATIC_STATS.weeks?.[String(week)] || null;
  if (!wk) return null;
  return wk[String(sleeperPlayerId)] || null;
}

// ------------------------------
// Sleeper state + players + league context
// ------------------------------
async function getNFLState() {
  const url = `${API_BASE}/state/nfl`;
  nflState = await fetchJson(url);
}

async function getAllPlayers() {
  if (Object.keys(playerCache).length > 0) return;
  const url = `${API_BASE}/players/nfl`;
  playerCache = (await fetchJson(url)) || {};
}

async function fetchInitialContext() {
  const userUrl = `${API_BASE}/user/${USER_USERNAME}`;
  const userData = await fetchJson(userUrl);
  const userId = userData.user_id;

  const leagueUrl = `${API_BASE}/league/${LEAGUE_ID}`;
  const usersUrl = `${API_BASE}/league/${LEAGUE_ID}/users`;
  const rostersUrl = `${API_BASE}/league/${LEAGUE_ID}/rosters`;

  const [leagueMeta, users, rosters] = await Promise.all([
    fetchJson(leagueUrl),
    fetchJson(usersUrl),
    fetchJson(rostersUrl),
  ]);

  LEAGUE_SEASON = Number(leagueMeta?.season) || null;

  leagueContext.users = users;
  leagueContext.rosters = rosters;

  const userRoster = rosters.find((r) => r && r.owner_id === userId);
  if (!userRoster) throw new Error(`Roster not found for user ${USER_USERNAME} in league ${LEAGUE_ID}.`);

  leagueContext.userRosterId = userRoster.roster_id;
}

// ------------------------------
// Schedule for opponent display
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

function getOpponentTextForTeam(teamAbbrev) {
  const entry = scheduleByTeam?.[teamAbbrev];
  if (!entry) return "N/A";
  const ha = entry.homeAway || "vs";
  const opp = entry.opp || "";
  const status = entry.gameStatus ? ` • ${entry.gameStatus}` : "";
  return `${ha} ${opp}${status}`.trim();
}

// ------------------------------
// Matchups (scoreboard)
// ------------------------------
async function fetchDynamicData(week) {
  const matchupUrl = `${API_BASE}/league/${LEAGUE_ID}/matchups/${week}`;
  const matchups = await fetchJson(matchupUrl);

  if (!Array.isArray(matchups) || matchups.length === 0) return { matchupTeams: [] };

  const userTeamMatchup = matchups.find((m) => m && m.roster_id === leagueContext.userRosterId);
  if (!userTeamMatchup) throw new Error(`Matchup data for roster_id ${leagueContext.userRosterId} not found in week ${week}.`);

  leagueContext.matchupId = userTeamMatchup.matchup_id;

  const currentMatchupTeams = matchups
    .filter((m) => m && m.matchup_id === leagueContext.matchupId)
    .sort((a, b) => a.roster_id - b.roster_id);

  return { matchupTeams: currentMatchupTeams };
}

// ------------------------------
// Merge + Render (scoreboard)
// ------------------------------
function mergeAndRenderData(data) {
  if (!data || !Array.isArray(data.matchupTeams)) return;

  const matchupTeams = data.matchupTeams;

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

  renderStarters(teamADetails.starters, "team-a-starters", teamADetails.playersPoints);
  renderStarters(teamBDetails.starters, "team-b-starters", teamBDetails.playersPoints);

  const scoreboardEl = document.getElementById("scoreboard");
  if (scoreboardEl) scoreboardEl.classList.remove("hidden");
  const loadingEl = document.getElementById("loading");
  if (loadingEl) loadingEl.classList.add("hidden");

  lastUpdatedTime = new Date();
  const lastUpdatedEl = document.getElementById("last-updated");
  if (lastUpdatedEl) lastUpdatedEl.textContent = lastUpdatedTime.toLocaleTimeString();
}

// ------------------------------
// Starters list rendering (clickable)
// ------------------------------
function renderStarters(starterIds = [], containerId, playersPoints = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = "";
  if (!Array.isArray(starterIds)) return;

  starterIds.forEach((playerIdRaw) => {
    const playerId = String(playerIdRaw);

    // Team DEF token like "HOU"
    const isTeamDef = /^[A-Z]{2,4}$/.test(playerId) && !playerCache[playerId];
    const player = playerCache[playerId] || playerCache[Number(playerId)] || null;

    const position = isTeamDef ? "DEF" : (player?.position || "N/A");
    const name = isTeamDef
      ? `${playerId} Defense`
      : (player?.full_name || (player?.first_name ? `${player.first_name} ${player.last_name}` : "Unknown Player"));

    const teamShort = isTeamDef ? playerId : (player?.team || "");
    const actualScore = Number(playersPoints?.[playerId] ?? 0);
    const oppText = teamShort ? getOpponentTextForTeam(teamShort) : "N/A";

    const card = document.createElement("div");
    card.className = "player-card";

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
    } else {
      card.style.cursor = "default";
    }

    card.innerHTML = `
      <div class="player-info">
        <span class="player-name">${escapeHtml(name)} (${escapeHtml(position)})</span>
        <div class="player-details">${escapeHtml(teamShort || "N/A")} • ${escapeHtml(oppText)}</div>
      </div>
      <div class="score-box">
        <div class="score-actual">${Number(actualScore).toFixed(2)}</div>
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

  if (modalLastFocusedEl && typeof modalLastFocusedEl.focus === "function") modalLastFocusedEl.focus();
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

function buildEspnPlayerUrl(playerObj) {
  const espnId = playerObj?.espn_id ?? playerObj?.espnId;
  if (!espnId) return "";
  return `https://www.espn.com/nfl/player/_/id/${encodeURIComponent(String(espnId))}`;
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

function getNewsMultiplierAndNote(playerId, sleeperPlayerObj) {
  const pid = String(playerId);
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

function rowFromStats(week, statsObj) {
  const pts = numOrNull(statsObj?.fantasy_points_ppr ?? statsObj?.fantasy_points);
  return {
    week,
    pts,
    pass_cmp: numOrNull(statsObj?.pass_cmp),
    pass_att: numOrNull(statsObj?.pass_att),
    pass_yd: numOrNull(statsObj?.pass_yd),
    pass_td: numOrNull(statsObj?.pass_td),
    pass_int: numOrNull(statsObj?.pass_int),

    rush_att: numOrNull(statsObj?.rush_att),
    rush_yd: numOrNull(statsObj?.rush_yd),
    rush_td: numOrNull(statsObj?.rush_td),

    rec: numOrNull(statsObj?.rec),
    rec_tgt: numOrNull(statsObj?.rec_tgt),
    rec_yd: numOrNull(statsObj?.rec_yd),
    rec_td: numOrNull(statsObj?.rec_td),

    fum: numOrNull(statsObj?.fum),
    fum_lost: numOrNull(statsObj?.fum_lost),
  };
}

async function showPlayerDetailsModal(playerId) {
  wirePlayerModalEventsOnce();

  const player = playerCache[String(playerId)] || playerCache[Number(playerId)] || null;
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
    bodyHtml: `<div class="player-loading">Loading…</div>`,
  });

  openPlayerModal();

  await loadStaticStatsOnce();
  const season = pickSeason();
  const weeksToFetch = getLastNWeeksCompleted(6);

  if (!STATIC_STATS || Number(STATIC_STATS.season) !== Number(season)) {
    renderPlayerModalContent({
      title: name,
      subtitle: `${team ? team + " • " : ""}${position || ""}`.trim(),
      actionsHtml: actions,
      bodyHtml: `<div class="player-loading">Static stats not available for season ${escapeHtml(String(season))}.</div>`,
    });
    return;
  }

  if (!weeksToFetch.length) {
    renderPlayerModalContent({
      title: name,
      subtitle: `${team ? team + " • " : ""}${position || ""}`.trim(),
      actionsHtml: actions,
      bodyHtml: `<div class="player-loading">No completed weeks available yet.</div>`,
    });
    return;
  }

  const rows = weeksToFetch.map((w) => {
    const statsObj = getStaticPlayerWeekStats(season, w, playerId);
    return rowFromStats(w, statsObj);
  });

  // Weighted expected from last 6 rows (more recent heavier)
  const weighted = (k) => {
    const vals = rows
      .map((r, i) => ({ v: numOrZero(r[k]), w: i + 1 }))
      .filter((x) => Number.isFinite(x.v));
    return weightedAvg(vals);
  };

  const expectedRaw = {
    pts: weighted("pts"),
    pass_cmp: weighted("pass_cmp"),
    pass_att: weighted("pass_att"),
    pass_yd: weighted("pass_yd"),
    pass_td: weighted("pass_td"),
    pass_int: weighted("pass_int"),

    rush_att: weighted("rush_att"),
    rush_yd: weighted("rush_yd"),
    rush_td: weighted("rush_td"),

    rec: weighted("rec"),
    rec_tgt: weighted("rec_tgt"),
    rec_yd: weighted("rec_yd"),
    rec_td: weighted("rec_td"),

    fum: weighted("fum"),
    fum_lost: weighted("fum_lost"),
  };

  const { mult, note } = getNewsMultiplierAndNote(playerId, player);
  const expectedAdj = {};
  for (const [k, v] of Object.entries(expectedRaw)) expectedAdj[k] = v == null ? null : Number(v) * mult;

  const cellRush = (r) => {
    const has = r.rush_att != null || r.rush_yd != null || r.rush_td != null;
    if (!has) return "—";
    return `${formatStatValue(r.rush_att)}-${formatStatValue(r.rush_yd)} (${formatStatValue(r.rush_td)} TD)`;
  };

  const cellRec = (r) => {
    const has = r.rec != null || r.rec_tgt != null || r.rec_yd != null || r.rec_td != null;
    if (!has) return "—";
    return `${formatStatValue(r.rec)}/${formatStatValue(r.rec_tgt)}-${formatStatValue(r.rec_yd)} (${formatStatValue(r.rec_td)} TD)`;
  };

  const cellPass = (r) => {
    const has = r.pass_yd != null || r.pass_td != null || r.pass_int != null || r.pass_cmp != null || r.pass_att != null;
    if (!has) return "—";
    const compAtt = (r.pass_cmp != null || r.pass_att != null) ? `${formatStatValue(r.pass_cmp)}/${formatStatValue(r.pass_att)}` : "—";
    return `${compAtt} • ${formatStatValue(r.pass_yd)} (${formatStatValue(r.pass_td)} TD, ${formatStatValue(r.pass_int)} INT)`;
  };

  const statTable = `
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
        ${rows
          .map(
            (r) => `
            <tr>
              <td>${r.week}</td>
              <td>${formatStatValue(r.pts)}</td>
              <td>${cellRush(r)}</td>
              <td>${cellRec(r)}</td>
              <td>${cellPass(r)}</td>
            </tr>
          `
          )
          .join("")}

        <tr>
          <td><strong>Expected</strong></td>
          <td><strong>${formatStatValue(expectedRaw.pts)}</strong></td>
          <td><strong>${cellRush(expectedRaw)}</strong></td>
          <td><strong>${cellRec(expectedRaw)}</strong></td>
          <td><strong>${cellPass(expectedRaw)}</strong></td>
        </tr>

        <tr>
          <td><strong>Expected*</strong></td>
          <td><strong>${formatStatValue(expectedAdj.pts)}</strong></td>
          <td><strong>${cellRush(expectedAdj)}</strong></td>
          <td><strong>${cellRec(expectedAdj)}</strong></td>
          <td><strong>${cellPass(expectedAdj)}</strong></td>
        </tr>
      </tbody>
    </table>
  `;

  const expectedNote = note
    ? `<div class="player-muted" style="margin-top:8px;">* Adjusted: ${escapeHtml(note)}</div>`
    : "";

  const sourceNote = `<div class="player-muted" style="margin-top:8px;">Stats source: data/stats-static.json • season ${escapeHtml(
    String(season)
  )} • generated ${escapeHtml(String(STATIC_STATS.generated_at || ""))}</div>`;

  renderPlayerModalContent({
    title: name,
    subtitle: `${team ? team + " • " : ""}${position || ""}`.trim(),
    actionsHtml: actions,
    bodyHtml: `${statTable}${expectedNote}${sourceNote}`,
  });
}

// ------------------------------
// Main application flow
// ------------------------------
async function fetchAndRenderData() {
  if (!leagueContext.users || !leagueContext.rosters || !leagueContext.userRosterId) return;

  const week = DISPLAY_WEEK;
  const season = pickSeason();

  await fetchScheduleForSeasonAndWeek(season, week);

  const dynamicData = await fetchDynamicData(week);
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
        await getNFLState(); // keeps modal completed-week logic fresh
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
    await loadStaticStatsOnce();

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
