/**
 * Resolve YouTube video id from common URL shapes (or raw 11-char id).
 * @param {string} url
 * @returns {string|null}
 */
export function extractYoutubeVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(u)) return u;
  const short = u.match(/youtu\.be\/([^?&/]+)/);
  if (short?.[1]) return short[1].slice(0, 11);
  const embed = u.match(/youtube\.com\/embed\/([^?&/]+)/);
  if (embed?.[1]) return embed[1].slice(0, 11);
  const v = u.match(/[?&]v=([^&]+)/);
  if (v?.[1]) return v[1].slice(0, 11);
  return null;
}

/**
 * Best-effort duration in seconds from the public watch page (no API key).
 * YouTube markup changes occasionally; multiple patterns are tried.
 * @param {string} videoId
 * @returns {Promise<number|null>}
 */
export async function fetchYoutubeDurationSeconds(videoId) {
  if (!videoId) return null;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(
      `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: controller.signal,
      }
    );
    if (!res.ok) return null;
    const html = await res.text();

    const lengthPatterns = [
      /"lengthSeconds"\s*:\s*"(\d+)"/,
      /"lengthSeconds"\s*:\s*(\d+)\b/,
      /lengthSeconds\\":\\"(\d+)\\"/,
      /lengthSeconds\\":(\d+)/,
    ];
    for (const re of lengthPatterns) {
      const m = html.match(re);
      if (m) {
        const sec = parseInt(m[1], 10);
        if (Number.isFinite(sec) && sec > 0) return sec;
      }
    }

    const msPatterns = [
      /"approxDurationMs"\s*:\s*"(\d+)"/,
      /"approxDurationMs"\s*:\s*(\d+)\b/,
      /approxDurationMs\\":\\"(\d+)\\"/,
    ];
    for (const re of msPatterns) {
      const m = html.match(re);
      if (m) {
        const ms = parseInt(m[1], 10);
        if (Number.isFinite(ms) && ms > 0) return Math.max(1, Math.round(ms / 1000));
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(tid);
  }
}
