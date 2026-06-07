const LOCAL_CHANNELS = [
  {
    title: "T Sports",
    group: "Local TV",
    url: "http://10.14.56.20/T_SPORTS/index.m3u8",
  },
  {
    title: "PTV Sports",
    group: "Local TV",
    url: "http://10.14.56.20/ptvsports/index.m3u8",
  },
  {
    title: "Star Sports 1",
    group: "Local TV",
    url: "http://10.14.56.20/STAR_SPORTS_1/index.m3u8",
  },
  {
    title: "Ten Sports",
    group: "Local TV",
    url: "http://10.14.56.20/tensports/index.m3u8",
  },
  {
    title: "beIN Sports 1 / LaLiga TV",
    group: "Local TV",
    url: "http://10.14.56.20/foxsports1/index.m3u8",
  },
  {
    title: "TNT Sports",
    group: "Local TV",
    url: "http://10.14.56.20/SPORTS6/index.m3u8",
  },
];

const ROARZONE_HOME = "https://tv.roarzone.net/";
const ROARZONE_PLAYER = "https://tv.roarzone.net/player.php";

const CATALOG_CACHE_TTL_SECONDS = 3600;
const SIGNED_URL_CACHE_TTL_SECONDS = 60;
const MANIFEST_CACHE_TTL_SECONDS = 20;
const PLAYLIST_CACHE_TTL_SECONDS = 3600;
const STALE_PLAYLIST_SECONDS = 86400;
const STALE_MANIFEST_SECONDS = 20;
const FETCH_TIMEOUT_MS = 12000;

const TEXT_HEADERS = {
  "cache-control": "no-store",
  "content-type": "text/plain; charset=utf-8",
};

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
};

const PLAYLIST_HEADERS = {
  "cache-control": `public, max-age=${PLAYLIST_CACHE_TTL_SECONDS}, s-maxage=${CATALOG_CACHE_TTL_SECONDS}, stale-while-revalidate=${STALE_PLAYLIST_SECONDS}`,
  "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
};

const MANIFEST_HEADERS = {
  "cache-control": `public, max-age=10, s-maxage=${MANIFEST_CACHE_TTL_SECONDS}, stale-while-revalidate=${STALE_MANIFEST_SECONDS}`,
  "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
};

let hotCatalog = {
  expiresAt: 0,
  channels: [],
};

const inflightCatalogRequests = new Map();
const inflightSignedUrlRequests = new Map();
const inflightManifestRequests = new Map();

export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return handleIndex(request);
    }

    if (url.pathname === "/playlist.m3u") {
      return handlePlaylist(request, ctx);
    }

    if (url.pathname === "/roarzone.m3u8") {
      return handleRoarZoneStream(request, ctx);
    }

    return new Response("Available endpoint: /playlist.m3u", {
      status: 404,
      headers: TEXT_HEADERS,
    });
  },
};

