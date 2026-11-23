# Normas al escribir

Informe de la rama `normas-al-escribir` de cli-memoria (antes my-memory), 2026-11-23. Sale de `main` (`7abf6ef`, lo que hay en producción). Nada de esto está desplegado ni escrito en la memoria: Pablo lo aprueba después de ver los resultados.

## Resumen

- **El código pone las normas.** Cada escritura del servidor (`create`, `edit`, `write`, `move`, `revert`, `attach`) se comprueba contra las reglas que la memoria declara en la tabla `[rules]` de su `memory.toml`. Un agente que no lea o no siga `AGENTS.md` no puede saltárselas: el servidor rechaza la escritura con `RULES_VIOLATED`.
- **Solo bloquea lo nuevo.** La versión anterior de la nota es la referencia. Lo que la nota ya tenía mal no impide editarla (vuelve como aviso `RULES_EXISTING`), pero una escritura no puede añadir problemas.
- **Mensajes que corrigen.** Cada problema ocupa una línea con la regla, la línea de la nota, qué está mal y cómo arreglarlo (principio de SWE-agent, arXiv 2405.15793). Por ejemplo: `obsolete, line 14: «memoria_search» is a retired name this memory no longer uses. Fix: the memoria_* tools are gone: agents use the memoria CLI (memoria buscar, leer, copia, publicar…) through the Badulaque.`
- **Partir una nota en un solo envío.** Una línea que sale del `## Fuentes` de una nota no cuenta como borrada si entra, sin cambios, en el `## Fuentes` de otra nota del mismo envío. Un envío es una llamada a la herramienta nueva `publish` (lo que puede mandar `memoria publicar`) o un mismo commit de varias notas. En escrituras sueltas la regla sigue igual, y el rechazo sugiere hacer la partición en un solo envío.
- **Nombres retirados: instrucciones no, historia sí.** Una mención en una línea con una fecha explícita fuera de los marcadores de origen («quitado el 2026-11-22») es historia: no bloquea ni avisa. En un envío, una mención que sale de una nota y entra en otra tampoco es nueva.
- **Configurable y publicable.** Sin `[rules]` el servidor hace exactamente lo de hoy. Las reglas viven en `memory.toml`, que ninguna herramienta puede escribir: solo Pablo, con git.
- **Sobre la memoria real** (copia de solo lectura, HEAD `4c12c7f`):
  - Hoy, 49 de 282 notas tienen algún problema con las reglas propuestas.
  - Ninguna de las 926 ediciones normales simuladas queda bloqueada.
  - En la última semana, 117 escrituras a notas con problemas viejos habrían pasado igual. Se habrían rechazado 13; si cada partición de notas hubiera ido en un solo envío, 9. Todas añaden problemas nuevos: un tipo inválido y 8 nombres retirados en líneas sin fecha.

## 1. Rutas de escritura y lo que ya se comprobaba

| Ruta | Dónde | Qué se comprobaba antes de esta rama |
|---|---|---|
| `create` | `MemoryService.create` | Ruta (`checkPath`: `.md`, sin ocultos, carpetas permitidas, archivos de raíz), patrón del nombre nuevo, enlaces simbólicos, que no exista, nombre único (`NAME_TAKEN`), frontmatter (`parseNote`), parecidos (`DUPLICATE_CANDIDATES`), razón de 300 caracteres como máximo |
| `edit` | `MemoryService.edit` | Hash opcional, coincidencia exacta de `old_string`, frontmatter: bloquea si cambia y queda mal; si queda igual que estaba, avisa `FRONTMATTER_PROBLEMS` |
| `write` | `MemoryService.write` | Hash obligatorio y el mismo frontmatter que `edit` |
| `move` | `MemoryService.move` | Ruta y patrón del nombre de destino, hash, nombre único, reescritura de los `[[enlaces]]` en el mismo commit; no miraba el contenido |
| `delete` | `MemoryService.delete` | Hash; se niega mientras otras notas la enlacen (`HAS_BACKLINKS`). No escribe contenido |
| `revert` | `MemoryService.revert` | Fusión a tres bandas, rutas, nombres, enlaces entrantes, frontmatter como `write` |
| `attach` | `MemoryService.attach` | Ruta, nombre, LFS; el servidor genera la nota compañera, sin `type` |
| Publicar una copia de trabajo (`memoria publicar`) | CLI `memoria` (hoy en `lisa/kit/memoria/memoria.mjs`, pasando a `cli/` en la rama `cli-memoria`) | Traduce cada commit de la copia en llamadas `create`/`write`/`move`/`delete` por el Badulaque, nota a nota, con el hash del servidor. Antes, su `comprobar()` solo miraba rutas, carpetas, el patrón del nombre, los campos obligatorios de las notas nuevas y la razón |
| Commits empujados al remoto git | `integrateRemoteLocked` (webhook o fetch periódico) | Nada: llegan ya publicados. En lisa no hay remoto (`hosts/lisa/memoria.nix`: «sin remoto (Pablo, 2026-10-17: sin Forgejo)»), así que esta ruta no existe en producción |
| `my-memory migrate --apply` | CLI, sobre un clon | Herramienta de migración fuera de línea; hace un commit en el clon y no publica nada |
| `lint` | `lint.ts` | Lista de mantenimiento: frontmatter (`problems`), enlaces, huérfanas, tamaño en bytes (`oversized`)… |

