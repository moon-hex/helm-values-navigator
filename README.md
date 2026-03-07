# Helm Values Explorer

VS Code extension for inspecting Helm values across environments. Hover over `{{ .Values.x.y.z }}` in templates to see resolved values per environment. Orphan detection for unused keys and unresolved refs.

## Supported layouts

- **Helmfile**: `helmfile.yaml` at workspace root with explicit `environments`. Value layers: chart base → env values → secrets → system.
- **Override-folder**: `helm/*/values.yaml` + `helm/*/overrides/*.yaml`. Environments inferred from override filenames.

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

Opens a new VS Code window with the extension loaded. Status bar shows "Helm: active" when `helmfile.yaml` is present.

## Settings

| Setting | Description |
|---------|-------------|
| `helmValues.helmfilePath` | Path to helmfile.yaml (default: `helmfile.yaml`) |
| `helmValues.secretsFilePath` | Override for git-ignored secrets file |
| `helmValues.excludeOrphanPrefixes` | Path prefixes to exclude from orphan diagnostics (e.g. `["global.images"]`) |
