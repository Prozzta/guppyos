# Release checklist

A release has one path: the verified local cut. The Release workflow
(`.github/workflows/release.yml`) only dry-builds, by hand, and never publishes.

1. **Version commit**: the version in `package.json` and both lock root entries, the
   version test pins, the README badge and history, and a CHANGELOG section.
2. **FULL alone on that tip**: 0 fails, with the wall time against the last release's.
3. **Identity gate** on every commit being pushed, and on the tagger: authors, committers,
   messages and patches. Only the release identity and the noreply co-author may appear.
4. **Push and tag from origin**: resolve the tip and the tags with `git ls-remote origin`,
   not from local names. Push the release branch, then an annotated `v<version>` tag.
   - Before the tag push, check that no workflow publishes on it. Either
     `gh workflow list --all -R <owner>/<repo>` shows Release as `disabled_manually`, or
     `git show <tip>:.github/workflows/release.yml` has no `push` trigger. GitHub runs the
     tag's workflows from the tagged commit, so a release branch made before this fix still
     carries the publishing workflow.
5. **Cut** in a fresh worktree at the tag's commit, with a scrubbed env and `npm ci`:
   - `node scripts/release-markers.cjs` on the source tree and again on the build. It must print
     `ALL 12 MARKERS OK`.
   - The packaged CHANGELOG and no-seams checks, and the code markers for the release's
     fixes. Run the code markers against the installed previous release too, as a control:
     that run must FAIL every new marker.
   - Unpack the installer payload. Its `app.asar` must equal the built one.
6. **Publish**: create the release by hand, with the CHANGELOG `[<version>]` section as its body.
   The update toast digests that body (`src/shared/releaseNotes.ts`), and it is tested on the
   CHANGELOG shape. Then upload the setup exe, its blockmap and `latest.yml`. Always pass
   `-R <owner>/<repo>`, because gh defaults to the upstream parent:
   - `gh release create v<version> -R <owner>/<repo> --verify-tag --title v<version> --notes-file <the CHANGELOG [<version>] section> --latest`
   - `gh release upload v<version> -R <owner>/<repo> <setup.exe> <setup.exe.blockmap> latest.yml`
7. **After publishing, check the release itself**:
   - List the release's final assets (`gh release view v<version> --json assets`).
   - The list must be exactly the 3 files from step 6, and each GitHub digest must equal
     the sha256 of the verified file.
   - Do this after every workflow the tag push started has finished. In 1.1.91, a
     tag-triggered run replaced the verified installer with its own build, which had no
     embedding model.
