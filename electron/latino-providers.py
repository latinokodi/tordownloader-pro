#!/usr/bin/env python3
"""
latino-providers.py — IMDB-based torrent providers for TorDownloader Electron.
Ported from nuvio-latino Stremio addon.

Usage:
  python latino-providers.py <imdb_id> <type> [season] [episode]
  python latino-providers.py --stream <imdb_id> <type> [season] [episode]

  type: movie | series
  season/episode: required for series

Three providers:
  1. TCL — hacktorrent.to WordPress REST API
  2. Cinecalidad — via Torrentio proxy
  3. Comet — via Comet Stremio addon

Output: JSON lines (stream mode) or single JSON array (batch mode).
"""

import sys
import json
import re
import base64
import urllib.request
import urllib.parse
import concurrent.futures
from typing import Optional

# ── Constants ───────────────────────────────────────────

TCL_HOST = 'https://hacktorrent.to'
TCL_API = f'{TCL_HOST}/wp-json/wpreact/v1'

CINECALIDAD_URL = 'https://torrentio.strem.fun/providers=cinecalidad'

COMET_BASE = (
    'https://comet.stremio.ru/'
    'eyJtYXhSZXN1bHRzUGVyUmVzb2x1dGlvbiI6MCwibWF4U2l6ZSI6MzIyMTIyNTQ3MjAs'
    'ImNhY2hlZE9ubHkiOmZhbHNlLCJzb3J0Q2FjaGVkVW5jYWNoZWRUb2dldGhlciI6ZmFs'
    'c2UsInJlbW92ZVRyYXNoIjp0cnVlLCJyZXN1bHRGb3JtYXQiOlsiYWxsIl0sImRlYnJp'
    'ZFNlcnZpY2VzIjpbXSwiZW5hYmxlVG9ycmVudCI6dHJ1ZSwiZGVkdXBsaWNhdGVTdHJl'
    'YW1zIjpmYWxzZSwic2NyYXBlRGVicmlkQWNjb3VudFRvcnJlbnRzIjpmYWxzZSwiZGVi'
    'cmlkU3RyZWFtUHJveHlQYXNzd29yZCI6IiIsImxhbmd1YWdlcyI6eyJyZXF1aXJlZCI6'
    'WyJsYSJdLCJhbGxvd2VkIjpbXSwiZXhjbHVkZSI6W10sInByZWZlcnJlZCI6WyJsYSJd'
    'fSwicmVzb2x1dGlvbnMiOnsicjQ4MHAiOmZhbHNlLCJyMzYwcCI6ZmFsc2UsInIyNDBw'
    'IjpmYWxzZX0sIm9wdGlvbnMiOnsicmVtb3ZlX3JhbmtzX3VuZGVyIjotMTAwMDAwMDAw'
    'MDAsImFsbG93X2VuZ2xpc2hfaW5fbGFuZ3VhZ2VzIjp0cnVlLCJyZW1vdmVfdW5rbm93'
    'bl9sYW5ndWFnZXMiOmZhbHNlfX0='
)

IMDB_SUGGESTION = 'https://v3.sg.media-imdb.com/suggestion'
CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta'
TRAKT_URL = 'https://api.trakt.tv'

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.coppersurfer.tk:6969/announce',
    'udp://tracker.leechers-paradise.org:6969/announce',
]

HTML_TAG_RE = re.compile(r'<[^>]+>')
MAGNET_RE = re.compile(r'magnet:\?[^\s"\'<>]+', re.IGNORECASE)
INFO_HASH_RE = re.compile(r'btih:([a-fA-F0-9]{40})', re.IGNORECASE)


# ── HTTP helpers ────────────────────────────────────────

def http_get(url, timeout=15, referer=None, accept_json=False):
    """Simple HTTP GET, returns body string."""
    headers = {'User-Agent': UA}
    if referer:
        headers['Referer'] = referer
    if accept_json:
        headers['Accept'] = 'application/json'
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode('utf-8', errors='replace')


def http_get_json(url, timeout=15, referer=None):
    """HTTP GET returning parsed JSON."""
    return json.loads(http_get(url, timeout, referer, accept_json=True))


# ── Title normalization (matches nuvio-latino) ──────────

