# Third-party notices

Project source is MIT licensed unless a file states otherwise.

- UI primitives are derived from [shadcn/ui](https://github.com/shadcn-ui/ui),
  MIT License, copyright shadcn. The components remain in `components/ui`.
- IBM Plex fonts are copyright IBM Corp. and licensed under the SIL Open Font
  License 1.1. License copies are included in `public/fonts`.
- The project-local frontend-design skill comes from
  [anthropics/skills](https://github.com/anthropics/skills); its accompanying
  license is preserved in `.agents/skills/frontend-design/LICENSE.txt`.
- The shadcn skill comes from [shadcn-ui/ui](https://github.com/shadcn-ui/ui),
  MIT licensed. Cloudflare skills come from
  [cloudflare/skills](https://github.com/cloudflare/skills) under Apache-2.0.
  The vinext skill comes from
  [cloudflare/vinext](https://github.com/cloudflare/vinext) under MIT.
  These upstream license texts are retained in `LICENSES`. Source paths and
  content hashes are recorded in `skills-lock.json`.

Dependency licenses remain in their packages. `fflate` is overridden to the
compatible patched version 0.7.5 while the upstream dependency pins 0.7.4.