Fuera del servicio, nadie escribe en `/var/lib/my-memory/repo`. La terminal de lisa lo monta en solo lectura (`srt`), y Lisa web solo lee sus PDF.

## 2. Las reglas

Todas son opcionales: cada tabla de `[rules]` que falta es una regla que no se aplica. Cada regla tiene `action = "block"` o `"warn"`.

| Regla (`rule`) | Qué comprueba | Por defecto | Cuándo es nueva |
|---|---|---|---|
| `frontmatter` | La nota empieza con frontmatter entre `---` | block | Si antes lo tenía y ahora no, o si la nota es nueva |
| `type` | El campo `type` existe y está en la lista cerrada. Las carpetas de `untyped_folders` no lo llevan | block | Por valor: mantener `type: Topic` avisa, pero cambiarlo a otro inválido bloquea |
| `obsolete` | Nombres retirados, como expresiones regulares que distinguen mayúsculas. Cada patrón puede llevar su `fix` y notas o carpetas exentas (`except`). Cuenta también dentro de `código`. Con `allow_dated` (por defecto), una línea que lleva una fecha `AAAA-MM-DD` fuera de `[…]` es historia y no cuenta: «hasta el 2026-11-22» sí, «[Claude, 2026-11-21, sesión]» no, porque esa fecha dice de dónde sale el dato y no hasta cuándo valía | block | Por texto encontrado: una escritura no puede subir la cuenta, así que retocar la línea que ya lo tenía no bloquea. En un envío, cada mención que sale de una nota cubre una que entra en otra, y las notas que el envío borra también dan las suyas |
| `append_only` | Las líneas existentes de las secciones listadas (`Fuentes`) no se cambian ni se borran. Se pueden añadir líneas en cualquier sitio y reordenar; no cuentan los espacios del final ni las líneas en blanco. En un envío de varias notas, una línea puede pasar sin cambios al `## Fuentes` de otra nota del envío | block | Línea a línea, entre la versión anterior y la nueva. En un envío, cada línea que entra en otra nota cubre una que sale |
| `forbidden_section` | Encabezados prohibidos, de cualquier nivel, sin distinguir mayúsculas ni tildes, fuera de bloques de código | block | Por encabezado |
| `template` | Las secciones de nivel 2 de un tipo con plantilla son las de la plantilla y van en su orden | warn | Por encabezado fuera de la plantilla o fuera de orden |
| `size` | Caracteres de la nota por encima de `max_chars`. Las notas compañeras de adjuntos quedan fuera | warn | Si cruza el límite, o si ya lo pasaba y crece |

Quedan fuera de todas las reglas los archivos de la raíz (`AGENTS.md`, `README.md`), el archivo (`archive/`) y las carpetas de `[rules] exclude`.

Casos especiales por ruta:

