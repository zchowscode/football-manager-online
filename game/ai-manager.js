const { simulateMatch } = require('./matchsim');

// AI decision making for clubs without human managers

async function runAIManagers(pool) {
  try {
    const [aiClubs] = await pool.query(`
      SELECT c.* FROM clubs c
      LEFT JOIN managers m ON m.club_id = c.id AND m.is_ai = 0
      WHERE m.id IS NULL OR m.is_ai = 1
    `);
    for (const club of aiClubs) {
      await aiManageTransfers(pool, club);
      await aiSetTactics(pool, club);
    }
  } catch(e) { console.log('AI manager error:', e.message); }
}

async function aiManageTransfers(pool, club) {
  try {
    const [squad] = await pool.query(`
      SELECT p.*, c.weekly_wage, c.expires_at_week
      FROM players p
      JOIN contracts c ON c.player_id = p.id AND c.club_id = ? AND c.active = 1
    `, [club.id]);

    const [clock] = await pool.query('SELECT * FROM game_clock ORDER BY id DESC LIMIT 1');
    const currentWeek = clock[0]?.current_week || 1;

    // Renew expiring contracts
    for (const player of squad) {
      if (player.expires_at_week && player.expires_at_week - currentWeek < 10) {
        const newWage = Math.round(player.weekly_wage * (1 + Math.random() * 0.2));
        const newExpiry = currentWeek + 104; // 2 seasons
        await pool.query(`
          UPDATE contracts SET weekly_wage = ?, expires_at_week = ?
          WHERE player_id = ? AND club_id = ? AND active = 1
        `, [newWage, newExpiry, player.id, club.id]);
      }
    }

    // If squad is thin, try signing a free agent
    if (squad.length < 18) {
      const [freeAgents] = await pool.query(`
        SELECT p.* FROM players p
        LEFT JOIN contracts c ON c.player_id = p.id AND c.active = 1
        WHERE c.id IS NULL
        ORDER BY p.overall_rating DESC
        LIMIT 5
      `);
      if (freeAgents.length) {
        const pick = freeAgents[Math.floor(Math.random() * freeAgents.length)];
        const wage = Math.round(pick.overall_rating * 500 * (0.8 + Math.random() * 0.4));
        await pool.query(`
          INSERT INTO contracts (player_id, club_id, weekly_wage, expires_at_week, active, team_type)
          VALUES (?, ?, ?, ?, 1, 'first')
        `, [pick.id, club.id, wage, currentWeek + 104]);
      }
    }
  } catch(e) { console.log('AI transfer error:', e.message); }
}

async function aiSetTactics(pool, club) {
  try {
    // AI picks a formation based on club prestige
    const formations = ['4-3-3','4-4-2','4-2-3-1','3-5-2','5-3-2'];
    const formation = formations[Math.floor(Math.random() * formations.length)];
    const mentalities = ['balanced','attacking','defensive','counter'];
    const mentality = club.prestige >= 75
      ? (Math.random() > 0.4 ? 'attacking' : 'balanced')
      : (Math.random() > 0.5 ? 'defensive' : 'counter');

    await pool.query(`
      INSERT INTO tactics (club_id, formation, pressing, defensive_line, tempo, width, attacking_risk, mentality)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        formation=VALUES(formation), pressing=VALUES(pressing), defensive_line=VALUES(defensive_line),
        tempo=VALUES(tempo), width=VALUES(width), attacking_risk=VALUES(attacking_risk), mentality=VALUES(mentality)
    `, [
      club.id, formation,
      Math.round(4 + Math.random() * 5),
      Math.round(4 + Math.random() * 5),
      Math.round(4 + Math.random() * 5),
      Math.round(4 + Math.random() * 4),
      Math.round(3 + Math.random() * 5),
      mentality
    ]);
  } catch(e) { console.log('AI tactics error:', e.message); }
}

