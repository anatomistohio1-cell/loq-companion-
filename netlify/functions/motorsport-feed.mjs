const FEEDS = Object.freeze({
  wec: {
    url: 'https://www.autosport.com/rss/wec/news/',
    host: 'www.autosport.com',
  },
  imsa: {
    url: 'https://www.autosport.com/rss/imsa/news/',
    host: 'www.autosport.com',
  },
  wrc: {
    url: 'https://www.autosport.com/rss/wrc/news/',
    host: 'www.autosport.com',
  },
  rally: {
    url: 'https://dirtfish.com/feed/',
    host: 'dirtfish.com',
  },
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

const isAllowedOrigin = (request) => {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const siteUrl = process.env.URL;
  try {
    return Boolean(siteUrl && new URL(origin).origin === new URL(siteUrl).origin);
  } catch {
    return false;
  }
};

export default async (request) => {
  if (request.method !== 'GET') return json({ detail: 'Method not allowed.' }, 405);
  if (!isAllowedOrigin(request)) return json({ detail: 'Origin is not allowed.' }, 403);

  const key = new URL(request.url).searchParams.get('series');
  const feed = FEEDS[key];
  if (!feed) return json({ detail: 'Choose a supported motorsport feed.' }, 400);

  try {
    const response = await fetch(feed.url, {
      headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      console.error(`Motorsport RSS source returned ${response.status}.`);
      return json({ detail: 'The selected motorsport news feed is unavailable.' }, 502);
    }

    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== feed.host) {
      console.error('Motorsport RSS source resolved outside its configured host.');
      return json({ detail: 'The selected news source could not be verified.' }, 502);
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > 1_000_000) {
      return json({ detail: 'The selected news feed is too large to load.' }, 502);
    }
    const xml = await response.text();
    if (xml.length > 1_000_000 || !/<rss[\s>]/i.test(xml)) {
      return json({ detail: 'The selected source did not return a supported RSS feed.' }, 502);
    }

    return new Response(xml, {
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=600, stale-while-revalidate=300',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('Motorsport RSS request failed:', error);
    return json({ detail: 'The selected motorsport news feed could not be reached.' }, 502);
  }
};