- **`move`:** la nota se juzga en su destino frente a lo que era en su origen. Sacarla del archivo, o de una carpeta sin tipo, convierte sus problemas en nuevos. Las notas cuyos enlaces reescribe solo se bloquean si la reescritura añade algo, y no reciben avisos de lo viejo.
- **`revert`:** se compara con la nota como está ahora. Puede quitar de `Fuentes` las líneas que añadió el commit que deshace, y ninguna otra. Así se puede deshacer una fuente inventada, pero no volver a meter un nombre retirado que alguien limpió. Una nota borrada que vuelve se compara con su última versión: vuelve tal cual era.
- **`attach`:** solo comprueba el frontmatter que escribe el servidor. El texto extraído es el documento tal cual. El tipo sale del nuevo parámetro `type` de la herramienta o, si no lo hay, de `attachment_type`.
- **`publish` (nueva):** varios commits de cambios (`create`, `write`, `move`, `delete`) como un solo envío, que es lo que manda `memoria publicar`. Cada commit queda como un commit con su razón y cada cambio ve lo que hicieron los anteriores. Las reglas se juzgan al final sobre todo el envío, y es todo o nada: si falla un cambio o una regla, la rama, el árbol de trabajo y el índice vuelven a como estaban y no se empuja nada. El error dice qué commit y qué cambio fallaron. Devuelve los commits y el hash nuevo de cada nota, para que la copia de trabajo siga sin preguntar.
- **Commits del remoto:** no se pueden rechazar porque ya están publicados. Lo que añaden se registra en el log como `rules.remote_violations`, y `my-memory check` puede rechazarlos antes como hook del servidor git.

Además, las instrucciones MCP del servidor resumen las reglas en un párrafo, sin repetir los nombres retirados, para acertar a la primera:

> Every write is checked against this memory's rules: every note starts with frontmatter; «type» is one of Profile, Preference, Work, People, Notes (except notes in skills/); the existing lines of «## Fuentes» are never changed or removed, only added to (to split a note, send both notes in one publish: a line may then move unchanged to the same section of the other note); no «## Historia» sections; People notes use the sections Quién es · Relación con Pablo · Contacto · Trato · Asuntos · Pendiente · Fuentes, in that order; names of retired tools and services are refused (except on a line that dates them as past, e.g. «until 2026-11-22»); notes stay under 20,000 characters. A write that adds a violation fails with RULES_VIOLATED and says, per problem, the line and how to fix it; problems a note already had only warn.

### Respuestas del servidor

- **Escritura rechazada.** Error `RULES_VIOLATED`, sin commit y con el árbol de trabajo intacto. El mensaje es una cabecera y una línea por problema (como mucho 12; el resto va en `violations`, con `rule`, `line`, `message` y `fix`):

  ```text
  Not saved: this write would add 1 problem that the memory's rules forbid in «topics/prueba-de-tipo.md» (memory.toml [rules]). Fix each one and retry; nothing else changes.
  - type, line 5: «type: Topic» is not one of this memory's types. Fix: use one of: Profile, Preference, Work, People, Notes.
  ```

- **Escritura aceptada.** Puede traer dos avisos más: `RULES_WARNINGS`, con los problemas nuevos de reglas `warn`, y `RULES_EXISTING`, con lo que la nota ya tenía, para arreglarlo cuando se pueda.

## 3. Configuración

Todo va en `memory.toml`, en la raíz del repositorio de notas:

```toml
[rules]
exclude = []                         # carpetas fuera de las reglas, además del archivo

[rules.frontmatter]
required = true                      # action = "block"

[rules.type]
field = "type"                       # por defecto
allowed = ["Profile", "Preference", "Work", "People", "Notes"]
untyped_folders = ["skills"]         # sus notas van sin tipo
attachment_type = "Notes"            # el tipo de las notas compañeras de attach

[rules.obsolete]
allow_dated = true                   # una línea con fecha AAAA-MM-DD fuera de […] es historia

[[rules.obsolete.patterns]]          # uno por nombre retirado
pattern = '\blisa-skill\b'           # expresión regular; ignore_case = true para no distinguir mayúsculas
fix = "…"                            # cómo arreglarlo; si falta, uno genérico
except = ["projects/x.md", "projects/carpeta"]   # nota exacta o carpeta entera

[rules.append_only]
sections = ["Fuentes"]

[rules.forbidden_sections]
sections = ["Historia"]
fix = "…"                            # opcional

[rules.templates]
action = "warn"                      # o "block"
level = 2                            # nivel de encabezado que se mira
People = ["Quién es", "Relación con Pablo", "Contacto", "Trato", "Asuntos", "Pendiente", "Fuentes"]

[rules.size]
max_chars = 20000
action = "warn"
```

Un `memory.toml` mal escrito no se carga. El mensaje dice qué clave falla, por ejemplo `rules.obsolete.patterns[2].pattern is not a valid regular expression`, y también falla si hay claves desconocidas, una plantilla de un tipo que no está en `allowed` o un patrón que acepta el texto vacío. Mientras corre, el servidor conserva las últimas convenciones válidas.

