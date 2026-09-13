import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  byeTeams,
  projectedPoints,
  canFill,
  assign,
  optimize,
  findProblems,
  slotChanges,
  buildReport,
  auditRoster,
  startedTeams,
} from '../advise.mjs';

const P = {
  qb1: { first_name: 'Dak', last_name: 'Prescott', team: 'DAL', position: 'QB', fantasy_positions: ['QB'] },
  qb2: { first_name: 'Jared', last_name: 'Goff', team: 'DET', position: 'QB', fantasy_positions: ['QB'] },
  rb1: { first_name: 'Jonathan', last_name: 'Taylor', team: 'IND', position: 'RB', fantasy_positions: ['RB'] },
  wr1: { first_name: 'Puka', last_name: 'Nacua', team: 'LAR', position: 'WR', fantasy_positions: ['WR'] },
  te1: { first_name: 'Mark', last_name: 'Andrews', team: 'BAL', position: 'TE', fantasy_positions: ['TE'] },
  hurt: { first_name: 'Saquon', last_name: 'Barkley', team: 'PHI', position: 'RB', fantasy_positions: ['RB'], injury_status: 'Out' },
  quest: { first_name: 'Terry', last_name: 'McLaurin', team: 'WAS', position: 'WR', fantasy_positions: ['WR'], injury_status: 'Questionable' },
  gone: { first_name: 'Retired', last_name: 'Guy', team: null, position: 'WR', fantasy_positions: ['WR'] },
};

const GAMES = [
  { week: 1, home: 'DAL', away: 'IND' },
  { week: 1, home: 'LAR', away: 'BAL' },
  { week: 2, home: 'DAL', away: 'LAR' },
  // IND and BAL have no week-2 game, so they are on bye.
];

test('bye teams are the ones with no game that week', () => {
  assert.deepEqual([...byeTeams(GAMES, 1)].sort(), []);
  assert.deepEqual([...byeTeams(GAMES, 2)].sort(), ['BAL', 'IND']);
});

test('projected points use the league scoring, including TE premium', () => {
  const scoring = { rec: 1, rec_yd: 0.1, rec_td: 6, bonus_rec_te: 0.5 };
  const stats = { rec: 4, rec_yd: 42, rec_td: 0.4, bonus_rec_te: 4, pts_ppr: 10.8, adp_dd_ppr: 55 };
  // 4 + 4.2 + 2.4 + 2.0 = 12.6; pts_ppr and adp are not scoring keys and must be ignored.
  assert.equal(Number(projectedPoints(stats, scoring).toFixed(2)), 12.6);
  assert.equal(projectedPoints(null, scoring), 0);
});

test('flex slots accept what they should', () => {
  assert.equal(canFill('FLEX', P.rb1), true);
  assert.equal(canFill('FLEX', P.qb1), false);
  assert.equal(canFill('SUPER_FLEX', P.qb1), true);
  assert.equal(canFill('QB', P.rb1), false);
});

test('assignment is optimal, not merely greedy', () => {
  // QB slot can only take a QB; SUPER_FLEX can take anyone. Spending SUPER_FLEX on the best QB
  // and leaving the weaker QB in the QB slot scores 19; the optimal split scores 35.
  const slots = ['QB', 'SUPER_FLEX'];
  const roster = ['qb1', 'qb2', 'rb1'];
  const pts = { qb1: 10, qb2: 9, rb1: 25 };
  const { lineup, total } = optimize(slots, roster, P, (id) => pts[id]);
  assert.equal(total, 35);
  assert.equal(lineup[0], 'qb1');
  assert.equal(lineup[1], 'rb1');
});

test('a slot with nobody eligible stays empty rather than taking an illegal player', () => {
  const { lineup, total } = optimize(['QB'], ['rb1'], P, () => 10);
  assert.deepEqual(lineup, [null]);
  assert.equal(total, 0);
});

test('must-fix catches byes, ruled-out players, empty slots and departures', () => {
  const slots = ['QB', 'RB', 'WR', 'TE', 'FLEX'];
  const starters = ['qb1', 'hurt', 'gone', 'te1', '0'];
  const problems = findProblems(slots, starters, P, byeTeams(GAMES, 2));
  const must = problems.filter((p) => p.level === 'must').map((p) => p.text);

  assert.equal(must.length, 4);
  assert.match(must[0], /Saquon Barkley \(RB\) — Out/);
  assert.match(must[1], /Retired Guy \(WR\) — no longer on an NFL roster/);
  assert.match(must[2], /Mark Andrews \(TE\) — BAL on bye/);
  assert.match(must[3], /FLEX slot is empty/);
  // Dak plays in week 2 and is healthy, so he must not be flagged.
  assert.equal(problems.some((p) => p.text.includes('Dak')), false);
});

test('questionable is a monitor, not a must-fix', () => {
  const problems = findProblems(['WR'], ['quest'], P, new Set());
  assert.deepEqual(problems.map((p) => p.level), ['watch']);
  assert.match(problems[0].text, /Terry McLaurin \(WR\) — Questionable/);
});

