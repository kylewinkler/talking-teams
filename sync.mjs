#!/usr/bin/env node
/**
 * talking-teams — daily Sleeper roster sync.
 *
 * Every fantasy team in this league IS a real NFL team, so a roster is correct exactly when it
 * holds every eligible player from its NFL club and nobody else. Real-world trades, signings and
 * retirements break that constantly.
 *
 * The Sleeper API is read-only (https://docs.sleeper.com/ — "you cannot modify contents via this
 * API"), so this reports the work rather than doing it. The three commissioners apply the moves
 * via Commish -> Roster Players in the Sleeper mobile app.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.sleeper.app/v1';
const ROOT = path.dirname(fileURLToPath(import.meta.url));

export async function api(endpoint) {
  const res = await fetch(`${API}${endpoint}`);
  if (!res.ok) throw new Error(`Sleeper ${endpoint} -> ${res.status} ${res.statusText}`);
  return res.json();
}

/* ----------------------------------------------------------- league shape ---- */

// roster_positions mixes real positions with bench/IR markers and flex tokens.
const NOT_A_POSITION = new Set(['BN', 'IR', 'TAXI']);
const FLEX = {
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB'],
};

/** Which positions this league actually rosters, with flex slots expanded to what can fill them. */
export function rosterablePositions(rosterPositions = []) {
  const out = new Set();
  for (const slot of rosterPositions) {
    if (NOT_A_POSITION.has(slot)) continue;
    for (const p of FLEX[slot] ?? [slot]) out.add(p);
  }
  return out;
}

/** Total bodies a roster can hold: starters + bench, plus any IR/taxi stash slots. */
export function rosterCapacity(league) {
  const slots = (league.roster_positions ?? []).filter((p) => p !== 'IR' && p !== 'TAXI').length;
  const s = league.settings ?? {};
  return slots + (s.reserve_slots ?? 0) + (s.taxi_slots ?? 0);
}

/* ------------------------------------------------------------ eligibility ---- */

/**
 * A player belongs on a roster when Sleeper still lists him on the club at a position the league
 * rosters. `active` is the discriminator, for two reasons: it is the only flag separating real
 * records from the artifacts littering the feed (every one of the many "Duplicate Player" entries
 * is active:false), and it covers team defenses, which are keyed by team abbreviation ("LAR") and
 * carry no `status` field at all — 0 of 32 have one.
 *
 * Deliberately NOT keyed on `status`: that field holds stale history rather than live state. Jason
 * Witten, Greg Olsen and Joe Staley are all still "Injured Reserve" years after retiring, and not
 * one of the 227 players with that status has a team. Live injuries live in `injury_status`
 * (IR / PUP / Questionable) on players whose `team` is still set, so the genuinely injured are
 * kept automatically — which is what we want, since an injured Ram is still a Ram.
 */
export function isEligible(player, nflTeam, positions) {
  if (!player || player.team !== nflTeam || player.active !== true) return false;
  return (player.fantasy_positions ?? []).some((p) => positions.has(p));
}

export function eligibleFor(players, nflTeam, positions) {
  const out = new Set();
  for (const [id, p] of Object.entries(players)) {
    if (isEligible(p, nflTeam, positions)) out.add(id);
  }
  return out;
}

/* -------------------------------------------------------------- move plan ---- */

/**
 * Pairs every roster's drops and adds into moves owned by exactly one commissioner.
 *
 * A player sitting on the wrong roster is a single `transfer` owned by the RECEIVING division —
 * emitting it as an independent drop and add would have two commissioners racing to make the
 * same change.
 */
export function planMoves(rosters, desiredByRoster) {
  const holder = new Map(); // playerId -> roster_id currently holding him
  for (const r of rosters) for (const id of r.players ?? []) holder.set(id, r.roster_id);

  const moves = [];
  const covered = new Set(); // "rosterId:playerId" drops already handled by a transfer

  for (const r of rosters) {
    const desired = desiredByRoster.get(r.roster_id);
    if (!desired) continue;
    const current = new Set(r.players ?? []);
    for (const id of desired) {
      if (current.has(id)) continue;
      const from = holder.get(id);
      if (from === undefined) {
        moves.push({ kind: 'add', playerId: id, to: r.roster_id });
      } else {
        moves.push({ kind: 'transfer', playerId: id, from, to: r.roster_id });
        covered.add(`${from}:${id}`);
      }
    }
  }

  for (const r of rosters) {
    const desired = desiredByRoster.get(r.roster_id);
    if (!desired) continue;
    for (const id of r.players ?? []) {
      if (desired.has(id) || covered.has(`${r.roster_id}:${id}`)) continue;
      moves.push({ kind: 'drop', playerId: id, from: r.roster_id });
    }
  }

  return moves;
}

