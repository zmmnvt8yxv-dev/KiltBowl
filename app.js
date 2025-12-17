// --- Global Configuration (Must be customized by the user) ---
const LEAGUE_ID = "1262418074540195841"; 
const USER_USERNAME = "conner27lax"; // <-- USER MUST EDIT THIS
const UPDATE_INTERVAL_MS = 30000; // 30 seconds refresh rate

// --- Global Data Stores (Client-side Cache) ---
const API_BASE = "https://api.sleeper.app/v1";
const AVATAR_BASE = "https://sleepercdn.com/avatars/thumbs/";
let nflState = {};
let playerCache = {};
let leagueContext = {
    users:, // CORRECTED: Initialized as empty array
    rosters:, // CORRECTED: Initialized as empty array
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

/**
 * STEP 1: Get the current NFL season and week.
 */
async function getNFLState() {
    try {
        const url = `${API_BASE}/state/nfl`;
        nflState = await fetchJson(url);
        // Use 'week' for matchups, as it reflects the currently active week.
        console.log(`Current NFL Week: ${nflState.week}, Season: ${nflState.season}`);
    } catch (error) {
        console.error("Error fetching NFL State:", error);
        throw new Error("Failed to retrieve current NFL season information.");
    }
}

/**
 * STEP 2 (Initial Load Only): Cache all NFL player data.
 * This is a large payload and should be called only once per session.
 */
async function getAllPlayers() {
    try {
        if (Object.keys(playerCache).length > 0) {
            console.log("Player cache already populated.");
            return;
        }
        const url = `${API_BASE}/players/nfl`;
        const playersData = await fetchJson(url);
        playerCache = playersData;
        console.log(`Cached ${Object.keys(playerCache).length} players.`);
    } catch (error) {
        console.error("Error fetching all players:", error);
        // This is a crucial dependency. Re-throw to stop execution.
        throw new Error("Failed to cache player data. Cannot translate Player IDs.");
    }
}

/**
 * STEP 3 (Initial Load Only): Map users and rosters to identify the current user's team and opponent.
 */
async function fetchInitialContext() {
    try {
        // 3a. Find the user ID based on the username
        const userUrl = `${API_BASE}/user/${USER_USERNAME}`;
        const userData = await fetchJson(userUrl);
        const userId = userData.user_id;

        // 3b. Get all league users and rosters
        const usersUrl = `${API_BASE}/league/${LEAGUE_ID}/users`;
        const rostersUrl = `${API_BASE}/league/${LEAGUE_ID}/rosters`;
        const [users, rosters] = await Promise.all([
            fetchJson(usersUrl),
            fetchJson(rostersUrl)
        ]);
        
        leagueContext.users = users;
        leagueContext.rosters = rosters;

        // 3c. Map user ID to Roster ID
        const userRoster = rosters.find(r => r.owner_id === userId);
        if (!userRoster) {
             throw new Error(`Roster not found for user ${USER_USERNAME} in league ${LEAGUE_ID}.`);
        }
        leagueContext.userRosterId = userRoster.roster_id;
        console.log(`Identified current user's Roster ID: ${leagueContext.userRosterId}`);

    } catch (error) {
        console.error("Error fetching initial league context:", error);
        throw new Error("Failed to identify user or fetch league structure.");
    }
}

/**
 * STEP 4: Retrieve matchup, stats, and projections for the current week.
 */
async function fetchDynamicData(week, season) {
    const matchupUrl = `${API_BASE}/league/${LEAGUE_ID}/matchups/${week}`;
    const projectionsUrl = `${API_BASE}/projections/nfl/${season}/${week}`;
    const statsUrl = `${API_BASE}/stats/nfl/${season}/${week}`;

    // Execute concurrent fetches for efficiency
    const [matchups, projections, stats] = await Promise.all([
        fetchJson(matchupUrl),
        fetchJson(projectionsUrl),
        fetchJson(statsUrl)
    ]);
    
    // Find the current matchup
    const userTeamMatchup = matchups.find(m => m.roster_id === leagueContext.userRosterId);
    if (!userTeamMatchup) {
        // If the current week is a Bye or Playoff week not yet scheduled
        throw new Error(`Matchup data for Roster ID ${leagueContext.userRosterId} not found in Week ${week}.`);
    }

    leagueContext.matchupId = userTeamMatchup.matchup_id;
    
    // Filter the full matchup list down to the two teams in this specific matchup ID
    const currentMatchupTeams = matchups.filter(m => m.matchup_id === leagueContext.matchupId)
                                      .sort((a, b) => a.roster_id - b.roster_id); // Ensure consistent order

    return { 
        matchupTeams: currentMatchupTeams, 
        projections: projections, 
        stats: stats 
    };
}

/**
 * STEP 5: Merge all data sets and render to the DOM.
 */
function mergeAndRenderData(data) {
    const { matchupTeams, projections, stats } = data;
    
    // Determine Team A (User's team) and Team B (Opponent)
    const teamA = matchupTeams.find(t => t.roster_id === leagueContext.userRosterId);
    const teamB = matchupTeams.find(t => t.roster_id!== leagueContext.userRosterId);

    if (!teamA ||!teamB) {
        throw new Error("Could not identify both teams in the matchup.");
    }

    // --- Helper function to get User and Roster details ---
    const getTeamDetails = (roster) => {
        const user = leagueContext.users.find(u => u.user_id === roster.owner_id);
        const teamName = roster.metadata?.team_name |

| user?.display_name |
| `Roster ${roster.roster_id}`;
        
        // Sleeper API does not explicitly provide W/L for the team object easily, 
        // so we derive the record from the roster's win/loss count.
        const record = `${roster.settings.wins |

| 0}-${roster.settings.losses |
| 0}${roster.settings.ties? '-' + roster.settings.ties : ''}`;

        return {
            id: roster.roster_id,
            name: teamName,
            record: record,
            avatar: user?.avatar,
            starters: roster.starters,
            points: roster.points // Authoritative league-calculated score [1]
        };
    };

    const teamADetails = getTeamDetails(teamA);
    const teamBDetails = getTeamDetails(teamB);

    // Update Header Scores
    document.getElementById('team-a-name').textContent = teamADetails.name;
    document.getElementById('team-a-record').textContent = teamADetails.record;
    document.getElementById('team-a-avatar').src = `${AVATAR_BASE}${teamADetails.avatar}`;
    document.getElementById('score-a').textContent = teamADetails.points.toFixed(2);

    document.getElementById('team-b-name').textContent = teamBDetails.name;
    document.getElementById('team-b-record').textContent = teamBDetails.record;
    document.getElementById('team-b-avatar').src = `${AVATAR_BASE}${teamBDetails.avatar}`;
    document.getElementById('score-b').textContent = teamBDetails.points.toFixed(2);
    
    // --- Render Starters ---
    renderStarters(teamADetails.starters, 'team-a-starters', projections, stats);
    renderStarters(teamBDetails.starters, 'team-b-starters', projections, stats);

    document.getElementById('scoreboard').classList.remove('hidden');
    document.getElementById('loading').classList.add('hidden');
    
    lastUpdatedTime = new Date();
    document.getElementById('last-updated').textContent = lastUpdatedTime.toLocaleTimeString();
}

// Renders the list of starting players for one team
function renderStarters(starterIds, containerId, projections, stats) {
    const container = document.getElementById(containerId);
    container.innerHTML = ''; // Clear previous data

    starterIds.forEach(playerId => {
        const player = playerCache[playerId];
        
        // Player details mapping
        const position = player?.position |

| 'N/A';
        const name = player?.full_name |

| 'Unknown Player';
        const team = player?.team |

| '';

        // Score retrieval (using PPR fields for projections/stats as a common standard)
        // Note: The stats/projections APIs usually provide points like pts_ppr or pts_std.[2]
        const projScore = projections[playerId]?.pts_ppr |

| 0.0;
        const actualScore = stats[playerId]?.pts_ppr |

| 0.0;
        
        // Status detail (mimicking Sleeper's in-game status bar)
        let statusText = `${team}`; // Start with the player's NFL team
        
        if (actualScore > 0.01 && projScore!== 0) {
            statusText += ` - LIVE`; // Player is currently scoring
        } else if (projScore === 0) {
            statusText += ` - BYE/Post-Game`; 
        } else {
             statusText += ` - YET TO PLAY`; // Player hasn't played yet
        }


        const card = document.createElement('div');
        card.className = 'player-card';
        card.innerHTML = `
            <div class="player-info">
                <span class="player-name">${name} (${position})</span>
                <div class="player-details">
                    ${statusText}
                </div>
            </div>
            <div class="score-box">
                <div class="score-actual">${actualScore.toFixed(2)}</div>
                <div class="score-projected">P: ${projScore.toFixed(2)}</div>
            </div>
        `;
        container.appendChild(card);
    });
}

/**
 * Main application initializer. Fetches static data and begins the update loop.
 */
async function initializeApp() {
    try {
        await getNFLState();
        await getAllPlayers(); // Heavy, cached call
        await fetchInitialContext(); // User/Roster mapping
        
        // Initial rendering
        await fetchAndRenderData(nflState.week, nflState.season);
        
        // Start the live update polling loop
        startLiveUpdate();

    } catch (error) {
        document.getElementById('loading').textContent = `Error: ${error.message}. Please check your LEAGUE_ID and USER_USERNAME configuration.`;
        console.error("Initialization Failed:", error);
    }
}

/**
 * Handles the periodic update loop.
 * Only fetches dynamic (time-sensitive) data: State, Matchups, Stats, Projections.
 */
async function fetchAndRenderData(week, season) {
    try {
        // Fetch dynamic data sets
        const dynamicData = await fetchDynamicData(week, season);
        
        // Merge and update UI
        mergeAndRenderData(dynamicData);

    } catch (error) {
        console.warn(`Live Update Warning (Week ${week}): ${error.message}. Retrying on next interval.`);
    }
}

function startLiveUpdate() {
    let countdownValue = UPDATE_INTERVAL_MS / 1000;
    const countdownElement = document.getElementById('countdown');

    const updateCountdown = () => {
        countdownElement.textContent = countdownValue;
        if (countdownValue <= 0) {
            countdownValue = UPDATE_INTERVAL_MS / 1000;
            // Execute the data refresh on timer reset
            fetchAndRenderData(nflState.week, nflState.season);
        } else {
            countdownValue--;
        }
    };

    // Run countdown every second
    setInterval(updateCountdown, 1000);
    // Set the initial data refresh interval
    updateTimer = setInterval(() => {
        // fetchAndRenderData is now handled by the countdown loop when it resets
    }, UPDATE_INTERVAL_MS);
}

// Kick off the application
initializeApp();
