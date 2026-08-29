# SugarCube fixture provenance

- SugarCube version: 2.37.3
- Official release: `sugarcube-2.37.3-for-twine-2.1-local.zip`
- Release URL: https://github.com/tmedwards/sugarcube-2/releases/download/v2.37.3/sugarcube-2.37.3-for-twine-2.1-local.zip
- Release SHA-256: `da00a8c15ec4e88a9e231a3ff6c516c57055f84231bb999f869ed34ade353dab`
- License: BSD-2-Clause; copied in `SUGARCUBE_LICENSE.txt`

Rebuild the published fixture with:

```bash
node build-fixture.mjs /path/to/sugarcube-2/format.js
```

`fixture.twee` is authored for this repository. `fixture-current.html` embeds the upstream SugarCube runtime generated from the pinned official format.