def normalize_title(text):
    if not text:
        return ''
    # Remove accents
    import unicodedata
    nfkd = unicodedata.normalize('NFKD', text)
    no_accents = ''.join(c for c in nfkd if not unicodedata.combining(c))
    lower = no_accents.lower()
    # Remove years
    lower = re.sub(r'\(\d{4}\)|\b\d{4}\b', ' ', lower)
    # Keep only alphanumeric
    lower = re.sub(r'[^a-z0-9]+', ' ', lower)
    return ' '.join(lower.split())


def build_magnet(info_hash, name=''):
    """Build a magnet URI from info_hash."""
    if not info_hash:
        return ''
    dn = f'&dn={urllib.parse.quote(name)}' if name else ''
    tr = ''.join(f'&tr={urllib.parse.quote(t)}' for t in TRACKERS)
    return f'magnet:?xt=urn:btih:{info_hash}{dn}{tr}'


def extract_info_hash(magnet_or_url):
    """Extract info_hash from a magnet link."""
    if not magnet_or_url:
        return None
    m = INFO_HASH_RE.search(magnet_or_url)
    return m.group(1).lower() if m else None


def format_result(title, magnet, info_hash, size='', source=''):
    """Format a result dict matching TorDownloader's MetaResult."""
    return {
        'title': title,
        'size': size or '0 B',
        'seeders': -1,
        'peers': -1,
        'link': magnet,
        'indexer': source,
        'info_hash': info_hash,
    }


# ── IMDB / Cinemeta / Trakt metadata resolution ─────────

def resolve_metadata(imdb_id, media_type):
    """Resolve title + year from IMDB → Cinemeta → Trakt."""
    titles = set()
    year = None
    primary_title = None

    # Step 1: IMDB Suggestion API
    try:
        data = http_get_json(
            f'{IMDB_SUGGESTION}/{imdb_id}.json',
            timeout=6,
        )
        items = data.get('d', [])
        for item in items:
            if item.get('id') and '/' in item['id']:
                continue
            if item.get('l'):
                primary_title = item['l']
                titles.add(item['l'])
            if item.get('y'):
                year = item['y']
            if primary_title:
                break
    except Exception:
        pass

    # Step 2: Cinemeta fallback
    if not primary_title:
        try:
            cm_type = 'series' if media_type == 'series' else 'movie'
            data = http_get_json(f'{CINEMETA_URL}/{cm_type}/{imdb_id}.json', timeout=6)
            meta = data.get('meta', {})
            if meta.get('name'):
                primary_title = meta['name']
                titles.add(meta['name'])
                if meta.get('year'):
                    y = str(meta['year'])
                    m = re.search(r'\d{4}', y)
                    if m:
                        year = int(m.group())
        except Exception:
            pass

    if not primary_title:
        return None

    # Step 3: Trakt aliases
    try:
        trakt_type = 'shows' if media_type == 'series' else 'movies'
        data = http_get_json(
            f'{TRAKT_URL}/{trakt_type}/{imdb_id}/aliases',
            timeout=5,
        )
        for alias in data:
            if alias.get('title'):
                titles.add(alias['title'])
    except Exception:
        pass

    return {
        'titles': list(titles),
        'year': year,
    }


# ── Provider: TCL (hacktorrent.to) ─────────────────────

def tcl_search_api(query, content_type):
    """Search hacktorrent.to WP REST API."""
    params = urllib.parse.urlencode({
        'query': query,
        'type': content_type,
        'page': '1',
    })
    try:
        data = http_get_json(
            f'{TCL_API}/search?{params}',
            timeout=10,
            referer=f'{TCL_HOST}/',
        )
        return data.get('results', [])
    except Exception:
        return []


def tcl_movie_detail(slug):
    """Get movie detail with downloads."""
    try:
        return http_get_json(
            f'{TCL_API}/movie/{urllib.parse.quote(slug)}',
            timeout=10,
            referer=f'{TCL_HOST}/',
        )
    except Exception:
        return None


def tcl_series_detail(slug, content_type):
    """Get series detail with downloads."""
    endpoint = 'anime' if content_type == 'anime' else 'serie'
    try:
        data = http_get_json(
            f'{TCL_API}/{endpoint}/{urllib.parse.quote(slug)}',
            timeout=10,
            referer=f'{TCL_HOST}/',
        )
        # Also fetch related downloads for series
        if endpoint == 'serie':
            try:
                related = http_get_json(
                    f'{TCL_API}/serie/{urllib.parse.quote(slug)}/related?vb=12',
                    timeout=8,
                    referer=f'{TCL_HOST}/',
                )
                if related and related.get('downloads'):
                    if data is None:
                        data = {}
                    data['downloads'] = related['downloads']
            except Exception:
                pass
        return data
    except Exception:
        return None


