# talking-teams

Two Sleeper automations for Kyle's leagues. Both read-only, both dependency-free, both silent
when there is nothing to say.

# Roster sync (`sync.mjs`)

Keeps a 12-team Sleeper best-ball league in sync with reality, in a league where **each fantasy team
*is* a real NFL team** — the Rams manager rosters every eligible Ram and nobody else.

Trades, signings, cuts and IR moves break that invariant constantly. This checks all twelve rosters
once a day and posts each division's add/drop list to Discord.

## It reports; it does not execute

The [Sleeper API is read-only](https://docs.sleeper.com/) — *"No API Token is necessary, as you
cannot modify contents via this API."* Every documented endpoint is a `GET`. Sleeper's own support
docs put force add/drop behind **Commish → Roster Players in the mobile app**.

So this works out exactly what needs to change and tells the right commissioner. The three of you
apply the moves by hand. Because you're commissioners you can move a player straight from one roster
to another, so there are no waiver claims, no FAAB and no ordering to worry about.

**When every roster is correct, it posts nothing.** Silence means synced.

## Setup

**1. Generate the config.** This infers which roster is which NFL team by majority vote over each
roster's current players, so nobody hand-maps twelve roster ids:

```bash
node scripts/bootstrap.mjs "Ram Bradford"
```

That prints your leagues; re-run with the one you want:

```bash
node scripts/bootstrap.mjs <league_id> > league.json
```

Check the confidence column before committing — a roster showing something like `18/25` is flagged,
and usually means real drift rather than a bad guess. Confirm each commissioner landed in the
division they actually run.

**2. Add the Discord webhook.** Repo → Settings → Secrets → Actions → new secret named
`DISCORD_WEBHOOK_URL`. Point it at a test channel first.

**3. Optional — `@`-mention each commissioner.** Fill in `discord_id` in `league.json`. This must be
the **numeric user ID**, not a username tag: in Discord, Settings → Advanced → enable Developer
Mode, then right-click the person → *Copy User ID*. You'll get 18-ish digits like
`123456789012345678`. Anything that isn't a snowflake falls back to the plain name rather than
posting a broken `<@wynx#0099>`.

**4. Commit `league.json`.** It's the source of truth for the roster → NFL team mapping.

## Usage

```bash
npm run dry-run    # print the work order, post nothing
npm run sync       # post to Discord (needs DISCORD_WEBHOOK_URL)
npm test           # the diff logic
```

The GitHub Action runs daily at 13:00 UTC (~9am ET) and can be triggered by hand from the Actions
tab. Note that **GitHub disables scheduled workflows after 60 days of repo inactivity** — worth
knowing for the offseason; any commit re-arms it.

## Who counts as a Ram

The rule is deliberately simple: **if Sleeper still lists him on the club at a position the league
rosters, he belongs.** Concretely — `team` matches, `active === true`, and one of his
`fantasy_positions` is rosterable (read from the league's own `roster_positions`, flex slots
expanded).

That keeps practice-squad depth who can be elevated mid-week, and avoids churning players on and off
over weekly inactive designations. With 41 roster spots against ~25 eligible players, there's no
reason to be stingy.

Three quirks in Sleeper's data drive the implementation, all verified against the live feed:

- **`status` is stale history, not live state.** Jason Witten, Greg Olsen and Joe Staley are all
  still `"Injured Reserve"` years after retiring — and *none* of the 227 players carrying that
  status has a team. Filtering on it is a trap.
- **Real injuries live in `injury_status`** (IR / PUP / Questionable) on players whose `team` is
  still set, so genuinely injured players are kept automatically. An injured Ram is still a Ram, and
  the report shows the designation next to his name.
- **`active` is the honest discriminator.** It separates real records from the artifacts littering
  the feed — there are dozens of entries literally named "Duplicate Player", and every one is
  `active: false`. It also covers team defenses, which are keyed by team abbreviation (`"LAR"`) and
  carry no `status` field at all: 0 of 32 have one.

To switch to active-roster-only instead, tighten `isEligible` in [sync.mjs](sync.mjs) to also
require `status === 'Active'` — expect ~27 cuts and steady week-to-week churn as a result.

## Roster capacity

Rosters hold 41 (38 slots + 3 taxi) against roughly 25 eligible players per NFL team, so capacity
isn't close to binding. The check stays in because a league resize would otherwise produce a report
asking for adds that cannot fit; if it ever fires it names the overflow rather than guessing who to
cut — that call is yours.

---

# Lineup advisor (`advise.mjs`)

A second, unrelated tool in the same repo, for **makaveli** — a 12-team dynasty superflex league
where lineups actually matter. Runs daily at 12:30 UTC and posts to its own Discord webhook
(`MAKAVELI_WEBHOOK_URL`). Silent when the lineup is already set and optimal.

```bash
npm run advise:dry    # print, post nothing
npm run advise        # post to Discord
```

Two independent halves, deliberately separated:

**🔴 Must fix** — a starter on bye, ruled out, or an empty slot. Purely deterministic, built only on
documented endpoints, correct regardless of anyone's projections.

**🟢 Lineup change** — the exact highest-projected legal lineup. Scored with the league's own
`scoring_settings`, so TE premium and PPR variants come out right: Mark Andrews projects 12.83 here
versus 10.88 raw PPR, the difference being `bonus_rec_te`.

**🟡 Monitor** — Questionable and similar. Flagged, not acted on.

### How it decides

Projections come from Sleeper's `projections` endpoint, which is **undocumented**. It's read-only
and needs no auth — no ToS problem like the write API — but it isn't in the official docs and could
change without notice. The must-fix half keeps working if it ever does.

Projected points are a dot product of the projection's stat keys against the league's scoring keys
(`rec`, `rush_yd`, `bonus_rec_te`…), which happen to be the same keys — so custom scoring is handled
without any per-league configuration. Threshold bonuses (`bonus_rec_yd_100`) are scored by the league
but absent from the projection feed, so high-yardage players are very slightly under-counted;
it applies uniformly and doesn't change who outranks whom.

Anyone who can't play — bye, Out, IR, PUP, suspended, **or Doubtful** — is worth zero, so the
optimiser never recommends starting someone the must-fix section says to bench.

The lineup itself is an exact max-weight assignment (Hungarian, O(n³)), not a greedy fill. Greedy
happens to be optimal for the usual nested FLEX/SUPER_FLEX shape, but stops being so if a league
defines overlapping-but-not-nested slots; at 10×25 the exact solve costs nothing.

Changes are reported **per slot type, with interchangeable slots collapsed**. Three FLEX slots are
fungible, so a player sliding between two of them is a no-op and is not reported — otherwise one
genuine swap cascades into a wall of meaningless "moves to another slot" lines.

## Layout

| | |
|---|---|
| `sync.mjs` | roster sync: fetch → diff → format → post (also the shared Sleeper client) |
| `advise.mjs` | lineup advisor for makaveli |
| `scripts/bootstrap.mjs` | one-time config generation for the sync |
| `league.json` / `advisor.json` | config for each tool |
| `test/` | diff logic and advisor logic |

No dependencies — Node's built-in `fetch` and `node:test` only.
