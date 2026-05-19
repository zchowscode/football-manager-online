function calculatePlayerDecision(player, contract, currentClub, biddingClub, bid) {
  let score = 0;
  const notes = [];

  // LOYALTY - how long at current club
  const weeksAtClub = contract.duration_weeks - (contract.expires_at_week - (global.currentWeek || 1));
  const loyaltyBonus = Math.min(40, weeksAtClub * 0.8);
  score += loyaltyBonus;
  if (loyaltyBonus > 20) notes.push(`Loyal to ${currentClub.name}`);

  // HAPPINESS
  const happinessScore = (player.happiness - 50) * 0.6;
  score += happinessScore;
  if (player.happiness > 70) notes.push('Happy at current club');
  if (player.happiness < 40) notes.push('Unsettled, open to leaving');

  // PRESTIGE DIFFERENCE
  const prestigeDiff = biddingClub.prestige - currentClub.prestige;
  if (prestigeDiff > 15) { score -= 20; notes.push('Big step up in prestige'); }
  else if (prestigeDiff > 5) { score -= 10; notes.push('Slightly bigger club'); }
  else if (prestigeDiff < -15) { score += 25; notes.push('Would be a step down'); }
  else if (prestigeDiff < -5) { score += 10; notes.push('Slight step down'); }

  // WAGE DIFFERENCE - money matters but not everything
  const wageIncrease = ((bid.offered_wage - contract.weekly_wage) / contract.weekly_wage) * 100;
  if (wageIncrease > 100) { score -= 25; notes.push('Massive wage increase offered'); }
  else if (wageIncrease > 50) { score -= 15; notes.push('Big wage increase'); }
  else if (wageIncrease > 25) { score -= 8; notes.push('Better wages offered'); }
  else if (wageIncrease < 0) { score += 20; notes.push('Pay cut - very unlikely to leave'); }
  else if (wageIncrease < 10) { score += 10; notes.push('Minimal wage improvement'); }

  // CONTRACT LENGTH offered
  if (bid.offered_years >= 4) score -= 8;
  else if (bid.offered_years <= 1) score += 10;

  // LEAGUE POSITION - winning clubs keep players
  if (currentClub.league_position && currentClub.league_position <= 4) {
    score += 15;
    notes.push('Current club in top 4');
  }

  // AGE - older players chase final big contract
  if (player.age >= 32) score -= 10;
  if (player.age <= 22) score += 5;

  // WORLD CLASS players won't go to lesser clubs
  if (player.reputation >= 85 && biddingClub.prestige < 70) {
    score += 30;
    notes.push('World class player, club not at his level');
  }

  // RECENTLY SIGNED - no-poach window
  if (contract.no_poach_until_week > (global.currentWeek || 1)) {
    score += 50;
    notes.push('Just signed new contract - very unlikely to leave');
  }

  // LOYALTY TOKEN used by defending manager
  if (bid.loyalty_token_used) {
    score -= 20;
    notes.push('Manager personally persuaded player to stay');
  }

  const stayProbability = Math.min(95, Math.max(5, 50 + score));
  const decision = Math.random() * 100 < stayProbability ? 'stay' : 'leave';

  return { decision, stayProbability: Math.round(stayProbability), score: Math.round(score), notes };
}

module.exports = { calculatePlayerDecision };
