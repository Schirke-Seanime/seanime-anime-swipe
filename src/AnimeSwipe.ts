/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

// Anime Swipe: one anime at a time that isn't in your list yet. Swipe right
// (or press →) to add it to Planning, left to pass, up if you've seen it.
// Pick a genre and a subgenre (the AniList tags most common in that genre,
// like Isekai under Fantasy); the deck is ordered by how well each show fits
// your taste. Shows you've decided on never come back.

function init() {
  // Seanime runs the UI handler in its own runtime, from its source text, so
  // it can't see anything declared at the top level of this file. Everything
  // it needs comes from the shared module compiled from createAnimeSwipe().
  $shared.define("anime-swipe", createAnimeSwipe)

  $ui.register((ctx) => {
    const S = $shared.use("anime-swipe")

    const page = ctx.newWebview({
      slot: "screen",
      fullWidth: true,
      // A screen-tall frame that scrolls itself, rather than one sized to fit
      // its content: in a frame with nothing to scroll, Chrome's middle-click
      // autoscroll gets stuck and the wheel stops working until the next click.
      height: "100vh",
      sidebar: { label: "Anime Swipe", icon: S.ICON },
    })

    const payload = ctx.state<any>(null)
    page.channel.sync("data", payload)
    page.setContent(() => S.PAGE_HTML)

    const update = (p: any) => payload.set(Object.assign({}, payload.get() || {}, p))

    // One deck load at a time; a newer filter wins over an older one.
    let loadId = 0
    async function deal(filter: any, more: boolean) {
      const id = ++loadId
      update({ loading: true, error: null })
      const result = await S.deal(filter, more)
      if (id !== loadId) return
      update(Object.assign(result, { loading: false, stats: S.stats() }))
    }

    page.channel.on("deal", (p: any) => { deal(S.savePrefs(p || {}), false) })
    page.channel.on("more", () => { deal(S.readPrefs(), true) })
    page.channel.on("decide", (p: any) => {
      if (!p || !p.id) return
      const error = S.decide(Number(p.id), String(p.action), p.show || null)
      update({ stats: S.stats(), actionError: error || null })
    })
    page.channel.on("undo", (p: any) => {
      if (!p || !p.id) return
      S.undo(Number(p.id))
      update({ stats: S.stats() })
    })
    page.channel.on("open", (p: any) => {
      const id = p && Number(p.id)
      if (id) ctx.screen.navigateTo("/entry", { id: String(id) })
    })

    const start = () => { if (!payload.get() || !payload.get().deck) deal(S.readPrefs(), false) }
    start()
    page.onMount(start)
  })
}

