import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  rosterablePositions,
  rosterCapacity,
  isEligible,
  eligibleFor,
  planMoves,
  owningRoster,
  inferTeam,
  buildDivisionReports,
  mentionFor,
  chunk,
} from '../sync.mjs';

/* Fixtures mirror the real quirks found in Sleeper's live players blob. */
const players = {
  1: { first_name: 'Matthew', last_name: 'Stafford', team: 'LAR', status: 'Active', active: true, position: 'QB', fantasy_positions: ['QB'] },
  2: { first_name: 'Puka', last_name: 'Nacua', team: 'LAR', status: 'Active', active: true, position: 'WR', fantasy_positions: ['WR'] },
  3: { first_name: 'Kyren', last_name: 'Williams', team: 'DEN', status: 'Active', active: true, position: 'RB', fantasy_positions: ['RB'] },
  4: { first_name: 'Blake', last_name: 'Corum', team: 'LAR', status: 'Active', active: true, position: 'RB', fantasy_positions: ['RB'] },
  // Practice-squad depth: still on the club, so still ours.
  5: { first_name: 'Squad', last_name: 'Guy', team: 'LAR', status: 'Inactive', active: true, position: 'WR', fantasy_positions: ['WR'] },
  6: { first_name: 'Gone', last_name: 'Guy', team: null, status: 'Inactive', active: false, position: 'WR', fantasy_positions: ['WR'] },
  7: { first_name: 'Caleb', last_name: 'Williams', team: 'CHI', status: 'Active', active: true, position: 'QB', fantasy_positions: ['QB'] },
  // Genuinely hurt: `team` intact, real designation in injury_status, NOT in status.
  8: { first_name: 'Hurt', last_name: 'Ram', team: 'LAR', status: 'Active', active: true, injury_status: 'IR', position: 'TE', fantasy_positions: ['TE'] },
  // Sleeper's feed is full of these; every one is active:false.
  9: { first_name: 'Duplicate', last_name: 'Player', team: 'LAR', status: 'Inactive', active: false, position: 'WR', fantasy_positions: ['WR'] },
  // Retired years ago, but `status` still says Injured Reserve — the trap that field sets.
  10: { first_name: 'Jason', last_name: 'Witten', team: null, status: 'Injured Reserve', active: true, position: 'TE', fantasy_positions: ['TE'] },
  // Team defenses carry no `status` field whatsoever.
  LAR: { first_name: 'Los Angeles', last_name: 'Rams', team: 'LAR', active: true, position: 'DEF', fantasy_positions: ['DEF'] },
  CHI: { first_name: 'Chicago', last_name: 'Bears', team: 'CHI', active: true, position: 'DEF', fantasy_positions: ['DEF'] },
};

const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);

// Roster 1 = Rams (division 1). Roster 2 = Bears (division 3) but is squatting on a Ram.
const rosters = [
  { roster_id: 1, owner_id: 'u1', settings: { division: 1 }, players: ['1', '3', '6'] },
  { roster_id: 2, owner_id: 'u2', settings: { division: 3 }, players: ['4', '7'] },
];

const desired = new Map([
  [1, eligibleFor(players, 'LAR', POSITIONS)],
  [2, eligibleFor(players, 'CHI', POSITIONS)],
]);

test('league settings drive which positions count', () => {
  const rp = ['QB', 'RB', 'WR', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'IR'];
  assert.deepEqual([...rosterablePositions(rp)].sort(), ['DEF', 'K', 'QB', 'RB', 'TE', 'WR']);
  assert.equal(rosterCapacity({ roster_positions: rp, settings: { reserve_slots: 2 } }), 10);
});

test('a team defense is eligible despite having no status field', () => {
  assert.equal(isEligible(players.LAR, 'LAR', POSITIONS), true);
});

test('practice-squad depth counts — still on the club, still ours', () => {
  assert.equal(isEligible(players[5], 'LAR', POSITIONS), true);
});

test('an injured player stays eligible, since injury lives in injury_status', () => {
  assert.equal(isEligible(players[8], 'LAR', POSITIONS), true);
});

test('a "Duplicate Player" artifact never reaches a roster', () => {
  assert.equal(isEligible(players[9], 'LAR', POSITIONS), false);
});

test('a stale "Injured Reserve" status on a retired player is ignored', () => {
  // Jason Witten has status "Injured Reserve" years after retiring; team:null is what settles it.
  assert.equal(isEligible(players[10], 'LAR', POSITIONS), false);
});

