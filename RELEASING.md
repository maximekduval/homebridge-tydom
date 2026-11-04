# Releasing

How a new version of `homebridge-tydom-mk` reaches npm and the Homebridge UI.

## Steps

1. In a pull request, bump the version without creating a tag:

   ```sh
   npm version patch --no-git-tag-version
   ```

   This updates `version` in `package.json` and `package-lock.json`. Add a
   `## X.Y.Z` section at the top of `CHANGELOG.md` in the same pull request.
   `npm test` fails when the version has no changelog section, so a release
   cannot go out without notes. Merge it once CI is green.
2. On GitHub, go to Releases > Draft a new release, create the tag `vX.Y.Z` on
   `main`, leave the description empty and publish.
3. Two workflows start by themselves:
   - **Release** stages the package on npm. It first checks that the tag
     matches `version` in `package.json` and is on `main`.
   - **Release notes** copies the `## X.Y.Z` section of `CHANGELOG.md` into the
     description of the GitHub release.
4. Approve the staged version with 2FA on npmjs.com (package > Versions), or run
   `npm stage approve <stage-id>`. The stage id is a UUID, not the package name
   and version: the **Release** workflow prints it at the end of its "Stage the
   package on npm" step (`staged with id ...`), and
   `npm stage list homebridge-tydom-mk` shows it after `npm login`. npm first
   validates the package for a couple of minutes; the approval is available
   after that.

Do not run `npm publish` or `npm version` with a tag on your machine: the
version and the tag come from the pull request and the GitHub release. The one
exception is the very first version, below.

The **Release** workflow authenticates with npm trusted publishing, configured
on npmjs.com for this repository and `release.yml` with the stage-only
permission, so no npm token is stored in GitHub. That configuration is tied to
the repository name and the workflow file name: if either is renamed, update the
trusted publisher in the package settings on npmjs.com before the next release,
or the **Release** workflow is refused.

## First publication (1.0.0)

A trusted publisher can only be configured on a package that already exists, so
1.0.0 is published by hand, once:

1. Merge the pull request that brings 1.0.0 into `main`, then on `main`:

   ```sh
   npm login
   npm publish
   ```

   `prepack` runs the lint, the type check, the tests and the build first.
2. On npmjs.com, open `homebridge-tydom-mk` > Settings > Trusted publishing, add
   GitHub Actions with the repository `maximekduval/homebridge-tydom` and the
   workflow `release.yml`, with the stage-only permission.
3. Create the GitHub release `v1.0.0` on `main` as in step 2 above. The
   **Release** workflow sees that 1.0.0 is already on npm and stops there; the
   **Release notes** workflow fills the description.

From 1.0.1 on, follow the steps above.

## Release notes in the Homebridge UI

When a plugin is updated, the Homebridge UI shows the description of the GitHub
release `vX.Y.Z` as the release notes, and `CHANGELOG.md` as the full changelog.
It reads both from the GitHub repository found in `homepage`, or else `bugs`, of
`package.json`, with anonymous requests. So:

- the repository must be public, otherwise the UI shows "Could not retrieve
  release notes";
- the GitHub release must exist with a description that is not empty, which the
  **Release notes** workflow takes care of.

To fill a release that already exists, or to create one for an existing tag, run
the **Release notes** workflow from the Actions tab and give it the tag, for
example `v1.0.0`. A description written by hand is never overwritten. Check
`latest` only for the newest version: GitHub marks a new release as the latest
one, and an older version must not take that label. To preview the notes of a
version, run `node scripts/changelog-section.mjs 1.0.0`.

## Taking changes from upstream

```sh
git fetch upstream
git log --oneline main..upstream/main
```

Take what is useful in a pull request, as for any other change, with its own
`## X.Y.Z` section in `CHANGELOG.md`. Upstream uses pnpm: a conflict on
`pnpm-lock.yaml` is resolved by deleting the file, and `package-lock.json` is
refreshed with `npm install`.
