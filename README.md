# Helm Values Explorer

VS Code extension for inspecting Helm values across environments. Hover over `.Values` references to see resolved values per environment; hover over `include` calls to see template definitions. Orphan detection (Phase 3) planned.

## Features

- **Values hover**: Hover over `.Values.x.y.z` in `templates/**/*.{yaml,yml,tpl}` → inline table of resolved values across all environments. Works in `{{ .Values.x }}`, `{{- if .Values.x }}`, `{{- with .Values.x }}`, etc. Values that differ from the base are **bold**; missing keys show `⚠ not set`.
- **Template definition hover**: Hover over `{{ include "template.name" . }}` → shows the `define` block source (file + full definition).

## Supported layouts

- **Helmfile**: `helmfile.yaml` at workspace root with explicit `environments`. Value layers: chart base → env values → secrets → system.
- **Override-folder**: `helm/*/values.yaml` + `helm/*/overrides/*.yaml`. Environments inferred from override filenames.
- **Custom**: Set `helmValues.environments` and `helmValues.valuesFilePattern` to use explicit env list and a pattern like `values/values-{env}.yml`. Base path via `helmValues.valuesBasePath`. Takes precedence over helmfile/override-folder when both are set.

## Installation

Package as `.vsix` and install locally:

```powershell
npm run compile
npx vsce package
code --install-extension helm-values-explorer-0.1.0.vsix
```

## Development

```powershell
npm install
npm run compile
```

## Testing

Launch the extension against nolo-helm (Extension Development Host):

```powershell
.\scripts\test-nolo-helm.ps1
```

Opens a new VS Code window with the extension loaded. Status bar shows "Helm: N envs" when a chart is detected (e.g. "Helm: 9 envs" for nolo-helm).

## Settings

| Setting | Description |
|---------|-------------|
| `helmValues.helmfilePath` | Path to helmfile.yaml (default: `helmfile.yaml`) |
| `helmValues.chartPath` | Override chart path when multiple charts exist (e.g. `nolo` or `helm/sample-gitops-2`) |
| `helmValues.baseValuesFile` | Base values filename relative to chart root (default: `values.yaml`) |
| `helmValues.overridesDir` | Overrides directory relative to chart root (override-folder layout, default: `overrides`) |
| `helmValues.secretsFilePath` | Override for git-ignored secrets file |
| `helmValues.environments` | Explicit env list. With `valuesFilePattern`, enables custom layout |
| `helmValues.valuesBasePath` | Base path for value files (default: `.`). Used with custom layout |
| `helmValues.valuesFilePattern` | Pattern with `{env}` placeholder (e.g. `values/values-{env}.yml`) |
| `helmValues.excludeOrphanPrefixes` | Path prefixes to exclude from orphan diagnostics (e.g. `["global.images"]`) |
