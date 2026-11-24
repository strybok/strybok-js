# Peer dependency stand-ins

The folders here are empty packages named like this package's peer dependencies. They are linked
as `devDependencies` (`link:./peer-stubs/...`) for one reason: pnpm auto-installs missing peer
dependencies, and the real ones must not be installed into this workspace. With a local link in
place pnpm has nothing to fetch.

Nothing imports them. Type-checking uses the declarations in `src/peer-modules.d.ts`; tests
replace the modules with the fakes in `test/fakes` (see `vitest.config.ts`). They are not part of
the published package.