## 4. Cobertura

| Ruta | Cómo queda |
|---|---|
| `create`, `edit`, `write` | Reglas completas, con la nota anterior como referencia (ninguna en `create`) |
| `move` | Nota movida: destino frente a origen. Notas con enlaces reescritos: solo bloquean si se añade algo |
| `revert` | Reglas completas frente a la nota de ahora; `Fuentes` puede perder solo lo que añadió el commit que se deshace |
| `attach` | Frontmatter y tipo de la nota compañera |
| `delete` | No escribe contenido: sin cambios |
| `publish` | Todas las reglas de cada cambio, juzgadas juntas sobre el envío entero; todo o nada |
| `memoria publicar` | Hoy pasa nota a nota por `create`, `write`, `move` y `delete`, así que se aplica todo lo anterior. Comparar con la versión del servidor es justo «solo lo nuevo». Probado imitando su protocolo. Para mover líneas de Fuentes entre notas tiene que mandar la publicación como un `publish` (ver la sección 8) |
| Remoto git | Log `rules.remote_violations`, más `my-memory check` como hook |
| `lint` | Nuevo tipo `rules`: una entrada por nota con `by_rule` y una línea por problema. Solo aparece si hay `[rules]`. También en `my-memory lint --kind rules` |
| `my-memory check <repo> [<rev> \| <de>..<a> [--each]] [--conventions f] [--json]` | Las mismas reglas sobre un repo git, sin servidor. Sobre un árbol, lo que incumple cada nota. Sobre un rango, juzgado como un solo envío (sale con 1 si añade algo que bloquea). Con `--each`, cada commit frente a su padre y como un envío. Los commits del remoto se juzgan igual |

## 5. Pruebas

- **Archivos nuevos:**
  - `test/rules.test.ts`: 25 pruebas puras de cada regla, nueva frente a existente, con los mensajes exactos, la configuración, los errores de configuración y las mayúsculas. Historia fechada: con fecha en la línea no cuenta; con la fecha solo en un marcador de origen o en un enlace, o solo con el mes, sí; y `allow_dated = false` lo apaga. Nombres retirados en un envío: los que pasan de nota a nota no son nuevos, uno de más sí, y una nota borrada da los suyos. Para Fuentes entre notas de un envío: partir pasa; una línea que no va a ningún sitio, que llega cambiada o que acaba fuera de Fuentes sigue bloqueada; y cada línea que entra cubre una sola que sale.
  - `test/rules-writes.test.ts`: 18 pruebas de integración con `MemoryService`. Con `publish`: un nombre retirado puede pasar de la nota que se parte a la nueva, pero no uno más, y una edición que lo escribe con fecha pasa sin avisos de esa regla; partir una nota con Fuentes en dos commits de un envío pasa, mientras que la escritura suelta de la nota madre se rechaza con la sugerencia; una línea que no va a ningún sitio o que llega cambiada rechaza todo el envío sin dejar rastro (rama, árbol e índice); un cambio que falla dice qué commit y qué cambio; y un commit de una copia de trabajo mandado como lo haría `memoria publicar` también pasa en `check --each`. Además, `create`, `edit`, `write`, `move` (renombrar, salir de `skills/` y salir del archivo), `revert` (quitar una fuente añadida, no deshacer una limpieza, recuperar una nota borrada), publicación de una copia de trabajo commit a commit y aplanada, `attach` (necesita git-lfs), commits del remoto, configuración ausente, `lint` (herramienta y CLI) y `check` (árbol, rango, `--each` y códigos de salida).
- **En lisa** (`nix shell nixpkgs#nodejs_24 git-lfs poppler-utils tesseract`): typecheck limpio y **149 de 149 pruebas** (en `main` eran 106). `test/http.test.ts` comprueba además `publish` por MCP.
- **En el Mac:** typecheck limpio. Fallan las 6 pruebas de `attach` que ya fallaban en `main`, porque falta git-lfs. La de esta rama se salta sola sin LFS.

## 6. Simulación sobre la memoria real

**Método.** Todo se hizo en solo lectura.

