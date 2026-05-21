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
// RESOLVE EXPIRED TRANSFER BIDS - every hour
// ============================================================
cron.schedule("0 * * * *", async () => {
  try {
    const [expiredBids] = await pool.execute(
      "SELECT * FROM transfer_bids WHERE status = 'pending' AND expires_at < NOW()"
    );
    for (const bid of expiredBids) {
      const [[player]] = await pool.execute('SELECT * FROM players WHERE id = ?', [bid.player_id]);
      const [[contract]] = await pool.execute('SELECT * FROM contracts WHERE player_id = ? AND active = 1', [bid.player_id]);
      const [[currentClub]] = await pool.execute('SELECT * FROM clubs WHERE id = ?', [bid.to_club_id]);
      const [[biddingClub]] = await pool.execute('SELECT * FROM clubs WHERE id = ?', [bid.from_club_id]);

      const { calculatePlayerDecision } = require('./game/poaching');
      const result = calculatePlayerDecision(player, contract, currentClub, biddingClub, bid);

      if (result.decision === 'leave') {
        await pool.execute('UPDATE contracts SET active = 0 WHERE player_id = ? AND active = 1', [bid.player_id]);
        const [[clock]] = await pool.execute('SELECT * FROM game_clock LIMIT 1');
        await pool.execute(
          `INSERT INTO contracts (player_id, club_id, weekly_wage, expires_at_week, active, team_type)
           VALUES (?, ?, ?, ?, 1, 'first')`,
          [bid.player_id, bid.from_club_id, bid.offered_wage, clock.current_week + bid.offered_years * 38]
        );
        await pool.execute("UPDATE transfer_bids SET status = 'completed', player_decision = 'leave' WHERE id = ?", [bid.id]);

        const [[biddingClubFull]] = await pool.execute('SELECT manager_id FROM clubs WHERE id = ?', [bid.from_club_id]);
        if (biddingClubFull?.manager_id) {
          await sendNotification(biddingClubFull.manager_id, 'contract', `✅ ${player.name} has agreed to join your club!`, { player_id: bid.player_id });
        }
        const [[defendingClubFull]] = await pool.execute('SELECT manager_id FROM clubs WHERE id = ?', [bid.to_club_id]);
        if (defendingClubFull?.manager_id) {
          await sendNotification(defendingClubFull.manager_id, 'contract', `❌ ${player.name} has left to join another club.`, { player_id: bid.player_id });
        }
      } else {
        await pool.execute("UPDATE transfer_bids SET status = 'completed', player_decision = 'stay' WHERE id = ?", [bid.id]);
        const [[biddingClubFull]] = await pool.execute('SELECT manager_id FROM clubs WHERE id = ?', [bid.from_club_id]);
        if (biddingClubFull?.manager_id) {
          await sendNotification(biddingClubFull.manager_id, 'contract', `❌ ${player.name} has rejected your offer and decided to stay.`, { player_id: bid.player_id });
        }
      }
    }
  } catch (err) {
    console.error('Bid resolution error:', err.message);
  }
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

      // PATCH 3: enriched match:result payload so the frontend result modal works
      io.to(`server:${match.server_id}`).emit('match:result', {
        fixture_id:       match.id,
        home_club_id:     match.home_club_id,
        away_club_id:     match.away_club_id,
        home_team:        homeClub.name,
        away_team:        awayClub.name,
        week:             week,
        home_goals:       result.homeGoals,
        away_goals:       result.awayGoals,
        home_possession:  result.homePossession,
        away_possession:  result.awayPossession,
        home_shots:       result.homeShots,
        away_shots:       result.awayShots,
        scorers:          scorersSummary
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

// PATCH 2: Fixtures for a server — JOINs club names
app.get("/api/fixtures/:serverId", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT f.*,
         hc.name AS home_club_name,
         ac.name AS away_club_name
       FROM fixtures f
       JOIN clubs hc ON hc.id = f.home_club_id
       JOIN clubs ac ON ac.id = f.away_club_id
       WHERE f.server_id = ?
       ORDER BY f.week ASC`,
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

// PATCH 1: Seed players — derives real per-position stats from CSV
// CSV uses TABS as delimiters
app.get("/api/seed-players", async (req, res) => {
  try {
    const csvPath = path.join(__dirname, "players_data_light-2025_2026.csv");
    const text = fs.readFileSync(csvPath, "utf8");
    const lines = text.trim().split(/\r?\n/);
    const headers = lines[0].split(",").map(h => h.replace(/"/g, "").trim());

    const getCol = (cols, name) => {
      const idx = headers.indexOf(name);
      return idx >= 0 ? (cols[idx] || "").replace(/"/g, "").trim() : "0";
    };

    const clamp = (v, min, max) => Math.min(max, Math.max(min, Math.round(v)));
    const norm = (raw, base, scale, min = 40, max = 95) =>
      clamp(65 + (raw - base) * scale, min, max);

    let inserted = 0, updated = 0;

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split("\t");
      const name = getCol(cols, "Player");
      if (!name || name === "Player" || name === "") continue;

      const rawPos   = getCol(cols, "Pos") || "MF";
      const age      = parseFloat(getCol(cols, "Age")) || 22;
      const nation   = getCol(cols, "Nation") || "";
      const mp       = parseFloat(getCol(cols, "MP")) || 1;
      const starts   = parseFloat(getCol(cols, "Starts")) || 0;
      const nineties = Math.max(parseFloat(getCol(cols, "90s")) || 0.5, 0.5);
      const gls      = parseFloat(getCol(cols, "Gls")) || 0;
      const ast      = parseFloat(getCol(cols, "Ast")) || 0;
      const sh       = parseFloat(getCol(cols, "Sh")) || 0;
      const sot      = parseFloat(getCol(cols, "SoT")) || 0;
      const crs      = parseFloat(getCol(cols, "Crs")) || 0;
      const tklW     = parseFloat(getCol(cols, "TklW")) || 0;
      const intc     = parseFloat(getCol(cols, "Int")) || 0;
      const fld      = parseFloat(getCol(cols, "Fld")) || 0;
      const fls      = parseFloat(getCol(cols, "Fls")) || 0;
      const minPlyd  = parseFloat(getCol(cols, "Min")) || 0;

      // Per-90 rates
      const glsP90 = gls / nineties;
      const astP90 = ast / nineties;
      const shP90  = sh  / nineties;
      const sotP90 = sot / nineties;
      const crsP90 = crs / nineties;
      const tklP90 = tklW / nineties;
      const intP90 = intc / nineties;
      const fldP90 = fld / nineties;

      const primaryPos = rawPos.split(",")[0].trim();
      const isGK = primaryPos === "GK";
      const isFW = primaryPos === "FW";
      const isDF = primaryPos === "DF";

      // Overall rating
      let overall;
      if (isGK) {
        const savePct = parseFloat(getCol(cols, "Save%")) || 65;
        const csPct   = parseFloat(getCol(cols, "CS%"))   || 0;
        const ga90    = parseFloat(getCol(cols, "GA90"))  || 2;
        overall = clamp(savePct * 0.5 + csPct * 0.3 + (2.5 - ga90) * 8 + 40, 50, 90);
      } else if (isFW) {
        overall = clamp(60 + glsP90 * 18 + astP90 * 8 + sotP90 * 3, 50, 92);
      } else if (isDF) {
        overall = clamp(60 + tklP90 * 10 + intP90 * 10 - fls * 0.08, 50, 90);
      } else {
        overall = clamp(60 + glsP90 * 12 + astP90 * 12 + tklP90 * 6 + crsP90 * 2, 50, 91);
      }

      // Individual stats
      let pace, shooting, passing, dribbling, defending, physical;

      if (isGK) {
        const savePct = parseFloat(getCol(cols, "Save%")) || 65;
        pace      = clamp(50 + Math.random() * 15, 45, 70);
        shooting  = clamp(35 + Math.random() * 10, 30, 50);
        passing   = clamp(55 + crsP90 * 4, 50, 78);
        dribbling = clamp(45 + Math.random() * 12, 40, 62);
        defending = clamp(savePct * 0.92 + 4, 55, 92);
        physical  = clamp(60 + (minPlyd / 2700) * 15, 55, 85);
      } else {
        pace      = norm(fldP90 + (29 - Math.min(age, 35)) * 0.2, 1.5, 11);
        shooting  = norm(glsP90 * 2 + sotP90 * 0.8, 0.6, 16);
        passing   = norm(astP90 * 2.5 + crsP90 * 0.25, 0.5, 18);
        dribbling = norm(fldP90 * 1.2, 1.2, 13);
        const defMult = isDF ? 1.5 : 1.0;
        defending = norm((tklP90 + intP90) * defMult, 2.0, 9);
        const startRatio = mp > 0 ? starts / mp : 0.5;
        physical  = norm(startRatio * 5 + fls * 0.04, 3.0, 10);
      }

      // Potential
      const bonus = age <= 20 ? 10 : age <= 22 ? 7 : age <= 24 ? 4 : age <= 27 ? 2 : 0;
      const potential = clamp(overall + Math.floor(Math.random() * (bonus + 1)), overall, 96);

      // Nationality: "us USA" → "USA"
      const nationality = nation.split(" ").slice(-1)[0] || nation;

      const reputation = clamp(overall * 0.8 + (mp / 38) * 10, 30, 99);

      // Upsert
      const [existing] = await pool.execute(
        "SELECT id FROM players WHERE name = ? LIMIT 1", [name]
      );

      if (existing.length > 0) {
        await pool.execute(
          `UPDATE players SET
            position=?, overall_rating=?, potential=?, age=?, nationality=?,
            pace=?, shooting=?, passing=?, dribbling=?, defending=?, physical=?,
            reputation=?
           WHERE id=?`,
          [primaryPos, overall, potential, Math.round(age), nationality,
           pace, shooting, passing, dribbling, defending, physical,
           reputation, existing[0].id]
        );
        updated++;
      } else {
        await pool.execute(
          `INSERT INTO players
            (name, position, overall_rating, potential, age, nationality,
             pace, shooting, passing, dribbling, defending, physical,
             reputation, happiness)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,80)`,
          [name, primaryPos, overall, potential, Math.round(age), nationality,
           pace, shooting, passing, dribbling, defending, physical, reputation]
        );
        inserted++;
      }
    }

    res.json({ success: true, inserted, updated });
  } catch (err) {
    console.error("Seed error:", err);
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
