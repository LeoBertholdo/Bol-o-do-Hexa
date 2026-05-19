# Code Review — Bolão do Hexa 2026

**Reviewed:** `bolao2026.html` (2,649 lines), `supabase_setup.sql` (247 lines), `index.html` (19 lines)
**Date:** 2026-05-19
**Scope:** Security, performance, correctness, maintainability

---

## Summary

Solid single-file web app backed by Supabase, with sensible RLS, consistent HTML escaping, and a clean separation between local state and remote sync. Two correctness bugs around knockout-stage cascades and score validation deserve attention before the tournament starts. Everything else is polish.

**Verdict:** Request changes — fix the two correctness issues; the rest can land incrementally.

---

## Critical issues

### 1. Cascading knockout deletions are not synced to Supabase
**File:** `bolao2026.html` · **Lines:** 2322–2370 (`confirmRes`, `clearRes`, `clearDependentKnockouts`)
**Severity:** High — silent data drift

When an admin changes or removes a group-stage result, `clearDependentKnockouts(id)` deletes all downstream KO results from the **local** `S.results`, but `confirmRes` only calls `saveResultRemote(id)` / `clearRes` only calls `deleteResultRemote(id)` for the originally-changed game. The KO results stay on the server and reappear on the next 30-second poll via `loadRemoteData`, silently undoing the admin's correction.

Repro: admin saves R32_01 → 1×0, then changes a group result that invalidates R32_01 → R32_01 is cleared locally → poll fires → R32_01 = 1×0 is back.

**Fix:** collect the IDs that `clearDependentKnockouts` deletes and call `deleteResultRemote` on each, or upsert an empty row, or batch a `delete().in("game_id", ids)`.

```js
function clearDependentKnockouts(id){
  const cleared = [];
  // ...existing logic, push g.id into `cleared` on each delete...
  return cleared;
}
// in confirmRes / clearRes:
const cleared = clearDependentKnockouts(id);
save();
saveResultRemote(id); // or deleteResultRemote(id)
if(remoteClient && isAdmin() && cleared.length){
  remoteWrite(() => remoteClient.from("results").delete().in("game_id", cleared));
}
```

### 2. `setPal` accepts scores above 30; round-trips through the DB to fail
**File:** `bolao2026.html` · **Lines:** 2452–2467 (`setPal`)
**Severity:** Medium — bad UX, wasted requests

`setResDraft` caps with `Math.min(30, n)` (line 2320), but `setPal` doesn't:

```js
const n=parseInt(v,10);
if(!Number.isNaN(n)&&n>=0){
  if(w===1) S.palpites[key].s1=n;   // 99 lands here
  ...
}
```

The DB rejects via `CHECK (s1 between 0 and 30)`. The user sees `remoteErrorText` ("Não consegui conversar com o Supabase") and the local state is then overwritten by a full reload. Confusing for the user and unnecessary network traffic.

**Fix:** mirror the `setResDraft` clamp:

```js
const n = parseInt(v, 10);
if(!Number.isNaN(n) && n >= 0){
  const clamped = Math.min(30, n);
  if(w===1) S.palpites[key].s1 = clamped;
  else      S.palpites[key].s2 = clamped;
}
```

`confirmRes` (line 2329) has the same gap — it validates `s1<0||s2<0` but not `s1>30`. Add the upper bound there too.

---

## Suggestions

### Correctness

**3. `Number(x) || fallback` treats 0 as missing** (`applyRemoteData`, lines 1132–1133)
If an admin sets `entry_value = 0` deliberately, the fallback kicks in. Use `Number.isFinite(parsed) ? parsed : fallback`.

**4. `pushLocalStateToRemote` is a destructive overwrite with no confirmation** (lines 1359–1394)
The button label "Publicar dados locais no Supabase" sounds like a publish; the operation is actually an upsert that can clobber participants' newer predictions with the admin's stale local copy. Add a `confirm()` step and a one-line warning in the UI.

**5. `score` function: clean** (lines 1624–1633)
Verified all four branches (cravada, invertida, resultado certo, erro). Tie predictions (`ps1===ps2`) skip the invertida check correctly. No issue.

**6. Date parsing uses local timezone** (`parseDateKey`, line 854)
`new Date(y, m-1, d)` is local-tz. For a Brazilian audience watching Brazilian-time kickoffs this is fine, but worth noting if anyone else uses the same template.

### Security

**7. No Subresource Integrity on Supabase CDN** (line 789)
```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
```
Pinned only to major version. A compromised CDN or a breaking v2.x change could break auth/RLS or worse. Pin a minor + add `integrity="sha384-..."` and `crossorigin="anonymous"`.

