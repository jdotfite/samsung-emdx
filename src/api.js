const AUTH_TOKEN_STORAGE_KEY = "poster-creator-api-token";

export function saveApiAuthToken(token) {
  window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
}

function getApiAuthHeaders() {
  const token = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiGetJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...getApiAuthHeaders() }
  });
  return parseJson(response);
}

export async function apiPutJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...getApiAuthHeaders() },
    body: JSON.stringify(body)
  });
  return parseJson(response);
}

export async function apiDeleteJson(url) {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { Accept: "application/json", ...getApiAuthHeaders() }
  });
  return parseJson(response);
}

export async function apiPostJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...getApiAuthHeaders() },
    body: JSON.stringify(body)
  });
  return parseJson(response);
}

export async function apiUploadImage(url, file, options = {}) {
  const headers = {
    Accept: "application/json",
    "Content-Type": file.type || "application/octet-stream",
    "X-Filename": encodeURIComponent(file.name || "upload"),
    ...getApiAuthHeaders()
  };

  if (options.replaceName) {
    headers["X-Replace-Name"] = encodeURIComponent(options.replaceName);
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: file
  });
  return parseJson(response);
}

async function parseJson(response) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}
