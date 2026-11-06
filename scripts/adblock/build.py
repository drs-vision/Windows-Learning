#!/usr/bin/env python3
"""Build content/adblock/hosts.txt from a clone of https://github.com/StevenBlack/hosts.

Only the source lists whose licenses allow reuse in CoinQuest are taken (MIT, CC BY, CC0). Lists marked
non-commercial (mvps.org, someonewhocares.org), share-alike (KADhosts) or without a license (yoyo.org) are left out.
Usage: python3 scripts/adblock/build.py /path/to/StevenBlack-hosts-clone
"""
import json, pathlib, re, subprocess, sys

SOURCES = {  # folder in data/ -> (name, license, link)
    'StevenBlack': ('Steven Black', 'MIT', 'https://github.com/StevenBlack/hosts'),
    'adaway.org': ('AdAway', 'CC BY 3.0', 'https://github.com/AdAway/adaway.github.io'),
    'add.2o7Net': ('FadeMind add.2o7Net', 'MIT', 'https://github.com/FadeMind/hosts.extras'),
    'UncheckyAds': ('FadeMind UncheckyAds', 'MIT', 'https://github.com/FadeMind/hosts.extras'),
    'tiuxo': ('tiuxo', 'CC BY 4.0', 'https://github.com/tiuxo/hosts'),
    'add.Risk': ('FadeMind add.Risk', 'MIT', 'https://github.com/FadeMind/hosts.extras'),
    'add.Spam': ('FadeMind add.Spam', 'MIT', 'https://github.com/FadeMind/hosts.extras'),
    'Badd-Boyz-Hosts': ('Badd Boyz Hosts', 'MIT', 'https://github.com/mitchellkrogza/Badd-Boyz-Hosts'),
}
LINE = re.compile(r'^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([a-z0-9._-]+)', re.I)
SKIP = {'localhost', 'localhost.localdomain', 'local', 'broadcasthost', '0.0.0.0', 'ip6-localhost', 'ip6-loopback'}

def main(clone):
    root = pathlib.Path(clone)
    commit = subprocess.run(['git', '-C', str(root), 'log', '-1', '--format=%H %cs'], capture_output=True, text=True).stdout.strip()
    hosts, counts = set(), {}
    for folder, (name, lic, _) in SOURCES.items():
        meta = json.loads((root / 'data' / folder / 'update.json').read_text(encoding='utf-8'))
        if (meta.get('license') or '').strip() != lic:
            sys.exit(f'{folder}: license is now {meta.get("license")!r}, expected {lic!r}; check it before using')
        got = {m.group(1).lower().rstrip('.') for m in map(LINE.match, (root / 'data' / folder / 'hosts').read_text(encoding='utf-8', errors='ignore').splitlines()) if m}
        got -= SKIP
        got = {h for h in got if '.' in h}
        counts[folder] = len(got)
        hosts |= got
    out = pathlib.Path(__file__).resolve().parents[2] / 'content' / 'adblock'
    out.mkdir(parents=True, exist_ok=True)
    head = [f'# CoinQuest ad and tracker hosts: {len(hosts)} hosts, built from StevenBlack/hosts {commit}.',
            '# Sources and licenses: see README.md in this folder. One host per line; a host also covers its subdomains.']
    (out / 'hosts.txt').write_text('\n'.join(head + sorted(hosts)) + '\n', encoding='utf-8', newline='\n')
    print(f'{len(hosts)} hosts from', ', '.join(f'{k} {v}' for k, v in counts.items()), '|', commit)

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '.')
