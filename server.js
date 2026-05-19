require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");
const cron = require("node-cron");
const cors = require("cors");
const path = require("path");

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

// Make sendNotification available to routes
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
    global.currentWeek = clock.current_week;
    console.log(`Game week ${clock.current_week} season ${clock.current_season}`);

    await simulateMatchday(clock.current_week, clock.current_season);

    if (clock.current_week >= 38) await endSeason(clock.current_season);

    const inWindow = (clock.current_week >= 1 && clock.current_week <= 4) ||
                     (clock.current_week >= 20 && clock.current_week <= 24);
    await pool.execute("UPDATE game_clock SET transfer_window_open = ?", [inWindow]);

    const [managers] = await pool.execute("SELECT id FROM managers WHERE is_ai = false");
    for (const m of managers) {
      await sendNotification(m.id, "week_start", `Week ${clock.current_week} has begun`,
        { week: clock.current_week, transfer_window: inWindow });
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

    for (const match of matches) {
      const [[homeClub]] = await pool.execute("SELECT * FROM clubs WHERE id = ?", [match.home_club_id]);
      const [[awayClub]] = await pool.execute("SELECT * FROM clubs WHERE id = ?", [match.away_club_id]);

      const homeLambda = Math.max(0.3, (homeClub.attack_strength / awayClub.defence_strength) * 1.3);
      const awayLambda = Math.max(0.3, awayClub.attack_strength / homeClub.defence_strength);

      const homeGoals = poissonRandom(homeLambda);
      const awayGoals = poissonRandom(awayLambda);

      await pool.execute(
        "UPDATE fixtures SET home_goals = ?, away_goals = ?, played = true WHERE id = ?",
        [homeGoals, awayGoals, match.id]
      );

      await updateLeagueTable(match, homeGoals, awayGoals);

      const result = `${homeClub.name} ${homeGoals} - ${awayGoals} ${awayClub.name}`;

      if (homeClub.manager_id) {
        await sendNotification(homeClub.manager_id, "match_result", `Result: ${result}`,
          { home_goals: homeGoals, away_goals: awayGoals });
      }
      if (awayClub.manager_id) {
        await sendNotification(awayClub.manager_id, "match_result", `Result: ${result}`,
          { home_goals: homeGoals, away_goals: awayGoals });
      }

      io.to(`server:${match.server_id}`).emit("match:result", {
        fixture_id: match.id, result, home_goals: homeGoals, away_goals: awayGoals,
      });
    }
  } catch (err) {
    console.error("Match sim error:", err.message);
  }
}

function poissonRandom(lambda) {
  let L = Math.exp(-lambda), k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return Math.min(k - 1, 8);
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
    [homeWin?1:0, draw?1:0, awayWin?1:0,
     homeGoals, awayGoals, homeGoals - awayGoals,
     homeWin?3:draw?1:0, match.home_club_id, match.server_id]
  );

  await pool.execute(
    `UPDATE league_table SET
      played = played + 1,
      won = won + ?, drawn = drawn + ?, lost = lost + ?,
      goals_for = goals_for + ?, goals_against = goals_against + ?,
      goal_difference = goal_difference + ?, points = points + ?
     WHERE club_id = ? AND server_id = ?`,
    [awayWin?1:0, draw?1:0, homeWin?1:0,
     awayGoals, homeGoals, awayGoals - homeGoals,
     awayWin?3:draw?1:0, match.away_club_id, match.server_id]
  );
}

async function endSeason(season) {
  console.log(`Season ${season} ending...`);
  await pool.execute("UPDATE game_clock SET current_week = 1, current_season = current_season + 1");
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
      `SELECT p.*, c.expires_at_week, c.weekly_wage
       FROM players p
       JOIN contracts c ON p.id = c.player_id
       WHERE c.club_id = ? AND c.active = true
       ORDER BY p.overall_rating DESC`,
      [req.params.clubId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fixtures
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
    await pool.execute("UPDATE notifications SET `read` = true WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Mark all notifications read
app.post("/api/notifications/:managerId/read-all", async (req, res) => {
  try {
    await pool.execute("UPDATE notifications SET `read` = true WHERE manager_id = ?", [req.params.managerId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Transfer market
app.get("/api/transfers/market", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT p.*, cl.name AS club_name, cl.league
       FROM players p
       LEFT JOIN contracts c ON c.player_id = p.id AND c.active = 1
       LEFT JOIN clubs cl ON cl.id = c.club_id
       ORDER BY p.overall_rating DESC LIMIT 500`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Promote youth player
app.post("/api/squad/promote/:id", async (req, res) => {
  try {
    await pool.execute("UPDATE contracts SET team_type = 'first' WHERE player_id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/csv-headers', (req, res) => {
  const fs = require('fs');
  const text = fs.readFileSync(path.join(__dirname, 'players_data_light-2025_2026.csv'), 'utf8');
  const headers = text.split('\n')[0];
  res.json({ headers });
});
// Seed players from CSV
const fs = require('fs');

app.get('/api/seed-players', async (req, res) => {
  try {
   const csvPath = path.join(__dirname, 'players_data_light-2025_2026.csv');
    const text = fs.readFileSync(csvPath, 'utf8');
    const lines = text.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());

    let inserted = 0;

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const get = (name) => cols[headers.indexOf(name)]?.replace(/"/g, '').trim() || null;

      const name = get('player');
      const position = get('position');
      const age = parseInt(get('age')) || 22;
      const nationality = get('nationality');
      const overall = Math.min(99, Math.max(40, parseInt(get('overall_rating') || get('rating') || get('ova')) || 70));

      if (!name) continue;

      await pool.execute(
        "INSERT IGNORE INTO players (name, position, overall_rating, potential, age, nationality, pace, shooting, passing, dribbling, defending, physical, reputation, happiness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [name, position, overall, overall + Math.floor(Math.random()*5), age, nationality,
         parseInt(get('pace'))||65, parseInt(get('shooting'))||65, parseInt(get('passing'))||65,
         parseInt(get('dribbling'))||65, parseInt(get('defending'))||65, parseInt(get('physical'))||65,
         70, 80]
      );
      inserted++;
    }

    res.json({ success: true, inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Serve login page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Serve game page
app.get("/game", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "game.html"));
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Football Manager server running on port ${PORT}`);
});

module.exports = { app, io, pool, sendNotification };