/** The roster a move is filed under: whoever ends up holding the player, else whoever loses him. */
export const owningRoster = (m) => m.to ?? m.from;

/** Majority NFL team among a roster's current players — used to spot a stale roster->team mapping. */
export function inferTeam(playerIds = [], players) {
  const votes = new Map();
  for (const id of playerIds) {
    const team = players[id]?.team;
    if (team) votes.set(team, (votes.get(team) ?? 0) + 1);
  }
  let best = null;
  for (const [team, n] of votes) if (!best || n > best.count) best = { team, count: n };
  return best;
}

/* --------------------------------------------------------------- report ---- */

// Bold signs rather than the ➕/➖ emoji, which Discord draws as heavy grey boxes. The minus is
// U+2212, not a hyphen, so it matches the plus's width and can't be read as a markdown list bullet.
const ADD = '**+**';
const DROP = '**−**';

/**
 * Discord only turns `<@…>` into a real ping for a numeric snowflake id. A username tag like
 * "wynx#0099" would post as literal text, so anything that isn't a snowflake degrades to the
 * commissioner's plain name rather than emitting a visibly broken mention.
 */
const SNOWFLAKE = /^\d{17,20}$/;

export function mentionFor(commissioner) {
  if (!commissioner) return '';
  const id = String(commissioner.discord_id ?? '');
  return SNOWFLAKE.test(id) ? `<@${id}>` : (commissioner.name ?? '');
}

/**
 * "Nate Carter · RB", plus his live injury designation when there is one — worth knowing when you
 * are adding a hurt player, and pure noise on one who is leaving, hence `injury: false`.
 */
export function playerLabel(id, players, { injury = true } = {}) {
  const p = players[id];
  if (!p) return `Unknown player \`${id}\``;
  const bits = [
    [p.first_name, p.last_name].filter(Boolean).join(' ') || id,
    p.fantasy_positions?.[0] ?? p.position ?? '?',
  ];
  if (injury && p.injury_status && p.injury_status !== 'NA') bits.push(p.injury_status);
  return bits.join(' · ');
}

/**
 * Groups the day's work by division: one entry per division with anything to say, holding a
 * section per affected team. Divisions with nothing to do are left out entirely, which is the
 * whole of the "don't be noisy" mechanism — a fully synced league returns an empty map and the run
 * posts nothing.
 *
 * `actionable` is false for a division whose only content is an FYI about a move another
 * commissioner owns: it still gets a card, so nobody wonders why a roster looks short, but its
 * commissioner isn't pinged for work that isn't theirs.
 */
