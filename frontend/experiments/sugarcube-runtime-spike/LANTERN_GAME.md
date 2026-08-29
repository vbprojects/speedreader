# Lantern in the Fog

`lantern-in-the-fog.html` is a ready-to-run published SugarCube 2.37.3 story.
Open it directly in a browser, load it through the runtime spike, or use it as
an import fixture once HTML import is enabled.

The editable source is `lantern-in-the-fog.twee`. It exercises:

- a textbox that stores a name and navigates on Enter;
- passage choices with setter expressions;
- story variables and conditional prose;
- `<<linkappend>>` and `<<linkreplace>>` without passage navigation;
- history/save restoration across several turns; and
- a replay link.

Rebuild it with the pinned SugarCube `format.js`:

```bash
node build-fixture.mjs /path/to/sugarcube-2/format.js lantern-in-the-fog.twee lantern-in-the-fog.html
```