1. En lisa, `sudo -u my-memory git bundle create - --all` de `/var/lib/my-memory/repo` (HEAD `4c12c7f`, 2026-11-23 00:23). Se clonó en `~/normas-sim.*`, con permisos 0700.
2. Sobre esa copia se pasaron el código de la rama, `my-memory check` con el bloque propuesto (`--conventions`), un guion de ediciones sintéticas y escrituras de verdad por `MemoryService` sobre otra copia desechable con su propio índice.
3. Al acabar se borró la carpeta.

### Cómo está hoy

282 notas dentro de las reglas: no cuentan las 19 del archivo ni los archivos de raíz. `lint` (tipo `rules`) usa la misma función que `check`: 49 notas. Antes de dar por historia las líneas con fecha eran 56; lint lo comprobó entonces sobre una copia indexada.

| Regla | Notas | Problemas | Detalle |
|---|---|---|---|
| `obsolete` | 22 | 47 | «Lisa IA» 16, `buscador_usar` 7, `memoria_*` 4, `buscador_buscar` 4, `dispositivos_ejecutar` 3, `archivos_*` 3, `memoria_search` 2, `memoria_anotar` 2, y 1 de `memoria_create`, `dispositivos_listar`, `dispositivos_*`, `correo_enviar`, `correo_*` y `archivos_preparar_subida`. Por carpetas: 17 en `projects/`, 3 en `skills/`, 1 en `me/` y 1 en `topics/`. Sin `allow_dated` serían 70 en 30 notas: 23 menciones ya llevan su fecha de corte en la línea |
| `type` | 5 | 5 | Sin tipo, 3: una en `people/`, otra en `projects/` y otra en `topics/`. Con tipo inválido, 2: `Project` y `Topic`. Las 5 aparecieron después de la 0.5.0, entre el 2026-11-06 y el 2026-11-19 |
| `template` | 13 de 19 People | 34 | Todas son secciones fuera de la plantilla; no hay desórdenes. 6 son variantes de «Trato» («Cómo tratar con él/ella/ellos») y 8 de «Asuntos» («Sus asuntos con …»). El resto son secciones propias de cada persona |
| `size` | 12 | 12 | De 20.097 a 57.266 caracteres. Las mayores son transcripciones de reuniones guardadas enteras y notas de proyectos largos |
| `frontmatter` | 0 | 0 | |
| `forbidden_section` (Historia) | 0 | 0 | |

Por qué no coincide con el diagnóstico del encargo (13, 73 en 24 notas y 13):

- **Tipo:** las 6 notas de `skills/` no llevan tipo por diseño (`AGENTS.md`), y la raíz queda fuera. Dentro de las reglas, 5.
- **Nombres retirados:** 23 menciones con fecha en la línea cuentan como historia. Además, los patrones propuestos distinguen mayúsculas, así que 17 nombres de archivo del tipo «Memoria_….pdf» no cuentan como la herramienta. «Lisa IA» no cuenta en su propia nota (13 apariciones exentas), ni `lisa-skill` en las 2 notas que cuentan su historia. Entran `skills/` y los nombres de herramienta concretos.
- **Tamaño:** se mide en caracteres, no en bytes, y las notas compañeras de adjuntos no cuentan.

### Ninguna edición normal queda bloqueada por problemas viejos

**Ediciones sintéticas.** Sobre cada nota de hoy, comprobadas con las reglas propuestas:

| Edición | Probadas | Bloqueadas | Con avisos nuevos (`warn`) |
|---|---|---|---|
| Reescribirla igual (`write` sin cambios) | 282 | 0 | 0 |
| Añadir una frase al final | 282 | 0 | 13 (notas grandes que crecen) |
| Añadir una línea a `## Fuentes` | 54 | 0 | 8 |
| Retocar cada línea que ya tiene un problema (fuera del frontmatter y de Fuentes) | 36 | 0 | 15 (encabezados retocados, crecimiento) |
| Borrar una sección entera que no sea Fuentes | 272 | 0 | 0 |
| **Total** | **926** | **0** | |

**Escrituras de verdad por el servicio**, sobre una copia desechable con el bloque propuesto, en `projects/badulaque/panel-y-buscador.md` (14 problemas viejos):

- Una edición normal se guarda, con `RULES_EXISTING` (14). Esta prueba es de antes de `allow_dated`, que solo afloja.
- Añadir `memoria_search` se rechaza con `obsolete, line 14: … Fix: the memoria_* tools are gone…`.
- Crear una nota con `type: Topic` se rechaza con `type, line 5: … Fix: use one of: …`.

