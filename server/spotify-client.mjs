import { resolveSpotifySettings } from "./spotify-settings-store.mjs";

let tokenCache = {
  value: null,
  expiresAt: 0,
  cacheKey: ""
};

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

async function spotifyGet(endpoint, params = {}) {
  const settings = resolveSpotifySettings();
  const token = await getAccessToken(settings);
  const url = new URL(`https://api.spotify.com/v1/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Spotify request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
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

export async function getArtistAlbums(artistId, limit = 20) {
  const id = parseSpotifyId(artistId);
  const target = Math.max(1, Math.min(limit, 50));
  const items = [];
  let offset = 0;

  while (items.length < target) {
    const chunkSize = Math.min(10, target - items.length);
    const payload = await spotifyGet(`artists/${id}/albums`, {
      include_groups: "album,single,compilation",
      limit: chunkSize,
      offset
    });
    const nextItems = payload.items || [];
    if (!nextItems.length) {
      break;
    }
    items.push(...nextItems);
    offset += nextItems.length;
    if (!payload.next) {
      break;
    }
  }

  return items;
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
