export async function fetchStartupOpen() {
  try {
    const res = await fetch("/api/startup");
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.hasFile) return null;
    return {
      name: data.name,
      path: data.path,
      url: openedUrl(data.id),
      id: data.id,
    };
  } catch {
    return null;
  }
}

export function openedUrl(id) {
  return id ? `/opened/${encodeURIComponent(id)}.pdf` : `/opened.pdf?t=${Date.now()}`;
}