**Repetición del historial real** (`my-memory check --each`). Cada commit se juzga frente a su padre con las reglas propuestas, como si hubieran existido siempre. En el historial real cada llamada a una herramienta fue su propio commit, así que aquí ninguna partición cuenta como un solo envío (eso va en la sección siguiente):

| Ventana | Commits | Escrituras de notas | Commits rechazados (escrituras) | Commits por regla | Escrituras a notas con problemas viejos que pasan | Avisos nuevos |
|---|---|---|---|---|---|---|
| Todo (2026-10-01 → 11-23) | 2.207 | 2.534 | 278 (433) | `append_only` 135, `type` 75, `obsolete` 46, `forbidden_section` 35, `frontmatter` 4 | 1.203 | `size` 384, `template` 46 |
| Desde la 0.5.0 (2026-11-04) | 1.256 | 1.279 | 133 (133) | `append_only` 109, `obsolete` 23, `type` 5 | 262 | `size` 190, `template` 46 |
| Última semana (desde 2026-11-16) | 389 | 415 | 13 (13) | `obsolete` 12, `type` 1 | 117 | `size` 119, `template` 1 |

Qué eran los rechazos:

- **Antes del 2026-11-04** (tipos ausentes, «Historia», Fuentes que no eran citas): reglas que entonces no existían. No es una señal de nada.
- **Los 109 de `append_only` desde la 0.5.0** son todos del 2026-11-04, de `write` por `gw-claude-code`: la migración a 0.5.0 nota a nota («Migración a 0.5.0: …»), que convirtió las Fuentes antiguas (descripciones de dónde salió cada dato) en marcadores en línea. Desde el 2026-11-05, ninguna escritura ha cambiado ni borrado una línea de Fuentes.
- **Los 13 de la última semana añaden problemas nuevos de verdad** (sin `allow_dated` eran 18; 5 escribían el nombre con su fecha de corte):
  - 1 nota creada con `type: Topic`.
  - 7 ediciones que escribieron «Lisa IA» o `buscador_*` mientras aún eran actuales o se estaban retirando (2026-11-21 y 11-22), sin fecha en la línea: un encabezado «El buscador (`buscador_buscar` y `buscador_usar`)», que el hook del Mac llama a `memoria_*` por `buscador_usar`, que Lisa IA «todavía no se ha quitado», listas de lo que se quita… Desde ahora es justo lo que se quiere parar.
  - 5 `create` de subnotas del 2026-11-22, juzgados cada uno solo (ver abajo).
- En la última semana, 117 escrituras tocaron notas con problemas viejos y todas habrían pasado.

### Las particiones del 2026-11-22

Ese día se partieron 4 notas grandes (`badulaque`, `lisa-web`, `memoria-de-lisa` y `lisa`) en 17 escrituras: una de la nota madre y las demás, subnotas nuevas, con la misma razón cada partición. Las madres no perdieron ninguna línea de Fuentes. Lo que frenaba a 7 subnotas eran los nombres retirados que copiaron.

Juzgada cada partición como un solo envío (lo que haría `publish`), con los nombres que pasan de nota a nota y la historia fechada:

| Partición | Escrituras | Rechazadas | Por qué |
|---|---|---|---|
| `lisa-web` | 4 | 0 | |
| `memoria-de-lisa` | 3 | 0 | |
| `lisa` | 3 | 0 | |
| `badulaque` | 7 | 1 | `panel-y-buscador.md`: 5 menciones de `buscador_*` y `memoria_*` en 3 líneas sin fecha (el encabezado del buscador, el hook del Mac y una comprobación) que no venían de la madre sino de otra nota, `mcp-unico.md`: no salían de ninguna nota del envío |

**6 de los 7 `create` de subnotas pasan** (sin estos dos cambios, ninguno). Queda uno, por 3 líneas copiadas de otra nota que describen en presente cómo funcionaba lo retirado.

Con las particiones en un envío cada una, **la semana queda en 9 rechazos**: 1 tipo inválido, las 7 ediciones de arriba y esa subnota. Las 8 de nombres retirados son líneas sin fecha fuera de los marcadores de origen. Casi todas describen en presente un estado que ya no vale, o sea, instrucciones obsoletas. Hay tres casos dudosos:

