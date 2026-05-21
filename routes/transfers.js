const express = require('express');
const router = express.Router();

// POST A BID / DIRECT SIGN
router.post('/bid', async (req, res) => {
  const { player_id, from_club_id, offered_wage, offered_years, bid_amount } = req.body;
  const pool = req.pool;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[player]] = await conn.execute(
      'SELECT * FROM players WHERE id = ? FOR UPDATE', [player_id]
    );
    if (!player) {
      await conn.rollback();
      return res.status(404).json({ error: 'Player not found' });
    }

    const [[contract]] = await conn.execute(
      'SELECT * FROM contracts WHERE player_id = ? AND active = 1', [player_id]
    );

    const isFreeAgent = !contract;

    // FREE AGENT — sign directly, no fee needed
    if (isFreeAgent) {
      const durationWeeks = (offered_years || 3) * 38;
      await conn.execute(
        'UPDATE contracts SET active = 0 WHERE player_id = ?', [player_id]
      );
      await conn.execute(
        `INSERT INTO contracts (player_id, club_id, weekly_wage, expires_at_week, active, team_type)
         VALUES (?, ?, ?, ?, 1, 'first')`,
        [player_id, from_club_id, offered_wage, durationWeeks]
      );
      await conn.commit();
      return res.json({ success: true, message: `${player.name} signed as a free agent!` });
    }

    // CONTRACTED PLAYER — check no-poach window
    if (contract.no_poach_until_week && contract.no_poach_until_week > (global.currentWeek || 1)) {
      await conn.rollback();
      return res.status(400).json({ error: 'Player recently signed — cannot be approached yet' });
    }

    // Check minimum transfer fee
    const playerValue = Math.round((player.overall_rating || 60) * 900000);
    const minFee = Math.round(playerValue * 0.6);
    const fee = bid_amount || 0;
    if (fee < minFee) {
      await conn.rollback();
      return res.status(400).json({
        error: `Bid too low. Minimum fee is £${minFee.toLocaleString()} (60% of £${playerValue.toLocaleString()} value).`
      });
    }

    // Insert bid record
    const [result] = await conn.execute(
      `INSERT INTO transfer_bids 
        (player_id, from_club_id, to_club_id, bid_amount, offered_wage, offered_years, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 48 HOUR))`,
      [player_id, contract.club_id, from_club_id, fee, offered_wage, offered_years]
    );

    await conn.commit();

    // Notify defending club manager if human
    try {
      const [[defendingClub]] = await pool.execute(
        'SELECT manager_id FROM clubs WHERE id = ?', [contract.club_id]
      );
      if (defendingClub?.manager_id && req.sendNotification) {
        req.sendNotification(
          defendingClub.manager_id,
          'poach_attempt',
          `£${fee.toLocaleString()} bid received for ${player.name}!`,
          { player_id, bid_id: result.insertId, offered_wage, bid_amount: fee }
        );
      }
    } catch(e) {}

    res.json({ success: true, bid_id: result.insertId, message: `Bid submitted for ${player.name}! They will decide within 48 hours.` });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// USE LOYALTY TOKEN
router.post('/loyalty-token/:bid_id', async (req, res) => {
  try {
    await req.pool.execute(
      'UPDATE transfer_bids SET loyalty_token_used = true WHERE id = ?', [req.params.bid_id]
    );
    res.json({ success: true, message: 'Loyalty token used — player much more likely to stay' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// RESOLVE BID
router.post('/resolve/:bid_id', async (req, res) => {
  const pool = req.pool;
  try {
    const [[bid]] = await pool.execute('SELECT * FROM transfer_bids WHERE id = ?', [req.params.bid_id]);
    if (!bid) return res.status(404).json({ error: 'Bid not found' });

    const [[player]] = await pool.execute('SELECT * FROM players WHERE id = ?', [bid.player_id]);
    const [[contract]] = await pool.execute('SELECT * FROM contracts WHERE player_id = ? AND active = 1', [bid.player_id]);

    // Simple accept logic: 70% chance if fee >= value, 40% otherwise
    const playerValue = Math.round((player.overall_rating || 60) * 900000);
    const acceptChance = bid.bid_amount >= playerValue ? 0.7 : 0.4;
    const accepted = Math.random() < acceptChance;

    if (accepted) {
      await pool.execute('UPDATE contracts SET active = 0 WHERE player_id = ? AND active = 1', [bid.player_id]);
      const [[clock]] = await pool.execute('SELECT * FROM game_clock LIMIT 1');
      const durationWeeks = bid.offered_years * 38;
      await pool.execute(
        `INSERT INTO contracts (player_id, club_id, weekly_wage, expires_at_week, active, team_type, no_poach_until_week)
         VALUES (?, ?, ?, ?, 1, 'first', ?)`,
        [bid.player_id, bid.from_club_id, bid.offered_wage, durationWeeks,
         (clock?.current_week || 1) + 8]
      );
      await pool.execute(
        "UPDATE transfer_bids SET status = 'completed', player_decision = 'leave' WHERE id = ?",
        [bid.id]
      );

      // Notify buying manager
      try {
        const [[buyingClub]] = await pool.execute('SELECT manager_id FROM clubs WHERE id = ?', [bid.from_club_id]);
        if (buyingClub?.manager_id && req.sendNotification) {
          req.sendNotification(buyingClub.manager_id, 'contract', `${player.name} has accepted your offer and signed!`, { player_id: player.id });
        }
      } catch(e) {}

      return res.json({ success: true, result: { decision: 'leave', message: `${player.name} accepted and signed!` } });
    } else {
      await pool.execute(
        "UPDATE transfer_bids SET status = 'completed', player_decision = 'stay' WHERE id = ?",
        [bid.id]
      );
      return res.json({ success: true, result: { decision: 'stay', message: `${player.name} decided to stay at their current club.` } });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TRANSFER MARKET
router.get('/market', async (req, res) => {
  const { position, league, search } = req.query;
  try {
    let query = `
      SELECT p.*, cl.name AS club_name, cl.league,
        ROUND(p.overall_rating * 900000) as market_value,
        ROUND(p.overall_rating * 900000 * 0.6) as min_fee
      FROM players p
      LEFT JOIN contracts c ON c.player_id = p.id AND c.active = 1
      LEFT JOIN clubs cl ON cl.id = c.club_id
      WHERE 1=1
    `;
    const params = [];
    if (position) { params.push(position); query += ` AND p.position = ?`; }
    if (league) { params.push(`%${league}%`); query += ` AND cl.league LIKE ?`; }
    if (search) { params.push(`%${search}%`); query += ` AND p.name LIKE ?`; }
    query += ' ORDER BY p.overall_rating DESC LIMIT 500';
    const [rows] = await req.pool.execute(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