**8. No Content-Security-Policy meta** 
The app uses ~78 inline event handlers and inline `<script>`, so CSP would need `'unsafe-inline'` to keep working — which makes CSP largely cosmetic. Still worth adding a strict `default-src 'self' https://cdn.jsdelivr.net https://*.supabase.co; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net` to limit damage if a future regex bug ever leaks unescaped content. Better long-term: migrate to event delegation and drop `'unsafe-inline'`.

**9. XSS surface — escaping looks complete** ✓
Verified `esc()` is applied to every template literal interpolation that touches `S.participants`, `currentProfile.*`, `remoteSession.user.email`, podium names, etc. Raw flag emojis come from a hardcoded constant. Scores come from DB columns with integer `CHECK`s. No issues found.

**10. Publishable anon key in source — fine** (line 836)
`sb_publishable_*` is the new-format anon key, safe to expose. RLS protects data. No action needed.

**11. SQL: profile insert race** (`supabase_setup.sql`, lines 123–126)
A user can claim any participant_index that isn't already taken; the unique constraint handles races. Worth adding a policy that prevents a user from inserting multiple profile rows (currently allowed by the policy, blocked only by PK on `id`). Already safe in practice — PK on `id` enforces one-profile-per-user — but stating it explicitly in the policy is clearer.

### Performance

**12. `gameTeams` recomputes `buildR32Pairings` per call** (line 1747)
`buildR32Pairings` → `qualifiers` → `groupStandings` runs through 48 games. Called once per KO game per render (~30+ calls). Trivial in absolute terms but easy to memoize per-render:

```js
let _pairingsCache = null;
function gameTeams(game){
  if(game.phaseKey === "r32" && !_pairingsCache) _pairingsCache = buildR32Pairings();
  // ...
}
// reset _pairingsCache = null at the top of render()
```

**13. Full-tree re-render on every keystroke after `onchange`**
`setPal`, `setAP`, `setPodio`, `setResDraft` (via `confirmRes`) all call `renderXxx()` which `innerHTML =`'s the whole tab. Fine in absolute terms, but causes the input the user just left to lose its draft state if they were tabbing fast. Two cheap mitigations:
- After write, update only the badge/progress text instead of re-rendering the whole tab.
- Use `requestAnimationFrame` to debounce re-renders.

### Maintainability

**14. Silent error swallowing** (lines 943, 973, 2626)
```js
}catch(e){}
```
Three places. At least `console.warn(e)` so debugging a user's "my data disappeared" report is possible.

**15. Toast vs. native `confirm()`** (line 2363)
`clearRes` uses native `confirm("Remover este resultado?")`. The rest of the app uses the custom `toast`. A custom inline confirm would feel more consistent and is keyboard-accessible.

**16. Single-file size is approaching unwieldy**
2,649 lines, ~115 KB. Still loads fast and there's value in zero-build deployability, but if you ever want to split: CSS → `styles.css`, JS → `app.js`, leave the HTML shell. The `<script>` block alone is 1,857 lines.

**17. No `aria-label` on the score `<input>`s** (line 1611)
`scoreControl` renders an unlabelled `<input type="number">`. The plus/minus buttons have no text alternatives either (`−` / `+` glyphs). Add `aria-label="Placar de {team}"` and `aria-label="Aumentar placar"` / `"Diminuir placar"` for screen-reader users.

**18. `participants insert own profile` policy can be tightened**
Currently `with check (id = auth.uid() and role = 'participant')`. Consider also `and not exists (select 1 from profiles where id = auth.uid())` to make the one-profile constraint policy-explicit instead of relying on the PK.

---

## What looks good

- **RLS is well-thought-out.** Admin/participant split is clean; `app_private.is_admin()` is correctly `security definer` with a fixed `search_path` (preventing search-path injection). Self-edit policies correctly check both `user_id = auth.uid()` and `owns_participant_index`.
- **Consistent HTML escaping** via `esc()` everywhere user/DB content flows into templates.
- **Local-first with remote sync** falls back gracefully when Supabase is unconfigured or unreachable.
- **Migration path** (`migrateState`, `OLD_STORAGE_KEYS`) preserves old local data — nice touch.
- **Score logic** correctly handles cravada / invertida / resultado certo edge cases.
- **Auth UX** covers the full lifecycle: signup, signin, password recovery (URL hash parsing handled), claim-participant.

---

## Verdict

**Request changes**, two fixes:
1. Sync the cascade deletes in `clearDependentKnockouts` to the server.
2. Clamp `setPal` (and `confirmRes`) to ≤30.

The rest can land as follow-up PRs. Once those two ship, this is ready for the World Cup.
