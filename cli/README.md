# `memoria`, la CLI de cli-memoria

`cli-memoria` es una memoria compartida en git con su servidor y su CLI `memoria`.

`memoria` expone las notas Markdown en git como comandos de terminal pensados para agentes: salida compacta (una línea por resultado, con el total y cómo seguir), `--json` para filtrar con `jq`, `--simular` en todo lo que escribe y códigos de salida estables. Sin dependencias de npm: Node 22 o más y unos `.mjs`.

```sh
memoria buscar pendiente --carpeta projects --limite 5   # por el servidor: search
memoria buscar pendiente --tipo proyecto --estado activo
memoria buscar pendiente --en alfa          # dentro de una nota: con rg, sus líneas, con número y sección
memoria plazos                              # las tareas de las secciones «Pendiente», por fecha
memoria plazos --sin-plazo --hechas --carpeta tareas
memoria leer alfa --seccion pendiente
memoria editar alfa --razon "Pendiente al día" --viejo "- [ ] X" --nuevo "- [x] X"
memoria lista projects
memoria recientes 10
memoria --help        # todo lo demás
```

## Estructura

```text
cli/
├─ memoria.mjs       el programa: comandos, ayuda, lectura local, copia de trabajo y publicar
├─ lib/
│  ├─ nativa.mjs     opciones, errores y códigos de salida, alias en inglés, llamadas al servidor, --json, --simular
│  ├─ paginas.mjs    salida por páginas: ventanas de texto (~150 líneas u 8.000 caracteres) y listados con total
│  └─ pasarela.mjs   el cliente MCP del servidor (Streamable HTTP, JSON o SSE)
├─ probar.sh         prueba de punta a punta contra un servidor real, con notas y agentes de juguete
└─ README.md         esto
nix/memoria.nix      el paquete `memoria` del flake
```

## Cómo lee y cómo escribe

- **Leer**:
  - `buscar` y `plazos` preguntan al servidor, también con `MEMORIA_DIR`: `search` y `deadlines` de `cli-memoria` deciden
    qué se encuentra y en qué orden. `buscar` manda `query`, `folder`, `include_archive`, `limit` (hasta 50) y `offset`
    (lo que toca según `--pagina`); `--tipo` y `--estado` van a `type` y `status`. Da una línea por resultado
    (`ruta:línea · sección · fragmento`) y, bajo el primer resultado de cada nota, `↳ (cambiada el AAAA-MM-DD) su
    description`, hasta 200 caracteres; acaba con el total y cómo pasar de página. `plazos` da una línea por tarea
    (`fecha · qué · responsable · nota`).
  - `leer`, `lista` y `recientes` van con `MEMORIA_DIR` directamente a una copia del repositorio de notas (basta de solo
    lectura), con `rg` y `git`, sin pasar por MCP. Sin `MEMORIA_DIR`, las mismas lecturas van al servidor (`read`, `list`
    y `recent`). La fecha de cambio que enseña `leer` sale de una sola pasada de `git log` por todo el historial (unos
    40 ms con 2.200 commits; lo mismo que hace el servidor al indexar).
  - `buscar <texto> --en <nota>` sigue en local: las líneas de esa nota que coinciden, con su número y su sección, y el
    total, sin leerla entera. Con `MEMORIA_DIR` sale del disco; sin ella, la nota se lee por el servidor y se busca aquí.
    `--regex` es una expresión de `rg` sobre la copia local: necesita `MEMORIA_DIR`.
  - Si el servidor no responde, `buscar` y `plazos` fallan con su error (código 3): nada de buscar en el disco por su
    cuenta.
  - Las notas en bruto están en `MEMORIA_DIR`, para `rg -n` cuando haga falta algo que `buscar` no da.
