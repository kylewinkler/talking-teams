#!/usr/bin/env node
/**
 * Daily lineup advisor for a start/sit league (makaveli — 12-team dynasty, superflex, TE premium).
 *
 * Two independent halves, deliberately:
 *
 *   Must-fix   — a starter on bye, ruled out, or an empty slot. Deterministic, built only on
 *                documented endpoints, and correct regardless of anyone's projections.
 *   Optimize   — the exact highest-projected legal lineup, scored with THIS league's own
 *                scoring_settings rather than generic PPR. Uses Sleeper's projections endpoint,
 *                which works and needs no auth but is undocumented and could change without notice.
 *
 * Posts nothing when the lineup is already correct and optimal.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, chunk, post } from './sync.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** The schedule lives outside /v1, unlike everything else. */
async function schedule(season) {
  const res = await fetch(`https://api.sleeper.app/schedule/nfl/regular/${season}`);
  if (!res.ok) throw new Error(`Sleeper schedule -> ${res.status}`);
  return res.json();
}

const FLEX_ELIGIBILITY = {
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB'],
};

// Designations meaning he will not take the field. "Doubtful" is included on purpose — doubtful
// players almost never play, and leaving them projected would have the optimiser recommend a
// starter the must-fix section is simultaneously telling you to bench.
const WILL_NOT_PLAY = new Set(['Out', 'IR', 'PUP', 'Sus', 'DNR', 'NA', 'COV', 'Doubtful']);
const MONITOR = new Set(['Questionable', 'Limited Practice', 'DTD']);

export const eligibleFor = (slot) => FLEX_ELIGIBILITY[slot] ?? [slot];
export const canFill = (slot, player) =>
  eligibleFor(slot).some((p) => (player?.fantasy_positions ?? []).includes(p));

/** Teams with no game in a given week are on bye. */
export function byeTeams(games, week) {
  const playing = new Set();
  for (const g of games) if (g.week === week) { playing.add(g.home); playing.add(g.away); }
  const all = new Set();
  for (const g of games) { all.add(g.home); all.add(g.away); }
  return new Set([...all].filter((t) => !playing.has(t)));
}

/**
 * Projected points under the league's own scoring. Sleeper's projection stats share their keys with
 * scoring_settings (rec, rush_yd, bonus_rec_te...), so this is a dot product rather than a guess —
 * it picks up TE premium and PPR variants for free. Keys the league doesn't score are skipped.
 *
 * Threshold bonuses (bonus_rec_yd_100 and friends) are scored by the league but not carried in the
 * projection feed, so high-yardage players are very slightly under-counted. It applies uniformly,
 * so it does not change who outranks whom.
 */
export function projectedPoints(stats, scoring) {
  if (!stats) return 0;
  let total = 0;
  for (const [k, v] of Object.entries(stats)) {
    if (typeof v === 'number' && typeof scoring[k] === 'number') total += v * scoring[k];
  }
  return total;
}

/**
 * Max-weight assignment of players to slots (Hungarian / Jonker-Volgenant, O(n^3)).
 *
 * Filling the most restrictive slot first with the best available player happens to be optimal for
 * the usual nested FLEX/SUPER_FLEX shape, but that stops being true the moment a league defines
 * overlapping-but-not-nested slots. This is exact for any slot definitions, and at 10x25 the cost
 * is irrelevant.
 *
 * Returns slotIndex -> playerIndex, or -1 where a slot could not be filled.
 */
export function assign(weight, nSlots, nPlayers) {
  const n = nSlots, m = nPlayers, INF = Infinity;
  if (!n || !m) return new Array(n).fill(-1);
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF), used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = -weight[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }

  const slotOf = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j] > 0) slotOf[p[j] - 1] = j - 1;
  return slotOf;
}

const UNPLAYABLE = -1e6; // sentinel weight for an assignment that is not allowed at all

/**
 * Best legal lineup and its projected total.
 *
 * `current` breaks ties toward the lineup already set. Two RB-eligible players can sit in an RB slot
 * and a FLEX slot in either order for identical points, and the solver is free to return either —
 * so without this it happily reports a "+0.0 projected" swap that is pure churn. The nudge is far
 * smaller than any real projection difference, so it only ever decides genuine ties.
 */
