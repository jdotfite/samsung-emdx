import { resolveSpotifySettings } from "./spotify-settings-store.mjs";

let tokenCache = {
  value: null,
  expiresAt: 0,
  cacheKey: ""
};

const responseCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatRetryAfter(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "a little while";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

async function getAccessToken(settings) {
  const clientId = settings?.clientId || "";
  const clientSecret = settings?.clientSecret || "";

  if (!clientId || !clientSecret) {
    throw new Error("Spotify credentials are missing. Open Studio > Album Art > Spotify Settings and add your client ID and secret.");
  }

  const cacheKey = `${clientId}:${clientSecret}`;
  if (tokenCache.value && tokenCache.cacheKey === cacheKey && Date.now() < tokenCache.expiresAt) {
    return tokenCache.value;
  }

  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    throw new Error(`Spotify token request failed: ${response.status}`);
  }

  const payload = await response.json();
  tokenCache = {
    value: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in - 60) * 1000,
    cacheKey
  };
  return tokenCache.value;
}

async function spotifyGet(endpoint, params = {}, options = {}) {
  const settings = resolveSpotifySettings();
  const token = await getAccessToken(settings);
  const url = new URL(`https://api.spotify.com/v1/${endpoint}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const cacheKey = url.toString();
  const cacheTtlMs = options.cacheTtlMs ?? 120000;
  const cached = responseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterSeconds = Number(retryAfterHeader || "1");
    if (options.retry429 !== false && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 && retryAfterSeconds <= 3) {
      await sleep(retryAfterSeconds * 1000);
      return spotifyGet(endpoint, params, { ...options, retry429: false });
    }
    throw new Error(`Spotify rate limit reached. Try again in ${formatRetryAfter(retryAfterSeconds)}.`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Spotify request failed: ${response.status} ${response.statusText} - ${body}`);
  }

  const payload = await response.json();
  responseCache.set(cacheKey, {
    data: payload,
    expiresAt: Date.now() + cacheTtlMs
  });
  return payload;
}

export function parseSpotifyId(input) {
  if (!input) {
    return "";
  }

  if (/^[A-Za-z0-9]{22}$/.test(input)) {
    return input;
  }

  const playlistMatch = input.match(/playlist[/:]([A-Za-z0-9]{22})/);
  if (playlistMatch) {
    return playlistMatch[1];
  }

  const artistMatch = input.match(/artist[/:]([A-Za-z0-9]{22})/);
  if (artistMatch) {
    return artistMatch[1];
  }

  const albumMatch = input.match(/album[/:]([A-Za-z0-9]{22})/);
  if (albumMatch) {
    return albumMatch[1];
  }

  return input;
}

export async function searchArtists(query, limit = 8) {
  const settings = resolveSpotifySettings();
  const payload = await spotifyGet("search", {
    q: query,
    type: "artist",
    limit,
    market: settings.market
  });
  return payload.artists?.items || [];
}

export async function searchAlbums(query, limit = 12) {
  const settings = resolveSpotifySettings();
  const payload = await spotifyGet("search", {
    q: query,
    type: "album",
    limit,
    market: settings.market
  });
  return payload.albums?.items || [];
}

export async function getArtistAlbumsPage(artistId, { filter = "album", offset = 0, limit = 20 } = {}) {
  const id = parseSpotifyId(artistId);
  const settings = resolveSpotifySettings();
  const includeGroups = filter === "all" ? "album,single,compilation" : filter;
  const normalizedLimit = Math.min(10, Math.max(1, Number.parseInt(String(limit || "10"), 10) || 10));
  const payload = await spotifyGet(`artists/${id}/albums`, {
    include_groups: includeGroups,
    market: settings.market,
    limit: normalizedLimit,
    offset
  });

  const items = [...new Map((payload.items || []).map((item) => [item.id, item])).values()];
  return {
    items,
    total: payload.total || items.length,
    offset,
    limit: normalizedLimit,
    hasMore: Boolean(payload.next)
  };
}

export async function getAlbum(albumId) {
  const id = parseSpotifyId(albumId);
  const settings = resolveSpotifySettings();
  return spotifyGet(`albums/${id}`, {
    market: settings.market
  });
}

export async function getPlaylistAlbums(playlistId) {
  const id = parseSpotifyId(playlistId);
  const settings = resolveSpotifySettings();
  let next = `playlists/${id}/tracks`;
  const albums = new Map();

  while (next) {
    const endpoint = next.startsWith("https://api.spotify.com/v1/")
      ? next.replace("https://api.spotify.com/v1/", "")
      : next;
    const payload = await spotifyGet(endpoint, {
      market: settings.market,
      limit: 100
    });

    for (const item of payload.items || []) {
      const album = item.track?.album;
      if (!album?.id) {
        continue;
      }
      albums.set(album.id, album);
    }

    next = payload.next;
  }

  return [...albums.values()];
}
