# Changelog

All notable changes to Helm Values Navigator will be documented in this file.

## [0.1.0] - 2025-03-07

### Added

- **Values hover**: Hover over .Values.x.y.z in Helm templates to see resolved values across all environments in an inline table
- **Template definition hover**: Hover over {{ include "template.name" . }} to see the define block source
- **Layout support**: Helmfile, override-folder, custom (explicit environments + valuesFilePattern), standalone
- **Custom layout config**: helmValues.environments, helmValues.valuesBasePath, helmValues.valuesFilePattern
- **Layout detection optimization**: Skip workspace walk for helmfile and custom+chartPath layouts
- **Sample chart**: Minimal helmfile layout (dev/staging) for quick testing
- **Extension icon** and **screenshot** in README
- **Orphan diagnostics**: Unresolved `.Values` refs → Error; unused value keys → Hint. Config: `excludeOrphanPrefixes`, `orphanDiagnosticsEnabled`
- **Subchart support**: Values under dependency names (e.g. `subchart1.replicaCount`) are not flagged as unused when the subchart's templates reference them
- **Subchart warning**: When Chart.yaml lists dependencies but they're not in `charts/`, shows an informational diagnostic suggesting `helm dependency update`
