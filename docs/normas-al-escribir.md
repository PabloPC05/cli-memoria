# Normas al escribir (`[rules]`)

Diseño, principios y evaluación empírica de las reglas de escritura en código de `cli-memoria`.

## Resumen

- **El código pone las normas.** Cada escritura del servidor (`create`, `edit`, `write`, `move`, `revert`, `attach`, `publish`) se comprueba contra las reglas que el repositorio de notas declara en la tabla `[rules]` de su `memory.toml`. Un agente que no lea o no siga `AGENTS.md` no puede saltárselas: el servidor rechaza la escritura con `RULES_VIOLATED`.
- **Solo bloquea lo nuevo.** La versión anterior de la nota es la referencia. Lo que la nota ya tenía mal no impide editarla (vuelve como aviso `RULES_EXISTING`), pero una escritura no puede añadir problemas nuevos.
- **Mensajes que corrigen.** Cada problema ocupa una línea con la regla, la línea de la nota, qué está mal y cómo arreglarlo (principio de SWE-agent, [arXiv:2405.15793](https://arxiv.org/abs/2405.15793): mensajes de error accionables en el mismo turno). Por ejemplo: `obsolete, line 14: «memoria_search» is a retired name this memory no longer uses. Fix: use the memoria CLI (memoria buscar, leer, copia, publicar…).`
- **Partir una nota en un solo envío (`publish`).** Una línea que sale de una sección de solo añadido (p. ej. `## Fuentes`) no cuenta como borrada si entra, sin cambios, en la misma sección de otra nota del mismo envío. Un envío es una llamada a `publish` (lo que envía `memoria publicar`) o un mismo commit de varias notas. En escrituras sueltas la regla sigue igual, y el rechazo sugiere hacer la partición en un solo envío.
- **Nombres retirados: instrucciones no, historia sí.** Una mención en una línea con una fecha explícita `AAAA-MM-DD` fuera de los marcadores de origen `[…]` (por ejemplo «retirado el 2026-11-22») es historia: no bloquea ni avisa. En un envío, una mención que sale de una nota y entra en otra tampoco es nueva.
- **Configurable y opcional.** Sin `[rules]` en `memory.toml` el servidor no aplica ninguna regla adicional. Las reglas viven en `memory.toml`, que ninguna herramienta puede escribir: solo el propietario, con git.
- **Evaluación sobre una memoria real de ~280 notas:**
  - 49 de 282 notas tenían problemas previos con las reglas propuestas.
  - **0 de 926** ediciones normales simuladas quedaron bloqueadas por problemas preexistentes.
  - En la repetición de la última semana real (389 commits), 117 escrituras a notas con problemas viejos habrían pasado sin bloqueo; se habrían frenado 13 escrituras (9 agrupando particiones en un solo `publish`), todas ellas añadiendo problemas nuevos reales (un tipo inválido y 8 menciones sin fecha a herramientas retiradas).

## 1. Rutas de escritura y cobertura

| Ruta | Cómo se comprueba |
|---|---|
| `create`, `edit`, `write` | Reglas completas, comparando con la versión anterior de la nota (ninguna en `create`). |
| `move` | La nota movida se juzga en su destino frente a su origen (sacarla del archivo o de una carpeta sin tipo convierte sus problemas en nuevos). Las notas cuyos enlaces se reescriben solo bloquean si la reescritura añade algo. |
| `revert` | Reglas completas frente a la nota actual; una sección de solo añadido puede perder únicamente las líneas que añadió el commit que se deshace. Una nota borrada que vuelve se compara con su última versión. |
| `attach` | Frontmatter y `type` de la nota compañera (`type` del parámetro o `attachment_type`). El texto extraído del documento se conserva tal cual. |
| `delete` | No escribe contenido (solo bloquea `HAS_BACKLINKS`). |
| `publish` | Varios commits (`create`, `write`, `move`, `delete`) en un solo envío atómico (todo o nada). Las reglas se juzgan al final sobre el conjunto, permitiendo mover líneas de `append_only` o menciones obsoletas al partir/fusionar notas. |
| Remoto git | Los commits ya empujados no se pueden rechazar; sus incumplimientos se registran en el log (`rules.remote_violations`) y pueden bloquearse antes con `cli-memoria check` como hook git. |
| `lint` | Tipo `rules` (`cli-memoria lint --kind rules` o herramienta `lint`): una entrada por nota con los problemas actuales, sin modelo. |
| `cli-memoria check` | `cli-memoria check <repo> [<rev> \| <de>..<a> [--each]] [--conventions f] [--json]` evalúa un árbol, un rango (código de salida `1` si añade un problema bloqueante: sirve como hook `pre-push`/`pre-receive`) o cada commit por separado. |

## 2. Las reglas

| Regla (`rule`) | Qué comprueba | Acción por defecto | Cuándo cuenta como problema nuevo |
|---|---|---|---|
| `frontmatter` | La nota empieza con frontmatter YAML entre `---`. | `block` | Si antes lo tenía y ahora no, o si la nota es nueva. |
| `type` | El campo `type` existe y pertenece a la lista cerrada `allowed`. Las carpetas de `untyped_folders` quedan exentas. | `block` | Por valor: mantener un valor viejo inválido solo avisa, pero cambiarlo a otro inválido bloquea. |
| `obsolete` | Nombres retirados definidos como expresiones regulares (sensibles a mayúsculas por defecto). Cuenta también dentro de código. Con `allow_dated = true` (por defecto), una línea con fecha `AAAA-MM-DD` fuera de marcadores `[…]` cuenta como historia y se permite. | `block` | Por texto encontrado: una escritura no puede aumentar el conteo, así que retocar la línea que ya lo tenía no bloquea. En un envío (`publish`), cada mención que sale de una nota cubre una que entra en otra (las notas borradas también ceden las suyas). |
| `append_only` | Las líneas existentes de las secciones listadas (p. ej. `Fuentes`) no se modifican ni se borran; se puede añadir y reordenar (se ignoran líneas en blanco y espacios finales). | `block` | Línea a línea entre la versión anterior y la nueva. En `publish`, una línea que sale de una nota y entra idéntica en la misma sección de otra del mismo envío queda cubierta. |
| `forbidden_section` | Encabezados prohibidos (de cualquier nivel, sin distinguir mayúsculas ni tildes, fuera de bloques de código). | `block` | Por encabezado. |
| `template` | Las secciones del nivel indicado de un tipo con plantilla coinciden con las de la plantilla y van en orden. | `warn` | Por encabezado fuera de plantilla o fuera de orden. |
| `size` | Caracteres de la nota por encima de `max_chars` (las notas compañeras de adjuntos quedan fuera). | `warn` | Si cruza el límite o si ya lo superaba y crece. |

Quedan fuera de todas las reglas los archivos de la raíz (`AGENTS.md`, `README.md`), la carpeta de archivo (`archive/`) y las carpetas de `[rules] exclude`.

### Respuestas del servidor

- **Escritura rechazada (`RULES_VIOLATED`):** no se hace commit y el árbol de trabajo queda intacto. El mensaje incluye cabecera y una línea por problema (hasta 12 en texto; el detalle completo va en `violations` con `rule`, `line`, `message` y `fix`):

  ```text
  Not saved: this write would add 1 problem that the memory's rules forbid in «topics/ejemplo.md» (memory.toml [rules]). Fix each one and retry; nothing else changes.
  - type, line 5: «type: Topic» is not one of this memory's types. Fix: use one of: Profile, Preference, Work, People, Notes.
  ```

- **Escritura aceptada:** puede devolver dos avisos no bloqueantes: `RULES_WARNINGS` (problemas nuevos de reglas en modo `warn`) y `RULES_EXISTING` (problemas que la nota ya tenía antes de editarla).

## 3. Configuración (`memory.toml`)

```toml
[rules]
exclude = []                         # carpetas fuera de las reglas, además del archivo

[rules.frontmatter]
required = true                      # action = "block"

[rules.type]
field = "type"                       # por defecto
allowed = ["Profile", "Preference", "Work", "People", "Notes"]
untyped_folders = ["skills"]         # sus notas van sin tipo
attachment_type = "Notes"            # tipo por defecto de las notas compañeras de attach

[rules.obsolete]
allow_dated = true                   # una línea con fecha AAAA-MM-DD fuera de […] es historia

[[rules.obsolete.patterns]]          # uno por nombre retirado
pattern = '\bmemoria_(?:search|read|create|edit|write|move|delete)\b'
fix = "use the memoria CLI (memoria buscar, leer, crear, editar, publicar…)"
except = ["projects/ejemplo.md", "projects/carpeta"]   # nota exacta o carpeta entera

[rules.append_only]
sections = ["Fuentes"]

[rules.forbidden_sections]
sections = ["Historia"]
fix = "move dated history into the relevant section instead of a separate Historia section"

[rules.templates]
action = "warn"                      # o "block"
level = 2                            # nivel de encabezado comprobado
People = ["Quién es", "Relación", "Contacto", "Trato", "Asuntos", "Pendiente", "Fuentes"]

[rules.size]
max_chars = 20000
action = "warn"
```

Un `memory.toml` mal escrito nunca se aplica: el mensaje indica qué clave falla (expresión regular inválida, claves desconocidas, plantilla de un tipo que no está en `allowed`, patrón que casa con cadena vacía). Mientras corre, el servidor conserva las últimas convenciones válidas.

## 4. Evaluación empírica sobre una memoria real

Evaluación realizada en modo de solo lectura sobre un historial real de **282 notas activas** y **2.207 commits** (sin modificar la memoria de producción).

### Ediciones sintéticas (falsos bloqueos)

| Edición sintética | Probadas | Bloqueadas | Con avisos nuevos (`warn`) |
|---|---:|---:|---:|
| Reescribirla igual (`write` sin cambios) | 282 | 0 | 0 |
| Añadir una frase al final | 282 | 0 | 13 (notas grandes que crecen) |
| Añadir una línea a `## Fuentes` | 54 | 0 | 8 |
| Retocar cada línea que ya tiene un problema (fuera de frontmatter y Fuentes) | 36 | 0 | 15 |
| Borrar una sección entera que no sea Fuentes | 272 | 0 | 0 |
| **Total** | **926** | **0** | |

### Repetición del historial real (`cli-memoria check --each`)

| Ventana | Commits | Escrituras de notas | Commits rechazados | Desglose por regla | Escrituras a notas con problemas previos que pasan |
|---|---:|---:|---:|---|---:|
| Historial completo | 2.207 | 2.534 | 278 | `append_only` 135, `type` 75, `obsolete` 46, `forbidden_section` 35, `frontmatter` 4 | 1.203 |
| Desde la migración de esquema | 1.256 | 1.279 | 133 | `append_only` 109 (migración masiva), `obsolete` 23, `type` 5 | 262 |
| Última semana | 389 | 415 | 13 (9 con `publish`) | `obsolete` 12 → 8, `type` 1 | 117 |

- **Por qué `allow_dated` ignora fechas dentro de `[…]`:** casi todas las líneas de hechos llevan un marcador de origen con fecha (p. ej. `[Agente, 2026-11-21, sesión]`). Si esa fecha contara como fecha histórica, pasaría cualquier instrucción obsoleta escrita en presente con su marcador de origen. Solo cuenta una fecha `AAAA-MM-DD` explícita en el texto fuera de `[…]`.
- **Particiones de notas grandes:** al evaluar 4 particiones reales (17 escrituras: 4 notas madre + 13 subnotas) como envíos atómicos `publish` + `allow_dated`, **6 de las 7 subnotas** que arrastraban menciones obsoletas desde la nota madre pasaron sin falsos bloqueos, y la única rechazada correspondía a 3 líneas copiadas de una nota ajena al envío que describían en presente herramientas retiradas.

## 5. Compromisos y decisiones de diseño

- **Migraciones masivas de formato:** una migración que reescriba una sección `append_only` quedaría bloqueada por diseño; para ejecutarla hay dos vías: poner temporalmente `[rules.append_only] action = "warn"` o aplicarla directamente con git.
- **Sensibilidad a mayúsculas en patrones:** los patrones de `obsolete` distinguen mayúsculas por defecto (`ignore_case = true` lo cambia) para evitar falsos positivos con nombres de archivo o sustantivos comunes.
- **Dos métricas de tamaño:** `[rules.size]` cuenta caracteres (más cercano a tokens de LLM), mientras que `[lint] max_bytes` cuenta bytes; ambos son ajustables en `memory.toml`.
- **Validación antes de hacer commit en `memory.toml`:** conviene validar cambios con `cli-memoria check <repo> --conventions memory.toml` antes de aplicarlos.
