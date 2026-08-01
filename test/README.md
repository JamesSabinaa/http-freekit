# Test suite organization

Run the complete suite from the repository root with:

```sh
npm test
```

Tests live in folders named for the feature they exercise. The larger
interceptor and proxy areas use a second folder level for their main runtime
families. Shared process fixtures remain in `fixtures/`.

Name test files after the behavior or component under test. Do not use issue or
bug numbers in filenames; issue history belongs in commit messages and
`bugs.md`. Add cases to an existing file when they exercise the same component
with the same setup. Keep separate files when combining them would mix layers
or require unrelated fixtures.
