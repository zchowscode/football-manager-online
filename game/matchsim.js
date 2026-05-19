function simulateMatch(homeClub, awayClub, homeTactics, awayTactics, homeSquad, awaySquad) {
  const homeStrength = calculateSquadStrength(homeSquad);
  const awayStrength = calculateSquadStrength(awaySquad);
  const { homeModifier, awayModifier } = calculateTacticalMatchup(homeTactics, awayTactics);
  const homeAdvantage = 1.15;
  const upsetFactor = calculateUpsetFactor(homeStrength.attack, awayStrength.defence);

  const homeLambda = Math.max(0.3,
    (homeStrength.attack / awayStrength.defence) * homeAdvantage * homeModifier * upsetFactor
  );
  const awayLambda = Math.max(0.3,
    (awayStrength.attack / homeStrength.defence) * awayModifier * upsetFactor
  );

  const homeGoals = poissonRandom(homeLambda);
  const awayGoals = poissonRandom(awayLambda);

  const homePossession = Math.min(75, Math.max(25,
    Math.round(50 + (homeTactics.tempo - awayTactics.tempo) * 2 + Math.random() * 10 - 5)
  ));

  const homeScorers = pickScorers(homeSquad, homeGoals);
  const awayScorers = pickScorers(awaySquad, awayGoals);

  return {
    homeGoals, awayGoals,
    homePossession, awayPossession: 100 - homePossession,
    homeShots: Math.round(homeGoals * 4 + Math.random() * 6),
    awayShots: Math.round(awayGoals * 4 + Math.random() * 6),
    homeScorers,
    awayScorers,
    homeStrength,
    awayStrength
  };
}

function pickScorers(squad, goals) {
  if (!goals || !squad.length) return [];
  // Weight players by position and shooting
  const attackers = squad.filter(p => ['ST','LW','RW','CAM'].includes(p.position));
  const midfielders = squad.filter(p => ['CM','CDM','LM','RM'].includes(p.position));
  const defenders = squad.filter(p => ['CB','LB','RB','LWB','RWB'].includes(p.position));

  const pool = [
    ...attackers.map(p => ({ ...p, weight: (p.shooting || 65) * 3 })),
    ...midfielders.map(p => ({ ...p, weight: (p.shooting || 65) * 1.2 })),
    ...defenders.map(p => ({ ...p, weight: (p.shooting || 65) * 0.3 })),
  ];

  if (!pool.length) return [];

  const scorers = [];
  for (let i = 0; i < goals; i++) {
    const scorer = weightedRandom(pool);
    if (scorer) {
      const minute = Math.floor(Math.random() * 90) + 1;
      scorers.push({ player_id: scorer.id, name: scorer.name, minute });
    }
  }
  return scorers.sort((a, b) => a.minute - b.minute);
}

function weightedRandom(pool) {
  const total = pool.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of pool) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return pool[pool.length - 1];
}

function calculateSquadStrength(squad) {
  if (!squad || !squad.length) return { attack: 60, defence: 60 };
  const attackers = squad.filter(p => ['ST','LW','RW','CAM'].includes(p.position));
  const midfielders = squad.filter(p => ['CM','CDM','LM','RM'].includes(p.position));
  const defenders = squad.filter(p => ['CB','LB','RB','LWB','RWB'].includes(p.position));
  const gk = squad.filter(p => p.position === 'GK');

  const avgAttack = avg([
    ...attackers.map(p => p.shooting * 0.4 + p.pace * 0.3 + p.dribbling * 0.3),
    ...midfielders.map(p => p.passing * 0.4 + p.shooting * 0.3 + p.dribbling * 0.3)
  ]) || 65;

  const avgDefence = avg([
    ...defenders.map(p => p.defending * 0.5 + p.physical * 0.3 + p.pace * 0.2),
    ...gk.map(p => p.overall_rating),
    ...midfielders.map(p => p.defending * 0.5)
  ]) || 65;

  return { attack: avgAttack, defence: avgDefence };
}

function calculateTacticalMatchup(h, a) {
  let hm = 1.0, am = 1.0;
  if (h.pressing >= 8 && a.tempo <= 4) hm += 0.12;
  if (a.defensive_line <= 3 && h.attacking_risk >= 7) { am += 0.10; hm -= 0.05; }
  if (h.tempo >= 8) { hm += 0.08; hm -= 0.03; }
  if (h.attacking_risk >= 8) { hm += 0.10; am += 0.08; }
  if (h.mentality === 'attacking' && a.mentality === 'counter') am += 0.08;
  if (h.mentality === 'defensive' && a.mentality === 'attacking') { hm += 0.05; am -= 0.05; }
  if (h.width >= 8 && a.width <= 3) hm += 0.07;
  return { homeModifier: hm, awayModifier: am };
}

function calculateUpsetFactor(attack, defence) {
  const diff = attack - defence;
  if (diff > 20) return 0.85;
  if (diff > 10) return 0.92;
  if (diff < -20) return 1.20;
  if (diff < -10) return 1.10;
  return 1.0;
}

function poissonRandom(lambda) {
  let L = Math.exp(-lambda), k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return Math.min(k - 1, 8);
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

module.exports = { simulateMatch };