- «Hasta ese día el buscador era un destino más…»: es historia, pero la fecha está en otra línea.
- Las listas de lo que se quitaba de Lisa web: la fecha está en la línea de arriba.
- Un pendiente que dice que `~/.claude/CLAUDE.md` «todavía habla de herramientas `memoria_*`».

Los tres pasarían con su fecha en la misma línea.

**Las fechas de los marcadores de origen no cuentan, y es a propósito.** Casi toda línea de la memoria acaba en un marcador con fecha («[Claude, 2026-11-21, sesión]»), así que si contaran pasaría cualquier instrucción con su marcador, y la regla no pararía casi nada. Si contaran, en esta semana pasarían también varias de esas 8, por ejemplo «el hook del Mac llama a `memoria_*` con `buscador_usar` … [Claude, 2026-11-21, sesión]», que describe en presente cómo funciona algo.

## 7. Bloque de configuración propuesto

Este es el `memory.toml` completo que se propone: el de hoy, más `[rules]`. **No está escrito en la memoria.** Para activarlo, ver la sección 9.

```toml
[folders]
allowed    = ["me", "people", "topics", "projects", "skills", "archive"]
archive    = "archive"
index_full = ["me"]

[notes]
superseded_field = "superseded_by"

[attachments]
page_heading = "Page {n}"

# Write rules. The server checks them on every write (create, edit, write, move, revert, attach) and refuses a
# write that adds a problem of a "block" rule; what a note already had only warns. lint (kind «rules») and
# «my-memory check» report the same rules. Agents cannot edit this file: only Pablo, with git.

[rules.frontmatter]
required = true

[rules.type]
allowed = ["Profile", "Preference", "Work", "People", "Notes"]
untyped_folders = ["skills"]
attachment_type = "Notes"

[rules.append_only]
sections = ["Fuentes"]

[rules.forbidden_sections]
sections = ["Historia"]
fix = "remove the section and correct the note so it says what is true now (git keeps every earlier version); a past event that explains the present stays as a dated line in the body"

[rules.templates]
action = "warn"
People = ["Quién es", "Relación con Pablo", "Contacto", "Trato", "Asuntos", "Pendiente", "Fuentes"]

[rules.size]
max_chars = 20000
action = "warn"

# Retired names. Case-sensitive: «Memoria_2025.pdf» is a file, not a tool. A line that dates the mention
# («until 2026-11-22»; a date inside an origin marker […] does not count) is history, not an instruction.
[rules.obsolete]
allow_dated = true

[[rules.obsolete.patterns]]
pattern = '\bmemoria_(?:search|list|read|create|edit|write|move|delete|links|history|recent|revert|attach|lint|clients|anotar)\b|\bmemoria_\*'
fix = "the memoria_* tools are gone: agents use the memoria CLI (memoria buscar, leer, copia, publicar…) through the Badulaque"

[[rules.obsolete.patterns]]
pattern = '\bbuscador_(?:[a-z]+\b|\*)'
fix = "agents no longer see buscador_*: name the service's CLI they run through the Badulaque (memoria, correo, archivos…)"

[[rules.obsolete.patterns]]
pattern = '\barchivos_(?:[a-z]+(?:_[a-z]+)*\b|\*)'
fix = "the archivos_* tools are gone: use the archivos CLI (archivos buscar, leer…)"

[[rules.obsolete.patterns]]
pattern = '\bcorreo_(?:[a-z]+(?:_[a-z]+)*\b|\*)'
fix = "the correo_* tools are gone: use the correo CLI (correo buscar…)"

[[rules.obsolete.patterns]]
pattern = '\bdispositivos_(?:[a-z]+\b|\*)'
fix = "the dispositivos_* tools are gone: say what was done (ssh to lisa, the terminal) without the old tool name"

[[rules.obsolete.patterns]]
pattern = '\bLisa IA\b'
fix = "Lisa IA no longer exists (removed from Lisa web on 2026-11-22): name what you mean today, or link [[lisa-ia-tareas-y-paginas-de-lisa-web]]"
except = ["projects/lisa-web/lisa-ia-tareas-y-paginas-de-lisa-web.md"]

[[rules.obsolete.patterns]]
pattern = '\blisa-skill\b'
fix = "lisa-skill was archived on 2026-10-14: the memory is this one (my-memory)"
except = ["projects/memoria-de-lisa/decisiones-y-antecedentes-de-la-memoria.md", "projects/memoria-de-lisa/memoria-de-lisa.md"]
```

