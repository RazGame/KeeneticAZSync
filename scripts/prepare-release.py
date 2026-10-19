#!/usr/bin/env python3
"""Prepare a public source archive from an explicit allowlist (Python 3.9+)."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = (
    '.gitignore', '.gitattributes', '.env.example', 'README.md', 'CHANGELOG.md',
    'SECURITY.md', 'SECURITY-AUDIT.md', 'docker-compose.yml',
    'docker-compose.override.sample.yml', 'node/package.json',
    'node/package-lock.json', 'node/Dockerfile', 'node/.dockerignore',
    'node/config.example.yaml', 'node/README.md',
)
TREES = {
    'node/bin': {'.js'}, 'node/src': {'.js'},
    'node/web': {'.js', '.cjs', '.html', '.css'}, 'node/test': {'.js'},
    'docs': {'.md', '.yaml'},
    'deploy': {'.yml', '.example', ''}, 'scripts': {'.py'},
    '.github/workflows': {'.yml'},
}


def public_files():
    result = {ROOT / name for name in FILES}
    for directory, extensions in TREES.items():
        for path in (ROOT / directory).rglob('*'):
            if path.is_file() and path.suffix in extensions and '.bak' not in path.name:
                result.add(path)
    # A license is included only if the owner explicitly adds one later.
    result.update(p for name in ['LICENSE', 'LICENSE.md'] if (p := ROOT / name).is_file())
    return sorted(result, key=lambda p: p.relative_to(ROOT).as_posix())


def check(paths):
    names = {p.relative_to(ROOT).as_posix() for p in paths}
    required = {'node/bin/awgsync.js', 'node/src/server.js', 'node/src/traffic.js',
                'node/src/router-traffic.js', 'node/web/index.html',
                'docs/local.md', 'docs/server.md', 'docs/antizapret.md',
                '.env.example', 'deploy/antizapret.env.example'}
    if not required <= names:
        raise ValueError('Required public source files are missing')
    for path in paths:
        name = path.relative_to(ROOT).as_posix()
        if not path.is_file() or path.is_symlink() or ROOT not in path.resolve().parents:
            raise ValueError('Missing file or unsafe link: ' + name)
        if any(p.is_symlink() for p in path.parents if p != ROOT and ROOT in p.parents):
            raise ValueError('Symlinked directory: ' + name)
        if path.name == 'config.yaml' or (path.name.startswith('.env') and path.name != '.env.example'):
            raise ValueError('Private configuration selected: ' + name)
        if any(part in {'node_modules', 'obj', '.git', '.codex-remote-attachments', 'config'} for part in path.relative_to(ROOT).parts):
            raise ValueError('Private/generated directory selected: ' + name)
        text = path.read_text(encoding='utf-8-sig')
        # Real multi-line PEM material or literal WireGuard private key assignments.
        if re.search(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]{80,}', text):
            raise ValueError('Possible private key material: ' + name)
        if re.search(r'(?m)^\s*PrivateKey\s*=\s*[A-Za-z0-9+/]{43}=', text):
            raise ValueError('Possible WireGuard private key: ' + name)
        if path.suffix == '.md':
            for link in re.findall(r'\]\(([^)]+)\)', text):
                target = link.split('#', 1)[0].strip('<>')
                if not target or re.match(r'^[a-z]+:', target, re.I):
                    continue
                resolved = (path.parent / unquote(target)).resolve()
                if not resolved.exists() or (resolved.is_file() and resolved not in paths):
                    raise ValueError('Broken or unpublished documentation link: ' + name + ' -> ' + target)
    # Return only public names; never display local credential contents.
    return names


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='validate without building an archive')
    args = parser.parse_args()
    paths = public_files()
    check(paths)
    version = json.loads((ROOT / 'node/package.json').read_text(encoding='utf-8'))['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?', version):
        raise ValueError('Invalid package version')
    if args.check:
        print('Public source check passed: %d files; local configs and generated files excluded.' % len(paths))
        return
    output = ROOT / 'dist'
    output.mkdir(exist_ok=True)
    if output.is_symlink():
        raise ValueError('Refusing symlinked dist directory')
    archive = output / ('awg-sync-%s-source.zip' % version)
    # Fixed timestamps/modes and sorted inputs make the archive reproducible.
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path in paths:
            name = path.relative_to(ROOT).as_posix()
            info = zipfile.ZipInfo('awg-sync/' + name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            mode = 0o100755 if name == 'node/bin/awgsync.js' else 0o100644
            info.external_attr = mode << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            data = path.read_bytes().replace(b'\r\n', b'\n')
            z.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    with archive.with_suffix('.zip.sha256').open('w', encoding='utf-8', newline='\n') as output_file:
        output_file.write(checksum + '  ' + archive.name + '\n')
    with (output / 'source-manifest.txt').open('w', encoding='utf-8', newline='\n') as output_file:
        output_file.write('\n'.join(p.relative_to(ROOT).as_posix() for p in paths) + '\n')
    print('Prepared: ' + str(archive))
    print('Files: %d; SHA256: %s' % (len(paths), checksum))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        print('Release preparation failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
