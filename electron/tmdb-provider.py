#!/usr/bin/env python3
"""
tmdb-provider.py — TMDB API bridge for TorDownloader Electron.
No external deps, stdlib only.

Usage:
  python tmdb-provider.py lists                  → trending/popular/topRated
  python tmdb-provider.py detail <id> <type>     → movie or series detail
  python tmdb-provider.py season <id> <season>   → episode list

All output is JSON to stdout. TMDB API key from TMDB_API_KEY env var.
"""

import sys
import json
import os
import urllib.request
import urllib.parse

TMDB_KEY = os.environ.get('TMDB_API_KEY', '')
TMDB_BASE = 'https://api.themoviedb.org/3'
TMDB_IMAGE = 'https://image.tmdb.org/t/p'

UA = 'TorDownloader-PRO/1.0'


class TMDBError(Exception):
    pass


def tmdb_get(path, params=None):
    """Call TMDB API and return parsed JSON. Raises TMDBError on failure."""
    if params is None:
        params = {}
    params['api_key'] = TMDB_KEY
    params['language'] = 'es-ES'
    qs = urllib.parse.urlencode(params)
    url = f'{TMDB_BASE}{path}?{qs}'
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read()
            return json.loads(body)
    except Exception as e:
        raise TMDBError(str(e)) from e


def poster_url(path, size='w342'):
    if not path:
        return None
    return f'{TMDB_IMAGE}/{size}{path}'


def backdrop_url(path, size='w780'):
    if not path:
        return None
    return f'{TMDB_IMAGE}/{size}{path}'


def format_item(item, media_type):
    title = item.get('title') or item.get('name', '')
    return {
        'id': item['id'],
        'title': title,
        'overview': item.get('overview', ''),
        'poster': poster_url(item.get('poster_path')),
        'backdrop': backdrop_url(item.get('backdrop_path')),
        'year': (item.get('release_date') or item.get('first_air_date') or '')[:4],
        'rating': round(item.get('vote_average', 0), 1),
        'media_type': media_type,
    }


def cmd_lists():
    result = {'movies': {}, 'tv': {}}

    for kind in ('trending', 'popular', 'top_rated'):
        if kind == 'trending':
            data = tmdb_get('/trending/movie/week')
            items = data.get('results', [])
        elif kind == 'popular':
            data = tmdb_get('/movie/popular')
            items = data.get('results', [])
        else:
            data = tmdb_get('/movie/top_rated')
            items = data.get('results', [])

        result['movies'][kind] = [format_item(item, 'movie') for item in items[:20]]

    for kind in ('trending', 'popular', 'top_rated'):
        if kind == 'trending':
            data = tmdb_get('/trending/tv/week')
            items = data.get('results', [])
        elif kind == 'popular':
            data = tmdb_get('/tv/popular')
            items = data.get('results', [])
        else:
            data = tmdb_get('/tv/top_rated')
            items = data.get('results', [])

        result['tv'][kind] = [format_item(item, 'tv') for item in items[:20]]

    return result


def cmd_load_more(media_type, kind, page):
    page = int(page)

    if kind == 'trending':
        return {'results': [], 'page': page, 'total_pages': 1}

    if media_type == 'movie':
        if kind == 'popular':
            data = tmdb_get('/movie/popular', {'page': page})
        else:
            data = tmdb_get('/movie/top_rated', {'page': page})
    else:
        if kind == 'popular':
            data = tmdb_get('/tv/popular', {'page': page})
        else:
            data = tmdb_get('/tv/top_rated', {'page': page})

    items = data.get('results', [])
    result = [format_item(item, media_type) for item in items]
    total_pages = data.get('total_pages', 1)
    return {'results': result, 'page': page, 'total_pages': min(total_pages, 25)}


def cmd_detail(tmdb_id, media_type):
    if media_type == 'movie':
        data = tmdb_get(f'/movie/{tmdb_id}')
        ext = tmdb_get(f'/movie/{tmdb_id}/external_ids')
        result = format_item(data, 'movie')
        result['imdb_id'] = ext.get('imdb_id')
        result['runtime'] = data.get('runtime', 0)
        result['genres'] = [g['name'] for g in data.get('genres', [])]
    else:
        data = tmdb_get(f'/tv/{tmdb_id}')
        ext = tmdb_get(f'/tv/{tmdb_id}/external_ids')
        result = format_item(data, 'tv')
        result['imdb_id'] = ext.get('imdb_id')
        result['seasons'] = [
            {
                'season_number': s['season_number'],
                'name': s['name'],
                'episode_count': s['episode_count'],
                'poster': poster_url(s.get('poster_path')),
            }
            for s in data.get('seasons', [])
            if s.get('season_number', 0) > 0
        ]
        result['genres'] = [g['name'] for g in data.get('genres', [])]

    return result


def cmd_season(tmdb_id, season_number):
    data = tmdb_get(f'/tv/{tmdb_id}/season/{season_number}')
    episodes = []
    for ep in data.get('episodes', []):
        episodes.append({
            'episode_number': ep['episode_number'],
            'name': ep.get('name', ''),
            'overview': ep.get('overview', ''),
            'still': poster_url(ep.get('still_path'), 'w300'),
            'air_date': ep.get('air_date', ''),
        })
    return {'season_number': season_number, 'episodes': episodes}


def cmd_search(query):
    params = {'query': query, 'page': 1}
    data = tmdb_get('/search/multi', params)
    results = []
    for item in data.get('results', []):
        media_type = item.get('media_type', '')
        if media_type not in ('movie', 'tv'):
            continue
        results.append(format_item(item, media_type))
    return results


def main():
    if not TMDB_KEY:
        print(json.dumps({'error': 'TMDB_API_KEY not set'}))
        sys.exit(1)

    args = sys.argv[1:]
    if not args:
        print(json.dumps({'error': 'No command'}))
        sys.exit(1)

    cmd = args[0]
    try:
        if cmd == 'lists':
            result = cmd_lists()
        elif cmd == 'detail' and len(args) >= 3:
            result = cmd_detail(args[1], args[2])
        elif cmd == 'season' and len(args) >= 3:
            result = cmd_season(args[1], args[2])
        elif cmd == 'search' and len(args) >= 2:
            result = cmd_search(args[1])
        elif cmd == 'load_more' and len(args) >= 4:
            result = cmd_load_more(args[1], args[2], args[3])
        else:
            print(json.dumps({'error': f'Unknown command: {cmd}'}))
            sys.exit(1)

        print(json.dumps(result))

    except TMDBError as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
