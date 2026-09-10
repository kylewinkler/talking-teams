#!/usr/bin/env node
/**
 * One-time setup: works out which Sleeper roster is which NFL team, and which commissioner runs
 * which division, then prints a league.json for review.
 *
 * The roster -> NFL team mapping is inferred by majority vote over each roster's current players
 * rather than typed by hand, so nobody has to map twelve roster ids or guess whether Sleeper spells
 * it JAX or JAC. Eyeball the confidence column before committing the output.
 *
 *   node scripts/bootstrap.mjs <league_id>
 *   node scripts/bootstrap.mjs "Ram Bradford"     # resolves leagues for a username
 */

import { api, inferTeam } from '../sync.mjs';

// The three commissioners, one per division. Keyed on Sleeper display name rather than team name
// ("Ram Bradford", "Giant Dongs", "Duffalo Dills") because a manager can rename their team mid-season
// and silently break the mapping.
const COMMISSIONERS = [
  { name: 'Kyle', sleeper_user: 'winksahoy' },
  { name: 'David', sleeper_user: 'TenKaura' },
  { name: 'Tyler', sleeper_user: 'TeeFlesh' },
];

async function resolveLeagues(username) {
  const user = await api(`/user/${encodeURIComponent(username)}`);
  if (!user?.user_id) {
    // /user/ takes the login username, not the display name shown in the league.
    throw new Error(
      `no Sleeper user named "${username}" — that endpoint wants the login username, not a ` +
        'display name. Grab the league id from the app URL instead and pass that.',
    );
  }
  const { season } = await api('/state/nfl');
  const leagues = await api(`/user/${user.user_id}/leagues/nfl/${season}`);
  if (!leagues?.length) throw new Error(`${username} has no ${season} NFL leagues`);

  console.error(`Leagues for ${username} (${season}):\n`);
  for (const l of leagues) console.error(`  ${l.league_id}  ${l.name} (${l.total_rosters} teams)`);
  console.error('\nRe-run with the league_id you want:\n  node scripts/bootstrap.mjs <league_id>');
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: node scripts/bootstrap.mjs <league_id|username>');
    process.exitCode = 1;
    return;
  }
  // Sleeper league ids are long numeric strings; anything else is treated as a username, which
  // only lists the leagues to choose from — there is nothing to map until we have an id.
  if (!/^\d+$/.test(arg)) {
    await resolveLeagues(arg);
    process.exitCode = 1;
    return;
  }

  const [league, rosters, users, players] = await Promise.all([
    api(`/league/${arg}`),
    api(`/league/${arg}/rosters`),
    api(`/league/${arg}/users`),
    api('/players/nfl'),
  ]);

  const nameOf = new Map(users.map((u) => [u.user_id, u.display_name ?? u.username]));

  console.error(`\n${league.name} — ${league.total_rosters} teams, ${league.settings?.divisions ?? 0} divisions\n`);
  console.error('  roster  div  NFL  confidence  manager');
  console.error('  ' + '-'.repeat(58));

  const teams = {};
  for (const r of [...rosters].sort((a, b) => a.roster_id - b.roster_id)) {
    const held = r.players?.length ?? 0;
    const best = inferTeam(r.players, players);
    teams[String(r.roster_id)] = best?.team ?? null;

    const conf = best ? `${best.count}/${held}` : 'EMPTY ROSTER';
    const flag = best && best.count / Math.max(held, 1) < 0.8 ? '  <-- check this one' : '';
    console.error(
      `  ${String(r.roster_id).padStart(6)}  ${String(r.settings?.division ?? '-').padStart(3)}  ` +
        `${(best?.team ?? '??').padEnd(4)} ${conf.padEnd(11)} ${nameOf.get(r.owner_id) ?? '?'}${flag}`,
    );
  }

  // Each commissioner runs the division they play in. Printed for confirmation rather than assumed
  // silently, since a wrong guess would misroute a season's worth of work.
  const key = (s) => String(s ?? '').trim().toLowerCase();
  const ownerOf = new Map(); // display name AND team name both resolve to the same user
  for (const u of users) {
    ownerOf.set(key(u.display_name), u.user_id);
    if (u.metadata?.team_name) ownerOf.set(key(u.metadata.team_name), u.user_id);
  }
  const divisionOfOwner = new Map(rosters.map((r) => [r.owner_id, r.settings?.division ?? null]));

  const commissioners = COMMISSIONERS.map((c) => {
    const division = divisionOfOwner.get(ownerOf.get(key(c.sleeper_user))) ?? null;
    if (division === null) {
      console.error(`\n! "${c.sleeper_user}" has no roster here — set ${c.name}'s division by hand`);
    }
    return { ...c, division, discord_id: null };
  });

  const config = { league_id: arg, teams, commissioners };

  console.error('\nReview the mapping above, then save this as league.json:\n');
  console.log(JSON.stringify(config, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
