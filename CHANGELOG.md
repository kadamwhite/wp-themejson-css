# Changelog

All notable changes to the **wp-themejson-css** extension will be documented in this file.

## [v0.0.2]

- Preserve double-colon syntax on `::before` and `::after` properties (they are ignored by WordPress when using only a single colon).
- Save `" "` content strings with single quotes to increase legibility of minified code in the JSON.

## [v0.0.1]

- CSS syntax highlighting injected into `"css"` values in `theme.json`.
- **WP: Edit inline theme.json CSS** command opens a formatted side pane.
- Saving the pane minifies with cssnano and writes back to the source JSON.
- `wpThemeJsonCss.sortDeclarations` setting to control declaration sorting.
