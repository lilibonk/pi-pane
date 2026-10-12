# Bundled theme decorations

`pi-pane-porcelain.json` is separate from pi theme files: pi loads only `themes/*.json`.
Its closed schema allows four empty decoration slots, two asset identifiers, three pi color
roles, an opacity ceiling of 0.2, and either no repetition or horizontal repetition.

The two SVGs in `public/decorations/` were drawn specifically for pi-pane on 2026-10-11:
an original curved botanical branch and an original alternating wave border. They were
constructed from simple Bézier geometry without tracing, downloaded artwork, or external
references. Copyright belongs to the pi-pane contributors; both use the repository's MIT
license. They contain geometry and `currentColor` only and are rendered as alpha masks.

Vite copies the files to `web-dist/decorations/`, served by the existing same-origin Hub
static resource route. The whole SVG set is limited to 32 KiB. The build gate and host
loader validate the manifest, bounded regular files, SVG grammar and canonical paths;
any runtime failure removes the artwork without affecting colors or session operation.
Only the real source file `themes/pi-pane-porcelain.json` may bind this manifest. A user,
project or package theme with the same display name never acquires it.

Artwork belongs only in empty brand, empty-state, settings-header and divider boxes.
It must not underlay text, code, diffs, forms or tool output. Layout keeps those boxes
when artwork is absent; browser preference, narrow viewports and system contrast
preferences can hide their contents.
