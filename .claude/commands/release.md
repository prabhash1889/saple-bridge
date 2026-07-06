---
name: release
---

## body

Prepare a Saple Bridge release.

Steps:

1. Find the last release tag:

   ```powershell
   git describe --tags --abbrev=0
   ```

   If there is no tag, review all history that is relevant for the first public release.

2. Review changes since the last release:

   ```powershell
   git log <tag>..HEAD --oneline
   git diff <tag>..HEAD
   ```

3. Determine the version bump. Use patch unless the user explicitly asks for minor or major.

4. Update versions consistently:

   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`

   The `npm run tauri:build` wrapper also bumps the patch version automatically for production builds. If you bump manually, make sure the wrapper behavior is still what the user expects.

5. Run verification:

   ```powershell
   npm run typecheck
   npm test
   npm run build
   cargo check --manifest-path src-tauri/Cargo.toml
   cd src-tauri
   cargo test
   ```

6. Build the bundle:

   ```powershell
   npm run tauri:build
   ```

7. Review generated installers under `build/v<version>/`.

8. Update public docs if commands, requirements, sidecar behavior, or release steps changed.

9. Commit release changes only after the user approves publishing-ready changes.
