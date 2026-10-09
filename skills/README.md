# Distribution skills

Ported Zouroboros skills in the Hermes skill format: `skills/<category>/<skill-name>/SKILL.md`
plus optional `references/`, `templates/`, `assets/` and `scripts/` support files.
The generated Hermes profile lists this directory in `skills.external_dirs`.

Every file here, including this one, needs an entry in `provenance/skills.json` whose
`distributedSha256` matches. Import with `scripts/import-skill.ts`; never copy a source skill
directory wholesale. See `docs/skills.md` and `docs/SKILLS-PARITY.md`.