export function buildDivisionReports({ moves, warnings, rosters, players, config, ctx }) {
  const byId = new Map(rosters.map((r) => [r.roster_id, r]));
  const divOf = (rosterId) => byId.get(rosterId)?.settings?.division ?? 0;
  const nflOf = (rosterId) => config.teams[String(rosterId)] ?? '??';
  const mgrOf = (rosterId) => ctx.managerOf.get(rosterId);
  // "KC · JohnSchutz" as a section heading; "**KC** (JohnSchutz)" when named mid-sentence.
  const heading = (rosterId) => (mgrOf(rosterId) ? `${nflOf(rosterId)} · ${mgrOf(rosterId)}` : nflOf(rosterId));
  const inline = (rosterId) => `**${nflOf(rosterId)}**${mgrOf(rosterId) ? ` (${mgrOf(rosterId)})` : ''}`;

  const divisions = new Map(); // division -> { teams: Map<rosterId, string[]>, fyi: string[] }
  const division = (d) => {
    if (!divisions.has(d)) divisions.set(d, { teams: new Map(), fyi: [] });
    return divisions.get(d);
  };
  const teamLines = (d, rosterId) => {
    const t = division(d).teams;
    if (!t.has(rosterId)) t.set(rosterId, []);
    return t.get(rosterId);
  };

  // Warnings first: a capacity limit constrains which of the adds below are even possible.
  for (const w of warnings) teamLines(divOf(w.rosterId), w.rosterId).push(`⚠️ ${w.text}`);

  for (const m of moves) {
    const owner = owningRoster(m);
    const div = divOf(owner);
    const who = playerLabel(m.playerId, players);
    const leaving = playerLabel(m.playerId, players, { injury: false });

    if (m.kind === 'add') {
      // No explanation needed under a "KC" heading — adding a Chief says it all. The obvious tag,
      // "free agent", reads as "has no NFL team", the opposite of why he's being added.
      teamLines(div, owner).push(`${ADD} ${who}`);
    } else if (m.kind === 'transfer') {
      teamLines(div, owner).push(`${ADD} ${who} · from ${inline(m.from)}`);
      // Cross-division: tell the losing side who owns it, so two commissioners don't both do it.
      const fromDiv = divOf(m.from);
      if (fromDiv !== div) {
        const owns = config.commissioners.find((c) => c.division === div);
        division(fromDiv).fyi.push(
          `${leaving} leaves ${inline(m.from)} → ${owns?.name ?? `Division ${div}`} is handling it`,
        );
      }
    } else {
      // Three different reasons a player no longer belongs, and they need telling apart: he moved
      // clubs, he left the NFL entirely, or Sleeper has stopped treating the record as a real player.
      const p = players[m.playerId];
      let reason;
      if (!p?.team) reason = 'left the NFL';
      else if (p.team !== nflOf(owner)) reason = `now on ${p.team}`;
      else reason = 'flagged inactive by Sleeper';
      teamLines(div, owner).push(`${DROP} ${leaving} · ${reason}`);
    }
  }

  const out = new Map();
  for (const [div, { teams, fyi }] of [...divisions].sort((a, b) => a[0] - b[0])) {
    const commissioner = config.commissioners.find((c) => c.division === div) ?? null;
    const name = ctx.divisionNames[div] ?? `Division ${div}`;
    out.set(div, {
      division: div,
      title: commissioner ? `${name} · ${commissioner.name}` : name,
      commissioner,
      actionable: teams.size > 0,
      teams: [...teams]
        .sort((a, b) => a[0] - b[0])
        .map(([rosterId, lines]) => ({ name: heading(rosterId), lines })),
      fyi,
    });
  }
  return out;
}

/** Discord caps message content at 2000 chars; split on line boundaries so nothing truncates. */
export function chunk(text, limit = 1900) {
  const parts = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf && buf.length + line.length + 1 > limit) {
      parts.push(buf);
      buf = '';
    }
    buf = buf ? `${buf}\n${line}` : line;
  }
  if (buf) parts.push(buf);
  return parts;
}

// Division card colors, from Discord's own palette so they sit naturally in light and dark themes.
const DIVISION_COLORS = { 1: 0x5865f2, 2: 0xf0b232, 3: 0x57f287 };
const NEUTRAL = 0x99aab5;

// Past any of these Discord rejects the entire post; it does not truncate.
const LIMIT = { fieldValue: 1024, fields: 25, embeds: 10, chars: 6000 };
const embedChars = (e) =>
  e.title.length + e.fields.reduce((t, f) => t + f.name.length + f.value.length, 0);

/**
 * Renders the division reports as webhook messages: one color-coded card per division, with the
 * pings on a plain line above them — a mention inside an embed renders but never notifies anyone.
 *
 * A heavy day spills over rather than failing: a team too long for one field continues in the
 * next, a division too big for one card continues in another, and cards past one message's budget
 * go in a second message. Only the first message carries the pings.
 */
export function discordPayloads(reports, header) {
  const cards = [];
  for (const r of reports.values()) {
    const fields = [];
    const section = (name, lines) =>
      chunk(lines.join('\n'), LIMIT.fieldValue).forEach((value, i) =>
        fields.push({ name: i ? `${name} (cont.)` : name, value }),
      );
    for (const t of r.teams) section(t.name, t.lines);
    if (r.fyi.length) section('No action needed — handled elsewhere', r.fyi);

    let card = null;
    for (const f of fields) {
      const full =
        card &&
        (card.fields.length === LIMIT.fields ||
          embedChars(card) + f.name.length + f.value.length > LIMIT.chars);
      if (!card || full) {
        const title = card ? `${r.title} (cont.)` : r.title;
        card = { title, color: DIVISION_COLORS[r.division] ?? NEUTRAL, fields: [] };
        cards.push(card);
      }
      card.fields.push(f);
    }
  }

  const messages = [];
  for (const card of cards) {
    const last = messages.at(-1);
    const fits =
      last &&
      last.embeds.length < LIMIT.embeds &&
      last.embeds.reduce((t, e) => t + embedChars(e), 0) + embedChars(card) <= LIMIT.chars;
    if (fits) last.embeds.push(card);
    else messages.push({ embeds: [card] });
  }

  const pings = [...reports.values()]
    .filter((r) => r.actionable && r.commissioner)
    .map((r) => mentionFor(r.commissioner));
  if (messages.length) {
    messages[0].content = [[...new Set(pings)].join(' '), header].filter(Boolean).join(' — ');
  }
  return messages;
}