Los `fix` están en inglés, como las instrucciones de `AGENTS.md`. Las exenciones son solo las notas cuyo tema es lo retirado. Si Pablo quiere que las notas de arquitectura del Badulaque (`projects/badulaque/…`) puedan seguir nombrando `buscador_*`, basta con añadirlas a `except`.

## 8. Riesgos y decisiones abiertas

- **Partir o fusionar notas.** Si todo va en un solo envío (`publish`), las líneas de `## Fuentes` y los nombres retirados pueden pasar de una nota a otra; las notas que el envío borra también dan lo suyo. En escrituras sueltas siguen bloqueadas, y el rechazo sugiere el envío único. Un nombre retirado copiado de una nota que no está en el envío sí es nuevo.
- **Historia fechada.** `allow_dated` deja pasar cualquier mención en una línea con fecha fuera de `[…]`, incluso una instrucción con una fecha puesta para colarla («usa `memoria_search` desde el 2026-11-23»). Es el precio de no distinguir con un modelo. `lint` no lista estas menciones aparte (no lo he añadido); `my-memory check` con `allow_dated = false` las saca todas.
- **Migraciones de formato.** Una migración como la 0.5.0 reescribe `Fuentes` y quedaría bloqueada: en el ensayo serían 109 commits. Para la próxima, hay dos salidas: poner `[rules.append_only] action = "warn"` mientras dure, o hacerla Pablo con git.
- **Patrones.** `archivos_x` y `correo_x` en minúscula podrían chocar con un nombre de archivo; hoy no pasa en ninguna nota. Por eso los patrones distinguen mayúsculas por defecto (`ignore_case` lo cambia), y la herramienta `memoria_*` va con la lista exacta de nombres.
- **Raíz fuera de las reglas.** `AGENTS.md` y `README.md` no se comprueban. El propio `AGENTS.md` de la memoria nombra `archivos_*`, `correo_*`, `recordatorios_*` y `chats_*`, y Pablo debería corregirlo a mano.
- **Un `memory.toml` roto apaga las reglas** al arrancar: el servidor vuelve a lo de por defecto y registra `conventions.invalid`. Mientras corre, conserva las últimas válidas. Antes de hacer commit del archivo, conviene comprobarlo con `my-memory check <repo> --conventions memory.toml`.
- **Commits del remoto.** No se pueden rechazar, solo registrar. En lisa no hay remoto.
- **Dos tamaños.** `[rules.size]` cuenta caracteres (20.000, unos 5.000 tokens) y `lint`/`oversized` cuenta bytes (16 KiB por defecto). Si se quiere una sola medida, se puede ajustar `[lint] max_bytes`.
- **Plantillas solo para People.** Los demás tipos siguen sin plantilla. Los encabezados de las notas Work son los más variados y serían los siguientes candidatos.
- **Instrucciones.** El resumen de las reglas va en las instrucciones MCP de cli-memoria. Un agente que entra por el Badulaque quizá no las vea; entonces aprende de los mensajes de error, que es lo que se ha cuidado.
- **Para la CLI `memoria`** (rama `cli-memoria`, carpeta `cli/`, que esta rama no toca):
  - Que `memoria publicar` mande la publicación entera como un solo `publish`: un commit del servidor por commit de la copia, cada uno con su asunto como razón y con los hashes de las versiones de la copia (los blobs coinciden con los del servidor). Así una partición con Fuentes pasa, y la publicación es todo o nada en vez de quedarse a medias en el primer rechazo, como pasa hoy. El `hashes` de la respuesta le dice cómo queda cada nota.
  - `memoria adjuntar` debería aceptar `--tipo`. Sin él, el servidor usa `attachment_type`.

## 9. Para activarlo (no hecho)

1. Revisar y fusionar la rama, y desplegar cli-memoria en lisa (`aplicar-seguro` → comprobar → `confirmar-cambio`). Sin `[rules]` en la memoria, el comportamiento no cambia.
2. Hacer commit del bloque de la sección 7 en `memory.toml` de `/var/lib/my-memory/repo`, como `my-memory`, con git. Las herramientas no pueden escribir ese archivo.
3. Reiniciar `my-memory`. Sin remoto, el servidor no ve un commit hecho a mano hasta que arranca; al arrancar recarga las convenciones y reindexa.
4. Comprobar con `my-memory lint --config … --kind rules`: deberían salir las 49 notas de la sección 6.