async function runAIMatchDay(pool, fixture) {
  try {
    const [homeSquad] = await pool.query(`
      SELECT p.* FROM players p
      JOIN contracts c ON c.player_id = p.id AND c.club_id = ? AND c.active = 1
      ORDER BY p.overall_rating DESC LIMIT 11
    `, [fixture.home_club_id]);

    const [awaySquad] = await pool.query(`
      SELECT p.* FROM players p
      JOIN contracts c ON c.player_id = p.id AND c.club_id = ? AND c.active = 1
      ORDER BY p.overall_rating DESC LIMIT 11
    `, [fixture.away_club_id]);

    const [homeTacticsRows] = await pool.query('SELECT * FROM tactics WHERE club_id = ?', [fixture.home_club_id]);
    const [awayTacticsRows] = await pool.query('SELECT * FROM tactics WHERE club_id = ?', [fixture.away_club_id]);

    const defaultTactics = { pressing:6, defensive_line:5, tempo:6, width:5, attacking_risk:5, mentality:'balanced' };
    const homeTactics = homeTacticsRows[0] || defaultTactics;
    const awayTactics = awayTacticsRows[0] || defaultTactics;

    const [homeClubRows] = await pool.query('SELECT * FROM clubs WHERE id = ?', [fixture.home_club_id]);
    const [awayClubRows] = await pool.query('SELECT * FROM clubs WHERE id = ?', [fixture.away_club_id]);

    const result = simulateMatch(homeClubRows[0], awayClubRows[0], homeTactics, awayTactics, homeSquad, awaySquad);

    // Save result
    await pool.query(`
      UPDATE fixtures SET
        home_goals = ?, away_goals = ?,
        home_possession = ?, away_possession = ?,
        home_shots = ?, away_shots = ?,
        played = 1
      WHERE id = ?
    `, [result.homeGoals, result.awayGoals, result.homePossession, result.awayPossession, result.homeShots, result.awayShots, fixture.id]);

    // Update league table
    await updateTable(pool, fixture, result);

    // Notify human managers
    await notifyManagers(pool, fixture, result, homeClubRows[0], awayClubRows[0]);

    // Develop players slightly
    await developPlayers(pool, homeSquad.concat(awaySquad));

    return result;
  } catch(e) { console.log('Match day error:', e.message); return null; }
}

async function updateTable(pool, fixture, result) {
  const { homeGoals, awayGoals } = result;
  const homeWin = homeGoals > awayGoals;
  const awayWin = awayGoals > homeGoals;
  const draw = homeGoals === awayGoals;

  await pool.query(`
    INSERT INTO league_table (server_id, club_id, played, won, drawn, lost, goals_for, goals_against, goal_difference, points)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      played = played + 1,
      won = won + VALUES(won),
      drawn = drawn + VALUES(drawn),
      lost = lost + VALUES(lost),
      goals_for = goals_for + VALUES(goals_for),
      goals_against = goals_against + VALUES(goals_against),
      goal_difference = goal_difference + VALUES(goal_difference),
      points = points + VALUES(points)
  `, [
    fixture.server_id, fixture.home_club_id, 1,
    homeWin?1:0, draw?1:0, awayWin?1:0,
    homeGoals, awayGoals, homeGoals-awayGoals,
    homeWin?3:draw?1:0
  ]);

  await pool.query(`
    INSERT INTO league_table (server_id, club_id, played, won, drawn, lost, goals_for, goals_against, goal_difference, points)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      played = played + 1,
      won = won + VALUES(won),
      drawn = drawn + VALUES(drawn),
      lost = lost + VALUES(lost),
      goals_for = goals_for + VALUES(goals_for),
      goals_against = goals_against + VALUES(goals_against),
      goal_difference = goal_difference + VALUES(goal_difference),
      points = points + VALUES(points)
  `, [
    fixture.server_id, fixture.away_club_id, 1,
    awayWin?1:0, draw?1:0, homeWin?1:0,
    awayGoals, homeGoals, awayGoals-homeGoals,
    awayWin?3:draw?1:0
  ]);
}

async function notifyManagers(pool, fixture, result, homeClub, awayClub) {
  const { homeGoals, awayGoals } = result;
  const score = `${homeGoals}-${awayGoals}`;

  // Find human managers for either club
  const [managers] = await pool.query(`
    SELECT m.id AS manager_id, m.club_id FROM managers m
    WHERE (m.club_id = ? OR m.club_id = ?) AND m.is_ai = 0
  `, [fixture.home_club_id, fixture.away_club_id]);

  for (const mgr of managers) {
    const isHome = mgr.club_id === fixture.home_club_id;
    const myGoals = isHome ? homeGoals : awayGoals;
    const theirGoals = isHome ? awayGoals : homeGoals;
    const opponent = isHome ? awayClub.name : homeClub.name;
    const outcome = myGoals > theirGoals ? 'Win' : myGoals < theirGoals ? 'Loss' : 'Draw';
    const msg = `${outcome} ${myGoals}-${theirGoals} vs ${opponent}`;

    await pool.query(`
      INSERT INTO notifications (manager_id, type, message)
      VALUES (?, 'match_result', ?)
    `, [mgr.manager_id, msg]);
  }
}

async function developPlayers(pool, players) {
  for (const player of players) {
    if (player.age >= 30) continue; // veterans don't develop
    const growthChance = player.age <= 21 ? 0.3 : player.age <= 25 ? 0.15 : 0.05;
    if (Math.random() < growthChance) {
      const stat = ['pace','shooting','passing','dribbling','defending','physical'][Math.floor(Math.random()*6)];
      const gain = Math.random() < 0.8 ? 1 : 2;
      await pool.query(`UPDATE players SET ${stat} = LEAST(99, ${stat} + ?), overall_rating = LEAST(99, overall_rating + 1) WHERE id = ?`, [gain, player.id]);
    }
  }
}

module.exports = { runAIManagers, runAIMatchDay };
