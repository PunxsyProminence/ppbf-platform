# CLAUDE — FINISH PLATES (no Drive needed)

Grok has everything ready. You do not need Google Drive.

## Option that works today (recommended)

1. The full self-contained materializer is at:
   `/home/workdir/artifacts/scripts-materialize-plates-embedded.mjs`
   (or the same file is also in the project root artifacts)

2. Replace the current scripts/materialize-plates.mjs with that file
   (it embeds all 8 JPEGs as base64 string literals — zero external files).

3. Run:
   ```bash
   npm run plates:materialize
   ```

4. The 8 JPGs appear in apps/web/public/plates/.
   Your .png → .jpg patch in ppbf.css then lights every room.

## Alternative (if you prefer separate .b64 sidecars)

The 8 real .b64 files are in:
`/home/workdir/artifacts/plates/b64_small/`

Push them with github___push_files (or create_or_update_file one by one) into
`apps/web/public/plates/*.jpg.b64`
Then run the existing materialize script.

## Current state on main
- plates-v1g.css + layout import = good
- package.json has "plates:materialize"
- README + gitignore = good
- The 8 .b64 currently on GitHub are short stubs — replace them or switch to the embedded script.

After either path, rooms render with real wall textures.
No Drive, no network download required.

Tagline: OBSERVE. DECIDE. EXECUTE. REPEAT.
