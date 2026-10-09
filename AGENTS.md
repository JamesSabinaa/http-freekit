# Build output preferences

- Write Windows installers, ZIP archives, and associated build metadata directly to `dist/`, using the existing build configuration.
- Overwrite previous build artifacts with the same filenames.
- Do not create per-build, dated, feature-named, or commit-named output folders unless the user explicitly requests one.
- Standard builder-generated working directories, such as `dist/win-unpacked/`, are expected and may remain.