def resolve_acortalink(acorta_url):
    """Resolve acortalink.net short URL to magnet."""
    try:
        parsed = urllib.parse.urlparse(acorta_url)
        qs = urllib.parse.parse_qs(parsed.query)
        i_param = qs.get('i', [''])[0]
        if not i_param:
            return None
        # 'i' param is base64-encoded 'l' param
        l_param = base64.b64decode(i_param).decode('utf-8', errors='replace')
        resolve_url = f'https://acortalink.net/r.php?l={l_param}'
        html = http_get(resolve_url, timeout=10, referer=f'{TCL_HOST}/')
        matches = MAGNET_RE.findall(html)
        return matches[0] if matches else None
    except Exception:
        return None


def provider_tcl(imdb_id, media_type, season=None, episode=None):
    """Scrape hacktorrent.to for torrents matching IMDB ID."""
    results = []

    # Resolve metadata
    meta = resolve_metadata(imdb_id, media_type)
    if not meta:
        return results

    titles = meta['titles']
    year = meta['year']

    # Content type mapping (TCL uses Spanish types)
    if media_type == 'movie':
        content_types = ['pelicula']
    else:
        content_types = ['serie', 'anime']

    # Try each title until we find a match
    match = None
    active_ct = None
    for ct in content_types:
        for title in titles:
            api_results = tcl_search_api(title, ct)
            normalized_titles = {normalize_title(t) for t in titles}
            for item in api_results:
                item_title = HTML_TAG_RE.sub('', item.get('title', '')).strip()
                if normalize_title(item_title) not in normalized_titles:
                    continue
                item_year = str(item.get('year', ''))
                if ct == 'pelicula' and year and item_year and item_year != str(year):
                    continue
                match = item
                active_ct = ct
                break
            if match:
                break
        if match:
            break

    if not match:
        return results

    slug = match.get('slug', '')
    if not slug:
        return results

    # Get detail page with downloads
    downloads = []
    if media_type == 'movie':
        detail = tcl_movie_detail(slug)
        if detail:
            downloads = detail.get('downloads', [])
    else:
        detail = tcl_series_detail(slug, active_ct)
        if detail:
            all_downloads = detail.get('downloads', [])
            downloads = [
                d for d in all_downloads
                if str(d.get('season', '')) == str(season)
                and str(d.get('episode', '')) == str(episode)
            ]

    for dl in downloads:
        magnet = dl.get('download_link') or dl.get('magnet', '')
        if 'acortalink.net' in magnet:
            resolved = resolve_acortalink(magnet)
            if resolved:
                magnet = resolved

        info_hash = extract_info_hash(magnet)
        if not info_hash:
            continue

        title = dl.get('title') or match.get('title', '')
        quality = dl.get('quality', '')
        lang = dl.get('language', '')
        size = dl.get('size', '')

        label = title
        if quality:
            label += f' [{quality}]'

        results.append(format_result(
            label, magnet, info_hash, size, 'TCL',
        ))

    return results


# ── Provider: Cinecalidad (via Torrentio) ───────────────

def provider_cinecalidad(imdb_id, media_type, season=None, episode=None):
    """Scrape Cinecalidad torrents via Torrentio."""
    results = []

    if media_type == 'movie':
        path = f'stream/movie/{imdb_id}.json'
    else:
        if not season or not episode:
            return []
        path = f'stream/series/{imdb_id}:{season}:{episode}.json'

    url = f'{CINECALIDAD_URL}/{path}'
    try:
        data = http_get_json(url, timeout=8)
        streams = data.get('streams', [])
    except Exception:
        return results

    for s in streams:
        info_hash = (s.get('infoHash') or '').lower()
        if not info_hash:
            continue

        title = s.get('title', '')
        # Filter: only Cinecalidad provider
        provider_match = re.search(r'⚙[^\n]*?\s([^\s\n]+)', title)
        if provider_match and provider_match.group(1).lower() != 'cinecalidad':
            continue

        filename = (s.get('behaviorHints', {}).get('filename')
                    or title.split('\n')[0]
                    or info_hash)

        # Extract size from title
        size = ''
        size_match = re.search(r'💾\s*([\d.]+\s*[KMGT]B)', title, re.IGNORECASE)
        if size_match:
            size = size_match.group(1)

        magnet = build_magnet(info_hash, filename)
        results.append(format_result(filename, magnet, info_hash, size, 'CC'))

    return results


