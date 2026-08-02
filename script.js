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
  };

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
    forceShowAll = false;
    FIELD_ORDER.forEach((key) => {
      const wrap = document.querySelector(`[data-field="${key}"]`);
      if (wrap) wrap.hidden = true;
    });
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
      return `${a} (${src.year}) ${src.title}. ${src.site}. Available at: ${src.url}${accessBit}.`;
    },

    "harvard-au"(src) {
      const a = harvardAuthor(src.author);
      const accessed = formatAccessedLong(src.accessed);
      const viewBit = accessed ? `, viewed ${accessed}` : "";
      return `${a} ${src.year}, '${src.title}', ${src.site}${viewBit}, <${src.url}>.`;
    },

    ieee(src) {
      const a = ieeeAuthor(src.author) || "Anon.";
      const accessed = formatAccessedIEEE(src.accessed);
      const accessBit = accessed ? ` [Accessed: ${accessed}]` : "";
      return `[1] ${a}, "${src.title}," ${src.site}. [Online]. Available: ${src.url}.${accessBit}`;
    },

    apa(src) {
      const a = apaAuthor(src.author);
      const who = a ? `${a} ` : "";
      return `${who}(${src.year}). ${src.title}. ${src.site}. ${src.url}`;
    },

    mla(src) {
      const a = mlaAuthor(src.author);
      const who = a ? `${a}. ` : "";
      const accessed = formatAccessedUS(src.accessed);
      const accessBit = accessed ? ` Accessed ${accessed}.` : "";
      return `${who}"${src.title}." ${src.site}, ${src.year}, ${src.url}.${accessBit}`;
    },

    chicago(src) {
      const a = mlaAuthor(src.author);
      const who = a ? `${a}. ` : "";
      const accessed = formatAccessedUS(src.accessed);
      const accessBit = accessed ? ` Accessed ${accessed}.` : "";
      return `${who}${src.year}. "${src.title}." ${src.site}. ${src.url}.${accessBit}`;
    },

    vancouver(src) {
      const a = vancouverAuthor(src.author) || "Anonymous";
      const accessed = formatAccessedLong(src.accessed);
      const accessBit = accessed ? ` [cited ${accessed}]` : "";
      return `1. ${a}. ${src.title} [Internet]. ${src.site}; ${src.year}${accessBit}. Available from: ${src.url}`;
    },

    bibtex(src) {
      const key = bibtexKey(src);
      const author = src.author || "Anonymous";
      const year = src.year === "n.d." ? "" : src.year;
      return [
        `@misc{${key},`,
        `  author = {${escapeBib(author)}},`,
        `  title = {${escapeBib(src.title)}},`,
        `  year = {${escapeBib(year)}},`,
        `  howpublished = {${escapeBib(src.site)}},`,
        `  url = {${escapeBib(src.url)}},`,
        `  note = {Accessed: ${formatAccessedLong(src.accessed) || "n.d."}}`,
        `}`,
      ].join("\n");
    },
  };

  function generate() {
    const src = getSource();
    if (!src.url) {
      setStatus("Insert a valid link before generating.", "error");
      els.url.focus();
      return;
    }

    const style = els.format.value;
    els.citationLabel.textContent = FORMAT_NAMES[style] || "Citation";
    els.citationOutput.textContent = formatters[style](src);
    els.citationBlock.hidden = false;
    els.citationBlock.style.animation = "none";
    void els.citationBlock.offsetWidth;
    els.citationBlock.style.animation = "";
    els.copyBtn.textContent = "Copy";
    els.copyBtn.classList.remove("is-copied");
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
  els.format.addEventListener("change", () => {
    if (!els.citationBlock.hidden) generate();
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
        // Keep edit-all mode while typing; refresh lists on blur
        if (!forceShowAll) updateFieldVisibility();
        if (!els.citationBlock.hidden) generate();
      }
    });
    input.addEventListener("blur", () => {
      if (!els.detailsSection.hidden) {
        if (forceShowAll && FIELD_ORDER.every(isFieldFilled)) forceShowAll = false;
        updateFieldVisibility();
        if (!els.citationBlock.hidden) generate();
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
})();
