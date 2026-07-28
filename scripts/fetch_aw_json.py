"""
Runs inside GitHub Actions. Fetches the OLBS AMSS Chennai aerodrome
watch/warning page, parses the VOGA warning (same logic as
aerodrome_warning_monitor.py), and writes the result to
data/voga_warning.json in this repo. A workflow step then commits
and pushes that file — the dashboard reads it from raw.githubusercontent.com.
"""
import requests
from bs4 import BeautifulSoup
import re
import json
import os
from datetime import datetime, timezone
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

STATION = "VOGA"
URL = "https://olbs.amsschennai.gov.in/nsweb/FlightBriefing/showwatchwarn.php"
OUT_PATH = os.path.join("data", "voga_warning.json")


def fetch_html():
    resp = requests.get(URL, timeout=15, verify=False)
    resp.raise_for_status()
    return resp.text


def parse_warning_text(text):
    flat = re.sub(r'\s+', ' ', text).strip()
    header_match = re.search(r'WARNING\s+FOR\s+(\w+)\s*-\s*(\d{8})\s+(\d{2}:\d{2})', flat)
    if not header_match:
        return None

    station = header_match.group(1)
    issue_date = header_match.group(2)
    detail_line = re.sub(r'^[\s\-]+', '', flat[header_match.end():])
    if not detail_line:
        return None

    data = {'station': station, 'issue_date': issue_date}

    detail_pattern = r'(\w+)\s+(\d{6}Z?)\s+AD\s+WRNG\s+(\d+)\s+VALID\s+(\d{6})/(\d{6})'
    m = re.search(detail_pattern, detail_line)
    if not m:
        return None
    data['icao'] = m.group(1)
    data['issue_time_z'] = m.group(2)
    data['warning_number'] = m.group(3)
    data['valid_from'] = m.group(4)
    data['valid_to'] = m.group(5)

    valid_match = re.search(r'VALID\s+\d{6}/\d{6}\s+', detail_line)
    if valid_match:
        remaining = detail_line[valid_match.end():]
        obs_match = re.search(r'\s+(FCST|OBS)\s+', remaining, re.IGNORECASE)
        if obs_match:
            data['phenomenon'] = remaining[:obs_match.start()].strip()
            data['obs_type'] = obs_match.group(1).upper()
            data['changes'] = remaining[obs_match.end():].strip().rstrip('=')
        else:
            data['phenomenon'] = remaining.strip()
            data['obs_type'] = ''
            data['changes'] = ''
    else:
        data['phenomenon'] = detail_line
        data['obs_type'] = ''
        data['changes'] = ''

    if not data.get('phenomenon'):
        data['phenomenon'] = 'N/A'
    return data


def extract_station_warnings(html):
    soup = BeautifulSoup(html, 'html.parser')
    divs = soup.find_all('div', class_='adwarning')
    results = []
    for div in divs:
        text = div.get_text(separator='\n', strip=True)
        if STATION in text:
            data = parse_warning_text(text)
            if data:
                results.append(data)
    return results


def main():
    os.makedirs("data", exist_ok=True)
    generated_at = datetime.now(timezone.utc).isoformat()

    try:
        html = fetch_html()
        warnings = extract_station_warnings(html)
    except Exception as e:
        # Keep the last-known-good file untouched on a fetch/parse failure
        # rather than overwriting it with an error state.
        print(f"Fetch/parse failed: {e}")
        return

    if warnings:
        latest = max(warnings, key=lambda w: int(w.get('warning_number', 0) or 0))
        payload = {"generated_utc": generated_at, "has_warning": True, "warning": latest}
    else:
        payload = {"generated_utc": generated_at, "has_warning": False, "warning": None}

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"Wrote {OUT_PATH}: has_warning={payload['has_warning']}")


if __name__ == "__main__":
    main()