// Everything the plugin does. Self-contained: compiled from its own source
// by $shared, so it may only use globals ($anilist, $storage, fetch, ...).
// Keep it free of anything esbuild compiles into top-level helpers (tagged
// templates like String.raw, for one): those would be outside this function.
function createAnimeSwipe() {
  const PREFS_KEY = "sw-prefs"
  const LIST_KEY = "sw-list-v1"
  const DECIDED_KEY = "sw-decided"
  const LIST_TTL = 10 * 60000
  const PAGES_PER_DEAL = 3
  const GEM_SCORE = 75
  const GEM_POPULARITY = 50000
  const GENRES = ["Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music",
    "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller"]
  const SORTS: { [k: string]: string } = { best: "SCORE_DESC", top: "SCORE_DESC", gems: "SCORE_DESC", popular: "POPULARITY_DESC", new: "START_DATE_DESC" }

  const ICON = `<span style="display:inline-flex;width:24px;height:24px;align-items:center;justify-content:center;color:currentColor"><svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="3" width="12" height="16" rx="2" transform="rotate(12 13 11)"/><rect x="4" y="5" width="12" height="16" rx="2"/><path d="M10 15.5s-2.5-1.4-2.5-3.1a1.4 1.4 0 0 1 2.5-.8 1.4 1.4 0 0 1 2.5.8c0 1.7-2.5 3.1-2.5 3.1z"/></svg></span>`

  const LIST_QUERY = `query ($u: Int) {
    MediaListCollection(userId: $u, type: ANIME) {
      lists { entries {
        status score(format: POINT_100)
        media { id genres studios(isMain: true) { nodes { name } } tags { name rank } }
      } }
    }
  }`

  const DECK_QUERY = `query ($p: Int, $genre: String, $tag: String, $tagRank: Int, $sort: [MediaSort], $popLess: Int, $scoreMore: Int) {
    Page(page: $p, perPage: 50) {
      pageInfo { hasNextPage }
      media(type: ANIME, isAdult: false, genre: $genre, tag: $tag, minimumTagRank: $tagRank, sort: $sort, status_in: [FINISHED, RELEASING],
            format_in: [TV, ONA, MOVIE, OVA], popularity_greater: 1500, popularity_lesser: $popLess, averageScore_greater: $scoreMore) {
        id format episodes duration status seasonYear
        title { userPreferred english }
        coverImage { extraLarge large color }
        bannerImage
        description(asHtml: false)
        genres averageScore popularity
        startDate { year }
        studios(isMain: true) { nodes { name } }
        tags { name rank isMediaSpoiler }
        relations { edges { relationType node { id type } } }
      }
    }
  }`

  // ---------------------------------------------------------------------------
  // AniList
  // ---------------------------------------------------------------------------

  // An AniList error (rate limit, outage) throws: treating it as empty data
  // would show an empty deck as if nothing were left.
  function query(token: string, q: string, variables: any): any {
    const res: any = $anilist.customQuery({ query: q, variables }, token)
    if (!res || (res.errors && !res.data)) {
      throw new Error("AniList didn't answer" + (res && res.errors ? ": " + JSON.stringify(res.errors).slice(0, 120) : ""))
    }
    // customQuery may or may not unwrap "data".
    return res.data ? res.data : res
  }

  // Public data straight from AniList, so pages load in parallel: Seanime's
  // client runs one request at a time and blocks the plugin meanwhile.
  async function gql(q: string, variables: any): Promise<any> {
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query: q, variables }),
    })
    if (!res.ok) throw new Error("AniList HTTP " + res.status)
    const j: any = await res.json()
    if (j.errors) throw new Error("AniList: " + JSON.stringify(j.errors).slice(0, 200))
    return j.data
  }

  function viewerId(token: string): number {
    const cached = $storage.get("sw-viewer")
    if (cached) return cached
    const d = query(token, "query { Viewer { id } }", {})
    const id = d && d.Viewer && d.Viewer.id
    if (!id) throw new Error("could not get the AniList user")
    $storage.set("sw-viewer", id)
    return id
  }

  // ---------------------------------------------------------------------------
  // Your list and taste (as in Season Guide)
  // ---------------------------------------------------------------------------

  // The ids in your list, plus how much you like each genre, studio and tag:
  // scored shows count by how far their score is from your average, unscored
  // ones by their status (dropped counts against).
  function readList(token: string): any {
    const cached = $storage.get(LIST_KEY)
    if (cached && cached.at && Date.now() - cached.at < LIST_TTL) return cached
    const d = query(token, LIST_QUERY, { u: viewerId(token) })
    if (!d || !d.MediaListCollection) throw new Error("AniList returned no list")
    const raw: any[] = []
    for (const l of (d.MediaListCollection.lists || [])) for (const e of (l.entries || [])) if (e && e.media) raw.push(e)

    const scores = raw.filter((e) => e.score > 0).map((e) => e.score)
    const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 70
    const sd = scores.length > 1
      ? Math.sqrt(scores.reduce((a, b) => a + (b - mean) * (b - mean), 0) / scores.length)
      : 10
    const byStatus: { [s: string]: number } = { COMPLETED: 0.4, REPEATING: 0.6, CURRENT: 0.25, PAUSED: 0, DROPPED: -1, PLANNING: 0.15 }
    const sum: { [f: string]: number } = {}
    const weight: { [f: string]: number } = {}
    for (const e of raw) {
      const w = e.score > 0
        ? Math.max(-2, Math.min(2, (e.score - mean) / Math.max(sd, 5)))
        : (byStatus[e.status] || 0)
      const add = (f: string, fw: number) => {
        sum[f] = (sum[f] || 0) + w * fw
        weight[f] = (weight[f] || 0) + fw
      }
      for (const g of (e.media.genres || [])) add("g:" + g, 1)
      for (const s of ((e.media.studios && e.media.studios.nodes) || [])) add("s:" + s.name, 0.8)
      for (const t of (e.media.tags || [])) if (t && t.rank >= 60) add("t:" + t.name, (t.rank / 100) * 0.6)
    }
    const affinity: { [f: string]: number } = {}
    for (const f in sum) affinity[f] = sum[f] / (weight[f] + 2)
    const list = { at: Date.now(), ids: raw.map((e) => e.media.id), affinity }
    $storage.set(LIST_KEY, list)
    return list
  }

  // 0-100 match with your taste, and what pushed it up and down the most.
  function matchOf(genres: string[], studios: string[], tags: string[], affinity: { [f: string]: number }): any {
    let total = 0
    let weights = 0
    const parts: { name: string, v: number }[] = []
    const add = (f: string, name: string, fw: number) => {
      const a = affinity[f] || 0
      total += a * fw
      weights += fw
      if (Math.abs(a) >= 0.08) parts.push({ name, v: a * fw })
    }
    for (const g of genres) add("g:" + g, g, 1)
    for (const s of studios) add("s:" + s, s, 0.8)
    for (const t of tags) add("t:" + t, t, 0.5)
    // The extra weight pulls shows we know little about towards 50%.
    const raw = total / (weights + 1.5)
    return {
      match: Math.round(100 / (1 + Math.exp(-raw * 7))),
      why: {
        p: parts.filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 4).map((x) => x.name),
        n: parts.filter((x) => x.v < 0).sort((a, b) => a.v - b.v).slice(0, 3).map((x) => x.name),
      },
    }
  }

  // ---------------------------------------------------------------------------
  // Deck
  // ---------------------------------------------------------------------------

  // AniList descriptions come with <br>, <i> and source notes.
  function cleanDescription(s: string): string {
    if (!s) return ""
    let out = s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    out = out.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    out = out.replace(/\(Source:[^)]*\)/gi, "").replace(/\[Written by[^\]]*\]/gi, "").replace(/\n{3,}/g, "\n\n").trim()
    return out.length > 1200 ? out.slice(0, 1200).replace(/\s+\S*$/, "") + "…" : out
  }

  // The anime a show continues (prequel or parent story), if any: a sequel
  // or a side story.
  function prequelsOf(m: any): number[] {
    const out: number[] = []
    for (const e of ((m.relations && m.relations.edges) || [])) {
      if (e && e.node && e.node.type === "ANIME" && (e.relationType === "PREQUEL" || e.relationType === "PARENT")) out.push(e.node.id)
    }
    return out
  }

  // The subgenre you picked always shows (first), even if AniList marks it
  // as a spoiler or it's further down the list.
  function toCard(m: any, affinity: { [f: string]: number }, pickedTag: string): any {
    const tags: string[] = pickedTag ? [pickedTag] : []
    for (const t of (m.tags || [])) if (t && !t.isMediaSpoiler && t.rank >= 50 && tags.length < 10 && t.name !== pickedTag) tags.push(t.name)
    const studios = ((m.studios && m.studios.nodes) || []).map((s: any) => s.name)
    const taste = matchOf(m.genres || [], studios, tags.filter((t) => t !== pickedTag || (m.tags || []).some((x: any) => x.name === t && x.rank >= 60)).slice(0, 8), affinity)
    const english = m.title && m.title.english
    const title = (m.title && m.title.userPreferred) || english || "?"
    return {
      id: m.id,
      title,
      english: english && english !== title ? english : "",
      cover: (m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || "",
      banner: m.bannerImage || "",
      color: (m.coverImage && m.coverImage.color) || "",
      format: m.format || "",
      episodes: m.episodes || 0,
      duration: m.duration || 0,
      status: m.status || "",
      year: m.seasonYear || (m.startDate && m.startDate.year) || 0,
      description: cleanDescription(m.description || ""),
      genres: m.genres || [],
      tags,
      studios,
      score: m.averageScore || 0,
      popularity: m.popularity || 0,
      match: taste.match,
      why: taste.why,
      gem: (m.averageScore || 0) >= GEM_SCORE && (m.popularity || 0) < GEM_POPULARITY,
    }
  }

  // Where each filter's deck has got to, so "more" fetches the next pages.
  const cursors: { [key: string]: number } = {}
  // The subgenres last found for each genre.
  const tagsByGenre: { [genre: string]: string[][] } = {}

  function filterKey(f: any): string { return [f.genre, f.tag, f.sort].join("|") }

  // Pages fetched in the last half hour, by filter and page number, so going
  // back to a genre costs no requests (AniList allows only so many a minute).
  const pageCache: { [key: string]: { at: number, d: any } } = {}
  const PAGE_TTL = 30 * 60000

  async function fetchPages(token: string, f: any, from: number, count: number): Promise<{ media: any[], more: boolean }> {
    const vars = (p: number) => ({
      p,
      genre: f.genre || undefined,
      tag: f.tag || undefined,
      // Only shows the subgenre really is about, not ones with a passing mention.
      tagRank: f.tag ? 60 : undefined,
      sort: [SORTS[f.sort] || "SCORE_DESC", "POPULARITY_DESC"],
      popLess: f.sort === "gems" ? GEM_POPULARITY : undefined,
      // "Newest" would otherwise be all unrated shows from last week.
      scoreMore: f.sort === "new" ? 65 : undefined,
    })
    const pages: number[] = []
    for (let p = from; p < from + count; p++) pages.push(p)
    const key = filterKey(f) + "#"
    const cached = (p: number) => { const c = pageCache[key + p]; return c && Date.now() - c.at < PAGE_TTL ? c.d : null }
    let results: any[]
    try {
      results = await Promise.all(pages.map((p) => cached(p) || gql(DECK_QUERY, vars(p))))
    } catch (e) {
      console.error("Anime Swipe: direct AniList request failed, using Seanime's client: " + e)
      results = pages.map((p) => cached(p) || query(token, DECK_QUERY, vars(p)))
    }
    pages.forEach((p, i) => { if (!cached(p)) pageCache[key + p] = { at: Date.now(), d: results[i] } })
    const media: any[] = []
    let more = false
    for (const d of results) {
      for (const m of ((d && d.Page && d.Page.media) || [])) media.push(m)
      more = !!(d && d.Page && d.Page.pageInfo && d.Page.pageInfo.hasNextPage)
    }
    return { media, more }
  }

  // The most common subgenres (tags) among the shows of a genre.
  function countTags(media: any[], genre: string): string[][] {
    const n: { [t: string]: number } = {}
    for (const m of media) for (const t of (m.tags || [])) if (t && t.rank >= 60 && !t.isMediaSpoiler) n[t.name] = (n[t.name] || 0) + 1
    const skip: { [t: string]: boolean } = { "Male Protagonist": true, "Female Protagonist": true, "Primarily Teen Cast": true, "Primarily Adult Cast": true,
      "Primarily Female Cast": true, "Primarily Male Cast": true, "Ensemble Cast": true, "Episodic": true, "Shounen": true, "Seinen": true, "Shoujo": true, "Josei": true, "Heterosexual": true }
    const out: string[][] = []
    for (const t in n) if (!skip[t] && t !== genre && n[t] >= 3) out.push([t, String(n[t])])
    out.sort((a, b) => Number(b[1]) - Number(a[1]))
    return out.slice(0, 24)
  }

  // A deck for the filter: shows not in your list and not decided on, best
  // first. "For you" mixes taste and score; the others keep AniList's order.
  async function deal(f: any, more: boolean): Promise<any> {
    try {
      const token = $database.anilist.getToken()
      if (!token) return { error: "Not logged in to AniList: log in in Seanime.", filter: f }
      const list = readList(token)
      const key = filterKey(f)
      const from = more ? (cursors[key] || 1) : 1
      const got = await fetchPages(token, f, from, PAGES_PER_DEAL)
      cursors[key] = from + PAGES_PER_DEAL
      // Subgenres come from the genre's own shows; with a subgenre already
      // picked (say, saved from last time), from what we have.
      if ((!f.tag && from === 1) || !tagsByGenre[f.genre || ""]) tagsByGenre[f.genre || ""] = countTags(got.media, f.genre || "")

      const skip: { [id: string]: boolean } = {}
      for (const id of list.ids) skip[String(id)] = true
      const decided = $storage.get(DECIDED_KEY) || {}
      for (const id in decided) skip[id] = true
      // No sequels: of a show you haven't seen they're no use, and Seanime
      // already lists the missed sequels of the ones you have.
      const cards = got.media
        .filter((m) => m && !skip[String(m.id)] && !prequelsOf(m).length)
        .map((m) => toCard(m, list.affinity, f.tag || ""))
      if (f.sort === "best" || f.sort === "gems") {
        const value = (c: any) => 0.55 * c.match + 0.45 * (c.score ? Math.max(0, Math.min(100, (c.score - 55) * 3)) : 30)
        cards.sort((a, b) => value(b) - value(a))
      }
      return {
        filter: f,
        deckKey: key + "#" + Date.now(),
        deck: cards,
        append: more,
        hasMore: got.more,
        tags: tagsByGenre[f.genre || ""] || [],
        genres: GENRES,
      }
    } catch (e) {
      console.error("Anime Swipe: " + e)
      // An empty deck, so the old filter's cards don't stay up under the new one.
      const limited = /429|Too Many/i.test(String(e))
      return {
        error: limited ? "AniList is limiting requests for a minute. Wait a moment and pick the filter again." : "Couldn't load shows: " + e,
        filter: f, genres: GENRES, deck: [], deckKey: "error#" + Date.now(), append: false, hasMore: false, tags: tagsByGenre[f.genre || ""] || [],
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Decisions
  // ---------------------------------------------------------------------------

  // plan: add to your Planning list; pass and seen: just never show it again.
  // Returns an error message, or "" if all went well.
  function decide(id: number, action: string, show: any): string {
    if (["plan", "pass", "seen"].indexOf(action) < 0) return ""
    let error = ""
    if (action === "plan") {
      try {
        $anilist.updateEntry(id, "PLANNING" as any, undefined, undefined, undefined, undefined)
        $anilist.refreshAnimeCollection()
      } catch (e) {
        console.error("Anime Swipe: add to planning: " + e)
        error = "Couldn't add it to Planning: " + e
      }
    }
    const decided = $storage.get(DECIDED_KEY) || {}
    decided[String(id)] = { a: action, at: Date.now(), t: show ? String(show.title || "").slice(0, 120) : "", c: show ? String(show.cover || "") : "" }
    $storage.set(DECIDED_KEY, decided)
    // The list cache would otherwise offer it again in another genre.
    if (action === "plan") {
      const list = $storage.get(LIST_KEY)
      if (list && list.ids) { list.ids.push(id); $storage.set(LIST_KEY, list) }
    }
    return error
  }

  // Takes back the last decision: a show added to Planning is removed again.
  function undo(id: number) {
    const decided = $storage.get(DECIDED_KEY) || {}
    const d = decided[String(id)]
    if (!d) return
    if (d.a === "plan") {
      try {
        $anilist.deleteEntry(id)
        $anilist.refreshAnimeCollection()
      } catch (e) { console.error("Anime Swipe: undo: " + e) }
      const list = $storage.get(LIST_KEY)
      if (list && list.ids) { list.ids = list.ids.filter((x: number) => x !== id); $storage.set(LIST_KEY, list) }
    }
    delete decided[String(id)]
    $storage.set(DECIDED_KEY, decided)
  }

  // Counts, and the shows you added most recently.
  function stats(): any {
    const decided = $storage.get(DECIDED_KEY) || {}
    const out = { plan: 0, pass: 0, seen: 0, recent: [] as any[] }
    const added: any[] = []
    for (const id in decided) {
      const d = decided[id]
      if (d.a in out) (out as any)[d.a]++
      if (d.a === "plan") added.push({ id: Number(id), title: d.t, cover: d.c, at: d.at })
    }
    added.sort((a, b) => b.at - a.at)
    out.recent = added.slice(0, 12)
    return out
  }

  // ---------------------------------------------------------------------------
  // Preferences: the filter
  // ---------------------------------------------------------------------------

  function cleanPrefs(p: any): any {
    p = p || {}
    return {
      genre: GENRES.indexOf(p.genre) >= 0 ? p.genre : "",
      tag: typeof p.tag === "string" ? p.tag.slice(0, 60) : "",
      sort: SORTS[p.sort] ? p.sort : "best",
    }
  }

  function readPrefs(): any {
    try { return cleanPrefs($storage.get(PREFS_KEY)) } catch (e) { return cleanPrefs(null) }
  }

  function savePrefs(p: any): any {
    const prefs = cleanPrefs(Object.assign({}, readPrefs(), p || {}))
    $storage.set(PREFS_KEY, prefs)
    return prefs
  }

  // ---------------------------------------------------------------------------
  // Page (runs inside the webview iframe). A plain template literal: no
  // backslashes and no interpolation inside, so nothing to escape.
  // ---------------------------------------------------------------------------

  const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  :root {
    --bg: #0b0b0d; --paper: #131317; --paper2: #1a1a20; --line: #26262e;
    --text: #ececf1; --muted: #8a8a96; --brand: #7c6cf2; --on-brand: #fff;
    --yellow: #e6b422; --green: #3fbf6a; --blue: #5b8def; --red: #ff6b6b; --gem: #4fd1c5;
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); color-scheme: dark; scrollbar-width: thin; scrollbar-color: #3a3a46 transparent; }
  html, body { margin: 0; color: var(--text); font: 14px/1.45 Inter, "Segoe UI", system-ui, sans-serif; }
  body { position: relative; overflow-x: hidden; }
  .hero { position: absolute; top: 0; left: 0; right: 0; height: 520px; pointer-events: none;
    background-size: cover; background-position: center 30%; opacity: .45; transition: background-image .3s;
    -webkit-mask-image: linear-gradient(to bottom, #000 0%, rgba(0,0,0,.55) 45%, transparent 100%);
    mask-image: linear-gradient(to bottom, #000 0%, rgba(0,0,0,.55) 45%, transparent 100%); }
  .hero.cover { filter: blur(28px) saturate(1.4); transform: scale(1.15); opacity: .55; }
  .wrap { position: relative; padding: 8px 4px 32px; max-width: 1200px; margin: 0 auto; }
  h1 { margin: 0; font-weight: 700; letter-spacing: -.01em; }
  .muted { color: var(--muted); }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .spacer { flex: 1; }
  button { font: inherit; color: var(--text); background: var(--paper2); border: 1px solid var(--line);
    border-radius: 10px; padding: 7px 13px; cursor: pointer; }
  button:hover { border-color: #3a3a46; background: #202028; }
  button:disabled { opacity: .45; cursor: default; }
  .seg { display: inline-flex; background: var(--paper2); border: 1px solid var(--line); border-radius: 10px; padding: 2px; }
  .seg button { border: 0; background: transparent; padding: 5px 11px; border-radius: 8px; color: var(--muted); }
  .seg button.on { background: var(--brand); color: var(--on-brand); font-weight: 600; }
  .chip { border-radius: 99px; padding: 3px 11px; font-size: 13px; color: var(--muted); }
  .chip.on { border-color: var(--brand); color: var(--text); background: color-mix(in srgb, var(--brand) 22%, var(--paper2)); }
  .chip small { color: var(--muted); margin-left: 3px; }
  section { background: rgba(19,19,23,.86); border: 1px solid var(--line); border-radius: 16px; padding: 14px 16px; margin-top: 14px; }
  .head { min-height: 120px; align-items: flex-end; padding-bottom: 4px; }
  .head h1 { font-size: 34px; text-shadow: 0 2px 12px rgba(0,0,0,.6); }
  .head .sub { font-size: 13px; color: #d4d4dc; text-shadow: 0 1px 6px rgba(0,0,0,.8); margin-top: 2px; }
  .label { width: 82px; flex: none; color: var(--muted); font-size: 13px; }
  .filters .row + .row { margin-top: 8px; }
  .filters .row { align-items: flex-start; }
  .filters .label { padding-top: 5px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; }

  /* The deck */
  .stage { position: relative; margin: 18px auto 0; max-width: 900px; min-height: 470px; }
  .card { position: absolute; inset: 0 0 auto 0; display: flex; gap: 22px; padding: 18px; background: var(--paper2);
    border: 1px solid var(--line); border-radius: 20px; box-shadow: 0 14px 40px rgba(0,0,0,.5); touch-action: none;
    user-select: none; cursor: grab; transition: transform .28s ease, opacity .28s ease; min-height: 450px; }
  .card.dragging { transition: none; cursor: grabbing; }
  .card.next { transform: scale(.96) translateY(14px); opacity: .55; pointer-events: none; z-index: 0; }
  .card.top { z-index: 1; position: relative; }
  .card.fly-plan { transform: translateX(130%) rotate(16deg); opacity: 0; }
  .card.fly-pass { transform: translateX(-130%) rotate(-16deg); opacity: 0; }
  .card.fly-seen { transform: translateY(-120%); opacity: 0; }
  .card .poster { width: 290px; height: 412px; flex: none; border-radius: 14px; object-fit: cover; background: #222; pointer-events: none; }
  .card .info { display: flex; flex-direction: column; gap: 8px; min-width: 0; flex: 1; }
  .card h2 { margin: 0; font-size: 24px; line-height: 1.2; }
  .card .en { color: var(--muted); font-size: 14px; margin-top: -4px; }
  .meta { color: var(--muted); font-size: 13px; }
  .meta b { color: var(--text); font-weight: 600; }
  .pills { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
  .pill { font-size: 12px; padding: 2px 9px; border-radius: 99px; background: #23232b; color: #c4c4cc; }
  .pill.genre { background: #2a2a34; color: #e2e2ea; }
  .pill.hit { background: color-mix(in srgb, var(--brand) 35%, transparent); color: var(--text); }
  .pill.match { background: color-mix(in srgb, var(--brand) 22%, transparent); color: var(--text); cursor: help; }
  .pill.gem { background: rgba(79,209,197,.15); color: var(--gem); }
  .score { font-size: 15px; font-weight: 700; }
  .desc { color: #cfcfd8; font-size: 13.5px; white-space: pre-line; overflow: hidden; display: -webkit-box;
    -webkit-line-clamp: 9; -webkit-box-orient: vertical; }
  .desc.full { -webkit-line-clamp: unset; display: block; }
  .link { color: var(--muted); font-size: 12px; cursor: pointer; text-decoration: underline; }
  .stamp { position: absolute; top: 34px; padding: 6px 16px; border: 4px solid; border-radius: 12px; font-size: 30px;
    font-weight: 800; letter-spacing: .08em; opacity: 0; pointer-events: none; text-transform: uppercase; }
  .stamp.plan { left: 34px; color: var(--green); border-color: var(--green); transform: rotate(-14deg); }
  .stamp.pass { right: 34px; color: var(--red); border-color: var(--red); transform: rotate(14deg); }
  .stamp.seen { left: 50%; top: auto; bottom: 30px; transform: translateX(-50%); color: var(--blue); border-color: var(--blue); }

  .actions { display: flex; justify-content: center; align-items: center; gap: 16px; margin: 20px 0 6px; }
  .act { width: 64px; height: 64px; border-radius: 99px; padding: 0; font-size: 26px; display: inline-flex; align-items: center; justify-content: center; }
  .act.pass { color: var(--red); }
  .act.plan { color: var(--green); width: 74px; height: 74px; font-size: 30px; }
  .act.seen { color: var(--blue); width: 54px; height: 54px; font-size: 20px; }
  .act.undo { color: var(--muted); width: 46px; height: 46px; font-size: 18px; }
  .act:hover { transform: scale(1.06); }
  .keys { text-align: center; color: var(--muted); font-size: 12px; }
  .keys b { display: inline-block; min-width: 20px; padding: 0 5px; border: 1px solid var(--line); border-radius: 5px; background: var(--paper2); color: var(--text); font-weight: 600; }

  .added { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; }
  .added img { width: 54px; height: 76px; object-fit: cover; border-radius: 7px; cursor: pointer; flex: none; background: #222; }
  .toast { color: var(--red); font-size: 13px; text-align: center; }

  #tip { position: absolute; display: none; z-index: 50; max-width: 320px; pointer-events: none;
    background: #1f1f27; border: 1px solid #34343f; border-radius: 10px; padding: 10px 12px; font-size: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,.5); }
  #tip b { font-size: 13px; display: block; margin-bottom: 6px; }
  #tip div { margin-top: 3px; }
  .tip-row { display: flex; gap: 8px; }
  .tip-label { flex: none; width: 96px; color: var(--muted); }
  .tip-label.good { color: var(--green); }
  .tip-label.bad { color: var(--red); }
  .tip-foot { color: var(--muted); font-size: 11px; margin-top: 8px !important; }
  .empty { color: var(--muted); padding: 40px 24px; text-align: center; }
  .error { color: var(--red); }
  @media (max-width: 760px) {
    .card { flex-direction: column; align-items: center; }
    .card .poster { width: 200px; height: 284px; }
    .stage { min-height: 760px; }
  }
</style>
</head>
<body>
<div class="hero" id="hero"></div>
<div class="wrap" id="root"><div class="empty">Loading…</div></div>
<div id="tip"></div>
<script>
var DATA = null;
// The cards still to come, and what was decided (for undo).
var QUEUE = [];
var DECK_KEY = "";
var HISTORY = [];
// Cards decided on in this session stay gone even if a reload brings them back.
var SEEN_IN_SESSION = {};
var ASKED_MORE = false;
// Loads in a row that brought nothing new (you've seen everything they had);
// after a few, stop asking for more.
var EMPTY_LOADS = 0;
var FULL_DESC = false;
var SORTS = [["best", "For you"], ["top", "Top rated"], ["gems", "Hidden gems"], ["popular", "Popular"], ["new", "Newest"]];
var FORMAT_NAME = { TV: "TV", TV_SHORT: "TV Short", ONA: "ONA", MOVIE: "Movie", OVA: "OVA", SPECIAL: "Special" };

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function send(ev, p) { window.webview.send(ev, p || {}); }
function filter() { return (DATA && DATA.filter) || { genre: "", tag: "", sort: "best" }; }
function hexToRgb(h) {
  if (!h || h.charAt(0) !== "#" || h.length !== 7) return null;
  return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)];
}
// Banner and accent colour of the card on top.
function applyTheme(top) {
  var hero = document.getElementById("hero");
  var img = top && (top.banner || top.cover);
  hero.style.backgroundImage = img ? 'url("' + String(img).replace(/"/g, "%22") + '")' : "none";
  hero.className = "hero" + (top && !top.banner ? " cover" : "");
  var css = document.documentElement.style;
  var rgb = top && hexToRgb(top.color);
  var brand = "#7c6cf2", onBrand = "#fff";
  if (rgb) {
    var lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    var spread = Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
    if (lum > 0.22 && lum < 0.85 && spread > 40) { brand = top.color; onBrand = lum > 0.6 ? "#111" : "#fff"; }
  }
  css.setProperty("--brand", brand);
  css.setProperty("--on-brand", onBrand);
}
function users(n) { return n >= 1000000 ? (n / 1000000).toFixed(1) + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(n); }

// ---------- match tooltip ----------
function tipRow(label, c, text) { return '<div class="tip-row"><span class="tip-label ' + c + '">' + label + '</span><span>' + text + '</span></div>'; }
function showTip(el) {
  var c = QUEUE[0];
  if (!c) return;
  var w = c.why || { p: [], n: [] };
  var html = '<b>' + c.match + '% match</b>';
  if (w.p.length) html += tipRow("You like", "good", esc(w.p.join(", ")));
  if (w.n.length) html += tipRow("Not your thing", "bad", esc(w.n.join(", ")));
  if (!w.p.length && !w.n.length) html += '<div class="muted">Not enough in common with your list to tell — neutral.</div>';
  html += '<div class="tip-foot">From genres, studios and tags of what you scored and watched on AniList.</div>';
  var tip = document.getElementById("tip");
  tip.innerHTML = html;
  tip.style.display = "block";
  var r = el.getBoundingClientRect();
  var left = Math.min(r.left + window.scrollX, document.documentElement.clientWidth - tip.offsetWidth - 8);
  var top = r.top + window.scrollY - tip.offsetHeight - 8;
  if (top < window.scrollY + 4) top = r.bottom + window.scrollY + 8;
  tip.style.left = Math.max(8, left) + "px";
  tip.style.top = top + "px";
}
function hideTip() { var tip = document.getElementById("tip"); if (tip) tip.style.display = "none"; }
document.addEventListener("mouseover", function (ev) {
  if (DRAG) return;
  var el = ev.target.closest ? ev.target.closest("[data-tip]") : null;
  if (el) showTip(el); else hideTip();
});
document.addEventListener("scroll", hideTip, true);

// ---------- rendering ----------
function cardHtml(c, cls) {
  var f = filter();
  var meta = [];
  meta.push("<b>" + esc(FORMAT_NAME[c.format] || c.format) + "</b>");
  if (c.episodes > 1) meta.push(c.episodes + " eps" + (c.duration ? " × " + c.duration + " min" : ""));
  else if (c.duration) meta.push(c.duration + " min");
  if (c.year) meta.push(String(c.year));
  if (c.status === "RELEASING") meta.push("airing");
  if (c.studios.length) meta.push(esc(c.studios.join(", ")));
  return '<div class="card ' + cls + '" data-id="' + c.id + '">' +
    '<div class="stamp plan">Plan</div><div class="stamp pass">Nope</div><div class="stamp seen">Seen</div>' +
    '<img class="poster" src="' + esc(c.cover) + '" draggable="false">' +
    '<div class="info"><h2>' + esc(c.title) + '</h2>' + (c.english ? '<div class="en">' + esc(c.english) + '</div>' : '') +
    '<div class="meta">' + meta.join(" · ") + '</div>' +
    '<div class="pills"><span class="score">' + (c.score ? "★ " + (c.score / 10).toFixed(1) : "★ —") + '</span>' +
    '<span class="pill">' + users(c.popularity) + ' users</span>' +
    '<span class="pill match" data-tip="match">' + c.match + '% match</span>' +
    (c.gem ? '<span class="pill gem">Hidden gem</span>' : '') + '</div>' +
    '<div class="pills">' + c.genres.map(function (g) { return '<span class="pill genre' + (g === f.genre ? " hit" : "") + '">' + esc(g) + '</span>'; }).join("") + '</div>' +
    '<div class="pills">' + c.tags.map(function (t) { return '<span class="pill' + (t === f.tag ? " hit" : "") + '">' + esc(t) + '</span>'; }).join("") + '</div>' +
    '<div class="desc' + (FULL_DESC ? " full" : "") + '">' + esc(c.description || "No description.") + '</div>' +
    '<div class="row"><span class="link" data-act="desc">' + (FULL_DESC ? "Less" : "More") + '</span><span class="spacer"></span>' +
    '<span class="link" data-act="open">Open in Seanime</span></div>' +
    '</div></div>';
}
function renderStage() {
  var stage = document.getElementById("stage");
  if (!stage) return;
  var c = QUEUE[0];
  applyTheme(c || null);
  if (!c) {
    stage.innerHTML = '<div class="empty">' + (DATA.loading ? "Dealing cards…" : DATA.hasMore && EMPTY_LOADS < 4 ? "Dealing more…" :
      "That's every show for this filter. Try another genre or subgenre.") + '</div>';
    return;
  }
  stage.innerHTML = (QUEUE[1] ? cardHtml(QUEUE[1], "next") : "") + cardHtml(c, "top");
  bindDrag(stage.querySelector(".card.top"));
  var undo = document.querySelector('[data-act="undo"]');
  if (undo) undo.disabled = !HISTORY.length;
  // Ask for the next pages before the deck runs out.
  if (QUEUE.length < 8 && DATA.hasMore && !ASKED_MORE && !DATA.loading && EMPTY_LOADS < 4) { ASKED_MORE = true; send("more"); }
}
function renderAdded() {
  var el = document.getElementById("added");
  if (!el) return;
  var s = DATA.stats || { recent: [] };
  el.innerHTML = s.recent.length ? '<div class="row" style="margin-bottom:8px"><b>Added to Planning</b><span class="muted">· ' + s.plan + '</span></div>' +
    '<div class="added">' + s.recent.map(function (r) { return '<img src="' + esc(r.cover) + '" title="' + esc(r.title) + '" data-open="' + r.id + '">'; }).join("") + '</div>' : "";
  el.style.display = s.recent.length ? "" : "none";
}
function render() {
  var root = document.getElementById("root");
  if (!DATA) { root.innerHTML = '<div class="empty">Loading…</div>'; return; }
  var f = filter();
  var s = DATA.stats || { plan: 0, pass: 0, seen: 0 };
  var sub = s.plan + " added to Planning · " + (s.pass + s.seen) + " passed";
  var genres = '<button class="chip' + (!f.genre ? " on" : "") + '" data-act="genre" data-v="">Any</button>' +
    (DATA.genres || []).map(function (g) { return '<button class="chip' + (f.genre === g ? " on" : "") + '" data-act="genre" data-v="' + esc(g) + '">' + esc(g) + '</button>'; }).join("");
  var tags = (DATA.tags || []).slice();
  if (f.tag && !tags.some(function (t) { return t[0] === f.tag; })) tags.unshift([f.tag, ""]);
  var tagChips = '<button class="chip' + (!f.tag ? " on" : "") + '" data-act="tag" data-v="">Any</button>' +
    tags.map(function (t) { return '<button class="chip' + (f.tag === t[0] ? " on" : "") + '" data-act="tag" data-v="' + esc(t[0]) + '">' + esc(t[0]) + (t[1] ? '<small>' + t[1] + '</small>' : '') + '</button>'; }).join("");
  var sorts = '<span class="seg">' + SORTS.map(function (o) { return '<button data-act="sort" data-v="' + o[0] + '" class="' + (f.sort === o[0] ? "on" : "") + '">' + o[1] + '</button>'; }).join("") + '</span>';
  root.innerHTML = '<div class="row head"><div><h1>Anime Swipe</h1><div class="sub">' + esc(sub) +
    (DATA.loading ? " · loading…" : "") + '</div></div><span class="spacer"></span>' + sorts + '</div>' +
    '<section class="filters"><div class="row"><span class="label">Genre</span><div class="chips">' + genres + '</div></div>' +
    '<div class="row"><span class="label">Subgenre</span><div class="chips">' + tagChips + '</div></div></section>' +
    (DATA.error ? '<section><div class="empty error">' + esc(DATA.error) + '</div></section>' : '') +
    '<div class="stage" id="stage"></div>' +
    '<div class="actions"><button class="act undo" data-act="undo" title="Undo (Z)">↶</button>' +
    '<button class="act pass" data-act="pass" title="Not interested (←)">✕</button>' +
    '<button class="act seen" data-act="seen" title="Seen it (↑)">👁</button>' +
    '<button class="act plan" data-act="plan" title="Add to Planning (→)">♥</button></div>' +
    '<div class="keys"><b>←</b> not interested · <b>↑</b> seen it · <b>→</b> add to Planning · <b>Z</b> undo · drag the card</div>' +
    (DATA.actionError ? '<div class="toast">' + esc(DATA.actionError) + '</div>' : '') +
    '<section id="added"></section>';
  renderStage();
  renderAdded();
}

// ---------- deciding ----------
var BUSY = false;
function decide(action) {
  var c = QUEUE[0];
  if (!c || BUSY) return;
  BUSY = true;
  hideTip();
  var el = document.querySelector(".card.top");
  if (el) { el.style.transform = ""; el.classList.add("fly-" + action); }
  SEEN_IN_SESSION[c.id] = true;
  send("decide", { id: c.id, action: action, show: { title: c.title, cover: c.cover } });
  HISTORY.push({ card: c, action: action });
  setTimeout(function () {
    QUEUE.shift();
    FULL_DESC = false;
    BUSY = false;
    renderStage();
  }, 260);
}
function undo() {
  var last = HISTORY.pop();
  if (!last || BUSY) return;
  delete SEEN_IN_SESSION[last.card.id];
  send("undo", { id: last.card.id });
  QUEUE.unshift(last.card);
  renderStage();
}

// ---------- dragging ----------
var DRAG = null;
function bindDrag(el) {
  if (!el) return;
  el.addEventListener("pointerdown", function (ev) {
    if (ev.button !== 0 || (ev.target.closest && ev.target.closest(".link,[data-tip]"))) return;
    DRAG = { x: ev.clientX, y: ev.clientY, dx: 0, dy: 0, el: el, id: ev.pointerId };
    el.setPointerCapture(ev.pointerId);
    el.classList.add("dragging");
  });
  el.addEventListener("pointermove", function (ev) {
    if (!DRAG || DRAG.el !== el) return;
    DRAG.dx = ev.clientX - DRAG.x; DRAG.dy = ev.clientY - DRAG.y;
    el.style.transform = "translate(" + DRAG.dx + "px," + Math.min(0, DRAG.dy) * 0.9 + "px) rotate(" + DRAG.dx / 18 + "deg)";
    var up = DRAG.dy < -60 && Math.abs(DRAG.dy) > Math.abs(DRAG.dx);
    el.querySelector(".stamp.plan").style.opacity = up ? 0 : Math.max(0, Math.min(1, DRAG.dx / 120));
    el.querySelector(".stamp.pass").style.opacity = up ? 0 : Math.max(0, Math.min(1, -DRAG.dx / 120));
    el.querySelector(".stamp.seen").style.opacity = up ? Math.min(1, -DRAG.dy / 140) : 0;
  });
  var end = function () {
    if (!DRAG || DRAG.el !== el) return;
    var d = DRAG; DRAG = null;
    el.classList.remove("dragging");
    if (d.dy < -110 && Math.abs(d.dy) > Math.abs(d.dx)) return decide("seen");
    if (d.dx > 120) return decide("plan");
    if (d.dx < -120) return decide("pass");
    el.style.transform = "";
    ["plan", "pass", "seen"].forEach(function (s) { el.querySelector(".stamp." + s).style.opacity = 0; });
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

document.addEventListener("keydown", function (ev) {
  if (!DATA || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.key === "ArrowRight") { ev.preventDefault(); decide("plan"); }
  else if (ev.key === "ArrowLeft") { ev.preventDefault(); decide("pass"); }
  else if (ev.key === "ArrowUp") { ev.preventDefault(); decide("seen"); }
  else if (ev.key === "z" || ev.key === "Z" || ev.key === "Backspace") { ev.preventDefault(); undo(); }
});

function setFilter(p) {
  var f = Object.assign({}, filter(), p);
  DATA.filter = f;
  DATA.loading = true;
  QUEUE = [];
  ASKED_MORE = false;
  send("deal", f);
  render();
}

document.addEventListener("click", function (ev) {
  var el = ev.target.closest ? ev.target.closest("[data-act],[data-open]") : null;
  if (!el || !DATA) return;
  var act = el.getAttribute("data-act"), v = el.getAttribute("data-v");
  var open = el.getAttribute("data-open");
  if (open) { send("open", { id: Number(open) }); return; }
  if (act === "plan" || act === "pass" || act === "seen") decide(act);
  else if (act === "undo") undo();
  else if (act === "open" && QUEUE[0]) send("open", { id: QUEUE[0].id });
  else if (act === "desc") { FULL_DESC = !FULL_DESC; renderStage(); }
  // A new genre starts from all its subgenres.
  else if (act === "genre") setFilter({ genre: v, tag: "" });
  else if (act === "tag") setFilter({ tag: v });
  else if (act === "sort") setFilter({ sort: v });
});

window.webview.on("data", function (d) {
  var prevKey = DECK_KEY;
  DATA = d;
  if (d && d.deck && d.deckKey !== prevKey) {
    DECK_KEY = d.deckKey;
    // Fresh deck for a new filter; more pages for the same one are appended.
    var incoming = d.deck.filter(function (c) { return !SEEN_IN_SESSION[c.id]; });
    if (d.append) {
      var have = {};
      QUEUE.forEach(function (c) { have[c.id] = true; });
      var fresh = incoming.filter(function (c) { return !have[c.id]; });
      EMPTY_LOADS = fresh.length ? 0 : EMPTY_LOADS + 1;
      QUEUE = QUEUE.concat(fresh);
    } else { QUEUE = incoming; EMPTY_LOADS = 0; }
    ASKED_MORE = false;
    render();
    return;
  }
  // Only counts or an error changed: keep the stage as it is.
  var stage = document.getElementById("stage");
  if (!stage || d.error || d.loading) render(); else { renderAdded(); var sub = document.querySelector(".head .sub"); if (sub) { var s = d.stats; sub.textContent = s.plan + " added to Planning · " + (s.pass + s.seen) + " passed"; } }
});
render();
</script>
</body>
</html>`

  return { ICON, PAGE_HTML, deal, decide, undo, stats, readPrefs, savePrefs }
}
