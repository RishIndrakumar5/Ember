(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    url: $("url-input"),
    fetchBtn: $("fetch-btn"),
    generateBtn: $("generate-btn"),
    copyBtn: $("copy-btn"),
    status: $("status"),
    author: $("author"),
    year: $("year"),
    title: $("title"),
    site: $("site"),
    accessed: $("accessed"),
    format: $("format"),
    citationBlock: $("citation-block"),
    citationLabel: $("citation-label"),
    citationOutput: $("citation-output"),
    detailsSection: $("details-section"),
    detectedBlock: $("detected-block"),
    detectedList: $("detected-list"),
    neededBlock: $("needed-block"),
    neededHint: $("needed-hint"),
    allFound: $("all-found"),
    editAllBtn: $("edit-all-btn"),
    outputPanel: $("output-panel"),
    linkMode: $("link-mode"),
    convertMode: $("convert-mode"),
    citationInput: $("citation-input"),
    convertBtn: $("convert-btn"),
    sourcesBlock: $("sources-block"),
    sourcesBtn: $("sources-btn"),
    sourcesStatus: $("sources-status"),
    sourcesList: $("sources-list"),
    credibilityBlock: $("credibility-block"),
    credibilityStatus: $("credibility-status"),
    credibilityVerdict: $("credibility-verdict"),
    credibilityScore: $("credibility-score"),
    credibilityList: $("credibility-list"),
    modeTabs: document.querySelectorAll(".mode-tab"),
  };

  let activeMode = "link";
  let sourcesSeq = 0;
  let credibilitySeq = 0;
  let lastCredibilityKey = "";
  let lastCredibilityResult = null;

  const FIELD_META = {
    author: { label: "Author", input: () => els.author, required: true },
    year: { label: "Year", input: () => els.year, required: true },
    title: { label: "Title", input: () => els.title, required: true },
    site: { label: "Website / Publisher", input: () => els.site, required: true },
    accessed: { label: "Accessed date", input: () => els.accessed, required: true },
  };

  const FIELD_ORDER = ["title", "author", "year", "site", "accessed"];

  let forceShowAll = false;

  const FORMAT_NAMES = {
    harvard: "Harvard",
    "harvard-au": "Harvard (Australia)",
    ieee: "IEEE",
    apa: "APA 7th",
    mla: "MLA 9th",
    chicago: "Chicago (Author–Date)",
    vancouver: "Vancouver",
    bibtex: "BibTeX",
  };

  let debounceTimer = null;
  let fetchSeq = 0;
  let lastFetchedUrl = "";

  function todayISO() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  }

  els.accessed.value = todayISO();

  function setStatus(message, kind = "") {
    els.status.textContent = message;
    els.status.className = "status" + (kind ? ` is-${kind}` : "");
  }

  function normalizeUrl(raw) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return "";
    try {
      const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      const u = new URL(withProtocol);
      if (!u.hostname.includes(".")) return "";
      return u.href;
    } catch {
      return "";
    }
  }

  function looksLikeUrl(raw) {
    return Boolean(normalizeUrl(raw));
  }

  function hostnameOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, "");
    } catch {
      return "";
    }
  }

  function siteNameFromHost(host) {
    if (!host) return "";
    const known = {
      "youtube.com": "YouTube",
      "youtu.be": "YouTube",
      "en.wikipedia.org": "Wikipedia",
      "wikipedia.org": "Wikipedia",
      "medium.com": "Medium",
      "github.com": "GitHub",
      "bbc.com": "BBC",
      "bbc.co.uk": "BBC",
      "nytimes.com": "The New York Times",
      "theguardian.com": "The Guardian",
      "cnn.com": "CNN",
      "reuters.com": "Reuters",
      "nature.com": "Nature",
      "sciencedirect.com": "ScienceDirect",
      "arxiv.org": "arXiv",
      "linkedin.com": "LinkedIn",
      "twitter.com": "X",
      "x.com": "X",
    };
    if (known[host]) return known[host];
    for (const [key, name] of Object.entries(known)) {
      if (host.endsWith(`.${key}`) || host === key) return name;
    }
    const base = host.split(".").slice(-2, -1)[0] || host.split(".")[0] || host;
    return base.charAt(0).toUpperCase() + base.slice(1);
  }

  function decodeEntities(str) {
    const ta = document.createElement("textarea");
    ta.innerHTML = str;
    return ta.value;
  }

  function cleanText(str) {
    return decodeEntities(String(str || ""))
      .replace(/\s+/g, " ")
      .trim();
  }

  function yearFromAny(value) {
    if (!value) return "";
    const m = String(value).match(/(19|20)\d{2}/);
    return m ? m[0] : "";
  }

  function authorFromAny(value) {
    if (!value) return "";
    if (Array.isArray(value)) {
      return value
        .map((item) => {
          if (!item) return "";
          if (typeof item === "string") return cleanText(item);
          if (typeof item === "object") return cleanText(item.name || item.fullName || "");
          return "";
        })
        .filter(Boolean)
        .join("; ");
    }
    if (typeof value === "object") return cleanText(value.name || value.fullName || "");
    return cleanText(value);
  }

  function metaContent(html, names) {
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const patterns = [
        new RegExp(
          `<meta[^>]+(?:name|property|itemprop)=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
          "i"
        ),
        new RegExp(
          `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property|itemprop)=["']${escaped}["']`,
          "i"
        ),
      ];
      for (const re of patterns) {
        const m = html.match(re);
        if (m?.[1]) return cleanText(m[1]);
      }
    }
    return "";
  }

  function extractJsonLd(html) {
    const blocks = [];
    const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = re.exec(html))) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (Array.isArray(parsed)) blocks.push(...parsed);
        else blocks.push(parsed);
      } catch {
        /* ignore bad JSON-LD */
      }
    }
    return blocks;
  }

  function pickJsonLd(blocks) {
    const types = ["NewsArticle", "Article", "BlogPosting", "WebPage", "ScholarlyArticle", "Report"];
    for (const type of types) {
      const hit = blocks.find((b) => {
        const t = b["@type"];
        if (!t) return false;
        if (Array.isArray(t)) return t.includes(type);
        return String(t).includes(type);
      });
      if (hit) return hit;
    }
    return blocks[0] || null;
  }

  function extractFromHtml(html, url) {
    const ld = pickJsonLd(extractJsonLd(html));
    const title =
      (ld && cleanText(ld.headline || ld.name)) ||
      metaContent(html, ["og:title", "twitter:title", "citation_title", "dc.title", "DC.title"]) ||
      (() => {
        const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        return m ? cleanText(m[1]) : "";
      })();

    const author =
      authorFromAny(ld && (ld.author || ld.creator)) ||
      metaContent(html, [
        "author",
        "article:author",
        "og:article:author",
        "citation_author",
        "dc.creator",
        "DC.creator",
        "twitter:creator",
        "sailthru.author",
      ]);

    const year =
      yearFromAny(ld && (ld.datePublished || ld.dateCreated || ld.dateModified)) ||
      yearFromAny(
        metaContent(html, [
          "article:published_time",
          "og:published_time",
          "article:modified_time",
          "date",
          "dc.date",
          "DC.date",
          "citation_publication_date",
          "citation_date",
          "pubdate",
          "publish-date",
          "sailthru.date",
        ])
      ) ||
      yearFromAny(url.match(/\/((?:19|20)\d{2})(?:\/|$)/)?.[1]);

    const site =
      cleanText(ld && (ld.isPartOf?.name || ld.publisher?.name || ld.publisher)) ||
      metaContent(html, ["og:site_name", "application-name", "citation_journal_title", "publisher"]) ||
      siteNameFromHost(hostnameOf(url));

    return { title, author, year, site };
  }

  async function fetchJson(url, timeout = 10000) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function fetchText(url, timeout = 12000) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  /** Microlink returns clean structured metadata for many sites */
  async function fetchViaMicrolink(url) {
    const data = await fetchJson(`https://api.microlink.io?url=${encodeURIComponent(url)}&meta=true`);
    if (data.status !== "success" || !data.data) throw new Error("Microlink failed");
    const d = data.data;
    return {
      title: cleanText(d.title),
      author: authorFromAny(d.author),
      year: yearFromAny(d.date),
      site: cleanText(d.publisher) || siteNameFromHost(hostnameOf(url)),
    };
  }

  /** JSONLink extract API */
  async function fetchViaJsonLink(url) {
    const data = await fetchJson(`https://jsonlink.io/api/extract?url=${encodeURIComponent(url)}`);
    return {
      title: cleanText(data.title),
      author: authorFromAny(data.author),
      year: yearFromAny(data.published || data.date),
      site: cleanText(data.site_name || data.publisher) || siteNameFromHost(hostnameOf(url)),
    };
  }

  /** Scrape HTML through CORS-friendly proxies */
  async function fetchViaHtmlProxy(url) {
    const proxies = [
      (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
      (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
      (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
    ];

    let lastError = null;
    for (const build of proxies) {
      try {
        const html = await fetchText(build(url));
        if (!html || html.length < 40) throw new Error("Empty response");
        return extractFromHtml(html, url);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error("HTML proxy failed");
  }

  function metaScore(meta) {
    return ["title", "author", "year", "site"].reduce((n, key) => n + (meta[key] ? 1 : 0), 0);
  }

  function mergeMeta(base, next) {
    return {
      title: base.title || next.title || "",
      author: base.author || next.author || "",
      year: base.year || next.year || "",
      site: base.site || next.site || "",
    };
  }

  async function resolveMetadata(url) {
    const sources = [fetchViaMicrolink, fetchViaJsonLink, fetchViaHtmlProxy];
    let best = { title: "", author: "", year: "", site: "" };

    const results = await Promise.allSettled(sources.map((fn) => fn(url)));
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      best = mergeMeta(best, result.value);
    }

    if (!best.site) best.site = siteNameFromHost(hostnameOf(url));
    if (!best.title) {
      // Last-resort title from URL path
      try {
        const path = decodeURIComponent(new URL(url).pathname).replace(/\/$/, "");
        const slug = path.split("/").filter(Boolean).pop() || "";
        if (slug && slug !== "index.html") {
          best.title = cleanText(slug.replace(/[-_]+/g, " ").replace(/\.\w+$/, ""));
        }
      } catch {
        /* ignore */
      }
    }

    if (metaScore(best) === 0) throw new Error("No metadata found");
    return best;
  }

  function clearMetaFields() {
    els.author.value = "";
    els.year.value = "";
    els.title.value = "";
    els.site.value = "";
    els.accessed.value = todayISO();
    forceShowAll = false;
  }

  function hideDetails() {
    els.detailsSection.hidden = true;
    els.detectedBlock.hidden = true;
    els.neededBlock.hidden = true;
    els.allFound.hidden = true;
    els.outputPanel.hidden = true;
    els.citationBlock.hidden = true;
    els.sourcesBlock.hidden = true;
    els.credibilityBlock.hidden = true;
    els.sourcesList.innerHTML = "";
    els.sourcesStatus.textContent = "";
    els.credibilityList.innerHTML = "";
    els.credibilityStatus.textContent = "";
    els.credibilityVerdict.hidden = true;
    els.credibilityScore.hidden = true;
    lastCredibilityKey = "";
    lastCredibilityResult = null;
    forceShowAll = false;
    FIELD_ORDER.forEach((key) => {
      const wrap = document.querySelector(`[data-field="${key}"]`);
      if (wrap) wrap.hidden = true;
    });
  }

  function setMode(mode) {
    activeMode = mode === "convert" ? "convert" : "link";
    els.linkMode.hidden = activeMode !== "link";
    els.convertMode.hidden = activeMode !== "convert";
    els.modeTabs.forEach((tab) => {
      const on = tab.dataset.mode === activeMode;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    });
    const detectedTitle = document.querySelector("#detected-block .section-title");
    if (detectedTitle) {
      detectedTitle.textContent =
        activeMode === "convert" ? "Parsed from your citation" : "Found from your link";
    }
    hideDetails();
    setStatus("");
    lastAutoSourceQuery = "";
    if (activeMode === "convert") els.citationInput.focus();
    else els.url.focus();
  }

  function extractUrlFromText(text) {
    const doi = text.match(/\b(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\d{4,9}\/[^\s,;)\]]+)/i);
    if (doi) {
      const id = doi[1].replace(/[.,;]+$/, "");
      return `https://doi.org/${id}`;
    }
    const url = text.match(/https?:\/\/[^\s<>"')\]]+/i);
    if (!url) return "";
    return normalizeUrl(url[0].replace(/[.,;)]+$/, ""));
  }

  function parseCitationText(raw) {
    const text = cleanText(raw);
    if (!text) return null;

    const url = extractUrlFromText(text);
    let working = text
      .replace(/https?:\/\/[^\s<>"')\]]+/gi, " ")
      .replace(/\bdoi:\s*10\.\d{4,9}\/[^\s,;)\]]+/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    let year = "";
    const yearParen = working.match(/\((\d{4}[a-z]?)\)/);
    const yearBare = working.match(/(?:^|[.\s])((?:19|20)\d{2})(?:[a-z]?)(?:[.,\s]|$)/);
    if (yearParen) year = yearParen[1].slice(0, 4);
    else if (yearBare) year = yearBare[1];

    let author = "";
    let title = "";
    let site = "";

    // APA / Harvard-ish: Author (Year). Title. Site.
    const apaLike = working.match(/^(.+?)\s*\((?:19|20)\d{2}[a-z]?\)\s*\.?\s*(.+)$/i);
    if (apaLike) {
      author = cleanText(apaLike[1].replace(/[.]+$/, ""));
      const rest = apaLike[2].trim();
      const parts = rest.split(/\.\s+/).map((p) => cleanText(p.replace(/^["“]|["”]$/g, ""))).filter(Boolean);
      title = parts[0] || "";
      site = parts[1] || parts[parts.length - 1] || "";
      if (site && /^Available at/i.test(site)) site = parts[parts.length - 2] || "";
    } else {
      // MLA-ish: Author. "Title." Site, Year
      const mlaLike = working.match(/^(.+?)\.\s*["“](.+?)["”]\.?\s*(.+)$/);
      if (mlaLike) {
        author = cleanText(mlaLike[1]);
        title = cleanText(mlaLike[2]);
        const tail = cleanText(mlaLike[3]);
        site = cleanText(tail.split(",")[0] || tail.split(".")[0] || "");
      } else {
        // Fallback: first segment author, quoted or first sentence title
        const quoted = working.match(/["“](.+?)["”]/);
        if (quoted) {
          title = cleanText(quoted[1]);
          author = cleanText(working.slice(0, quoted.index).replace(/[.,]+$/, ""));
          const after = working.slice(quoted.index + quoted[0].length).replace(/^[.,\s]+/, "");
          site = cleanText(after.split(/[.,]/)[0] || "");
        } else {
          const chunks = working.split(/\.\s+/).map(cleanText).filter(Boolean);
          author = chunks[0] || "";
          title = chunks[1] || "";
          site = chunks[2] || "";
        }
      }
    }

    author = author.replace(/\s*\((?:19|20)\d{2}[a-z]?\)\s*$/, "").replace(/^[\[\d.\]]+\s*/, "");
    title = title.replace(/^[\[\d.\]]+\s*/, "").replace(/\.$/, "");
    site = site
      .replace(/\b(?:Available at|Available from|Online|Internet|Accessed|viewed|cited).*$/i, "")
      .replace(/[<>]/g, "")
      .replace(/[.,;]+$/, "")
      .trim();

    if (!title && !author && !url) return null;

    return {
      author,
      year,
      title,
      site: site || (url ? siteNameFromHost(hostnameOf(url)) : ""),
      url,
    };
  }

  function convertCitation() {
    const parsed = parseCitationText(els.citationInput.value);
    if (!parsed) {
      setStatus("Paste a citation first — include author, year, title, or a DOI/URL if you have one.", "error");
      els.citationInput.focus();
      return;
    }

    forceShowAll = false;
    els.url.value = parsed.url || "";
    els.author.value = parsed.author || "";
    els.year.value = parsed.year || "";
    els.title.value = parsed.title || "";
    els.site.value = parsed.site || "";
    els.accessed.value = todayISO();
    lastFetchedUrl = parsed.url || "";
    updateFieldVisibility();
    generate();

    const missing = FIELD_ORDER.filter((k) => k !== "accessed" && !isFieldFilled(k)).length;
    if (missing > 0) {
      setStatus(`Converted. Fill in ${missing} missing field${missing === 1 ? "" : "s"}, then pick a style.`, "ok");
    } else {
      setStatus("Citation converted. Choose a style above, or find stronger sources below.", "ok");
    }
  }

  function setSourcesStatus(message, kind = "") {
    els.sourcesStatus.textContent = message;
    els.sourcesStatus.className = "status" + (kind ? ` is-${kind}` : "");
  }

  function formatOpenAlexAuthor(authorships) {
    if (!Array.isArray(authorships) || !authorships.length) return "";
    return authorships
      .slice(0, 3)
      .map((a) => cleanText(a.author?.display_name || ""))
      .filter(Boolean)
      .join("; ");
  }

  function credibilityBadges(work) {
    const badges = [];
    if (work.doi || (work.id && String(work.id).includes("doi.org"))) badges.push("DOI");
    if (work.is_oa) badges.push("Open access");
    if (work.type) {
      const type = String(work.type).replace(/-/g, " ");
      badges.push(type.charAt(0).toUpperCase() + type.slice(1));
    }
    if (typeof work.cited_by_count === "number" && work.cited_by_count > 0) {
      badges.push(`${work.cited_by_count} citations`);
    }
    if (work.host?.includes("nature") || /nature|science|lancet|nejm|cell|pnas/i.test(work.site || "")) {
      badges.push("High-impact");
    }
    return badges.slice(0, 4);
  }

  function normalizeScholarlyWork(raw, source) {
    if (source === "openalex") {
      const doi = raw.doi ? String(raw.doi).replace(/^https?:\/\/doi\.org\//i, "") : "";
      const url =
        (doi && `https://doi.org/${doi}`) ||
        raw.primary_location?.landing_page_url ||
        raw.primary_location?.pdf_url ||
        raw.id ||
        "";
      const site =
        cleanText(raw.primary_location?.source?.display_name) ||
        cleanText(raw.host_venue?.display_name) ||
        "Scholarly source";
      return {
        title: cleanText(raw.title || raw.display_name),
        author: formatOpenAlexAuthor(raw.authorships),
        year: String(raw.publication_year || yearFromAny(raw.publication_date) || ""),
        site,
        url: normalizeUrl(url) || url,
        doi,
        is_oa: Boolean(raw.open_access?.is_oa || raw.primary_location?.is_oa),
        type: raw.type || "article",
        cited_by_count: raw.cited_by_count || 0,
        host: (raw.primary_location?.source?.host_organization_name || site || "").toLowerCase(),
      };
    }

    // Crossref
    const msg = raw;
    const doi = cleanText(msg.DOI || "");
    const author = Array.isArray(msg.author)
      ? msg.author
          .slice(0, 3)
          .map((a) => cleanText([a.family, a.given].filter(Boolean).join(", ")))
          .filter(Boolean)
          .join("; ")
      : "";
    const year =
      String(msg.published?.["date-parts"]?.[0]?.[0] || msg.created?.["date-parts"]?.[0]?.[0] || "") ||
      yearFromAny(msg.created?.["date-time"]);
    const title = cleanText(Array.isArray(msg.title) ? msg.title[0] : msg.title);
    const site = cleanText(
      (Array.isArray(msg["container-title"]) ? msg["container-title"][0] : msg["container-title"]) ||
        msg.publisher ||
        "Crossref"
    );
    const url = doi ? `https://doi.org/${doi}` : normalizeUrl(msg.URL) || msg.URL || "";
    return {
      title,
      author,
      year,
      site,
      url,
      doi,
      is_oa: false,
      type: msg.type || "article",
      cited_by_count: msg["is-referenced-by-count"] || 0,
      host: site.toLowerCase(),
    };
  }

  async function fetchOpenAlexSources(query) {
    const url =
      `https://api.openalex.org/works?search=${encodeURIComponent(query)}` +
      `&per_page=6&sort=cited_by_count:desc&mailto=ember@local.app`;
    const data = await fetchJson(url, 12000);
    return (data.results || [])
      .map((w) => normalizeScholarlyWork(w, "openalex"))
      .filter((w) => w.title && w.url);
  }

  async function fetchCrossrefSources(query) {
    const url =
      `https://api.crossref.org/works?query=${encodeURIComponent(query)}` +
      `&rows=6&select=DOI,title,author,published,created,container-title,publisher,URL,type,is-referenced-by-count`;
    const data = await fetchJson(url, 12000);
    return (data.message?.items || [])
      .map((w) => normalizeScholarlyWork(w, "crossref"))
      .filter((w) => w.title && w.url);
  }

  function dedupeSources(list) {
    const seen = new Set();
    return list.filter((item) => {
      const key = (item.doi || item.url || item.title).toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function renderSources(sources) {
    els.sourcesList.innerHTML = "";
    sources.forEach((src, index) => {
      const li = document.createElement("li");
      li.className = "source-card";

      const title = document.createElement("p");
      title.className = "source-title";
      title.textContent = src.title;

      const meta = document.createElement("p");
      meta.className = "source-meta";
      meta.textContent = [src.author, src.year, src.site].filter(Boolean).join(" · ");

      const badgeWrap = document.createElement("div");
      badgeWrap.className = "source-badges";
      credibilityBadges(src).forEach((label) => {
        const badge = document.createElement("span");
        badge.className = "source-badge";
        badge.textContent = label;
        badgeWrap.appendChild(badge);
      });

      const actions = document.createElement("div");
      actions.className = "source-actions";

      const citeBtn = document.createElement("button");
      citeBtn.type = "button";
      citeBtn.className = "btn-mini";
      citeBtn.dataset.citeIndex = String(index);
      citeBtn.textContent = "Cite this";

      const openLink = document.createElement("a");
      openLink.className = "btn-mini";
      openLink.href = src.url;
      openLink.target = "_blank";
      openLink.rel = "noopener noreferrer";
      openLink.textContent = "Open";

      actions.append(citeBtn, openLink);
      li.append(title, meta, badgeWrap, actions);
      els.sourcesList.appendChild(li);
    });
    els.sourcesList._sources = sources;
  }

  async function findCredibleSources({ auto = false } = {}) {
    const src = getSource();
    const query = cleanText([src.title, src.author, src.site].filter(Boolean).join(" "));
    if (!query || query === "Untitled") {
      setSourcesStatus("Add a title (or author) first so Ember knows what to search for.", "error");
      return;
    }

    const seq = ++sourcesSeq;
    els.sourcesBtn.disabled = true;
    setSourcesStatus(auto ? "Finding more sources on this topic…" : "Searching scholarly databases…");

    try {
      const settled = await Promise.allSettled([
        fetchOpenAlexSources(query),
        fetchCrossrefSources(query),
      ]);
      if (seq !== sourcesSeq) return;

      let combined = [];
      for (const result of settled) {
        if (result.status === "fulfilled") combined = combined.concat(result.value);
      }

      // Prefer DOI / highly cited / journal articles
      combined = dedupeSources(combined)
        .map((item) => ({
          ...item,
          score:
            (item.doi ? 40 : 0) +
            Math.min(item.cited_by_count || 0, 200) / 4 +
            (/article|journal|review|book/i.test(item.type || "") ? 15 : 0) +
            (item.is_oa ? 5 : 0),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 6);

      // Drop the exact same URL the user already cited + credibility comparison picks
      const currentUrl = normalizeUrl(src.url);
      const comparedUrls = new Set(
        (lastCredibilityResult?.comparisons || [])
          .map((c) => normalizeUrl(c.url))
          .filter(Boolean)
      );
      combined = combined.filter((item) => {
        const u = normalizeUrl(item.url);
        return u && u !== currentUrl && !comparedUrls.has(u);
      });

      if (!combined.length) {
        els.sourcesList.innerHTML = "";
        setSourcesStatus("No extra scholarly matches found. Try a clearer title or topic keywords.", "error");
        return;
      }

      renderSources(combined);
      setSourcesStatus(
        `Suggested ${combined.length} more source${combined.length === 1 ? "" : "s"} after your citation.`,
        "ok"
      );
    } catch {
      if (seq !== sourcesSeq) return;
      setSourcesStatus("Couldn’t reach scholarly databases right now. Try again in a moment.", "error");
    } finally {
      if (seq === sourcesSeq) els.sourcesBtn.disabled = false;
    }
  }

  function citeSourceAt(index) {
    const sources = els.sourcesList._sources || [];
    const src = sources[index];
    if (!src) return;

    forceShowAll = false;
    els.url.value = src.url || "";
    els.author.value = src.author || "";
    els.year.value = src.year || "";
    els.title.value = src.title || "";
    els.site.value = src.site || "";
    els.accessed.value = todayISO();
    lastFetchedUrl = src.url || "";
    lastCredibilityKey = "";
    lastCredibilityResult = null;
    updateFieldVisibility();
    generate({ skipCredibilityCache: true });
    setStatus("Loaded a suggested source. Credibility will be re-checked.", "ok");
    els.citationBlock.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function setCredibilityStatus(message, kind = "") {
    els.credibilityStatus.textContent = message;
    els.credibilityStatus.className = "status" + (kind ? ` is-${kind}` : "");
  }

  function domainReputation(url) {
    const host = hostnameOf(url).toLowerCase();
    if (!host) return { tier: "unknown", points: 20, label: "Unknown site" };

    const high = [
      "edu", "gov", "ac.uk", "gov.uk", "mil",
      "nature.com", "science.org", "sciencedirect.com", "springer.com", "wiley.com",
      "nih.gov", "who.int", "cdc.gov", "nasa.gov", "arxiv.org", "pubmed.ncbi.nlm.nih.gov",
      "bbc.com", "bbc.co.uk", "reuters.com", "apnews.com", "nytimes.com", "theguardian.com",
      "wikipedia.org", "britannica.com", "doi.org", "jstor.org", "ieee.org", "acm.org",
      "harvard.edu", "stanford.edu", "mit.edu", "ox.ac.uk", "cam.ac.uk",
    ];
    const medium = [
      "forbes.com", "bloomberg.com", "cnn.com", "washingtonpost.com", "npr.org",
      "medium.com", "substack.com", "github.com", "linkedin.com", "ted.com",
    ];
    const low = [
      "blogspot.com", "wordpress.com", "tumblr.com", "wixsite.com", "squarespace.com",
      "tiktok.com", "facebook.com", "pinterest.com",
    ];

    if (host.endsWith(".edu") || host.endsWith(".gov") || host.endsWith(".ac.uk") || host.endsWith(".gov.uk")) {
      return { tier: "high", points: 40, label: "Academic / government domain" };
    }
    if (high.some((d) => host === d || host.endsWith(`.${d}`))) {
      return { tier: "high", points: 38, label: "Well-known reputable publisher" };
    }
    if (medium.some((d) => host === d || host.endsWith(`.${d}`))) {
      return { tier: "medium", points: 24, label: "Established web publisher" };
    }
    if (low.some((d) => host === d || host.endsWith(`.${d}`))) {
      return { tier: "low", points: 8, label: "Personal / social / blog domain" };
    }
    return { tier: "unknown", points: 16, label: "Unranked domain — verify carefully" };
  }

  async function fetchSemanticScholarComparison(query) {
    const api =
      `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}` +
      `&limit=1&fields=title,authors,year,url,venue,citationCount,externalIds,abstract`;
    const data = await fetchJson(api, 12000);
    const paper = data?.data?.[0];
    if (!paper) {
      return {
        outlet: "Semantic Scholar",
        found: false,
        title: "No close Semantic Scholar match",
        author: "",
        year: "",
        site: "Semantic Scholar",
        url: `https://www.semanticscholar.org/search?q=${encodeURIComponent(query)}`,
        note: "No strong peer-reviewed match found in Semantic Scholar.",
        cited_by_count: 0,
        doi: "",
      };
    }

    const authors = Array.isArray(paper.authors)
      ? paper.authors
          .slice(0, 3)
          .map((a) => cleanText(a.name))
          .filter(Boolean)
          .join("; ")
      : "";
    const doi = cleanText(paper.externalIds?.DOI || "");
    const url =
      (doi && `https://doi.org/${doi}`) ||
      normalizeUrl(paper.url) ||
      (paper.paperId ? `https://www.semanticscholar.org/paper/${paper.paperId}` : "");
    const cited = paper.citationCount || 0;
    const venue = cleanText(paper.venue) || "Semantic Scholar";

    return {
      outlet: "Semantic Scholar",
      found: true,
      title: cleanText(paper.title),
      author: authors,
      year: paper.year ? String(paper.year) : "",
      site: venue,
      url,
      doi,
      cited_by_count: cited,
      note: cited
        ? `Peer-reviewed index · cited ${cited} times.`
        : "Peer-reviewed / scholarly record from Semantic Scholar.",
    };
  }

  async function fetchCrossrefComparison(query) {
    const works = await fetchCrossrefSources(query);
    const best = works[0];
    if (!best) {
      return {
        outlet: "Crossref",
        found: false,
        title: "No close scholarly match",
        author: "",
        year: "",
        site: "Crossref",
        url: `https://search.crossref.org/?q=${encodeURIComponent(query)}`,
        note: "No strong DOI-backed article found for this topic.",
        cited_by_count: 0,
        doi: "",
      };
    }
    return {
      outlet: "Crossref",
      found: true,
      ...best,
      note: best.doi
        ? `DOI-backed work${best.cited_by_count ? ` · cited ${best.cited_by_count} times` : ""}.`
        : "Scholarly record from Crossref.",
    };
  }

  async function fetchOpenAlexComparison(query) {
    const works = await fetchOpenAlexSources(query);
    const best = works[0];
    if (!best) {
      return {
        outlet: "OpenAlex",
        found: false,
        title: "No close OpenAlex match",
        author: "",
        year: "",
        site: "OpenAlex",
        url: `https://openalex.org/works?page=1&filter=default.search:${encodeURIComponent(query)}`,
        note: "No strong scholarly match found in OpenAlex.",
        cited_by_count: 0,
        doi: "",
      };
    }
    return {
      outlet: "OpenAlex",
      found: true,
      ...best,
      note: best.cited_by_count
        ? `Cited ${best.cited_by_count} times in scholarly literature.`
        : "Scholarly work indexed by OpenAlex.",
    };
  }

  function scoreCredibility(src, comparisons, reputation) {
    let score = reputation.points;
    const foundCount = comparisons.filter((c) => c.found).length;
    score += foundCount * 15;

    const scholarlyHits = comparisons.filter(
      (c) =>
        c.found &&
        (c.outlet === "Crossref" || c.outlet === "OpenAlex" || c.outlet === "Semantic Scholar")
    );
    if (scholarlyHits.length) score += 10;
    const cites = scholarlyHits.reduce((n, c) => n + (c.cited_by_count || 0), 0);
    if (cites >= 50) score += 10;
    else if (cites >= 10) score += 6;
    else if (cites > 0) score += 3;

    if (src.url && /^https:/i.test(src.url)) score += 4;
    if (src.author) score += 4;
    if (src.year && src.year !== "n.d.") score += 4;
    if (src.title && src.title !== "Untitled") score += 3;

    score = Math.max(0, Math.min(100, Math.round(score)));

    let level = "mixed";
    let headline = "Mixed credibility signals";
    let detail = "";

    if (score >= 70) {
      level = "strong";
      headline = "Looks reasonably credible";
      detail =
        foundCount >= 2
          ? `Your source aligns with ${foundCount} of 3 comparison outlets, and the domain rates as ${reputation.label.toLowerCase()}.`
          : `Domain looks solid (${reputation.label.toLowerCase()}), though fewer external matches were found.`;
    } else if (score >= 40) {
      level = "mixed";
      headline = "Use with caution";
      detail =
        foundCount >= 1
          ? `Some related coverage exists, but corroboration is limited. Domain: ${reputation.label.toLowerCase()}.`
          : `Weak corroboration from scholarly indexes. Prefer one of the comparison sources if possible.`;
    } else {
      level = "weak";
      headline = "Weak credibility signals";
      detail =
        "Few trusted outlets cover this topic in a similar way. Consider citing a comparison source instead.";
    }

    return { score, level, headline, detail, foundCount, reputation };
  }

  function renderCredibilityComparisons(comparisons) {
    els.credibilityList.innerHTML = "";
    comparisons.forEach((item) => {
      const li = document.createElement("li");
      li.className = "cred-card";

      const top = document.createElement("div");
      top.className = "cred-card-top";

      const outlet = document.createElement("span");
      outlet.className = "cred-source-label";
      outlet.textContent = item.outlet;

      const match = document.createElement("span");
      match.className = `cred-match ${item.found ? "is-found" : "is-missing"}`;
      match.textContent = item.found ? "Similar source found" : "No close match";

      top.append(outlet, match);

      const title = document.createElement("p");
      title.className = "source-title";
      title.textContent = item.title;

      const meta = document.createElement("p");
      meta.className = "source-meta";
      meta.textContent = [item.author, item.year, item.site].filter(Boolean).join(" · ") || item.note;

      const note = document.createElement("p");
      note.className = "source-meta";
      note.textContent = item.note;

      const actions = document.createElement("div");
      actions.className = "source-actions";

      if (item.found && item.url) {
        const citeBtn = document.createElement("button");
        citeBtn.type = "button";
        citeBtn.className = "btn-mini";
        citeBtn.textContent = "Cite this instead";
        citeBtn.addEventListener("click", () => {
          forceShowAll = false;
          els.url.value = item.url || "";
          els.author.value = item.author || "";
          els.year.value = item.year || "";
          els.title.value = item.title || "";
          els.site.value = item.site || item.outlet;
          els.accessed.value = todayISO();
          lastFetchedUrl = item.url || "";
          lastCredibilityKey = "";
          lastCredibilityResult = null;
          updateFieldVisibility();
          generate({ skipCredibilityCache: true });
          setStatus(`Switched to the ${item.outlet} source. Re-checking credibility.`, "ok");
        });
        actions.appendChild(citeBtn);
      }

      const openLink = document.createElement("a");
      openLink.className = "btn-mini";
      openLink.href = item.url;
      openLink.target = "_blank";
      openLink.rel = "noopener noreferrer";
      openLink.textContent = "Open";
      actions.appendChild(openLink);

      li.append(top, title, meta, note, actions);
      els.credibilityList.appendChild(li);
    });
  }

  async function runCredibilityCheck(src) {
    const query = cleanText([src.title, src.author].filter(Boolean).join(" "));
    const credibilityKey = [normalizeUrl(src.url) || "", query, src.site || ""].join("|");

    if (lastCredibilityKey === credibilityKey && lastCredibilityResult) {
      const cached = lastCredibilityResult;
      els.credibilityBlock.hidden = false;
      renderCredibilityComparisons(cached.comparisons);
      els.credibilityScore.hidden = false;
      els.credibilityScore.textContent = `${cached.summary.score}/100 · ${cached.summary.level}`;
      els.credibilityScore.className = `cred-score is-${cached.summary.level}`;
      els.credibilityVerdict.hidden = false;
      els.credibilityVerdict.className = `cred-verdict is-${cached.summary.level}`;
      els.credibilityVerdict.textContent = `${cached.summary.headline}. ${cached.summary.detail}`;
      setCredibilityStatus(
        `Compared against ${cached.comparisons.length} sources — ${cached.summary.foundCount} close match${cached.summary.foundCount === 1 ? "" : "es"} found.`,
        cached.summary.level === "weak" ? "error" : "ok"
      );
      return cached;
    }

    const seq = ++credibilitySeq;
    els.credibilityBlock.hidden = false;
    els.credibilityVerdict.hidden = true;
    els.credibilityScore.hidden = true;
    els.credibilityList.innerHTML = "";
    setCredibilityStatus("Checking 3 similar sources (Semantic Scholar, Crossref, OpenAlex)…");

    const reputation = domainReputation(src.url);
    const settled = await Promise.allSettled([
      fetchSemanticScholarComparison(query || src.site || src.url),
      fetchCrossrefComparison(query || src.site || "research"),
      fetchOpenAlexComparison(query || src.site || "research"),
    ]);

    if (seq !== credibilitySeq) return null;

    const comparisons = settled.map((result, i) => {
      const outlet = ["Semantic Scholar", "Crossref", "OpenAlex"][i];
      if (result.status === "fulfilled") return result.value;
      return {
        outlet,
        found: false,
        title: `${outlet} check failed`,
        author: "",
        year: "",
        site: outlet,
        url: "#",
        note: "Could not reach this source right now.",
      };
    });

    const summary = scoreCredibility(src, comparisons, reputation);
    const result = { comparisons, summary, key: credibilityKey };
    lastCredibilityKey = credibilityKey;
    lastCredibilityResult = result;

    renderCredibilityComparisons(comparisons);

    els.credibilityScore.hidden = false;
    els.credibilityScore.textContent = `${summary.score}/100 · ${summary.level}`;
    els.credibilityScore.className = `cred-score is-${summary.level}`;

    els.credibilityVerdict.hidden = false;
    els.credibilityVerdict.className = `cred-verdict is-${summary.level}`;
    els.credibilityVerdict.textContent = `${summary.headline}. ${summary.detail}`;

    setCredibilityStatus(
      `Compared against ${comparisons.length} sources — ${summary.foundCount} close match${summary.foundCount === 1 ? "" : "es"} found.`,
      summary.level === "weak" ? "error" : "ok"
    );

    return result;
  }

  function fieldValue(key) {
    return cleanText(FIELD_META[key].input().value);
  }

  function isFieldFilled(key) {
    if (key === "accessed") return Boolean(els.accessed.value);
    return Boolean(fieldValue(key));
  }

  function displayValue(key) {
    if (key === "accessed") {
      const d = parseAccessed(els.accessed.value);
      return d ? formatAccessedLong(d) : els.accessed.value;
    }
    return fieldValue(key);
  }

  function updateFieldVisibility() {
    const missing = [];
    const found = [];

    FIELD_ORDER.forEach((key) => {
      if (isFieldFilled(key)) found.push(key);
      else missing.push(key);
    });

    // Show only missing fields — unless user chose Edit all
    FIELD_ORDER.forEach((key) => {
      const wrap = document.querySelector(`[data-field="${key}"]`);
      if (!wrap) return;
      const show = forceShowAll || missing.includes(key);
      wrap.hidden = !show;
      wrap.classList.toggle("is-needed", missing.includes(key));
    });

    // Detected summary
    els.detectedList.innerHTML = "";
    found.forEach((key) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="detected-key">${FIELD_META[key].label}</span>
        <span class="detected-value"></span>
        <button type="button" class="btn-mini" data-edit="${key}">Edit</button>
      `;
      li.querySelector(".detected-value").textContent = displayValue(key);
      els.detectedList.appendChild(li);
    });

    els.detectedBlock.hidden = found.length === 0;
    els.neededBlock.hidden = missing.length === 0 && !forceShowAll;
    els.allFound.hidden = !(missing.length === 0 && !forceShowAll);

    if (missing.length === 1) {
      els.neededHint.textContent = `This link still needs a ${FIELD_META[missing[0]].label.toLowerCase()}.`;
    } else if (missing.length > 1) {
      const labels = missing.map((k) => FIELD_META[k].label.toLowerCase());
      const last = labels.pop();
      els.neededHint.textContent = `This link still needs: ${labels.join(", ")} and ${last}.`;
    } else if (forceShowAll) {
      els.neededHint.textContent = "Edit any detail below, then generate your citation.";
    } else {
      els.neededHint.textContent = "";
    }

    els.detailsSection.hidden = false;
    els.outputPanel.hidden = false;
  }

  function fillFromMeta(meta) {
    els.title.value = meta.title || "";
    els.author.value = meta.author || "";
    els.year.value = meta.year || "";
    els.site.value = meta.site || "";
    els.accessed.value = todayISO();
    forceShowAll = false;
    updateFieldVisibility();
  }

  async function fetchDetails({ silentInvalid = false } = {}) {
    const url = normalizeUrl(els.url.value);
    if (!url) {
      if (!silentInvalid) {
        setStatus("Enter a valid link first.", "error");
        els.url.focus();
      }
      return;
    }

    if (url === lastFetchedUrl && (els.title.value || els.site.value)) {
      updateFieldVisibility();
      generate();
      return;
    }

    const seq = ++fetchSeq;
    els.url.value = url;
    els.fetchBtn.disabled = true;
    setStatus("Reading the page and filling details…");

    try {
      const meta = await resolveMetadata(url);
      if (seq !== fetchSeq) return;

      fillFromMeta(meta);
      lastFetchedUrl = url;

      const missingCount = FIELD_ORDER.filter((k) => k !== "accessed" && !isFieldFilled(k)).length;
      if (missingCount > 0) {
        setStatus(`Link read. Fill in the ${missingCount} missing field${missingCount === 1 ? "" : "s"} below.`, "ok");
      } else {
        setStatus("All details found from your link. Citation is ready below.", "ok");
      }
      generate();
    } catch {
      if (seq !== fetchSeq) return;
      els.site.value = siteNameFromHost(hostnameOf(url));
      els.accessed.value = todayISO();
      els.title.value = "";
      els.author.value = "";
      els.year.value = "";
      lastFetchedUrl = "";
      forceShowAll = false;
      updateFieldVisibility();
      setStatus("Couldn’t auto-read that page. Fill in the missing fields below.", "error");
    } finally {
      if (seq === fetchSeq) els.fetchBtn.disabled = false;
    }
  }

  function scheduleAutoFetch() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (looksLikeUrl(els.url.value)) {
        fetchDetails({ silentInvalid: true });
      }
    }, 650);
  }

  function parseAccessed(iso) {
    if (!iso) return null;
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  }

  function monthName(date, style = "long") {
    return date.toLocaleString("en-GB", { month: style });
  }

  function formatAccessedLong(date) {
    if (!date) return "";
    return `${date.getDate()} ${monthName(date)} ${date.getFullYear()}`;
  }

  function formatAccessedUS(date) {
    if (!date) return "";
    return `${monthName(date)} ${date.getDate()}, ${date.getFullYear()}`;
  }

  function formatAccessedIEEE(date) {
    if (!date) return "";
    const mon = date.toLocaleString("en-US", { month: "short" });
    return `${mon}. ${date.getDate()}, ${date.getFullYear()}`;
  }

  function getSource() {
    const url = normalizeUrl(els.url.value);
    return {
      url,
      author: cleanText(els.author.value),
      year: cleanText(els.year.value) || "n.d.",
      title: cleanText(els.title.value) || "Untitled",
      site: cleanText(els.site.value) || siteNameFromHost(hostnameOf(url)) || "Website",
      accessed: parseAccessed(els.accessed.value),
    };
  }

  function authorParts(author) {
    if (!author) return null;
    // Prefer first author if multiple are joined with ;
    const primary = author.split(";")[0].trim();
    if (primary.includes(",")) {
      const [last, ...rest] = primary.split(",");
      return { last: cleanText(last), first: cleanText(rest.join(",")) };
    }
    const bits = primary.split(/\s+/);
    if (bits.length === 1) return { last: bits[0], first: "" };
    return { last: bits[bits.length - 1], first: bits.slice(0, -1).join(" ") };
  }

  function initials(first) {
    if (!first) return "";
    return first
      .split(/\s+/)
      .filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + ".")
      .join(" ");
  }

  function harvardAuthor(author) {
    const p = authorParts(author);
    if (!p) return "Anon.";
    if (!p.first) return p.last;
    return `${p.last}, ${initials(p.first)}`;
  }

  function apaAuthor(author) {
    const p = authorParts(author);
    if (!p) return "";
    if (!p.first) return p.last;
    return `${p.last}, ${initials(p.first)}`;
  }

  function mlaAuthor(author) {
    const p = authorParts(author);
    if (!p) return "";
    if (!p.first) return p.last;
    return `${p.last}, ${p.first}`;
  }

  function ieeeAuthor(author) {
    const p = authorParts(author);
    if (!p) return "";
    if (!p.first) return p.last;
    const init = p.first
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + ".")
      .join(" ");
    return `${init} ${p.last}`;
  }

  function vancouverAuthor(author) {
    const p = authorParts(author);
    if (!p) return "";
    if (!p.first) return p.last;
    const init = p.first
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase())
      .join("");
    return `${p.last} ${init}`;
  }

  function bibtexKey(src) {
    const p = authorParts(src.author);
    const last = (p?.last || "web").replace(/[^a-zA-Z]/g, "") || "web";
    const year = src.year === "n.d." ? "nd" : src.year;
    const slug = src.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 12);
    return `${last}${year}${slug}`;
  }

  function escapeBib(str) {
    return String(str).replace(/[{}]/g, "");
  }

  const formatters = {
    harvard(src) {
      const a = harvardAuthor(src.author);
      const accessed = formatAccessedLong(src.accessed);
      const accessBit = accessed ? ` (Accessed: ${accessed})` : "";
      const avail = src.url ? ` Available at: ${src.url}${accessBit}.` : accessBit ? `${accessBit}.` : ".";
      return `${a} (${src.year}) ${src.title}. ${src.site}.${avail}`;
    },

    "harvard-au"(src) {
      const a = harvardAuthor(src.author);
      const accessed = formatAccessedLong(src.accessed);
      const viewBit = accessed ? `, viewed ${accessed}` : "";
      const linkBit = src.url ? `, <${src.url}>` : "";
      return `${a} ${src.year}, '${src.title}', ${src.site}${viewBit}${linkBit}.`;
    },

    ieee(src) {
      const a = ieeeAuthor(src.author) || "Anon.";
      const accessed = formatAccessedIEEE(src.accessed);
      const accessBit = accessed ? ` [Accessed: ${accessed}]` : "";
      const avail = src.url ? ` [Online]. Available: ${src.url}.` : ".";
      return `[1] ${a}, "${src.title}," ${src.site}.${avail}${accessBit}`;
    },

    apa(src) {
      const a = apaAuthor(src.author);
      const who = a ? `${a} ` : "";
      const link = src.url ? ` ${src.url}` : "";
      return `${who}(${src.year}). ${src.title}. ${src.site}.${link}`;
    },

    mla(src) {
      const a = mlaAuthor(src.author);
      const who = a ? `${a}. ` : "";
      const accessed = formatAccessedUS(src.accessed);
      const accessBit = accessed ? ` Accessed ${accessed}.` : "";
      const link = src.url ? `, ${src.url}.` : ".";
      return `${who}"${src.title}." ${src.site}, ${src.year}${link}${accessBit}`;
    },

    chicago(src) {
      const a = mlaAuthor(src.author);
      const who = a ? `${a}. ` : "";
      const accessed = formatAccessedUS(src.accessed);
      const accessBit = accessed ? ` Accessed ${accessed}.` : "";
      const link = src.url ? ` ${src.url}.` : "";
      return `${who}${src.year}. "${src.title}." ${src.site}.${link}${accessBit}`;
    },

    vancouver(src) {
      const a = vancouverAuthor(src.author) || "Anonymous";
      const accessed = formatAccessedLong(src.accessed);
      const accessBit = accessed ? ` [cited ${accessed}]` : "";
      const avail = src.url ? ` Available from: ${src.url}` : "";
      return `1. ${a}. ${src.title} [Internet]. ${src.site}; ${src.year}${accessBit}.${avail}`;
    },

    bibtex(src) {
      const key = bibtexKey(src);
      const author = src.author || "Anonymous";
      const year = src.year === "n.d." ? "" : src.year;
      const lines = [
        `@misc{${key},`,
        `  author = {${escapeBib(author)}},`,
        `  title = {${escapeBib(src.title)}},`,
        `  year = {${escapeBib(year)}},`,
        `  howpublished = {${escapeBib(src.site)}},`,
      ];
      if (src.url) lines.push(`  url = {${escapeBib(src.url)}},`);
      lines.push(`  note = {Accessed: ${formatAccessedLong(src.accessed) || "n.d."}}`, `}`);
      return lines.join("\n");
    },
  };

  function renderCitationOnly() {
    const src = getSource();
    if (!src.title && !src.author) return;
    if (activeMode === "link" && !src.url) return;
    const style = els.format.value;
    els.citationLabel.textContent = FORMAT_NAMES[style] || "Citation";
    els.citationOutput.textContent = formatters[style](src);
  }

  let lastAutoSourceQuery = "";

  async function generate(options = {}) {
    const src = getSource();
    if (activeMode === "link" && !src.url) {
      setStatus("Insert a valid link before generating.", "error");
      els.url.focus();
      return;
    }
    if (!src.title && !src.author) {
      setStatus("Add a title or author before generating.", "error");
      return;
    }

    const style = els.format.value;
    els.generateBtn.disabled = true;
    const previousLabel = els.generateBtn.textContent;
    els.generateBtn.textContent = "Checking sources…";

    try {
      // Before citing: compare with 3 similar sources
      if (options.skipCredibilityCache) {
        lastCredibilityKey = "";
        lastCredibilityResult = null;
      }
      const check = await runCredibilityCheck(src);
      if (!check) return;

      els.citationLabel.textContent = FORMAT_NAMES[style] || "Citation";
      els.citationOutput.textContent = formatters[style](src);
      els.citationBlock.hidden = false;
      els.citationBlock.style.animation = "none";
      void els.citationBlock.offsetWidth;
      els.citationBlock.style.animation = "";
      els.copyBtn.textContent = "Copy";
      els.copyBtn.classList.remove("is-copied");

      els.sourcesBlock.hidden = false;

      const level = check.summary.level;
      if (level === "strong") {
        setStatus("Credibility check passed. Citation is ready — copy it below.", "ok");
      } else if (level === "mixed") {
        setStatus("Citation ready. Credibility is mixed — review the 3 comparison sources.", "ok");
      } else {
        setStatus("Citation ready, but credibility looks weak — consider citing a comparison source.", "error");
      }

      // After citing: suggest more sources
      const readyQuery = cleanText([src.title, src.author].filter(Boolean).join(" "));
      if (readyQuery && readyQuery !== lastAutoSourceQuery) {
        lastAutoSourceQuery = readyQuery;
        findCredibleSources({ auto: true });
      } else if (!els.sourcesList.children.length) {
        setSourcesStatus("Browse suggested sources on the same topic below.");
      }
    } finally {
      els.generateBtn.disabled = false;
      els.generateBtn.textContent = previousLabel || "Check credibility & cite";
    }
  }

  async function copyCitation() {
    const text = els.citationOutput.textContent;
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(els.citationOutput);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("copy");
      sel.removeAllRanges();
    }

    els.copyBtn.textContent = "Copied";
    els.copyBtn.classList.add("is-copied");
    setTimeout(() => {
      els.copyBtn.textContent = "Copy";
      els.copyBtn.classList.remove("is-copied");
    }, 1800);
  }

  els.fetchBtn.addEventListener("click", () => {
    lastFetchedUrl = "";
    fetchDetails();
  });
  els.generateBtn.addEventListener("click", generate);
  els.copyBtn.addEventListener("click", copyCitation);
  els.convertBtn.addEventListener("click", convertCitation);
  els.sourcesBtn.addEventListener("click", () => findCredibleSources());
  els.format.addEventListener("change", () => {
    if (!els.citationBlock.hidden) renderCitationOnly();
  });

  els.modeTabs.forEach((tab) => {
    tab.addEventListener("click", () => setMode(tab.dataset.mode));
  });

  els.citationInput.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      convertCitation();
    }
  });

  els.sourcesList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cite-index]");
    if (!btn) return;
    citeSourceAt(Number(btn.getAttribute("data-cite-index")));
  });

  els.editAllBtn.addEventListener("click", () => {
    forceShowAll = true;
    updateFieldVisibility();
    const firstMissing = FIELD_ORDER.find((k) => !isFieldFilled(k)) || "title";
    FIELD_META[firstMissing].input().focus();
  });

  els.detectedList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-edit]");
    if (!btn) return;
    const key = btn.getAttribute("data-edit");
    forceShowAll = true;
    updateFieldVisibility();
    const input = FIELD_META[key]?.input();
    if (input) {
      input.focus();
      input.select?.();
    }
  });

  FIELD_ORDER.forEach((key) => {
    const input = FIELD_META[key].input();
    input.addEventListener("input", () => {
      if (!els.detailsSection.hidden) {
        if (!forceShowAll) updateFieldVisibility();
        if (!els.citationBlock.hidden) renderCitationOnly();
      }
    });
    input.addEventListener("blur", () => {
      if (!els.detailsSection.hidden) {
        if (forceShowAll && FIELD_ORDER.every(isFieldFilled)) forceShowAll = false;
        updateFieldVisibility();
        if (!els.citationBlock.hidden) renderCitationOnly();
      }
    });
  });

  els.url.addEventListener("paste", () => {
    clearTimeout(debounceTimer);
    setTimeout(() => {
      if (looksLikeUrl(els.url.value)) {
        clearMetaFields();
        hideDetails();
        lastFetchedUrl = "";
        fetchDetails({ silentInvalid: true });
      }
    }, 0);
  });

  els.url.addEventListener("input", () => {
    lastFetchedUrl = "";
    hideDetails();
    setStatus("");
    scheduleAutoFetch();
  });

  els.url.addEventListener("change", () => {
    if (looksLikeUrl(els.url.value)) {
      fetchDetails({ silentInvalid: true });
    }
  });

  els.url.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(debounceTimer);
      lastFetchedUrl = "";
      fetchDetails();
    }
  });

  hideDetails();
  setMode("link");
})();
