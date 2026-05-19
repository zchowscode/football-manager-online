require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const cron = require("node-cron");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(express.json());
app.use(cors());

// ============================================================
// DATABASE CONNECTION
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.connect()
  .then(() => console.log("Database connected!"))
  .catch((err) => console.error("Database connection error:", err));

// ============================================================
// TRACK ONLINE MANAGERS
// ============================================================
const onlineManagers = new Map(); // socketId -> managerId

// ============================================================
// SOCKET.IO - REAL TIME LAYER
// ============================================================
io.on("connection", (socket) => {
  console.log("Manager connected:", socket.id);

  // Manager joins with their ID
  socket.on("manager:join", async (managerId) => {
    onlineManagers.set(socket.id, managerId);
    socket.join(`manager:${managerId}`);
    console.log(`Manager ${managerId} is online`);

    // Send them any missed notifications
    try {
      const result = await pool.query(
        "SELECT * FROM notifications WHERE manager_id = $1 AND read = false ORDER BY created_at DESC",
        [managerId]
      );
      socket.emit("notifications:unread", result.rows);
    } catch (err) {
      console.error("Error fetching notifications:", err);
    }
  });

  // Manager joins a server/league room
  socket.on("server:join", (serverId) => {
    socket.join(`server:${serverId}`);
    console.log(`Manager joined server room: ${serverId}`);
  });

  // Manager disconnects
  socket.on("disconnect", () => {
    const managerId = onlineManagers.get(socket.id);
    onlineManagers.delete(socket.id);
    console.log(`Manager ${managerId} went offline`);
  });
});

// ============================================================
// HELPER - SEND NOTIFICATION TO A MANAGER
// ============================================================
async function sendNotification(managerId, type, message, data = {}) {
  try {
    // Save to database so offline managers see it when they return
    await pool.query(
      "INSERT INTO notifications (manager_id, type, message, data) VALUES ($1, $2, $3, $4)",
      [managerId, type, message, JSON.stringify(data)]
    );

    // If manager is online push it instantly via Socket.io
    io.to(`manager:${managerId}`).emit("notification:new", {
      type,
      message,
      data,
    });
  } catch (err) {
    console.error("Error sending notification:", err);
  }
}

// ============================================================
// GAME CLOCK - TICKS EVERY 2 REAL DAYS = 1 GAME WEEK
// Cron: runs at midnight every 2 days
// ============================================================
cron.schedule("0 0 */2 * *", async () => {
  console.log("Game clock ticking...");
  try {
    // Advance the game week by 1
    await pool.query(
      "UPDATE game_clock SET current_week = current_week + 1, last_tick = NOW()"
    );

    const clockResult = await pool.query("SELECT * FROM game_clock LIMIT 1");
    const clock = clockResult.rows[0];
    console.log(`Game is now week ${clock.current_week} of season ${clock.current_season}`);

    // Simulate all matches for this week
    await simulateMatchday(clock.current_week, clock.current_season);

    // Check for season end (38 weeks)
    if (clock.current_week >= 38) {
      await endSeason(clock.current_season);
    }

    // Check transfer window (open weeks 1-4 and weeks 20-24)
    const inTransferWindow =
      (clock.current_week >= 1 && clock.current_week <= 4) ||
      (clock.current_week >= 20 && clock.current_week <= 24);

    await pool.query("UPDATE game_clock SET transfer_window_open = $1", [
      inTransferWindow,
    ]);

    // Notify all managers that a new week has started
    const managers = await pool.query("SELECT id FROM managers");
    for (const manager of managers.rows) {
      await sendNotification(
        manager.id,
        "week_start",
        `Week ${clock.current_week} has begun`,
        { week: clock.current_week, transfer_window: inTransferWindow }
      );
    }
  } catch (err) {
    console.error("Game clock error:", err);
  }
});