- **Escribir** siempre lo hace el servidor (firma con la credencial del agente y aplica las reglas de `memory.toml`):
  - una nota cada vez, con esta misma CLI y por MCP (también sin `MEMORIA_DIR`): `crear`, `editar`, `escribir`,
    `mover`, `borrar --si` (sin `--si` no borra) y `revertir`;
  - cambios de varias notas a la vez (hace falta `MEMORIA_DIR`): `memoria copia` hace un `git clone` de trabajo, se
    edita y se commitea con git, y `memoria publicar` lleva esos commits al servidor, con el hash de cada nota para no
    pisar cambios ajenos. Si el servidor tiene la herramienta `publish` (la busca en su lista de herramientas), va todo
    en un solo envío: un commit del servidor por cada commit de la copia, con su asunto como razón, y si algo falla no se
    guarda nada. Si no la tiene, nota a nota (`create`, `write`, `move`, `delete`), como antes: si una falla, lo anterior
    ya quedó publicado. `memoria estado` y `memoria actualizar` completan el ciclo.
- **El resto** del servidor, por MCP: `historial`, `enlaces`, `revisar` (lint).

## Configuración

| Variable | Para qué | Si falta |
|---|---|---|
| `MEMORIA_DIR` | La carpeta del repositorio de notas para leer en local (y para la copia de trabajo) | Todo va al servidor |
| `MEMORIA_COPIA` | Dónde vive la copia de trabajo de `memoria copia` | `~/memoria` |
| `MEMORIA_URL` | Dirección `/mcp` del servidor `cli-memoria` | Código 2: `buscar`, `plazos` y todo lo que escribe lo necesitan |
| `MEMORIA_TOKEN` | Token del agente (`mm_…`) para hablar con el servidor | Código 2, como `MEMORIA_URL` |

`rg` y `git` tienen que estar en el `PATH` para leer en local, para `--en` y `--regex` y para la copia de trabajo (el
paquete de Nix los añade al final del `PATH`).

### Conexión al servidor

Con `MEMORIA_URL` (p. ej. `http://127.0.0.1:8787/mcp`) y `MEMORIA_TOKEN`, la CLI habla con el servidor `cli-memoria` por
Streamable HTTP (sin sesión), llamando a `search`, `deadlines`, `read`, `create`, `edit`, `publish`, etc. por su nombre
real. Es la única conexión que hay: no hay pasarela intermedia.

## Instalar

```sh
nix run github:PabloPC05/cli-memoria#memoria -- --help
nix profile install github:PabloPC05/cli-memoria#memoria
```

El paquete va en `x86_64-linux`, `aarch64-linux`, `x86_64-darwin` y `aarch64-darwin`: `$out/bin/memoria` corre
`$out/lib/memoria/memoria.mjs` con Node 22. Sin Nix: copia `cli/memoria.mjs` y `cli/lib/` juntos y lánzalo con
`node memoria.mjs`.

## Probar

```sh
NODE=$(command -v node) \
CLI_MEMORIA=$(nix build --no-link --print-out-paths .#default)/bin/cli-memoria \
  cli/probar.sh

# la CLI empaquetada en vez de cli/memoria.mjs
MEMORIA=$(nix build --no-link --print-out-paths .#memoria)/bin/memoria NODE=… CLI_MEMORIA=… cli/probar.sh
```

Levanta un servidor `cli-memoria` de verdad en una carpeta temporal, con notas de juguete y dos agentes; prueba la lectura
navegable, `buscar` por el servidor (`--limite`, `--pagina`, `--carpeta`, `--archivo`, `--tipo`, `--estado`), `plazos`,
`buscar --en` y `--regex` en local, las fechas, la ayuda y los alias, la copia de trabajo, `publicar` (también choques
entre agentes) y que ningún token salga en las salidas. Vale con un servidor con `publish` y sin él: dice al empezar
cuál es, y las pruebas de `publicar` esperan lo que toca en cada caso. Si el servidor todavía no tiene `search` con
`offset` ni `deadlines`, las sirve un servidor MCP de juguete que sigue la interfaz común y pasa lo demás al servidor de
verdad (también lo dice al empezar). No toca ninguna memoria real. Necesita `git`, `curl`, `jq` y `rg`.

## Códigos de salida

`0` bien, `1` error de la herramienta, `2` uso o configuración, `3` red o protocolo.
