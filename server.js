require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");
const cron = require("node-cron");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { simulateMatch } = require('./game/matchsim');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// ============================================================
// DATABASE CONNECTION
// ============================================================
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

async function initDB() {
  try {
    const conn = await pool.getConnection();
    console.log("Database connected!");
    conn.release();
  } catch (err) {
    console.error("Database connection error:", err.message);
  }
}
initDB();

// ============================================================
// TRACK ONLINE MANAGERS
// ============================================================
const onlineManagers = new Map();

// ============================================================
// HELPER - SEND NOTIFICATION
// ============================================================
async function sendNotification(managerId, type, message, data = {}) {
  try {
    await pool.execute(
      "INSERT INTO notifications (manager_id, type, message, data) VALUES (?, ?, ?, ?)",
      [managerId, type, message, JSON.stringify(data)]
    );
    io.to(`manager:${managerId}`).emit("notification:new", { type, message, data });
  } catch (err) {
    console.error("Notification error:", err.message);
  }
}

app.use((req, res, next) => {
  req.pool = pool;
  req.sendNotification = sendNotification;
  next();
});

// ============================================================
// SOCKET.IO
// ============================================================
io.on("connection", (socket) => {
  console.log("Manager connected:", socket.id);

  socket.on("manager:join", async (managerId) => {
    onlineManagers.set(socket.id, managerId);
    socket.join(`manager:${managerId}`);
    try {
      const [notifications] = await pool.execute(
        "SELECT * FROM notifications WHERE manager_id = ? AND `read` = false ORDER BY created_at DESC",
        [managerId]
      );
      socket.emit("notifications:unread", notifications);
    } catch (err) {
      console.error("Error fetching notifications:", err.message);
    }
  });

  socket.on("server:join", (serverId) => {
    socket.join(`server:${serverId}`);
  });

  socket.on("disconnect", () => {
    onlineManagers.delete(socket.id);
  });
});

// ============================================================
// GAME CLOCK - every 2 real days = 1 game week
// ============================================================
cron.schedule("0 0 */2 * *", async () => {
  console.log("Game clock ticking...");
  try {
    await pool.execute(
      "UPDATE game_clock SET current_week = current_week + 1, last_tick = NOW()"
    );
    const [clockRows] = await pool.execute("SELECT * FROM game_clock LIMIT 1");
    const clock = clockRows[0];
    console.log(`Game week ${clock.current_week} season ${clock.current_season}`);

    await simulateMatchday(clock.current_week, clock.current_season);

    if (clock.current_week >= 38) await endSeason(clock.current_season);

    const inWindow =
      (clock.current_week >= 1 && clock.current_week <= 4) ||
      (clock.current_week >= 20 && clock.current_week <= 24);
    await pool.execute("UPDATE game_clock SET transfer_window_open = ?", [inWindow]);

    const [managers] = await pool.execute(
      "SELECT id FROM managers WHERE is_ai = false"
    );
    for (const m of managers) {
      await sendNotification(
        m.id,
        "week_start",
        `Week ${clock.current_week} has begun`,
        { week: clock.current_week, transfer_window: inWindow }
      );
    }
  } catch (err) {
    console.error("Game clock error:", err.message);
  }
});

