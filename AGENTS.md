# Agentwheel Project Notes

## Release And Publish

- Do not run `npm publish` manually from Codex or other local agents.
- The npm package publish is handled by the configured release pipeline.
- For a release, update the version files and changelog, run the local checks, commit, push `main`, and push the release tag. Let CI/pipeline publish the package.
- If npm auth is missing locally, treat that as expected; do not try to re-authenticate or publish outside the pipeline unless Giuseppe explicitly asks for a manual emergency publish.