/** Plain-text view of a webhook message, so a dry run shows exactly what would be sent. */
export function describe(message) {
  const out = [];
  if (message.content) out.push(message.content, '');
  for (const e of message.embeds ?? []) {
    out.push(`┃ ${e.title}   [#${e.color.toString(16).padStart(6, '0')}]`);
    for (const f of e.fields) {
      out.push('┃', `┃ ${f.name}`, ...f.value.split('\n').map((l) => `┃   ${l}`));
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

export async function post(webhook, message) {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Only user mentions may ping — never @everyone or a role, whatever ends up in the text.
    body: JSON.stringify({ allowed_mentions: { parse: ['users'] }, ...message }),
  });
  if (!res.ok) throw new Error(`Discord webhook -> ${res.status} ${await res.text()}`);
}

/* ------------------------------------------------------------------ main ---- */

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const configPath = path.join(ROOT, 'league.json');
  if (!fs.existsSync(configPath)) {
    console.error('league.json not found — run: node scripts/bootstrap.mjs <league_id|username>');
    process.exitCode = 1;
    return;
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const [state, league, rosters, users, players] = await Promise.all([
    api('/state/nfl'),
    api(`/league/${config.league_id}`),
    api(`/league/${config.league_id}/rosters`),
    api(`/league/${config.league_id}/users`),
    api('/players/nfl'),
  ]);

  const positions = rosterablePositions(league.roster_positions);
  const capacity = rosterCapacity(league);

  const nameOf = new Map(users.map((u) => [u.user_id, u.display_name ?? u.username]));
  const managerOf = new Map(rosters.map((r) => [r.roster_id, nameOf.get(r.owner_id) ?? 'unknown']));

  const divisionNames = {};
  for (let d = 1; d <= (league.settings?.divisions ?? 0); d++) {
    if (league.metadata?.[`division_${d}`]) divisionNames[d] = league.metadata[`division_${d}`];
  }

  const desiredByRoster = new Map();
  const warnings = [];
  for (const r of rosters) {
    const nfl = config.teams[String(r.roster_id)];
    if (!nfl) {
      warnings.push({
        rosterId: r.roster_id,
        text: `roster ${r.roster_id} is not mapped to an NFL team in league.json — skipped`,
      });
      continue;
    }
    const desired = eligibleFor(players, nfl, positions);
    desiredByRoster.set(r.roster_id, desired);

    if (desired.size > capacity) {
      warnings.push({
        rosterId: r.roster_id,
        text: `${desired.size} eligible ${nfl} players but only ${capacity} roster spots — ${desired.size - capacity} must be left off, your call which`,
      });
    }
    // A stale mapping would silently "correct" a roster into nonsense, so say so instead.
    const inferred = inferTeam(r.players, players);
    if (inferred && inferred.team !== nfl && inferred.count >= 3) {
      warnings.push({
        rosterId: r.roster_id,
        text: `mapped to ${nfl} but its players are mostly ${inferred.team} — check league.json`,
      });
    }
  }

  const moves = planMoves(rosters, desiredByRoster);
  const ctx = { managerOf, divisionNames };
  const reports = buildDivisionReports({ moves, warnings, rosters, players, config, ctx });

  const week = `${state.season} week ${state.week}`;
  if (reports.size === 0) {
    console.log(`${week}: all ${rosters.length} rosters in sync, nothing to post.`);
    return;
  }

  const messages = discordPayloads(reports, `roster moves · ${week}`);
  if (dryRun) {
    console.log(messages.map(describe).join('\n\n' + '─'.repeat(60) + '\n\n'));
    console.log(`\n[dry run] ${moves.length} move(s), ${reports.size} division(s); nothing posted.`);
    return;
  }

  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) {
    console.error('DISCORD_WEBHOOK_URL is not set');
    process.exitCode = 1;
    return;
  }
  for (const m of messages) await post(webhook, m);
  console.log(`Posted ${messages.length} message(s): ${moves.length} move(s), ${reports.size} division(s).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