// ============================================================
// MATCH SIMULATION
// ============================================================
async function simulateMatchday(week, season) {
  try {
    const [matches] = await pool.execute(
      "SELECT * FROM fixtures WHERE week = ? AND season = ? AND played = false",
      [week, season]
    );

    console.log(`Simulating ${matches.length} matches for week ${week}`);

    for (const match of matches) {
      const [[homeClub]] = await pool.execute("SELECT * FROM clubs WHERE id = ?", [match.home_club_id]);
      const [[awayClub]] = await pool.execute("SELECT * FROM clubs WHERE id = ?", [match.away_club_id]);

      const [homeSquad] = await pool.execute(
        `SELECT p.* FROM players p
         JOIN contracts c ON p.id = c.player_id
         WHERE c.club_id = ? AND c.active = 1`,
        [match.home_club_id]
      );
      const [awaySquad] = await pool.execute(
        `SELECT p.* FROM players p
         JOIN contracts c ON p.id = c.player_id
         WHERE c.club_id = ? AND c.active = 1`,
        [match.away_club_id]
      );

      const defaultTactics = {
        pressing: 6, defensive_line: 5, tempo: 6,
        width: 5, attacking_risk: 5, mentality: 'balanced'
      };
      const [homeTacticsRows] = await pool.execute("SELECT * FROM tactics WHERE club_id = ?", [match.home_club_id]);
      const [awayTacticsRows] = await pool.execute("SELECT * FROM tactics WHERE club_id = ?", [match.away_club_id]);
      const homeTactics = homeTacticsRows[0] || defaultTactics;
      const awayTactics = awayTacticsRows[0] || defaultTactics;

      const result = simulateMatch(homeClub, awayClub, homeTactics, awayTactics, homeSquad, awaySquad);

      const scorersSummary = [
        ...result.homeScorers.map(s => `${s.name} ${s.minute}'`),
        ...result.awayScorers.map(s => `${s.name} ${s.minute}'`)
      ].join(', ');

      await pool.execute(
        `UPDATE fixtures SET
          home_goals = ?, away_goals = ?, played = true,
          home_possession = ?, away_possession = ?,
          home_shots = ?, away_shots = ?,
          scorers = ?
         WHERE id = ?`,
        [
          result.homeGoals, result.awayGoals,
          result.homePossession, result.awayPossession,
          result.homeShots, result.awayShots,
          scorersSummary,
          match.id
        ]
      );

      await updateLeagueTable(match, result.homeGoals, result.awayGoals);

      const resultStr = `${homeClub.name} ${result.homeGoals} - ${result.awayGoals} ${awayClub.name}`;
      console.log(`Result: ${resultStr} | Scorers: ${scorersSummary}`);

      if (homeClub.manager_id) {
        await sendNotification(homeClub.manager_id, 'match_result', `Result: ${resultStr}`, {
          home_goals: result.homeGoals, away_goals: result.awayGoals,
          scorers: result.homeScorers
        });
      }
      if (awayClub.manager_id) {
        await sendNotification(awayClub.manager_id, 'match_result', `Result: ${resultStr}`, {
          home_goals: result.homeGoals, away_goals: result.awayGoals,
          scorers: result.awayScorers
        });
      }

      io.to(`server:${match.server_id}`).emit('match:result', {
        fixture_id: match.id,
        result: resultStr,
        home_goals: result.homeGoals,
        away_goals: result.awayGoals,
        home_possession: result.homePossession,
        home_shots: result.homeShots,
        away_shots: result.awayShots,
        scorers: scorersSummary
      });
    }
  } catch (err) {
    console.error('Match sim error:', err.message);
  }
}

async function updateLeagueTable(match, homeGoals, awayGoals) {
  const homeWin = homeGoals > awayGoals;
  const awayWin = awayGoals > homeGoals;
  const draw = homeGoals === awayGoals;

  await pool.execute(
    `UPDATE league_table SET
      played = played + 1,
      won = won + ?, drawn = drawn + ?, lost = lost + ?,
      goals_for = goals_for + ?, goals_against = goals_against + ?,
      goal_difference = goal_difference + ?, points = points + ?
     WHERE club_id = ? AND server_id = ?`,
    [
      homeWin ? 1 : 0, draw ? 1 : 0, awayWin ? 1 : 0,
      homeGoals, awayGoals, homeGoals - awayGoals,
      homeWin ? 3 : draw ? 1 : 0,
      match.home_club_id, match.server_id,
    ]
  );

  await pool.execute(
    `UPDATE league_table SET
      played = played + 1,
      won = won + ?, drawn = drawn + ?, lost = lost + ?,
      goals_for = goals_for + ?, goals_against = goals_against + ?,
      goal_difference = goal_difference + ?, points = points + ?
     WHERE club_id = ? AND server_id = ?`,
    [
      awayWin ? 1 : 0, draw ? 1 : 0, homeWin ? 1 : 0,
      awayGoals, homeGoals, awayGoals - homeGoals,
      awayWin ? 3 : draw ? 1 : 0,
      match.away_club_id, match.server_id,
    ]
  );
}

async function endSeason(season) {
  console.log(`Season ${season} ending...`);
  await pool.execute(
    "UPDATE game_clock SET current_week = 1, current_season = current_season + 1"
  );
}

// ============================================================
// ROUTES
// ============================================================
const { router: authRouter } = require("./routes/auth");
const transferRouter = require("./routes/transfers");

app.use("/api/auth", authRouter);
app.use("/api/transfers", transferRouter);

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Football Manager server running" });
});