test('eligible set is exactly the rosterable Rams', () => {
  assert.deepEqual([...desired.get(1)].sort(), ['1', '2', '4', '5', '8', 'LAR']);
});

test('moves cover every kind of drift, and a contested player only once', () => {
  const moves = planMoves(rosters, desired);
  const kinds = (k) => moves.filter((m) => m.kind === k).map((m) => m.playerId).sort();

  assert.deepEqual(kinds('add'), ['2', '5', '8', 'CHI', 'LAR']); // free agents
  assert.deepEqual(kinds('transfer'), ['4']); // Corum, sitting on the Bears roster
  assert.deepEqual(kinds('drop'), ['3', '6']); // traded to DEN, and out of the league

  // The Bears' drop of Corum must NOT also appear as a standalone drop, or two commissioners
  // would each try to action half of the same move.
  assert.equal(moves.filter((m) => m.playerId === '4').length, 1);
  assert.equal(owningRoster(moves.find((m) => m.playerId === '4')), 1);
});

test('a cross-division transfer is owned by one commissioner and flagged to the other', () => {
  const moves = planMoves(rosters, desired);
  const config = {
    teams: { 1: 'LAR', 2: 'CHI' },
    commissioners: [
      { name: 'Kyle', division: 1 },
      { name: 'Tyler', division: 3 },
    ],
  };
  const ctx = { managerOf: new Map([[1, 'Ram Bradford'], [2, 'Dufallo Dills']]), divisionNames: {} };
  const reports = buildDivisionReports({ moves, warnings: [], rosters, players, config, ctx });

  // Kyle owns it: his division carries the actionable line.
  assert.match(reports.get(1), /Blake Corum \(RB\).*currently on \*\*CHI\*\*/);
  // Tyler is told, but only as an FYI naming who is handling it.
  assert.match(reports.get(3), /No action needed/);
  assert.match(reports.get(3), /Blake Corum .*Kyle is handling it/);
  assert.doesNotMatch(reports.get(3), /➕ Blake Corum/);
});

test('a drop says which of the three reasons applies', () => {
  // '3' moved to DEN, '6' left the NFL, '9' is still listed on LAR but is an inactive artifact.
  const r = [{ roster_id: 1, settings: { division: 1 }, players: ['3', '6', '9'] }];
  const moves = planMoves(r, new Map([[1, new Set(['1'])]]));
  const reports = buildDivisionReports({
    moves,
    warnings: [],
    rosters: r,
    players,
    config: { teams: { 1: 'LAR' }, commissioners: [{ name: 'Kyle', division: 1 }] },
    ctx: { managerOf: new Map(), divisionNames: {} },
  });
  const body = reports.get(1);
  assert.match(body, /Kyren Williams \(RB\) — now on DEN/);
  assert.match(body, /Gone Guy \(WR\) — no longer on an NFL roster/);
  assert.match(body, /Duplicate Player \(WR\) — still listed on LAR but flagged inactive by Sleeper/);
});

test('a fully synced league produces no report at all', () => {
  const clean = [{ roster_id: 1, settings: { division: 1 }, players: ['1', '2', '4', '5', '8', 'LAR'] }];
  const moves = planMoves(clean, new Map([[1, desired.get(1)]]));
  assert.deepEqual(moves, []);
  const reports = buildDivisionReports({
    moves,
    warnings: [],
    rosters: clean,
    players,
    config: { teams: { 1: 'LAR' }, commissioners: [] },
    ctx: { managerOf: new Map(), divisionNames: {} },
  });
  assert.equal(reports.size, 0);
});

test('only a numeric snowflake becomes a real Discord ping', () => {
  assert.equal(mentionFor({ name: 'Kyle', discord_id: '123456789012345678' }), '<@123456789012345678>');
  // A username tag would post as literal text, so fall back to the readable name instead.
  assert.equal(mentionFor({ name: 'Kyle', discord_id: 'wynx#0099' }), 'Kyle');
  assert.equal(mentionFor({ name: 'Kyle', discord_id: null }), 'Kyle');
  assert.equal(mentionFor(undefined), '');
});

test('inferTeam picks the majority club, which is how the mapping is bootstrapped', () => {
  assert.deepEqual(inferTeam(['1', '2', '3'], players), { team: 'LAR', count: 2 });
});

test('chunk splits on line boundaries without dropping content', () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const parts = chunk(text, 200);
  assert.ok(parts.every((p) => p.length <= 200));
  assert.equal(parts.join('\n'), text);
});
