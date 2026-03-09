# Changelog

All notable changes to Helm Values Navigator will be documented in this file.

## [0.1.5] - 2025-03-09

### Fixed

- **Mac orphan diagnostics**: Use `Uri.joinPath(folder.uri, relativePath)` instead of `Uri.file(absPath)` so diagnostic URIs match VS Code's document URIs (fixes symlink/path normalization on macOS).

### Added

- **Add to exclude list (Quick Fix)**: Right-click on orphan diagnostics to add path to `helmValues.excludeOrphanPrefixes`. Offers prefix, full path, and "edit..." to customize before adding. **Asterisk support**: Use `*` for one segment (e.g. `secrets.*` matches `secrets.foo` but not `secrets.foo.bar`).

## [0.1.4] - 2025-03-07

### Added

- **Subchart .tgz support**: Orphan diagnostics now detect subchart dependencies stored as `.tgz` archives (from `helm dependency update`). Extracts to temp, scans templates for `.Values` paths, caches by tgz mtime to avoid re-extraction.

## [0.1.3] - 2025-03-07

### Performance

- **Hover cache**: Layout and resolved values are cached for the values hover. Cache invalidates on save of templates, values files, Chart.yaml, helmfile, or overrides; and on helmValues config change. Subsequent hovers are instant after the first.
- **Diagnostics cache**: Orphan diagnostics results are cached per workspace folder. In multi-root workspaces, saving in one folder only recomputes that folder; others use cached results.

## [0.1.2] - 2025-03-07

### Performance

- **Debouncing**: Orphan diagnostics refresh is debounced (400ms) on save to avoid repeated full scans when saving multiple files
- **Resolver caching**: Resolved values are computed once per environment and reused for both unresolved-ref and unused-key checks (was O(paths × envs) resolver calls, now O(envs))
- **No refresh on open**: Diagnostics refresh only on save, not on file open, to reduce perceived lag when switching between files

## [0.1.1] - 2025-03-07

### Added Subchart Support!

- **Subchart support**: Values under dependency names (e.g. `subchart1.replicaCount`) are not flagged as unused when the subchart's templates reference them
- **Subchart warning**: When Chart.yaml lists dependencies but they're not in `charts/`, shows an informational diagnostic with Quick Fix to run `helm dependency update`
- **Subchart dependency Quick Fix**: When Chart.yaml lists dependencies but they're not in `charts/`, a Quick Fix (lightbulb) offers to run `helm dependency update`. Command **Helm: Update Dependencies** also available from the palette.

## [0.1.0] - 2025-03-07

### Added

- **Values hover**: Hover over .Values.x.y.z in Helm templates to see resolved values across all environments in an inline table
- **Template definition hover**: Hover over {{ include "template.name" . }} to see the define block source
- **Layout support**: Helmfile, override-folder, custom (explicit environments + valuesFilePattern), standalone
- **Custom layout config**: helmValues.environments, helmValues.valuesBasePath, helmValues.valuesFilePattern
- **Layout detection optimization**: Skip workspace walk for helmfile and custom+chartPath layouts
- **Orphan diagnostics**: Unresolved `.Values` refs → Error; unused value keys → Hint. Config: `excludeOrphanPrefixes`, `orphanDiagnosticsEnabled`