export function optimize(slots, roster, players, points, current = []) {
  const STAY_PUT = 1e-6;
  const weight = slots.map((s, i) =>
    roster.map((id) => {
      if (!canFill(s, players[id])) return UNPLAYABLE;
      return points(id) + (current[i] === id ? STAY_PUT : 0);
    }),
  );
  const slotOf = assign(weight, slots.length, roster.length);
  const lineup = slots.map((s, i) => {
    const pi = slotOf[i];
    return pi >= 0 && weight[i][pi] > UNPLAYABLE ? roster[pi] : null;
  });
  return { lineup, total: lineup.reduce((t, id) => t + (id ? points(id) : 0), 0) };
}

/** Deterministic problems with the lineup as it currently stands. */
export function findProblems(slots, starters, players, byes) {
  const problems = [];
  slots.forEach((slot, i) => {
    const id = starters[i];
    const p = id && id !== '0' ? players[id] : null;
    if (!p) { problems.push({ level: 'must', slot, text: `${slot} slot is empty` }); return; }

    const who = `${p.first_name} ${p.last_name} (${p.fantasy_positions?.[0] ?? p.position})`;
    if (!p.team) problems.push({ level: 'must', slot, text: `${who} — no longer on an NFL roster` });
    else if (byes.has(p.team)) problems.push({ level: 'must', slot, text: `${who} — ${p.team} on bye` });
    else if (WILL_NOT_PLAY.has(p.injury_status)) {
      problems.push({ level: 'must', slot, text: `${who} — ${p.injury_status}` });
    } else if (MONITOR.has(p.injury_status)) {
      problems.push({ level: 'watch', slot, text: `${who} — ${p.injury_status}` });
    }
  });
  return problems;
}

/**
 * Per-slot instructions for turning the current lineup into the optimal one.
 *
 * Reported by slot rather than as "start X over Y" pairs: Sleeper's lineup is positional, and a
 * pairing built from set difference can suggest starting a WR "over" a TE, which is not a move the
 * app will let you make. A player who merely shifts slots is called out as such instead of looking
 * like a benching.
 */
export function slotChanges(slots, current, optimal, players, points) {
  // Slots with identical eligibility are interchangeable — this league has three FLEX — so a player
  // sliding between two of them is a no-op. Diffing per slot index would fill the report with
  // cascading "moves to another slot" churn, so group by eligibility and diff the sets instead.
  const signature = (slot) => eligibleFor(slot).slice().sort().join('/');
  const stillStarting = new Set(optimal.filter(Boolean));
  const label = (id) => {
    const p = players[id];
    if (!p) return String(id);
    const pos = p.fantasy_positions?.[0] ?? p.position;
    return `${p.first_name} ${p.last_name} (${pos}, ${points(id).toFixed(1)})`;
  };

  const groups = new Map();
  slots.forEach((slot, i) => {
    const key = signature(slot);
    if (!groups.has(key)) groups.set(key, { slot, current: [], optimal: [] });
    const g = groups.get(key);
    if (current[i] && current[i] !== '0') g.current.push(current[i]);
    if (optimal[i]) g.optimal.push(optimal[i]);
  });

  const byValue = (a, b) => points(b) - points(a);
  const changes = [];
  for (const g of groups.values()) {
    const held = new Set(g.current), wanted = new Set(g.optimal);
    const incoming = g.optimal.filter((id) => !held.has(id)).sort(byValue);
    const outgoing = g.current.filter((id) => !wanted.has(id)).sort(byValue);
    if (!incoming.length && !outgoing.length) continue;
    changes.push({
      slot: g.slot,
      incoming: incoming.map(label),
      outgoing: outgoing.map((id) => ({ label: label(id), keepsStarting: stillStarting.has(id) })),
    });
  }
  return changes;
}