// ============================================================
// MATCH SIMULATION
// ============================================================
async function simulateMatchday(week, season) {
  try {
    const matches = await pool.query(
      "SELECT * FROM fixtures WHERE week = $1 AND season = $2 AND played = false",
      [week, season]
    );

    for (const match of matches.rows) {
      const homeClub = await pool.query(
        "SELECT * FROM clubs WHERE id = $1",
        [match.home_club_id]
      );
      const awayClub = await pool.query(
        "SELECT * FROM clubs WHERE id = $1",
        [match.away_club_id]
      );

      const homeStrength = homeClub.rows[0].attack_strength;
      const awayStrength = awayClub.rows[0].attack_strength;
      const homeDefence = homeClub.rows[0].defence_strength;
      const awayDefence = awayClub.rows[0].defence_strength;

      // Poisson distribution goal simulation
      const homeLambda = Math.max(0.3, (homeStrength / awayDefence) * 1.3); // home advantage
      const awayLambda = Math.max(0.3, awayStrength / homeDefence);

      const homeGoals = poissonRandom(homeLambda);
      const awayGoals = poissonRandom(awayLambda);

      // Save result
      await pool.query(
        `UPDATE fixtures SET 
          home_goals = $1, 
          away_goals = $2, 
          played = true 
        WHERE id = $3`,
        [homeGoals, awayGoals, match.id]
      );

      // Update league table
      await updateLeagueTable(match, homeGoals, awayGoals);

      // Notify both managers of result
      const result = `${homeClub.rows[0].name} ${homeGoals} - ${awayGoals} ${awayClub.rows[0].name}`;

      if (homeClub.rows[0].manager_id) {
        await sendNotification(
          homeClub.rows[0].manager_id,
          "match_result",
          `Match result: ${result}`,
          { home_goals: homeGoals, away_goals: awayGoals, fixture_id: match.id }
        );
      }
      if (awayClub.rows[0].manager_id) {
        await sendNotification(
          awayClub.rows[0].manager_id,
          "match_result",
          `Match result: ${result}`,
          { home_goals: homeGoals, away_goals: awayGoals, fixture_id: match.id }
        );
      }

      // Broadcast result to server room
      io.to(`server:${match.server_id}`).emit("match:result", {
        fixture_id: match.id,
        result,
        home_goals: homeGoals,
        away_goals: awayGoals,
      });
    }
  } catch (err) {
    console.error("Match simulation error:", err);
  }
}

// Poisson random number generator
function poissonRandom(lambda) {
  let L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}

// Update league table after a result
async function updateLeagueTable(match, homeGoals, awayGoals) {
  const homeWin = homeGoals > awayGoals;
  const awayWin = awayGoals > homeGoals;
  const draw = homeGoals === awayGoals;

  await pool.query(
    `UPDATE league_table SET
      played = played + 1,
      won = won + $1,
      drawn = drawn + $2,
      lost = lost + $3,
      goals_for = goals_for + $4,
      goals_against = goals_against + $5,
      goal_difference = goal_difference + $6,
      points = points + $7
    WHERE club_id = $8 AND server_id = $9`,
    [
      homeWin ? 1 : 0,
      draw ? 1 : 0,
      awayWin ? 1 : 0,
      homeGoals,
      awayGoals,
      homeGoals - awayGoals,
      homeWin ? 3 : draw ? 1 : 0,
      match.home_club_id,
      match.server_id,
    ]
  );

  await pool.query(
    `UPDATE league_table SET
      played = played + 1,
      won = won + $1,
      drawn = drawn + $2,
      lost = lost + $3,
      goals_for = goals_for + $4,
      goals_against = goals_against + $5,
      goal_difference = goal_difference + $6,
      points = points + $7
    WHERE club_id = $8 AND server_id = $9`,
    [
      awayWin ? 1 : 0,
      draw ? 1 : 0,
      homeWin ? 1 : 0,
      awayGoals,
      homeGoals,
      awayGoals - homeGoals,
      awayWin ? 3 : draw ? 1 : 0,
      match.away_club_id,
      match.server_id,
    ]
  );
}

// End of season logic
async function endSeason(season) {
  console.log(`Season ${season} ending...`);
  await pool.query(
    "UPDATE game_clock SET current_week = 1, current_season = current_season + 1"
  );
  // TODO: promotion/relegation logic here
}

// ============================================================
// ROUTES
// ============================================================

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Football Manager server running" });
});

// Get game clock state
app.get("/api/clock", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM game_clock LIMIT 1");
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get league table for a server
app.get("/api/table/:serverId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT lt.*, c.name as club_name, c.badge_url 
       FROM league_table lt
       JOIN clubs c ON lt.club_id = c.id
       WHERE lt.server_id = $1
       ORDER BY lt.points DESC, lt.goal_difference DESC`,
      [req.params.serverId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get fixtures for a server
app.get("/api/fixtures/:serverId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM fixtures WHERE server_id = $1 ORDER BY week ASC",
      [req.params.serverId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get squad for a club
app.get("/api/squad/:clubId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, c.expires_at, c.weekly_wage 
       FROM players p
       JOIN contracts c ON p.id = c.player_id
       WHERE c.club_id = $1 AND c.active = true
       ORDER BY p.overall_rating DESC`,
      [req.params.clubId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark notification as read
app.post("/api/notifications/:id/read", async (req, res) => {
  try {
    await pool.query("UPDATE notifications SET read = true WHERE id = $1", [
      req.params.id,
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Football Manager server running on port ${PORT}`);
});

module.exports = { app, io, pool, sendNotification };
