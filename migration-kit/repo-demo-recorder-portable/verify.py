#!/usr/bin/env python3
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'SHA256.json').read_text())
for name, expected in manifest.items():
    file = root / name
    if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != expected:
        raise SystemExit('FAIL: ' + name)
print(f'PASS: {len(manifest)} files verified')
