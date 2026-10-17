#!/usr/bin/env python3
"""Collect active tropical-cyclone data and local warnings for SkyPulse.

Runs on GitHub Actions (stdlib only) and writes one JSON file that the site
reads from its own origin, because most agency feeds do not send CORS headers.

Sources
  NHC   NOAA National Hurricane Center   Atlantic, East & Central Pacific (official RSMC)
  JMA   Japan Meteorological Agency      Western North Pacific (official RSMC Tokyo)
  JTWC  Joint Typhoon Warning Center     all basins except the Atlantic
  IMD   India Meteorological Department  North Indian Ocean cone and wind areas (RSMC New Delhi)
  GDACS Global Disaster Alert and Coordination System   alert level, surge and rain maps
  SACHET NDMA CAP feed (IMD + state disaster agencies)  local warnings in India

Usage: python pipeline/fetch_tropical.py --out LiveWeather/data/tropical.json
"""
from __future__ import annotations

import argparse
import html
import io
import json
import math
import os
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

UA = 'Mozilla/5.0 (compatible; SkyPulse-weather/1.0; +https://kauswai.github.io/Live-Weather/)'
UTC = timezone.utc
NOW = datetime.now(UTC)
STATUS: dict[str, dict] = {}


# ----------------------------------------------------------------- helpers
def fetch(url: str, timeout: int = 30, tries: int = 2) -> bytes:
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': '*/*'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - any network failure is retried, then reported
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f'{url}: {last}')


def text(url: str, **kw) -> str:
    return fetch(url, **kw).decode('utf-8', errors='replace')


def pre_text(url: str) -> str:
    """NHC text products are served as HTML with the bulletin inside <pre>."""
    s = text(url)
    m = re.search(r'<pre>(.*?)</pre>', s, re.S | re.I)
    body = m.group(1) if m else s
    return html.unescape(re.sub(r'<[^>]+>', '', body))


def iso(dt: datetime | None) -> str | None:
    return dt.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%SZ') if dt else None


def haversine_km(a_lat, a_lon, b_lat, b_lon) -> float:
    r = math.radians
    dlat, dlon = r(b_lat - a_lat), r(b_lon - a_lon)
    h = math.sin(dlat / 2) ** 2 + math.cos(r(a_lat)) * math.cos(r(b_lat)) * math.sin(dlon / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def latlon(lat: str, ns: str, lon: str, ew: str, tenths: bool = False) -> tuple[float, float]:
    la, lo = float(lat), float(lon)
    if tenths:
        la, lo = la / 10, lo / 10
    return (-la if ns == 'S' else la, -lo if ew == 'W' else lo)


def run(name: str, fn, *args):
    """Run one source; a failure is recorded in STATUS instead of aborting the whole job."""
    t0 = time.time()
    try:
        out = fn(*args)
        STATUS[name] = {'ok': True, 'count': len(out) if hasattr(out, '__len__') else None, 'seconds': round(time.time() - t0, 1)}
        return out
    except Exception as e:  # noqa: BLE001
        STATUS[name] = {'ok': False, 'error': str(e)[:300], 'seconds': round(time.time() - t0, 1)}
        print(f'[{name}] FAILED: {e}', file=sys.stderr)
        return [] if name != 'IMD' else {}


QUADS = ('ne', 'se', 'sw', 'nw')


def radii_dict(found) -> dict:
    """[(kt, ne, se, sw, nw), ...] -> {'34': [ne, se, sw, nw], ...} in nautical miles."""
    out = {}
    for kt, *r in found:
        vals = [int(x) for x in r]
        if any(vals):
            out[str(int(kt))] = vals
    return out


# -------------------------------------------------------------------- JTWC
BASIN_FROM_JTWC = {'W': 'WP', 'A': 'IO', 'B': 'IO', 'S': 'SH', 'P': 'SH', 'E': 'EP', 'C': 'CP', 'L': 'AL'}


def parse_tcw(raw: str, file_id: str) -> dict | None:
    lines = raw.splitlines()
    head = next((l for l in lines if re.match(r'^\d{10}\s+\w+\s', l)), None)
    if not head:
        return None
    m = re.match(r'^(\d{10})\s+(\w+)\s+(\S+)\s+(\d+)\s+\d+\s+(\d+)\s+(\d+)', head)
    if not m:
        return None
    dtg, sid, name, warn_no, mdir, mspd = m.groups()
    t0 = datetime.strptime(dtg, '%Y%m%d%H').replace(tzinfo=UTC)

    body = raw.split('AMP', 1)[1] if 'AMP' in raw else raw
    gusts = [(int(a), int(b)) for a, b in re.findall(r'MAX SUSTAINED WINDS - (\d+) KT, GUSTS (\d+) KT', body)]
    points = []
    for l in lines:
        t = re.match(r'^T(\d{3})\s+(\d+)([NS])\s+(\d+)([EW])\s+(\d+)(.*)$', l.strip())
        if not t:
            continue
        tau, la, ns, lo, ew, vmax, rest = t.groups()
        lat, lon = latlon(la, ns, lo, ew, tenths=True)
        rad = radii_dict(re.findall(r'R(\d{3})\s+(\d{3}) NE QD\s+(\d{3}) SE QD\s+(\d{3}) SW QD\s+(\d{3}) NW QD', rest))
        points.append({'time': iso(t0 + timedelta(hours=int(tau))), 'tau': int(tau), 'lat': lat, 'lon': lon,
                       'vmaxKt': int(vmax), 'radii': rad})
    for i, p in enumerate(points):
        if i < len(gusts) and gusts[i][0] == p['vmaxKt']:
            p['gustKt'] = gusts[i][1]
    if not points:
        return None

    past, seen = [], set()
    tail = raw.split('//', 1)[1] if '//' in raw else ''
    for l in tail.splitlines():
        p = re.match(r'^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s+(\d+)([NS])\s*(\d+)([EW])\s+(\d+)', l.strip())
        if not p:
            continue
        _, yy, mm, dd, hh, la, ns, lo, ew, v = p.groups()
        when = datetime(2000 + int(yy), int(mm), int(dd), int(hh), tzinfo=UTC)
        if when in seen:
            continue
        seen.add(when)
        lat, lon = latlon(la, ns, lo, ew, tenths=True)
        past.append({'time': iso(when), 'lat': lat, 'lon': lon, 'vmaxKt': int(v)})

    cls = re.search(r'1\.\s+([A-Z \-]+?)\s+\d{2}[A-Z]\s+\(', body)
    pres = re.search(r'MINIMUM CENTRAL PRESSURE AT \d+Z IS (\d+) MB', body)
    wave = re.search(r'MAXIMUM SIGNIFICANT WAVE HEIGHT AT \d+Z IS (\d+) FEET', body)
    remark = re.search(r'REMARKS:\s*(.*?)(?:MINIMUM CENTRAL PRESSURE|//)', body, re.S)
    summary = ''
    if remark:
        summary = re.sub(r'\s+', ' ', remark.group(1)).strip()
        summary = re.sub(r'^\d{6}Z POSITION NEAR [\d.]+[NS] [\d.]+[EW]\.\s*\d{2}[A-Z]{3}\d{2}\.\s*', '', summary)
    cur = points[0]
    letter = sid[-1]
    return {
        'source': 'JTWC', 'id': sid, 'fileId': file_id, 'name': name.title() if name not in ('INVEST', 'ONE') else name.title(),
        'basin': BASIN_FROM_JTWC.get(letter, '??'), 'subBasin': letter,
        'classText': cls.group(1).strip().title() if cls else None,
        'time': cur['time'], 'lat': cur['lat'], 'lon': cur['lon'], 'vmaxKt': cur['vmaxKt'], 'gustKt': cur.get('gustKt'),
        'pressure': int(pres.group(1)) if pres else None, 'moveDir': int(mdir), 'moveKt': int(mspd),
        'radii': cur['radii'], 'maxWaveFt': int(wave.group(1)) if wave else None,
        'windAvg': '1-min', 'advisory': int(warn_no), 'summary': summary[:600],
        'forecast': points[1:], 'past': past,
        'links': [{'label': 'JTWC warning text', 'url': f'https://www.metoc.navy.mil/jtwc/products/{file_id}web.txt'},
                  {'label': 'JTWC warning graphic', 'url': f'https://www.metoc.navy.mil/jtwc/products/{file_id}.gif'}],
    }


def jtwc() -> list[dict]:
    rss = text('https://www.metoc.navy.mil/jtwc/rss/jtwc.rss')
    ids = sorted(set(re.findall(r'products/([a-z]{2}\d{4})\.tcw', rss)))
    out = []
    for fid in ids:
        try:
            s = parse_tcw(text(f'https://www.metoc.navy.mil/jtwc/products/{fid}.tcw'), fid)
            if s:
                out.append(s)
        except Exception as e:  # noqa: BLE001
            print(f'[JTWC] {fid}: {e}', file=sys.stderr)
    return out


# --------------------------------------------------------------------- NHC
NHC_CLASS = {'HU': 'Hurricane', 'TS': 'Tropical Storm', 'TD': 'Tropical Depression', 'STS': 'Subtropical Storm',
             'STD': 'Subtropical Depression', 'PTC': 'Post-Tropical Cyclone', 'PC': 'Potential Tropical Cyclone',
             'TY': 'Typhoon'}
MONTHS = {m: i + 1 for i, m in enumerate('JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split())}


def nhc_day_time(issued: datetime, ddhhmm: tuple[str, str]) -> datetime:
    day, hhmm = int(ddhhmm[0]), ddhhmm[1]
    year, month = issued.year, issued.month
    if day < issued.day - 15:  # forecast crosses into next month
        month += 1
        if month == 13:
            year, month = year + 1, 1
    return datetime(year, month, day, int(hhmm[:2]), int(hhmm[2:]), tzinfo=UTC)


RAD_RE = re.compile(r'^\s*(\d{2}) KT\.+\s*(\d+)NE\s+(\d+)SE\s+(\d+)SW\s+(\d+)NW', re.M)
SEAS_RE = re.compile(r'^\s*(\d+) (FT|M) SEAS\.+\s*(\d+)NE\s+(\d+)SE\s+(\d+)SW\s+(\d+)NW', re.M)


def parse_tcm(t: str) -> dict:
    iss = re.search(r'(\d{3,4}) UTC \w{3} (\w{3}) (\d{1,2}) (\d{4})', t)
    issued = datetime(int(iss.group(4)), MONTHS[iss.group(2)], int(iss.group(3)),
                      int(iss.group(1).zfill(4)[:2]), int(iss.group(1).zfill(4)[2:]), tzinfo=UTC)
    title = re.search(r'^\s*(.+?) FORECAST/ADVISORY NUMBER', t, re.M)
    c = re.search(r'CENTER LOCATED NEAR\s+([\d.]+)([NS])\s+([\d.]+)([EW]) AT (\d{2})/(\d{4})Z', t)
    blocks = re.split(r'\n(?=\s*(?:FORECAST|OUTLOOK) VALID)', t)[1:]
    cur_part = t.split('REPEAT...')[0]
    mv = re.search(r'PRESENT MOVEMENT TOWARD THE .*? OR (\d+) DEGREES AT\s+(\d+) KT', t)
    wind = re.search(r'MAX SUSTAINED WINDS\s+(\d+) KT WITH GUSTS TO\s+(\d+) KT', t)
    seas = SEAS_RE.search(cur_part)
    out = {
        'issued': iso(issued), 'title': title.group(1).strip().title() if title else None,
        'time': iso(nhc_day_time(issued, (c.group(5), c.group(6)))) if c else None,
        'lat': latlon(c.group(1), c.group(2), c.group(3), c.group(4))[0] if c else None,
        'lon': latlon(c.group(1), c.group(2), c.group(3), c.group(4))[1] if c else None,
        'moveDir': int(mv.group(1)) if mv else None, 'moveKt': int(mv.group(2)) if mv else (0 if 'STATIONARY' in t else None),
        'pressure': int(m.group(1)) if (m := re.search(r'MINIMUM CENTRAL PRESSURE\s+(\d+) MB', t)) else None,
        'eyeNm': int(m.group(1)) if (m := re.search(r'EYE DIAMETER\s+(\d+) NM', t)) else None,
        'vmaxKt': int(wind.group(1)) if wind else None, 'gustKt': int(wind.group(2)) if wind else None,
        'radii': radii_dict(RAD_RE.findall(cur_part)),
        'seas': {'height': int(seas.group(1)), 'unit': seas.group(2).lower(), 'radiiNm': [int(x) for x in seas.groups()[2:]]} if seas else None,
        'forecast': [],
    }
    for b in blocks:
        h = re.match(r'\s*(FORECAST|OUTLOOK) VALID (\d{2})/(\d{4})Z\s+([\d.]+)([NS])\s+([\d.]+)([EW])(?:\.\.\.(\S[^\n]*))?', b)
        if not h:
            continue
        lat, lon = latlon(h.group(4), h.group(5), h.group(6), h.group(7))
        w = re.search(r'MAX WIND\s+(\d+) KT\.\.\.GUSTS\s+(\d+) KT', b)
        when = nhc_day_time(issued, (h.group(2), h.group(3)))
        out['forecast'].append({
            'time': iso(when), 'tau': round((when - issued).total_seconds() / 3600), 'lat': lat, 'lon': lon,
            'vmaxKt': int(w.group(1)) if w else None, 'gustKt': int(w.group(2)) if w else None,
            'radii': radii_dict(RAD_RE.findall(b)), 'note': (h.group(8) or '').strip(' .').title() or None,
        })
    return out


def tcp_sections(t: str) -> dict:
    def section(start, stops):
        m = re.search(re.escape(start) + r'\s*-*\s*(.*?)(?=' + '|'.join(re.escape(s) for s in stops) + r'|\$\$)', t, re.S)
        return re.sub(r'[ \t]+\n', '\n', m.group(1)).strip() if m else None

    headline = re.search(r'\n\s*\n(\.\.\..*?\.\.\.)\s*\n\s*\n', t, re.S)
    ww = section('SUMMARY OF WATCHES AND WARNINGS IN EFFECT:', ['DISCUSSION AND OUTLOOK'])
    if ww is None:
        ww = section('WATCHES AND WARNINGS', ['DISCUSSION AND OUTLOOK'])
    return {
        'headline': re.sub(r'\s+', ' ', headline.group(1)).strip('. ').replace('... ...', ' · ').replace('...', ' · ') if headline else None,
        'watchesWarnings': ww,
        'hazards': section('HAZARDS AFFECTING LAND', ['NEXT ADVISORY', 'NEXT COMPLETE ADVISORY']),
        'location': section('SUMMARY OF', ['WATCHES AND WARNINGS']),
    }


def kmz_polygon(url: str) -> list | None:
    """First polygon ring of an NHC KMZ (the forecast cone), as [[lat, lon], ...]."""
    z = zipfile.ZipFile(io.BytesIO(fetch(url)))
    kml = next(n for n in z.namelist() if n.endswith('.kml'))
    root = ET.fromstring(z.read(kml))
    for el in root.iter():
        if el.tag.endswith('coordinates') and el.text:
            pts = []
            for tok in el.text.split():
                lon, lat, *_ = tok.split(',')
                pts.append([round(float(lat), 3), round(float(lon), 3)])
            if len(pts) > 3:
                return decimate(pts, 400)
    return None


def best_track_kmz(url: str) -> list[dict]:
    z = zipfile.ZipFile(io.BytesIO(fetch(url)))
    kml = z.read(next(n for n in z.namelist() if n.endswith('.kml'))).decode('utf-8', 'replace')
    out, seen = [], set()
    for pm in re.findall(r'<Placemark>(.*?)</Placemark>', kml, re.S):
        g = lambda tag: (m.group(1).strip() if (m := re.search(rf'<{tag}>(.*?)</{tag}>', pm, re.S)) else None)  # noqa: E731
        dtg, lat, lon = g('atcfdtg'), g('lat'), g('lon')
        if not (dtg and lat and lon) or dtg in seen:
            continue
        seen.add(dtg)
        p = g('minSeaLevelPres')
        out.append({'time': iso(datetime.strptime(dtg, '%Y%m%d%H').replace(tzinfo=UTC)), 'lat': float(lat), 'lon': float(lon),
                    'vmaxKt': int(g('intensity') or 0), 'pressure': int(p) if p and p.isdigit() and int(p) > 0 else None,
                    'type': g('stormType')})
    return sorted(out, key=lambda p: p['time'])


def best_track(storm_id: str) -> list[dict]:
    raw = text(f'https://ftp.nhc.noaa.gov/atcf/btk/b{storm_id}.dat', timeout=20, tries=1)
    out, seen = [], set()
    for line in raw.splitlines():
        f = [x.strip() for x in line.split(',')]
        if len(f) < 9 or f[4] != 'BEST':
            continue
        when = datetime.strptime(f[2], '%Y%m%d%H').replace(tzinfo=UTC)
        if when in seen:
            continue
        seen.add(when)
        la, lo = f[6], f[7]
        lat, lon = latlon(la[:-1], la[-1], lo[:-1], lo[-1], tenths=True)
        out.append({'time': iso(when), 'lat': lat, 'lon': lon, 'vmaxKt': int(f[8] or 0), 'pressure': int(f[9]) if f[9].isdigit() else None})
    return out


def nhc() -> list[dict]:
    d = json.loads(fetch('https://www.nhc.noaa.gov/CurrentStorms.json'))
    out = []
    for s in d.get('activeStorms', []):
        sid = s['id']
        rec = {
            'source': 'NHC', 'id': sid, 'name': s['name'], 'basin': sid[:2].upper(),
            'classCode': s.get('classification'), 'classText': NHC_CLASS.get(s.get('classification'), s.get('classification')),
            'time': s.get('lastUpdate'), 'lat': s.get('latitudeNumeric'), 'lon': s.get('longitudeNumeric'),
            'vmaxKt': int(s['intensity']) if str(s.get('intensity', '')).isdigit() else None,
            'pressure': int(s['pressure']) if str(s.get('pressure', '')).isdigit() else None,
            'moveDir': s.get('movementDir'), 'moveKt': s.get('movementSpeed'), 'windAvg': '1-min',
            'links': [{'label': 'NHC graphics & key messages', 'url': (s.get('forecastGraphics') or {}).get('url')},
                      {'label': 'Public advisory', 'url': (s.get('publicAdvisory') or {}).get('url')},
                      {'label': 'Forecast discussion', 'url': (s.get('forecastDiscussion') or {}).get('url')}],
        }
        try:
            tcm = parse_tcm(pre_text(s['forecastAdvisory']['url']))
            for k in ('radii', 'seas', 'eyeNm', 'forecast', 'gustKt'):
                rec[k] = tcm.get(k)
            rec['advisoryIssued'] = tcm.get('issued')
            if tcm.get('title'):
                rec['title'] = tcm['title']
        except Exception as e:  # noqa: BLE001
            print(f'[NHC] TCM {sid}: {e}', file=sys.stderr)
        try:
            rec.update({k: v for k, v in tcp_sections(pre_text(s['publicAdvisory']['url'])).items() if v})
        except Exception as e:  # noqa: BLE001
            print(f'[NHC] TCP {sid}: {e}', file=sys.stderr)
        try:
            if (s.get('trackCone') or {}).get('kmzFile'):
                rec['cone'] = kmz_polygon(s['trackCone']['kmzFile'])
        except Exception as e:  # noqa: BLE001
            print(f'[NHC] cone {sid}: {e}', file=sys.stderr)
        try:
            rec['past'] = best_track_kmz(s['bestTrackGIS']['kmzFile'])
        except Exception as e:  # noqa: BLE001
            print(f'[NHC] best track KMZ {sid}: {e}', file=sys.stderr)
            try:
                rec['past'] = best_track(sid)
            except Exception as e2:  # noqa: BLE001
                print(f'[NHC] best track {sid}: {e2}', file=sys.stderr)
        out.append(rec)
    return out


# --------------------------------------------------------------------- JMA
JP_DIR = {'北': 'N', '北北東': 'NNE', '北東': 'NE', '東北東': 'ENE', '東': 'E', '東南東': 'ESE', '南東': 'SE', '南南東': 'SSE',
          '南': 'S', '南南西': 'SSW', '南西': 'SW', '西南西': 'WSW', '西': 'W', '西北西': 'WNW', '北西': 'NW', '北北西': 'NNW'}
DIR_DEG = {d: i * 22.5 for i, d in enumerate(['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'])}
JP_INTENSITY = {'強い': 'Strong', '非常に強い': 'Very strong', '猛烈な': 'Violent'}
JP_SCALE = {'大型': 'Large', '超大型': 'Very large'}
JMA_CAT = {'TD': 'Tropical Depression', 'TS': 'Tropical Storm', 'STS': 'Severe Tropical Storm', 'TY': 'Typhoon', 'LOW': 'Extratropical Low'}


def jma_part(p: dict) -> dict:
    mw = p.get('maximumWind') or {}
    num = lambda v: int(v) if str(v).isdigit() else None  # noqa: E731
    course = p.get('course')
    out = {
        'time': (p.get('validtime') or {}).get('UTC'), 'tau': p.get('advancedHours'),
        'lat': (p.get('position') or {}).get('deg', [None, None])[0], 'lon': (p.get('position') or {}).get('deg', [None, None])[1],
        'pressure': num(p.get('pressure')), 'vmaxKt': num((mw.get('sustained') or {}).get('kt')), 'gustKt': num((mw.get('gust') or {}).get('kt')),
        'category': (p.get('category') or {}).get('en'),
        'intensity': JP_INTENSITY.get(p.get('intensity')), 'scale': JP_SCALE.get(p.get('scale')),
        'moveDir': DIR_DEG.get(JP_DIR.get(course)) if course else None,
        'moveText': JP_DIR.get(course, 'Almost stationary' if course and '停滞' in course else None),
        'moveKt': num((p.get('speed') or {}).get('kt')),
        'probRadiusNm': (p.get('probabilityCircleRadius') or {}).get('nm'),
        'gale': [{'dir': JP_DIR.get(g.get('area'), 'All' if g.get('area') == '全域' else g.get('area')), 'nm': (g.get('range') or {}).get('nm')} for g in p.get('galeWarning') or []],
        'storm': [{'dir': ((g.get('area') or {}).get('en') if isinstance(g.get('area'), dict) else JP_DIR.get(g.get('area'))), 'nm': (g.get('range') or {}).get('nm')} for g in p.get('stormWarning') or []],
    }
    return out


def jma() -> list[dict]:
    base = 'https://www.jma.go.jp/bosai/typhoon/data/'
    out = []
    for tc in json.loads(fetch(base + 'targetTc.json')):
        code = tc['tropicalCyclone']
        spec = json.loads(fetch(f'{base}{code}/specifications.json'))
        fc = json.loads(fetch(f'{base}{code}/forecast.json'))
        title = next((p for p in spec if p.get('part') == 'title'), {})
        parts = [jma_part(p) for p in spec if isinstance(p.get('part'), dict)]
        if not parts:
            continue
        a = parts[0]
        track = next((p.get('track') for p in fc if isinstance(p.get('part'), dict) and p.get('track')), {}) or {}
        name = (title.get('name') or {}).get('en') or f"TD {tc.get('typhoonNumber') or code}"
        cat = a.get('category') or tc.get('category')
        out.append({
            'source': 'JMA', 'id': code, 'typhoonNumber': title.get('typhoonNumber'), 'name': name, 'basin': 'WP',
            'classCode': cat, 'classText': ' '.join(x for x in [a.get('intensity'), JMA_CAT.get(cat, cat)] if x),
            'scale': a.get('scale'), 'issued': (title.get('issue') or {}).get('UTC'),
            **{k: a[k] for k in ('time', 'lat', 'lon', 'pressure', 'vmaxKt', 'gustKt', 'moveDir', 'moveText', 'moveKt', 'gale', 'storm')},
            'windAvg': '10-min',
            'forecast': parts[1:],
            'pastPath': [[round(la, 2), round(lo, 2)] for la, lo in (track.get('preTyphoon') or []) + (track.get('typhoon') or [])],
            'links': [{'label': 'JMA typhoon information', 'url': 'https://www.jma.go.jp/bosai/map.html#contents=typhoon&lang=en'}],
        })
    return out


# --------------------------------------------------------------------- IMD
def decimate(pts: list, limit: int) -> list:
    if len(pts) <= limit:
        return pts
    step = math.ceil(len(pts) / limit)
    return pts[::step] + [pts[-1]]


def geom_rings(g) -> list:
    """GeoJSON geometry/feature/collection -> list of rings [[lat, lon], ...] (outer rings only)."""
    if not g:
        return []
    t = g.get('type')
    if t == 'FeatureCollection':
        return [r for f in g.get('features', []) for r in geom_rings(f)]
    if t == 'Feature':
        return geom_rings(g.get('geometry'))
    if t == 'Polygon':
        polys = [g['coordinates']]
    elif t == 'MultiPolygon':
        polys = g['coordinates']
    else:
        return []
    return [decimate([[round(c[1], 3), round(c[0], 3)] for c in poly[0]], 300) for poly in polys if poly and poly[0]]


def imd() -> dict:
    # dss.imd.gov.in serves only its leaf certificate (no emSign intermediate), so stock CA bundles on
    # CI runners can't verify it; the same public files are also served over plain HTTP.
    base = 'https://dss.imd.gov.in/dwr_img/GIS/'
    try:
        fetch(base + 'tout.geojson', timeout=20, tries=1)
    except RuntimeError as e:
        if 'CERTIFICATE' not in str(e).upper():
            raise
        base = 'http://dss.imd.gov.in/dwr_img/GIS/'
    out = {}
    for key, f in (('cone', 'tout'), ('r28', 'tout27'), ('r34', 'tout34'), ('r50', 'tout50'), ('r64', 'tout64')):
        raw = fetch(base + f + '.geojson', timeout=20).strip()
        if raw:
            try:
                rings = geom_rings(json.loads(raw))
                if rings:
                    out[key] = rings
            except json.JSONDecodeError:
                pass
    return out


# ------------------------------------------------------------------- GDACS
def gdacs() -> list[dict]:
    d = json.loads(fetch('https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC'))
    out = []
    for f in d.get('features', []):
        p = f.get('properties', {})
        if str(p.get('iscurrent')).lower() != 'true' or p.get('eventtype') != 'TC':
            continue
        rec = {'eventId': p.get('eventid'), 'episodeId': p.get('episodeid'), 'name': p.get('eventname'),
               'alertLevel': p.get('alertlevel'), 'severity': (p.get('severitydata') or {}).get('severitytext'),
               'countries': [c.get('countryname') for c in p.get('affectedcountries') or []],
               'source': p.get('source'), 'lat': (f.get('geometry') or {}).get('coordinates', [None, None])[1],
               'lon': (f.get('geometry') or {}).get('coordinates', [None, None])[0],
               'report': (p.get('url') or {}).get('report')}
        try:
            det = json.loads(fetch((p.get('url') or {}).get('details'), timeout=25))
            img = det.get('images') or {}
            rec['images'] = {k: img[k] for k in ('rainmap', 'overviewmap', 'storm_surge_maxheight_end_ECMWF', 'storm_surge_maxheight_end_GFS') if img.get(k)}
        except Exception as e:  # noqa: BLE001
            print(f'[GDACS] {rec["name"]}: {e}', file=sys.stderr)
        out.append(rec)
    return out


# ------------------------------------------------------------------ SACHET
CAP = '{urn:oasis:names:tc:emergency:cap:1.2}'


def cap_alert(url: str) -> dict | None:
    root = ET.fromstring(fetch(url, timeout=20, tries=1))
    if (root.findtext(f'{CAP}msgType') or '') == 'Cancel' or (root.findtext(f'{CAP}status') or '') != 'Actual':
        return None
    infos = root.findall(f'{CAP}info')
    if not infos:
        return None
    info = next((i for i in infos if (i.findtext(f'{CAP}language') or '').lower().startswith('en')), infos[0])
    g = lambda k: (info.findtext(f'{CAP}{k}') or '').strip()  # noqa: E731
    expires = g('expires')
    try:
        if expires and datetime.fromisoformat(expires) < NOW:
            return None
    except ValueError:
        pass
    area = info.find(f'{CAP}area')
    return {
        'id': root.findtext(f'{CAP}identifier'), 'sender': root.findtext(f'{CAP}sender'), 'sent': root.findtext(f'{CAP}sent'),
        'event': g('event'), 'severity': g('severity'), 'urgency': g('urgency'), 'certainty': g('certainty'),
        'onset': g('onset') or g('effective'), 'expires': expires, 'headline': re.sub(r'\s+', ' ', g('headline'))[:400],
        'description': re.sub(r'\s+', ' ', g('description'))[:500], 'instruction': re.sub(r'\s+', ' ', g('instruction'))[:300],
        'area': (area.findtext(f'{CAP}areaDesc') if area is not None else '') or '', 'lang': g('language'),
    }


def sachet() -> list[dict]:
    rss = text('https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml')
    items = re.findall(r'<item>(.*?)</item>', rss, re.S)
    jobs = []
    for it in items:
        link = re.search(r'<link>(.*?)</link>', it, re.S)
        author = re.search(r'<author>.*?\((.*?)\)</author>', it, re.S)
        if link:
            jobs.append((html.unescape(link.group(1).strip()), author.group(1).strip() if author else None))

    def one(job):
        try:
            a = cap_alert(job[0])
            if a:
                a['issuer'] = job[1]
                a['link'] = job[0]
            return a
        except Exception:  # noqa: BLE001
            return None

    with ThreadPoolExecutor(max_workers=8) as ex:
        alerts = [a for a in ex.map(one, jobs) if a]
    # one entry per alert chain (updates reuse the numeric part of the identifier)
    seen, out = set(), []
    for a in alerts:
        key = re.sub(r'_\d+$', '', a['id'] or '')
        if key in seen:
            continue
        seen.add(key)
        out.append(a)
    return out


# ------------------------------------------------------------------- merge
BASIN_NAMES = {'AL': 'North Atlantic', 'EP': 'Eastern North Pacific', 'CP': 'Central North Pacific', 'WP': 'Western North Pacific',
               'IO': 'North Indian Ocean', 'SH': 'Southern Hemisphere'}
OFFICIAL = {
    'AL': ('NHC', 'NOAA National Hurricane Center (RSMC Miami)', 'https://www.nhc.noaa.gov/'),
    'EP': ('NHC', 'NOAA National Hurricane Center (RSMC Miami)', 'https://www.nhc.noaa.gov/'),
    'CP': ('CPHC', 'Central Pacific Hurricane Center (RSMC Honolulu)', 'https://www.nhc.noaa.gov/?cpac'),
    'WP': ('JMA', 'Japan Meteorological Agency (RSMC Tokyo)', 'https://www.jma.go.jp/bosai/map.html#contents=typhoon&lang=en'),
    'IO': ('IMD', 'India Meteorological Department (RSMC New Delhi)', 'https://rsmcnewdelhi.imd.gov.in/'),
}


def sh_official(lon: float) -> tuple:
    if 30 <= lon < 90:
        return ('MFR', 'Météo-France La Réunion (RSMC)', 'https://meteofrance.re/fr/cyclone')
    if 90 <= lon < 160:
        return ('BOM', 'Bureau of Meteorology (TCWC Perth/Darwin/Brisbane)', 'https://www.bom.gov.au/cyclone/')
    return ('FMS', 'Fiji Meteorological Service (RSMC Nadi)', 'https://www.met.gov.fj/')


def same_storm(a: dict, b: dict) -> bool:
    if None in (a.get('lat'), b.get('lat')):
        return False
    return haversine_km(a['lat'], a['lon'], b['lat'], b['lon']) < 350


def merge(nhc_s, jma_s, jtwc_s, imd_g, gdacs_s) -> list[dict]:
    storms = []
    for s in nhc_s + jma_s:
        storms.append({**s, 'alt': []})
    for j in jtwc_s:
        host = next((s for s in storms if same_storm(s, j)), None)
        if host:
            host['alt'].append(j)
            if not host.get('past') and j.get('past'):
                host['past'] = j['past']
            if host.get('maxWaveFt') is None and j.get('maxWaveFt'):
                host['maxWaveFt'] = j['maxWaveFt']
            if not host.get('radii') and j.get('radii'):
                host['radiiFrom'] = 'JTWC'
                host['radii'] = j['radii']
        else:
            storms.append({**j, 'alt': []})
    for s in storms:
        b = s['basin']
        code, name, url = OFFICIAL.get(b) or sh_official(s.get('lon') or 0)
        s['basinName'] = BASIN_NAMES.get(b, b) + ({'A': ' (Arabian Sea)', 'B': ' (Bay of Bengal)', 'S': ' (South Indian Ocean)', 'P': ' (South Pacific)'}.get(s.get('subBasin'), ''))
        s['official'] = {'code': code, 'name': name, 'url': url, 'dataFrom': s['source']}
        s['key'] = f"{b}-{(s.get('name') or s['id']).upper()}"
        if b == 'IO' and imd_g:
            s['imd'] = imd_g
        g = next((g for g in gdacs_s if (g.get('name') or '').split('-')[0].upper() == (s.get('name') or '').upper()
                  or (g.get('lat') is not None and s.get('lat') is not None and haversine_km(g['lat'], g['lon'], s['lat'], s['lon']) < 300)), None)
        if g:
            s['gdacs'] = g
    return storms


# -------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='LiveWeather/data/tropical.json')
    args = ap.parse_args()

    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {name: ex.submit(run, name, fn) for name, fn in
                (('NHC', nhc), ('JMA', jma), ('JTWC', jtwc), ('IMD', imd), ('GDACS', gdacs), ('SACHET', sachet))}
        res = {k: f.result() for k, f in futs.items()}

    storms = merge(res['NHC'], res['JMA'], res['JTWC'], res['IMD'], res['GDACS'])
    doc = {
        'generated': iso(NOW), 'status': STATUS, 'storms': storms,
        'gdacs': res['GDACS'], 'india': {'source': 'NDMA SACHET (CAP)', 'alerts': res['SACHET']},
    }
    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
    print(f'wrote {args.out}: {len(storms)} storms, {len(res["SACHET"])} India alerts')
    for k, v in STATUS.items():
        print(f'  {k:7} {"ok " if v["ok"] else "ERR"} {v}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