test('changes are reported per slot type, so each one is an executable move', () => {
  const pts = { rb1: 20, wr1: 18, te1: 5, qb1: 2 };
  const changes = slotChanges(['RB', 'WR'], ['te1', 'qb1'], ['rb1', 'wr1'], P, (id) => pts[id]);
  assert.deepEqual(changes.map((c) => c.slot), ['RB', 'WR']);
  assert.match(changes[0].incoming[0], /Jonathan Taylor \(RB, 20.0\)/);
  assert.match(changes[0].outgoing[0].label, /Mark Andrews \(TE, 5.0\)/);
  assert.equal(changes[0].outgoing[0].keepsStarting, false);
});

test('an unchanged slot produces no instruction', () => {
  const changes = slotChanges(['RB', 'WR'], ['rb1', 'qb1'], ['rb1', 'wr1'], P, () => 10);
  assert.deepEqual(changes.map((c) => c.slot), ['WR']);
});

test('shuffling between identical FLEX slots is not reported at all', () => {
  // Same two players, opposite slots: interchangeable, so there is nothing to tell anyone.
  const changes = slotChanges(['FLEX', 'FLEX'], ['rb1', 'wr1'], ['wr1', 'rb1'], P, () => 10);
  assert.deepEqual(changes, []);
});

test('a player changing slot TYPE is reported as a shift, not a benching', () => {
  // Saquon takes the RB slot, pushing Taylor down to FLEX and Nacua out of the lineup entirely.
  const changes = slotChanges(['RB', 'FLEX'], ['rb1', 'wr1'], ['hurt', 'rb1'], P, () => 10);

  const rb = changes.find((c) => c.slot === 'RB');
  assert.match(rb.outgoing[0].label, /Jonathan Taylor/);
  assert.equal(rb.outgoing[0].keepsStarting, true, 'Taylor is still starting, at FLEX');

  const flex = changes.find((c) => c.slot === 'FLEX');
  assert.match(flex.outgoing[0].label, /Puka Nacua/);
  assert.equal(flex.outgoing[0].keepsStarting, false, 'Nacua is genuinely benched');
});

test('filling an empty slot reports an arrival with nobody leaving', () => {
  const changes = slotChanges(['RB'], ['0'], ['rb1'], P, () => 20);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].outgoing, []);
  assert.match(changes[0].incoming[0], /Jonathan Taylor/);
});

test('report is null when there is nothing at all to say', () => {
  const args = { leagueName: 'x', week: 1, must: [], watch: [], changes: [], currentTotal: 0, total: 0 };
  assert.equal(buildReport(args), null);
});

test('ties are broken toward the lineup already set, so no churn is recommended', () => {
  // Two RB-eligible players, an RB slot and a FLEX slot: either arrangement scores the same, so
  // the solver must return the one already in place rather than an arbitrary swap.
  const slots = ['RB', 'FLEX'];
  const roster = ['rb1', 'hurt'];
  const current = ['hurt', 'rb1'];
  const pts = { rb1: 15, hurt: 15 };
  const { lineup, total } = optimize(slots, roster, P, (id) => pts[id], current);
  assert.equal(total, 30);
  assert.deepEqual(lineup, current, 'should leave the lineup untouched');
  assert.deepEqual(slotChanges(slots, current, lineup, P, (id) => pts[id]), []);
});

test('startedTeams treats anything but pre_game as under way', () => {
  const games = [
    { week: 1, home: 'LAR', away: 'SF', status: 'complete' },
    { week: 1, home: 'CAR', away: 'CHI', status: 'pre_game' },
    { week: 2, home: 'KC', away: 'DEN', status: 'complete' },
  ];
  assert.deepEqual([...startedTeams(games, 1)].sort(), ['LAR', 'SF']);
});

test('a player whose game has kicked off is left where he is', () => {
  const league = { roster_positions: ['FLEX', 'BN'], scoring_settings: { rec: 1 } };
  const roster = { starters: ['rb1'], players: ['rb1', 'wr1'] };
  const projections = { rb1: { rec: 1 }, wr1: { rec: 30 } };
  const base = { league, roster, players: P, projections, byes: new Set() };

  const open = auditRoster({ ...base, started: new Set() });
  assert.deepEqual(open.changes.map((c) => c.slot), ['FLEX'], 'before kickoff, swap him out');

  // rb1 is on IND; once that game is under way Sleeper freezes the slot, so advice is unactionable.
  const locked = auditRoster({ ...base, started: new Set(['IND']) });
  assert.deepEqual(locked.changes, [], 'after kickoff, leave him alone');
});

test('no must-fix for a slot that has already kicked off', () => {
  // Saquon (PHI) is Out — worth flagging beforehand, pure noise once the game is under way.
  const league = { roster_positions: ['FLEX', 'BN'], scoring_settings: {} };
  const roster = { starters: ['hurt'], players: ['hurt'] };
  const base = { league, roster, players: P, projections: {}, byes: new Set() };
  assert.equal(auditRoster({ ...base, started: new Set() }).must.length, 1);
  assert.equal(auditRoster({ ...base, started: new Set(['PHI']) }).must.length, 0);
});