// Manual week advance for testing
app.get("/api/admin/advance-week", async (req, res) => {
  try {
    await pool.execute("UPDATE game_clock SET current_week = current_week + 1, last_tick = NOW()");
    const [clockRows] = await pool.execute("SELECT * FROM game_clock LIMIT 1");
    const clock = clockRows[0];
    await simulateMatchday(clock.current_week, clock.current_season);
    res.json({ success: true, week: clock.current_week, season: clock.current_season });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Game clock
app.get("/api/clock", async (req, res) => {
  try {
    const [rows] = await pool.execute("SELECT * FROM game_clock LIMIT 1");
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// League table
app.get("/api/table/:serverId", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT lt.*, c.name as club_name FROM league_table lt
       JOIN clubs c ON lt.club_id = c.id
       WHERE lt.server_id = ?
       ORDER BY lt.points DESC, lt.goal_difference DESC`,
      [req.params.serverId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Squad
app.get("/api/squad/:clubId", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT p.*, c.expires_at_week, c.weekly_wage, c.team_type, c.happiness
       FROM players p
       JOIN contracts c ON p.id = c.player_id
       WHERE c.club_id = ? AND c.active = 1
       ORDER BY p.overall_rating DESC`,
      [req.params.clubId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fixtures for a server
app.get("/api/fixtures/:serverId", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT * FROM fixtures WHERE server_id = ? ORDER BY week ASC",
      [req.params.serverId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fixtures for a specific club
app.get("/api/fixtures/club/:clubId", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT f.*,
        hc.name as home_club_name, ac.name as away_club_name
       FROM fixtures f
       JOIN clubs hc ON hc.id = f.home_club_id
       JOIN clubs ac ON ac.id = f.away_club_id
       WHERE f.home_club_id = ? OR f.away_club_id = ?
       ORDER BY f.week ASC`,
      [req.params.clubId, req.params.clubId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Notifications
app.get("/api/notifications/:managerId", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT * FROM notifications WHERE manager_id = ? ORDER BY created_at DESC LIMIT 50",
      [req.params.managerId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/notifications/:id/read", async (req, res) => {
  try {
    await pool.execute(
      "UPDATE notifications SET `read` = true WHERE id = ?",
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/notifications/:managerId/read-all", async (req, res) => {
  try {
    await pool.execute(
      "UPDATE notifications SET `read` = true WHERE manager_id = ?",
      [req.params.managerId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Press room
app.get("/api/press/:serverId", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT pc.*, m.username, cl.name AS club_name
       FROM press_conferences pc
       JOIN managers m ON m.id = pc.manager_id
       JOIN clubs cl ON cl.id = pc.club_id
       WHERE pc.server_id = ?
       ORDER BY pc.created_at DESC LIMIT 30`,
      [req.params.serverId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/press", async (req, res) => {
  const { server_id, club_id, template_text, custom_text } = req.body;
  try {
    const [mgr] = await pool.execute("SELECT id FROM managers WHERE club_id = ?", [club_id]);
    if (!mgr.length) return res.status(400).json({ error: "Manager not found" });
    await pool.execute(
      "INSERT INTO press_conferences (manager_id, server_id, club_id, template_text, custom_text) VALUES (?, ?, ?, ?, ?)",
      [mgr[0].id, server_id, club_id, template_text, custom_text || null]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tactics
app.post("/api/tactics", async (req, res) => {
  const { club_id, formation, pressing, defensive_line, tempo, width, attacking_risk, mentality } = req.body;
  try {
    await pool.execute(
      `INSERT INTO tactics (club_id, formation, pressing, defensive_line, tempo, width, attacking_risk, mentality)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         formation=VALUES(formation), pressing=VALUES(pressing), defensive_line=VALUES(defensive_line),
         tempo=VALUES(tempo), width=VALUES(width), attacking_risk=VALUES(attacking_risk), mentality=VALUES(mentality)`,
      [club_id, formation, pressing, defensive_line, tempo, width, attacking_risk, mentality]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Promote youth player
app.post("/api/squad/promote/:id", async (req, res) => {
  try {
    await pool.execute(
      "UPDATE contracts SET team_type = 'first' WHERE player_id = ?",
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate fixtures
app.get("/api/admin/generate-fixtures", async (req, res) => {
  try {
    const serverId = req.query.server_id || 1;
    const season = req.query.season || 1;

    await pool.execute(
      "DELETE FROM fixtures WHERE server_id = ? AND season = ? AND played = false",
      [serverId, season]
    );

    const [clubs] = await pool.execute("SELECT id FROM clubs ORDER BY id ASC");
    const clubIds = clubs.map(c => c.id);
    const fixtures = [];

    const ids = [...clubIds];
    if (ids.length % 2 !== 0) ids.push(null);
    const rounds = ids.length - 1;
    const half = ids.length / 2;

    for (let round = 0; round < rounds; round++) {
      for (let i = 0; i < half; i++) {
        const home = ids[i];
        const away = ids[ids.length - 1 - i];
        if (home && away) {
          fixtures.push([home, away, round + 1, season, serverId]);
        }
      }
      ids.splice(1, 0, ids.pop());
    }

    const returnFixtures = fixtures.map(([h, a, w, s, sid]) => [a, h, w + rounds, s, sid]);
    const allFixtures = [...fixtures, ...returnFixtures];

    const values = allFixtures.map(f => `(${f[0]}, ${f[1]}, ${f[2]}, ${f[3]}, ${f[4]}, false)`).join(',');
    await pool.execute(
      `INSERT INTO fixtures (home_club_id, away_club_id, week, season, server_id, played) VALUES ${values}`
    );

    res.json({ success: true, fixtures_generated: allFixtures.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CSV headers debug
app.get("/api/csv-headers", (req, res) => {
  const text = fs.readFileSync(
    path.join(__dirname, "players_data_light-2025_2026.csv"), "utf8"
  );
  res.json({ headers: text.split("\n")[0] });
});

// Seed contracts
app.get("/api/seed-contracts", async (req, res) => {
  try {
    const csvPath = path.join(__dirname, "players_data_light-2025_2026.csv");
    const text = fs.readFileSync(csvPath, "utf8");
    const lines = text.trim().split(/\r?\n/);
    const headers = lines[0].split(",").map(h => h.replace(/"/g, "").trim());

    const clubMap = {
      "Manchester City": 1, Arsenal: 2, Liverpool: 3, Chelsea: 4,
      "Manchester Utd": 5, Tottenham: 6, "Newcastle Utd": 7, "Aston Villa": 8,
      "West Ham": 9, Brighton: 10, Brentford: 11, Fulham: 12,
      "Crystal Palace": 13, Wolves: 14, Everton: 15, "Leicester City": 16,
      "Nott'ham Forest": 17, Bournemouth: 18, Southampton: 19, "Ipswich Town": 20,
    };

    const [allPlayers] = await pool.execute("SELECT id, name FROM players");

    const normalize = str => str
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();

    const playerMap = {};
    for (const p of allPlayers) {
      playerMap[normalize(p.name)] = p.id;
    }

    const values = [];
    const matched = new Set();
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      const get = (name) => cols[headers.indexOf(name)]?.replace(/"/g, "").trim() || null;
      const playerName = get("Player");
      const squad = get("Squad");
      if (!playerName || !squad || !clubMap[squad]) continue;

      const normalizedName = normalize(playerName);
      const playerId = playerMap[normalizedName];
      if (!playerId || matched.has(playerId)) continue;

      matched.add(playerId);
      values.push(`(${playerId}, ${clubMap[squad]}, 10000, 100, 1, 'first')`);
    }

    if (values.length > 0) {
      await pool.execute(
        `INSERT IGNORE INTO contracts (player_id, club_id, weekly_wage, expires_at_week, active, team_type) VALUES ${values.join(",")}`
      );
    }

    res.json({ success: true, assigned: values.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Seed players
app.get("/api/seed-players", async (req, res) => {
  try {
    const csvPath = path.join(__dirname, "players_data_light-2025_2026.csv");
    const text = fs.readFileSync(csvPath, "utf8");
    const lines = text.trim().split(/\r?\n/);
    const headers = lines[0].split(",").map(h => h.replace(/"/g, "").trim());

    let inserted = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      const get = (name) => cols[headers.indexOf(name)]?.replace(/"/g, "").trim() || null;
      const name = get("Player");
      const position = get("Pos");
      const age = parseInt(get("Age")) || 22;
      const nationality = get("Nation");
      const goals = parseInt(get("Gls")) || 0;
      const assists = parseInt(get("Ast")) || 0;
      const overall = Math.min(90, Math.max(50, 60 + goals + assists));
      if (!name || name === "Player") continue;

      await pool.execute(
        "INSERT IGNORE INTO players (name, position, overall_rating, potential, age, nationality, pace, shooting, passing, dribbling, defending, physical, reputation, happiness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [name, position, overall, overall + Math.floor(Math.random() * 5), age, nationality, 65, 65, 65, 65, 65, 65, 70, 80]
      );
      inserted++;
    }

    res.json({ success: true, inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve pages
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/game", (req, res) => res.sendFile(path.join(__dirname, "public", "game.html")));

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Football Manager server running on port ${PORT}`);
});

module.exports = { app, io, pool, sendNotification };