# ── Provider: Comet ─────────────────────────────────────

def provider_comet(imdb_id, media_type, season=None, episode=None):
    """Scrape torrents via Comet Stremio addon."""
    results = []

    if media_type == 'movie':
        path = f'stream/movie/{imdb_id}.json'
    else:
        if not season or not episode:
            return []
        path = f'stream/series/{imdb_id}:{season}:{episode}.json'

    url = f'{COMET_BASE}/{path}'
    try:
        data = http_get_json(url, timeout=15)
        streams = data.get('streams', [])
    except Exception:
        return results

    for s in streams:
        info_hash = (s.get('infoHash') or '').lower()
        direct_url = s.get('url', '')
        description = s.get('description', '')

        # Filename
        filename = (s.get('behaviorHints', {}).get('filename')
                    or info_hash or '')
        if (not filename or filename == info_hash) and description:
            m = re.search(r'📄\s*([^\n]+)', description)
            if m:
                filename = m.group(1).strip()

        # Size
        size = ''
        if description:
            size_match = re.search(r'💾\s*([\d.]+\s*[KMGT]B)', description, re.IGNORECASE)
            if size_match:
                size = size_match.group(1)

        # Debrid cached streams (have directUrl, no infoHash)
        if not info_hash and direct_url:
            results.append({
                'title': filename,
                'size': size or '0 B',
                'seeders': -1,
                'peers': -1,
                'link': direct_url,
                'indexer': 'Comet',
                'info_hash': None,
            })
            continue

        if not info_hash:
            continue

        magnet = build_magnet(info_hash, filename)
        results.append(format_result(filename, magnet, info_hash, size, 'Comet'))

    return results


# ── Main ────────────────────────────────────────────────

def run_all(imdb_id, media_type, season=None, episode=None):
    """Run all 3 providers in parallel and collect results."""
    all_results = []

    providers = {
        'TCL': provider_tcl,
        'Cinecalidad': provider_cinecalidad,
        'Comet': provider_comet,
    }

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            executor.submit(fn, imdb_id, media_type, season, episode): name
            for name, fn in providers.items()
        }

        for future in concurrent.futures.as_completed(futures, timeout=30):
            name = futures[future]
            try:
                results = future.result(timeout=25)
                all_results.extend(results)
            except Exception:
                pass

    return all_results


def main():
    args = sys.argv[1:]
    stream_mode = '--stream' in args
    clean_args = [a for a in args if not a.startswith('--')]

    if len(clean_args) < 2:
        print(json.dumps({'error': 'Usage: latino-providers.py <imdb_id> <type> [season] [episode]'}))
        sys.exit(1)

    imdb_id = clean_args[0]
    media_type = clean_args[1]  # 'movie' or 'series'
    season = clean_args[2] if len(clean_args) > 2 else None
    episode = clean_args[3] if len(clean_args) > 3 else None

    if media_type == 'series' and (not season or not episode):
        print(json.dumps({'error': 'Season and episode required for series'}))
        sys.exit(1)

    if stream_mode:
        # Stream mode: emit JSON lines per provider
        providers = {
            'TCL': provider_tcl,
            'Cinecalidad': provider_cinecalidad,
            'Comet': provider_comet,
        }
        all_results = []

        for name in providers:
            print(json.dumps({'type': 'provider_start', 'provider': name}), flush=True)

        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            futures = {
                executor.submit(fn, imdb_id, media_type, season, episode): name
                for name, fn in providers.items()
            }

            for future in concurrent.futures.as_completed(futures, timeout=30):
                name = futures[future]
                try:
                    results = future.result(timeout=25)
                    all_results.extend(results)
                    print(json.dumps({
                        'type': 'provider_results',
                        'provider': name,
                        'results': results,
                    }), flush=True)
                except Exception:
                    print(json.dumps({
                        'type': 'provider_results',
                        'provider': name,
                        'results': [],
                    }), flush=True)

        print(json.dumps({'type': 'done', 'total': len(all_results)}), flush=True)
    else:
        results = run_all(imdb_id, media_type, season, episode)
        print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
