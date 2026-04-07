export async function apiGetJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" }
  });
  return parseJson(response);
}

export async function apiPutJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body)
  });
  return parseJson(response);
}

export async function apiPostJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body)
  });
  return parseJson(response);
}

export async function apiUploadImage(url, file, options = {}) {
  const headers = {
    Accept: "application/json",
    "Content-Type": file.type || "application/octet-stream",
    "X-Filename": encodeURIComponent(file.name || "upload")
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
    throw new Error(payload?.error || `Request failed: ${response.status}`);
  }
  return payload;
}