/** The Discord message, or null when the lineup is already set and optimal. */
export function buildReport({ leagueName, week, must, watch, changes, currentTotal, total }) {
  if (!must.length && !watch.length && !changes.length) return null;

  const lines = [`🏈 **${leagueName}** — week ${week} lineup check`, ''];
  if (must.length) lines.push('🔴 **Must fix**', ...must.map((p) => ` · ${p.text}`), '');

  if (changes.length) {
    lines.push(`🟢 **Lineup change** — +${(total - currentTotal).toFixed(1)} projected`);
    for (const c of changes) {
      const parts = [];
      if (c.incoming.length) parts.push(`start ${c.incoming.map((s) => `**${s}**`).join(', ')}`);
      const bench = c.outgoing.filter((o) => !o.keepsStarting).map((o) => o.label);
      const moved = c.outgoing.filter((o) => o.keepsStarting).map((o) => o.label);
      if (bench.length) parts.push(`bench ${bench.join(', ')}`);
      if (moved.length) parts.push(`${moved.join(', ')} shifts to another slot`);
      if (!parts.length) continue;
      lines.push(` · \`${c.slot}\` — ${parts.join('; ')}`);
    }
    lines.push('');
  }

  if (watch.length) lines.push('🟡 **Monitor**', ...watch.map((p) => ` · ${p.text}`), '');
  lines.push(`_Projected ${currentTotal.toFixed(1)} → ${total.toFixed(1)}_`);
  return lines.join('\n').trim();
}

/* ------------------------------------------------------------------ main ---- */

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const configPath = path.join(ROOT, 'advisor.json');
  if (!fs.existsSync(configPath)) {
    console.error('advisor.json not found');
    process.exitCode = 1;
    return;
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const state = await api('/state/nfl');
  const week = state.week;
  const [league, rosters, players, projections, games] = await Promise.all([
    api(`/league/${config.league_id}`),
    api(`/league/${config.league_id}/rosters`),
    api('/players/nfl'),
    api(`/projections/nfl/regular/${state.season}/${week}`),
    schedule(state.season),
  ]);

  const mine = rosters.find((r) => r.owner_id === config.user_id);
  if (!mine) throw new Error(`no roster for user ${config.user_id} in ${league.name}`);

  const slots = league.roster_positions.filter((s) => !['BN', 'IR', 'TAXI'].includes(s));
  const byes = byeTeams(games, week);
  const scoring = league.scoring_settings ?? {};

  // A player who cannot take the field is worth zero, which keeps the optimiser from ever
  // recommending someone the must-fix section is telling you to bench.
  const points = (id) => {
    const p = players[id];
    if (!p || !p.team || byes.has(p.team) || WILL_NOT_PLAY.has(p.injury_status)) return 0;
    return projectedPoints(projections[id], scoring);
  };

  const roster = (mine.players ?? []).filter((id) => players[id]);
  const problems = findProblems(slots, mine.starters ?? [], players, byes);
  const current = (mine.starters ?? []).filter((id) => id && id !== '0');
  const currentTotal = current.reduce((t, id) => t + points(id), 0);
  const starters = mine.starters ?? [];
  const { lineup, total } = optimize(slots, roster, players, points, starters);
  // Below a tenth of a point the "improvement" is projection noise, not a decision worth a message.
  const worthDoing = total - currentTotal >= 0.1;
  const changes = worthDoing ? slotChanges(slots, starters, lineup, players, points) : [];

  const must = problems.filter((p) => p.level === 'must');
  const watch = problems.filter((p) => p.level === 'watch');
  const gain = total - currentTotal;

  const body = buildReport({
    leagueName: league.name, week, must, watch, changes, currentTotal, total,
  });
  if (body === null) {
    console.log(`${league.name} week ${week}: lineup is set and optimal (${currentTotal.toFixed(1)} proj).`);
    return;
  }

  if (dryRun) {
    console.log(body);
    console.log(`\n[dry run] ${must.length} must-fix, ${changes.length} change(s); nothing posted.`);
    return;
  }

  const webhook = process.env[config.webhook_env];
  if (!webhook) {
    console.error(`${config.webhook_env} is not set`);
    process.exitCode = 1;
    return;
  }
  for (const part of chunk(body)) await post(webhook, { content: part });
  console.log(`Posted: ${must.length} must-fix, ${changes.length} change(s), +${gain.toFixed(1)} proj.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