async function handlePlaylist(request, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(
    buildCacheUrl(request.url, "/__cache/v2/playlist"),
  );
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  const cacheId = "playlist";
  const response = await dedupe(inflightCatalogRequests, cacheId, async () => {
    const baseUrl = getBaseUrl(request.url);
    const roarzoneChannels = await fetchRoarZoneCatalog(ctx);
    const lines = ["#EXTM3U"];

    for (const channel of LOCAL_CHANNELS) {
      lines.push(toExtInf(channel.title, channel.group, channel.logo));
      lines.push(channel.url);
      lines.push("");
    }

    for (const channel of roarzoneChannels) {
      lines.push(toExtInf(channel.title, channel.group, channel.logo));
      lines.push(
        `${baseUrl}/roarzone.m3u8?stream=${encodeURIComponent(channel.stream)}`,
      );
      lines.push("");
    }

    return new Response(lines.join("\n"), { headers: PLAYLIST_HEADERS });
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function handleRoarZoneStream(request, ctx) {
  const url = new URL(request.url);
  const stream = url.searchParams.get("stream");
  if (!stream) {
    return new Response("Missing stream query parameter", {
      status: 400,
      headers: TEXT_HEADERS,
    });
  }

  const cache = caches.default;
  const cacheKey = new Request(
    buildCacheUrl(
      request.url,
      `/__cache/v2/manifest/${encodeURIComponent(stream)}`,
    ),
  );
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  const response = await dedupe(inflightManifestRequests, stream, async () => {
    try {
      const signedUrl = await getSignedStreamUrl(stream, ctx);
      const upstream = await fetch(signedUrl, {
        headers: buildRoarZoneHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!upstream.ok) {
        return new Response(`Upstream manifest failed: ${upstream.status}`, {
          status: 502,
          headers: TEXT_HEADERS,
        });
      }

      const manifestText = await upstream.text();
      const rewritten = rewriteManifestUrls(manifestText, signedUrl);
      return new Response(rewritten, { headers: MANIFEST_HEADERS });
    } catch (error) {
      return new Response(toErrorMessage(error), {
        status: 502,
        headers: TEXT_HEADERS,
      });
    }
  });

  if (response.ok) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }

  return response;
}
async function fetchRoarZoneCatalog(ctx) {
  if (hotCatalog.expiresAt > Date.now() && hotCatalog.channels.length > 0) {
    return hotCatalog.channels;
  }

  const cache = caches.default;
  const cacheKey = new Request("https://cache.local/__cache/v2/catalog");
  const cached = await cache.match(cacheKey);
  if (cached) {
    const channels = await cached.json();
    hotCatalog = {
      expiresAt: Date.now() + CATALOG_CACHE_TTL_SECONDS * 1000,
      channels,
    };
    return channels;
  }

  const channels = await dedupe(
    inflightCatalogRequests,
    "catalog",
    async () => {
      const response = await fetch(ROARZONE_HOME, {
        headers: {
          "User-Agent": "Mozilla/5.0",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Failed to load RoarZone catalog: ${response.status}`);
      }

      const channels = [];
      const seen = new Set();
      let currentChannel = null;

      class ChannelHandler {
        element(element) {
          const title = element.getAttribute("data-title");
          const stream = element.getAttribute("data-stream");
          const tags = element.getAttribute("data-tags");

          if (title && stream) {
            const normTitle = normalizeTitle(decodeHtml(title).trim());
            const normStream = stream.trim();
            const groupName = tags ? normalizeTitle(tags) : "RoarZone";

            if (normTitle && normStream && !seen.has(normStream)) {
              seen.add(normStream);
              currentChannel = {
                title: normTitle,
                stream: normStream,
                group: groupName,
                logo: "",
              };
              channels.push(currentChannel);
            } else {
              currentChannel = null;
            }
          }
        }
      }

      class ImageHandler {
        element(element) {
          if (currentChannel && !currentChannel.logo) {
            const src = element.getAttribute("src");
            if (src) {
              currentChannel.logo = src;
            }
          }
        }
      }

      await new HTMLRewriter()
        .on("div.channel-card", new ChannelHandler())
        .on("div.channel-card img", new ImageHandler())
        .transform(response)
        .text();

      return channels;
    },
  );

  hotCatalog = {
    expiresAt: Date.now() + CATALOG_CACHE_TTL_SECONDS * 1000,
    channels,
  };

  const cacheResponse = new Response(JSON.stringify(channels), {
    headers: {
      "cache-control": `public, max-age=${CATALOG_CACHE_TTL_SECONDS}, s-maxage=${CATALOG_CACHE_TTL_SECONDS}, stale-while-revalidate=${STALE_PLAYLIST_SECONDS}`,
      "content-type": "application/json; charset=utf-8",
    },
  });
  ctx.waitUntil(cache.put(cacheKey, cacheResponse));

  return channels;
}

async function getSignedStreamUrl(stream, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(
    `https://cache.local/__cache/v2/signed/${encodeURIComponent(stream)}`,
  );
  const cached = await cache.match(cacheKey);
  if (cached) {
    const payload = await cached.json();
    if (payload?.url) {
      return payload.url;
    }
  }

  const signedUrl = await dedupe(
    inflightSignedUrlRequests,
    stream,
    async () => {
      const playerUrl = `${ROARZONE_PLAYER}?stream=${encodeURIComponent(stream)}`;
      const response = await fetch(playerUrl, {
        headers: buildRoarZoneHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Failed to load player page: ${response.status}`);
      }

      const html = await response.text();
      const match = html.match(/https?:\/\/[^\s"'<>]+m3u8[^\s"'<>]*/);
      if (!match) {
        throw new Error("Signed stream URL not found");
      }

      return match[0];
    },
  );

  const cacheResponse = new Response(JSON.stringify({ url: signedUrl }), {
    headers: {
      "cache-control": `public, max-age=${SIGNED_URL_CACHE_TTL_SECONDS}, s-maxage=${SIGNED_URL_CACHE_TTL_SECONDS}`,
      "content-type": "application/json; charset=utf-8",
    },
  });
  ctx.waitUntil(cache.put(cacheKey, cacheResponse));

  return signedUrl;
}

function rewriteManifestUrls(manifestText, manifestUrl) {
  const baseUrl = new URL(manifestUrl);
  return manifestText
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return line;
      }
      return line.replace(trimmed, new URL(trimmed, baseUrl).toString());
    })
    .join("\n");
}

function buildRoarZoneHeaders() {
  return {
    Referer: ROARZONE_HOME,
    Origin: "https://tv.roarzone.net",
    "User-Agent": "Mozilla/5.0",
  };
}

async function dedupe(map, key, factory) {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }

  const promise = Promise.resolve()
    .then(factory)
    .finally(() => {
      map.delete(key);
    });

  map.set(key, promise);
  return promise;
}

function getBaseUrl(requestUrl) {
  const url = new URL(requestUrl);
  return `${url.protocol}//${url.host}`;
}

function buildCacheUrl(requestUrl, pathname) {
  const url = new URL(requestUrl);
  url.pathname = pathname;
  url.search = "";
  return url.toString();
}

function normalizeTitle(title) {
  return title
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function decodeHtml(text) {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"');
}

function toExtInf(title, group, logo) {
  let attrs = `tvg-name="${escapeAttr(title)}" group-title="${escapeAttr(group)}"`;
  if (logo) {
    attrs += ` tvg-logo="${escapeAttr(logo)}"`;
  }
  return `#EXTINF:-1 ${attrs},${title}`;
}

function escapeAttr(text) {
  return text.replaceAll('"', "'");
}

function toErrorMessage(error) {
  if (error instanceof Error && error.name === "AbortError") {
    return "Upstream request timed out";
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Upstream request failed";
}

function handleIndex(request) {
  const baseUrl = getBaseUrl(request.url);
  const playlistUrl = `${baseUrl}/playlist.m3u`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RoarFlare M3U Playlist</title>
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; line-height: 1.6; background: #f9fafb; color: #111827; }
        .container { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
        h1 { color: #2563eb; margin-top: 0; }
        .url-box { background: #f3f4f6; padding: 1rem; border-radius: 4px; font-family: monospace; font-size: 1.1rem; word-break: break-all; border: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; }
        .copy-btn { background: #2563eb; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; font-weight: bold; }
        .copy-btn:hover { background: #1d4ed8; }
        .steps { margin-top: 2rem; }
        .steps li { margin-bottom: 0.5rem; }
    </style>
</head>
<body>
    <div class="container">
        <h1>RoarFlare IPTV Playlist</h1>
        <p>Your M3U playlist URL is ready to use. Copy the link below and add it to your favorite IPTV player.</p>
        
        <div class="url-box">
            <span id="playlist-url">${playlistUrl}</span>
            <button class="copy-btn" onclick="copyUrl()">Copy URL</button>
        </div>

        <div class="steps">
            <h2>How to use this playlist:</h2>
            <ol>
                <li>Download an IPTV player (like TiviMate, IPTV Smarters, VLC, or Sparkle TV).</li>
                <li>Go to the app's settings and select <strong>Add Playlist</strong> or <strong>Add M3U URL</strong>.</li>
                <li>Paste the URL copied from above into the playlist link/URL field.</li>
                <li>Save and wait for the app to load the channels.</li>
                <li>Enjoy watching your favorite streams!</li>
            </ol>
        </div>
    </div>

    <script>
        function copyUrl() {
            const urlText = document.getElementById('playlist-url').innerText;
            navigator.clipboard.writeText(urlText).then(() => {
                const btn = document.querySelector('.copy-btn');
                btn.innerText = 'Copied!';
                setTimeout(() => { btn.innerText = 'Copy URL'; }, 2000);
            });
        }
    </script>
</body>
</html>
  `;

  return new Response(html, { headers: HTML_HEADERS });
}
