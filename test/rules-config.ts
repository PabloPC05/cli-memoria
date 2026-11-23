/** The rules of the tests: those proposed for a real memory, with a small size limit. */
export const RULES = String.raw`
[rules.frontmatter]
required = true

[rules.type]
allowed = ["Profile", "Preference", "Work", "People", "Notes"]
untyped_folders = ["skills"]
attachment_type = "Notes"

[rules.obsolete]
patterns = [
  { pattern = '\bmemoria_[a-z_]+', fix = "use this server's own tools (search, read, write…)" },
  { pattern = '\bLisa IA\b', except = ["projects/historia-de-lisa.md"] },
]

[rules.append_only]
sections = ["Fuentes"]

[rules.forbidden_sections]
sections = ["Historia"]

[rules.templates]
People = ["Quién es", "Relación con Pablo", "Contacto", "Trato", "Asuntos", "Pendiente", "Fuentes"]

[rules.size]
max_chars = 1500
`;
